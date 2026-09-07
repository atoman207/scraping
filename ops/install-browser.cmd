@echo off
REM Download the browser Playwright needs (Chromium).
REM npm install does NOT fetch it - this is a separate one-time download.
REM Re-run this if research fails with: Executable doesn't exist at ...

cd /d "%~dp0.."

echo Installing the Chromium build Playwright needs. This downloads ~500 MB.
echo.
call npx playwright install chromium
echo.
echo Verifying...
call npm run test:browser

pause
