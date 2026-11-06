@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-issue189-epoch386-e2e.ps1"
if errorlevel 1 pause
