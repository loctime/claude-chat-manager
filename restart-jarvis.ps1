# Reinicia el server de Jarvis via PM2 (migrado 2026-08-17 desde kill-by-PID).
# Corre como scheduled task "JarvisRestart" (/RL LIMITED). Ya no necesita el
# ".bat" de Admin: "pm2 restart" mata su propio hijo, no pega con procesos
# de integridad mas alta/Session 0 (ver historia vieja mas abajo).
#
# Historia (ya no aplica, PM2 evita este problema): antes este script mataba
# por PID dueno del puerto 3777 y relanzaba node directo; si se mataba desde
# un contexto elevado el hijo heredaba integridad "High" y quedaba
# ilegible/inmatable para procesos normales.
#
# npm install antes de reiniciar (agregado 2026-08-21): un `git pull` que agrega
# una dependencia nueva a package.json NO corre npm install solo -- eso dejo a
# node_modules desincronizado y jarvis-server crasheaba en cada arranque
# (Cannot find module 'pdf-lib'), y "reiniciar" solo repetia el mismo crash.
# `npm install` sin flags es casi instantaneo si no hay nada que instalar, asi
# que correrlo siempre aca no tiene costo real.
$logFile = "$env:TEMP\jarvis-restart.log"
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$pm2 = "C:\Users\User\AppData\Roaming\npm\pm2.cmd"
$npm = "C:\Program Files\nodejs\npm.cmd"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Set-Location $projectDir

$npmOut = & $npm install --no-audit --no-fund 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Log "npm install fallo (seguimos igual, pm2 dira si el modulo sigue faltando): $npmOut"
} elseif ($npmOut -notmatch "up to date") {
    Log "npm install hizo cambios: $npmOut"
}

$out = & $pm2 restart jarvis-server 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $out -match "process or namespace not found") {
    Log "jarvis-server no existia en pm2, arrancando desde ecosystem.win.config.js"
    & $pm2 start ecosystem.win.config.js --only jarvis-server 2>&1 | Out-Null
} else {
    Log "restarted (pm2)"
}
