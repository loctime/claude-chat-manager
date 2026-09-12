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
