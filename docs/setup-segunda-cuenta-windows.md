# Setup: segunda instancia de Jarvis en esta PC (cuenta Windows separada)

Guía de bootstrap para levantar una segunda instancia de claude-chat-manager en esta misma PC, corriendo bajo una cuenta Windows distinta (`locti`) con su propia cuenta Anthropic, en paralelo a la instancia principal (usuario `User`, https://jarvis.controlapps.ar, puerto 3777).

> Nota de nombres (actualizado 17/8/2026 tras el setup real): la cuenta terminó llamándose `locti` (no `loctime`, que era el nombre provisorio de cuando se escribió esta guía). El túnel de Cloudflare quedó con el nombre interno `jarvis2` (el que se creó con `cloudflared tunnel create`), pero el hostname público final es **`jarvis-locti.controlapps.ar`**, no `jarvis2.controlapps.ar` — se cambió sobre la marcha porque es más claro de qué cuenta es. La tarea programada se llama `JarvisLocti`.

Si estás leyendo esto como el Claude Code que corre dentro de esta cuenta nueva: seguí los pasos en orden. Los marcados **[HUMANO]** no los podés hacer vos — requieren un browser interactivo o privilegios de admin que esta sesión no tiene. Pedile a Diego que los haga y que te avise cuando termine cada uno.

## Ya está resuelto (no reinstalar)

Node.js, npm y Git están instalados machine-wide (`C:\Program Files\nodejs`, `C:\Program Files\Git`) — visibles para cualquier usuario de esta PC sin reinstalar nada. Confirmalo con `node -v` / `git -v` antes de asumir que falta.

## Lo que sí es por-usuario (hay que rehacerlo en esta cuenta)

1. **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`. El paquete global de npm vive en `%AppData%\Roaming\npm`, que es por perfil de Windows — no se hereda del usuario `User`.
2. **[HUMANO] Login de la cuenta Anthropic secundaria**: correr `claude` y completar el OAuth por navegador. No se puede scriptear.
3. **cloudflared**: revisar `cloudflared -v`. Si no está, `winget install --scope machine Cloudflare.cloudflared` (con `--scope machine` queda instalado para todos los usuarios, evita reinstalarlo en cada cuenta — pero pide UAC; si esta sesión no tiene privilegios de admin, que Diego lo corra elevado una vez).
4. **[HUMANO] `cloudflared tunnel login`**: abre navegador, autoriza la cuenta Cloudflare de controlapps.ar. Genera `~/.cloudflared/cert.pem` en el perfil de `locti`. Es por perfil — no se puede copiar del usuario `User` sin admin cruzando perfiles, más simple rehacerlo.
5. **`cloudflared tunnel create jarvis2`** (o el nombre que se decida): con el cert ya en su lugar esto sí lo podés correr vos. Guardate el tunnel ID que devuelve. El nombre interno del túnel no tiene por qué coincidir con el hostname público (ver nota arriba).
6. **DNS CNAME**: `jarvis-locti.controlapps.ar` → `<tunnel-id>.cfargotunnel.com`. Si tenés `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` en tu propio `~/.claude/settings.json` lo podés crear vía API; si no los tenés (lo más probable, esos tokens viven en el perfil del usuario `User`, no en este), **[HUMANO]** pedile a Diego que lo cree a mano en el dashboard de Cloudflare (DNS → Add record → CNAME → `jarvis-locti` → `<tunnel-id>.cfargotunnel.com`, proxied).
7. **`~/.cloudflared/config.yml`** en este perfil, apuntando `jarvis-locti.controlapps.ar` → `http://127.0.0.1:3778`.
8. **Clonar el repo** (si no está ya): `git clone https://github.com/loctime/claude-chat-manager` y `npm install` adentro.
9. **Variables de entorno de esta instancia** (`setx`, quedan en el perfil de `locti`):
   - `setx PORT 3778` — `src/server.js` lee `process.env.PORT` (default 3777); hay que separarlo para no chocar con la instancia principal.
   - `setx ACCESS_PIN <elegir un PIN>`
   - **Gotcha real:** la tarea programada (ver punto 10) corre el proceso vía logon S4U y en la práctica **no propaga bien la variable de entorno `PORT`** seteada por `setx`, aunque figure en el perfil. `start-jarvis-locti.bat` esquiva esto fijando `set PORT=3778` a mano adentro del propio script en vez de depender de heredarla — replicar ese patrón, no confiar en `setx` sola para lo que arranca por Scheduled Task.
10. **Autostart (probado y funcionando)**: arrancar el server y cloudflared al boot sin depender de que `locti` tenga sesión gráfica abierta requiere una Scheduled Task con credenciales guardadas. Esto **sí lo podés armar vos** si tenés una sesión con privilegios de admin (o pedirle a Diego que corra los comandos si no):
    ```
    schtasks /Create /TN "JarvisLocti" /TR "<ruta-repo>\start-jarvis-locti.bat" /SC ONSTART /RU locti /RP "<password-real-de-locti>" /RL LIMITED /F
    ```
    - `/SC ONSTART` = dispara al bootear Windows, **antes** de cualquier login — no "al iniciar sesión de locti". Así arranca sola sin importar qué usuario loguee después.
    - **Gotcha real (el que más costó):** aunque el `schtasks /Create` termine "correcto", la tarea puede fallar con *acceso denegado* al dispararse si la cuenta `locti` no tiene el derecho **"Iniciar sesión como trabajo por lotes" (`SeBatchLogonRight`)** — no viene dado por default a cuentas estándar. Hay que otorgarlo una vez, con una sesión de admin, porque `secpol.msc` (GUI) puede estar bloqueado por política corporativa/Home edition; usar la vía por línea de comandos:
      ```powershell
      $sid = (New-Object System.Security.Principal.NTAccount("locti")).Translate([System.Security.Principal.SecurityIdentifier]).Value
      $cfg = "$env:TEMP\secpol.cfg"
      secedit /export /cfg $cfg /areas USER_RIGHTS | Out-Null
      (Get-Content $cfg) -replace '^(SeBatchLogonRight\s*=\s*.*)$', "`$1,*$sid" | Set-Content $cfg
      secedit /configure /db "$env:TEMP\secedit.sdb" /cfg $cfg
      ```
      Verificar con `secedit /export /cfg $env:TEMP\check.cfg /areas USER_RIGHTS; Get-Content $env:TEMP\check.cfg | Select-String SeBatchLogonRight` — tiene que listar el SID de `locti`.
    - Confirmar que la tarea corrió bien: `Get-ScheduledTaskInfo -TaskName "JarvisLocti"` (`LastTaskResult` debe ser `0`) y `netstat -ano | findstr ":3778"` debe mostrar `LISTENING`.
    - Nombre de referencia en la instancia principal (`User`): mismo patrón, task `JarvisWatchdog`/`JarvisRestart`, puerto 3777.

## Gotcha importante

Los tokens del `CLAUDE.md` global de Diego (Vercel, GitHub, Cloudflare, etc., en `C:\Users\User\.claude\settings.json`) **no son visibles desde esta cuenta** — cada perfil de Windows tiene su propio `.claude`. Si esta instancia necesita alguno de esos tokens, decidir con Diego si conviene: (a) que los copie a mano a `C:\Users\locti\.claude\settings.json`, o (b) setearlos como variable de entorno de **sistema** (no de usuario) una sola vez, para que queden visibles desde ambas cuentas sin duplicar archivos.

## Troubleshooting: "reinicié y no responde" / error 530-1033 en el túnel

Si tras un reboot la tarea corrió (`LastTaskResult: 0`) pero `https://jarvis-locti.controlapps.ar` da **HTTP 530 / error 1033** (Cloudflare: túnel sin conector activo) mientras que `http://127.0.0.1:3778` local sí responde: el server está bien, el problema es el lado del túnel. Diagnóstico rápido:

```powershell
Get-Process node,cloudflared -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime
netstat -ano | findstr ":3778"
Get-Content "$env:TEMP\jarvis-tunnel-locti.log" -Tail 20
```

Si aparece **más de un `cloudflared.exe`** corriendo (además de los `node.exe` normales de sesiones de chat activas — esos sí son legítimos, el server spawnea uno por sesión), lo más simple es matar todo y relanzar una vez:

```powershell
Stop-Process -Name node,cloudflared -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process "<ruta-repo>\start-jarvis-locti.bat"
```

**Ojo:** si `Stop-Process`/`taskkill` devuelve *"Acceso denegado"* en procesos que en teoría son del mismo usuario, es porque corren en la sesión de la Scheduled Task (S4U), distinta de la sesión interactiva — no se pueden matar desde una consola normal, ni siquiera siendo el mismo usuario. En ese caso la única forma limpia es Task Manager como administrador, o un reinicio completo de la PC.

## Nota

Esta instancia corre con `SINGLE_ACCOUNT` forzado igual que la principal — `IS_WIN` en `src/server.js` bloquea el multi-cuenta (`/home` + `sudo -u`) en Windows sea cual sea el valor de esa env var. El "multi-cuenta" acá es a nivel de dos instancias independientes (dos procesos, dos puertos, dos túneles), no el selector de cuenta nativo de la app.
