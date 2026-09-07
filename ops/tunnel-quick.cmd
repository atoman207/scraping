@echo off
REM Publish a temporary public URL (no Cloudflare account needed).
REM All Japanese messages live in cloudflare-tunnel.ps1 - cmd.exe garbles UTF-8 text.

set PORT=3000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloudflare-tunnel.ps1" -Action quick -Port %PORT%

pause
