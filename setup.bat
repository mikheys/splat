@echo off
chcp 65001 >nul
title 3D Viewer — Setup

echo ╔══════════════════════════════════════════╗
echo ║   3D Viewer — Image to 3D               ║
echo ║   Установка зависимостей                ║
echo ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM ── 1. Проверка Python ─────────────────────
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python не найден! Установи Python 3.10+
    echo Скачать: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [1/6] ✓ Python найден
python --version

REM ── 2. Создание venv ────────────────────────
if not exist ".venv\" (
    echo [2/6] Создание виртуального окружения...
    python -m venv .venv
) else (
    echo [2/6] ✓ Виртуальное окружение уже есть
)

call .venv\Scripts\activate.bat

REM ── 3. Установка API зависимостей ───────────
echo [3/6] Установка API зависимостей...
pip install -q -r backend\requirements_api.txt

REM ── 4. Клонирование репозиториев движков ────
if not exist "backend\instantmesh\" (
    echo [4/6] Клонирование InstantMesh...
    git clone https://github.com/TencentARC/InstantMesh.git backend\instantmesh
) else (
    echo [4/6] ✓ InstantMesh уже склонирован
)

if not exist "backend\lgm\" (
    echo [4/6] Клонирование LGM...
    git clone https://github.com/3DTopia/LGM.git backend\lgm
) else (
    echo [4/6] ✓ LGM уже склонирован
)

REM ── 5. Установка зависимостей движков ───────
echo [5/6] Установка зависимостей движков...
echo   ⏳ Это может занять несколько минут...

REM PyTorch с CUDA
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126 2>nul

REM InstantMesh
if exist "backend\instantmesh\requirements.txt" (
    pip install -q -r backend\instantmesh\requirements.txt 2>nul
)

REM LGM
if exist "backend\lgm\requirements.txt" (
    pip install -q -r backend\lgm\requirements.txt 2>nul
)
pip install -q kiui xatlas roma 2>nul

REM ── 6. Скачивание весов моделей (если нет) ──
echo [6/6] Проверка весов моделей...

if not exist "data\ckpts\model_fp16.safetensors" (
    echo   ⏳ Скачивание LGM весов (830 MB)...
    python -c "from huggingface_hub import hf_hub_download; hf_hub_download('ashawkey/LGM', 'model_fp16.safetensors', local_dir='data/ckpts')" 2>nul
) else (
    echo   ✓ LGM веса уже есть
)

echo.
echo ────────────────────────────────────────────
echo ✅ Установка завершена!
echo.
echo Запуск сервера:  start.bat
echo Открыть:         http://localhost:8080
echo ────────────────────────────────────────────
echo.

pause
