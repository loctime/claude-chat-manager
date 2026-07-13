#!/bin/bash
# Levanta Claude Chat Manager + túnel Cloudflare
# Uso: ACCESS_PIN=123456 ./start.sh
# O con PIN por defecto si está seteado en el archivo

ACCESS_PIN="${ACCESS_PIN:-REDACTED}"

kill $(lsof -ti:3777) 2>/dev/null || true
pkill -f "cloudflared tunnel.*run" 2>/dev/null || true
sleep 1

cd "$(dirname "$0")"
ACCESS_PIN="$ACCESS_PIN" HOST=127.0.0.1 node src/server.js &>/tmp/ccm.log &
echo "Server PID: $!"

~/.local/bin/cloudflared tunnel --config ~/.cloudflared/config.yml run &>/tmp/ccm-tunnel.log &
echo "Tunnel PID: $!"

echo ""
echo "Chat disponible en: https://stark.controlapps.ar"
echo "PIN: $ACCESS_PIN"
