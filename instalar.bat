@echo off
title Vault - Paso 1: Instalar Termux

set ADB=%~dp0adb.exe
set APK=%~dp0termux.apk

cls
echo.
echo  Vault - Paso 1: Instalar Termux
echo  =================================
echo.

if not exist "%ADB%" (
    echo ERROR: No se encontro adb.exe en esta carpeta.
    pause & exit /b 1
)
if not exist "%APK%" (
    echo ERROR: No se encontro termux.apk en esta carpeta.
    pause & exit /b 1
)

echo Antes de continuar:
echo.
echo 1. Activa Depuracion USB en tu telefono:
echo    Ajustes - Acerca del telefono
echo    Toca Numero de compilacion 7 veces
echo    Opciones de desarrollador - Depuracion USB ON
echo.
echo 2. Conecta el cable USB a la PC
echo 3. Acepta "Permitir depuracion USB" en el telefono
echo.
pause

echo.
echo Conectando...
"%ADB%" kill-server >nul 2>&1
"%ADB%" start-server >nul 2>&1
timeout /t 3 /nobreak >nul

echo Esperando dispositivo...
set TRIES=0
:wait
"%ADB%" devices 2>nul | findstr /r "^[A-Za-z0-9].*device$" >nul 2>&1
if %errorlevel%==0 goto found
set /a TRIES+=1
if %TRIES% geq 15 (
    echo.
    echo ERROR: No se detecto ningun dispositivo.
    echo Verifica el cable, Depuracion USB y el dialogo del telefono.
    pause & exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait

:found
for /f "tokens=*" %%M in ('"%ADB%" shell getprop ro.product.model 2^>nul') do set MODEL=%%M
echo Dispositivo: %MODEL%
echo.

:: Verificar si ya esta instalado
"%ADB%" shell pm list packages 2>nul | findstr "com.termux" >nul 2>&1
if %errorlevel%==0 (
    echo Termux ya esta instalado.
    goto done
)

echo Instalando Termux...
"%ADB%" install -r -t "%APK%"
if %errorlevel% neq 0 "%ADB%" install -r "%APK%"

"%ADB%" shell pm list packages 2>nul | findstr "com.termux" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: No se pudo instalar Termux.
    echo Intentalo desconectando y reconectando el cable.
    pause & exit /b 1
)

:done
echo.
echo  =================================
echo   Termux instalado correctamente
echo  =================================
echo.
echo  SIGUIENTE PASO:
echo.
echo  1. Abre Termux en tu telefono
echo  2. Espera que termine de inicializar
echo  3. Pega este comando:
echo.
echo  pkg install -y curl ^&^& curl -fsSL https://alexiszapeta06-arch.github.io/vault/install.sh ^| bash
echo.
echo  O ve a la pagina de Vault y toca
echo  "Paso 2: Instalar AuroraOS y Vault"
echo  para copiar el comando automaticamente.
echo.
pause
