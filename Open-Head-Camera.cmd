@echo off
cd /d "%~dp0"
.conda\python.exe sim\server.py --gui --head-camera %*
if errorlevel 1 pause
