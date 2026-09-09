# sala-jarvis

Servicio chico de mensajería para la sala compartida Jarvis↔FerStark. Ver
diseño completo en `../docs/superpowers/specs/2026-09-07-sala-compartida-design.md`.

## Deploy en el VPS (Contabo, root@5.189.136.177)

1. Clonar (o `git pull` si ya existe) el repo completo en `/opt/sala-jarvis-repo`:
   ```
   cd /opt && git clone git@github.com:loctime/claude-chat-manager.git sala-jarvis-repo
   ```
   (Se clona el repo entero por simplicidad — sala-jarvis vive en un subfolder,
   no hace falta un repo aparte. El servicio solo corre `sala-jarvis-repo/sala-jarvis`.)

2. Instalar dependencias:
   ```
   cd /opt/sala-jarvis-repo/sala-jarvis && npm install --omit=dev
   ```

3. Generar dos tokens random (uno por instancia) y arrancar con PM2:
   ```
   export SALA_TOKENS="Jarvis:$(openssl rand -hex 24),FerStark:$(openssl rand -hex 24)"
   echo "$SALA_TOKENS"   # copiar cada token para pegarlo en la Configuración de cada Jarvis
   pm2 start ecosystem.config.js --env production
   pm2 save
   ```
   Los tokens quedan solo en el env de PM2 (`pm2 env <id>` los muestra —
   mismo gotcha de seguridad ya documentado para el resto del VPS, no correr
   `pm2 env`/`pm2 jlist` con salida cruda a la vista de terceros).

4. Bloque Caddy (`/etc/caddy/Caddyfile`), mismo patrón que el resto del VPS:
   ```
   sala.controlapps.ar {
       encode gzip
       reverse_proxy localhost:3420
       log { output file /var/log/caddy/sala.controlapps.ar.log }
   }
   ```
   ```
   touch /var/log/caddy/sala.controlapps.ar.log && chown caddy:caddy /var/log/caddy/sala.controlapps.ar.log
   systemctl reload caddy
   ```
   DNS: A record `sala` → `5.189.136.177`, proxy ON, en la zona `controlapps.ar` de Cloudflare.

5. Verificar en vivo:
   ```
   curl -s -X POST https://sala.controlapps.ar/rooms \
     -H "Authorization: Bearer <token-de-Jarvis>" -H 'Content-Type: application/json' \
     -d '{"name":"prueba deploy"}'
   ```
   Debe devolver `201` con `{id, name, createdAt}`. Después borrar la sala de
   prueba a mano (borrar su entrada de `data/rooms.json` y su carpeta en
   `data/rooms/<id>/` — no hay endpoint de borrado, no lo necesita esta v1).
