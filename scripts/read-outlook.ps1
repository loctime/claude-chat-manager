param(
  [ValidateSet("20", "50", "100", "7d", "30d")]
  [string]$Choice = "20"
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
$inbox = $namespace.GetDefaultFolder(6)
$items = $inbox.Items
$items.Sort("[ReceivedTime]", $true)

$maxItems = if ($Choice.EndsWith("d")) { 10000 } else { [int]$Choice }
$cutoff = if ($Choice.EndsWith("d")) { (Get-Date).AddDays(-[int]$Choice.TrimEnd("d")) } else { $null }
$result = [System.Collections.Generic.List[object]]::new()

foreach ($item in $items) {
  if ($result.Count -ge $maxItems) { break }
  if ($null -eq $item -or $item.Class -ne 43) { continue }
  $received = [DateTime]$item.ReceivedTime
  if ($null -ne $cutoff -and $received -lt $cutoff) { break }

  $senderEmail = ""
  try {
    if ($item.SenderEmailType -eq "EX") {
      $exchangeUser = $item.Sender.GetExchangeUser()
      if ($null -ne $exchangeUser) { $senderEmail = $exchangeUser.PrimarySmtpAddress }
      if ([string]::IsNullOrWhiteSpace($senderEmail)) {
        $senderEmail = $item.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x39FE001E")
      }
    } else { $senderEmail = $item.SenderEmailAddress }
  } catch { $senderEmail = $item.SenderEmailAddress }

  $body = [string]$item.Body
  if ($body.Length -gt 10000) { $body = $body.Substring(0, 10000) }
  $preview = ($body -replace "\s+", " ").Trim()
  if ($preview.Length -gt 500) { $preview = $preview.Substring(0, 500) }
  $internetMessageId = $null
  try { $internetMessageId = [string]$item.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x1035001E") } catch {}
  $subject = [string]$item.Subject
  if ([string]::IsNullOrWhiteSpace($subject)) { $subject = "(Sin asunto)" }
  $senderName = [string]$item.SenderName
  if ([string]::IsNullOrWhiteSpace($senderName)) { $senderName = "Sin remitente" }
  $importance = "normal"
  if ($item.Importance -eq 2) { $importance = "high" }
  if ($item.Importance -eq 0) { $importance = "low" }

  $result.Add([PSCustomObject]@{
    id = [string]$item.EntryID
    internetMessageId = $internetMessageId
    subject = $subject
    senderName = $senderName
    senderEmail = [string]$senderEmail
    receivedDateTime = $received.ToUniversalTime().ToString("o")
    bodyPreview = $preview
    body = $body
    hasAttachments = $item.Attachments.Count -gt 0
    importance = $importance
  })
}

@($result) | ConvertTo-Json -Depth 4 -Compress
