' Lanzado por la tarea programada "ClaudeChatManager" al iniciar sesion en Windows.
' Corre autostart.sh y despues deja un "sleep infinity" corriendo OCULTO dentro de WSL.
' Ese proceso cuenta como sesion activa y evita que WSL termine la distro Ubuntu
' (~60s despues de cerrarse la ultima ventana), que era lo que mataba FerStark y el tunel.
' Sin esto, FerStark solo funcionaba mientras claude.bat estuviera abierto.
Set ws = CreateObject("Wscript.Shell")
ws.Run "C:\WINDOWS\System32\wsl.exe -d Ubuntu -u fernando -- bash -lc ""/mnt/c/Users/Fernando/Desktop/claude/claude-chat-manager/autostart.sh; exec sleep infinity""", 0, False
