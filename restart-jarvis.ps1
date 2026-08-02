# Reinicia solo el server de Jarvis (no el tunnel) para que tome codigo nuevo.
# Corre como scheduled task "JarvisRestart" a nivel NORMAL (/RL LIMITED), a proposito:
# asi el node.exe que arranca aca siempre queda a integridad estandar, nunca elevada.
# Esto importa porque si alguna vez se mata el proceso desde un contexto elevado (ej.
# "Reiniciar Jarvis (Admin).bat"), el hijo hereda integridad "High" y despues ni esta
# tarea ni un Stop-Process normal lo pueden volver a matar ("Acceso denegado" aunque
# sea el mismo usuario), por eso ese .bat delega el arranque aca en vez de lanzar
# node directamente. Vale tambien el motivo original: el proceso puede terminar en
# Session 0, donde un Stop-Process interactivo normal (Session 1) da "Acceso denegado".
#
# Nota: este archivo debe ser puro ASCII. Un guion largo metido sin querer en un
# string rompio el parseo de PowerShell 5.1 (sin BOM UTF-8 no lo banca) y dejo esta
# tarea fallando en silencio durante un rato el 2026-07-26.
$projectDir = "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
$logFile = "$env:TEMP\jarvis-restart.log"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

# Identificamos por quien tiene el puerto 3777 escuchando (no por nombre/CommandLine,
# que puede ser ilegible via WMI para procesos en Session 0 o de integridad distinta).
$listeners = Get-NetTCPConnection -LocalPort 3777 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $listeners) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
        Log "NO SE PUDO matar pid $procId (sigue vivo, probablemente integridad mas alta que esta tarea; hace falta el bat de Admin)"
    } else {
        Log "killed pid $procId (dueno del puerto 3777)"
    }
}
if (-not $listeners) { Log "nada escuchaba en 3777 (igual arranco uno nuevo)" }

Start-Sleep -Seconds 2
Set-Location $projectDir
Start-Process -FilePath "node" -ArgumentList "src\server.js" -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\jarvis-server.log" -RedirectStandardError "$env:TEMP\jarvis-server-err.log"

Log "restarted"
