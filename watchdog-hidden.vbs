' Hidden launcher for the TeleCode watchdog (no console flash).
' Used by the Windows Task Scheduler entry. Runs node watchdog.js in this
' script's own folder, with the window hidden (0) and without waiting.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "node watchdog.js", 0, False
