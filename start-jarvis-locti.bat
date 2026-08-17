@echo off
:: J.A.R.V.I.S (claude-chat-manager) + Cloudflare Tunnel -- instancia propia de "locti".
:: Variante de start-jarvis.bat con el puerto fijado a mano (no depende de heredar la
:: variable de entorno PORT, que la tarea programada S4U no estaba pasando bien).
:: Tunnel: %USERPROFILE%\.cloudflared\config.yml (jarvis-locti.controlapps.ar -> 127.0.0.1:3778)
set PORT=3778
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)

if "%ACCESS_PIN%"=="" (
  echo ADVERTENCIA: ACCESS_PIN no seteado. El chat queda SIN password.
  echo Setealo con: setx ACCESS_PIN tu_pin  ^(y reabri esta consola^)
)

start "jarvis-server-locti" /min cmd /c "set PORT=3778&& node src\server.js >> %TEMP%\jarvis-server-locti.log 2>&1"
start "jarvis-tunnel-locti" /min cmd /c "cloudflared tunnel run >> %TEMP%\jarvis-tunnel-locti.log 2>&1"

echo J.A.R.V.I.S (locti) corriendo:
echo   local:   http://127.0.0.1:3778
echo   publico: https://jarvis-locti.controlapps.ar
echo Logs en %TEMP%\jarvis-server-locti.log y %TEMP%\jarvis-tunnel-locti.log
