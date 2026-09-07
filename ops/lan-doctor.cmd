@echo off
REM Diagnose why other devices cannot reach the dashboard.
REM All Japanese messages live in lan-access.ps1 - cmd.exe garbles UTF-8 text.
REM Admin rights are not required for this one.

set PORT=3000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lan-access.ps1" -Action doctor -Port %PORT%

pause
