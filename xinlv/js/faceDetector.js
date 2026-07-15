class FaceDetector {
  constructor(options = {}) {
    this.options = {
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.3,
      minTrackingConfidence: 0.3,
      sendTimeoutMs: 2500,
      initTimeoutMs: 30000,
      roiOptions: {
        useForehead: true,
        useCheeks: true,
        foreheadScale: { w: 0.6, h: 0.18 },
        cheekScale: { w: 0.22, h: 0.18 }
      },
      ...options
    };
    this.faceMesh = null;
    this._onResultsCallbacks = [];
    this._lastLandmarks = null;
    this._lastROIs = null;
    this._faceDetected = false;
    this._initPromise = null;
    this._processingFrame = false;
    this._bufCanvas = document.createElement('canvas');
    this._bufCtx = this._bufCanvas.getContext('2d', { willReadFrequently: true });
    this._stats = {
      sendCount: 0, recvCount: 0, successCount: 0,
      timeoutCount: 0, failCount: 0,
      lastSendAt: 0, lastRecvAt: 0, lastError: null
    };
    this._initDone = false;
    this._forceCanvasSend = false;
    this._cdnBaseOverride = null;
    if (typeof window !== 'undefined' && typeof window.__getFaceMeshBase === 'function') {
      try { this._cdnBaseOverride = window.__getFaceMeshBase(); } catch (_) {}
    }
    this._cdnTried = 0;
  }

  get lastLandmarks() { return this._lastLandmarks; }
  get lastROIs() { return this._lastROIs; }
  get isFaceDetected() { return this._faceDetected; }
  get stats() { return { ...this._stats }; }

  _currentCdnBase() {
    if (typeof window !== 'undefined' && typeof window.__getFaceMeshBase === 'function') {
      try {
        const b = window.__getFaceMeshBase();
        if (b) { this._cdnBaseOverride = b; return b; }
      } catch (_) {}
    }
    if (this._cdnBaseOverride) return this._cdnBaseOverride;
    return 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619';
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().catch(async (e) => {
      try { if (this.faceMesh && typeof this.faceMesh.close === 'function') this.faceMesh.close(); } catch (_) {}
      this.faceMesh = null;
      this._initPromise = null;
      this._initDone = false;
      this._forceCanvasSend = false;
      this._cdnTried++;
      const maxTry = 4;
      if (this._cdnTried < maxTry) {
        this._cdnBaseOverride = null;
        this._stats.lastError = `第 ${this._cdnTried} 次初始化失败，切换 CDN 配置重试...`;
        return this.init();
      }
      const nerr = new Error('FaceMesh 初始化失败：' + ((e && e.message) || String(e)));
      nerr.code = (e && e.code) || 'INIT_FAIL';
      nerr.inner = e;
      this._stats.lastError = (e && e.message) || String(e);
      throw nerr;
    });
    return this._initPromise;
  }

  async _doInit() {
    if (typeof FaceMesh === 'undefined') {
      const err = new Error('FaceMesh 脚本未加载（CDN 被拦截或网络异常）');
      err.code = 'CDN_LOAD_FAIL';
      throw err;
    }
    const cdnBase = this._currentCdnBase();
    this._stats.lastError = `正在加载 FaceMesh 模型...（CDN: ${cdnBase.substring(0, 60)}...）`;

    const self = this;
    let cdnScriptLoadError = null;
    const scriptFailHandler = (ev) => {
      try {
        let src = null;
        let msgFrag = null;
        if (ev && ev.target && (ev.target.src || (ev.target.href && ev.target.getAttribute('src')))) {
          src = ev.target.src || ev.target.getAttribute('src');
        }
        if (ev && ev.message && typeof ev.message === 'string') {
          msgFrag = ev.message;
        } else if (ev && ev.reason && ev.reason.message) {
          msgFrag = ev.reason.message;
        }
        const srcMatch = typeof src === 'string' && (src.indexOf('/face_mesh') >= 0 || src.indexOf('mediapipe') >= 0);
        const msgMatch = typeof msgFrag === 'string' && (msgFrag.indexOf('face_mesh') >= 0 || msgFrag.indexOf('SyntaxError') >= 0 || msgFrag.indexOf('reserved word') >= 0 || msgFrag.indexOf('Cannot read') >= 0);
        if (srcMatch || msgMatch) {
          const desc = (src || msgFrag || '未知错误');
          cdnScriptLoadError = new Error('脚本加载/解析失败：' + desc);
          if (typeof console !== 'undefined' && console.warn) console.warn('[FaceMesh] CDN fail:', desc);
        }
      } catch (_) {}
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('error', scriptFailHandler, true);
      window.addEventListener('unhandledrejection', scriptFailHandler, true);
    }

    this.faceMesh = new FaceMesh({
      locateFile: (file) => {
        const base = self._currentCdnBase();
        const url = `${base}/${file}`;
        return url;
      }
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

    const initTimeoutP = new Promise((_, reject) => {
      setTimeout(() => {
        if (cdnScriptLoadError) {
          const ferr = new Error('CDN 资源加载失败：' + (cdnScriptLoadError.message || cdnScriptLoadError));
          ferr.code = 'CDN_FALLBACK_NEEDED';
          reject(ferr);
        } else {
          reject(new Error('FaceMesh 初始化超时（WASM 下载失败）'));
        }
      }, this.options.initTimeoutMs);
    });

    const initP = (async () => {
      if (cdnScriptLoadError) {
        const ferr = new Error('CDN 资源加载失败：' + (cdnScriptLoadError.message || cdnScriptLoadError));
        ferr.code = 'CDN_FALLBACK_NEEDED';
        throw ferr;
      }
      try {
        const warmImgData = warmCtx.getImageData(0, 0, 64, 64);
        const warmSendP = this.faceMesh.send({ image: warmImgData });
        const warmTimeoutP = new Promise((_, rj) => {
          setTimeout(() => rj(new Error('warmup timeout')), 4000);
        });
        await Promise.race([warmSendP, warmTimeoutP]);
      } catch (e) {
        if (cdnScriptLoadError) {
          const ferr = new Error('CDN 资源加载失败：' + (cdnScriptLoadError.message || cdnScriptLoadError));
          ferr.code = 'CDN_FALLBACK_NEEDED';
          throw ferr;
        }
      }
      if (cdnScriptLoadError) {
        const ferr = new Error('CDN 资源加载失败：' + (cdnScriptLoadError.message || cdnScriptLoadError));
        ferr.code = 'CDN_FALLBACK_NEEDED';
        throw ferr;
      }
      await firstResultPromise;
      await new Promise(resolve => setTimeout(resolve, 150));
      if (cdnScriptLoadError) {
        const ferr = new Error('CDN 资源加载失败：' + (cdnScriptLoadError.message || cdnScriptLoadError));
        ferr.code = 'CDN_FALLBACK_NEEDED';
        throw ferr;
      }
      this._initDone = true;
      return true;
    })();

    try {
      await Promise.race([initTimeoutP, initP]);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const nerr = new Error(msg);
      nerr.code = (e && e.code) || 'INIT_FAIL';
      nerr.inner = e;
      this._stats.lastError = msg;
      throw nerr;
    } finally {
      this._initDone = true;
      if (firstResultTimer) clearTimeout(firstResultTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('error', scriptFailHandler, true);
        window.removeEventListener('unhandledrejection', scriptFailHandler, true);
      }
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
    let sendInput = null;
    let inputType = null;
    try {
      if (imageSource && imageSource.tagName === 'VIDEO') {
        const v = imageSource;
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
          const w = Math.max(1, Math.floor(v.videoWidth * scale));
          const h = Math.max(1, Math.floor(v.videoHeight * scale));
          if (this._bufCanvas.width !== w || this._bufCanvas.height !== h) {
            this._bufCanvas.width = w;
            this._bufCanvas.height = h;
          }
          this._bufCtx.drawImage(v, 0, 0, w, h);
          sendInput = this._bufCtx.getImageData(0, 0, w, h);
          inputType = 'imagedata';
        } else {
          this._processingFrame = false;
          return;
        }
      } else if (imageSource && imageSource.tagName === 'CANVAS') {
        const c = imageSource;
        const w = c.width, h = c.height;
        const ctx = c.getContext('2d');
        if (ctx) {
          sendInput = ctx.getImageData(0, 0, w, h);
          inputType = 'imagedata';
        } else {
          this._processingFrame = false;
          return;
        }
      } else if (imageSource instanceof ImageData) {
        sendInput = imageSource;
        inputType = 'imagedata';
      } else {
        this._processingFrame = false;
        return;
      }
      if (!sendInput) {
        this._processingFrame = false;
        return;
      }
      this._stats.sendCount++;
      this._stats.lastSendAt = performance.now();
      const sendTask = this.faceMesh.send({ image: sendInput });
      const timeoutMs = this.options.sendTimeoutMs || 2500;
      const timeoutTask = new Promise((_, reject) => {
        setTimeout(() => {
          const terr = new Error('FaceMesh 处理超时（> ' + timeoutMs + 'ms）[' + inputType + ']');
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
        this._stats.timeoutCount++;
        if (this._initDone && this._stats.timeoutCount >= 3 && this._forceCanvasSend !== true) {
          this._forceCanvasSend = true;
          this._stats.lastError = msg + ' · 切换 Canvas 路径重试';
        }
        if (this._initDone && typeof this.faceMesh === 'object' && this.faceMesh && typeof this.faceMesh.close === 'function' && this._stats.timeoutCount >= 12) {
          try { this.faceMesh.close(); } catch (_) {}
          this.faceMesh = null;
        }
      } else {
        this._stats.failCount++;
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
    if (!lm[10] || !lm[338] || !lm[297] || !lm[332] || !lm[284]) return null;
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
    let faceEdge, cheekCenter, underEye, noseSide, mouthCorner;
    if (side === 'left') {
      faceEdge = lm[234];
      cheekCenter = lm[205];
      underEye = lm[233];
      noseSide = lm[50];
      mouthCorner = lm[61];
    } else {
      faceEdge = lm[454];
      cheekCenter = lm[425];
      underEye = lm[450];
      noseSide = lm[280];
      mouthCorner = lm[291];
    }
    if (!faceEdge || !cheekCenter || !underEye || !noseSide || !mouthCorner) return null;
    const cx = cheekCenter.x;
    const cy = (underEye.y + mouthCorner.y) / 2;
    const faceWidth = Math.abs(lm[234].x - lm[454].x);
    const w = faceWidth * scale.w * 1.3;
    const h = Math.abs(mouthCorner.y - underEye.y) * scale.h * 1.6;
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
