#!/bin/bash
# Manda un aviso por Telegram (bot de Tron) a los chats de /etc/ccm/tron.env.
#
# Lo usan los agentes de las cuentas colab-* por sudo, para escalar problemas o
# dilemas que no deben resolver solos. El token del bot vive SOLO en
# /etc/ccm/tron.env (root, 600): los colaboradores nunca lo ven. El mensaje se
# manda como dato (--data-urlencode) y el token por stdin de curl (-K -), así no
# queda en la lista de procesos ni hay inyección por el texto.
#
# Uso:  sudo /usr/local/bin/avisar-diego "qué pasó y qué hay que decidir"
#       (o por stdin:  echo "mensaje" | sudo /usr/local/bin/avisar-diego)
# Límites: 1500 caracteres, 20 s entre avisos y 8 por hora por cuenta.
#
# Se instala en /usr/local/bin (root:root, 755) con la regla de sudoers
# /etc/sudoers.d/avisar-diego (grupo ccm-colab). Copia versionada en el repo:
# si se cambia acá hay que reinstalarla en el VPS.
set -u

ENV=/etc/ccm/tron.env
STATE=/var/lib/ccm-avisos
MAX_LEN=1500
MIN_GAP=20
MAX_HOUR=8

who=${SUDO_USER:-$(id -un)}
case "$who" in
  colab-*|claude|root) ;;
  *) echo "Cuenta no autorizada para avisar." >&2; exit 1 ;;
esac

msg="$*"
if [ -z "$msg" ] && [ ! -t 0 ]; then msg=$(head -c 4000); fi
msg=$(printf '%s' "$msg" | tr -d '\000-\010\013\014\016-\037' | head -c "$MAX_LEN")
if [ -z "$msg" ]; then echo "Falta el mensaje." >&2; exit 2; fi

[ -r "$ENV" ] || { echo "Aviso no configurado en el servidor." >&2; exit 3; }
# shellcheck disable=SC1090
. "$ENV"
[ -n "${TRON_TOKEN:-}" ] && [ -n "${TRON_CHAT_IDS:-}" ] || { echo "Aviso mal configurado en el servidor." >&2; exit 3; }

# límites por cuenta
mkdir -p "$STATE"; chmod 755 "$STATE"
log="$STATE/$who.log"; now=$(date +%s)
last=$(tail -n 1 "$log" 2>/dev/null || echo 0)
if [ $((now - ${last:-0})) -lt "$MIN_GAP" ]; then
  echo "Esperá unos segundos antes de mandar otro aviso." >&2; exit 4
fi
recent=$(awk -v n="$now" 'n-$1<3600' "$log" 2>/dev/null | wc -l)
if [ "$recent" -ge "$MAX_HOUR" ]; then
  echo "Ya se mandaron muchos avisos en la última hora." >&2; exit 4
fi

text="🔔 [$who] $msg"
ok=0
for chat in ${TRON_CHAT_IDS//,/ }; do
  resp=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TRON_TOKEN" \
    | curl -sS -m 15 -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" 2>/dev/null)
  case "$resp" in *'"ok":true'*) ok=1 ;; esac
done

if [ "$ok" = 1 ]; then
  echo "$now" >> "$log"
  echo "Aviso enviado."
else
  echo "No se pudo enviar el aviso." >&2; exit 5
fi
