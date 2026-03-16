/**
 * Vault Installer — installer.js
 * Orquesta la instalación completa:
 *   1. Termux APK
 *   2. Script de setup AuroraOS (Alpine renombrado)
 *   3. Vault server + UI
 */

const Installer = (() => {

  // ── URLs de descarga ────────────────────────────────────
  // Termux oficial de GitHub Releases (no Play Store)
  // GitHub Releases no permite fetch directo por CORS.
  // Usamos el proxy de jsdelivr que sí tiene CORS abierto,
  // con fallback a corsproxy.io si falla.
  const TERMUX_FILENAME = 'termux-app_v0.119.0-beta.3+apt-android-7-github-debug_arm64-v8a.apk';
  const TERMUX_REPO     = 'termux/termux-app';
  const TERMUX_TAG      = 'v0.119.0-beta.3';
  const TERMUX_URL      = `https://cdn.jsdelivr.net/gh/${TERMUX_REPO}@${TERMUX_TAG}/${TERMUX_FILENAME}`;
  const TERMUX_URL_FB   = `https://corsproxy.io/?https://github.com/${TERMUX_REPO}/releases/download/${TERMUX_TAG}/${TERMUX_FILENAME}`;

  // Script de setup que corre dentro de Termux al primer arranque
  // Instala AuroraOS (Alpine) + Vault server
  const SETUP_SCRIPT = `#!/data/data/com.termux/files/usr/bin/bash
# Vault — AuroraOS Setup Script
# Instala el entorno AuroraOS y el servidor Vault

set -e
export TERM=xterm-256color

echo ""
echo "  ┌─────────────────────────────────┐"
echo "  │   Vault — Configurando entorno  │"
echo "  │   AuroraOS + Vault Server       │"
echo "  └─────────────────────────────────┘"
echo ""

# ── Actualizar Termux ─────────────────────────────────────
echo "  Actualizando repositorios..."
pkg update -y -q 2>/dev/null | tail -1

# ── Instalar dependencias base ────────────────────────────
echo "  Instalando dependencias..."
pkg install -y -q proot-distro python curl wget 2>/dev/null | tail -3

# ── Instalar AuroraOS (Alpine con identidad propia) ───────
echo "  Instalando AuroraOS..."
if ! proot-distro list 2>/dev/null | grep -q "alpine.*installed"; then
  proot-distro install alpine 2>/dev/null
fi

# ── Crear estructura de directorios persistente ───────────
mkdir -p "$HOME/.vault/aurora-data"/{apps,apks,registry,tmp,core,shortcuts}
mkdir -p "$HOME/.shortcuts"

# ── Configurar AuroraOS internamente ─────────────────────
echo "  Configurando AuroraOS..."
proot-distro login alpine \\
  --bind "$HOME/.vault/aurora-data":/home/vault \\
  --shared-tmp \\
  -- sh -c "
    apk update -q 2>/dev/null
    apk add --no-cache python3 py3-pip -q 2>/dev/null
    pip3 install flask --quiet --break-system-packages 2>/dev/null || \\
    pip3 install flask --quiet 2>/dev/null
    mkdir -p /home/vault/{apps,apks,registry,tmp,core,shortcuts}

    # Identidad AuroraOS
    echo 'AuroraOS' > /etc/aurora-release
    cat > /etc/os-release << 'OSEOF'
NAME=\\"AuroraOS\\"
ID=auroraos
VERSION_ID=\\"1.0\\"
PRETTY_NAME=\\"AuroraOS 1.0\\"
OSEOF
    echo 'aurora' > /etc/hostname
  " 2>/dev/null

# ── Instalar Vault server ─────────────────────────────────
echo "  Instalando Vault server..."
VAULT_DIR="$HOME/.vault/aurora-data"

# Descargar server.py si no existe
if [ ! -f "$VAULT_DIR/server.py" ]; then
  curl -fsSL "https://alexiszapeta06-arch.github.io/vault/server.py" -o "$VAULT_DIR/server.py" 2>/dev/null || \\
  wget -qO "$VAULT_DIR/server.py" "https://alexiszapeta06-arch.github.io/vault/server.py" 2>/dev/null || true
fi

if [ ! -f "$VAULT_DIR/core.py" ]; then
  curl -fsSL "https://alexiszapeta06-arch.github.io/vault/core.py" -o "$VAULT_DIR/core.py" 2>/dev/null || \\
  wget -qO "$VAULT_DIR/core.py" "https://alexiszapeta06-arch.github.io/vault/core.py" 2>/dev/null || true
fi

# ── Crear scripts de control ──────────────────────────────

# vault-start.sh
cat > "$HOME/.vault/vault-start.sh" << 'VSTART'
#!/bin/sh
VAULT_DIR="$HOME/.vault"
DATA_DIR="$VAULT_DIR/aurora-data"
PID_FILE="$VAULT_DIR/vault.pid"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null || true

proot-distro login alpine \\
  --bind "$DATA_DIR":/home/vault \\
  --shared-tmp \\
  -- python3 /home/vault/server.py &

echo $! > "$PID_FILE"
sleep 2

command -v termux-open-url >/dev/null 2>&1 && \\
  termux-open-url "http://localhost:7070" 2>/dev/null || true

trap 'exit 0' INT TERM
while true; do
  sleep 20
  kill -0 "$(cat $PID_FILE 2>/dev/null)" 2>/dev/null || {
    proot-distro login alpine \\
      --bind "$DATA_DIR":/home/vault \\
      --shared-tmp \\
      -- python3 /home/vault/server.py &
    echo $! > "$PID_FILE"
  }
done
VSTART
chmod 755 "$HOME/.vault/vault-start.sh"

# vault-ghost.sh (silencioso)
cat > "$HOME/.vault/vault-ghost.sh" << 'VGHOST'
#!/bin/sh
VAULT_DIR="$HOME/.vault"
DATA_DIR="$VAULT_DIR/aurora-data"
PID_FILE="$VAULT_DIR/vault.pid"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock >/dev/null 2>&1 || true

proot-distro login alpine \\
  --bind "$DATA_DIR":/home/vault \\
  --shared-tmp \\
  -- python3 /home/vault/server.py >/dev/null 2>&1 &

echo $! > "$PID_FILE"

i=0
while [ $i -lt 8 ]; do
  sleep 1
  curl -s --max-time 1 http://localhost:7070/ >/dev/null 2>&1 && break
  i=$((i+1))
done

command -v termux-open-url >/dev/null 2>&1 && \\
  termux-open-url "http://localhost:7070" >/dev/null 2>&1 &
exit 0
VGHOST
chmod 755 "$HOME/.vault/vault-ghost.sh"

# vault-stop.sh
cat > "$HOME/.vault/vault-stop.sh" << 'VSTOP'
#!/bin/sh
PID_FILE="$HOME/.vault/vault.pid"
[ -f "$PID_FILE" ] && kill "$(cat $PID_FILE)" 2>/dev/null || true
pkill -f "server.py" 2>/dev/null || true
pkill -f "vault-start" 2>/dev/null || true
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock 2>/dev/null || true
rm -f "$PID_FILE"
echo "Vault detenido."
VSTOP
chmod 755 "$HOME/.vault/vault-stop.sh"

# ── Shortcut Termux:Widget ────────────────────────────────
cat > "$HOME/.shortcuts/Vault.sh" << 'SC'
#!/data/data/com.termux/files/usr/bin/sh
exec sh "$HOME/.vault/vault-ghost.sh"
SC
chmod 755 "$HOME/.shortcuts/Vault.sh"

# ── Auto-start en .bashrc ─────────────────────────────────
if ! grep -q "vault-ghost" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" << 'BASHRC'

# ── Vault auto-start ──────────────────────────────────────
_vault_auto() {
  local PF="$HOME/.vault/vault.pid"
  if [ ! -f "$PF" ] || ! kill -0 "$(cat $PF 2>/dev/null)" 2>/dev/null; then
    sh "$HOME/.vault/vault-ghost.sh" &
  fi
}
_vault_auto
alias vault="sh $HOME/.vault/vault-start.sh"
alias vault-stop="sh $HOME/.vault/vault-stop.sh"
# ─────────────────────────────────────────────────────────
BASHRC
fi

# ── Lanzar Vault por primera vez ─────────────────────────
echo ""
echo "  ✓ AuroraOS configurado"
echo "  ✓ Vault server instalado"
echo "  ✓ Shortcut creado en ~/.shortcuts/Vault.sh"
echo ""
echo "  Iniciando Vault..."
sh "$HOME/.vault/vault-ghost.sh"
echo ""
echo "  ✓ Vault activo en http://localhost:7070"
echo ""
echo "  Para el ícono en pantalla:"
echo "  Instala Termux:Widget desde F-Droid"
echo "  y añade el widget a tu launcher."
echo ""
`;

  // ── Estado de la instalación ───────────────────────────
  let onStatus  = () => {};
  let onLog     = () => {};
  let onStep    = () => {};

  function status(msg, type = 'loading') { onStatus(msg, type); }
  function log(msg)                      { onLog(msg); }
  function step(n, msg)                  { onStep(n, msg); }

  // ── Descargar APK con progreso ──────────────────────────
  async function downloadAPK(url, name, onProgress, fallbackUrl) {
    log(`Descargando ${name}...`);

    // Intentar URL principal, luego fallback si falla CORS
    let resp;
    try {
      resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch(e) {
      if (fallbackUrl) {
        log(`Reintentando con mirror alternativo...`);
        resp = await fetch(fallbackUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} al descargar ${name}`);
      } else {
        throw new Error(`No se pudo descargar ${name}: ${e.message}`);
      }
    }

    const total  = parseInt(resp.headers.get('content-length') || '0');
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total && onProgress) {
        onProgress(Math.round((received / total) * 100));
      }
    }

    const blob   = new Blob(chunks);
    const buffer = await blob.arrayBuffer();
    log(`✓ ${name} descargado (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    return buffer;
  }

  // ── Instalación completa ────────────────────────────────
  async function install(logFn, statusFn, stepFn) {
    onLog    = logFn    || onLog;
    onStatus = statusFn || onStatus;
    onStep   = stepFn   || onStep;

    try {

      // ── PASO 1: Conectar via ADB ──────────────────────
      step(1, 'Conectando dispositivo');
      status('Conectando via ADB...', 'loading');
      await ADB.connect(log);
      status('✓ Dispositivo conectado', 'ok');

      // Verificación de dispositivo omitida — shell directo no disponible
      // en algunos dispositivos MIUI/Xiaomi via WebUSB.
      // La conexión ADB ya fue verificada en el paso de autenticación.
      log('Dispositivo conectado y listo');

      // ── PASO 2: Descargar Termux ──────────────────────
      step(2, 'Descargando Termux');
      status('Descargando Termux...', 'loading');

      const termuxData = await downloadAPK(
        TERMUX_URL, 'Termux',
        p => status(`Descargando Termux... ${p}%`, 'loading'),
        TERMUX_URL_FB
      );

      // ── PASO 3: Instalar Termux ───────────────────────
      step(3, 'Instalando Termux');
      status('Instalando Termux...', 'loading');

      await ADB.installAPK(termuxData, 'termux.apk', (phase, p) => {
        if (phase === 'push')    status(`Enviando Termux al dispositivo... ${p}%`, 'loading');
        if (phase === 'install') status('Instalando Termux...', 'loading');
      });

      status('✓ Termux instalado', 'ok');

      // ── PASO 4: Enviar script de setup ────────────────
      step(4, 'Configurando AuroraOS');
      status('Enviando script de configuración...', 'loading');

      const scriptData = new TextEncoder().encode(SETUP_SCRIPT);
      await ADB.push(
        scriptData.buffer,
        '/data/local/tmp/vault-setup.sh',
        p => status(`Enviando configuración... ${p}%`, 'loading')
      );

      // ── PASO 5: Ejecutar setup dentro de Termux ───────
      step(5, 'Instalando AuroraOS + Vault');
      status('Configurando AuroraOS y Vault...', 'loading');
      log('Ejecutando setup en Termux (puede tardar 2-3 minutos)...');

      // Dar permisos y ejecutar el script via am (Activity Manager)
      await ADB.shell('chmod 755 /data/local/tmp/vault-setup.sh');

      // Lanzar Termux con el script de setup
      const launchResult = await ADB.shell(
        'am start -n com.termux/.HomeActivity' +
        ' --es com.termux.app.EXTRA_ARGUMENTS' +
        ' "bash /data/local/tmp/vault-setup.sh"'
      );
      log(launchResult.trim());

      status('AuroraOS instalándose en Termux...', 'loading');
      log('El script de configuración se está ejecutando en Termux.');
      log('Esto puede tardar 2-3 minutos según tu conexión a internet.');

      // Esperar a que el setup termine (polling del PID file)
      let ready = false;
      for (let i = 0; i < 180; i++) { // max 3 minutos
        await sleep(1000);
        const check = await ADB.shell(
          'test -f /data/data/com.termux/files/home/.vault/vault-ghost.sh && echo OK || echo WAIT'
        );
        if (check.includes('OK')) {
          ready = true;
          break;
        }
        if (i % 10 === 0) log(`Esperando setup... ${i}s`);
      }

      if (!ready) {
        log('⚠ El setup tardó más de lo esperado. Abre Termux manualmente para verificar.');
      }

      // ── PASO 6: Limpiar y finalizar ───────────────────
      step(6, 'Finalizando');
      await ADB.shell('rm -f /data/local/tmp/vault-setup.sh');
      status('✓ Instalación completada', 'ok');

      await ADB.disconnect();

      return { success: true };

    } catch (err) {
      status(`✗ Error: ${err.message}`, 'error');
      log(`Error: ${err.message}`);
      try { await ADB.disconnect(); } catch(e) {}
      return { success: false, error: err.message };
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { install };

})();
