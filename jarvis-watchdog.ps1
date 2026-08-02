# Watchdog Jarvis: si 127.0.0.1:3777 no responde, mata y relanza server+tunnel.
# Si el local responde pero la URL pública no (tunel colgado/502), relanza solo cloudflared.
$logFile = "$env:TEMP\jarvis-watchdog.log"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$publicUrl = "https://jarvis.controlapps.ar"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Start-Server {
    Set-Location $projectDir
    Start-Process -FilePath "node" -ArgumentList "src\server.js" -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\jarvis-server.log" -RedirectStandardError "$env:TEMP\jarvis-server-err.log"
}

function Start-Tunnel {
    Start-Process -FilePath "cloudflared" -ArgumentList "tunnel","run" -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\jarvis-tunnel.log" -RedirectStandardError "$env:TEMP\jarvis-tunnel-err.log"
}

function Kill-Cloudflared {
    Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        if (Get-Process -Id $_.Id -ErrorAction SilentlyContinue) {
            Log "no se pudo matar cloudflared pid $($_.Id) (acceso denegado, probablemente session 0)"
        } else {
            Log "killed cloudflared pid $($_.Id)"
        }
    }
}

$localAlive = $false
try {
    $r = Invoke-WebRequest -Uri http://127.0.0.1:3777 -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $localAlive = $true }
} catch { $localAlive = $false }

if (-not $localAlive) {
    Log "3777 no responde, reiniciando server + tunnel"

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*server.js*" -and $_.CommandLine -like "*claude-chat-manager*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Log "killed node pid $($_.ProcessId)" }

    Kill-Cloudflared

    Start-Sleep -Seconds 2

    Start-Server
    Start-Tunnel

    Log "relanzado"
    exit 0
}

$publicAlive = $false
try {
    $rp = Invoke-WebRequest -Uri $publicUrl -UseBasicParsing -TimeoutSec 10
    if ($rp.StatusCode -eq 200) { $publicAlive = $true }
} catch { $publicAlive = $false }

if ($publicAlive) { exit 0 }

Log "local OK pero $publicUrl no responde, reiniciando solo tunnel"
Kill-Cloudflared
Start-Sleep -Seconds 2
Start-Tunnel
Log "tunnel relanzado"
