@echo off
chcp 65001 >nul
title Vault Installer
color 0A

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║          Vault — Instalador              ║
echo  ║     Termux + AuroraOS + Vault            ║
echo  ╚══════════════════════════════════════════╝
echo.

:: ── Directorios ──────────────────────────────────────────
set VAULT_TMP=%TEMP%\vault-install
set TOOLS_DIR=%VAULT_TMP%\platform-tools
set ADB=%TOOLS_DIR%\adb.exe
set TERMUX_APK=%VAULT_TMP%\termux.apk

mkdir "%VAULT_TMP%" 2>nul

:: ── Verificar si ADB ya está instalado ──────────────────
echo  Verificando ADB...
where adb >nul 2>&1
if %errorlevel% == 0 (
    set ADB=adb
    echo  OK  ADB encontrado en el sistema
    goto :check_device
)

:: ── Descargar Platform Tools ─────────────────────────────
echo  ADB no encontrado. Descargando Platform Tools...
echo  ^(~30MB^)
echo.

:: Intentar con PowerShell (viene en Windows 7+)
powershell -Command "& {
    $url  = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
    $dest = '%VAULT_TMP%\platform-tools.zip';
    $wc   = New-Object System.Net.WebClient;
    $wc.DownloadFile($url, $dest);
    Write-Host '  OK  Descargado';
    Expand-Archive -Path $dest -DestinationPath '%VAULT_TMP%' -Force;
    Write-Host '  OK  Extraido';
}" 2>nul

if not exist "%ADB%" (
    echo  ERROR: No se pudo descargar Platform Tools.
    echo  Descargalo manualmente desde:
    echo  https://developer.android.com/studio/releases/platform-tools
    echo  Extrae adb.exe en esta carpeta y ejecuta de nuevo.
    pause
    exit /b 1
)
echo  OK  Platform Tools listo

:: ── Verificar dispositivo ────────────────────────────────
:check_device
echo.
echo  ─────────────────────────────────────────────
echo  ANTES DE CONTINUAR:
echo.
echo  1. Activa "Depuracion USB" en tu telefono:
echo     Ajustes → Acerca del telefono →
echo     toca "Numero de compilacion" 7 veces →
echo     Opciones de desarrollador →
echo     Depuracion USB: ON
echo.
echo  2. Conecta tu telefono por USB
echo  3. Acepta "Confiar en esta PC" en tu telefono
echo  ─────────────────────────────────────────────
echo.
pause

echo  Verificando conexion ADB...
"%ADB%" kill-server >nul 2>&1
"%ADB%" start-server >nul 2>&1
timeout /t 2 >nul

"%ADB%" devices | findstr "device$" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: No se detecta ningun dispositivo.
    echo  Asegurate de:
    echo    - Cable USB conectado
    echo    - Depuracion USB activada
    echo    - Haber tocado "Confiar" en el telefono
    echo.
    echo  Intenta desconectar y reconectar el cable.
    pause
    goto :check_device
)

:: Obtener info del dispositivo
for /f "tokens=*" %%i in ('"%ADB%" shell getprop ro.product.model 2^>nul') do set MODEL=%%i
for /f "tokens=*" %%i in ('"%ADB%" shell getprop ro.build.version.sdk 2^>nul') do set SDK=%%i
echo  OK  Dispositivo: %MODEL% ^(SDK %SDK%^)
echo.

:: ── Descargar Termux ─────────────────────────────────────
echo  Descargando Termux...
set TERMUX_URL=https://alexiszapeta06-arch.github.io/vault/termux.apk

powershell -Command "& {
    $wc = New-Object System.Net.WebClient;
    $wc.DownloadFile('%TERMUX_URL%', '%TERMUX_APK%');
    Write-Host '  OK  Termux descargado';
}" 2>nul

if not exist "%TERMUX_APK%" (
    echo  ERROR: No se pudo descargar Termux.
    echo  Verifica tu conexion a internet.
    pause
    exit /b 1
)

:: ── Instalar Termux ──────────────────────────────────────
echo  Instalando Termux en el telefono...
"%ADB%" install -r -t -g "%TERMUX_APK%" >nul 2>&1
if %errorlevel% neq 0 (
    :: Intentar sin -g para Android más viejos
    "%ADB%" install -r -t "%TERMUX_APK%" >nul 2>&1
)

:: Verificar instalación
"%ADB%" shell pm list packages 2>nul | findstr "com.termux" >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: No se pudo instalar Termux.
    echo  Intenta instalarlo manualmente desde:
    echo  https://f-droid.org/packages/com.termux/
    pause
    exit /b 1
)
echo  OK  Termux instalado

:: ── Enviar script de setup a Termux ─────────────────────
echo  Configurando AuroraOS y Vault...

:: Crear script de setup
set SETUP=%VAULT_TMP%\vault-setup.sh
(
echo #!/data/data/com.termux/files/usr/bin/bash
echo export TERM=xterm-256color
echo export HOME=/data/data/com.termux/files/home
echo cd "$HOME"
echo echo ""
echo echo "  Instalando AuroraOS + Vault..."
echo echo ""
echo pkg update -y -q 2^>/dev/null ^| tail -2
echo pkg install -y -q proot-distro python curl 2^>/dev/null ^| tail -2
echo echo "  OK proot-distro instalado"
echo if ! proot-distro list 2^>/dev/null ^| grep -q "alpine.*installed"; then
echo   proot-distro install alpine 2^>/dev/null
echo fi
echo echo "  OK AuroraOS ^(Alpine^) instalado"
echo mkdir -p "$HOME/.vault/aurora-data"/{apps,apks,registry,tmp,core,shortcuts}
echo mkdir -p "$HOME/.shortcuts"
echo proot-distro login alpine --bind "$HOME/.vault/aurora-data":/home/vault --shared-tmp -- sh -c "
echo   apk update -q 2^>/dev/null
echo   apk add --no-cache python3 py3-pip -q 2^>/dev/null
echo   pip3 install flask --quiet --break-system-packages 2^>/dev/null ^|^| pip3 install flask --quiet 2^>/dev/null
echo   mkdir -p /home/vault/{apps,apks,registry,tmp,core,shortcuts}
echo   echo 'AuroraOS' ^> /etc/aurora-release
echo " 2^>/dev/null
echo echo "  OK AuroraOS configurado"
echo curl -fsSL "https://alexiszapeta06-arch.github.io/vault/server.py" -o "$HOME/.vault/aurora-data/server.py" 2^>/dev/null
echo curl -fsSL "https://alexiszapeta06-arch.github.io/vault/core.py" -o "$HOME/.vault/aurora-data/core.py" 2^>/dev/null
echo echo "  OK Vault server descargado"
echo cat ^> "$HOME/.vault/vault-ghost.sh" ^<^< 'GHOST'
echo #!/bin/sh
echo VAULT_DIR="$HOME/.vault"
echo DATA="$VAULT_DIR/aurora-data"
echo command -v termux-wake-lock ^>/dev/null 2^>^&1 ^&^& termux-wake-lock ^>/dev/null 2^>^&1 ^|^| true
echo proot-distro login alpine --bind "$DATA":/home/vault --shared-tmp -- python3 /home/vault/server.py ^>/dev/null 2^>^&1 ^&
echo echo $! ^> "$VAULT_DIR/vault.pid"
echo sleep 3
echo command -v termux-open-url ^>/dev/null 2^>^&1 ^&^& termux-open-url "http://localhost:7070" ^>/dev/null 2^>^&1 ^&
echo exit 0
echo GHOST
echo chmod 755 "$HOME/.vault/vault-ghost.sh"
echo cat ^> "$HOME/.shortcuts/Vault.sh" ^<^< 'SC'
echo #!/data/data/com.termux/files/usr/bin/sh
echo exec sh "$HOME/.vault/vault-ghost.sh"
echo SC
echo chmod 755 "$HOME/.shortcuts/Vault.sh"
echo if ! grep -q "vault-ghost" "$HOME/.bashrc" 2^>/dev/null; then
echo   echo '' ^>^> "$HOME/.bashrc"
echo   echo '# Vault auto-start' ^>^> "$HOME/.bashrc"
echo   echo 'sh "$HOME/.vault/vault-ghost.sh" ^&' ^>^> "$HOME/.bashrc"
echo fi
echo sh "$HOME/.vault/vault-ghost.sh"
echo echo ""
echo echo "  ✓ Vault listo en http://localhost:7070"
echo echo ""
) > "%SETUP%"

:: Enviar script al dispositivo
"%ADB%" push "%SETUP%" /data/local/tmp/vault-setup.sh >nul 2>&1
"%ADB%" shell chmod 755 /data/local/tmp/vault-setup.sh >nul 2>&1

:: Ejecutar en Termux
echo  Ejecutando setup ^(2-3 minutos^)...
"%ADB%" shell "run-as com.termux bash /data/local/tmp/vault-setup.sh" 2>nul
if %errorlevel% neq 0 (
    :: Fallback: lanzar Termux con el script
    "%ADB%" shell "am start -n com.termux/.HomeActivity" >nul 2>&1
    timeout /t 3 >nul
    "%ADB%" shell "input text 'bash /data/local/tmp/vault-setup.sh'" >nul 2>&1
    "%ADB%" shell "input keyevent 66" >nul 2>&1
    echo  Setup lanzado en Termux. Espera a que termine en tu telefono.
    timeout /t 120 >nul
)

:: ── Limpiar ──────────────────────────────────────────────
"%ADB%" shell rm -f /data/local/tmp/vault-setup.sh >nul 2>&1

:: ── Listo ────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║        Vault instalado correctamente     ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  Siguiente paso — icono en pantalla:
echo  1. Instala "Termux:Widget" desde F-Droid
echo  2. Manten presionada tu pantalla de inicio
echo  3. Aniade widget → Termux:Widget
echo  4. Toca "Vault" para abrir la store
echo.
echo  URL directa: http://localhost:7070
echo  ^(abre Termux primero^)
echo.

:: Limpiar archivos temporales
rmdir /s /q "%VAULT_TMP%" >nul 2>&1

pause
