# 3D Viewer — Image to 3D Web Application

Превращает одну фотку в 3D двумя движками:
- **InstantMesh** — текстурированный 3D mesh (GLB/OBJ)
- **LGM** — 3D Gaussian Splatting (PLY, сплаты)

Загружаешь фото → выбираешь движок → получаешь 3D → крутишь → сохраняешь.

## Быстрый старт

```bash
# Установка
cd backend
pip install -r requirements.txt

# Запуск
python main.py
```

Открыть http://localhost:8000

## Архитектура

```
backend/          FastAPI + Python inference
frontend/         Vanilla JS + Three.js + Gaussian Splatting viewer
data/
  uploads/        Загруженные фото
  outputs/        Результаты (GLB/PLY)
  ckpts/          Веса моделей (скачиваются автоматом)
```
