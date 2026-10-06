param(
  [string]$EntryId,
  [string]$To,
  [string]$Subject,
  [Parameter(Mandatory = $true)][string]$DraftFile
)
$ErrorActionPreference = "Stop"
$body = [System.IO.File]::ReadAllText($DraftFile, [System.Text.Encoding]::UTF8)
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")

if ($EntryId) {
  $item = $namespace.GetItemFromID($EntryId)
  if ($null -eq $item) { throw "No se encontró el correo en Outlook." }
  $mail = $item.Reply()
  $mail.Body = $body + "`r`n`r`n" + $mail.Body
} else {
  if (-not $To -or -not $Subject) { throw "Sin EntryId hacen falta -To y -Subject." }
  $mail = $outlook.CreateItem(0)
  $mail.To = $To
  $mail.Subject = $Subject
  $mail.Body = $body
}
$mail.Send()
