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
# sirviendo mientras el supervisor ya esta roto por debajo. Se chequea salud
# real del daemon en cada corrida (barato) y si esta roto se intenta reparar
# solo: matar Daemon.js zombies a integridad normal, y si no alcanza, matar los
# procesos Session 0 sospechosos (node/cloudflared con CommandLine vacio) via
# una PowerShell elevada -- esta PC tiene UAC en "elevar sin preguntar"
# (ConsentPromptBehaviorAdmin=0), asi que esto corre en silencio, sin que Diego
# tenga que aprobar nada, SI la tarea programada tiene acceso a un escritorio
# interactivo.
#
# Verificacion real post-restart (agregado 2026-09-17, ver CLAUDE.local.md "EPERM
# volvio a pasar pese al fix del 09/10"): el 17/9 el watchdog repitio "pm2 restart"
# + "relanzado (pm2)" cada 5 min durante 70 min SIN disparar nunca la reparacion
# de arriba, mientras el server seguia caido. Dos causas reales: (1) el chequeo de
# salud de entonces (`pm2 ping` buscando el texto "EPERM") no detecta el caso
# donde el daemon esta roto pero ese texto no llega al stdout/stderr que
# capturamos (el respawn puede fallar en un proceso hijo aparte, de forma
# asincrona); y (2) el bloque de "3777 no responde" nunca comprobaba si el
# `pm2 restart` que acababa de correr habia funcionado de verdad -- logueaba
# "relanzado (pm2)" sin condicion y salia, ciego a si el proceso realmente volvio
# a escuchar el puerto. Fix: el chequeo de salud ahora exige que `pm2 jlist`
# parsee como JSON valido (cualquier salida rota ya no pasa el chequeo), y tras
# un restart por 3777 caido se re-verifica el puerto real antes de loguear
# exito; si sigue caido, escala a la reparacion de daemon aunque el chequeo
# inicial haya dado sano, y reintenta una vez mas -- el log siempre distingue
# "arriba" de "requiere revision manual" en vez de asumir que funciono.
$logFile = "$env:TEMP\jarvis-watchdog.log"
$publicUrl = "https://jarvis.controlapps.ar"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"

. (Join-Path $PSScriptRoot 'session0-cleanup.ps1')

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Test-Pm2Healthy {
    try {
        $out = & $pm2 jlist 2>&1 | Out-String
    } catch {
        return $false
    }
    try {
        $null = $out | ConvertFrom-Json
        return $true
    } catch {
        return $false
    }
}

function Test-Port3777 {
    try {
        $r = Invoke-WebRequest -Uri http://127.0.0.1:3777 -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Repair-Pm2Daemon {
    Log "PM2 daemon no responde bien (jlist no parsea) -- iniciando reparacion automatica"

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
    $killed = Repair-SessionZeroZombies -ProcessNames @('node.exe', 'cloudflared.exe')

    if ($killed.Count -eq 0) {
        Log "No se encontraron procesos Session 0 sospechosos, o no se pudo elevar -- requiere revision manual"
        return $false
    }

    Log "Resultado elevacion: $($killed -join ' | ')"

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

if (-not (Test-Port3777)) {
    Push-Location $projectDir
    $npmOut = & $npm install --no-audit --no-fund 2>&1 | Out-String
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Log "npm install fallo: $npmOut"
    } elseif ($npmOut -notmatch "up to date") {
        Log "npm install hizo cambios: $npmOut"
    }

    Log "3777 no responde, pm2 restart server + tunnel"
    $restartOut = & $pm2 restart jarvis-server 2>&1 | Out-String
    & $pm2 restart jarvis-tunnel 2>&1 | Out-Null
    Start-Sleep -Seconds 3

    if (Test-Port3777) {
        Log "relanzado (pm2) -- puerto confirmado arriba"
        exit 0
    }

    Log "pm2 restart no lo levanto (salida: $($restartOut.Trim())) -- probando reparacion de daemon aunque el chequeo inicial haya dado sano"
    if (Repair-Pm2Daemon) {
        & $pm2 resurrect 2>&1 | Out-Null
        Start-Sleep -Seconds 3
        & $pm2 restart jarvis-server 2>&1 | Out-Null
        & $pm2 restart jarvis-tunnel 2>&1 | Out-Null
        Start-Sleep -Seconds 3
    }

    if (Test-Port3777) {
        Log "relanzado tras reparacion de daemon -- puerto confirmado arriba"
    } else {
        Log "SIGUE CAIDO tras reparacion + restart -- requiere revision manual (Reiniciar Jarvis (Admin).bat)"
    }
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
