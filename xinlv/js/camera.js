class CameraManager {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.currentFacingMode = 'user';
    this.devices = [];
    this.currentDeviceId = null;
    this.onFrameCallbacks = [];
    this._frameLoopId = null;
    this._lastFrameTime = 0;
    this._fps = 0;
    this._fpsCounter = 0;
    this._fpsLastUpdate = 0;
  }

  get fps() { return this._fps; }
  get isRunning() { return !!this.stream && this.stream.active; }
  get facingMode() { return this.currentFacingMode; }

  async enumerateDevices() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        throw new Error('浏览器不支持设备枚举');
      }
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      this.devices = allDevices.filter(d => d.kind === 'videoinput');
      return this.devices;
    } catch (err) {
      console.warn('[Camera] 枚举设备失败:', err);
      return [];
    }
  }

  async start(constraints = {}) {
    try {
      await this.stop();
      const finalConstraints = this._buildConstraints(constraints);
      this.stream = await navigator.mediaDevices.getUserMedia(finalConstraints);
      this.video.srcObject = this.stream;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('视频加载超时')), 8000);
        this.video.onloadedmetadata = () => {
          clearTimeout(timeout);
          this.video.play().then(resolve).catch(reject);
        };
        this.video.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('视频元素错误'));
        };
      });

      const track = this.stream.getVideoTracks()[0];
      if (track) {
        const settings = track.getSettings();
        this.currentDeviceId = settings.deviceId || null;
        if (settings.facingMode) {
          this.currentFacingMode = settings.facingMode;
        }
      }

      this._startFrameLoop();
      return this.stream;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop() {
    if (this._frameLoopId) {
      cancelAnimationFrame(this._frameLoopId);
      this._frameLoopId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video.srcObject) {
      this.video.srcObject = null;
    }
    this._fps = 0;
  }

  async switchCamera() {
    const devices = await this.enumerateDevices();
    if (devices.length < 2) {
      this.currentFacingMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
      return this.start();
    }
    const currentIndex = devices.findIndex(d => d.deviceId === this.currentDeviceId);
    const nextIndex = (currentIndex + 1) % devices.length;
    const nextDevice = devices[nextIndex];
    return this.start({ deviceId: nextDevice.deviceId });
  }

  hasMultipleCameras() {
    return this.devices.length >= 2;
  }

  onFrame(callback) {
    if (typeof callback === 'function') {
      this.onFrameCallbacks.push(callback);
    }
  }

  _buildConstraints(userConstraints) {
    if (userConstraints.deviceId) {
      return {
        video: {
          deviceId: { exact: userConstraints.deviceId },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, min: 15 }
        },
        audio: false
      };
    }
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const facing = userConstraints.facingMode || (isMobile ? 'user' : 'user');
    this.currentFacingMode = facing;
    return {
      video: {
        facingMode: { ideal: facing },
        width: { ideal: isMobile ? 480 : 640, max: 1280 },
        height: { ideal: isMobile ? 360 : 480, max: 720 },
        frameRate: { ideal: 30, min: 15 }
      },
      audio: false
    };
  }

  _startFrameLoop() {
    const loop = (t) => {
      this._frameLoopId = requestAnimationFrame(loop);
      if (!this.video.videoWidth) return;

      this._fpsCounter++;
      if (t - this._fpsLastUpdate >= 1000) {
        this._fps = Math.round(this._fpsCounter * 1000 / (t - this._fpsLastUpdate));
        this._fpsCounter = 0;
        this._fpsLastUpdate = t;
      }

      for (const cb of this.onFrameCallbacks) {
        try { cb(t); } catch (e) { console.error(e); }
      }
      this._lastFrameTime = t;
    };
    this._fpsLastUpdate = performance.now();
    this._frameLoopId = requestAnimationFrame(loop);
  }
}

if (typeof window !== 'undefined') {
  window.CameraManager = CameraManager;
}
