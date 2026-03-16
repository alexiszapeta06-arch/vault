#!/bin/bash
# ═══════════════════════════════════════════════════════
# Vault Installer — Mac / Linux
# Instala Termux + AuroraOS + Vault via ADB
# ═══════════════════════════════════════════════════════

set -e

G='\033[92m'; Y='\033[93m'; R='\033[91m'
B='\033[94m'; W='\033[1;97m'; E='\033[0m'

VAULT_TMP="$HOME/.vault-install-tmp"
TOOLS_DIR="$VAULT_TMP/platform-tools"
TERMUX_URL="https://alexiszapeta06-arch.github.io/vault/termux.apk"
TERMUX_APK="$VAULT_TMP/termux.apk"

mkdir -p "$VAULT_TMP"

clear
echo ""
printf "${B}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║          Vault — Instalador              ║"
echo "  ║     Termux + AuroraOS + Vault            ║"
echo "  ╚══════════════════════════════════════════╝"
printf "${E}\n"

# ── Detectar OS ──────────────────────────────────────────
OS=$(uname -s)
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *)      PLATFORM="linux" ;;
esac

# ── Verificar/instalar ADB ───────────────────────────────
echo "  Verificando ADB..."
if command -v adb >/dev/null 2>&1; then
  ADB="adb"
  printf "  ${G}OK${E} ADB encontrado: $(adb version | head -1)\n"
else
  echo "  ADB no encontrado. Descargando Platform Tools..."
  mkdir -p "$TOOLS_DIR"

  if [ "$PLATFORM" = "mac" ]; then
    PT_URL="https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
  else
    PT_URL="https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
  fi

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$PT_URL" -o "$VAULT_TMP/platform-tools.zip"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$VAULT_TMP/platform-tools.zip" "$PT_URL"
  else
    printf "  ${R}ERROR${E}: Se necesita curl o wget.\n"
    exit 1
  fi

  unzip -q "$VAULT_TMP/platform-tools.zip" -d "$VAULT_TMP"
  chmod +x "$TOOLS_DIR/adb"
  ADB="$TOOLS_DIR/adb"
  printf "  ${G}OK${E} Platform Tools descargado\n"
fi

# ── Instrucciones previas ────────────────────────────────
echo ""
printf "  ${Y}─────────────────────────────────────────────${E}\n"
echo "  ANTES DE CONTINUAR:"
echo ""
echo "  1. Activa 'Depuración USB' en tu teléfono:"
echo "     Ajustes → Acerca del teléfono →"
echo "     toca 'Número de compilación' 7 veces →"
echo "     Opciones de desarrollador →"
echo "     Depuración USB: ON"
echo ""
echo "  2. Conecta tu teléfono por USB"
echo "  3. Acepta 'Confiar en esta PC' en tu teléfono"
printf "  ${Y}─────────────────────────────────────────────${E}\n"
echo ""
read -p "  Presiona Enter cuando estés listo..."

# ── Verificar dispositivo ────────────────────────────────
echo ""
echo "  Verificando conexión ADB..."
"$ADB" kill-server >/dev/null 2>&1 || true
"$ADB" start-server >/dev/null 2>&1

MAX_WAIT=30
WAITED=0
while ! "$ADB" devices | grep -q "device$"; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    printf "  ${R}ERROR${E}: No se detecta ningún dispositivo.\n"
    echo "  Verifica el cable, la depuración USB y el diálogo 'Confiar'."
    exit 1
  fi
  printf "  Esperando dispositivo... ${WAITED}s\r"
  sleep 2
  WAITED=$((WAITED+2))
done

MODEL=$("$ADB" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
SDK=$("$ADB" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
printf "  ${G}OK${E} Dispositivo: $MODEL (SDK $SDK)\n"

# ── Descargar Termux ─────────────────────────────────────
echo ""
echo "  Descargando Termux..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --progress-bar "$TERMUX_URL" -o "$TERMUX_APK"
else
  wget -q --show-progress "$TERMUX_URL" -O "$TERMUX_APK"
fi
printf "  ${G}OK${E} Termux descargado ($(du -sh "$TERMUX_APK" | cut -f1))\n"

# ── Instalar Termux ──────────────────────────────────────
echo "  Instalando Termux en el teléfono..."
"$ADB" install -r -t -g "$TERMUX_APK" >/dev/null 2>&1 || \
"$ADB" install -r -t "$TERMUX_APK" >/dev/null 2>&1 || \
"$ADB" install -r "$TERMUX_APK" >/dev/null 2>&1 || true

if ! "$ADB" shell pm list packages 2>/dev/null | grep -q "com.termux"; then
  printf "  ${R}ERROR${E}: No se pudo instalar Termux.\n"
  echo "  Instálalo manualmente desde F-Droid."
  exit 1
fi
printf "  ${G}OK${E} Termux instalado\n"

# ── Crear y enviar script de setup ───────────────────────
echo "  Preparando configuración de AuroraOS..."

SETUP="$VAULT_TMP/vault-setup.sh"
cat > "$SETUP" << 'SETUPEOF'
#!/data/data/com.termux/files/usr/bin/bash
export TERM=xterm-256color
export HOME=/data/data/com.termux/files/home
cd "$HOME"

echo ""
echo "  Instalando AuroraOS + Vault..."
echo ""

pkg update -y -q 2>/dev/null | tail -2
pkg install -y -q proot-distro python curl 2>/dev/null | tail -2
echo "  OK proot-distro listo"

if ! proot-distro list 2>/dev/null | grep -q "alpine.*installed"; then
  proot-distro install alpine 2>/dev/null
fi
echo "  OK AuroraOS instalado"

mkdir -p "$HOME/.vault/aurora-data"/{apps,apks,registry,tmp,core,shortcuts}
mkdir -p "$HOME/.shortcuts"

proot-distro login alpine \
  --bind "$HOME/.vault/aurora-data":/home/vault \
  --shared-tmp \
  -- sh -c "
    apk update -q 2>/dev/null
    apk add --no-cache python3 py3-pip -q 2>/dev/null
    pip3 install flask --quiet --break-system-packages 2>/dev/null || \
    pip3 install flask --quiet 2>/dev/null
    mkdir -p /home/vault/{apps,apks,registry,tmp,core,shortcuts}
    echo 'AuroraOS' > /etc/aurora-release
  " 2>/dev/null
echo "  OK AuroraOS configurado"

curl -fsSL "https://alexiszapeta06-arch.github.io/vault/server.py" \
  -o "$HOME/.vault/aurora-data/server.py" 2>/dev/null
curl -fsSL "https://alexiszapeta06-arch.github.io/vault/core.py" \
  -o "$HOME/.vault/aurora-data/core.py" 2>/dev/null
echo "  OK Vault server listo"

cat > "$HOME/.vault/vault-ghost.sh" << 'GHOST'
#!/bin/sh
VAULT_DIR="$HOME/.vault"
DATA="$VAULT_DIR/aurora-data"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock >/dev/null 2>&1 || true
proot-distro login alpine \
  --bind "$DATA":/home/vault \
  --shared-tmp \
  -- python3 /home/vault/server.py >/dev/null 2>&1 &
echo $! > "$VAULT_DIR/vault.pid"
sleep 3
command -v termux-open-url >/dev/null 2>&1 && \
  termux-open-url "http://localhost:7070" >/dev/null 2>&1 &
exit 0
GHOST
chmod 755 "$HOME/.vault/vault-ghost.sh"

cat > "$HOME/.shortcuts/Vault.sh" << 'SC'
#!/data/data/com.termux/files/usr/bin/sh
exec sh "$HOME/.vault/vault-ghost.sh"
SC
chmod 755 "$HOME/.shortcuts/Vault.sh"

if ! grep -q "vault-ghost" "$HOME/.bashrc" 2>/dev/null; then
  echo '' >> "$HOME/.bashrc"
  echo '# Vault auto-start' >> "$HOME/.bashrc"
  echo 'sh "$HOME/.vault/vault-ghost.sh" &' >> "$HOME/.bashrc"
fi

sh "$HOME/.vault/vault-ghost.sh"
echo ""
echo "  ✓ Vault listo en http://localhost:7070"
echo ""
SETUPEOF

"$ADB" push "$SETUP" /data/local/tmp/vault-setup.sh >/dev/null 2>&1
"$ADB" shell chmod 755 /data/local/tmp/vault-setup.sh

# ── Ejecutar setup ───────────────────────────────────────
echo "  Ejecutando setup en el teléfono (2-3 minutos)..."
echo "  No desconectes el cable..."
echo ""

"$ADB" shell "run-as com.termux bash /data/local/tmp/vault-setup.sh" 2>/dev/null || {
  "$ADB" shell "am start -n com.termux/.HomeActivity" >/dev/null 2>&1
  sleep 3
  "$ADB" shell "input text 'bash /data/local/tmp/vault-setup.sh && exit'" >/dev/null 2>&1
  "$ADB" shell "input keyevent 66" >/dev/null 2>&1
  echo "  Setup lanzado en Termux. Esperando..."
  sleep 90
}

# ── Limpiar ──────────────────────────────────────────────
"$ADB" shell rm -f /data/local/tmp/vault-setup.sh >/dev/null 2>&1 || true
rm -rf "$VAULT_TMP"

# ── Listo ────────────────────────────────────────────────
echo ""
printf "${G}${W}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║      Vault instalado correctamente  ✓   ║"
echo "  ╚══════════════════════════════════════════╝"
printf "${E}"
echo ""
echo "  Siguiente paso — ícono en pantalla:"
echo "  1. Instala 'Termux:Widget' desde F-Droid"
echo "  2. Mantén presionada tu pantalla de inicio"
echo "  3. Añade widget → Termux:Widget"
echo "  4. Toca 'Vault' para abrir la store"
echo ""
printf "  URL directa: ${B}http://localhost:7070${E}\n"
echo "  (abre Termux primero)"
echo ""
