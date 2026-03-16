/**
 * Vault Installer — adb.js v3.0
 * Protocolo ADB sobre WebUSB con compatibilidad universal.
 *
 * Sistema de métodos en cascada:
 *   - Detecta fabricante/ROM automáticamente
 *   - Prueba métodos de más rápido a más compatible
 *   - Funciona en: Stock Android, MIUI, HyperOS, OneUI,
 *                  ColorOS, OxygenOS, EMUI, Pixel
 */

const ADB = (() => {

  // ── Constantes del protocolo ──────────────────────────────
  const CMD = {
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

  // ── Estado ────────────────────────────────────────────────
  let device      = null;
  let iface       = null;
  let epIn        = null;
  let epOut       = null;
  let localId     = 1;
  let connected   = false;
  let deviceInfo  = { manufacturer: '', model: '', sdk: 0, rom: 'unknown' };
  let onLog       = () => {};

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function log(msg)  { onLog(msg); }
  function encode(s) { return enc.encode(s); }
  function decode(b) { return dec.decode(b); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function u32le(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  }

  function readU32(buf, off) {
    return new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
  }

  // ── Mensaje ADB ───────────────────────────────────────────
  function makeMessage(cmd, arg0, arg1, data) {
    const payload  = data
      ? (data instanceof Uint8Array ? data : encode(data))
      : new Uint8Array(0);
    const dataLen  = payload.length;
    const checksum = payload.reduce((s, b) => (s + b) & 0xFFFFFFFF, 0);
    const magic    = (cmd ^ 0xFFFFFFFF) >>> 0;
    const msg      = new Uint8Array(24 + dataLen);
    const dv       = new DataView(msg.buffer);
    dv.setUint32(0,  cmd,      true);
    dv.setUint32(4,  arg0,     true);
    dv.setUint32(8,  arg1,     true);
    dv.setUint32(12, dataLen,  true);
    dv.setUint32(16, checksum, true);
    dv.setUint32(20, magic,    true);
    if (dataLen > 0) msg.set(payload, 24);
    return msg;
  }

  async function send(cmd, arg0, arg1, data) {
    await device.transferOut(epOut.endpointNumber, makeMessage(cmd, arg0, arg1, data));
  }

  async function recv() {
    const hdr     = await device.transferIn(epIn.endpointNumber, 24);
    const h       = new Uint8Array(hdr.data.buffer);
    const cmd     = readU32(h, 0);
    const arg0    = readU32(h, 4);
    const arg1    = readU32(h, 8);
    const dataLen = readU32(h, 12);
    let payload   = new Uint8Array(0);
    if (dataLen > 0) {
      const p = await device.transferIn(epIn.endpointNumber, dataLen);
      payload = new Uint8Array(p.data.buffer);
    }
    return { cmd, arg0, arg1, payload };
  }

  async function recvWithTimeout(ms) {
    return Promise.race([
      recv(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))
    ]).catch(() => null);
  }

  // ── Conectar ──────────────────────────────────────────────
  async function connect(logFn) {
    if (logFn) onLog = logFn;
    log('Solicitando acceso al dispositivo USB...');

    device = await navigator.usb.requestDevice({
      filters: [{ classCode: 0xFF, subclassCode: 0x42, protocolCode: 0x01 }]
    });

    await device.open();
    log(`Dispositivo USB: ${device.productName || 'Android'}`);

    if (device.configuration === null) await device.selectConfiguration(1);

    // Buscar interfaz ADB
    let adbIface = null;
    for (const cfg of device.configurations) {
      for (const intf of cfg.interfaces) {
        for (const alt of intf.alternates) {
          if (alt.interfaceClass === 0xFF &&
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

    await send(CMD.CNXN, VERSION, MAX_PAYLOAD, BANNER);
    log('Handshake enviado...');
    await handleAuth();

    connected = true;
    log('✓ Conexión ADB establecida');

    // Detectar dispositivo
    await detectDevice();
    return true;
  }

  // ── Auth ──────────────────────────────────────────────────
  async function handleAuth() {
    const msg = await recv();
    if (msg.cmd === CMD.CNXN) { log('Conexión directa'); return; }
    if (msg.cmd !== CMD.AUTH || msg.arg0 !== AUTH_TOKEN)
      throw new Error('Handshake ADB inesperado');

    log('Autenticación requerida...');
    const keyPair     = await generateRSAKeyPair();
    const pubKeyBytes = await exportPublicKeyADB(keyPair.publicKey);

    // Intentar firma (dispositivo ya conocido)
    try {
      const sig  = await signToken(keyPair.privateKey, msg.payload);
      await send(CMD.AUTH, AUTH_SIGNATURE, 0, sig);
      const resp = await recvWithTimeout(3000);
      if (resp && resp.cmd === CMD.CNXN) {
        log('✓ Autenticado (dispositivo conocido)');
        return;
      }
    } catch(e) {}

    // Enviar clave pública → Android muestra diálogo "Confiar"
    log('Acepta "Confiar en esta computadora" en tu teléfono...');
    try { await send(CMD.AUTH, AUTH_RSAPUBKEY, 0, pubKeyBytes); } catch(e) {}

    // Soltar USB — Android reconecta tras aceptar
    try { await device.releaseInterface(iface.interfaceNumber); } catch(e) {}
    try { await device.close(); } catch(e) {}

    log('Esperando reconexión (hasta 30s)...');
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        await device.open();
        if (device.configuration === null) await device.selectConfiguration(1);
        await device.claimInterface(iface.interfaceNumber);
        await send(CMD.CNXN, VERSION, MAX_PAYLOAD, BANNER);
        const resp = await recvWithTimeout(3000);
        if (resp && resp.cmd === CMD.CNXN) {
          log('✓ Reconectado y autenticado');
          return;
        }
        if (resp && resp.cmd === CMD.AUTH) {
          const sig2 = await signToken(keyPair.privateKey, resp.payload);
          await send(CMD.AUTH, AUTH_SIGNATURE, 0, sig2);
          const final = await recvWithTimeout(3000);
          if (final && final.cmd === CMD.CNXN) {
            log('✓ Autenticado tras reconexión');
            return;
          }
        }
      } catch(e) {
        if (i % 3 === 0) log(`Esperando... ${(i+1)*2}s`);
      }
    }
    throw new Error('No se pudo reconectar. Asegúrate de haber tocado "Confiar" en tu teléfono.');
  }

  // ── RSA ───────────────────────────────────────────────────
  async function generateRSAKeyPair() {
    return crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' },
      true, ['sign', 'verify']
    );
  }
  async function signToken(key, token) {
    return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, token));
  }
  async function exportPublicKeyADB(key) {
    const exported = await crypto.subtle.exportKey('spki', key);
    const keyBytes = new Uint8Array(exported);
    const result   = new Uint8Array(4 + keyBytes.length + 1);
    new DataView(result.buffer).setUint32(0, keyBytes.length, true);
    result.set(keyBytes, 4);
    return result;
  }

  // ── Abrir stream ──────────────────────────────────────────
  async function openStream(service, timeoutMs = 8000) {
    const id = localId++;
    await send(CMD.OPEN, id, 0, service + '\0');
    for (let i = 0; i < 10; i++) {
      const resp = await recvWithTimeout(timeoutMs);
      if (!resp)            throw new Error(`Timeout abriendo servicio: ${service}`);
      if (resp.cmd === CMD.OKAY) return { localId: id, remoteId: resp.arg0 };
      if (resp.cmd === CMD.CLSE) throw new Error(`Servicio rechazado: ${service}`);
      // Descartar mensajes intermedios (CNXN extra de algunos ROMs)
    }
    throw new Error(`No se pudo abrir: ${service}`);
  }

  async function closeStream(stream) {
    try { await send(CMD.CLSE, stream.localId, stream.remoteId); } catch(e) {}
  }

  // ── Shell universal ───────────────────────────────────────
  // Prueba servicios en orden según el ROM detectado.
  // Cada ROM tiene sus servicios disponibles:
  //   exec:     → Android 8+ estándar, Pixel, OnePlus
  //   shell:    → Universal pero más lento
  //   shell,v2: → Stock Android moderno
  async function shell(cmd, onData) {
    log(`$ ${cmd}`);

    // Orden de servicios según ROM detectado
    let services;
    switch (deviceInfo.rom) {
      case 'miui':
      case 'hyperos':
        // MIUI/HyperOS: exec: primero, shell: como fallback
        services = [`exec:${cmd}`, `shell:${cmd}`];
        break;
      case 'oneui':
        // Samsung OneUI: shell,v2 funciona bien
        services = [`shell,v2,TERM=xterm:${cmd}`, `exec:${cmd}`, `shell:${cmd}`];
        break;
      case 'emui':
        // Huawei EMUI: shell: directo
        services = [`shell:${cmd}`, `exec:${cmd}`];
        break;
      default:
        // Stock Android / Pixel / desconocido: probar todo
        services = [
          `exec:${cmd}`,
          `shell:${cmd}`,
          `shell,v2,TERM=xterm:${cmd}`,
          `shell,v2:${cmd}`,
        ];
    }

    let stream  = null;
    let lastErr = null;
    for (const svc of services) {
      try { stream = await openStream(svc); break; }
      catch(e) { lastErr = e; stream = null; }
    }

    if (!stream) throw new Error(
      `No se pudo ejecutar en este dispositivo (${deviceInfo.rom}): ${lastErr?.message}`
    );

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

  // Shell que nunca lanza — para operaciones opcionales
  async function shellSafe(cmd) {
    try { return await shell(cmd); } catch(e) { return ''; }
  }

  // ── Detectar dispositivo y ROM ────────────────────────────
  async function detectDevice() {
    log('Detectando dispositivo...');
    try {
      // Intentar obtener info básica
      const info = await shell(
        'echo MFR:$(getprop ro.product.manufacturer) ' +
        'MDL:$(getprop ro.product.model) ' +
        'SDK:$(getprop ro.build.version.sdk) ' +
        'MIUI:$(getprop ro.miui.ui.version.name) ' +
        'ONEUI:$(getprop ro.build.version.oneui)'
      );

      const mfr   = (info.match(/MFR:(\S+)/)   || [])[1] || '';
      const model = (info.match(/MDL:(\S+)/)    || [])[1] || '';
      const sdk   = parseInt((info.match(/SDK:(\d+)/) || [])[1] || '0');
      const miui  = (info.match(/MIUI:(\S+)/)   || [])[1] || '';
      const oneui = (info.match(/ONEUI:(\S+)/)  || [])[1] || '';

      deviceInfo.manufacturer = mfr.toLowerCase();
      deviceInfo.model        = model;
      deviceInfo.sdk          = sdk;

      // Detectar ROM
      if (miui && miui !== 'null' && miui !== '') {
        deviceInfo.rom = 'miui';
        // Detectar HyperOS (MIUI 2.0+)
        if (miui.startsWith('2')) deviceInfo.rom = 'hyperos';
      } else if (oneui && oneui !== 'null' && oneui !== '') {
        deviceInfo.rom = 'oneui';
      } else if (deviceInfo.manufacturer.includes('huawei') ||
                 deviceInfo.manufacturer.includes('honor')) {
        deviceInfo.rom = 'emui';
      } else if (deviceInfo.manufacturer.includes('oppo') ||
                 deviceInfo.manufacturer.includes('realme')) {
        deviceInfo.rom = 'coloros';
      } else if (deviceInfo.manufacturer.includes('vivo')) {
        deviceInfo.rom = 'funtouch';
      } else {
        deviceInfo.rom = 'stock';
      }

      log(`Dispositivo: ${mfr} ${model} | Android SDK ${sdk} | ROM: ${deviceInfo.rom}`);
    } catch(e) {
      log(`Info de dispositivo no disponible — usando modo universal`);
      deviceInfo.rom = 'unknown';
    }
  }

  // ── Push de archivo via base64 ────────────────────────────
  // Método universal que funciona en todos los ROMs.
  // Codifica el archivo en base64, lo envía en chunks via shell,
  // y el teléfono lo decodifica con `base64 -d`.
  async function pushBase64(data, remotePath, onProgress) {
    const bytes = new Uint8Array(data);
    const total = bytes.length;
    const CHUNK = 48 * 1024; // 48KB → ~64KB base64
    let offset  = 0;
    let first   = true;

    await shellSafe(`rm -f "${remotePath}"`);

    while (offset < total) {
      const end   = Math.min(offset + CHUNK, total);
      const slice = bytes.slice(offset, end);
      let binary  = '';
      for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
      const b64 = btoa(binary);
      const op  = first ? '>' : '>>';
      await shell(`printf '%s' '${b64}' | base64 -d ${op} "${remotePath}"`);
      first  = false;
      offset = end;
      if (onProgress) onProgress(Math.round((offset / total) * 100));
    }

    log(`✓ ${remotePath} enviado via base64`);
    return true;
  }

  // ── Push via sync: (más rápido, no funciona en MIUI) ──────
  async function pushSync(data, remotePath, onProgress) {
    const stream = await openStream('sync:', 5000);

    const pathPerm  = `${remotePath},0644`;
    const pathBytes = encode(pathPerm);
    const sendHdr   = new Uint8Array(8 + pathBytes.length);
    sendHdr.set(encode('SEND'));
    new DataView(sendHdr.buffer).setUint32(4, pathBytes.length, true);
    sendHdr.set(pathBytes, 8);
    await sendSyncPacket(stream, sendHdr);

    const CHUNK = 64 * 1024;
    let offset  = 0;
    while (offset < data.byteLength) {
      const end   = Math.min(offset + CHUNK, data.byteLength);
      const chunk = data.slice(offset, end);
      const hdr   = new Uint8Array(8);
      hdr.set(encode('DATA'));
      new DataView(hdr.buffer).setUint32(4, chunk.byteLength, true);
      const pkt = new Uint8Array(8 + chunk.byteLength);
      pkt.set(hdr);
      pkt.set(new Uint8Array(chunk), 8);
      await sendSyncPacket(stream, pkt);
      offset = end;
      if (onProgress) onProgress(Math.round((offset / data.byteLength) * 100));
    }

    const done = new Uint8Array(8);
    done.set(encode('DONE'));
    new DataView(done.buffer).setUint32(4, Math.floor(Date.now() / 1000), true);
    await sendSyncPacket(stream, done);
    await recv();
    await closeStream(stream);
    log(`✓ ${remotePath} enviado via sync`);
    return true;
  }

  async function sendSyncPacket(stream, data) {
    await send(CMD.WRTE, stream.localId, stream.remoteId, data);
    const ack = await recv();
    if (ack.cmd !== CMD.OKAY) throw new Error('Sync OKAY esperado');
  }

  // ── Push universal — intenta sync: luego base64 ───────────
  async function push(data, remotePath, onProgress) {
    const mb = (data.byteLength / 1024 / 1024).toFixed(1);
    log(`Enviando ${remotePath} (${mb} MB)...`);

    // MIUI/HyperOS: ir directo a base64 (sync: no funciona)
    if (deviceInfo.rom === 'miui' || deviceInfo.rom === 'hyperos' ||
        deviceInfo.rom === 'unknown') {
      log('Usando método base64 (compatible con este ROM)...');
      return pushBase64(data, remotePath, onProgress);
    }

    // Otros ROMs: intentar sync: primero (más rápido)
    try {
      log('Intentando transferencia rápida (sync)...');
      return await pushSync(data, remotePath, onProgress);
    } catch(e) {
      log(`sync: no disponible — usando base64...`);
      return pushBase64(data, remotePath, onProgress);
    }
  }

  // ── Instalar APK ──────────────────────────────────────────
  async function installAPK(apkData, name, onProgress) {
    log(`Instalando ${name}...`);
    const tmpPath = `/data/local/tmp/${name}`;

    // 1. Enviar APK
    await push(apkData, tmpPath, p => {
      if (onProgress) onProgress('push', p);
    });

    // 2. Instalar — prueba métodos según ROM
    if (onProgress) onProgress('install', 0);
    let installed = false;

    const installMethods = [
      `pm install -r -t -g "${tmpPath}"`,
      `pm install -r -t "${tmpPath}"`,
      `pm install -r "${tmpPath}"`,
      `cmd package install -r -t -g "${tmpPath}"`,
    ];

    // MIUI/HyperOS: añadir flag específico
    if (deviceInfo.rom === 'miui' || deviceInfo.rom === 'hyperos') {
      installMethods.unshift(
        `pm install -r -t -g --bypass-low-target-sdk-block "${tmpPath}"`
      );
    }

    for (const method of installMethods) {
      if (installed) break;
      try {
        log(`Instalando: ${method.split(' ')[0]} ${method.split(' ')[1]}...`);
        const result = await shellSafe(method);
        if (result.includes('Success')) {
          installed = true;
          log(`✓ Instalado correctamente`);
        }
      } catch(e) {}
    }

    // Verificación final independiente del método
    if (!installed) {
      log('Verificando instalación en el sistema...');
      const check = await shellSafe('pm list packages 2>/dev/null');
      if (check.includes('com.termux')) {
        installed = true;
        log('✓ App detectada instalada');
      }
    }

    // 3. Limpiar (fire and forget)
    if (onProgress) onProgress('cleanup', 0);
    shellSafe(`rm -f "${tmpPath}"`);

    if (!installed) throw new Error(
      `No se pudo instalar en ${deviceInfo.rom || 'este dispositivo'}. ` +
      `Intenta instalar ${name} manualmente.`
    );

    if (onProgress) onProgress('install', 100);
    log(`✓ ${name} instalado`);
    return true;
  }

  // ── Desconectar ───────────────────────────────────────────
  async function disconnect() {
    if (device) {
      try { await device.releaseInterface(iface.interfaceNumber); } catch(e) {}
      try { await device.close(); } catch(e) {}
      device    = null;
      connected = false;
      log('Dispositivo desconectado');
    }
  }

  // ── API pública ───────────────────────────────────────────
  return {
    connect, disconnect, installAPK,
    shell, shellSafe, push,
    get connected()   { return connected; },
    get deviceInfo()  { return deviceInfo; },
  };

})();
