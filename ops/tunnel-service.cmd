@echo off
REM Run the named tunnel as a Windows service. Run as Administrator.
REM All Japanese messages live in cloudflare-tunnel.ps1 - cmd.exe garbles UTF-8 text.

set PORT=3000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloudflare-tunnel.ps1" -Action service-install -Port %PORT%

pause
