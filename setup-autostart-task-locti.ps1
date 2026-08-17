# Crea/actualiza la tarea programada que levanta esta instancia de Jarvis (usuario locti, puerto 3778)
# al ARRANCAR WINDOWS, sin necesitar que nadie inicie sesion en el perfil locti (trigger AtStartup +
# logon type S4U). Esto requiere admin para registrarse (a diferencia de la version AtLogOn, que no).
#
# RunLevel Limited a proposito (no "Highest"): un proceso lanzado desde una tarea elevada hereda
# integridad "High" y despues nada sin elevar lo puede volver a matar (mismo motivo documentado en
# restart-jarvis.ps1 de este repo). S4U con RunLevel Limited corre como locti a integridad normal,
# aunque la tarea en si se haya REGISTRADO con admin.

$ErrorActionPreference = "Stop"

# Auto-elevar si no estamos como admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$taskName   = "JarvisLocti"
$projectDir = "C:\Users\locti\OneDrive\Desktop\Proyectos\claude-chat-manager"
$batPath    = Join-Path $projectDir "start-jarvis.bat"

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
