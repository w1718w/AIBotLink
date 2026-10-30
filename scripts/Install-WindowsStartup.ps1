$ErrorActionPreference = 'Stop'
$gatewayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $gatewayRoot '..'))
$launchScript = Join-Path $PSScriptRoot 'Start-Gateway.ps1'
$settingsScript = Join-Path $PSScriptRoot 'Open-Settings.ps1'
$powerShellPath = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launchScript + '"') -WorkingDirectory $gatewayRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AILinkBridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the local IM gateway at sign-in. DSH remains independently managed.' -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $workspaceRoot 'AILinkBridge Settings.lnk'))
$shortcut.TargetPath = $powerShellPath
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $settingsScript + '"'
$shortcut.WorkingDirectory = $gatewayRoot
$shortcut.Save()
Write-Output 'AILinkBridge sign-in task and settings shortcut registered.'
