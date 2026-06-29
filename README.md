# 3D Viewer — Image to 3D Web Application

Превращает одну фотку в 3D двумя движками:
- **InstantMesh** — текстурированный 3D mesh (GLB/OBJ)
- **LGM** — 3D Gaussian Splatting (PLY, сплаты)

Загружаешь фото → выбираешь движок → получаешь 3D → крутишь → сохраняешь.

---

## 🪟 Windows (с RTX 4090)

```powershell
# 1. Скачать репозиторий
git clone https://github.com/mikheys/splat.git
cd splat

# 2. Перенести веса LGM (model_fp16.safetensors) в data/ckpts/
#    или они скачаются автоматически

# 3. Установка (один раз)
setup.bat

# 4. Запуск
start.bat
```

Открыть **http://localhost:8080**

---

## 🐧 Linux

```bash
# 1. Клонировать
git clone https://github.com/mikheys/splat.git
cd splat
git clone https://github.com/TencentARC/InstantMesh.git backend/instantmesh
git clone https://github.com/3DTopia/LGM.git backend/lgm

# 2. Установка
./setup.sh

# 3. Запуск
./start.sh
```

---

## Архитектура

```
backend/          FastAPI + Python inference
  main.py          — сервер
  instantmesh/     — клон TencentARC/InstantMesh
  lgm/             — клон 3DTopia/LGM
frontend/         Vanilla JS + Three.js + Gaussian Splatting viewer
  index.html       — drag-drop, выбор движка, 3D вьювер
  js/viewer_mesh.js   — Three.js OrbitControls
  js/viewer_splats.js — WebGL2 Gaussian Splat renderer
data/
  uploads/         Загруженные фото
  outputs/         Результаты (GLB/PLY/MP4)
  ckpts/           Веса моделей (model_fp16.safetensors)

setup.bat / setup.sh   — установка Windows/Linux
start.bat / start.sh   — запуск
```

## API

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/upload` | Загрузить фото |
| POST | `/api/generate` | Запустить генерацию |
| WS | `/api/ws/{task_id}` | Live-прогресс |
| GET | `/api/download/{task_id}` | Скачать результат |

