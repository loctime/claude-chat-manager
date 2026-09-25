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
#
# -WindowStyle Hidden en el Start-Process de abajo (agregado 2026-09-17): sin
# esto, cada vez que el watchdog repara zombies aparece un flash de terminal
# visible en el escritorio de Diego -- pasaba inadvertido mientras el chequeo
# de salud tenia el bug que casi nunca disparaba esta rama (ver CLAUDE.local.md,
# "Automatizacion real del playbook"); al arreglar ese chequeo la reparacion
# empezo a dispararse seguido y el flash se volvio visible/molesto.
#
# Exclusion del puerto 3778 (agregado 2026-09-17, ver CLAUDE.local.md "Pista real
# sobre el origen de los zombies de Session 0"): el proceso node.exe legitimo de
# la instancia de locti corre en Session 0 con CommandLine ilegible via WMI desde
# User -- exactamente la misma firma que un zombie real. Sin esta exclusion, este
# script puede matar por error el server de locti en vez de (o ademas de) un
# zombie de verdad. Se excluye por PID el proceso que en el momento de correr
# tiene el puerto 3778 escuchando, no por nombre/cuenta (mas robusto: sigue
# aplicando aunque locti cambie de puerto o el owner no se pueda leer).

function Repair-SessionZeroZombies {
    param(
        [string[]]$ProcessNames = @('node.exe', 'cloudflared.exe')
    )

    $lockedPorts = @(3778)
    $protectedPids = @()
    foreach ($p in $lockedPorts) {
        $protectedPids += Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess
    }

    # No se filtra mas por "SessionId -eq 0": el 2026-09-18 se confirmo dos veces
    # seguidas (mismo dia, menos de 15 min de diferencia) que el zombie real tenia
    # CommandLine/owner en blanco pero esta condicion no matcheaba -- de ahi que
    # el watchdog logueara "no se encontraron procesos Session 0 sospechosos"
    # mientras un zombie real segia vivo y se pudo matar a mano sin chequear su
    # SessionId. Verificado el mismo dia que TODOS los procesos node.exe/
    # cloudflared.exe legitimos de esta cuenta devuelven CommandLine no vacio via
    # CIM (misma sesion que quien consulta) -- CommandLine vacio ya es sospechoso
    # por si solo, sin necesitar ademas SessionId=0.
    $suspects = @()
    foreach ($name in $ProcessNames) {
        $suspects += Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
            Where-Object { [string]::IsNullOrEmpty($_.CommandLine) -and $protectedPids -notcontains $_.ProcessId }
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
        Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$killScriptPath`"" -ErrorAction Stop
    } catch {
        return @()
    }

    Start-Sleep -Seconds 5
    if (Test-Path $marker) {
        return @(Get-Content $marker)
    }
    return @()
}
