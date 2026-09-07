@echo off
REM Set up a permanent public hostname via Cloudflare Tunnel.
REM Requires a Cloudflare account and a domain already using Cloudflare nameservers.
REM All Japanese messages live in cloudflare-tunnel.ps1 - cmd.exe garbles UTF-8 text.

set PORT=3000
set /p HOSTNAME=Hostname to publish (e.g. tenbai.example.com): 
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloudflare-tunnel.ps1" -Action setup -Port %PORT% -Hostname %HOSTNAME%

pause
