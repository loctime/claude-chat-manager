# Mata procesos node.exe/cloudflared.exe huerfanos en Session 0 (CommandLine
# ilegible desde WMI) -- Session 0 nunca es una sesion interactiva legitima de
# ninguna cuenta de esta PC, asi que es seguro barrerla desde cualquiera de las
# dos (User o locti). Ver CLAUDE.local.md, "Root cause del EPERM de PM2
# identificado" (2026-09-09) para el contexto completo del hallazgo.
#
# Extraido de jarvis-watchdog.ps1 el 2026-09-12 para poder reusarlo desde
# jarvis-locti-watchdog.ps1 sin duplicar la logica de elevacion.
#
# Requiere que esta PC tenga UAC en "elevar sin preguntar"
# (ConsentPromptBehaviorAdmin=0) para que la elevacion sea silenciosa.

function Repair-SessionZeroZombies {
    param(
        [string[]]$ProcessNames = @('node.exe', 'cloudflared.exe')
    )

    $suspects = @()
    foreach ($name in $ProcessNames) {
        $suspects += Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
            Where-Object { $_.SessionId -eq 0 -and [string]::IsNullOrEmpty($_.CommandLine) }
    }

    if ($suspects.Count -eq 0) { return @() }

    $targetPids = ($suspects | Select-Object -ExpandProperty ProcessId) -join ','
    $marker = "$env:TEMP\session0-cleanup-elevated-kill.txt"
    Remove-Item $marker -ErrorAction SilentlyContinue
    $killScriptPath = "$env:TEMP\session0-cleanup-elevated-kill.ps1"
    @"
`$targetPids = '$targetPids' -split ','
foreach (`$p in `$targetPids) {
    try {
        Stop-Process -Id `$p -Force -ErrorAction Stop
        "PID `$p matado" | Out-File -FilePath '$marker' -Append
    } catch {
        "PID `$p fallo: `$(`$_.Exception.Message)" | Out-File -FilePath '$marker' -Append
    }
}
"@ | Out-File -FilePath $killScriptPath -Encoding utf8 -Force

    try {
        Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$killScriptPath`"" -ErrorAction Stop
    } catch {
        return @()
    }

    Start-Sleep -Seconds 5
    if (Test-Path $marker) {
        return @(Get-Content $marker)
    }
    return @()
}
