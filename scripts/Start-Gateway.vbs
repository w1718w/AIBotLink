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
script = fso.BuildPath(root, "Start-Gateway.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & script & """"
code = shell.Run(command, 0, True)
WScript.Quit code
