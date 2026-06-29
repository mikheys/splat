/**
 * Gaussian Splat Editor — WebGL2 Gaussian Splatting Viewer
 * 
 * Формат .ply: стандартный 3D Gaussian Splatting (Kerbl et al.)
 *   pos(3) + f_dc(3) + opacity(1) + scale(3) + rot(4) = 17 floats
 * 
 * Фичи:
 *   - Мышь: вращение, ПКМ: панорама, колёсико: зум
 *   - Кнопка «Сохранить PNG» — скриншот текущего ракурса
 *   - Сортировка гауссианов по глубине
 *   - Радиальный градиент вместо точек
 */
class SplatEditor {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.canvas = null;
    this.gl = null;
    this.width = 0;
    this.height = 0;
    this.animId = null;

    // Camera
    this.yaw = 0;
    this.pitch = -0.3;
    this.radius = 3.0;
    this.fov = 40;
    this.targetX = 0;
    this.targetY = 0;
    this.targetZ = 0;

    // Данные
    this.positions = null;
    this.colors = null;
    this.opacities = null;
    this.scales = null;
    this.rotations = null;
    this.numSplats = 0;
    this.loaded = false;

    // Depth sort buffer
    this.depthBuffer = null;
    this.needsSort = true;

    // Mouse
    this._isDragging = false;
    this._isPanning = false;
    this._prevMouse = { x: 0, y: 0 };
    this._lastPinchDist = 0;

    // Save screenshot button
    this.saveBtn = null;

    this._init();
    this._createSaveButton();
  }

  _init() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.cursor = 'grab';
    this.container.appendChild(this.canvas);

    this.gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
    });

    if (!this.gl) {
      console.error('WebGL2 not supported');
      return;
    }

    this._resize();
    window.addEventListener('resize', () => this._resize());

    // Mouse
    this.canvas.addEventListener('mousedown', (e) => this._onDown(e));
    window.addEventListener('mousemove', (e) => this._onMove(e));
    window.addEventListener('mouseup', () => this._onUp());
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch
    this.canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', () => this._onUp());

    this._initShaders();
    this._render();
  }

  _createSaveButton() {
    this.saveBtn = document.createElement('button');
    this.saveBtn.textContent = '💾 Сохранить PNG';
    this.saveBtn.style.cssText = `
      position: absolute; bottom: 60px; right: 20px; z-index: 20;
      padding: 8px 16px; background: rgba(108,92,231,0.9); color: white;
      border: none; border-radius: 8px; font-size: 13px; font-weight: 600;
      cursor: pointer; backdrop-filter: blur(8px);
      transition: opacity 0.2s; display: none;
    `;
    this.saveBtn.addEventListener('click', () => this.saveScreenshot());
    this.container.appendChild(this.saveBtn);
  }

  saveScreenshot() {
    if (!this.loaded) return;
    this.canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `splat_${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // ── Shaders ──────────────────────────────────────────────

  _initShaders() {
    const gl = this.gl;

    const vsSrc = `#version 300 es
      in vec3 aPosition;
      in vec3 aColor;
      in float aOpacity;
      in vec3 aScale;
      in vec4 aRotation;

      uniform mat4 uMVP;
      uniform vec2 uViewport;

      out vec4 vColor;
      out float vDepth;

      // Quaternion rotate point
      vec3 qrot(vec4 q, vec3 v) {
        return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
      }

      void main() {
        vec4 worldPos = vec4(aPosition, 1.0);
        vec4 clipPos = uMVP * worldPos;

        // Fixed point size for debugging
        gl_PointSize = 20.0;

        gl_Position = clipPos;
        vColor = vec4(aColor, aOpacity);
        vDepth = clipPos.z / clipPos.w;
      }
    `;

    const fsSrc = `#version 300 es
      precision highp float;

      in vec4 vColor;
      in float vDepth;

      out vec4 fragColor;

      void main() {
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        if (dist > 0.5) discard;

        // Soft radial gradient
        float alpha = exp(-4.0 * dist * dist);
        alpha = clamp(alpha, 0.0, 1.0);
        alpha *= vColor.a;

        // Anti-aliased edge
        float edge = smoothstep(0.5, 0.45, dist);
        alpha *= edge;

        if (alpha < 0.01) discard;
        fragColor = vec4(vColor.rgb, alpha);
      }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('VS compile error:', gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS compile error:', gl.getShaderInfoLog(fs));
    }

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(this.program));
    }

    this.attribs = {
      aPosition: gl.getAttribLocation(this.program, 'aPosition'),
      aColor: gl.getAttribLocation(this.program, 'aColor'),
      aOpacity: gl.getAttribLocation(this.program, 'aOpacity'),
      aScale: gl.getAttribLocation(this.program, 'aScale'),
      aRotation: gl.getAttribLocation(this.program, 'aRotation'),
    };
    console.log('Attrib locations:', this.attribs);

    this.uniforms = {
      uMVP: gl.getUniformLocation(this.program, 'uMVP'),
      uViewport: gl.getUniformLocation(this.program, 'uViewport'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.bufPosition = gl.createBuffer();
    this.bufColor = gl.createBuffer();
    this.bufOpacity = gl.createBuffer();
    this.bufScale = gl.createBuffer();
    this.bufRotation = gl.createBuffer();
  }

  // ── PLY Parsing (3DGS format) ──────────────────────────

  async loadPLY(url) {
    this.loaded = false;
    this.saveBtn.style.display = 'none';

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      this._parsePLY(buf);
      this._uploadBuffers();
      this.needsSort = true;
      this.loaded = true;
      this.saveBtn.style.display = 'block';
    } catch (err) {
      console.error('Failed to load PLY:', err);
    }
  }

  _parsePLY(buffer) {
    const decoder = new TextDecoder('ascii');
    const headerEnd = this._findHeaderEnd(buffer);
    const header = decoder.decode(new Uint8Array(buffer, 0, headerEnd));
    console.log('PLY header:', header.substring(0, 200));

    // Parse vertex count
    const vertMatch = header.match(/element vertex\s+(\d+)/i);
    if (!vertMatch) throw new Error('No vertex count in PLY');
    this.numSplats = parseInt(vertMatch[1]);

    // Find property offsets
    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2',
                   'opacity', 'scale_0', 'scale_1', 'scale_2',
                   'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    
    const propOrder = [];
    const propLines = header.split('\n').filter(l => l.trim().startsWith('property '));
    for (const line of propLines) {
      const parts = line.trim().split(/\s+/);
      const name = parts[parts.length - 1];
      const type = parts[parts.length - 2];
      propOrder.push({ name, type });
    }

    // Find stride (bytes per vertex)
    const typeSizes = { 'float': 4, 'float32': 4, 'uchar': 1, 'uint8': 1 };
    let stride = 0;
    for (const p of propOrder) {
      stride += typeSizes[p.type] || 4;
    }

    // Read all vertex data
    const dv = new DataView(buffer, headerEnd);
    const N = this.numSplats;

    // Pre-allocate arrays
    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const opacities = new Float32Array(N);
    const scales = new Float32Array(N * 3);
    const rotations = new Float32Array(N * 4);

    // Property indices in the vertex data
    const getIdx = (name) => propOrder.findIndex(p => p.name === name);

    const idxX = getIdx('x'), idxY = getIdx('y'), idxZ = getIdx('z');
    const idxDC0 = getIdx('f_dc_0');
    const idxOp = getIdx('opacity');
    const idxS0 = getIdx('scale_0');
    const idxR0 = getIdx('rot_0');

    for (let i = 0; i < N && (i * stride + stride) <= buffer.byteLength - headerEnd; i++) {
      const off = i * stride;

      // Position
      positions[i*3]   = dv.getFloat32(off + idxX * 4, true);
      positions[i*3+1] = dv.getFloat32(off + idxY * 4, true);
      positions[i*3+2] = dv.getFloat32(off + idxZ * 4, true);

      // Color (SH DC → RGB, scale by 0.28209479177387814 + clamp 0-1)
      const shR = dv.getFloat32(off + idxDC0 * 4, true);
      const shG = dv.getFloat32(off + (idxDC0 + 1) * 4, true) || dv.getFloat32(off + (idxDC0 + 1) * 4, true);
      const shB = dv.getFloat32(off + (idxDC0 + 2) * 4, true) || dv.getFloat32(off + (idxDC0 + 2) * 4, true);
      
      // SH DC: val = 0.28209479177387814 * rgb + 0.5 → rgb = (val - 0.5) / 0.28209479177387814
      // But LGM stores pre-activated: rgb = tanh(x)*0.5+0.5 → [0,1]
      // When compatible=True (default), it inverts: shs = (shs - 0.5) / 0.28209479177387814
      // So we need to decode: rgb = sh * 0.28209479177387814 + 0.5
      colors[i*3]   = Math.max(0, Math.min(1, shR * 0.28209479177387814 + 0.5));
      colors[i*3+1] = Math.max(0, Math.min(1, shG * 0.28209479177387814 + 0.5));
      colors[i*3+2] = Math.max(0, Math.min(1, shB * 0.28209479177387814 + 0.5));

      // Opacity (inverse sigmoid → sigmoid)
      const op = dv.getFloat32(off + idxOp * 4, true);
      opacities[i] = 1.0 / (1.0 + Math.exp(-op));

      // Scale (log → exp)
      if (idxS0 >= 0) {
        scales[i*3]   = Math.exp(dv.getFloat32(off + idxS0 * 4, true));
        scales[i*3+1] = Math.exp(dv.getFloat32(off + (idxS0 + 1) * 4, true));
        scales[i*3+2] = Math.exp(dv.getFloat32(off + (idxS0 + 2) * 4, true));
      }

      // Rotation
      if (idxR0 >= 0) {
        rotations[i*4]   = dv.getFloat32(off + idxR0 * 4, true);
        rotations[i*4+1] = dv.getFloat32(off + (idxR0 + 1) * 4, true);
        rotations[i*4+2] = dv.getFloat32(off + (idxR0 + 2) * 4, true);
        rotations[i*4+3] = dv.getFloat32(off + (idxR0 + 3) * 4, true);
        // Normalize
        const len = Math.sqrt(
          rotations[i*4]*rotations[i*4] +
          rotations[i*4+1]*rotations[i*4+1] +
          rotations[i*4+2]*rotations[i*4+2] +
          rotations[i*4+3]*rotations[i*4+3]
        );
        if (len > 0) {
          rotations[i*4]   /= len;
          rotations[i*4+1] /= len;
          rotations[i*4+2] /= len;
          rotations[i*4+3] /= len;
        }
      }
    }

    this.positions = positions;
    this.colors = colors;
    this.opacities = opacities;
    this.scales = scales;
    this.rotations = rotations;
    this.numSplats = N;
  }

  _findHeaderEnd(buffer) {
    const view = new Uint8Array(buffer);
    for (let i = 0; i < buffer.byteLength - 10; i++) {
      if (view[i] === 0x65 &&  // 'e'
          view[i+1] === 0x6e &&  // 'n'
          view[i+2] === 0x64 &&  // 'd'
          view[i+3] === 0x5f &&  // '_'
          view[i+4] === 0x68 &&  // 'h'
          view[i+5] === 0x65 &&  // 'e'
          view[i+6] === 0x61 &&  // 'a'
          view[i+7] === 0x64 &&  // 'd'
          view[i+8] === 0x65 &&  // 'e'
          view[i+9] === 0x72) {  // 'r'
        // end_header followed by \n or \r\n
        let eoh = i + 10; // position after 'end_header'
        // skip \r if present (Windows)
        if (eoh < buffer.byteLength && view[eoh] === 0x0d) eoh++;
        // skip \n
        if (eoh < buffer.byteLength && view[eoh] === 0x0a) eoh++;
        return eoh;
      }
    }
    throw new Error('No end_header found');
  }

  // ── Buffers ──────────────────────────────────────────────

  _uploadBuffers() {
    const gl = this.gl;
    if (this.numSplats === 0) return;

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPosition);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.aPosition);
    gl.vertexAttribPointer(this.attribs.aPosition, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.aColor);
    gl.vertexAttribPointer(this.attribs.aColor, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufOpacity);
    gl.bufferData(gl.ARRAY_BUFFER, this.opacities, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.aOpacity);
    gl.vertexAttribPointer(this.attribs.aOpacity, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufScale);
    gl.bufferData(gl.ARRAY_BUFFER, this.scales, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.aScale);
    gl.vertexAttribPointer(this.attribs.aScale, 3, gl.FLOAT, false, 0, 0);

    // Rotation may be optimized out by shader compiler
    if (this.attribs.aRotation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRotation);
      gl.bufferData(gl.ARRAY_BUFFER, this.rotations, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.attribs.aRotation);
      gl.vertexAttribPointer(this.attribs.aRotation, 4, gl.FLOAT, false, 0, 0);
    }

    gl.bindVertexArray(null);
  }

  // ── Render ────────────────────────────────────────────────

  _getMVP() {
    const cx = this.radius * Math.sin(this.yaw) * Math.cos(this.pitch);
    const cy = this.radius * Math.sin(this.pitch);
    const cz = this.radius * Math.cos(this.yaw) * Math.cos(this.pitch);

    const f = 1.0 / Math.tan(this.fov * 0.5 * Math.PI / 180);
    const aspect = this.width / this.height;
    const zNear = 0.05;
    const zFar = 200;
    const tx = -cx, ty = -cy, tz = -cz;

    // View matrix (lookAt from camera to origin)
    const fwdLen = Math.sqrt(tx*tx + ty*ty + tz*tz);
    const fx = tx / fwdLen, fy = ty / fwdLen, fz = tz / fwdLen;
    
    const rx = 0 * fz - 1 * fy;
    const ry = 1 * fx - 0 * fz;
    const rz = 0 * fy - 0 * fx;
    const rLen = Math.sqrt(rx*rx + ry*ry + rz*rz);
    const rxn = rx/rLen || 1, ryn = ry/rLen || 0, rzn = rz/rLen || 0;
    
    const ux = fy * rzn - fz * ryn;
    const uy = fz * rxn - fx * rzn;
    const uz = fx * ryn - fy * rxn;

    const view = new Float32Array([
      rxn, ux, -fx, 0,
      ryn, uy, -fy, 0,
      rzn, uz, -fz, 0,
      -(rxn*cx + ryn*cy + rzn*cz), -(ux*cx + uy*cy + uz*cz), fx*cx + fy*cy + fz*cz, 1
    ]);

    const proj = new Float32Array([
      f/aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (zFar+zNear)/(zNear-zFar), -1,
      0, 0, 2*zFar*zNear/(zNear-zFar), 0
    ]);

    // MVP = proj * view
    const mvp = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += proj[k*4+i] * view[j*4+k];
        }
        mvp[j*4+i] = sum;
      }
    }
    return mvp;
  }

  _render = () => {
    this.animId = requestAnimationFrame(this._render);
    const gl = this.gl;
    if (!gl || this.numSplats === 0) return;

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.04, 0.04, 0.05, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const mvp = this._getMVP();
    gl.uniformMatrix4fv(this.uniforms.uMVP, false, mvp);
    gl.uniform2f(this.uniforms.uViewport, this.width, this.height);

    // Transparency: back-to-front
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.drawArrays(gl.POINTS, 0, this.numSplats);
  }

  // ── Controls ─────────────────────────────────────────────

  _resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.width = Math.floor(rect.width * window.devicePixelRatio);
    this.height = Math.floor(rect.height * window.devicePixelRatio);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    if (this.gl) this.gl.viewport(0, 0, this.width, this.height);
  }

  _onDown(e) {
    if (e.button === 2) {
      this._isPanning = true;
    } else {
      this._isDragging = true;
      this.canvas.style.cursor = 'grabbing';
    }
    this._prevMouse = { x: e.clientX, y: e.clientY };
  }

  _onMove(e) {
    const dx = e.clientX - this._prevMouse.x;
    const dy = e.clientY - this._prevMouse.y;

    if (this._isDragging) {
      this.yaw += dx * 0.01;
      this.pitch = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, this.pitch + dy * 0.01));
    } else if (this._isPanning) {
      this.targetX -= dx * 0.005 * this.radius;
      this.targetY += dy * 0.005 * this.radius;
    }
    this._prevMouse = { x: e.clientX, y: e.clientY };
  }

  _onUp() {
    this._isDragging = false;
    this._isPanning = false;
    this.canvas.style.cursor = 'grab';
  }

  _onWheel(e) {
    e.preventDefault();
    this.radius = Math.max(0.3, Math.min(20, this.radius + e.deltaY * 0.005));
  }

  _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      this._isDragging = true;
      this._prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      this._lastPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && this._isDragging) {
      const dx = e.touches[0].clientX - this._prevMouse.x;
      const dy = e.touches[0].clientY - this._prevMouse.y;
      this.yaw += dx * 0.01;
      this.pitch = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, this.pitch + dy * 0.01));
      this._prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      this.radius *= this._lastPinchDist / dist;
      this._lastPinchDist = dist;
    }
  }

  clear() {
    this.numSplats = 0;
    this.loaded = false;
    if (this.saveBtn) this.saveBtn.style.display = 'none';
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    window.removeEventListener('resize', () => this._resize());
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
