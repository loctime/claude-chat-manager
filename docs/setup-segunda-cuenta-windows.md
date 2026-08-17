# Setup: segunda instancia de Jarvis en esta PC (cuenta Windows separada)

Guía de bootstrap para levantar una segunda instancia de claude-chat-manager en esta misma PC, corriendo bajo una cuenta Windows distinta (`locti`) con su propia cuenta Anthropic, en paralelo a la instancia principal (usuario `User`, https://jarvis.controlapps.ar, puerto 3777).

Si estás leyendo esto como el Claude Code que corre dentro de esta cuenta nueva: seguí los pasos en orden. Los marcados **[HUMANO]** no los podés hacer vos — requieren un browser interactivo o privilegios de admin que esta sesión no tiene. Pedile a Diego que los haga y que te avise cuando termine cada uno.

## Ya está resuelto (no reinstalar)

Node.js, npm y Git están instalados machine-wide (`C:\Program Files\nodejs`, `C:\Program Files\Git`) — visibles para cualquier usuario de esta PC sin reinstalar nada. Confirmalo con `node -v` / `git -v` antes de asumir que falta.

## Lo que sí es por-usuario (hay que rehacerlo en esta cuenta)

1. **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`. El paquete global de npm vive en `%AppData%\Roaming\npm`, que es por perfil de Windows — no se hereda del usuario `User`.
2. **[HUMANO] Login de la cuenta Anthropic secundaria**: correr `claude` y completar el OAuth por navegador. No se puede scriptear.
3. **cloudflared**: revisar `cloudflared -v`. Si no está, `winget install --scope machine Cloudflare.cloudflared` (con `--scope machine` queda instalado para todos los usuarios, evita reinstalarlo en cada cuenta — pero pide UAC; si esta sesión no tiene privilegios de admin, que Diego lo corra elevado una vez).
4. **[HUMANO] `cloudflared tunnel login`**: abre navegador, autoriza la cuenta Cloudflare de controlapps.ar. Genera `~/.cloudflared/cert.pem` en el perfil de `locti`. Es por perfil — no se puede copiar del usuario `User` sin admin cruzando perfiles, más simple rehacerlo.
5. **`cloudflared tunnel create jarvis2`** (o el nombre que se decida): con el cert ya en su lugar esto sí lo podés correr vos. Guardate el tunnel ID que devuelve.
6. **DNS CNAME**: `jarvis2.controlapps.ar` → `<tunnel-id>.cfargotunnel.com`. Si tenés `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` en tu propio `~/.claude/settings.json` lo podés crear vía API; si no los tenés (lo más probable, esos tokens viven en el perfil del usuario `User`, no en este), **[HUMANO]** pedile a Diego que lo cree a mano en el dashboard de Cloudflare (DNS → Add record → CNAME → `jarvis2` → `<tunnel-id>.cfargotunnel.com`, proxied).
7. **`~/.cloudflared/config.yml`** en este perfil, apuntando `jarvis2.controlapps.ar` → `http://127.0.0.1:3778`.
8. **Clonar el repo** (si no está ya): `git clone https://github.com/loctime/claude-chat-manager` y `npm install` adentro.
9. **Variables de entorno de esta instancia** (`setx`, quedan en el perfil de `locti`):
   - `setx PORT 3778` — `src/server.js` lee `process.env.PORT` (default 3777); hay que separarlo para no chocar con la instancia principal.
   - `setx ACCESS_PIN <elegir un PIN>`
10. **[HUMANO] Autostart + watchdog**: arrancar el server y cloudflared al boot sin depender de que `locti` tenga sesión gráfica abierta requiere una Scheduled Task con credenciales guardadas (`schtasks /Create /RU locti /RP <password> ...`), que necesita privilegios de admin y la contraseña de `locti`. Pedile a Diego que la registre — mismo patrón que `JarvisWatchdog`/`JarvisRestart` de la instancia principal, adaptado al puerto 3778 y al usuario `locti`.

## Gotcha importante

Los tokens del `CLAUDE.md` global de Diego (Vercel, GitHub, Cloudflare, etc., en `C:\Users\User\.claude\settings.json`) **no son visibles desde esta cuenta** — cada perfil de Windows tiene su propio `.claude`. Si esta instancia necesita alguno de esos tokens, decidir con Diego si conviene: (a) que los copie a mano a `C:\Users\locti\.claude\settings.json`, o (b) setearlos como variable de entorno de **sistema** (no de usuario) una sola vez, para que queden visibles desde ambas cuentas sin duplicar archivos.

## Nota

Esta instancia corre con `SINGLE_ACCOUNT` forzado igual que la principal — `IS_WIN` en `src/server.js` bloquea el multi-cuenta (`/home` + `sudo -u`) en Windows sea cual sea el valor de esa env var. El "multi-cuenta" acá es a nivel de dos instancias independientes (dos procesos, dos puertos, dos túneles), no el selector de cuenta nativo de la app.
