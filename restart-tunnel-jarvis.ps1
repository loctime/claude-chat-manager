# Reinicia solo el tunel de Jarvis via PM2 (migrado 2026-08-17 desde kill-by-PID).
# Corre como scheduled task "JarvisTunnelRestart" (/RL LIMITED).
$logFile = "$env:TEMP\jarvis-restart.log"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Set-Location $projectDir
$out = & $pm2 restart jarvis-tunnel 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $out -match "process or namespace not found") {
    Log "jarvis-tunnel no existia en pm2, arrancando desde ecosystem.win.config.js"
    & $pm2 start ecosystem.win.config.js --only jarvis-tunnel 2>&1 | Out-Null
} else {
    Log "tunnel restarted (pm2)"
}
