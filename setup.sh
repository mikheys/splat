#!/bin/bash
# 3D Viewer — Setup & Installation Guide
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "╔═══════════════════════════════════════════════════╗"
echo "║      3D Viewer — Image → 3D Setup               ║"
echo "║  InstantMesh + LGM Gaussian Splats              ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# ── Check CUDA ─────────────────────────────────────
echo "🔍 Checking system..."
HAS_CUDA=false
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true
  if python3 -c "import torch; print(f'✓ Torch {torch.__version__}'); print(f'✓ CUDA: {torch.cuda.is_available()}'); print(f'✓ GPU: {torch.cuda.get_device_name(0)}')" 2>/dev/null; then
    HAS_CUDA=true
  fi
fi

if [ "$HAS_CUDA" = false ]; then
  echo "⚠️  CUDA/PyTorch не найдены. Для работы нужна NVIDIA GPU (рекомендуется RTX 4090)."
  echo "   Установи PyTorch: https://pytorch.org/get-started/locally/"
  echo "   Пример: pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126"
  echo ""
fi

# ── Python venv ──────────────────────────────────
VENV="$ROOT/backend/.venv"
if [ ! -d "$VENV" ]; then
  echo "📦 Creating Python virtual environment..."
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"

# ── Install API deps ─────────────────────────────
echo "📥 Installing API server dependencies..."
pip install -q --upgrade pip
pip install -q -r "$ROOT/backend/requirements_api.txt"

# ── Install InstantMesh deps ─────────────────────
echo "📥 Installing InstantMesh dependencies..."
if [ -f "$ROOT/backend/instantmesh/requirements.txt" ]; then
  pip install -q -r "$ROOT/backend/instantmesh/requirements.txt" \
    || echo "⚠️  Некоторые зависимости InstantMesh не установились (возможно, нужен CUDA)"
fi

# ── Install LGM deps ─────────────────────────────
echo "📥 Installing LGM dependencies..."
if [ -f "$ROOT/backend/lgm/requirements.txt" ]; then
  pip install -q -r "$ROOT/backend/lgm/requirements.txt" \
    || echo "⚠️  Некоторые зависимости LGM не установились"
fi
# nvdiffrast может не собраться без CUDA — это нормально на N100
pip install -q kiui xatlas roma 2>/dev/null || true

# ── Download model weights ────────────────────────
echo "📥 Downloading model weights (first run only)..."
python3 -c "
from huggingface_hub import hf_hub_download
import os

# InstantMesh
print('  → InstantMesh: instant-mesh-large.ckpt')
try:
    hf_hub_download('TencentARC/InstantMesh', 'instant_mesh_large.ckpt', cache_dir=os.path.expanduser('~/.cache/huggingface/hub'))
    print('  ✓ Done')
except Exception as e:
    print(f'  ⚠️ {e}')

# Diffusion model for InstantMesh
print('  → InstantMesh: diffusion_pytorch_model.bin')
try:
    hf_hub_download('TencentARC/InstantMesh', 'diffusion_pytorch_model.bin', cache_dir=os.path.expanduser('~/.cache/huggingface/hub'))
    print('  ✓ Done')
except Exception as e:
    print(f'  ⚠️ {e}')

# LGM
print('  → LGM: model.safetensors (from ashawkey/LGM)')
try:
    hf_hub_download('ashawkey/LGM', 'model_lgm_fp16.safetensors', cache_dir=os.path.expanduser('~/.cache/huggingface/hub'))
    print('  ✓ Done')
except Exception as e:
    print(f'  ⚠️ {e}')
" 2>/dev/null || echo "⚠️  HuggingFace Hub download failed (will auto-download on first run)"

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 Запуск:  ./start.sh"
echo "   Открой:   http://localhost:8000"
echo ""
echo "📋 Требования:"
echo "   • NVIDIA GPU с 10+ GB VRAM (рекомендуется RTX 4090)"
echo "   • CUDA 12.1+ и torch с CUDA"
echo "   • Python 3.10+"
echo ""
echo "⚙️  Если на Windows — запускай через WSL2 или используй Docker"
