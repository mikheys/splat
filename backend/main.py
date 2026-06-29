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
    
    cmd = [
        python, str(LGM_REPO / "infer.py"),
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
