@echo off
REM Check whether the custom domain is wired up to this VPS through Cloudflare Tunnel.
REM All Japanese messages live in cloudflare-tunnel.ps1 - cmd.exe garbles UTF-8 text.

set /p HOSTNAME=Hostname to check (e.g. tenbai.a-step1.com): 
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloudflare-tunnel.ps1" -Action domain -Hostname %HOSTNAME%

pause
