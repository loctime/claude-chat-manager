param([Parameter(Mandatory = $true)][string]$EntryId)
$ErrorActionPreference = "Stop"
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
$item = $namespace.GetItemFromID($EntryId)
if ($null -eq $item) { throw "No se encontró el correo en Outlook." }
$item.Display($false)
