# Reinicia solo el tunel cloudflared (no el server).
# Corre como scheduled task "JarvisTunnelRestart" a nivel NORMAL (/RL LIMITED), a proposito:
# asi el cloudflared que arranca aca siempre queda a integridad estandar, nunca elevada
# (mismo motivo que restart-jarvis.ps1 con el server: un proceso lanzado desde un .bat
# elevado hereda integridad "High" y despues nada sin elevar lo puede volver a matar).
# El .bat de admin en el Desktop mata los cloudflared viejos (elevado, best-effort) y
# despues dispara esta tarea para levantar uno nuevo ya a integridad normal.
$logFile = "$env:TEMP\jarvis-tunnel-restart.log"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $_.Id -ErrorAction SilentlyContinue) {
        Log "NO SE PUDO matar cloudflared pid $($_.Id) (probablemente integridad mas alta que esta tarea)"
    } else {
        Log "killed cloudflared pid $($_.Id)"
    }
}

Start-Sleep -Seconds 1
Start-Process -FilePath "cloudflared" -ArgumentList "tunnel","run" -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\jarvis-tunnel.log" -RedirectStandardError "$env:TEMP\jarvis-tunnel-err.log"

Log "restarted"
