# Stark — Claude Chat Manager

PWA local para chatear con Claude Code desde el celular o el browser. Sidebar de conversaciones por proyecto, streaming en tiempo real, voz, adjuntos e imágenes.

## Funcionalidades

- **Chat con streaming** — respuestas en tiempo real vía SSE
- **Historial** — lee los JSONL de `~/.claude/projects/` (solo lectura)
- **Voz** — botón 🎤 transcribe audio vía Groq Whisper → llena el input
- **Adjuntos** — sube imágenes (auto-comprimir >1.5MB), PDFs y cualquier archivo; Claude los lee con su tool `Read`
- **Previews** — miniaturas inline para imágenes, cards para PDFs, lightbox fullscreen al tocar
- **TTS** — botón 🔊 en cada mensaje reproduce el texto (Web Speech API)
- **PWA** — instalable en Android/iOS, funciona con Cloudflare Tunnel para acceso remoto
- **Multi-modelo** — selector de modelo por conversación (Opus / Sonnet / Haiku)
- **Cola FIFO** — máximo 2 procesos `claude` concurrentes

## Requisitos

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) instalado y autenticado
- ImageMagick + Ghostscript (para thumbnails de imágenes y PDFs)
- Groq API key (para transcripción de audio)

### Linux / macOS
```bash
# Ubuntu/Debian
sudo apt install imagemagick ghostscript
sudo sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml

# macOS
brew install imagemagick ghostscript
```

### Windows
1. Instalar [ImageMagick 7](https://imagemagick.org/script/download.php#windows) — elegir el instalador `.exe`, marcar "Add to PATH"
2. Instalar [Ghostscript](https://www.ghostscript.com/releases/gsdnld.html) — elegir `gswin64c`, agregar al PATH
3. Verificar en PowerShell: `magick --version` y `gswin64c --version`

## Instalación

```bash
git clone https://github.com/loctime/claude-chat-manager
cd claude-chat-manager
npm install
```

## Configuración

Variable de entorno requerida para transcripción de voz:

```bash
export GROQ_API_KEY=tu_key   # gratis en console.groq.com
```

Si no está como variable de entorno, el server la busca automáticamente en `~/.claude/settings.json` bajo `env.GROQ_API_KEY`.

En Windows el binario de Claude se resuelve solo (shim npm o .exe en PATH); se puede forzar con `CLAUDE_CMD=C:\ruta\a\claude.exe`. El modo multi-cuenta (switch entre usuarios de `/home` vía sudo) es solo Linux/Mac — en Windows corre siempre single-account.

Opcional:
```bash
export PORT=3777          # default
export HOST=127.0.0.1    # cambiar a 0.0.0.0 para red local
export ACCESS_PIN=1234   # PIN de acceso (recomendado si exponés al exterior)
```

## Uso

```bash
# Linux / macOS
npm start

# Windows
start.bat
```
→ http://127.0.0.1:3777

### Acceso remoto (Cloudflare Tunnel)

```bash
# Crear túnel (una vez)
cloudflared tunnel create stark
cloudflared tunnel route dns stark tu-subdominio.tudominio.com

# Archivo ~/.cloudflared/config.yml
tunnel: <ID>
credentials-file: ~/.cloudflared/<ID>.json
ingress:
  - hostname: stark.tudominio.com
    service: http://127.0.0.1:3777
  - service: http_status:404

# Correr
cloudflared tunnel run
```

## Cómo funciona

- Lee los JSONL de `~/.claude/projects/` (solo lectura, nunca los escribe)
- Estado y nombres de conversaciones en `~/.claude/session-manager/meta.json`
- Cada mensaje spawnea `claude -p --resume <id> --output-format stream-json --dangerously-skip-permissions`
- Los archivos subidos van a `~/.ccm-uploads/`
- Thumbnails generados al vuelo por ImageMagick (1h de cache)

## Tests

```bash
npm test
```
