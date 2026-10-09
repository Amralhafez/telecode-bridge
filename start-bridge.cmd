@echo off
REM Windows launcher — runs from this script's own folder, uses node from PATH.
cd /d "%~dp0"
if not exist logs mkdir logs
node src\index.js >> logs\bridge-task.log 2>&1
