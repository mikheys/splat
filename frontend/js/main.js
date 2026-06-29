/**
 * Main Application Logic
 * Orchestrates upload, generation, viewer switching, and downloads.
 */
(function() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let state = {
    fileId: null,
    fileName: null,
    taskId: null,
    engine: 'instantmesh',
    ws: null,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────
  const dom = {
    uploadZone: document.getElementById('uploadZone'),
    uploadContent: document.getElementById('uploadContent'),
    uploadPreview: document.getElementById('uploadPreview'),
    previewImage: document.getElementById('previewImage'),
    fileInput: document.getElementById('fileInput'),
    changeImageBtn: document.getElementById('changeImageBtn'),
    generateBtn: document.getElementById('generateBtn'),
    progressCard: document.getElementById('progressCard'),
    progressFill: document.getElementById('progressFill'),
    progressStatus: document.getElementById('progressStatus'),
    actionsCard: document.getElementById('actionsCard'),
    resultBadge: document.getElementById('resultBadge'),
    downloadBtn: document.getElementById('downloadBtn'),
    newBtn: document.getElementById('newBtn'),
    resultFiles: document.getElementById('resultFiles'),
    viewerPlaceholder: document.getElementById('viewerPlaceholder'),
    threeContainer: document.getElementById('threeContainer'),
    splatContainer: document.getElementById('splatContainer'),
    viewerControls: document.getElementById('viewerControls'),
  };

  let meshViewer = null;
  let splatEditor = null;

  // ── Init ───────────────────────────────────────────────────────────────

  function init() {
    // Upload: click
    dom.uploadZone.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', onFileSelected);

    // Upload: drag-drop
    dom.uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.uploadZone.classList.add('dragover');
    });
    dom.uploadZone.addEventListener('dragleave', () => {
      dom.uploadZone.classList.remove('dragover');
    });
    dom.uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.uploadZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        handleFile(file);
      }
    });

    // Change image
    dom.changeImageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetForNewImage();
      dom.fileInput.click();
    });

    // Engine selection
    document.querySelectorAll('input[name="engine"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        state.engine = e.target.value;
        enableGenerate();
      });
    });

    // Generate button
    dom.generateBtn.addEventListener('click', startGeneration);

    // New photo button
    dom.newBtn.addEventListener('click', () => {
      resetAll();
      state = { fileId: null, fileName: null, taskId: null, engine: 'instantmesh', ws: null };
    });

    // Init viewers
    meshViewer = new MeshViewer('threeContainer');
    splatEditor = new SplatEditor('splatContainer');
  }

  // ── File handling ──────────────────────────────────────────────────────

  function onFileSelected(e) {
    const file = e.target.files[0];
    if (file) handleFile(file);
  }

  async function handleFile(file) {
    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      dom.previewImage.src = e.target.result;
      dom.uploadContent.style.display = 'none';
      dom.uploadPreview.style.display = 'flex';
    };
    reader.readAsDataURL(file);

    // Upload to server
    const formData = new FormData();
    formData.append('file', file);

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      state.fileId = data.file_id;
      state.fileName = data.filename;
      enableGenerate();
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Ошибка загрузки файла');
    }
  }

  function enableGenerate() {
    dom.generateBtn.disabled = !state.fileId;
  }

  // ── Generation ─────────────────────────────────────────────────────────

  async function startGeneration() {
    if (!state.fileId) return;

    // UI: show progress
    dom.generateBtn.disabled = true;
    dom.generateBtn.querySelector('.btn-text').style.display = 'none';
    dom.generateBtn.querySelector('.btn-loader').style.display = 'inline-block';
    dom.progressCard.style.display = 'block';
    dom.actionsCard.style.display = 'none';
    dom.progressFill.style.width = '10%';
    dom.progressStatus.textContent = 'Подготовка...';

    // Hide viewers
    dom.viewerPlaceholder.style.display = 'none';
    dom.threeContainer.style.display = 'none';
    dom.splatContainer.style.display = 'none';
    dom.viewerControls.style.display = 'none';

    try {
      // Start task
      const formData = new FormData();
      formData.append('file_id', state.fileId);
      formData.append('engine', state.engine);

      const resp = await fetch('/api/generate', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      state.taskId = data.task_id;

      // Connect WebSocket for progress
      connectWS(state.taskId);

    } catch (err) {
      console.error('Generation start failed:', err);
      dom.progressStatus.textContent = '❌ Ошибка запуска';
      resetGenerateBtn();
    }
  }

  function connectWS(taskId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/${taskId}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.progress !== undefined) {
        dom.progressFill.style.width = Math.min(msg.progress, 95) + '%';
      }
      if (msg.status === 'running') {
        dom.progressStatus.textContent = '⏳ Генерация 3D...';
        dom.progressFill.style.width = '40%';
      }
      if (msg.status === 'completed') {
        onGenerationComplete(msg.result);
      }
      if (msg.status === 'failed') {
        onGenerationFailed(msg.error);
      }
    };

    state.ws.onerror = () => {
      // Fallback to polling
      pollStatus(taskId);
    };

    state.ws.onclose = () => {
      // If still running, start polling
    };
  }

  async function pollStatus(taskId) {
    const maxAttempts = 120; // 2 min at 1s intervals
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(1000);
      try {
        const resp = await fetch(`/api/status/${taskId}`);
        const data = await resp.json();

        if (data.status === 'completed') {
          onGenerationComplete(data.result);
          return;
        }
        if (data.status === 'failed') {
          onGenerationFailed(data.error);
          return;
        }

        dom.progressFill.style.width = Math.min(30 + i * 0.5, 90) + '%';
        dom.progressStatus.textContent = '⏳ Генерация 3D...';

      } catch (err) {
        console.error('Poll error:', err);
      }
    }
    dom.progressStatus.textContent = '⏱ Таймаут — проверь сервер';
    resetGenerateBtn();
  }

  function onGenerationComplete(result) {
    dom.progressFill.style.width = '100%';
    dom.progressStatus.textContent = '✅ Готово!';
    dom.actionsCard.style.display = 'block';
    dom.viewerControls.style.display = 'block';

    resetGenerateBtn();

    // Show result info
    const files = [];
    if (result.glb) files.push('GLB: ' + result.glb.split('/').pop());
    if (result.obj) files.push('OBJ: ' + result.obj.split('/').pop());
    if (result.ply) files.push('PLY: ' + result.ply.split('/').pop());
    if (result.video) files.push('MP4: ' + result.video.split('/').pop());

    dom.resultFiles.textContent = files.join(' · ');

    // Setup download button
    const downloadUrl = result.glb || result.obj || result.ply;
    if (downloadUrl) {
      dom.downloadBtn.href = downloadUrl;
      dom.downloadBtn.download = downloadUrl.split('/').pop();
      dom.downloadBtn.style.display = '';
    } else {
      dom.downloadBtn.style.display = 'none';
    }

    // Show in 3D viewer
    showInViewer(result);
  }

  function onGenerationFailed(error) {
    dom.progressStatus.textContent = `❌ Ошибка: ${error}`;
    resetGenerateBtn();
  }

  function resetGenerateBtn() {
    dom.generateBtn.disabled = false;
    dom.generateBtn.querySelector('.btn-text').style.display = 'inline';
    dom.generateBtn.querySelector('.btn-loader').style.display = 'none';
  }

  // ── Viewer Display ────────────────────────────────────────────────────

  function showInViewer(result) {
    dom.viewerPlaceholder.style.display = 'none';

    if (state.engine === 'instantmesh' && (result.glb || result.obj)) {
      // Show mesh viewer
      dom.threeContainer.style.display = 'block';
      dom.splatContainer.style.display = 'none';

      const format = result.glb ? 'glb' : 'obj';
      const url = result.glb || result.obj;
      meshViewer.loadMesh(url, format);

    } else if (state.engine === 'lgm' && result.ply) {
      // Show splat editor
      dom.threeContainer.style.display = 'none';
      dom.splatContainer.style.display = 'block';

      splatEditor.loadPLY(result.ply);

    } else {
      // No viewable result — show fallback
      dom.threeContainer.style.display = 'none';
      dom.splatContainer.style.display = 'none';
      dom.viewerPlaceholder.style.display = 'flex';
      
      const hasAnyFile = result.glb || result.obj || result.ply;
      if (hasAnyFile) {
        dom.viewerPlaceholder.querySelector('p').textContent = 'Файл сгенерирован, но не может быть показан в браузере. Используй кнопку "Скачать".';
      } else {
        dom.viewerPlaceholder.querySelector('p').textContent = '❌ Генерация не удалась. Проверь логи сервера.';
        dom.resultBadge.textContent = '❌ Ошибка генерации';
        dom.resultBadge.style.color = '#ff6b6b';
      }
    }
  }

  // ── Reset helpers ──────────────────────────────────────────────────────

  function resetForNewImage() {
    dom.uploadContent.style.display = 'flex';
    dom.uploadPreview.style.display = 'none';
    dom.fileInput.value = '';
    dom.generateBtn.disabled = true;
    dom.progressCard.style.display = 'none';
    dom.actionsCard.style.display = 'none';
    dom.viewerPlaceholder.style.display = 'flex';
    dom.viewerPlaceholder.querySelector('p').textContent = 'Загрузи фото и нажми «Сгенерировать»';
    dom.threeContainer.style.display = 'none';
    dom.splatContainer.style.display = 'none';
    dom.viewerControls.style.display = 'none';
    meshViewer.clear();
    splatEditor.clear();
  }

  function resetAll() {
    resetForNewImage();
    if (state.ws) {
      state.ws.close();
    }
  }

  // ── Utils ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Bootstrap ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
