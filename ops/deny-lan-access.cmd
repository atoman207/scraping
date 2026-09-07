@echo off
REM Remove the LAN access rule added by allow-lan-access.cmd.
REM All Japanese messages live in lan-access.ps1 - cmd.exe garbles UTF-8 text.
REM Run this as Administrator (right-click > Run as administrator).

set PORT=3000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lan-access.ps1" -Action deny -Port %PORT%

pause
