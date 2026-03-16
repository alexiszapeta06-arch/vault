#!/bin/sh
# ═══════════════════════════════════════════════════════════
# Vault — Installer v1.0
# Un comando instala todo:
#   curl -fsSL <url>/install.sh | bash
#   o: bash install.sh
#
# Qué hace:
#   1. Instala proot-distro y dependencias en Termux
#   2. Instala Alpine Linux vía proot-distro
#   3. Crea volumen persistente en $HOME/.vault/alpine-data/
#      con bind mount → /home/vault dentro de Alpine
#   4. Instala Flask y dependencias dentro de Alpine
#   5. Crea shortcuts en ~/.shortcuts/ (Termux:Widget)
#   6. Configura arranque automático en ~/.bashrc
# ═══════════════════════════════════════════════════════════

set -e

APP_NAME="Vault"
VERSION="1.0.0"
VAULT_DIR="$HOME/.vault"
DATA_DIR="$VAULT_DIR/alpine-data"    # Volumen persistente HOST
GUEST_HOME="/home/vault"             # Ruta dentro de Alpine
SCRIPTS_DIR="$VAULT_DIR/scripts"
SHORTCUTS_DIR="$HOME/.shortcuts"
LOG="$VAULT_DIR/install.log"
PORT=7070

# ── Colores ──────────────────────────────────────────────────
G='\033[92m'; Y='\033[93m'; R='\033[91m'
B='\033[94m'; W='\033[1;97m'; D='\033[2m'; E='\033[0m'

ok()   { printf "  ${G}✓${E} %s\n" "$1"; }
warn() { printf "  ${Y}!${E} %s\n" "$1"; }
err()  { printf "  ${R}✗${E} %s\n" "$1" >&2; }
step() { printf "\n${B}▶${E} ${W}%s${E}\n" "$1"; }
log()  { echo "[$(date +%H:%M:%S)] $1" >> "$LOG"; }

# ── Banner ───────────────────────────────────────────────────
clear
printf "${B}"
cat << 'EOF'
 __   __          _ _
 \ \ / /_ _ _  _| | |_
  \ V / _` | || | |  _|
   \_/\__,_|\_,_|_|\__|

EOF
printf "${E}"
printf "  ${W}$APP_NAME v$VERSION${E}  —  App Store para Termux\n\n"

# ── Crear estructura de directorios ──────────────────────────
step "Preparando directorios"
mkdir -p "$VAULT_DIR" "$DATA_DIR" "$SCRIPTS_DIR" "$SHORTCUTS_DIR"
mkdir -p "$DATA_DIR"/{apps,apks,registry,tmp,shortcuts}
touch "$LOG"
ok "Estructura $VAULT_DIR/ creada"
ok "Volumen persistente: $DATA_DIR"

# ── Verificar Termux ─────────────────────────────────────────
step "Verificando entorno Termux"

if [ -z "${TERMUX_VERSION:-}" ] && ! echo "${PREFIX:-}" | grep -q termux 2>/dev/null; then
  warn "No parece ser Termux — algunos features pueden no funcionar"
else
  ok "Termux $(echo ${TERMUX_VERSION:-?})"
fi

FREE=$(df -k "$HOME" 2>/dev/null | tail -1 | awk '{print $4}')
if [ "${FREE:-0}" -lt 512000 ] 2>/dev/null; then
  warn "Espacio libre bajo (${FREE}KB). Se recomiendan 500MB+"
else
  ok "Espacio disponible"
fi

# ── Instalar dependencias Termux ─────────────────────────────
step "Instalando dependencias en Termux"

pkg update -y -q 2>/dev/null | tail -1 || true

PKGS="proot-distro python python-pip"
for p in $PKGS; do
  if ! command -v "$p" >/dev/null 2>&1 && \
     ! pkg list-installed 2>/dev/null | grep -q "^$p"; then
    printf "  Instalando $p..."
    pkg install -y -q "$p" >> "$LOG" 2>&1 && printf " ${G}✓${E}\n" || printf " ${Y}!${E}\n"
  else
    ok "$p ya instalado"
  fi
done

# termux-api (para abrir browser y wake lock)
if ! pkg list-installed 2>/dev/null | grep -q "^termux-api"; then
  printf "  Instalando termux-api (opcional)..."
  pkg install -y -q termux-api >> "$LOG" 2>&1 && printf " ${G}✓${E}\n" || printf " ${Y}skip${E}\n"
fi

# ── Instalar Alpine Linux ────────────────────────────────────
step "Instalando Alpine Linux (proot-distro)"

if proot-distro list 2>/dev/null | grep -q "alpine.*installed"; then
  ok "Alpine ya instalado"
else
  printf "  Descargando Alpine Linux..."
  proot-distro install alpine >> "$LOG" 2>&1
  printf " ${G}✓${E}\n"
fi

# ── Localizar rootfs de Alpine ───────────────────────────────
step "Configurando volumen persistente"

ALPINE_ROOTFS=""
for d in \
  "${PREFIX:-/usr}/var/lib/proot-distro/installed-rootfs/alpine" \
  "$HOME/../usr/var/lib/proot-distro/installed-rootfs/alpine" \
  "/data/data/com.termux/files/usr/var/lib/proot-distro/installed-rootfs/alpine"
do
  [ -d "$d" ] && ALPINE_ROOTFS="$d" && break
done

echo "$ALPINE_ROOTFS" > "$VAULT_DIR/rootfs_path"

if [ -n "$ALPINE_ROOTFS" ]; then
  ok "rootfs: $ALPINE_ROOTFS"
else
  warn "rootfs no localizado, se detectará en el primer arranque"
fi

# El volumen persistente $DATA_DIR en el host se monta en
# $GUEST_HOME dentro de Alpine vía --bind de proot.
# Los datos sobreviven a reinicios porque viven en $HOME de Termux,
# que Android preserva salvo desinstalación de Termux.
ok "Bind: $DATA_DIR → $GUEST_HOME (dentro de Alpine)"

# ── Copiar scripts al volumen ────────────────────────────────
step "Instalando scripts de Vault en el volumen"

SCRIPT_BASE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)"

for f in server.py core/registry.py core/apk_handler.py core/zip_handler.py; do
  src="$SCRIPT_BASE/$f"
  dst_dir="$DATA_DIR/$(dirname "$f")"
  mkdir -p "$dst_dir"
  if [ -f "$src" ]; then
    cp "$src" "$dst_dir/"
    ok "$f copiado"
  else
    warn "$f no encontrado (descárgalo en $DATA_DIR/)"
  fi
done

# ── Configurar Alpine (primer arranque) ──────────────────────
step "Configurando Alpine Linux"

# Script de setup que corre dentro de Alpine
cat > "$VAULT_DIR/alpine-setup.sh" << 'ALPINE_SETUP'
#!/bin/sh
set -e
echo "  [Alpine] Actualizando repos..."
apk update -q

echo "  [Alpine] Instalando Python, pip, curl..."
apk add --no-cache python3 py3-pip curl busybox-extras -q

echo "  [Alpine] Instalando Flask..."
pip3 install flask --quiet --break-system-packages 2>/dev/null || \
pip3 install flask --quiet

echo "  [Alpine] Creando estructura /home/vault/..."
mkdir -p /home/vault/{apps,apks,registry,tmp,core,shortcuts}

echo "  [Alpine] Setup completado"
ALPINE_SETUP

proot-distro login alpine \
  --bind "$DATA_DIR":"$GUEST_HOME" \
  --shared-tmp \
  -- sh /home/vault/../../../tmp/vault-alpine-setup.sh 2>/dev/null || \
proot-distro login alpine \
  --bind "$DATA_DIR":"$GUEST_HOME" \
  --shared-tmp \
  -- sh -c "
    apk update -q 2>/dev/null
    apk add --no-cache python3 py3-pip curl -q 2>/dev/null
    pip3 install flask --quiet --break-system-packages 2>/dev/null || \
    pip3 install flask --quiet 2>/dev/null
    mkdir -p /home/vault/{apps,apks,registry,tmp,core}
    echo 'Alpine configurado'
  " && ok "Alpine configurado" || warn "Configura Alpine manualmente (ver README)"

# ── Escribir scripts de control ──────────────────────────────
step "Escribiendo scripts de control"

# ── vault-start.sh ───────────────────────────────────────────
cat > "$VAULT_DIR/vault-start.sh" << VSTART
#!/bin/sh
# Vault — Iniciar servidor
VAULT_DIR="\$HOME/.vault"
DATA_DIR="\$VAULT_DIR/alpine-data"
GUEST_HOME="/home/vault"
PID_FILE="\$VAULT_DIR/vault.pid"
PORT=$PORT

# Wake lock (si termux-api está instalado)
command -v termux-wake-lock >/dev/null 2>&1 && \
  termux-wake-lock 2>/dev/null && echo "  Wake lock activado" || true

echo ""
echo "  ┌──────────────────────────────┐"
echo "  │  Vault v$VERSION               │"
echo "  │  Iniciando servidor...       │"
echo "  └──────────────────────────────┘"
echo ""

# Lanzar Flask dentro de Alpine con bind mount persistente
proot-distro login alpine \\
  --bind "\$DATA_DIR":"\$GUEST_HOME" \\
  --shared-tmp \\
  -- python3 /home/vault/server.py &

SERVER_PID=\$!
echo "\$SERVER_PID" > "\$PID_FILE"

# Esperar que Flask arranque
sleep 2

echo "  ✓ Servidor activo en http://localhost:$PORT"
echo "  ✓ PID: \$SERVER_PID"
echo ""

# Abrir navegador
command -v termux-open-url >/dev/null 2>&1 && \\
  termux-open-url "http://localhost:$PORT" 2>/dev/null || true

# Watchdog
trap 'echo "  Deteniendo..."; exit 0' INT TERM
while true; do
  sleep 20
  kill -0 "\$SERVER_PID" 2>/dev/null || {
    proot-distro login alpine \\
      --bind "\$DATA_DIR":"\$GUEST_HOME" \\
      --shared-tmp \\
      -- python3 /home/vault/server.py &
    SERVER_PID=\$!
    echo "\$SERVER_PID" > "\$PID_FILE"
  }
done
VSTART
chmod 755 "$VAULT_DIR/vault-start.sh"
ok "vault-start.sh"

# ── vault-stop.sh ────────────────────────────────────────────
cat > "$VAULT_DIR/vault-stop.sh" << 'VSTOP'
#!/bin/sh
VAULT_DIR="$HOME/.vault"
PID_FILE="$VAULT_DIR/vault.pid"
[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true
pkill -f "server.py" 2>/dev/null || true
pkill -f "vault-start" 2>/dev/null || true
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock 2>/dev/null || true
rm -f "$PID_FILE"
echo "  ✓ Vault detenido"
VSTOP
chmod 755 "$VAULT_DIR/vault-stop.sh"
ok "vault-stop.sh"

# ── vault-ghost.sh (inicio silencioso) ───────────────────────
cat > "$VAULT_DIR/vault-ghost.sh" << VGHOST
#!/bin/sh
# Vault Ghost — inicia silencioso y abre el browser
VAULT_DIR="\$HOME/.vault"
DATA_DIR="\$VAULT_DIR/alpine-data"
PID_FILE="\$VAULT_DIR/vault.pid"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock >/dev/null 2>&1 || true

proot-distro login alpine \\
  --bind "\$DATA_DIR":/home/vault \\
  --shared-tmp \\
  -- python3 /home/vault/server.py >/dev/null 2>&1 &

echo \$! > "\$PID_FILE"

# Esperar Flask
i=0
while [ \$i -lt 8 ]; do
  sleep 1
  curl -s --max-time 1 http://localhost:$PORT/ >/dev/null 2>&1 && break
  i=\$((i+1))
done

command -v termux-open-url >/dev/null 2>&1 && \\
  termux-open-url "http://localhost:$PORT" >/dev/null 2>&1 &

exit 0
VGHOST
chmod 755 "$VAULT_DIR/vault-ghost.sh"
ok "vault-ghost.sh"

# ── Shortcuts Termux:Widget ──────────────────────────────────
step "Creando shortcuts para pantalla"

# Shortcut principal — abre Vault
cat > "$SHORTCUTS_DIR/Vault.sh" << SHORTCUT
#!/data/data/com.termux/files/usr/bin/sh
# Toca este ícono en Termux:Widget para abrir Vault
exec sh "\$HOME/.vault/vault-ghost.sh"
SHORTCUT
chmod 755 "$SHORTCUTS_DIR/Vault.sh"
ok "~/.shortcuts/Vault.sh creado"

# Shortcut de parada
cat > "$SHORTCUTS_DIR/Vault Stop.sh" << SHORTSTOP
#!/data/data/com.termux/files/usr/bin/sh
exec sh "\$HOME/.vault/vault-stop.sh"
SHORTSTOP
chmod 755 "$SHORTCUTS_DIR/Vault Stop.sh"
ok "~/.shortcuts/Vault Stop.sh creado"

# ── Arranque automático en .bashrc ───────────────────────────
step "Configurando arranque automático"

BASHRC_BLOCK='
# ── Vault auto-start ─────────────────────────────────────────
_vault_autostart() {
  local PID_F="$HOME/.vault/vault.pid"
  # Solo arrancar si no está corriendo ya
  if [ ! -f "$PID_F" ] || ! kill -0 "$(cat "$PID_F")" 2>/dev/null; then
    sh "$HOME/.vault/vault-ghost.sh" &
  fi
}
# Arrancar Vault al abrir Termux (en background, no bloquea el shell)
_vault_autostart

# Aliases
alias vault="sh $HOME/.vault/vault-start.sh"
alias vault-stop="sh $HOME/.vault/vault-stop.sh"
alias vault-ghost="sh $HOME/.vault/vault-ghost.sh"
# ─────────────────────────────────────────────────────────────
'

for RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$RC" ] && ! grep -q "Vault auto-start" "$RC" 2>/dev/null; then
    echo "$BASHRC_BLOCK" >> "$RC"
    ok "Auto-start añadido a $(basename "$RC")"
  fi
done

# ── Resumen ──────────────────────────────────────────────────
echo ""
printf "${G}${W}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   Vault instalado correctamente  ✓       ║"
echo "  ╚══════════════════════════════════════════╝"
printf "${E}"
echo ""
echo "  Comandos:"
printf "  ${B}vault${E}            Iniciar (con terminal)\n"
printf "  ${B}vault-ghost${E}      Iniciar silencioso + abrir browser\n"
printf "  ${B}vault-stop${E}       Detener\n"
echo ""
echo "  Pantalla de inicio:"
printf "  ${Y}1.${E} Instala ${B}Termux:Widget${E} desde F-Droid\n"
printf "  ${Y}2.${E} Mantén presionada tu pantalla de inicio\n"
printf "  ${Y}3.${E} Añade widget → Termux:Widget\n"
printf "  ${Y}4.${E} Toca ${B}Vault${E} — abre el store directo\n"
echo ""
printf "  Volumen persistente: ${B}$DATA_DIR${E}\n"
printf "  URL: ${B}http://localhost:$PORT${E}\n"
echo ""
printf "  ${D}Reinicia Termux o ejecuta: source ~/.bashrc${E}\n\n"
