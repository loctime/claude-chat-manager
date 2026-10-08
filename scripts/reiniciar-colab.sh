#!/bin/bash
# Relanza el daemon de PM2 de una instancia de colaborador para que tome los grupos actuales
# (un grupo agregado con usermod -aG no llega a procesos que ya estaban corriendo).
# Conserva EXACTAMENTE el entorno del proceso vivo: el dump de `pm2 save` puede estar desactualizado
# (al de Julieta le faltaba COLLAB_MODE), así que no se usa `pm2 resurrect`.
#
# Uso (root, con la instancia inactiva):  sudo bash reiniciar-colab.sh colab-julietta
# Corta lo que la persona esté haciendo en ese momento: revisar antes que no haya un turno en curso.
set -euo pipefail
u=$1; n=ccm-${u#colab-}
pid=$(pgrep -u "$u" -f 'claude-chat-manager/src/server.js' | head -1)
[ -n "$pid" ] || { echo "no encuentro el server de $u"; exit 1; }
cwd=$(readlink "/proc/$pid/cwd")
f=$(mktemp /tmp/envcolab.XXXXXX)
tr '\0' '\n' < "/proc/$pid/environ" | grep -E '^(PORT|HOST|SINGLE_ACCOUNT|COLLAB_MODE|COLLAB_ENGINES|ACCESS_PIN)=' \
  | sed -E "s/^([A-Z_]+)=(.*)$/export \1='\2'/" > "$f"
chown "$u": "$f"; chmod 600 "$f"   # el PIN va por archivo 600, no por argv
port=$(grep -oE "PORT='[0-9]+'" "$f" | tr -dc 0-9)
echo "relanzando $n (cwd=$cwd, puerto=$port, vars=$(wc -l < "$f"))"
# runuser -l (no -u): -u deja el HOME de quien invoca y pm2 usaría el ~/.pm2 equivocado
runuser -l "$u" -c "pm2 kill >/dev/null 2>&1; . $f; pm2 start /opt/claude-chat-manager/src/server.js --name $n --cwd '$cwd' >/dev/null && pm2 save >/dev/null"
rm -f "$f"
sleep 4
npid=$(pgrep -u "$u" -f 'claude-chat-manager/src/server.js' | head -1)
grupos=$(grep ^Groups "/proc/$npid/status" | cut -f2 | xargs | tr ' ' ',')
echo "pid nuevo: $npid"
echo "grupos del proceso nuevo: $grupos"
echo "entorno nuevo (claves): $(tr '\0' '\n' < /proc/$npid/environ | grep -E '^(PORT|HOST|SINGLE_ACCOUNT|COLLAB_MODE|COLLAB_ENGINES|ACCESS_PIN)=' | cut -d= -f1 | sort | tr '\n' ' ')"
echo "HTTP local: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/)"
echo "reglas sudo sin clave desde ese proceso: $(setpriv --reuid="$(id -u "$u")" --regid="$(id -g "$u")" --groups="$grupos" sudo -n -l 2>&1 | grep -c NOPASSWD)"
