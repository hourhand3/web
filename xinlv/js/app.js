class RPPGApp {
  constructor() {
    this.els = this._collectElements();
    this.visualizer = new Visualizer(this.els);
    this.camera = new CameraManager(this.els.video);
    this.face = new FaceDetector();
    this.processor = new RPPGProcessor();
    this.settings = this._loadSettings();

    this._running = false;
    this._samplingReady = false;
    this._stabilizeFrames = 0;
    this._roiBufferCanvas = document.createElement('canvas');
    this._roiBufferCtx = this._roiBufferCanvas.getContext('2d', { willReadFrequently: true });
    this._lastFaceProcessTime = 0;
    this._faceProcessInterval = 66;
    this._pixelSampleCount = 0;
    this._faceMissingFrames = 0;
    this._sampleFailCount = 0;
    this._lastSampleROIs = null;
    this._firstFaceSendAt = 0;
    this._faceDeadlineWarned = false;
    this._faceReinitInProgress = false;

    this._bindUI();
    this._applySettings();
    this._setupProcessorCallbacks();
    this._setupCameraCallbacks();
    this._enumerateCameras();
  }

  _collectElements() {
    const $ = (id) => document.getElementById(id);
    return {
      video: $('video'),
      faceCanvas: $('face-canvas'),
      roiCanvas: $('roi-canvas'),
      waveformCanvas: $('waveform-canvas'),
      statusOverlay: $('status-overlay'),
      statusIcon: $('status-icon'),
      statusText: $('status-text'),
      statusSubtext: $('status-subtext'),
      bpmValue: $('bpm-value'),
      bpmConfidence: $('bpm-confidence'),
      fpsValue: $('fps-value'),
      windowValue: $('window-value'),
      stabilityValue: $('stability-value'),
      cameraLabel: $('camera-label'),
      btnStart: $('btn-start'),
      btnStop: $('btn-stop'),
      btnReset: $('btn-reset'),
      btnSettings: $('btn-settings'),
      btnCloseSettings: $('btn-close-settings'),
      btnSwitchCamera: $('btn-switch-camera'),
      settingsModal: $('settings-modal'),
      settingAlgorithm: $('setting-algorithm'),
      settingWindowsize: $('setting-windowsize'),
      settingDebug: $('setting-debug'),
      roiForehead: $('roi-forehead'),
      roiCheeks: $('roi-cheeks')
    };
  }

  _bindUI() {
    this.els.btnStart.addEventListener('click', () => this.start());
    this.els.btnStop.addEventListener('click', () => this.stop());
    this.els.btnReset.addEventListener('click', () => this.reset());
    this.els.btnSettings.addEventListener('click', () => this.els.settingsModal.classList.remove('hidden'));
    this.els.btnCloseSettings.addEventListener('click', () => this.els.settingsModal.classList.add('hidden'));
    this.els.settingsModal.addEventListener('click', (e) => {
      if (e.target === this.els.settingsModal) this.els.settingsModal.classList.add('hidden');
    });
    this.els.btnSwitchCamera.addEventListener('click', () => this._switchCamera());
    [
      ['settingAlgorithm', 'algorithm'],
      ['settingWindowsize', 'windowSize', true]
    ].forEach(([id, key, isNum]) => {
      this.els[id].addEventListener('change', () => {
        this.settings[key] = isNum ? parseInt(this.els[id].value, 10) : this.els[id].value;
        this._saveSettings();
        this._applySettings();
      });
    });
    ['roiForehead', 'roiCheeks'].forEach(id => {
      this.els[id].addEventListener('change', () => {
        this.settings[id] = this.els[id].checked;
        this._saveSettings();
        this._applyROISettings();
      });
    });
    this.els.settingDebug.addEventListener('change', () => {
      this.settings.debug = this.els.settingDebug.checked;
      this._saveSettings();
    });
  }

  _loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('rppg_settings') || '{}'); } catch {}
    return {
      algorithm: saved.algorithm || 'pos',
      windowSize: parseInt(saved.windowSize, 10) || 300,
      roiForehead: saved.roiForehead !== false,
      roiCheeks: saved.roiCheeks !== false,
      debug: !!saved.debug
    };
  }

  _saveSettings() {
    try { localStorage.setItem('rppg_settings', JSON.stringify(this.settings)); } catch {}
  }

  _applySettings() {
    this.els.settingAlgorithm.value = this.settings.algorithm;
    this.els.settingWindowsize.value = String(this.settings.windowSize);
    this.els.roiForehead.checked = this.settings.roiForehead;
    this.els.roiCheeks.checked = this.settings.roiCheeks;
    this.els.settingDebug.checked = !!this.settings.debug;
    this.processor.setOptions({
      algorithm: this.settings.algorithm,
      windowSize: this.settings.windowSize
    });
    this._applyROISettings();
  }

  _applyROISettings() {
    this.face.setROIOptions({
      useForehead: this.settings.roiForehead,
      useCheeks: this.settings.roiCheeks
    });
  }

  _setupProcessorCallbacks() {
    this.processor.onUpdate((state) => {
      this.visualizer.updateBPM(state.bpm, state.confidence, state.diagnostics);
      this.visualizer.drawWaveform(state.raw, state.filtered);
      this.visualizer.updateInfo({
        fps: this.camera.fps || state.fps,
        samples: state.samples,
        stability: this.processor.signalQuality,
        cameraLabel: this._currentCameraLabel()
      });
    });
  }

  _setupCameraCallbacks() {
    this.camera.onFrame(() => this._processFrame());
  }

  async _enumerateCameras() {
    const devices = await this.camera.enumerateDevices();
    if (devices.length >= 2) {
      this.els.btnSwitchCamera.style.display = 'inline-flex';
    }
  }

  _currentCameraLabel() {
    const fm = this.camera.facingMode;
    const map = { user: '前置', environment: '后置' };
    return map[fm] || (this.camera.isRunning ? '已连接' : '未连接');
  }

  async start() {
    if (this._running) return;
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw Object.assign(new Error('当前环境不支持摄像头访问'), {
          code: 'NO_GUM',
          message: '当前环境不支持摄像头访问（非安全上下文或浏览器不兼容）。请使用 https:// 或 localhost 访问，并使用最新版 Chrome / Safari / Edge 浏览器'
        });
      }
      this.visualizer.updateStatus('loading', '正在启动摄像头...', '请在弹出的权限请求中点击「允许」');
      await this.camera.start();
      this._running = true;
      this._stabilizeFrames = 0;
      this._samplingReady = false;
      this._pixelSampleCount = 0;
      this._sampleFailCount = 0;
      this._lastSampleROIs = null;
      this._firstFaceSendAt = 0;
      this._faceDeadlineWarned = false;
      this._faceReinitInProgress = false;
      this.visualizer.setButtonsState({ started: true });
      this.visualizer.updateStatus('loading', '正在加载人脸检测模型...', '正在初始化 MediaPipe，请稍候');
      if (typeof FaceMesh === 'undefined') {
        throw Object.assign(new Error('FaceMesh 脚本未加载'), {
          code: 'CDN_LOAD_FAIL',
          message: 'FaceMesh 脚本未加载（CDN 被拦截或网络异常）'
        });
      }
      try {
        await this.face.init();
      } catch (initErr) {
        const code = initErr && initErr.code;
        const inner = initErr && initErr.inner;
        const innerCode = inner && inner.code;
        if (code === 'CDN_LOAD_FAIL' || innerCode === 'CDN_LOAD_FAIL' || (initErr && String(initErr.message || initErr).indexOf('FaceMesh 脚本未加载') >= 0)) {
          throw Object.assign(new Error('FaceMesh CDN 加载失败'), {
            code: 'CDN_LOAD_FAIL',
            message: 'FaceMesh 脚本未加载（CDN 被拦截或网络异常）。请检查网络，确保可以访问 cdn.jsdelivr.net，或开启代理后刷新页面'
          });
        }
        throw initErr;
      }
      this.visualizer.updateStatus('detecting', '正在检测人脸', '请将面部正对摄像头，保持静止');
      await this._enumerateCameras();
    } catch (err) {
      console.error(err);
      this.visualizer.updateStatus('error', '启动失败', this._friendlyError(err));
      await this.stop();
    }
  }

  async stop() {
    this._running = false;
    this._samplingReady = false;
    await this.camera.stop();
    this.visualizer.clearFaceCanvas();
    this.visualizer.clearROI();
    this.visualizer.setButtonsState({ started: false });
    if (!this.processor.bpm) {
      this.visualizer.updateStatus('idle', '点击「开始检测」启动摄像头', '');
    } else {
      this.visualizer.updateStatus('success', `检测完成 · 当前心率 ${this.processor.bpm} BPM`, '点击「开始检测」重新测量');
    }
  }

  reset() {
    this.processor.reset();
    this.visualizer.updateBPM(null, 0);
    this.visualizer.drawWaveform([], []);
    this.visualizer.updateInfo({
      fps: this.camera.fps || null,
      samples: 0,
      stability: 0,
      cameraLabel: this._currentCameraLabel()
    });
    this._sampleFailCount = 0;
    this._lastSampleROIs = null;
    if (!this._running) {
      this.visualizer.updateStatus('idle', '点击「开始检测」启动摄像头', '');
    }
  }

  async _switchCamera() {
    if (!this._running) return;
    try {
      this.visualizer.updateStatus('loading', '切换摄像头中...', '');
      await this.camera.switchCamera();
      this.visualizer.updateStatus('hide');
    } catch (err) {
      this.visualizer.updateStatus('error', '切换失败', this._friendlyError(err));
    }
  }

  _processFrame() {
    if (!this._running) return;
    const video = this.els.video;
    if (!video.videoWidth || !video.videoHeight) return;

    const faceReady = !!this.face.faceMesh && this.face._initDone;

    if (this._stabilizeFrames < 60) {
      this._stabilizeFrames++;
      const initMsg = !faceReady ? ' · 检测模型加载中' : '';
      if (this._stabilizeFrames === 30) {
        this.visualizer.updateStatus('detecting', '正在检测人脸', '摄像头曝光稳定中，请稍候' + initMsg);
      } else if (!this._samplingReady && this._stabilizeFrames > 30) {
        const remain = Math.max(0, Math.ceil((60 - this._stabilizeFrames) / 30));
        this.visualizer.updateStatus('detecting', '正在检测人脸', `摄像头曝光稳定中，约 ${remain}s 后开始检测 · ${video.videoWidth}×${video.videoHeight}${initMsg}`);
      }
      return;
    }

    const now = performance.now();
    if (now - this._lastFaceProcessTime >= this._faceProcessInterval) {
      this._lastFaceProcessTime = now;
      try {
        if (this.face.faceMesh === null) {
          const initInProgress = this.face._initPromise && !this.face._initDone;
          if (initInProgress) {
            const stats = this.face.stats;
            const extra = stats.lastError ? ' · 最近错误：' + stats.lastError : '';
            this.visualizer.updateStatus('loading', '正在加载人脸检测模型...', 'WASM / 模型下载中，请稍候（首次加载可能需要 5-20s）' + extra);
          } else if (!this._faceReinitInProgress) {
            this._faceReinitInProgress = true;
            this.face._initPromise = null;
            this.visualizer.updateStatus('error', '检测引擎异常，正在尝试恢复...', '若仍失败请刷新页面（检测模型加载异常）');
            this.face.init().then(() => {
              this._faceDeadlineWarned = false;
              this._faceReinitInProgress = false;
              this.visualizer.updateStatus('detecting', '检测引擎已恢复，正在重新检测人脸', '请将面部正对摄像头');
            }).catch((e) => {
              this._faceReinitInProgress = false;
              console.error(e);
              this.visualizer.updateStatus('error', '检测引擎恢复失败', this._friendlyError(e) + ' · 请刷新页面或检查网络');
            });
          }
        } else {
          this.face.send(video);
        }
      } catch (e) {}
    }

    const stats = this.face.stats;
    if (stats.sendCount > 0 && this._firstFaceSendAt === 0) this._firstFaceSendAt = now;

    const detected = this.face.isFaceDetected;
    const rois = this.face.lastROIs;
    const landmarks = this.face.lastLandmarks;

    if (!detected || !rois || rois.length === 0) {
      this._faceMissingFrames++;
      if (this._samplingReady && this._faceMissingFrames > 15) {
        this.visualizer.clearROI();
        this.visualizer.updateStatus('warning', '未检测到人脸', '请将面部正对摄像头');
      } else if (!this._samplingReady) {
        const elapsed = this._firstFaceSendAt ? Math.round((now - this._firstFaceSendAt) / 1000) : 0;
        const extra = [];
        if (stats.successCount) extra.push('成功 ' + stats.successCount);
        if (stats.timeoutCount) extra.push('超时 ' + stats.timeoutCount);
        if (stats.failCount) extra.push('失败 ' + stats.failCount);
        if (stats.lastError) extra.push(stats.lastError);
        const debug = `检测请求 ${stats.sendCount} · 回调 ${stats.recvCount}${extra.length ? ' · ' + extra.join(' · ') : ''} · ${video.videoWidth}×${video.videoHeight}${elapsed ? ' · 用时 ' + elapsed + 's' : ''}`;
        const deadline = !this._faceDeadlineWarned && (
          (stats.sendCount >= 3 && stats.recvCount === 0 && elapsed >= 3) ||
          (stats.timeoutCount >= 2)
        );
        if (deadline) {
          this._faceDeadlineWarned = true;
          const tips = [];
          if (stats.lastError) tips.push(stats.lastError);
          if (typeof FaceMesh === 'undefined') tips.push('FaceMesh 未加载');
          if (stats.timeoutCount >= 3) tips.push('WASM/CDN 下载过慢');
          tips.push('请按 F12 打开控制台查看错误 · 或刷新页面重试');
          this.visualizer.updateStatus('error', '人脸检测无响应', tips.join(' · '));
        } else if (!this._faceDeadlineWarned) {
          this.visualizer.updateStatus('detecting', '正在检测人脸', debug);
        }
      }
      return;
    }
    this._faceMissingFrames = 0;

    if (this.settings.debug && landmarks) {
      this.visualizer.drawLandmarks(landmarks);
    }
    this.visualizer.drawROIs(rois);

    if (!this._samplingReady) {
      this._samplingReady = true;
      this.visualizer.updateStatus('hide');
    }

    const rgb = this._sampleAverageRGB(video, rois);
    if (rgb) {
      this._sampleFailCount = 0;
      this.processor.pushSample(rgb, now);
    } else {
      this._sampleFailCount++;
      if (this._sampleFailCount > 20 && this._samplingReady) {
        const ls = this._lastSampleROIs;
        const bufN = this.processor ? this.processor.buffer.length : 0;
        let diag = `采样失败 ${this._sampleFailCount} 帧 · 缓冲区 ${bufN}`;
        if (ls) {
          const rois = ls.pxROIs.map(r => `${r.name}[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}]`).join(' ');
          diag += ` · 画布 ${ls.sW}×${ls.sH} · ROI: ${rois} · w=${ls.weight.toFixed(0)}`;
        }
        if (this._sampleFailCount === 21 || this._sampleFailCount % 30 === 0) {
          this.visualizer.updateStatus('warning', 'ROI 采样异常', diag);
        }
      }
    }
  }

  _sampleAverageRGB(video, rois) {
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) return null;

    const buf = this._roiBufferCanvas;
    const dprScale = 0.5;
    const sW = Math.max(48, Math.floor(W * dprScale));
    const sH = Math.max(36, Math.floor(H * dprScale));
    if (buf.width !== sW || buf.height !== sH) {
      buf.width = sW; buf.height = sH;
    }
    const ctx = this._roiBufferCtx;
    try {
      ctx.drawImage(video, 0, 0, sW, sH);
    } catch (e) {
      return null;
    }
    let imgData;
    try {
      imgData = ctx.getImageData(0, 0, sW, sH);
    } catch (e) {
      return null;
    }

    let totalR = 0, totalG = 0, totalB = 0, weight = 0;
    const pxROIs = [];
    for (const roi of rois) {
      const pxRoi = {
        x: roi.x * sW,
        y: roi.y * sH,
        w: roi.w * sW,
        h: roi.h * sH,
        name: roi.name
      };
      pxROIs.push(pxRoi);
      const sample = this.face.sampleROIPixels(imgData, sW, sH, pxRoi);
      if (!sample.valid) continue;
      if (!isFinite(sample.r) || !isFinite(sample.g) || !isFinite(sample.b) || sample.r + sample.g + sample.b <= 10) continue;
      const w = Math.max(1, pxRoi.w * pxRoi.h);
      totalR += sample.r * w;
      totalG += sample.g * w;
      totalB += sample.b * w;
      weight += w;
    }
    this._lastSampleROIs = { sW, sH, pxROIs, weight };
    if (weight === 0) return null;
    const r = totalR / weight, g = totalG / weight, b = totalB / weight;
    if (!isFinite(r) || !isFinite(g) || !isFinite(b) || r <= 0 || g <= 0 || b <= 0) return null;
    return { r, g, b };
  }

  _friendlyError(err) {
    const code = (err && err.code) || '';
    const name = (err && err.name) || '';
    const msg = (err && err.message) ? String(err.message) : '';
    const low = (msg + ' ' + name).toLowerCase();
    if (code === 'NO_GUM') return msg;
    if (code === 'CDN_LOAD_FAIL' || low.indexOf('face_mesh') >= 0 && (low.indexOf('未加载') >= 0 || low.indexOf('cdn') >= 0)) {
      return msg + ' · 请检查网络，确保可以访问 cdn.jsdelivr.net，或开启代理后刷新页面';
    }
    if (code === 'INIT_FAIL' || low.indexOf('初始化失败') >= 0 || low.indexOf('初始化超时') >= 0) {
      return msg + ' · 检测模型加载失败，请刷新页面重试（WASM 可能下载较慢）';
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || low.indexOf('permission') >= 0 || low.indexOf('denied') >= 0 || low.indexOf('notallowed') >= 0) {
      return '摄像头权限被拒绝，请在浏览器地址栏左侧的「锁/权限」图标中允许此页面访问摄像头，然后刷新页面';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || low.indexOf('notfound') >= 0 || low.indexOf('no device') >= 0) {
      return '未检测到可用的摄像头设备，请检查摄像头是否已连接并启用';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || low.indexOf('notreadable') >= 0 || low.indexOf('in use') >= 0) {
      return '摄像头被其他应用占用，请关闭占用摄像头的程序（如微信、Zoom、Teams 等）后重试';
    }
    if (name === 'OverconstrainedError' || low.indexOf('overconstrained') >= 0) {
      return '摄像头分辨率不支持，请尝试更换摄像头或降低分辨率设置';
    }
    if (name === 'NotSupportedError' || low.indexOf('notsupported') >= 0 || low.indexOf('secure') >= 0) {
      return '请使用 HTTPS 或 localhost 访问此页面（摄像头访问需要安全上下文）';
    }
    return msg + (name && name !== 'Error' ? '（' + name + '）' : '') || (err && String(err)) || '未知错误';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.__rppgApp = new RPPGApp();
});
