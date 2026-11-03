@echo off
rem Delta Desk watcher: double-click to install or update. Runs install-watcher.ps1 from this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-watcher.ps1"
pause
