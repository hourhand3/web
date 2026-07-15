class FaceDetector {
  constructor(options = {}) {
    this.options = {
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.3,
      minTrackingConfidence: 0.3,
      sendTimeoutMs: 2500,
      initTimeoutMs: 20000,
      roiOptions: {
        useForehead: true,
        useCheeks: true,
        foreheadScale: { w: 0.6, h: 0.18 },
        cheekScale: { w: 0.22, h: 0.18 }
      },
      ...options
    };
    this.faceMesh = null;
    this.camera = null;
    this._onResultsCallbacks = [];
    this._lastLandmarks = null;
    this._lastROIs = null;
    this._faceDetected = false;
    this._initPromise = null;
    this._processingFrame = false;
    this._pendingSendPromise = null;
    this._bufCanvas = document.createElement('canvas');
    this._bufCtx = this._bufCanvas.getContext('2d', { willReadFrequently: false });
    this._stats = {
      sendCount: 0, recvCount: 0, successCount: 0,
      timeoutCount: 0, failCount: 0,
      lastSendAt: 0, lastRecvAt: 0, lastError: null
    };
    this._initDone = false;
  }

  get lastLandmarks() { return this._lastLandmarks; }
  get lastROIs() { return this._lastROIs; }
  get isFaceDetected() { return this._faceDetected; }
  get stats() { return { ...this._stats }; }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (typeof FaceMesh === 'undefined') {
      const err = new Error('FaceMesh 脚本未加载（CDN 被拦截或网络异常）');
      err.code = 'CDN_LOAD_FAIL';
      throw err;
    }
    this.faceMesh = new FaceMesh({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    this.faceMesh.setOptions({
      maxNumFaces: this.options.maxNumFaces,
      refineLandmarks: this.options.refineLandmarks,
      minDetectionConfidence: this.options.minDetectionConfidence,
      minTrackingConfidence: this.options.minTrackingConfidence
    });
    let firstResultResolve = null;
    let firstResultTimer = null;
    const firstResultPromise = new Promise((resolve) => { firstResultResolve = resolve; });
    const onceHandler = () => {
      if (firstResultResolve) { firstResultResolve(true); firstResultResolve = null; }
      if (firstResultTimer) { clearTimeout(firstResultTimer); firstResultTimer = null; }
    };
    this.faceMesh.onResults((results) => {
      if (!this._initDone) onceHandler();
      this._onResults(results);
    });
    firstResultTimer = setTimeout(() => { if (firstResultResolve) firstResultResolve(false); }, 5000);

    const warmCanvas = document.createElement('canvas');
    warmCanvas.width = 64; warmCanvas.height = 64;
    const warmCtx = warmCanvas.getContext('2d');
    warmCtx.fillStyle = '#8866aa'; warmCtx.fillRect(0, 0, 64, 64);
    try {
      const initTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('FaceMesh 初始化超时（WASM 下载失败）')), this.options.initTimeoutMs);
      });
      const initSteps = Promise.resolve().then(async () => {
        try { await this.faceMesh.send({ image: warmCanvas }); } catch (e) {}
        await firstResultPromise;
        await new Promise(resolve => setTimeout(resolve, 150));
        return true;
      });
      await Promise.race([initTimeout, initSteps]);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const nerr = new Error('FaceMesh 初始化失败：' + msg);
      nerr.code = 'INIT_FAIL';
      nerr.inner = e;
      this._stats.lastError = msg;
      throw nerr;
    } finally {
      this._initDone = true;
      if (firstResultTimer) clearTimeout(firstResultTimer);
    }
  }

  onResults(callback) {
    if (typeof callback === 'function') {
      this._onResultsCallbacks.push(callback);
    }
  }

  setROIOptions(opt) {
    this.options.roiOptions = { ...this.options.roiOptions, ...opt };
  }

  async send(imageSource) {
    if (!this.faceMesh || this._processingFrame) return;
    this._processingFrame = true;
    let timedOut = false;
    try {
      let input = imageSource;
      if (imageSource && imageSource.tagName === 'VIDEO') {
        const v = imageSource;
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
          const w = Math.max(1, Math.floor(v.videoWidth * scale));
          const h = Math.max(1, Math.floor(v.videoHeight * scale));
          if (this._bufCanvas.width !== w || this._bufCanvas.height !== h) {
            this._bufCanvas.width = w;
            this._bufCanvas.height = h;
          }
          this._bufCtx.drawImage(v, 0, 0, w, h);
          input = this._bufCanvas;
        } else {
          this._processingFrame = false;
          return;
        }
      }
      this._stats.sendCount++;
      this._stats.lastSendAt = performance.now();
      const sendTask = this.faceMesh.send({ image: input });
      const timeoutMs = this.options.sendTimeoutMs || 2500;
      const timeoutTask = new Promise((_, reject) => {
        setTimeout(() => {
          const terr = new Error('FaceMesh 处理超时（> ' + timeoutMs + 'ms）');
          terr.code = 'SEND_TIMEOUT';
          reject(terr);
        }, timeoutMs);
      });
      await Promise.race([sendTask, timeoutTask]);
    } catch (e) {
      const code = e && e.code;
      const msg = (e && e.message) || String(e);
      this._stats.lastError = msg;
      if (code === 'SEND_TIMEOUT') {
        timedOut = true;
        this._stats.timeoutCount++;
        console.warn('[FaceMesh] send timeout. T=', this._stats.timeoutCount);
        if (typeof this.faceMesh === 'object' && this.faceMesh && typeof this.faceMesh.close === 'function' && this._stats.timeoutCount >= 3) {
          try { this.faceMesh.close(); } catch (_) {}
          this.faceMesh = null;
        }
      } else {
        this._stats.failCount++;
        console.warn('[FaceMesh] send error:', e);
      }
    } finally {
      this._processingFrame = false;
    }
  }

  _onResults(results) {
    this._stats.recvCount++;
    this._stats.lastRecvAt = performance.now();
    const multiFace = results.multiFaceLandmarks;
    if (multiFace && multiFace.length > 0) {
      const landmarks = multiFace[0];
      this._lastLandmarks = landmarks;
      this._faceDetected = true;
      this._lastROIs = this._extractROIs(landmarks);
      this._stats.successCount++;
    } else {
      this._faceDetected = false;
    }
    for (const cb of this._onResultsCallbacks) {
      try { cb({ detected: this._faceDetected, landmarks: this._lastLandmarks, rois: this._lastROIs }); }
      catch (e) { console.error(e); }
    }
  }

  _extractROIs(landmarks) {
    const opts = this.options.roiOptions;
    const rois = [];
    if (opts.useForehead) {
      const forehead = this._foreheadROI(landmarks, opts.foreheadScale);
      if (forehead) rois.push({ name: 'forehead', ...forehead });
    }
    if (opts.useCheeks) {
      const left = this._cheekROI(landmarks, 'left', opts.cheekScale);
      const right = this._cheekROI(landmarks, 'right', opts.cheekScale);
      if (left) rois.push({ name: 'leftCheek', ...left });
      if (right) rois.push({ name: 'rightCheek', ...right });
    }
    return rois;
  }

  _foreheadROI(lm, scale) {
    const p10 = lm[10], p338 = lm[338], p297 = lm[297];
    const p332 = lm[332], p284 = lm[284];
    const cx = (p338.x + p297.x) / 2;
    const topY = p10.y;
    const browY = Math.min(p332.y, p284.y);
    const faceWidth = Math.abs(p297.x - p338.x) * 1.15;
    const w = faceWidth * scale.w;
    const h = Math.max(Math.abs(browY - topY) * 1.4, faceWidth * scale.h);
    const x = cx - w / 2;
    const y = topY + Math.abs(browY - topY) * 0.15;
    return this._toRect(x, y, w, h);
  }

  _cheekROI(lm, side, scale) {
    let anchor, outer, inner;
    if (side === 'left') {
      anchor = lm[234]; outer = lm[227]; inner = lm[454];
    } else {
      anchor = lm[454]; outer = lm[447]; inner = lm[234];
    }
    const underEye = side === 'left' ? lm[233] : lm[450];
    const nose = side === 'left' ? lm[50] : lm[280];
    const cx = (anchor.x + inner.x) / 2;
    const cy = (underEye.y + nose.y) / 2;
    const faceHalfWidth = Math.abs(outer.x - inner.x);
    const w = faceHalfWidth * scale.w * 1.8;
    const h = Math.abs(nose.y - underEye.y) * scale.h * 2.2;
    const x = cx - w / 2;
    const y = cy - h / 2;
    return this._toRect(x, y, w, h);
  }

  _toRect(x, y, w, h) {
    const clampedX = Math.max(0, Math.min(0.98, x));
    const clampedY = Math.max(0, Math.min(0.98, y));
    const maxW = 1 - clampedX - 0.01;
    const maxH = 1 - clampedY - 0.01;
    return {
      x: clampedX,
      y: clampedY,
      w: Math.max(0.02, Math.min(w, maxW)),
      h: Math.max(0.02, Math.min(h, maxH))
    };
  }

  sampleROIPixels(imageData, width, height, roiPx) {
    const x0 = Math.max(0, Math.floor(roiPx.x));
    const y0 = Math.max(0, Math.floor(roiPx.y));
    const rw = Math.max(2, Math.min(width - x0, Math.floor(roiPx.w)));
    const rh = Math.max(2, Math.min(height - y0, Math.floor(roiPx.h)));
    if (x0 >= width || y0 >= height || rw < 2 || rh < 2) {
      return { r: 0, g: 0, b: 0, valid: false };
    }
    const step = Math.max(1, Math.floor(Math.min(rw, rh) / 20));
    let r = 0, g = 0, b = 0, count = 0;
    const data = imageData.data;
    const xEnd = x0 + rw;
    const yEnd = y0 + rh;
    for (let y = y0; y < yEnd; y += step) {
      if (y >= height) break;
      const rowBase = y * width;
      for (let x = x0; x < xEnd; x += step) {
        if (x >= width) break;
        const idx = (rowBase + x) * 4;
        r += data[idx];
        g += data[idx + 1];
        b += data[idx + 2];
        count++;
      }
    }
    if (count === 0) return { r: 0, g: 0, b: 0, valid: false };
    return { r: r / count, g: g / count, b: b / count, valid: true };
  }
}

if (typeof window !== 'undefined') {
  window.FaceDetector = FaceDetector;
}
