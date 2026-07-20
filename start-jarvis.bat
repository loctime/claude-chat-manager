@echo off
:: J.A.R.V.I.S (claude-chat-manager) + Cloudflare Tunnel (Windows)
:: ACCESS_PIN debe estar seteado como variable de entorno de usuario (setx ACCESS_PIN xxxx)
:: El tunnel usa %USERPROFILE%\.cloudflared\config.yml (hostname -> 127.0.0.1:3777)
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)

if "%ACCESS_PIN%"=="" (
  echo ADVERTENCIA: ACCESS_PIN no seteado. El chat queda SIN password.
  echo Setealo con: setx ACCESS_PIN tu_pin  ^(y reabri esta consola^)
)

start "jarvis-server" /min cmd /c "node src\server.js >> %TEMP%\jarvis-server.log 2>&1"
start "jarvis-tunnel" /min cmd /c "cloudflared tunnel run >> %TEMP%\jarvis-tunnel.log 2>&1"

echo J.A.R.V.I.S corriendo:
echo   local:   http://127.0.0.1:3777
echo   publico: https://jarvis.controlapps.ar
echo Logs en %TEMP%\jarvis-server.log y %TEMP%\jarvis-tunnel.log
