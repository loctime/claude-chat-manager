param(
  [Parameter(Mandatory = $true)][string]$EntryId,
  [Parameter(Mandatory = $true)][string]$DraftFile
)
$ErrorActionPreference = "Stop"
$body = [System.IO.File]::ReadAllText($DraftFile, [System.Text.Encoding]::UTF8)
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
$item = $namespace.GetItemFromID($EntryId)
if ($null -eq $item) { throw "No se encontró el correo en Outlook." }
$reply = $item.Reply()
$reply.Body = $body + "`r`n`r`n" + $reply.Body
$reply.Display($false)
