# Registra la tarea programada que corre el watchdog de la instancia de locti
# (puerto 3778) cada 5 minutos, nativamente como locti via S4U -- mismo mecanismo
# que ya usa la tarea "JarvisWatchdog" de la cuenta User.
#
# RunLevel Limited (NO Highest): locti no es miembro del grupo Administradores
# de esta PC (verificado el 2026-09-12), y Register-ScheduledTask devuelve
# "Acceso denegado" al pedir RunLevel Highest para un principal que no es admin
# -- no hay privilegio maximo que otorgarle. La limpieza de zombies de Session 0
# la sigue cubriendo el JarvisWatchdog de User (que si es admin); este watchdog
# solo chequea el puerto 3778 y relanza si hace falta.
#
# No requiere la contrasena de locti (S4U no la necesita) ni que locti este
# logueado -- corre igual, este su sesion conectada, desconectada o deslogueada.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$taskName   = "JarvisLocti-Watchdog"
$scriptPath = "C:\Users\locti\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1"

$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72)
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\locti" -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Output "Tarea '$taskName' registrada: corre cada 5 min como locti, RunLevel Limited."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Write-Output ""
Write-Output "Presione Enter para cerrar..."
Read-Host | Out-Null
