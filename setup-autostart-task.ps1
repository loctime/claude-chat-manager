# Crea/actualiza la tarea programada que levanta Claude Chat Manager al iniciar sesión.
$ErrorActionPreference = "Stop"

$taskName = "ClaudeChatManager"
$wslExe   = "$env:WINDIR\System32\wsl.exe"
$argList  = "-d Ubuntu -u fernando -- bash -lc /mnt/c/Users/Fernando/Desktop/claude/claude-chat-manager/autostart.sh"

$action  = New-ScheduledTaskAction -Execute $wslExe -Argument $argList
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\fernando"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Output "Tarea '$taskName' creada/actualizada."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
