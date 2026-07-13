#!/bin/bash
# Levanta Claude Chat Manager + túnel Cloudflare
# Config: exportá ACCESS_PIN (obligatorio) y CHAT_URL (opcional),
#         o ponelas en ~/.claude-chat-manager.env

[ -f ~/.claude-chat-manager.env ] && source ~/.claude-chat-manager.env

if [ -z "$ACCESS_PIN" ]; then
  echo "ERROR: ACCESS_PIN no seteado."
  echo "Exportalo (ACCESS_PIN=xxxx ./start.sh) o ponelo en ~/.claude-chat-manager.env"
  exit 1
fi

CHAT_URL="${CHAT_URL:-http://127.0.0.1:3777}"

kill $(lsof -ti:3777) 2>/dev/null || true
pkill -f "cloudflared tunnel.*run" 2>/dev/null || true
sleep 1

cd "$(dirname "$0")"
ACCESS_PIN="$ACCESS_PIN" HOST=127.0.0.1 node src/server.js &>/tmp/ccm.log &
echo "Server PID: $!"

~/.local/bin/cloudflared tunnel --config ~/.cloudflared/config.yml run &>/tmp/ccm-tunnel.log &
echo "Tunnel PID: $!"

echo ""
echo "Chat disponible en: $CHAT_URL"
echo "PIN: $ACCESS_PIN"
