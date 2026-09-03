@echo off
chcp 65001 > nul
title 転売リサーチツール - 自動起動の登録
cd /d "%~dp0"

REM VPSの再起動後も自動で動くよう、タスクスケジューラに登録する。
REM ※ 管理者権限で実行してください(右クリック →「管理者として実行」)。

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo このファイルは「管理者として実行」してください。
  echo   右クリック →「管理者として実行」
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  タスクスケジューラに登録します
echo    1. TenbaiApp     … 画面(Next.js)     ログオン時に起動
echo    2. TenbaiWorker  … ワーカー          ログオン時に起動
echo    3. TenbaiBackup  … DBバックアップ    毎日 4:00
echo ============================================================
echo.

schtasks /create /tn "TenbaiApp" /tr "\"%~dp0start-app.cmd\"" /sc onlogon /rl HIGHEST /f
schtasks /create /tn "TenbaiWorker" /tr "\"%~dp0start-worker.cmd\"" /sc onlogon /rl HIGHEST /f
schtasks /create /tn "TenbaiBackup" /tr "\"%~dp0backup.cmd\"" /sc daily /st 04:00 /rl HIGHEST /f

echo.
echo 登録しました。確認するには:
echo   schtasks /query /tn TenbaiApp
echo   schtasks /query /tn TenbaiWorker
echo   schtasks /query /tn TenbaiBackup
echo.
echo 解除するには:
echo   schtasks /delete /tn TenbaiApp /f
echo.
echo ※「ログオン時に起動」なので、VPSにログオンした状態を保つ必要があります。
echo    誰もログオンしていなくても動かしたい場合は、下の注意書きを読んでください。
echo.
echo   ログオン不要で動かすには /sc onstart に変えて、実行ユーザーとパスワードを
echo   指定する必要があります(ブラウザを使うワーカーは、この方式だと
echo   画面の無いセッションで動くため、headless のままなら問題ありません)。
echo     schtasks /create /tn "TenbaiWorker" /tr "..." /sc onstart /ru "%USERDOMAIN%\%USERNAME%" /rp * /rl HIGHEST /f
echo.
pause
