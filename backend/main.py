"""
3D Viewer Backend — Image to 3D Web App

FastAPI сервер с интеграцией:
  • InstantMesh  — одна фотка → текстурированный 3D mesh (.glb/.obj)
  • LGM          — одна фотка → 3D Gaussian Splatting (.ply) + видео

Run:  python main.py  или  uvicorn main:app
"""
import os, sys, json, uuid, time, asyncio, logging, subprocess, shutil, glob
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import aiofiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("3d-viewer")

# ── Paths ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
OUTPUTS = DATA / "outputs"
CKPTS   = DATA / "ckpts"
FRONTEND = ROOT / "frontend"
IM_REPO  = ROOT / "backend" / "instantmesh"
LGM_REPO = ROOT / "backend" / "lgm"

for d in [UPLOADS, OUTPUTS, CKPTS]:
    d.mkdir(parents=True, exist_ok=True)

# ── Task store (in-memory) ──────────────────────────────────────────────
tasks: dict[str, dict] = {}
ws_connections: dict[str, list[WebSocket]] = {}

async def ws_send(task_id: str, data: dict):
    for ws in ws_connections.get(task_id, []):
        try:
            await ws.send_json(data)
        except Exception:
            pass

# ── Weight auto-download ──────────────────────────────────────────────

def ensure_im_weights() -> tuple[Path, Path]:
    """Скачать/найти веса для InstantMesh. Сначала смотрит в data/ckpts/."""
    ckpt_files = list(CKPTS.glob("*instant_mesh*")) + list(CKPTS.glob("*ckpt"))
    unet_files = list(CKPTS.glob("*diffusion*"))
    
    if ckpt_files and unet_files:
        logger.info(f"✓ InstantMesh weights (local)")
        return ckpt_files[0], unet_files[0]
    
    from huggingface_hub import hf_hub_download
    hub = "TencentARC/InstantMesh"
    
    ckpt = Path(hf_hub_download(
        hub, "instant_mesh_large.ckpt",
        cache_dir=str(CKPTS.parent / ".cache" / "huggingface"),
    ))
    unet = Path(hf_hub_download(
        hub, "diffusion_pytorch_model.bin",
        cache_dir=str(CKPTS.parent / ".cache" / "huggingface"),
    ))
    logger.info(f"✓ InstantMesh weights ready")
    return ckpt, unet


def patch_instantmesh_nvdiffrast():
    """
    Патч mesh_util.py: делаем импорт nvdiffrast опциональным.
    Он нужен только для --export_texmap, который мы не используем.
    """
    target = IM_REPO / "src" / "utils" / "mesh_util.py"
    if not target.exists():
        logger.warning(f"mesh_util.py not found at {target}")
        return
    
    content = target.read_text()
    old_block = "import nvdiffrast.torch as dr\nfrom PIL import Image"
    new_block = (
        "from PIL import Image\n"
        "\n"
        "try:\n"
        "    import nvdiffrast.torch as dr\n"
        "except ImportError:\n"
        "    dr = None"
    )
    
    if old_block in content:
        content = content.replace(old_block, new_block)
        target.write_text(content)
        logger.info("✓ Patched mesh_util.py: nvdiffrast import is now optional")
    else:
        logger.info("→ mesh_util.py already patched")


def patch_lgm_gsplat():
    """
    Патч LGM core/gs.py: заменяет diff_gaussian_rasterization на gsplat.
    gsplat имеет готовые wheels под Windows.
    """
    target = LGM_REPO / "core" / "gs.py"
    if not target.exists():
        logger.warning(f"LGM gs.py not found at {target}")
        return
    
    # Check if already patched with correct API
    content = target.read_text()
    if "rasterize_to_pixels" in content:
        logger.info("→ LGM gs.py already patched for gsplat")
        return
    
    logger.info("✓ Patching LGM gs.py for gsplat...")
    # Write the patched version inline
    patched = '''import numpy as np

import torch
import torch.nn as nn
import torch.nn.functional as F

from core.options import Options

import kiui

try:
    from gsplat import rasterize_to_pixels as _gsplat_rasterize
    HAS_GSPLAT = True
except ImportError:
    _gsplat_rasterize = None
    HAS_GSPLAT = False


class GaussianRenderer:
    def __init__(self, opt: Options):
        
        self.opt = opt
        self.bg_color = torch.tensor([1, 1, 1], dtype=torch.float32, device="cuda")
        
        # gsplat uses intrinsics matrix K
        self.tan_half_fov = np.tan(0.5 * np.deg2rad(self.opt.fovy))
        self.focal = self.opt.output_size / (2 * self.tan_half_fov)
        
    def render(self, gaussians, cam_view, cam_view_proj, cam_pos, bg_color=None, scale_modifier=1):
        device = gaussians.device
        B, V = cam_view.shape[:2]
        H = W = self.opt.output_size

        K = torch.tensor([
            [self.focal, 0, W / 2],
            [0, self.focal, H / 2],
            [0, 0, 1],
        ], dtype=torch.float32, device=device)

        images = []
        alphas = []
        
        for b in range(B):
            means3D = gaussians[b, :, 0:3].contiguous().float()
            opacity = gaussians[b, :, 3:4].contiguous().float()
            scales = gaussians[b, :, 4:7].contiguous().float()
            rotations = gaussians[b, :, 7:11].contiguous().float()
            rgbs = gaussians[b, :, 11:].contiguous().float()

            for v in range(V):
                view_matrix = cam_view[b, v].float()
                bg = self.bg_color if bg_color is None else bg_color

                if HAS_GSPLAT:
                    render_colors, render_alphas, info = _gsplat_rasterize(
                        means3D, rotations, scales, opacity.squeeze(-1), rgbs,
                        view_matrix, K, W, H,
                        bg_color=bg, scale_modifier=scale_modifier,
                    )
                else:
                    # fallback using module-level import
                    render_colors, render_alphas, info = _gsplat_rasterize(
                        means3D, rotations, scales, opacity.squeeze(-1), rgbs,
                        view_matrix, K, W, H, bg_color=bg,
                    )

                rendered_image = render_colors.permute(2, 0, 1).clamp(0, 1)
                rendered_alpha = render_alphas.permute(2, 0, 1)
                images.append(rendered_image)
                alphas.append(rendered_alpha)

        images = torch.stack(images, dim=0).view(B, V, 3, H, W)
        alphas = torch.stack(alphas, dim=0).view(B, V, 1, H, W)
        return {"image": images, "alpha": alphas}

    def save_ply(self, gaussians, path, compatible=True):
        assert gaussians.shape[0] == 1
        from plyfile import PlyData, PlyElement
        means3D = gaussians[0, :, 0:3].contiguous().float()
        opacity = gaussians[0, :, 3:4].contiguous().float()
        scales = gaussians[0, :, 4:7].contiguous().float()
        rotations = gaussians[0, :, 7:11].contiguous().float()
        shs = gaussians[0, :, 11:].unsqueeze(1).contiguous().float()
        mask = opacity.squeeze(-1) >= 0.005
        means3D, opacity, scales, rotations, shs = [x[mask] for x in (means3D, opacity, scales, rotations, shs)]
        if compatible:
            opacity = kiui.op.inverse_sigmoid(opacity)
            scales = torch.log(scales + 1e-8)
            shs = (shs - 0.5) / 0.28209479177387814
        xyzs = means3D.detach().cpu().numpy()
        f_dc = shs.detach().transpose(1, 2).flatten(start_dim=1).contiguous().cpu().numpy()
        opacities = opacity.detach().cpu().numpy()
        scales = scales.detach().cpu().numpy()
        rotations = rotations.detach().cpu().numpy()
        l = ['x', 'y', 'z'] + ['f_dc_{}'.format(i) for i in range(f_dc.shape[1])] + ['opacity'] + ['scale_{}'.format(i) for i in range(scales.shape[1])] + ['rot_{}'.format(i) for i in range(rotations.shape[1])]
        dtype_full = [(a, 'f4') for a in l]
        elements = np.empty(xyzs.shape[0], dtype=dtype_full)
        attributes = np.concatenate((xyzs, f_dc, opacities, scales, rotations), axis=1)
        elements[:] = list(map(tuple, attributes))
        PlyData([PlyElement.describe(elements, 'vertex')]).write(path)
    
    def load_ply(self, path, compatible=True):
        from plyfile import PlyData, PlyElement
        plydata = PlyData.read(path)
        xyz = np.stack([np.asarray(plydata.elements[0][a]) for a in ['x','y','z']], axis=1)
        opacities = np.asarray(plydata.elements[0]['opacity'])[..., np.newaxis]
        shs = np.zeros((xyz.shape[0], 3))
        for i in range(3):
            shs[:, i] = np.asarray(plydata.elements[0][f'f_dc_{i}'])
        scale_names = [p.name for p in plydata.elements[0].properties if p.name.startswith('scale_')]
        scales = np.zeros((xyz.shape[0], len(scale_names)))
        for idx, n in enumerate(scale_names):
            scales[:, idx] = np.asarray(plydata.elements[0][n])
        rot_names = [p.name for p in plydata.elements[0].properties if p.name.startswith('rot_')]
        rots = np.zeros((xyz.shape[0], len(rot_names)))
        for idx, n in enumerate(rot_names):
            rots[:, idx] = np.asarray(plydata.elements[0][n])
        gaussians = torch.from_numpy(np.concatenate([xyz, opacities, scales, rots, shs], axis=1)).float()
        if compatible:
            gaussians[..., 3:4] = torch.sigmoid(gaussians[..., 3:4])
            gaussians[..., 4:7] = torch.exp(gaussians[..., 4:7])
            gaussians[..., 11:] = 0.28209479177387814 * gaussians[..., 11:] + 0.5
        return gaussians
'''
    target.write_text(patched)
    logger.info("✓ Patched LGM gs.py for gsplat")

def patch_lgm_infer():
    """Revert trust_remote_code=True in infer.py (snapshot patching handles it)."""
    target = LGM_REPO / "infer.py"
    if not target.exists():
        return
    content = target.read_text()
    if "trust_remote_code=False" not in content:
        logger.info("→ infer.py already has trust_remote_code=True")
        return
    content = content.replace("trust_remote_code=False", "trust_remote_code=True")
    target.write_text(content)
    logger.info("✓ Reverted infer.py: trust_remote_code=True (snapshot patched instead)")

def patch_lgm_xformers():
    """Make xformers optional in mv_unet.py + hub cache copy."""
    # Patch local copy
    target = LGM_REPO / "mvdream" / "mv_unet.py"
    if target.exists():
        _patch_mv_unet_file(target)
    
    # Patch hub cache copy (used by diffusers with trust_remote_code)
    import glob
    hub_pattern = os.path.expanduser("~/.cache/huggingface/modules/diffusers_modules/local/mv_unet.py")
    for cached in glob.glob(hub_pattern.replace("mv_unet.py", "*mv_unet*")):
        p = Path(cached)
        if p.is_file() and "HAS_XFORMERS" not in p.read_text():
            _patch_mv_unet_file(p)
            logger.info(f"✓ Patched hub cache: {p}")


def _patch_mv_unet_file(target: Path):
    """Apply xformers-free patch to a single mv_unet.py file."""
    content = target.read_text()
    if "HAS_XFORMERS" in content:
        logger.info(f"→ Already patched: {target.name}")
        return
    
    old_import = "# require xformers!\nimport xformers\nimport xformers.ops"
    new_import = (
        "# xformers (optional)\n"
        "try:\n"
        "    import xformers\n"
        "    import xformers.ops\n"
        "    HAS_XFORMERS = True\n"
        "except ImportError:\n"
        "    HAS_XFORMERS = False"
    )
    content = content.replace(old_import, new_import)
    
    # Replace attention calls
    old_attn = "out = xformers.ops.memory_efficient_attention(\n            q, k, v, attn_bias=None, op=self.attention_op\n        )"
    new_attn = "if HAS_XFORMERS:\n            out = xformers.ops.memory_efficient_attention(\n                q, k, v, attn_bias=None, op=self.attention_op\n            )\n        else:\n            out = F.scaled_dot_product_attention(q, k, v)\n            out = out.reshape(b * self.heads, -1, self.dim_head)"
    content = content.replace(old_attn, new_attn)
    
    old_attn2 = "out_ip = xformers.ops.memory_efficient_attention(\n                q, k_ip, v_ip, attn_bias=None, op=self.attention_op\n            )"
    new_attn2 = "if HAS_XFORMERS:\n                out_ip = xformers.ops.memory_efficient_attention(\n                    q, k_ip, v_ip, attn_bias=None, op=self.attention_op\n                )\n            else:\n                out_ip = F.scaled_dot_product_attention(q, k_ip, v_ip)\n                out_ip = out_ip.reshape(b * self.heads, -1, self.dim_head)"
    content = content.replace(old_attn2, new_attn2)
    
    target.write_text(content)
    logger.info(f"✓ Patched: {target.name}")

def ensure_lgm_weights() -> Path:
    """Скачать/найти веса для LGM. Сначала смотрит в data/ckpts/."""
    local = CKPTS / "model_fp16.safetensors"
    if local.exists():
        logger.info(f"✓ LGM weights (local): {local}")
        return local
    from huggingface_hub import hf_hub_download
    ckpt = Path(hf_hub_download(
        "ashawkey/LGM", "model_fp16.safetensors",
        cache_dir=str(CKPTS.parent / ".cache" / "huggingface"),
    ))
    logger.info(f"✓ LGM weights ready: {ckpt}")
    return ckpt


def find_python():
    """Найти правильный Python (с CUDA)."""
    # Try venv first
    venv = ROOT / "backend" / ".venv"
    if (venv / "bin" / "python").exists():
        return str(venv / "bin" / "python")
    return sys.executable


# ── Engine Runners (subprocess) ───────────────────────────────────────

def run_instantmesh(image_path: str, output_dir: str, task_id: str) -> dict:
    """Запустить InstantMesh через subprocess."""
    config = IM_REPO / "configs" / "instant-mesh-large.yaml"
    python = find_python()
    
    # FIX: InstantMesh run.py requires positional args: config + input_path
    cmd = [
        python, str(IM_REPO / "run.py"),
        str(config),
        image_path,
        "--output_path", output_dir,
        "--diffusion_steps", "75",
        "--no_rembg",  # фон удалён фронтендом
    ]
    
    logger.info(f"🚀 InstantMesh: {' '.join(cmd)}")
    
    proc = subprocess.run(
        cmd, cwd=str(IM_REPO),
        capture_output=True, text=True,
        timeout=600,
    )
    
    if proc.returncode != 0:
        logger.error(f"InstantMesh stderr:\n{proc.stderr}")
        raise RuntimeError(f"InstantMesh failed: {proc.stderr[-500:]}")
    
    # Найти результаты
    results = {"glb": None, "obj": None, "preview": None}
    
    # InstantMesh создаёт outputs/<config_name>/meshes/
    for mesh_dir in Path(output_dir).rglob("meshes"):
        for f in mesh_dir.iterdir():
            if f.suffix == ".glb":
                results["glb"] = str(f)
            elif f.suffix == ".obj":
                results["obj"] = str(f)
    
    # Preview image
    for img_dir in Path(output_dir).rglob("images"):
        imgs = list(img_dir.glob("*"))
        if imgs:
            results["preview"] = str(imgs[0])
    
    # Если ничего не нашли — обновлённый InstantMesh может сохранять иначе
    if not results["glb"] and not results["obj"]:
        all_files = list(Path(output_dir).rglob("*.glb")) + list(Path(output_dir).rglob("*.obj"))
        if all_files:
            for f in all_files:
                if f.suffix == ".glb" and not results["glb"]:
                    results["glb"] = str(f)
                elif f.suffix == ".obj" and not results["obj"]:
                    results["obj"] = str(f)
    
    logger.info(f"✓ InstantMesh done: {results}")
    return results


def run_lgm(image_path: str, output_dir: str, task_id: str) -> dict:
    """Запустить LGM через subprocess."""
    python = find_python()
    weights = ensure_lgm_weights()
    
    # Patch hub snapshot mv_unet.py (where from_pretrained loads it from)
    import glob as _glob
    for _f in _glob.glob(os.path.expanduser(
        "~/.cache/huggingface/hub/models--ashawkey--imagedream-ipmv-diffusers/"
        "snapshots/*/unet/mv_unet.py"
    )):
        _p = Path(_f)
        _c = _p.read_text()
        if "HAS_XFORMERS" not in _c:
            _c = _c.replace("# require xformers!\nimport xformers\nimport xformers.ops",
                "# xformers (optional)\ntry:\n    import xformers\n    import xformers.ops\n    HAS_XFORMERS = True\nexcept ImportError:\n    HAS_XFORMERS = False")
            _c = _c.replace(
                "out = xformers.ops.memory_efficient_attention(\n            q, k, v, attn_bias=None, op=self.attention_op\n        )",
                "if HAS_XFORMERS:\n            out = xformers.ops.memory_efficient_attention(\n                q, k, v, attn_bias=None, op=self.attention_op\n            )\n        else:\n            out = F.scaled_dot_product_attention(q, k, v)\n            out = out.reshape(b * self.heads, -1, self.dim_head)")
            _c = _c.replace(
                "out_ip = xformers.ops.memory_efficient_attention(\n                q, k_ip, v_ip, attn_bias=None, op=self.attention_op\n            )",
                "if HAS_XFORMERS:\n                out_ip = xformers.ops.memory_efficient_attention(\n                    q, k_ip, v_ip, attn_bias=None, op=self.attention_op\n                )\n            else:\n                out_ip = F.scaled_dot_product_attention(q, k_ip, v_ip)\n                out_ip = out_ip.reshape(b * self.heads, -1, self.dim_head)")
            _p.write_text(_c)
            logger.info(f"✓ Patched hub snapshot: {_p}")
        break
    
    cmd = [
        python, str(LGM_REPO / "infer.py"),
        "big",
        "--test_path", image_path,
        "--workspace", output_dir,
        "--resume", str(weights),
    ]
    
    logger.info(f"🚀 LGM: {' '.join(cmd)}")
    
    proc = subprocess.run(
        cmd, cwd=str(LGM_REPO),
        capture_output=True, text=True,
        timeout=600,
    )
    
    if proc.returncode != 0:
        logger.error(f"LGM stderr:\n{proc.stderr}")
        # Если вернул вывод, но ошибка — некоторые версии LGM падают после сохранения
        if "CUDA" in (proc.stderr or "") or "out of memory" in (proc.stderr or "").lower():
            raise RuntimeError(f"LGM failed: {proc.stderr[-500:]}")
        logger.warning(f"LGM exit={proc.returncode}, checking output anyway...")
    
    results = {"ply": None, "video": None}
    
    out = Path(output_dir)
    for f in out.rglob("*.ply"):
        results["ply"] = str(f)
        break
    for f in out.rglob("*.mp4"):
        results["video"] = str(f)
        break
    
    logger.info(f"✓ LGM done: {results}")
    return results


# ── FastAPI App ───────────────────────────────────────────────────────

app = FastAPI(title="3D Viewer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

# Patch models for missing CUDA libs
patch_instantmesh_nvdiffrast()
patch_lgm_gsplat()
patch_lgm_infer()
patch_lgm_xformers()

app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="frontend")
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS)), name="outputs")


@app.get("/")
async def root():
    return FileResponse(str(FRONTEND / "index.html"))


@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    file_id = str(uuid.uuid4())
    ext = Path(file.filename or "image.png").suffix or ".png"
    dest = UPLOADS / f"{file_id}{ext}"
    
    async with aiofiles.open(dest, "wb") as f:
        await f.write(await file.read())
    
    logger.info(f"📸 Uploaded: {dest}")
    return {"file_id": file_id, "path": str(dest), "filename": dest.name}


@app.post("/api/generate")
async def generate(file_id: str = Form(...), engine: str = Form(...)):
    uploads = list(UPLOADS.glob(f"{file_id}.*"))
    if not uploads:
        raise HTTPException(404, "File not found")
    
    task_id = str(uuid.uuid4())
    out_dir = OUTPUTS / task_id
    out_dir.mkdir(parents=True)
    
    tasks[task_id] = {
        "status": "running", "engine": engine,
        "progress": 0, "result": None, "error": None,
    }
    
    image_path = str(uploads[0])
    
    async def run():
        try:
            await ws_send(task_id, {"status": "running", "progress": 10})
            
            loop = asyncio.get_event_loop()
            
            if engine == "instantmesh":
                result = await loop.run_in_executor(
                    None, lambda: run_instantmesh(image_path, str(out_dir), task_id)
                )
            elif engine == "lgm":
                result = await loop.run_in_executor(
                    None, lambda: run_lgm(image_path, str(out_dir), task_id)
                )
            else:
                raise ValueError(f"Unknown engine: {engine}")
            
            tasks[task_id].update(status="completed", progress=100, result=result)
            await ws_send(task_id, {"status": "completed", "progress": 100, "result": result})
            
        except Exception as e:
            logger.exception(f"Task {task_id} failed")
            tasks[task_id].update(status="failed", error=str(e))
            await ws_send(task_id, {"status": "failed", "error": str(e)})
    
    asyncio.create_task(run())
    return {"task_id": task_id, "status": "running"}


@app.get("/api/status/{task_id}")
async def get_status(task_id: str):
    t = tasks.get(task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    return t


@app.websocket("/api/ws/{task_id}")
async def ws_endpoint(ws: WebSocket, task_id: str):
    await ws.accept()
    ws_connections.setdefault(task_id, []).append(ws)
    try:
        # Send current state
        t = tasks.get(task_id)
        if t:
            await ws.send_json(t)
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if task_id in ws_connections:
            ws_connections[task_id].remove(ws)


@app.get("/api/download/{task_id}")
async def download_result(task_id: str, fmt: str = "glb"):
    t = tasks.get(task_id)
    if not t or t["status"] != "completed":
        raise HTTPException(404, "Result not ready")
    
    result = t.get("result", {})
    path = result.get(fmt) or result.get("obj") or result.get("ply")
    
    if not path or not Path(path).exists():
        raise HTTPException(404, f"No {fmt} file found")
    
    return FileResponse(path, filename=Path(path).name)


@app.get("/api/check")
async def check():
    """Проверка CUDA и готовности."""
    info = {"cuda": False, "gpu": None, "torch": None, "models": {}}
    try:
        import torch
        info["torch"] = torch.__version__
        info["cuda"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
    except Exception as e:
        info["torch_error"] = str(e)
    
    # Check if weights exist without downloading
    from huggingface_hub import HfApi, scan_cache_dir
    info["models"]["instantmesh"] = "checking..."
    info["models"]["lgm"] = "checking..."
    
    try:
        cache = scan_cache_dir(str(CKPTS.parent / ".cache" / "huggingface"))
        for repo in list(cache.repos):
            if "TencentARC/InstantMesh" in str(repo.repo_id):
                revisions = list(repo.revisions)
                if revisions and list(revisions[0].files):
                    info["models"]["instantmesh"] = "cached"
                else:
                    info["models"]["instantmesh"] = "not cached"
            if "ashawkey/LGM" in str(repo.repo_id):
                revisions = list(repo.revisions)
                if revisions and list(revisions[0].files):
                    info["models"]["lgm"] = "cached"
                else:
                    info["models"]["lgm"] = "not cached"
    except Exception:
        pass
    
    return info


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"🚀 3D Viewer starting on http://0.0.0.0:{port}")
    logger.info(f"   InstantMesh: {IM_REPO}")
    logger.info(f"   LGM:         {LGM_REPO}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
