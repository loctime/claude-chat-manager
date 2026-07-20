@echo off
:: J.A.R.V.I.S - Claude Chat Manager (Windows)
:: Requiere: Node.js, Claude Code CLI. Opcional: ImageMagick 7 (magick) + Ghostscript para thumbnails.
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)

:: GROQ_API_KEY: si no esta como variable de entorno, el server la lee
:: automaticamente de %USERPROFILE%\.claude\settings.json (clave env.GROQ_API_KEY)

:: Puerto (default 3777)
if "%PORT%"=="" set PORT=3777

echo Iniciando J.A.R.V.I.S en http://127.0.0.1:%PORT%
node src\server.js
