/**
 * Mesh Viewer — Three.js OBJ/GLTF viewer with OrbitControls
 */
class MeshViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.currentMesh = null;
    this.animationId = null;
    this._init();
  }

  _init() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0c);

    // Camera
    const rect = this.container.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(30, rect.width / rect.height, 0.1, 100);
    this.camera.position.set(0, 0.5, 3.5);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(rect.width, rect.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 10;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 2.0;
    this.controls.target.set(0, 0, 0);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(2, 3, 4);
    this.scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4);
    fillLight.position.set(-2, 1, -2);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
    rimLight.position.set(0, -1, -3);
    this.scene.add(rimLight);

    // Ground grid
    const gridHelper = new THREE.GridHelper(4, 20, 0x333355, 0x222244);
    gridHelper.position.y = -0.5;
    this.scene.add(gridHelper);

    // Resize
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    // Auto-animate
    this._animate();
  }

  _animate() {
    this.animationId = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height);
  }

  loadMesh(url, format = 'glb') {
    // Remove old mesh
    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
      this.currentMesh = null;
    }

    const loader = format === 'obj'
      ? new THREE.OBJLoader()
      : new THREE.GLTFLoader();

    this.controls.autoRotate = false;

    loader.load(
      url,
      (obj) => {
        if (format === 'glb') obj = obj.scene;

        // Center and scale
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 1.8 / maxDim;

        obj.position.sub(center);
        obj.position.multiplyScalar(scale);
        obj.scale.setScalar(scale);

        // Apply material enhancements
        obj.traverse((child) => {
          if (child.isMesh) {
            child.material.side = THREE.DoubleSide;
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        this.currentMesh = obj;
        this.scene.add(obj);

        // Reset camera
        this.camera.position.set(0, 0.5, 3.5);
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        setTimeout(() => {
          this.controls.autoRotate = true;
        }, 2000);
      },
      undefined,
      (err) => console.error('Mesh load error:', err)
    );
  }

  clear() {
    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
      this.currentMesh = null;
    }
  }

  destroy() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
