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
$logFile = "$env:TEMP\jarvis-watchdog.log"
$publicUrl = "https://jarvis.controlapps.ar"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
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
