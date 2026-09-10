# Watchdog Jarvis (migrado a PM2, 2026-08-17): si 127.0.0.1:3777 no responde,
# "pm2 restart" server+tunnel. Si el local responde pero la URL publica no,
# "pm2 restart" solo el tunel. Misma logica de antes, pero PM2 se encarga de
# matar/relanzar sus propios hijos en vez de que este script cace PIDs a mano
# (eso era lo que dejaba procesos huerfanos trabados en Session 0/integridad alta).
#
# npm install antes de reiniciar el server (agregado 2026-08-21): si el 3777 no
# responde porque node_modules quedo desincronizado de package.json (un `git pull`
# no corre npm install solo), "pm2 restart" sin mas solo repite el mismo crash cada
# 5 minutos para siempre sin autocurarse -- paso real, 2224 reinicios acumulados
# antes de que alguien lo notara. Solo se corre en esta rama (server realmente
# caido), no en cada chequeo sano, para no pagar el costo cada 5 min porque si.
#
# Auto-reparacion del daemon de PM2 (agregado 2026-09-09, ver CLAUDE.local.md
# "Root cause del EPERM de PM2 identificado"): el daemon de PM2 puede quedar
# colgado (EPERM en \\.\pipe\rpc.sock) por procesos misterio de Session 0 que
# le toman el pipe -- distinto del 3777 no respondiendo, la app puede seguir
# sirviendo mientras el supervisor ya esta roto por debajo. Se chequea "pm2 ping"
# en cada corrida (barato) y si esta roto se intenta reparar solo: matar
# Daemon.js zombies a integridad normal, y si no alcanza, matar los procesos
# Session 0 sospechosos (node/cloudflared con CommandLine vacio) via una
# PowerShell elevada -- esta PC tiene UAC en "elevar sin preguntar"
# (ConsentPromptBehaviorAdmin=0), asi que esto corre en silencio, sin que Diego
# tenga que aprobar nada, SI la tarea programada tiene acceso a un escritorio
# interactivo. Si no lo tiene (corre "no logueado"), la elevacion no deja
# marcador y el script lo loguea en vez de asumir que funciono -- ahi si hace
# falta "Reiniciar Jarvis (Admin).bat" a mano.
$logFile = "$env:TEMP\jarvis-watchdog.log"
$publicUrl = "https://jarvis.controlapps.ar"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Test-Pm2Healthy {
    $out = & $pm2 ping 2>&1 | Out-String
    return ($out -notmatch 'EPERM')
}

function Repair-Pm2Daemon {
    Log "PM2 daemon no responde (EPERM) -- iniciando reparacion automatica"

    $daemons = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*pm2*Daemon.js*' }
    foreach ($d in $daemons) {
        try { Stop-Process -Id $d.ProcessId -Force -ErrorAction Stop } catch {}
    }
    if ($daemons.Count -gt 0) {
        Log "Mate $($daemons.Count) daemon(s) PM2 zombie (integridad normal)"
        Start-Sleep -Seconds 2
    }

    if (Test-Pm2Healthy) { Log "PM2 sano tras matar daemons zombie -- no hizo falta elevar"; return $true }

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

    Start-Sleep -Seconds 2
    if (Test-Pm2Healthy) { Log "PM2 sano tras matar procesos Session 0"; return $true }

    Log "PM2 sigue roto tras el intento automatico -- requiere 'Reiniciar Jarvis (Admin).bat' o reiniciar la PC"
    return $false
}

if (-not (Test-Pm2Healthy)) {
    if (Repair-Pm2Daemon) {
        & $pm2 resurrect 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        Log "pm2 resurrect corrido tras reparacion"
    }
}

$localAlive = $false
try {
    $r = Invoke-WebRequest -Uri http://127.0.0.1:3777 -UseBasicParsing -TimeoutSec 5
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

    Log "3777 no responde, pm2 restart server + tunnel"
    & $pm2 restart jarvis-server 2>&1 | Out-Null
    & $pm2 restart jarvis-tunnel 2>&1 | Out-Null
    Log "relanzado (pm2)"
    exit 0
}

$publicAlive = $false
try {
    $rp = Invoke-WebRequest -Uri $publicUrl -UseBasicParsing -TimeoutSec 10
    if ($rp.StatusCode -eq 200) { $publicAlive = $true }
} catch { $publicAlive = $false }

if ($publicAlive) { exit 0 }

Log "local OK pero $publicUrl no responde, pm2 restart solo tunnel"
& $pm2 restart jarvis-tunnel 2>&1 | Out-Null
Log "tunnel relanzado (pm2)"
