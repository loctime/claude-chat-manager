#!/bin/bash
# Instala (o reinstala) el sistema de publicación con aprobación en el VPS. Correr como root, desde
# una copia del repo:  sudo bash scripts/publicar/instalar.sh
# Es idempotente. Qué hace:
#   - usuario/grupo ccm-aprobar (sin login) y carpetas de estado
#   - código en /usr/local/lib/ccm-publicar (root:root: lo que corre como root NO puede estar en un
#     lugar donde otro usuario escriba) + wrapper /usr/local/bin/pedir-publicacion
#   - regla de sudoers para el grupo ccm-colab, cron del publicador y servicio systemd de la página
#   - /etc/caddy/sitios.caddy (generado) + su import, y el bloque de aprobar.controlapps.ar
# El DNS (aprobar + wildcard *.controlapps.ar, proxied) NO lo toca: se crea aparte en Cloudflare.
set -euo pipefail
cd "$(dirname "$0")"

LIB=/usr/local/lib/ccm-publicar
install -d -o root -g root -m 755 "$LIB"
install -o root -g root -m 755 ccm-publicar.js "$LIB/ccm-publicar.js"

getent group ccm-aprobar >/dev/null || groupadd --system ccm-aprobar
id ccm-aprobar >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -g ccm-aprobar ccm-aprobar
install -d -o root -g root -m 755 /var/lib/ccm-publicar
install -d -o root -g ccm-aprobar -m 750 /var/lib/ccm-publicar/solicitudes
install -d -o root -g root -m 755 /srv/sites
touch /var/log/ccm-publicar.log && chmod 640 /var/log/ccm-publicar.log

cat > /usr/local/bin/pedir-publicacion <<'EOF'
#!/bin/bash
exec /usr/bin/node /usr/local/lib/ccm-publicar/ccm-publicar.js pedir "$@"
EOF
chmod 755 /usr/local/bin/pedir-publicacion

cat > /etc/sudoers.d/pedir-publicacion <<'EOF'
%ccm-colab ALL=(root) NOPASSWD: /usr/local/bin/pedir-publicacion
EOF
chmod 440 /etc/sudoers.d/pedir-publicacion
visudo -cf /etc/sudoers.d/pedir-publicacion

cat > /etc/cron.d/ccm-publicar <<'EOF'
* * * * * root /usr/bin/flock -n /run/ccm-publicar.lock /usr/bin/node /usr/local/lib/ccm-publicar/ccm-publicar.js publicar >> /var/log/ccm-publicar.log 2>&1
EOF
chmod 644 /etc/cron.d/ccm-publicar

cat > /etc/systemd/system/ccm-aprobar.service <<'EOF'
[Unit]
Description=Pagina de aprobacion de publicaciones (ccm-publicar)
After=network.target

[Service]
User=ccm-aprobar
Group=ccm-aprobar
Environment=PORT=3950
ExecStart=/usr/bin/node /usr/local/lib/ccm-publicar/ccm-publicar.js servir
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/ccm-publicar/solicitudes
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ccm-aprobar
systemctl restart ccm-aprobar

# Caddy: el archivo generado + su import + el bloque de aprobar (sin log: el token va en la URL)
[ -f /etc/caddy/sitios.caddy ] || echo '# Generado por ccm-publicar.js' > /etc/caddy/sitios.caddy
if ! grep -q 'import /etc/caddy/sitios.caddy' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-publicar-$(date +%Y%m%d%H%M%S)"
  cat >> /etc/caddy/Caddyfile <<'EOF'

# --- publicación con aprobación (ccm-publicar) ---
import /etc/caddy/sitios.caddy

aprobar.controlapps.ar {
	encode gzip
	reverse_proxy localhost:3950
}
EOF
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy
fi
echo "Instalado. Falta el DNS (aprobar + wildcard) si todavía no está."
