$ErrorActionPreference = 'Stop'
$gatewayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entryPoint = Join-Path $gatewayRoot 'dist/main.js'
if (-not (Test-Path -LiteralPath $entryPoint)) { throw 'Build the gateway before starting it.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'AIBotLink'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outputLog = Join-Path $runtimeDirectory "gateway-$logStamp.out.log"
$errorLog = Join-Path $runtimeDirectory "gateway-$logStamp.err.log"
# Keep ownership of this exact child. The scheduled task waits for it and may
# restart a failed gateway; it never searches for or kills other Node processes.
$gatewayProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + $entryPoint + '"') -WorkingDirectory $gatewayRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru -Wait
exit $gatewayProcess.ExitCode
