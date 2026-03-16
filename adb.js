/**
 * Vault Installer — adb.js
 * Implementación del protocolo ADB sobre WebUSB.
 * No requiere drivers ni software en la PC.
 *
 * Protocolo ADB:
 *   - Cada mensaje tiene header de 24 bytes + payload
 *   - Handshake: CNXN → AUTH → OPEN → servicios
 *   - Instalación via "exec:pm install -r -t /data/local/tmp/<apk>"
 */

const ADB = (() => {

  // ── Constantes del protocolo ────────────────────────────
  const CMD = {
    SYNC: 0x434e5953,
    CNXN: 0x4e584e43,
    AUTH: 0x48545541,
    OPEN: 0x4e45504f,
    OKAY: 0x59414b4f,
    CLSE: 0x45534c43,
    WRTE: 0x45545257,
  };

  const AUTH_TOKEN     = 1;
  const AUTH_SIGNATURE = 2;
  const AUTH_RSAPUBKEY = 3;
  const VERSION        = 0x01000000;
  const MAX_PAYLOAD    = 256 * 1024;
  const BANNER         = 'host::vault-installer';

  // ── Estado de conexión ──────────────────────────────────
  let device    = null;
  let iface     = null;
  let epIn      = null;
  let epOut     = null;
  let localId   = 1;
  let connected = false;
  let onLog     = () => {};

  function log(msg) { onLog(msg); }

  // ── Codificación ─────────────────────────────────────────
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function encode(str) { return enc.encode(str); }
  function decode(buf) { return dec.decode(buf); }

  function u32le(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  }

  function readU32(buf, offset) {
    return new DataView(buf.buffer, buf.byteOffset + offset, 4)
      .getUint32(0, true);
  }

  // ── Construir mensaje ADB ────────────────────────────────
  function makeMessage(cmd, arg0, arg1, data) {
    const payload  = data ? (data instanceof Uint8Array ? data : encode(data)) : new Uint8Array(0);
    const dataLen  = payload.length;
    const checksum = payload.reduce((s, b) => (s + b) & 0xFFFFFFFF, 0);
    const magic    = (cmd ^ 0xFFFFFFFF) >>> 0;

    const msg = new Uint8Array(24 + dataLen);
    const dv  = new DataView(msg.buffer);
    dv.setUint32(0,  cmd,      true);
    dv.setUint32(4,  arg0,     true);
    dv.setUint32(8,  arg1,     true);
    dv.setUint32(12, dataLen,  true);
    dv.setUint32(16, checksum, true);
    dv.setUint32(20, magic,    true);
    if (dataLen > 0) msg.set(payload, 24);
    return msg;
  }

  // ── Enviar mensaje ───────────────────────────────────────
  async function send(cmd, arg0, arg1, data) {
    const msg = makeMessage(cmd, arg0, arg1, data);
    await device.transferOut(epOut.endpointNumber, msg);
  }

  // ── Recibir mensaje ──────────────────────────────────────
  async function recv() {
    // Leer header
    const hdr = await device.transferIn(epIn.endpointNumber, 24);
    const h   = new Uint8Array(hdr.data.buffer);
    const cmd     = readU32(h, 0);
    const arg0    = readU32(h, 4);
    const arg1    = readU32(h, 8);
    const dataLen = readU32(h, 12);

    let payload = new Uint8Array(0);
    if (dataLen > 0) {
      const p = await device.transferIn(epIn.endpointNumber, dataLen);
      payload = new Uint8Array(p.data.buffer);
    }
    return { cmd, arg0, arg1, payload };
  }

  // ── Conectar al dispositivo ──────────────────────────────
  async function connect(logFn) {
    if (logFn) onLog = logFn;

    log('Solicitando acceso al dispositivo USB...');

    // Filtro: solo dispositivos Android ADB
    device = await navigator.usb.requestDevice({
      filters: [{ classCode: 0xFF, subclassCode: 0x42, protocolCode: 0x01 }]
    });

    await device.open();
    log(`Dispositivo: ${device.productName || 'Android'}`);

    // Seleccionar configuración e interfaz ADB
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    // Buscar interfaz ADB (class=0xFF, subclass=0x42, protocol=0x01)
    let adbIface = null;
    for (const cfg of device.configurations) {
      for (const intf of cfg.interfaces) {
        for (const alt of intf.alternates) {
          if (alt.interfaceClass    === 0xFF &&
              alt.interfaceSubclass === 0x42 &&
              alt.interfaceProtocol === 0x01) {
            adbIface = intf;
            epIn  = alt.endpoints.find(e => e.direction === 'in');
            epOut = alt.endpoints.find(e => e.direction === 'out');
          }
        }
      }
    }

    if (!adbIface) throw new Error(
      'Interfaz ADB no encontrada. Activa "Depuración USB" en Opciones de Desarrollador.'
    );

    iface = adbIface;
    await device.claimInterface(iface.interfaceNumber);
    log('Interfaz ADB reclamada');

    // Handshake CNXN
    await send(CMD.CNXN, VERSION, MAX_PAYLOAD, BANNER);
    log('Handshake enviado, esperando respuesta del dispositivo...');

    // Manejar AUTH / CNXN de respuesta
    await handleAuth();

    connected = true;
    log('✓ Conexión ADB establecida');
    return true;
  }

  // ── Manejo de autenticación ──────────────────────────────
  // Android cierra la conexión USB al mostrar el diálogo "Confiar en esta PC".
  // El flujo correcto es:
  //   1. Recibir AUTH_TOKEN del dispositivo
  //   2. Intentar firmar con clave RSA (si el dispositivo ya confía en nosotros)
  //   3. Si no confía: enviar clave pública, soltar la interfaz USB,
  //      esperar a que el usuario acepte, y reconectar.
  async function handleAuth() {
    const msg = await recv();

    // Dispositivo aceptó sin AUTH
    if (msg.cmd === CMD.CNXN) {
      log('Conexión aceptada directamente');
      return;
    }

    if (msg.cmd !== CMD.AUTH || msg.arg0 !== AUTH_TOKEN) {
      throw new Error('Respuesta ADB inesperada durante handshake');
    }

    log('Autenticación requerida...');

    // Generar par RSA para esta sesión
    const keyPair     = await generateRSAKeyPair();
    const pubKeyBytes = await exportPublicKeyADB(keyPair.publicKey);

    // Intentar firma — funciona si el dispositivo ya confía en este navegador
    try {
      const signature = await signToken(keyPair.privateKey, msg.payload);
      await send(CMD.AUTH, AUTH_SIGNATURE, 0, signature);
      const resp = await recvWithTimeout(3000);
      if (resp && resp.cmd === CMD.CNXN) {
        log('✓ Autenticado (dispositivo conocido)');
        return;
      }
    } catch(e) { /* no confía, continuar */ }

    // Enviar clave pública → Android muestra diálogo "Confiar en esta PC"
    // y DESCONECTA el USB temporalmente. Esto es normal.
    log('Acepta el diálogo "Confiar en esta computadora" en tu teléfono...');
    try {
      await send(CMD.AUTH, AUTH_RSAPUBKEY, 0, pubKeyBytes);
    } catch(e) { /* la desconexión puede interrumpir el send, es normal */ }

    // Soltar la interfaz — Android necesita reconectar el dispositivo
    try {
      await device.releaseInterface(iface.interfaceNumber);
    } catch(e) {}
    try {
      await device.close();
    } catch(e) {}

    log('Esperando reconexión del dispositivo (hasta 30s)...');

    // Esperar a que Android reconecte tras aceptar el diálogo
    // Polling: intentar reconectar cada 2 segundos
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        await device.open();
        if (device.configuration === null) {
          await device.selectConfiguration(1);
        }
        await device.claimInterface(iface.interfaceNumber);

        // Reenviar CNXN
        await send(CMD.CNXN, VERSION, MAX_PAYLOAD, BANNER);
        const resp = await recvWithTimeout(3000);

        if (resp && resp.cmd === CMD.CNXN) {
          log('✓ Dispositivo reconectado y autenticado');
          return;
        }
        if (resp && resp.cmd === CMD.AUTH) {
          // Necesita firma de nuevo con el nuevo token
          const sig2 = await signToken(keyPair.privateKey, resp.payload);
          await send(CMD.AUTH, AUTH_SIGNATURE, 0, sig2);
          const final = await recvWithTimeout(3000);
          if (final && final.cmd === CMD.CNXN) {
            log('✓ Autenticado tras reconexión');
            return;
          }
        }
      } catch(e) {
        // Dispositivo todavía no está listo, seguir esperando
        if (i % 3 === 0) log(`Esperando... (${(i+1)*2}s)`);
      }
    }

    throw new Error(
      'No se pudo reconectar. Asegúrate de haber tocado "Confiar" en tu teléfono y reintenta.'
    );
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Generar claves RSA para ADB ──────────────────────────
  async function generateRSAKeyPair() {
    return await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-1' },
      true, ['sign', 'verify']
    );
  }

  async function signToken(privateKey, token) {
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', privateKey, token
    );
    return new Uint8Array(sig);
  }

  async function exportPublicKeyADB(publicKey) {
    // ADB espera la clave en formato específico:
    // longitud (4 bytes LE) + clave pública RSA en formato ADB
    const exported = await crypto.subtle.exportKey('spki', publicKey);
    const keyBytes = new Uint8Array(exported);
    // Añadir longitud y null terminator como espera ADB
    const result = new Uint8Array(4 + keyBytes.length + 1);
    new DataView(result.buffer).setUint32(0, keyBytes.length, true);
    result.set(keyBytes, 4);
    return result;
  }

  // ── recv con timeout ─────────────────────────────────────
  async function recvWithTimeout(ms) {
    return Promise.race([
      recv(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), ms)
      )
    ]).catch(() => null);
  }

  // ── Abrir stream de servicio ─────────────────────────────
  // Algunos dispositivos (Xiaomi, Samsung) envían mensajes extras
  // tras la reconexión antes del OKAY. Los descartamos hasta obtenerlo.
  async function openStream(service, timeoutMs = 8000) {
    const id = localId++;
    await send(CMD.OPEN, id, 0, service + '\0');

    // Esperar OKAY descartando mensajes intermedios (max 10 intentos)
    for (let i = 0; i < 10; i++) {
      const resp = await recvWithTimeout(timeoutMs);
      if (!resp) throw new Error(`Timeout abriendo servicio: ${service}`);
      if (resp.cmd === CMD.OKAY) {
        return { localId: id, remoteId: resp.arg0 };
      }
      if (resp.cmd === CMD.CLSE) {
        throw new Error(`Servicio cerrado: ${service}`);
      }
      // CNXN u otro mensaje — descartar y seguir esperando
    }
    throw new Error(`No se pudo abrir servicio: ${service}`);
  }

  // ── Ejecutar shell command ───────────────────────────────
  // Prueba múltiples servicios en orden de compatibilidad.
  // Cada dispositivo/ROM soporta distintos servicios ADB.
  async function shell(cmd, onData) {
    log(`$ ${cmd}`);

    // Servicios a intentar en orden
    const services = [
      `exec:${cmd}`,                        // Android 8+ estándar
      `shell:${cmd}`,                       // ADB clásico
      `shell,v2,TERM=xterm-256color:${cmd}`,// Shell v2 (Pixel/stock)
      `shell,v2:${cmd}`,                    // Shell v2 minimal
    ];

    let stream = null;
    let lastErr = null;

    for (const svc of services) {
      try {
        stream = await openStream(svc);
        break; // Funcionó
      } catch(e) {
        lastErr = e;
        stream  = null;
      }
    }

    if (!stream) {
      throw new Error(`No se pudo ejecutar comando en este dispositivo: ${lastErr?.message}`);
    }

    let output = '';

    while (true) {
      const msg = await recv();
      if (msg.cmd === CMD.WRTE) {
        const chunk = decode(msg.payload);
        output += chunk;
        if (onData) onData(chunk);
        await send(CMD.OKAY, stream.localId, stream.remoteId);
      } else if (msg.cmd === CMD.CLSE) {
        break;
      }
    }
    return output;
  }

  // ── Push archivo via base64 (compatible con MIUI) ────────
  // sync: está bloqueado en MIUI. Alternativa: enviar el archivo
  // codificado en base64 via exec: y decodificarlo en el teléfono
  // con 'base64 -d' que viene en todos los Android.
  async function push(data, remotePath, onProgress) {
    const mb = (data.byteLength / 1024 / 1024).toFixed(1);
    log(`Enviando ${remotePath} (${mb} MB) via base64...`);

    const bytes  = new Uint8Array(data);
    const CHUNK  = 48 * 1024; // 48KB → ~64KB base64 por chunk
    const total  = bytes.length;
    let   offset = 0;
    let   first  = true;

    // Limpiar archivo destino
    await shell(`rm -f "${remotePath}"`);

    while (offset < total) {
      const end   = Math.min(offset + CHUNK, total);
      const slice = bytes.slice(offset, end);

      // Codificar chunk en base64
      let binary = '';
      for (let i = 0; i < slice.length; i++) {
        binary += String.fromCharCode(slice[i]);
      }
      const b64 = btoa(binary);

      // Append al archivo en el teléfono
      const op  = first ? '>' : '>>';
      const cmd = `echo '${b64}' | base64 -d ${op} "${remotePath}"`;
      await shell(cmd);

      first   = false;
      offset  = end;
      const pct = Math.round((offset / total) * 100);
      if (onProgress) onProgress(pct);
      if (pct % 10 === 0) log(`Enviando... ${pct}%`);
    }

    log(`✓ ${remotePath} enviado`);
    return true;
  }

  async function closeStream(stream) {
    await send(CMD.CLSE, stream.localId, stream.remoteId);
  }

  // ── Instalar APK ─────────────────────────────────────────
  async function installAPK(apkData, name, onProgress) {
    log(`Instalando ${name}...`);

    const tmpPath = `/data/local/tmp/${name}`;

    // 1. Push APK via base64
    await push(apkData, tmpPath, p => {
      if (onProgress) onProgress('push', p);
    });

    // 2. Instalar con pm install
    if (onProgress) onProgress('install', 0);
    let result = '';
    try {
      result = await shell(`pm install -r -t -g "${tmpPath}"`,
        chunk => log(chunk.trim())
      );
    } catch(e) {
      // pm install puede tardar mucho — si hay timeout verificar si se instaló
      log(`pm install: ${e.message} — verificando si se instaló...`);
      try {
        const check = await shell(`pm list packages | grep com.termux`);
        if (check.includes('com.termux')) {
          result = 'Success';
          log('✓ Termux encontrado instalado');
        }
      } catch(e2) { /* ignorar */ }
    }

    // 3. Limpiar tmp — completamente opcional, nunca falla la instalación
    if (onProgress) onProgress('cleanup', 0);
    // No usar shell() para rm — si todos los métodos dan timeout
    // simplemente seguimos. El archivo tmp se limpia solo eventualmente.
    Promise.resolve().then(async () => {
      try { await shell(`rm -f "${tmpPath}"`); } catch(e) { /* ignorar */ }
    });

    // Considerar éxito si pm dijo Success O si Termux está en el sistema
    const success = result.includes('Success') || result.includes('com.termux');
    if (!success) throw new Error(`Instalación falló: ${result.trim() || 'sin respuesta de pm'}`);

    if (onProgress) onProgress('install', 100);
    log(`✓ ${name} instalado`);
    return true;
  }

  // ── Desconectar ──────────────────────────────────────────
  async function disconnect() {
    if (device) {
      try {
        await device.releaseInterface(iface.interfaceNumber);
        await device.close();
      } catch(e) {}
      device = null;
      connected = false;
      log('Dispositivo desconectado');
    }
  }

  // ── API pública ──────────────────────────────────────────
  return { connect, installAPK, shell, push, disconnect,
           get connected() { return connected; } };

})();
