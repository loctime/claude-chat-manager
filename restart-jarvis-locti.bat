@echo off
:: Reinicio completo de Jarvis (locti): mata server+tunel propios y los relanza.
:: No requiere admin. Doble click o correrlo desde una consola.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "restart-jarvis-locti.ps1"
echo.
echo Listo. Log completo en %TEMP%\jarvis-locti-restart.log
pause
