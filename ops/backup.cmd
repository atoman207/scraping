@echo off
chcp 65001 > nul
title 転売リサーチツール - DBバックアップ
cd /d "%~dp0.."

REM Supabaseの無料プランには自動バックアップが無いため、VPS内に控えを取る。
REM タスクスケジューラで毎日実行するように登録して使う(ops/install-services.cmd 参照)。

call npm run db:backup >> "%~dp0backup.log" 2>&1
if errorlevel 1 (
  echo [%date% %time%] バックアップに失敗しました >> "%~dp0backup.log"
  exit /b 1
)
echo [%date% %time%] バックアップ完了 >> "%~dp0backup.log"
