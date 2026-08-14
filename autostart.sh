#!/bin/bash
# Arranca Claude Chat Manager (FerStark) + túnel Cloudflare al iniciar sesión en Windows (via tarea programada + WSL).
# URL fija: https://ferstark.controlapps.ar (túnel con nombre "ferstark", no quick tunnel).
#
# Nota (13/08/2026): server y tunel corren como servicios systemd --user
# (ferstark-server.service, ferstark-tunnel.service), habilitados con `systemctl --user enable`.
# Como fernando tiene `loginctl enable-linger` activo, systemd --user arranca solo
# apenas bootea la instancia WSL y los levanta automáticamente sin necesitar este script.
# Este script queda como red de seguridad idempotente (start no hace nada si ya están activos).

LOG=/tmp/ccm-autostart.log
log() { echo "$(date '+%F %T') $1" >> "$LOG"; }

if systemctl --user is-active --quiet ferstark-server.service; then
  log "server ya estaba corriendo (systemd), no hago nada"
else
  systemctl --user start ferstark-server.service
  log "server iniciado via systemd"
fi

if systemctl --user is-active --quiet ferstark-tunnel.service; then
  log "tunel ferstark ya estaba corriendo (systemd), no hago nada"
else
  systemctl --user start ferstark-tunnel.service
  log "tunel ferstark iniciado via systemd"
fi
