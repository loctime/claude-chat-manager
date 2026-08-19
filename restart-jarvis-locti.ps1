# Reinicio COMPLETO de esta instancia de Jarvis (usuario locti, puerto 3778, tunel jarvis2).
# Mata server + tunel propios y los vuelve a levantar. Corre a integridad normal (sin admin),
# igual que la tarea programada "JarvisLocti" -- asi un proceso lanzado desde aca siempre
# queda matable despues (mismo motivo que restart-jarvis.ps1 / jarvis-watchdog.ps1 del repo:
# un proceso arrancado desde un contexto elevado hereda integridad "High" y despues nada sin
# elevar lo puede volver a matar).
#
# No toca DNS/Cloudflare (eso es config del lado de Cloudflare, no un proceso local) ni la
# instancia del otro usuario en esta PC -- Windows ya impide que este script mate procesos
# que no son de la cuenta locti (fallan con "acceso denegado" y se ignoran, no se cae el script).
#
# Uso: powershell -ExecutionPolicy Bypass -File restart-jarvis-locti.ps1

$ErrorActionPreference = "Stop"

$projectDir = "C:\Users\locti\Proyectos\claude-chat-manager"
$port       = 3778
$publicUrl  = "https://jarvis-locti.controlapps.ar"
$logFile    = "$env:TEMP\jarvis-locti-restart.log"

# Fijados a mano (NO confiar en $env:PORT/$env:ACCESS_PIN heredados: si esta sesion de
# PowerShell es mas vieja que el ultimo `setx`, hereda valores viejos o vacios -- paso
# real detectado el 2026-08-17: sin esto arranco en el 3777 default en vez del 3778).
$env:PORT       = "3778"
$env:ACCESS_PIN = "diego"

# Ruta completa por si el PATH de esta sesion todavia no tiene cloudflared
# (winget lo agrego al PATH de Machine, pero una sesion ya abierta no lo hereda hasta reloguear).
$cloudflaredExe = "cloudflared"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    $fallback = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
    if (Test-Path $fallback) { $cloudflaredExe = $fallback }
}

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    $line | Out-File -FilePath $logFile -Append -Encoding utf8
    Write-Output $line
}

Log "=== reinicio completo iniciado ==="

# 1. Matar el server (identificado por quien tiene el puerto escuchando, no por nombre/CommandLine)
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $listeners) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
        Log "NO se pudo matar server pid $procId (probablemente no es mio)"
    } else {
        Log "server pid $procId matado"
    }
}
if (-not $listeners) { Log "nada escuchaba en $port" }

# 2. Matar cloudflared -- best effort; el que no sea mio tira "acceso denegado" y se ignora
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $_.Id -ErrorAction SilentlyContinue) {
        Log "cloudflared pid $($_.Id) sigue vivo (no es mio o integridad mas alta, ignorado)"
    } else {
        Log "cloudflared pid $($_.Id) matado"
    }
}

Start-Sleep -Seconds 2

# 3. Levantar server + tunel de nuevo
Set-Location $projectDir
Start-Process -FilePath "node" -ArgumentList "src\server.js" -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\jarvis-locti-server.log" -RedirectStandardError "$env:TEMP\jarvis-locti-server-err.log"
Log "server relanzado"

Start-Process -FilePath $cloudflaredExe -ArgumentList "tunnel","run" -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\jarvis-locti-tunnel.log" -RedirectStandardError "$env:TEMP\jarvis-locti-tunnel-err.log"
Log "tunel relanzado"

# 4. Verificar (curl.exe en vez de Invoke-WebRequest: mas simple con redirects/errores)
Start-Sleep -Seconds 5
$localCode = & curl.exe -s -o NUL -w "%{http_code}" --max-time 5 "http://127.0.0.1:$port/" 2>$null
Log "local check: HTTP $localCode"

Start-Sleep -Seconds 5
$pubCode = & curl.exe -s -o NUL -w "%{http_code}" --max-time 15 $publicUrl 2>$null
Log "publico check ($publicUrl): HTTP $pubCode"

Log "=== reinicio completo terminado ==="
