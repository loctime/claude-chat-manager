# Registra las dos tareas programadas de la instancia de locti
# (JarvisLocti-Watchdog cada 5 min, JarvisLocti al arranque) usando
# LogonType "Password" en vez de S4U.
#
# Por que Password y no S4U (descubierto el 2026-09-12, ver CLAUDE.local.md):
# registrar una tarea S4U para OTRA cuenta da "Acceso denegado" sin importar
# quien la registre (falta el privilegio de sistema SeTcbPrivilege, que ningun
# Administrador tiene por default). Se penso que la salida era que locti se
# registrara sus propias tareas S4U -- pero eso TAMBIEN dio "Acceso denegado"
# corriendo genuinamente como locti (confirmado con whoami + query session):
# registrar una tarea con LogonType S4U parece requerir que el proceso que
# registra este elevado, y locti no es miembro de Administradores, asi que
# nunca puede elevarse el mismo (no tiene credenciales de admin propias).
#
# Con LogonType Password, Windows guarda la contrasena cifrada (DPAPI, atada a
# esta maquina) dentro de la tarea -- el mecanismo estandar para que un admin
# arme una tarea que corra como otra cuenta. Requiere:
# - Correr ESTE script como User, ELEVADO ("Ejecutar como administrador").
# - Tipear la contrasena de Windows de locti una sola vez cuando la pida --
#   no se guarda en este archivo, ni en el repo, ni se le pasa a Claude.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Output "Este script necesita correr elevado. Cerra esta ventana y volve a abrirla con 'Ejecutar como administrador'."
    Read-Host "Presione Enter para cerrar"
    exit 1
}

$securePw = Read-Host -Prompt "Contrasena de Windows de locti" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw)
$plainPw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

try {
    # --- Tarea 1: JarvisLocti-Watchdog (cada 5 min) ---
    $watchdogScript = "C:\Users\locti\Proyectos\claude-chat-manager\jarvis-locti-watchdog.ps1"
    $action1   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`""
    $trigger1  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72)

    Register-ScheduledTask -TaskName "JarvisLocti-Watchdog" -Action $action1 -Trigger $trigger1 -Settings $settings1 -User "locti" -Password $plainPw -RunLevel Limited -Force | Out-Null
    Write-Output "JarvisLocti-Watchdog registrada."

    # --- Tarea 2: JarvisLocti (arranque) ---
    $projectDir = "C:\Users\locti\Proyectos\claude-chat-manager"
    $batPath    = Join-Path $projectDir "start-jarvis-locti.bat"
    $action2    = New-ScheduledTaskAction -Execute $batPath -WorkingDirectory $projectDir
    $trigger2   = New-ScheduledTaskTrigger -AtStartup
    $settings2  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName "JarvisLocti" -Action $action2 -Trigger $trigger2 -Settings $settings2 -User "locti" -Password $plainPw -RunLevel Limited -Force | Out-Null
    Write-Output "JarvisLocti registrada."
} finally {
    $plainPw = $null
}

Write-Output ""
Get-ScheduledTask -TaskName "JarvisLocti-Watchdog","JarvisLocti" | Select-Object TaskName, State
Write-Output ""
Write-Output "Presione Enter para cerrar..."
Read-Host | Out-Null
