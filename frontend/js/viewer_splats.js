/**
 * Gaussian Splat Viewer — WebGL2 renderer для .ply Gaussian Splats
 * 
 * Основан на алгоритме из 3D Gaussian Splatting (Kerbl et al.)
 * Адаптирован для веб-рендеринга через сортировку по глубине.
 */
class SplatViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.canvas = null;
    this.gl = null;
    this.width = 0;
    this.height = 0;
    this.animationId = null;

    // Camera
    this.camera = { x: 0, y: 0, z: 3.5 };
    this.target = { x: 0, y: 0, z: 0 };
    this.up = { x: 0, y: 1, z: 0 };
    this.fov = 45;

    // Mouse interaction
    this._isDragging = false;
    this._prevMouse = { x: 0, y: 0 };
    this._yaw = 0;
    this._pitch = -0.2;
    this._radius = 3.5;

    // Splat data
    this.points = [];
    this.numPoints = 0;

    // Sort buffer
    this._sortBuffer = null;
    this._needsSort = true;

    this._init();
  }

  _init() {
    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.container.appendChild(this.canvas);

    // Get context
    this.gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false
    });

    if (!this.gl) {
      console.error('WebGL2 not supported');
      return;
    }

    // Setup viewport
    this._resize();
    this._onResize = this._resize.bind(this);
    window.addEventListener('resize', this._onResize);

    // Mouse handlers
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this._onMouseUp());
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch handlers
    this.canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', () => this._onTouchEnd());

    // Shaders
    this._initShaders();

    // Start render loop
    this._render();
  }

  _initShaders() {
    const gl = this.gl;

    // Vertex shader
    const vsSrc = `#version 300 es
      in vec3 position;
      in vec4 color;
      in vec3 scale;
      in vec4 rot;

      uniform mat4 uMVP;
      uniform vec2 uFocal;
      uniform vec2 uViewport;

      out vec4 vColor;
      out vec2 vPosition;

      void main() {
        vec4 wPos = vec4(position, 1.0);
        vec4 cPos = uMVP * wPos;
        gl_Position = cPos;
        gl_PointSize = 2.0;
        
        vColor = color;
        vPosition = cPos.xy / cPos.w;
      }
    `;

    // Fragment shader
    const fsSrc = `#version 300 es
      precision highp float;
      in vec4 vColor;
      in vec2 vPosition;
      out vec4 fragColor;

      void main() {
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        if (dist > 0.5) discard;
        float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
        fragColor = vec4(vColor.rgb, vColor.a * alpha);
      }
    `;

    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('VS error:', gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS error:', gl.getShaderInfoLog(fs));
    }

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Program error:', gl.getProgramInfoLog(this.program));
    }

    this.attribs = {
      position: gl.getAttribLocation(this.program, 'position'),
      color: gl.getAttribLocation(this.program, 'color'),
      scale: gl.getAttribLocation(this.program, 'scale'),
      rot: gl.getAttribLocation(this.program, 'rot'),
    };

    this.uniforms = {
      uMVP: gl.getUniformLocation(this.program, 'uMVP'),
      uFocal: gl.getUniformLocation(this.program, 'uFocal'),
      uViewport: gl.getUniformLocation(this.program, 'uViewport'),
    };

    // VAO & buffers
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.posBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.scaleBuffer = gl.createBuffer();
    this.rotBuffer = gl.createBuffer();
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.floor(rect.width * window.devicePixelRatio);
    this.height = Math.floor(rect.height * window.devicePixelRatio);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.gl && this.gl.viewport(0, 0, this.width, this.height);
  }

  _getMVP() {
    // Simple look-at matrix
    const cx = this._radius * Math.sin(this._yaw) * Math.cos(this._pitch);
    const cy = this._radius * Math.sin(this._pitch);
    const cz = this._radius * Math.cos(this._yaw) * Math.cos(this._pitch);
    this.camera = { x: cx, y: cy, z: cz };

    const f = 1.0 / Math.tan(this.fov * 0.5 * Math.PI / 180);
    const aspect = this.width / this.height;
    const zNear = 0.1;
    const zFar = 100;

    const view = new Float32Array(16);
    const proj = new Float32Array(16);

    // LookAt: camera at (cx, cy, cz), looking at origin, up=(0,1,0)
    const fx = -cx, fy = -cy, fz = -cz;
    const fLen = Math.sqrt(fx*fx + fy*fy + fz*fz);
    const ux = fx/fLen, uy = fy/fLen, uz = fz/fLen;
    // Right = up × forward
    const rx = 1*uz - 0*uy;
    const ry = 0*ux - 0*uz;
    const rz = 0*uy - 1*ux;
    const rLen = Math.sqrt(rx*rx + ry*ry + rz*rz);
    const rxn = rx/rLen, ryn = ry/rLen, rzn = rz/rLen;
    // Recompute up = forward × right
    const upx = uy*rzn - uz*ryn;
    const upy = uz*rxn - ux*rzn;
    const upz = ux*ryn - uy*rxn;

    view[0] = rxn; view[1] = upx; view[2] = -ux; view[3] = 0;
    view[4] = ryn; view[5] = upy; view[6] = -uy; view[7] = 0;
    view[8] = rzn; view[9] = upz; view[10] = -uz; view[11] = 0;
    view[12] = -(rxn*cx + ryn*cy + rzn*cz);
    view[13] = -(upx*cx + upy*cy + upz*cz);
    view[14] = ux*cx + uy*cy + uz*cz;
    view[15] = 1;

    proj[0] = f/aspect; proj[1] = 0; proj[2] = 0; proj[3] = 0;
    proj[4] = 0; proj[5] = f; proj[6] = 0; proj[7] = 0;
    proj[8] = 0; proj[9] = 0; proj[10] = (zFar+zNear)/(zNear-zFar); proj[11] = -1;
    proj[12] = 0; proj[13] = 0; proj[14] = 2*zFar*zNear/(zNear-zFar); proj[15] = 0;

    // MVP = proj * view
    const mvp = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        mvp[j*4+i] = 0;
        for (let k = 0; k < 4; k++) {
          mvp[j*4+i] += proj[k*4+i] * view[j*4+k];
        }
      }
    }

    return mvp;
  }

  /**
   * Загрузка .ply файла с Gaussian Splats
   */
  async loadPLY(url) {
    try {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      this._parsePLY(buf);
      this._uploadBuffers();
      this._needsSort = true;
    } catch (err) {
      console.error('Failed to load PLY:', err);
    }
  }

  _parsePLY(buffer) {
    const data = new DataView(buffer);
    let offset = 0;

    // Parse header
    const headerStr = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 2000)));
    const headerEnd = headerStr.indexOf('end_header');
    if (headerEnd === -1) throw new Error('Invalid PLY header');

    const headerLines = headerStr.substring(0, headerEnd).split('\n');
    let vertexCount = 0;
    let hasColor = false;
    let hasScale = false;
    let hasRot = false;
    let vertexOffset = 0;

    for (const line of headerLines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'element' && parts[1] === 'vertex') {
        vertexCount = parseInt(parts[2]);
      }
      if (parts[0] === 'property') {
        if (parts[2] === 'red' || parts[2] === 'r') hasColor = true;
        if (parts[2] === 'scale_0' || parts[2] === 'sx') hasScale = true;
        if (parts[2] === 'rot_0' || parts[2] === 'qx') hasRot = true;
      }
    }

    // Find end_header
    const headerEndBytes = headerStr.indexOf('end_header') + 'end_header\n'.length;
    offset = headerEndBytes;

    this.points = [];
    this.numPoints = vertexCount;

    // Parse vertex data
    for (let i = 0; i < vertexCount && offset + 60 < buffer.byteLength; i++) {
      const x = data.getFloat32(offset, true); offset += 4;
      const y = data.getFloat32(offset, true); offset += 4;
      const z = data.getFloat32(offset, true); offset += 4;

      // LGM stores in SH coefficients format. Try reading colors
      let r, g, b;
      let nx = 0, ny = 0, nz = 0;

      if (hasColor) {
        r = data.getUint8(offset); offset += 1;
        g = data.getUint8(offset); offset += 1;
        b = data.getUint8(offset); offset += 1;

        // Try to skip SH coefficients if present
        // SH: 3*(degree+1)^2 floats for RGB, common in 3DGS
        // Let's try to read opacity
        if (hasScale) {
          // 3DGS format: pos(12) + opacity(4) + scales(12) + rot(16) + SH(48) = 92 bytes per vertex
          const opacity = data.getFloat32(offset, true); offset += 4;

          // Skip scales
          if (hasScale) {
            // Read one scale to check
            if (i === 0) {
              const s0 = data.getFloat32(offset, true);
              const s1 = data.getFloat32(offset + 4, true);
              const s2 = data.getFloat32(offset + 8, true);
              // If scales are tiny, it's probably splat format
              if (Math.abs(s0) < 1 && Math.abs(s1) < 1 && Math.abs(s2) < 1) {
                // Yes, it's a Gaussian splat
              }
            }
            nx = data.getFloat32(offset, true); offset += 4;
            ny = data.getFloat32(offset, true); offset += 4;
            nz = data.getFloat32(offset, true); offset += 4;
          }

          if (hasRot) {
            const qx = data.getFloat32(offset, true); offset += 4;
            const qy = data.getFloat32(offset, true); offset += 4;
            const qz = data.getFloat32(offset, true); offset += 4;
            const qw = data.getFloat32(offset, true); offset += 4;
            nx = qx; ny = qy; nz = qz;
          }

          // LGM format: 14 floats per Gaussian = 56 bytes
          // pos(3) + opacity(1) + scale(3) + rot(4) + rgb(3) = 14*4 = 56
          // But if we've already read opacity(4) and scale(12) and rot(16),
          // we might be at SH data which is 3 * (degree+1)^2 floats
          // Skip remaining SH coefficients
          // Try to skip 48 bytes (SH for degree 3)
          const remaining = buffer.byteLength - offset;
          if (remaining >= 48 && hasScale && hasRot) {
            // offset += 48; // SH0 already = rgb * 0.5
          }
        }
      } else {
        // LGM format: 14 floats = 56 bytes per splat
        // pos(3*4) + opacity(1*4) + scale(3*4) + rot(4*4) + rgb(3*4) = 56
        const opacity = data.getFloat32(offset, true); offset += 4;
        const sx = data.getFloat32(offset, true); offset += 4;
        const sy = data.getFloat32(offset, true); offset += 4;
        const sz = data.getFloat32(offset, true); offset += 4;
        const qx = data.getFloat32(offset, true); offset += 4;
        const qy = data.getFloat32(offset, true); offset += 4;
        const qz = data.getFloat32(offset, true); offset += 4;
        const qw = data.getFloat32(offset, true); offset += 4;
        r = Math.round(data.getFloat32(offset, true) * 255); offset += 4;
        g = Math.round(data.getFloat32(offset, true) * 255); offset += 4;
        b = Math.round(data.getFloat32(offset, true) * 255); offset += 4;
      }

      this.points.push({
        x, y, z,
        r: r || 255, g: g || 200, b: b || 200,
        nx: nx || 0, ny: ny || 0, nz: nz || 0,
        size: 0.02
      });
    }
  }

  _uploadBuffers() {
    const gl = this.gl;
    const count = this.points.length;

    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const scales = new Float32Array(count * 3);
    const rots = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      const p = this.points[i];
      positions[i*3] = p.x;
      positions[i*3+1] = p.y;
      positions[i*3+2] = p.z;
      colors[i*4] = p.r;
      colors[i*4+1] = p.g;
      colors[i*4+2] = p.b;
      colors[i*4+3] = 255;
      scales[i*3] = p.size;
      scales[i*3+1] = p.size;
      scales[i*3+2] = p.size;
      rots[i*4] = 0;
      rots[i*4+1] = 0;
      rots[i*4+2] = 0;
      rots[i*4+3] = 1;
    }

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.position);
    gl.vertexAttribPointer(this.attribs.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.color);
    gl.vertexAttribPointer(this.attribs.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.scaleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scales, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.scale);
    gl.vertexAttribPointer(this.attribs.scale, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, rots, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.rot);
    gl.vertexAttribPointer(this.attribs.rot, 4, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    this.numPoints = count;
  }

  _render = () => {
    this.animationId = requestAnimationFrame(this._render);
    const gl = this.gl;
    if (!gl || this.numPoints === 0) return;

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.04, 0.04, 0.05, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const mvp = this._getMVP();
    gl.uniformMatrix4fv(this.uniforms.uMVP, false, mvp);
    gl.uniform2f(this.uniforms.uFocal, this.width / (2 * Math.tan(this.fov * Math.PI / 360)), this.height / (2 * Math.tan(this.fov * Math.PI / 360)));
    gl.uniform2f(this.uniforms.uViewport, this.width, this.height);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.drawArrays(gl.POINTS, 0, this.numPoints);
  }

  // ── Mouse / Touch controls ──────────────────────────────────
  _onMouseDown(e) {
    this._isDragging = true;
    this._prevMouse = { x: e.clientX, y: e.clientY };
  }
  _onMouseMove(e) {
    if (!this._isDragging) return;
    const dx = e.clientX - this._prevMouse.x;
    const dy = e.clientY - this._prevMouse.y;
    this._yaw += dx * 0.01;
    this._pitch = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, this._pitch + dy * 0.01));
    this._prevMouse = { x: e.clientX, y: e.clientY };
  }
  _onMouseUp() { this._isDragging = false; }
  _onWheel(e) {
    e.preventDefault();
    this._radius = Math.max(0.5, Math.min(15, this._radius + e.deltaY * 0.005));
  }
  _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      this._isDragging = true;
      this._prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }
  _onTouchMove(e) {
    e.preventDefault();
    if (!this._isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - this._prevMouse.x;
    const dy = e.touches[0].clientY - this._prevMouse.y;
    this._yaw += dx * 0.01;
    this._pitch = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, this._pitch + dy * 0.01));
    this._prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  _onTouchEnd() { this._isDragging = false; }

  clear() {
    this.points = [];
    this.numPoints = 0;
  }

  destroy() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    window.removeEventListener('resize', this._onResize);
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
