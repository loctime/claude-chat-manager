# Watchdog nativo para la instancia de locti — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la instancia de locti (puerto 3778, `jarvis-locti.controlapps.ar`) se levante sola al arrancar Windows y se autorepare (incluida la limpieza de zombies de Session 0), corriendo nativamente como la cuenta `locti` — sin depender de que otra cuenta lance sus procesos.

**Architecture:** Se extrae la lógica de "matar procesos zombie de Session 0" de `jarvis-watchdog.ps1` (instancia de `User`) a una función compartida (`session0-cleanup.ps1`). Se crea un watchdog simétrico para locti (`jarvis-locti-watchdog.ps1`, sin PM2 — decisión explícita del spec) y dos tareas programadas (`JarvisLocti-Watchdog` cada 5 min, `JarvisLocti` al arranque), ambas `LogonType S4U` corriendo como `locti` — no requieren su contraseña ni que esté logueado.

**Tech Stack:** PowerShell 5.1, Windows Task Scheduler (S4U), Node.js, cloudflared.

**Spec:** `docs/superpowers/specs/2026-09-12-watchdog-locti-design.md`

## Global Constraints

- No se agrega PM2 para locti (decisión explícita del spec — evita duplicar el problema crónico de EPERM del pipe de PM2 en una segunda cuenta).
- `ACCESS_PIN` de la instancia de locti es `"diego"` (mismo valor ya hardcodeado en `restart-jarvis-locti.ps1` y `start-jarvis-locti.bat` — no inventar uno nuevo).
- Puerto fijo `3778` para locti, `3777` para `User` — cada watchdog toca solo el suyo, nunca "lo que sea que esté escuchando".
- Ambas tareas programadas nuevas usan `LogonType S4U` corriendo como `locti` (no `User`) — es la única forma de que `os.homedir()` del server resuelva a `C:\Users\locti` sin fijar variables de entorno a mano.
- El repo vive en dos checkouts separados del mismo remoto (`https://github.com/loctime/claude-chat-manager.git`): `C:\Users\User\Desktop\Proyectos\claude-chat-manager` y `C:\Users\locti\Proyectos\claude-chat-manager`. Los archivos nuevos tienen que llegar a los dos vía push+pull, no alcanza con crearlos en uno solo.

---

## Task 1: Extraer la limpieza de zombies de Session 0 a un helper compartido

**Files:**
- Create: `C:\Users\User\Desktop\Proyectos\claude-chat-manager\session0-cleanup.ps1`
- Modify: `C:\Users\User\Desktop\Proyectos\claude-chat-manager\jarvis-watchdog.ps1`

**Interfaces:**
- Produces: función `Repair-SessionZeroZombies -ProcessNames <string[]>` → devuelve `string[]` con una línea por PID procesado (`"PID <n> matado"` o `"PID <n> fallo: <mensaje>"`), o un array vacío si no había sospechosos o no se pudo elevar. La usan tanto `jarvis-watchdog.ps1` (Task 1) como `jarvis-locti-watchdog.ps1` (Task 2).

- [ ] **Step 1: Crear `session0-cleanup.ps1`**

```powershell
# Mata procesos node.exe/cloudflared.exe huerfanos en Session 0 (CommandLine
# ilegible desde WMI) -- Session 0 nunca es una sesion interactiva legitima de
# ninguna cuenta de esta PC, asi que es seguro barrerla desde cualquiera de las
# dos (User o locti). Ver CLAUDE.local.md, "Root cause del EPERM de PM2
# identificado" (2026-09-09) para el contexto completo del hallazgo.
#
# Extraido de jarvis-watchdog.ps1 el 2026-09-12 para poder reusarlo desde
# jarvis-locti-watchdog.ps1 sin duplicar la logica de elevacion.
#
# Requiere que esta PC tenga UAC en "elevar sin preguntar"
# (ConsentPromptBehaviorAdmin=0) para que la elevacion sea silenciosa.

function Repair-SessionZeroZombies {
    param(
        [string[]]$ProcessNames = @('node.exe', 'cloudflared.exe')
    )

    $suspects = @()
    foreach ($name in $ProcessNames) {
        $suspects += Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
            Where-Object { $_.SessionId -eq 0 -and [string]::IsNullOrEmpty($_.CommandLine) }
    }

    if ($suspects.Count -eq 0) { return @() }

    $targetPids = ($suspects | Select-Object -ExpandProperty ProcessId) -join ','
    $marker = "$env:TEMP\session0-cleanup-elevated-kill.txt"
    Remove-Item $marker -ErrorAction SilentlyContinue
    $killScriptPath = "$env:TEMP\session0-cleanup-elevated-kill.ps1"
    @"
`$targetPids = '$targetPids' -split ','
foreach (`$p in `$targetPids) {
    try {
        Stop-Process -Id `$p -Force -ErrorAction Stop
        "PID `$p matado" | Out-File -FilePath '$marker' -Append
    } catch {
        "PID `$p fallo: `$(`$_.Exception.Message)" | Out-File -FilePath '$marker' -Append
    }
}
"@ | Out-File -FilePath $killScriptPath -Encoding utf8 -Force

    try {
        Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$killScriptPath`"" -ErrorAction Stop
    } catch {
        return @()
    }

    Start-Sleep -Seconds 5
    if (Test-Path $marker) {
        return @(Get-Content $marker)
    }
    return @()
}
```

- [ ] **Step 2: Probar el helper de forma aislada**

Run: `powershell -NoProfile -Command ". 'C:\Users\User\Desktop\Proyectos\claude-chat-manager\session0-cleanup.ps1'; Repair-SessionZeroZombies"`

Expected: no tira error de sintaxis ni de ejecución. Si no hay zombies de Session 0 en este momento, devuelve nada (array vacío) — eso es un resultado válido, no una falla. Confirmar además que la máquina sigue funcionando normal después (no mató nada que no debía): `Get-Process node,cloudflared -ErrorAction SilentlyContinue | Select-Object Id,ProcessName` debe seguir mostrando los procesos legítimos de antes de correr el comando.

- [ ] **Step 3: Modificar `jarvis-watchdog.ps1` — agregar el dot-source**

Buscar esta línea (cerca del principio del archivo, después de las variables `$pm2`/`$npm`):

```powershell
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"
```

Reemplazar por:

```powershell
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"

. (Join-Path $PSScriptRoot 'session0-cleanup.ps1')
```

- [ ] **Step 4: Modificar `jarvis-watchdog.ps1` — reemplazar el bloque inline por la llamada al helper**

Buscar este bloque completo dentro de la función `Repair-Pm2Daemon` (empieza en `Log "Sigue roto..."`, termina justo antes de `Start-Sleep -Seconds 2` seguido de `if (Test-Pm2Healthy) { Log "PM2 sano tras matar procesos Session 0"...`):

```powershell
    Log "Sigue roto -- buscando procesos Session 0 sospechosos (node/cloudflared con CommandLine ilegible)"
    $suspects = @()
    $suspects += Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq 0 -and [string]::IsNullOrEmpty($_.CommandLine) }
    $suspects += Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq 0 -and [string]::IsNullOrEmpty($_.CommandLine) }

    if ($suspects.Count -eq 0) {
        Log "No se encontraron procesos Session 0 sospechosos -- no se puede reparar solo, requiere revision manual"
        return $false
    }

    $targetPids = ($suspects | Select-Object -ExpandProperty ProcessId) -join ','
    Log "Sospechosos: PIDs $targetPids -- intentando matar elevado"

    $marker = "$env:TEMP\jarvis-watchdog-elevated-kill.txt"
    Remove-Item $marker -ErrorAction SilentlyContinue
    $killScriptPath = "$env:TEMP\jarvis-watchdog-elevated-kill.ps1"
    @"
`$targetPids = '$targetPids' -split ','
foreach (`$p in `$targetPids) {
    try {
        Stop-Process -Id `$p -Force -ErrorAction Stop
        "PID `$p matado" | Out-File -FilePath '$marker' -Append
    } catch {
        "PID `$p fallo: `$(`$_.Exception.Message)" | Out-File -FilePath '$marker' -Append
    }
}
"@ | Out-File -FilePath $killScriptPath -Encoding utf8 -Force

    try {
        Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$killScriptPath`"" -ErrorAction Stop
    } catch {
        Log "No se pudo lanzar la PowerShell elevada: $($_.Exception.Message) -- requiere Reiniciar Jarvis (Admin).bat"
        return $false
    }

    Start-Sleep -Seconds 5
    if (Test-Path $marker) {
        Log "Resultado elevacion: $((Get-Content $marker) -join ' | ')"
    } else {
        Log "La elevacion no dejo marcador -- probablemente esta tarea no tiene escritorio interactivo disponible ahora. Requiere 'Reiniciar Jarvis (Admin).bat' a mano."
        return $false
    }
```

Reemplazar por:

```powershell
    Log "Sigue roto -- buscando procesos Session 0 sospechosos (node/cloudflared con CommandLine ilegible)"
    $killed = Repair-SessionZeroZombies -ProcessNames @('node.exe', 'cloudflared.exe')

    if ($killed.Count -eq 0) {
        Log "No se encontraron procesos Session 0 sospechosos, o no se pudo elevar -- requiere revision manual"
        return $false
    }

    Log "Resultado elevacion: $($killed -join ' | ')"
```

(El resto de la función, `Start-Sleep -Seconds 2` + el `if (Test-Pm2Healthy) { ... }` final + el último `return $false`, queda tal cual está — no se toca.)

- [ ] **Step 5: Verificar que el archivo sigue siendo sintácticamente válido**

Run: `powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('C:\Users\User\Desktop\Proyectos\claude-chat-manager\jarvis-watchdog.ps1', [ref]$null, [ref]$e); if ($e.Count -gt 0) { $e } else { 'OK: sin errores de sintaxis' }"`

Expected: `OK: sin errores de sintaxis`

- [ ] **Step 6: Correr el watchdog completo en vivo para confirmar que no rompió nada**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\Desktop\Proyectos\claude-chat-manager\jarvis-watchdog.ps1"`

Expected: termina sin error (la instancia de `User` debe estar sana en este momento, así que el script no debería loguear nada — comportamiento ya documentado como "solo escribe si actúa"). Confirmar con `Get-Content "$env:TEMP\jarvis-watchdog.log" -Tail 3` que no aparecieron líneas nuevas de error, y que `http://127.0.0.1:3777` sigue respondiendo (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3777` → `302` o `200`).

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
git add session0-cleanup.ps1 jarvis-watchdog.ps1
git commit -m "refactor: extraer limpieza de zombies Session 0 a helper compartido"
```

---

## Task 2: Crear el watchdog de la instancia de locti

**Files:**
- Create: `C:\Users\User\Desktop\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1`

**Interfaces:**
- Consumes: `Repair-SessionZeroZombies -ProcessNames <string[]>` (Task 1, mismo archivo `session0-cleanup.ps1` en el mismo directorio).

- [ ] **Step 1: Crear `jarvis-locti-watchdog.ps1`**

```powershell
# Watchdog de la instancia de locti (puerto 3778, jarvis-locti.controlapps.ar).
# Corre nativamente como locti (tarea programada JarvisLocti-Watchdog, S4U) -- por
# eso os.homedir() del server resuelve solo a C:\Users\locti, sin necesitar fijar
# USERPROFILE/HOME a mano. Ver CLAUDE.local.md, "Bug resuelto 2026-09-12": lanzar
# este proceso desde la sesion de User (sin fijar esas variables) fue justamente
# lo que mostro las conversaciones de Diego en la interfaz de locti por un rato.
#
# A diferencia de jarvis-watchdog.ps1 (instancia de User), esta no usa PM2 --
# decision a proposito del spec, para no duplicar el unico problema cronico no
# resuelto del proyecto (el pipe de PM2 colgandose) en una segunda cuenta. El
# chequeo es mas simple: puerto escuchando + npm install si hace falta +
# relanzar crudo -- mismo patron que restart-jarvis-locti.ps1, pero automatico.

$logFile    = "$env:TEMP\jarvis-locti-watchdog.log"
$publicUrl  = "https://jarvis-locti.controlapps.ar"
$projectDir = "C:\Users\locti\Proyectos\claude-chat-manager"
$port       = 3778
$node       = "C:\Program Files\nodejs\node.exe"
$npm        = "C:\Program Files\nodejs\npm.cmd"

$cloudflaredExe = "cloudflared"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    $fallback = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
    if (Test-Path $fallback) { $cloudflaredExe = $fallback }
}

. (Join-Path $PSScriptRoot 'session0-cleanup.ps1')

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

$killed = Repair-SessionZeroZombies -ProcessNames @('node.exe', 'cloudflared.exe')
if ($killed.Count -gt 0) {
    Log "Zombies de Session 0 matados: $($killed -join ' | ')"
}

$localAlive = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $localAlive = $true }
} catch { $localAlive = $false }

if (-not $localAlive) {
    Push-Location $projectDir
    $npmOut = & $npm install --no-audit --no-fund 2>&1 | Out-String
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Log "npm install fallo: $npmOut"
    } elseif ($npmOut -notmatch "up to date") {
        Log "npm install hizo cambios: $npmOut"
    }

    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $listeners) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 2

    $env:PORT = "$port"
    $env:ACCESS_PIN = "diego"
    Start-Process -FilePath $node -ArgumentList "src\server.js" -WorkingDirectory $projectDir -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\jarvis-locti-server.log" -RedirectStandardError "$env:TEMP\jarvis-locti-server-err.log"

    Log "puerto $port no respondia, server relanzado"
    exit 0
}

$publicAlive = $false
try {
    $rp = Invoke-WebRequest -Uri $publicUrl -UseBasicParsing -TimeoutSec 10
    if ($rp.StatusCode -eq 200) { $publicAlive = $true }
} catch { $publicAlive = $false }

if ($publicAlive) { exit 0 }

Log "local OK pero $publicUrl no responde, relanzando cloudflared"
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Start-Process -FilePath $cloudflaredExe -ArgumentList "tunnel","run" -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\jarvis-locti-tunnel.log" -RedirectStandardError "$env:TEMP\jarvis-locti-tunnel-err.log"
Log "tunel relanzado"
```

- [ ] **Step 2: Verificar sintaxis**

Run: `powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('C:\Users\User\Desktop\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1', [ref]$null, [ref]$e); if ($e.Count -gt 0) { $e } else { 'OK: sin errores de sintaxis' }"`

Expected: `OK: sin errores de sintaxis`

- [ ] **Step 3: Correrlo en vivo (solo para chequeo de seguridad — NO valida el fix del HOME todavía)**

Confirmar antes que la instancia de locti está sana: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3778` → `302`.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\Desktop\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1"`

Expected: termina sin error. Como la instancia ya está sana, no debería tocar nada (mismo comportamiento "silencioso" que el watchdog de `User`). Confirmar con `Get-Content "C:\Users\locti\AppData\Local\Temp\jarvis-locti-watchdog.log" -Tail 3 -ErrorAction SilentlyContinue` que no hay líneas de error nuevas, y que `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3778` sigue devolviendo `302`.

**Nota importante:** esta ejecución la hace la sesión de `User` (para probar que el script no tiene bugs), así que **no** confirma que el bug de `HOME`/`USERPROFILE` del 12/9 está resuelto — esa prueba solo es válida cuando el script corre a través de la tarea programada real (`JarvisLocti-Watchdog`, S4U, ejecutándose nativamente como `locti`). Esa validación end-to-end es el Task 5.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
git add jarvis-locti-watchdog.ps1
git commit -m "feat: watchdog automatico para la instancia de locti (sin PM2)"
```

---

## Task 3: Sincronizar el repo de locti y registrar la tarea `JarvisLocti-Watchdog`

**Files:**
- Create: `C:\Users\User\Desktop\Proyectos\claude-chat-manager\setup-locti-watchdog-task.ps1`

**Interfaces:**
- Consumes: `C:\Users\locti\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1` (Task 2, sincronizado a la copia de locti por este mismo task).

- [ ] **Step 1: Crear `setup-locti-watchdog-task.ps1`**

```powershell
# Registra la tarea programada que corre el watchdog de la instancia de locti
# (puerto 3778) cada 5 minutos, nativamente como locti via S4U -- mismo mecanismo
# que ya usa la tarea "JarvisWatchdog" de la cuenta User. RunLevel Highest porque
# el watchdog necesita poder matar zombies de Session 0 (ver session0-cleanup.ps1).
#
# No requiere la contrasena de locti (S4U no la necesita) ni que locti este
# logueado -- corre igual, este su sesion conectada, desconectada o deslogueada.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$taskName   = "JarvisLocti-Watchdog"
$scriptPath = "C:\Users\locti\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1"

$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72)
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\locti" -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Output "Tarea '$taskName' registrada: corre cada 5 min como locti, RunLevel Highest."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Write-Output ""
Write-Output "Presione Enter para cerrar..."
Read-Host | Out-Null
```

- [ ] **Step 2: Verificar sintaxis**

Run: `powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('C:\Users\User\Desktop\Proyectos\claude-chat-manager\setup-locti-watchdog-task.ps1', [ref]$null, [ref]$e); if ($e.Count -gt 0) { $e } else { 'OK: sin errores de sintaxis' }"`

Expected: `OK: sin errores de sintaxis`

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
git add setup-locti-watchdog-task.ps1
git commit -m "feat: script de registro de la tarea JarvisLocti-Watchdog"
```

- [ ] **Step 4: Push a origin y pull en la copia de locti**

Run:
```bash
cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager" && git push origin master
cd "C:\Users\locti\Proyectos\claude-chat-manager" && git pull origin master
```

Expected: el push llega sin pedir credenciales nuevas (credential.helper ya está en `store`). El pull en la copia de locti trae los 4 archivos nuevos/modificados (`session0-cleanup.ps1`, `jarvis-watchdog.ps1`, `jarvis-locti-watchdog.ps1`, `setup-locti-watchdog-task.ps1`) y queda en el mismo commit que `origin/master`. Confirmar con `git -C "C:\Users\locti\Proyectos\claude-chat-manager" log -1 --format=%H` que coincide con `git -C "C:\Users\User\Desktop\Proyectos\claude-chat-manager" log -1 --format=%H`.

- [ ] **Step 5: Registrar la tarea**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\locti\Proyectos\claude-chat-manager\setup-locti-watchdog-task.ps1"`

(El script se auto-eleva solo — en esta PC la elevación es silenciosa por la configuración de UAC, no debería aparecer ningún diálogo visible que haga falta aceptar a mano.)

- [ ] **Step 6: Verificar que quedó registrada correctamente**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'JarvisLocti-Watchdog' | Select-Object TaskName, State, @{n='UserId';e={$_.Principal.UserId}}, @{n='LogonType';e={$_.Principal.LogonType}}, @{n='RunLevel';e={$_.Principal.RunLevel}}"`

Expected:
```
TaskName             State UserId                    LogonType RunLevel
--------             ----- ------                    --------- --------
JarvisLocti-Watchdog Ready <COMPUTERNAME>\locti       S4U       Highest
```

---

## Task 4: Registrar la tarea de arranque `JarvisLocti`

**Files:**
- (ninguno nuevo — se ejecuta `setup-autostart-task-locti.ps1`, que ya existe en el repo sin cambios)

- [ ] **Step 1: Confirmar que el script ya está sincronizado en la copia de locti**

Run: `ls "C:\Users\locti\Proyectos\claude-chat-manager\setup-autostart-task-locti.ps1"`

Expected: el archivo existe (ya estaba en el repo antes de este plan, y Task 3 Step 4 ya sincronizó la copia de locti al último commit).

- [ ] **Step 2: Confirmar que la tarea `JarvisLocti` todavía no existe**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'JarvisLocti' -ErrorAction SilentlyContinue"`

Expected: sin salida (no existe todavía — se verificó así el 2026-09-12 antes de armar este plan).

- [ ] **Step 3: Registrarla**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\locti\Proyectos\claude-chat-manager\setup-autostart-task-locti.ps1"`

- [ ] **Step 4: Verificar**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'JarvisLocti' | Select-Object TaskName, State"`

Expected:
```
TaskName    State
--------    -----
JarvisLocti Ready
```

---

## Task 5: Validación end-to-end (la prueba real del fix del 12/9)

**Files:** (ninguno — solo verificación)

- [ ] **Step 1: Registrar el estado sano actual, para comparar después**

Run:
```bash
curl -s -o /dev/null -w "local antes: %{http_code}\n" http://127.0.0.1:3778
curl -s -o /dev/null -w "publico antes: %{http_code}\n" https://jarvis-locti.controlapps.ar
```

Expected: `302` en ambos.

- [ ] **Step 2: Matar la instancia de locti a mano (simular la caída)**

Run:
```powershell
$p = Get-NetTCPConnection -LocalPort 3778 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($p) { Stop-Process -Id $p -Force }
Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -notlike '*User*' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
```

Confirmar que quedó caída: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3778 --max-time 5` → error de conexión (no `302`).

- [ ] **Step 3: Disparar la tarea real (no correr el .ps1 a mano — tiene que pasar por la tarea programada para que corra nativamente como locti)**

Run: `schtasks /Run /TN "JarvisLocti-Watchdog"`

Esperar 15 segundos (el watchdog hace `npm install` + relanza — puede tardar unos segundos).

- [ ] **Step 4: Verificar que volvió**

Run:
```bash
curl -s -o /dev/null -w "local despues: %{http_code}\n" http://127.0.0.1:3778 --max-time 10
```

Expected: `302`.

- [ ] **Step 5: La prueba clave — confirmar que NO se repite el bug del HOME**

Run:
```bash
curl -s -c /tmp/jarvis_locti_verify.txt -X POST http://127.0.0.1:3778/__auth -H "Content-Type: application/json" -d '{"pin":"diego"}'
curl -s -b /tmp/jarvis_locti_verify.txt http://127.0.0.1:3778/api/tree --max-time 10 | grep -o '"projectDir":"[^"]*"' | sort -u
rm -f /tmp/jarvis_locti_verify.txt
```

Expected: la única salida es `"projectDir":"C:\\\\Users\\\\locti"` (con las barras escapadas por el JSON) — **ningún** `C:\\Users\\User`. Si aparece `C:\Users\User`, el fix no funcionó y hay que revisar por qué la tarea no está corriendo nativamente como locti (volver a Task 3, Step 6, y confirmar `LogonType`/`UserId`).

- [ ] **Step 6: Confirmar el túnel también volvió**

Run: `curl -s -o /dev/null -w "publico despues: %{http_code}\n" https://jarvis-locti.controlapps.ar --max-time 15`

Expected: `302`. Si sigue caído, esperar otros 15s (el registro del túnel contra el edge de Cloudflare tarda unos segundos) y reintentar antes de asumir que falló.

- [ ] **Step 7: Confirmar que las dos tareas de arranque quedaron listas para el próximo boot**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'JarvisLocti','JarvisLocti-Watchdog' | Select-Object TaskName, State"`

Expected: las dos en `Ready`.

**No hay commit en este task** — es puramente verificación, no toca código.

---

## Estado de ejecución (2026-09-12)

- **Task 1** (helper compartido + refactor de `jarvis-watchdog.ps1`): ✅ hecho, probado en vivo, commiteado (`275544c`).
- **Task 2** (`jarvis-locti-watchdog.ps1`): ✅ hecho, probado en vivo, commiteado (`480cfa8`, ajustado en `5e4ad0b` sin `Repair-SessionZeroZombies`).
- **Task 3** (registrar `JarvisLocti-Watchdog`): archivo listo y sincronizado a la copia de locti, pero **el registro de la tarea falló** — `CimException: Acceso denegado`. Causa real: S4U solo permite registrar una tarea para uno mismo sin privilegios especiales; ninguna otra cuenta (admin o no) puede hacerlo por otra. Corregido el script (sacada la auto-elevación que era contraproducente) en `e008ea0`. **Pendiente: correr desde la sesión de locti.**
- **Task 4** (`JarvisLocti`, arranque): mismo bloqueo — corregido el mismo bug de auto-elevación en `setup-autostart-task-locti.ps1` (probablemente nunca funcionó desde que se escribió el 17/8). **Pendiente: correr desde la sesión de locti.**
- **Task 5** (validación end-to-end): bloqueada hasta que Task 3 y 4 estén hechas.

### Para Fernando — 2 comandos, sin admin, sin elevar

Desde su propia sesión (locti), en una PowerShell normal (no "Ejecutar como administrador" — si aparece un cartel de UAC pidiendo credenciales, cancelarlo, es señal de que algo quedó apuntando al script viejo):

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\locti\Proyectos\claude-chat-manager\setup-locti-watchdog-task.ps1"
powershell -ExecutionPolicy Bypass -File "C:\Users\locti\Proyectos\claude-chat-manager\setup-autostart-task-locti.ps1"
```

Cada uno debería terminar mostrando `State: Ready` para su tarea (`JarvisLocti-Watchdog` / `JarvisLocti`) sin pedir nada. Avisar cuando estén corridos para terminar el Task 5 (validación).
