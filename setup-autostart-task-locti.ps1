# Crea/actualiza la tarea programada que levanta esta instancia de Jarvis (usuario locti, puerto 3778)
# al ARRANCAR WINDOWS, sin necesitar que nadie inicie sesion en el perfil locti (trigger AtStartup +
# logon type S4U).
#
# RunLevel Limited a proposito (no "Highest"): un proceso lanzado desde una tarea elevada hereda
# integridad "High" y despues nada sin elevar lo puede volver a matar (mismo motivo documentado en
# restart-jarvis.ps1 de este repo). S4U con RunLevel Limited corre como locti a integridad normal.
#
# CORREGIDO 2026-09-12 -- este script se auto-elevaba ("requiere admin para registrarse", nota vieja
# de arriba), pero eso es exactamente lo que NO hay que hacer: S4U solo permite registrar una tarea
# para "uno mismo" sin privilegios especiales -- si otra cuenta (ej. User, elevada) intenta
# registrarla para locti, da "Acceso denegado" sin importar el RunLevel (falta el privilegio de
# sistema SeTcbPrivilege, que ningun Administrador tiene por default). Y locti tampoco puede
# completar la auto-elevacion el mismo -- no es miembro del grupo Administradores, asi que el intento
# le dispara un pedido real de credenciales de admin que no tiene. Esto probablemente explica por que
# la tarea "JarvisLocti" nunca llego a existir desde que se escribio este script (17/8). Correr esto
# DESDE la sesion de locti, SIN elevar.

$ErrorActionPreference = "Stop"

$taskName   = "JarvisLocti"
$projectDir = "C:\Users\locti\Proyectos\claude-chat-manager"
# NB: "start-jarvis-locti.bat", no "start-jarvis.bat" -- este ultimo es el
# generico (puerto 3777, sin el PORT=3778 fijado a mano). La tarea ya
# registrada apuntaba al -locti correcto; este script tenia el nombre
# viejo/equivocado y lo hubiera roto si se volvia a correr. Corregido de paso
# al migrar fuera de OneDrive (2026-08-17).
$batPath    = Join-Path $projectDir "start-jarvis-locti.bat"

$action    = New-ScheduledTaskAction -Execute $batPath -WorkingDirectory $projectDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\locti" -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Output "Tarea '$taskName' reconfigurada: arranca con Windows, sin necesitar login en locti."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Write-Output ""
Write-Output "Presione Enter para cerrar..."
Read-Host | Out-Null
