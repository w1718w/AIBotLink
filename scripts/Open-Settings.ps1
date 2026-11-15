$ErrorActionPreference = 'Stop'
$settingsFile = Join-Path $env:LOCALAPPDATA 'AIBotLink/setup.json'
$launchScript = Join-Path $PSScriptRoot 'Start-Gateway.vbs'
$wscriptPath = Join-Path $env:WINDIR 'System32/wscript.exe'
function Get-SettingsUrl {
    if (-not (Test-Path -LiteralPath $settingsFile)) { return $null }
    try {
        $settingsRecord = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        if ($settingsRecord.version -ne 1 -or $settingsRecord.url -notmatch '^http://127\.0\.0\.1:[0-9]+/#[a-f0-9]{64}$') { return $null }
        Get-Process -Id $settingsRecord.pid -ErrorAction Stop | Out-Null
        return $settingsRecord.url
    } catch { return $null }
}
$settingsUrl = Get-SettingsUrl
if (-not $settingsUrl) {
    Start-Process -FilePath $wscriptPath -ArgumentList ('//nologo //B "' + $launchScript + '"') -WindowStyle Hidden | Out-Null
    for ($attempt = 0; $attempt -lt 40 -and -not $settingsUrl; $attempt++) {
        Start-Sleep -Milliseconds 250
        $settingsUrl = Get-SettingsUrl
    }
}
if (-not $settingsUrl) { throw 'The local settings page did not start. Check the logs in LocalAppData/AIBotLink.' }
Start-Process $settingsUrl
