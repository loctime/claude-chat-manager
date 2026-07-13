@echo off
:: Stark - Claude Chat Manager (Windows)
:: Requiere: Node.js, Claude Code CLI, ImageMagick 7 (magick), Groq API key

:: Seteá tu Groq API key acá o como variable de entorno del sistema
:: set GROQ_API_KEY=tu_key_acá

if "%GROQ_API_KEY%"=="" (
  echo ADVERTENCIA: GROQ_API_KEY no configurada. Transcripcion de voz no disponible.
  echo Seteala con: set GROQ_API_KEY=tu_key
  echo.
)

:: Puerto (default 3777)
if "%PORT%"=="" set PORT=3777

echo Iniciando Stark en http://127.0.0.1:%PORT%
node src/server.js
