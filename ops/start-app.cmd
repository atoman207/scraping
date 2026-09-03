@echo off
chcp 65001 > nul
title 転売リサーチツール - 画面(Next.js)
cd /d "%~dp0.."

echo ============================================================
echo  画面(Next.js)を起動します
echo  停止するには、このウィンドウで Ctrl+C を押してください
echo ============================================================
echo.

REM 本番用にビルドしてから起動する。
REM ビルド済みで起動だけしたいときは、下の npm run build の行を REM でコメントアウトする。
call npm run build
if errorlevel 1 (
  echo.
  echo ビルドに失敗しました。上のエラーを確認してください。
  pause
  exit /b 1
)

REM PORT を変えたいときは、この行の 3000 を書き換える
set PORT=3000
call npm run start

pause
