# Watchdog nativo para la instancia de locti — diseño

## Contexto

Esta PC corre dos instancias de Jarvis (claude-chat-manager): la de `User` (puerto 3777, `jarvis.controlapps.ar`, supervisada por PM2 + `jarvis-watchdog.ps1` + tareas programadas `JarvisRestart`/`JarvisTunnelRestart`/`JarvisWatchdog`) y la de `locti` (puerto 3778, `jarvis-locti.controlapps.ar`, hasta ahora sin ningún supervisor automático — solo `restart-jarvis-locti.ps1`, corrido a mano por locti cuando hace falta).

El 12/9/2026 la instancia de locti se cayó (mismo bug crónico de zombies en Session 0 tomando el pipe de PM2 — aunque locti no usa PM2, los mismos procesos zombie de Session 0 afectan cualquier `node.exe`/`cloudflared.exe` de la máquina). Se reinició a mano desde la sesión de `User`, lo que generó un bug real: el server, lanzado sin fijar `USERPROFILE`/`HOME`, resolvió `os.homedir()` a `C:\Users\User` en vez de `C:\Users\locti`, mostrando temporalmente las conversaciones de Diego en la interfaz de locti. Se corrigió fijando las variables de entorno a mano, pero el incidente mostró que lanzar procesos de una cuenta desde la sesión de la otra es frágil.

## Objetivo

Que ambas instancias se levanten solas al arrancar Windows, se autoreparen si se cuelgan (incluida la limpieza de zombies de Session 0), y que ningún mecanismo de una cuenta pueda interferir con la otra.

## Arquitectura

Dos sistemas de watchdog simétricos, cada uno registrado para correr **nativamente como su propia cuenta de Windows** vía Task Scheduler con `LogonType S4U` (no requiere contraseña de esa cuenta ni que esté logueada — mismo mecanismo ya probado en `JarvisWatchdog`). Correr nativamente como la cuenta dueña elimina de raíz la clase de bug del 12/9: Windows fija `USERPROFILE`/`HOME` correctos solo, no depende de que un script recuerde fijarlos a mano.

- **`User` (3777)**: sin cambios — sigue con PM2 + `jarvis-watchdog.ps1` tal cual están.
- **`locti` (3778)**: se queda sin PM2 (decisión explícita — evita duplicar el único problema crónico no resuelto del proyecto, el pipe de PM2 colgándose, en una segunda cuenta). Gana un watchdog propio con la misma cadencia (5 min) que el de `User`.

Cada watchdog **solo actúa sobre su propio puerto** (3777 o 3778) — nunca sobre "lo que sea que esté escuchando ahí". La única lógica compartida es la barrida de procesos zombie de Session 0, que es segura de correr desde cualquiera de las dos cuentas porque Session 0 nunca es una sesión interactiva legítima de ninguna de las dos (se verificó: la sesión de `locti` es Session ID 1, la de `User` es Session ID 2 — Session 0 es exclusivamente el contenedor de servicios/huérfanos).

## Componentes

### 1. `Repair-SessionZeroZombies` (función compartida, nuevo archivo `session0-cleanup.ps1`)

Extraída de la mitad genérica de `Repair-Pm2Daemon` (que hoy mezcla "matar daemons de PM2 duplicados" —específico de PM2— con "matar procesos Session 0 con `CommandLine` vacío" —genérico—). Recibe un filtro opcional de nombres de proceso (`node.exe`, `cloudflared.exe`) y devuelve la lista de PIDs que mató. No sabe nada de PM2 ni de puertos — solo sabe matar zombies de Session 0 con `CommandLine` ilegible, vía la PowerShell elevada silenciosa ya usada hoy (UAC en modo "elevar sin preguntar" en esta PC).

`jarvis-watchdog.ps1` (de `User`) pasa a llamar a esta función como paso dentro de `Repair-Pm2Daemon`, en vez de tener la lógica duplicada inline.

### 2. `jarvis-locti-watchdog.ps1` (nuevo)

Corre cada 5 min como `locti`. Lógica, en orden:

1. Llama a `Repair-SessionZeroZombies` (defensivo — no depende de que haya un problema para correrla, es barata).
2. Chequea `http://127.0.0.1:3778`. Si no responde:
   - `npm install --no-audit --no-fund` en `C:\Users\locti\Proyectos\claude-chat-manager` (mismo motivo documentado para la instancia de `User` el 21/8: un `git pull` puede traer una dependencia nueva sin instalar).
   - Mata lo que tenga el puerto 3778 (identificado por `Get-NetTCPConnection`, no por nombre — mismo patrón que el resto de los scripts del proyecto).
   - Relanza `node src\server.js` con `PORT=3778`, `cwd` en el proyecto de locti. Como el proceso corre nativamente como locti, `os.homedir()` resuelve solo a `C:\Users\locti` — sin necesidad de fijar `USERPROFILE`/`HOME` a mano.
3. Si el local responde pero `https://jarvis-locti.controlapps.ar` no: mata y relanza solo `cloudflared tunnel run` (sin necesidad de `--config` explícito — corriendo como locti, la resolución default de `~/.cloudflared/config.yml` ya apunta al túnel correcto).
4. Loguea a `%TEMP%\jarvis-locti-watchdog.log` (que al correr como locti resuelve a `C:\Users\locti\AppData\Local\Temp\`, la ubicación correcta).

### 3. Tarea programada `JarvisLocti-Watchdog`

`Principal`: `UserId = locti`, `LogonType = S4U`, `RunLevel = Highest` (necesario para el paso de matar zombies de Session 0 — mismo motivo que `JarvisWatchdog`). Trigger: repetición cada 5 min indefinida, igual que la tarea existente de `User`.

### 4. Tarea programada `JarvisLocti` (arranque)

Ya está escrita (`setup-autostart-task-locti.ps1`) pero nunca se registró — se ejecuta tal cual está, sin cambios de código.

### Fuera de alcance (YAGNI)

- No se agrega una tarea de reinicio "on-demand" equivalente a `JarvisRestart` para locti — ya tiene y usa `restart-jarvis-locti.ps1` a mano.
- No se agrega una tarea equivalente a `JarvisTunnelRestart` — el watchdog nuevo ya cubre "local OK, público caído" como un paso propio.
- No se migra a locti a PM2.

## Manejo de errores / casos límite

- **`npm install` falla o no hay cambios**: mismo patrón que `jarvis-watchdog.ps1` — se loguea el resultado, no bloquea el resto del ciclo.
- **La sesión de locti está desconectada (fast user switching) o directamente deslogueada**: no afecta — S4U corre sin necesitar sesión activa, mismo comportamiento ya validado para `JarvisWatchdog`.
- **Ambos watchdogs corren la barrida de Session 0 casi al mismo tiempo**: idempotente — si uno ya mató los zombies, el otro no encuentra nada que matar. No hay condición de carrera dañina porque ninguno de los dos lanza nada persistente en Session 0 (solo matan).
- **Drift de git entre la copia de `User` y la de `locti`**: fuera de alcance de este cambio — es un problema de sincronización manual preexistente, no algo que este watchdog deba resolver.

## Testing

Sin suite automatizada (mismo criterio que el resto de los scripts de PM2/watchdog del proyecto — son scripts de infraestructura, no módulos JS puros). Verificación manual:

1. Matar server + túnel de locti a mano.
2. Disparar `schtasks /Run /TN JarvisLocti-Watchdog` (en vez de esperar los 5 min).
3. Confirmar que vuelve: `127.0.0.1:3778` y `jarvis-locti.controlapps.ar` responden.
4. Confirmar que `os.homedir()` resolvió bien: login + `GET /api/tree` debe mostrar `projectDir: C:\\Users\\locti` en las conversaciones (no `C:\\Users\\User`) — esto es lo que salió mal el 12/9, es la regresión concreta a no repetir.
5. Confirmar `JarvisLocti-Watchdog` y `JarvisLocti` quedan registradas y en estado `Ready`.

No se prueba el arranque en frío real (reiniciar la PC compartida) — se asume el mecanismo por ser idéntico al de `User`, ya validado en producción desde el 17/8.
