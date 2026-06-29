#!/bin/bash
# 3D Viewer — Quick Start
set -e

cd "$(dirname "$0")"
ROOT="$PWD"

echo "╔═══════════════════════════════════════════╗"
echo "║       3D Viewer — Image to 3D            ║"
echo "╚═══════════════════════════════════════════╝"

# ── Python env ──────────────────────────────────
VENV="$ROOT/backend/.venv"
if [ ! -d "$VENV" ]; then
  echo "📦 Creating virtualenv..."
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"

# ── Install deps ────────────────────────────────
echo "📥 Installing API server deps..."
pip install -q -r "$ROOT/backend/requirements_api.txt" 2>/dev/null

echo "📥 Installing InstantMesh deps..."
pip install -q -r "$ROOT/backend/instantmesh/requirements.txt" 2>/dev/null || echo "  (continuing)"

echo "📥 Installing LGM deps..."
cd "$ROOT/backend/lgm"
pip install -q -e . 2>/dev/null || pip install -q torch torchvision xformers nvdiffrast kiui rembg imageio scipy 2>/dev/null
cd "$ROOT"

# ── Check CUDA ──────────────────────────────────
python3 -c "import torch; print(f'  Torch {torch.__version__} | CUDA: {torch.cuda.is_available()} | GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')" 2>/dev/null || echo "  PyTorch not configured yet"

# ── Run ─────────────────────────────────────────
echo ""
echo "🚀 Starting server at http://localhost:8000"
echo ""
cd "$ROOT"
exec uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
