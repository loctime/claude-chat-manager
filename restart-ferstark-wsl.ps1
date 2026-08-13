# Reinicia el server de FerStark para que tome codigo nuevo.
#
# A diferencia de restart-jarvis.ps1 (que es de Diego, para SU instancia
# nativa de Windows "J.A.R.V.I.S"), FerStark corre DENTRO de WSL como
# proceso Linux -- ver Tarea Programada de Windows "ClaudeChatManager"
# (trigger "at logon" -> wsl.exe -> autostart.sh). No usar Get-NetTCPConnection
# ni Stop-Process desde PowerShell nativo para esto: el proceso vive en el
# namespace de red de la VM de WSL2 y Windows no lo ve como dueno del
# puerto, asi que "matarlo" desde este lado no encuentra nada y terminaria
# levantando un SEGUNDO server nativo de Windows en paralelo al de WSL
# (conflicto de puerto / dos instancias vivas a la vez). En cambio,
# delegamos el kill y el restart adentro de la misma WSL via wsl.exe.
#
# El tunel Cloudflare ("ferstark", proceso cloudflared separado) NO se
# toca aca -- este script es solo para el server de Node.

$wslDistro = "Ubuntu"
$wslUser = "fernando"
$autostartPath = "/mnt/c/Users/Fernando/Desktop/claude/claude-chat-manager/autostart.sh"
$logFile = "$env:TEMP\ferstark-restart.log"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Log "matando server viejo (WSL)..."
wsl.exe -d $wslDistro -u $wslUser -- bash -lc "pkill -f 'node src/server.js' && echo killed || echo 'no habia nada corriendo'" |
    ForEach-Object { Log $_ }

Start-Sleep -Seconds 2

Log "levantando server nuevo via autostart.sh..."
wsl.exe -d $wslDistro -u $wslUser -- bash -lc "bash '$autostartPath'"

Start-Sleep -Seconds 2
$ok = wsl.exe -d $wslDistro -u $wslUser -- bash -lc "pgrep -f 'node src/server.js' >/dev/null && echo UP || echo DOWN"
Log "estado final: $ok"
Write-Host "FerStark: $ok (log completo en $logFile)"
