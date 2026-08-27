# Reinicio "a prueba de balas" de Jarvis (agregado 2026-08-25).
#
# Motivo: los scripts existentes (restart-jarvis.ps1, jarvis-watchdog.ps1) asumen
# que el DAEMON de PM2 esta sano y solo saben decirle "pm2 restart X". El 25/8 se
# encontro un modo de falla nuevo: el daemon de PM2 mismo queda colgado -- vistos
# 5 procesos "Daemon.js" corriendo en simultaneo, cada "pm2 list"/"pm2 restart"
# devuelve EPERM contra \\.\pipe\rpc.sock y ninguno llega a responder. Los scripts
# viejos, en ese estado, se quedan repitiendo "pm2 restart" contra un daemon roto
# para siempre (igual que el bug de 2224 reinicios del 21/8, pero un nivel mas abajo).
#
# Este script intenta el camino bueno primero (PM2, con autorestart/supervision) y
# SOLO si el daemon sigue sin responder despues de limpiarlo y reintentar, cae a
# arrancar server+tunnel directo (bypass total de PM2) para no dejar a Diego sin
# Jarvis. Es idempotente: si ya esta todo sano, no toca nada.
#
# Limite honesto: si algun proceso quedo en Session 0 / integridad alta (el otro
# bug viejo, documentado en CLAUDE.local.md, "Migracion a PM2" y anteriores), este
# script NO tiene permisos para matarlo -- lo dice en el log y hay que usar
# "Reiniciar Jarvis (Admin).bat" (pide UAC). Ningun script sin elevar puede
# garantizar el 100% de los casos posibles en Windows.
#
# Log persistente (append, no se pisa) en %TEMP%\jarvis-full-restart.log

$logFile = "$env:TEMP\jarvis-full-restart.log"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"
$publicUrl = "https://jarvis.controlapps.ar"

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    $line | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Test-Local {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3777" -UseBasicParsing -TimeoutSec 5
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Test-Public {
    try {
        $r = Invoke-WebRequest -Uri $publicUrl -UseBasicParsing -TimeoutSec 10
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Kill-ZombieDaemons {
    $daemons = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*pm2*Daemon.js*' }
    foreach ($d in $daemons) {
        try {
            Stop-Process -Id $d.ProcessId -Force -ErrorAction Stop
            Log "Mate daemon PM2 zombie PID $($d.ProcessId)"
        } catch {
            Log "No pude matar daemon PID $($d.ProcessId): $($_.Exception.Message) -- puede necesitar 'Reiniciar Jarvis (Admin).bat'"
        }
    }
    return $daemons.Count
}

Log "===== Reinicio Jarvis (full) iniciado ====="

if ((Test-Local) -and (Test-Public)) {
    Log "Ya esta arriba (local + publico OK). No hago nada."
    exit 0
}

# npm install por si package.json cambio y node_modules quedo desincronizado
# (causa real del incidente del 21/8 -- ver CLAUDE.local.md)
Push-Location $projectDir
$npmOut = & $npm install --no-audit --no-fund 2>&1 | Out-String
Pop-Location
if ($LASTEXITCODE -ne 0) {
    Log "npm install fallo (seguimos igual): $npmOut"
} elseif ($npmOut -notmatch "up to date") {
    Log "npm install hizo cambios: $npmOut"
}

if ((Kill-ZombieDaemons) -gt 0) { Start-Sleep -Seconds 2 }

# Intento por PM2 (metodo preferido: mantiene autorestart)
$pm2Ok = $false
for ($i = 1; $i -le 2; $i++) {
    Log "Intento PM2 #${i}: pm2 resurrect"
    $out = & $pm2 resurrect 2>&1 | Out-String
    Start-Sleep -Seconds 4
    if (Test-Local) {
        Log "PM2 levanto el server OK"
        $pm2Ok = $true
        break
    }
    Log "PM2 intento #${i} no funciono: $($out.Trim())"
    Kill-ZombieDaemons | Out-Null
    Start-Sleep -Seconds 2
}

# Fallback: bypass total de PM2 si el daemon sigue sin responder
if (-not $pm2Ok) {
    Log "PM2 no responde tras los reintentos -- arrancando directo (bypass PM2, sin autorestart hasta arreglar PM2)"

    $conn = Get-NetTCPConnection -LocalPort 3777 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        try {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
            Log "Mate proceso PID $($conn.OwningProcess) que tenia el 3777 tomado sin responder"
            Start-Sleep -Seconds 1
        } catch {
            Log "No pude liberar el 3777 (PID $($conn.OwningProcess)): $($_.Exception.Message) -- probablemente necesita 'Reiniciar Jarvis (Admin).bat'"
        }
    }

    Start-Process -FilePath "cmd.exe" -ArgumentList '/c', "node src\server.js >> %TEMP%\jarvis-server.log 2>&1" -WorkingDirectory $projectDir -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# Tunel: si la URL publica no responde, reiniciar cloudflared
if (-not (Test-Public)) {
    if ($pm2Ok) {
        Log "Publico no responde, pm2 restart jarvis-tunnel"
        & $pm2 restart jarvis-tunnel 2>&1 | Out-Null
    } else {
        Log "Publico no responde, arrancando cloudflared directo"
        Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath "cmd.exe" -ArgumentList '/c', "cloudflared tunnel run >> %TEMP%\jarvis-tunnel.log 2>&1" -WorkingDirectory $projectDir -WindowStyle Hidden
    }
    Start-Sleep -Seconds 5
}

# Verificacion final con reintentos cortos (el tunel a veces tarda unos segundos en registrar)
$finalLocal = $false
$finalPublic = $false
for ($i = 1; $i -le 4; $i++) {
    $finalLocal = Test-Local
    $finalPublic = Test-Public
    if ($finalLocal -and $finalPublic) { break }
    Start-Sleep -Seconds 3
}

$metodo = if ($pm2Ok) { "PM2 (supervisado normal)" } else { "directo -- PM2 sigue roto, investigar cuando haya tiempo" }
Log "Resultado: local=$finalLocal publico=$finalPublic metodo=$metodo"

if ($finalLocal -and $finalPublic) {
    Log "===== Jarvis arriba OK ====="
    exit 0
} else {
    Log "===== Jarvis SIGUE CAIDO -- probar 'Reiniciar Jarvis (Admin).bat' o revisar Task Manager como admin ====="
    exit 1
}
