#!/bin/bash
# Reinicia FerStark a mano: reinicia los servicios systemd --user (server + tunel).
# Llamado desde "Reiniciar FerStark.bat" (Windows) vía wsl.exe, o directo desde WSL.
#
# Nota (13/08/2026): antes esto usaba nohup+disown, pero los procesos morían solos
# 5-15s después de que la sesión de wsl.exe se cerraba (systemd-logind mata el
# "session scope" al terminar la sesión, aunque el usuario tenga linger habilitado).
# Fix: server y tunel corren como servicios systemd --user (ferstark-server.service,
# ferstark-tunnel.service), que viven en el user manager persistente, no en la sesión.

echo "Reiniciando FerStark (systemd --user)..."
systemctl --user restart ferstark-server.service ferstark-tunnel.service
sleep 3

echo ""
echo "Estado:"
if systemctl --user is-active --quiet ferstark-server.service; then echo "  server:  OK"; else echo "  server:  NO LEVANTO (ver: systemctl --user status ferstark-server.service / /tmp/ccm.log)"; fi
if systemctl --user is-active --quiet ferstark-tunnel.service; then echo "  tunel:   OK"; else echo "  tunel:   NO LEVANTO (ver: systemctl --user status ferstark-tunnel.service / /tmp/cf_ferstark.log)"; fi
echo ""
echo "URL: https://ferstark.controlapps.ar"
