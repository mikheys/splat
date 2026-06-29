@echo off
chcp 65001 >nul
title 3D Viewer — Установка CUDA-зависимостей

cd /d "%~dp0"

echo ╔══════════════════════════════════════════════════════════════╗
echo ║    Установка CUDA-зависимостей для 3D Viewer              ║
echo ║    nvdiffrast + diff-gaussian-rasterization                ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

call .venv\Scripts\activate.bat

REM ── Проверка CUDA ──────────────────────────
echo [1/4] Проверка CUDA...
python -c "import torch; print(f'  PyTorch {torch.__version__}'); print(f'  CUDA: {torch.cuda.is_available()}'); print(f'  GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')" 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PyTorch с CUDA не найден!
    echo.
    echo Установи PyTorch с CUDA 12.1+:
    echo   pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
    echo.
    pause
    exit /b 1
)
echo.

REM ── Проверка Visual C++ ────────────────────
echo [2/4] Проверка Visual Studio Build Tools...
where cl.exe 2>nul >nul
if %errorlevel% equ 0 (
    echo   ✓ C++ компилятор найден
) else (
    echo   ⚠️ VS компилятор не найден. Нужен "Desktop development with C++"
    echo   https://visualstudio.microsoft.com/visual-cpp-build-tools/
)
echo.

REM ── Установка nvdiffrast ───────────────────
echo [3/4] Установка nvdiffrast...
echo   pip install --no-build-isolation git+https://github.com/NVlabs/nvdiffrast/
pip install --no-build-isolation git+https://github.com/NVlabs/nvdiffrast/ 2>&1
if %errorlevel% neq 0 (
    echo   ❌ Ошибка! nvdiffrast не установился
    echo.
    echo   Альтернатива — установить вручную:
    echo   1. Открой "Developer Command Prompt for VS 2022"
    echo   2. cd G:\projects\splat
    echo   3. .venv\Scripts\activate
    echo   4. pip install git+https://github.com/NVlabs/nvdiffrast/
    echo.
) else (
    echo   ✓ nvdiffrast установлен
)
echo.

REM ── Установка diff-gaussian-rasterization ──
echo [4/4] Установка diff-gaussian-rasterization...
echo   pip install --no-build-isolation git+https://github.com/ashawkey/diff-gaussian-rasterization/
pip install --no-build-isolation git+https://github.com/ashawkey/diff-gaussian-rasterization/ 2>&1
if %errorlevel% neq 0 (
    echo   ❌ Ошибка! diff-gaussian-rasterization не установился
    echo.
) else (
    echo   ✓ diff-gaussian-rasterization установлен
)
echo.

REM ── Итог ───────────────────────────────────
echo ──────────────────────────────────────────────────────────────
python -c "import nvdiffrast.torch" 2>nul
if %errorlevel% equ 0 (echo   [OK] nvdiffrast) else (echo   [FAIL] nvdiffrast)

python -c "from diff_gaussian_rasterization import GaussianRasterizationSettings" 2>nul
if %errorlevel% equ 0 (echo   [OK] diff-gaussian-rasterization) else (echo   [FAIL] diff-gaussian-rasterization)

echo.
echo Если есть FAIL — нужен Visual Studio Build Tools:
echo https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo.
pause
