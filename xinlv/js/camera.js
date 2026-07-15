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
      return await this._attachStream(this.stream);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async _attachStream(stream) {
    const video = this.video;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let heartBeatTimer = null;
      const done = (ok, val) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (heartBeatTimer) { clearInterval(heartBeatTimer); heartBeatTimer = null; }
        video.onloadedmetadata = null;
        video.oncanplay = null;
        video.onerror = null;
        if (ok) resolve(val);
        else reject(val);
      };
      timer = setTimeout(() => {
        if (video.videoWidth > 0) {
          done(true, stream);
        } else {
          done(false, new Error('视频加载超时（请检查摄像头是否被占用，或刷新页面重试）'));
        }
      }, 8000);
      heartBeatTimer = setInterval(() => {
        if (settled) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          Promise.resolve()
            .then(() => video.play && video.play().catch(() => {}))
            .then(() => done(true, stream));
        }
      }, 500);
      video.onloadedmetadata = () => {
        if (settled) return;
        Promise.resolve()
          .then(() => (video.play ? video.play() : Promise.resolve()))
          .then(() => done(true, stream))
          .catch((playErr) => {
            if (video.videoWidth > 0) { done(true, stream); }
            else done(false, playErr || new Error('无法播放视频流'));
          });
      };
      video.oncanplay = () => {
        if (settled) return;
        Promise.resolve()
          .then(() => video.play && video.play().catch(() => {}))
          .then(() => done(true, stream));
      };
      video.onerror = () => done(false, new Error('视频元素错误'));
      try {
        video.srcObject = stream;
        if (typeof video.load === 'function') {
          try { video.load(); } catch (_) {}
        }
        if (video.readyState >= 1 && video.videoWidth > 0) {
          Promise.resolve()
            .then(() => video.play && video.play().catch(() => {}))
            .then(() => done(true, stream));
        }
      } catch (e) {
        done(false, e);
      }
    }).then((stream) => {
      this.stream = stream;
      const track = this.stream && this.stream.getVideoTracks ? this.stream.getVideoTracks()[0] : null;
      if (track) {
        const settings = track.getSettings();
        this.currentDeviceId = settings.deviceId || null;
        if (settings.facingMode) this.currentFacingMode = settings.facingMode;
      }
      this._startFrameLoop();
      return this.stream;
    });
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
