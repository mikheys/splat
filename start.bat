@echo off
chcp 65001 >nul
title 3D Viewer

cd /d "%~dp0"

REM ── Проверка venv ─────────────────────────
if not exist ".venv\" (
    echo [WARN] Окружение не найдено. Запусти setup.bat сначала.
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat

REM ── Создание папок ────────────────────────
if not exist "data\uploads\" mkdir data\uploads
if not exist "data\outputs\" mkdir data\outputs

REM ── Запуск ────────────────────────────────
echo.
echo ╔══════════════════════════════════════════╗
echo ║   3D Viewer — http://localhost:8080     ║
echo ╚══════════════════════════════════════════╝
echo.

python -m uvicorn backend.main:app --host 0.0.0.0 --port 8080 --log-level info

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Сервер остановился с ошибкой.
    pause
)
