#!/bin/bash
# Mantiene al día las instancias de colaboradores de Claude Chat Manager en el VPS.
#
# Todas las instancias (ccm-<nombre>, usuario colab-<nombre>) corren el MISMO
# checkout /opt/claude-chat-manager, así que un solo pull alcanza; lo que falta
# es reiniciar cada una para que tome el código. Este script:
#   1. hace fetch + pull --ff-only del checkout (como el usuario dueño),
#   2. reinicia (pm2 restart) cada instancia cuyo código en uso es más viejo que HEAD,
#      pero SOLO si está inactiva: un reinicio corta el stream de un turno en curso.
# "Inactiva" = ningún archivo de sesión de sus motores (Claude/Codex/AgY) se tocó en
# los últimos IDLE_MIN minutos. Si está ocupada se deja para la próxima corrida.
#
# Se instala en /usr/local/sbin (root:root, 755) y lo corre root por /etc/cron.d/ccm-update.
# Copia versionada en el repo: si se cambia acá hay que reinstalarla en el VPS.
set -u

REPO=/opt/claude-chat-manager
OWNER=claude
STATE=/var/lib/ccm-update
IDLE_MIN=${IDLE_MIN:-5}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
# as <usuario> <comando...>: corre con el HOME de ese usuario (pm2 y la deploy key de git lo necesitan)
as() { local u=$1; shift; runuser -u "$u" -- env HOME="/home/$u" "$@"; }

mkdir -p "$STATE"

# 1) traer el código
if ! as $OWNER git -C $REPO fetch -q origin 2>/dev/null; then
  log "fetch falló, se reintenta en la próxima corrida"; exit 1
fi
local_head=$(as $OWNER git -C $REPO rev-parse HEAD)
remote_head=$(as $OWNER git -C $REPO rev-parse '@{upstream}')
if [ "$local_head" != "$remote_head" ]; then
  if out=$(as $OWNER git -C $REPO pull --ff-only -q 2>&1); then
    log "pull ok: ${local_head:0:7} -> $(as $OWNER git -C $REPO rev-parse --short HEAD)"
  else
    log "pull NO aplicado (checkout con cambios o divergido): $out"; exit 1
  fi
fi
head=$(as $OWNER git -C $REPO rev-parse HEAD)

# 2) instancias
busy() { # $1 = home del colaborador
  find "$1/.claude/projects" "$1/.codex/sessions" "$1/.gemini" -type f -mmin -"$IDLE_MIN" -print -quit 2>/dev/null | grep -q .
}

for home in /home/colab-*; do
  [ -d "$home" ] || continue
  user=$(basename "$home")
  names=$(as "$user" pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s).filter(p=>p.name.startsWith("ccm-")).forEach(p=>console.log(p.name))}catch{}})')
  for name in $names; do
    stamp="$STATE/$name"
    [ "$(cat "$stamp" 2>/dev/null)" = "$head" ] && continue
    if busy "$home"; then
      log "$name: código viejo pero con actividad en los últimos ${IDLE_MIN} min, se pospone"
      continue
    fi
    if as "$user" pm2 restart "$name" --update-env >/dev/null 2>&1; then
      echo "$head" > "$stamp"
      log "$name: reiniciado en ${head:0:7}"
    else
      log "$name: pm2 restart FALLÓ"
    fi
  done
done
