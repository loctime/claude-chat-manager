# Registra la tarea programada que corre el watchdog de la instancia de locti
# (puerto 3778) cada 5 minutos, nativamente como locti via S4U -- mismo mecanismo
# que ya usa la tarea "JarvisWatchdog" de la cuenta User. RunLevel Highest porque
# el watchdog necesita poder matar zombies de Session 0 (ver session0-cleanup.ps1).
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
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\locti" -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Output "Tarea '$taskName' registrada: corre cada 5 min como locti, RunLevel Highest."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Write-Output ""
Write-Output "Presione Enter para cerrar..."
Read-Host | Out-Null
