' Windowless launcher for the sign-in task.
' Windows 11 uses Windows Terminal as the default console host, which ignores
' powershell.exe -WindowStyle Hidden and shows a console window at sign-in.
' wscript.exe has no console of its own, so Run(..., 0, True) starts the gateway
' hidden while the scheduled task still waits on it for failure restart.
Option Explicit
Dim shell, fso, root, script, command, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
script = "Start-Gateway.ps1"
If WScript.Arguments.Count = 1 Then
    If WScript.Arguments(0) = "settings" Then script = "Open-Settings.ps1"
End If
script = fso.BuildPath(root, script)
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """"
code = shell.Run(command, 0, True)
WScript.Quit code
