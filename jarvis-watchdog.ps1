# Watchdog Jarvis (migrado a PM2, 2026-08-17): si 127.0.0.1:3777 no responde,
# "pm2 restart" server+tunnel. Si el local responde pero la URL publica no,
# "pm2 restart" solo el tunel. Misma logica de antes, pero PM2 se encarga de
# matar/relanzar sus propios hijos en vez de que este script cace PIDs a mano
# (eso era lo que dejaba procesos huerfanos trabados en Session 0/integridad alta).
$logFile = "$env:TEMP\jarvis-watchdog.log"
$publicUrl = "https://jarvis.controlapps.ar"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

$localAlive = $false
try {
    $r = Invoke-WebRequest -Uri http://127.0.0.1:3777 -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $localAlive = $true }
} catch { $localAlive = $false }

if (-not $localAlive) {
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
