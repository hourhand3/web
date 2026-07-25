class Visualizer {
  constructor(elements) {
    this.els = elements;
    this._resizeHandler = this._resize.bind(this);
    window.addEventListener('resize', this._resizeHandler);
    this._lastBPM = null;
    this._bpmUpdatedAt = 0;
    this._initCanvases();
  }

  _initCanvases() {
    this._resize();
    this.drawWaveform([], []);
  }

  _resize() {
    this._resizeOverlay(this.els.faceCanvas, this.els.video);
    this._resizeOverlay(this.els.roiCanvas, this.els.video);
    this._resizeWaveform(this.els.waveformCanvas);
  }

  _resizeOverlay(canvas, video) {
    if (!canvas || !video) return;
    const rect = video.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }

  _resizeWaveform(canvas) {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const height = parseFloat(getComputedStyle(canvas).height) || canvas.height || 140;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
  }

  clearFaceCanvas() {
    const c = this.els.faceCanvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
  }

  drawLandmarks(landmarks) {
    const c = this.els.faceCanvas;
    if (!c || !landmarks) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);

    ctx.fillStyle = 'rgba(59, 130, 246, 0.45)';
    const r = Math.max(1, W / 800);
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      const x = p.x * W, y = p.y * H;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawROIs(rois) {
    const c = this.els.roiCanvas;
    if (!c || !rois || rois.length === 0) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);

    const colors = {
      forehead: 'rgba(34, 197, 94, 0.25)',
      foreheadBorder: '#22c55e',
      leftCheek: 'rgba(59, 130, 246, 0.25)',
      leftCheekBorder: '#3b82f6',
      rightCheek: 'rgba(139, 92, 246, 0.25)',
      rightCheekBorder: '#8b5cf6'
    };

    for (const roi of rois) {
      const x = roi.x * W, y = roi.y * H;
      const w = roi.w * W, h = roi.h * H;
      const fill = colors[roi.name] || 'rgba(255,255,255,0.15)';
      const border = colors[roi.name + 'Border'] || '#fff';
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = border;
      ctx.lineWidth = Math.max(1.5, W / 400);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  clearROI() {
    const c = this.els.roiCanvas;
    if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  drawWaveform(raw, filtered) {
    const c = this.els.waveformCanvas;
    if (!c) return;
    this._resizeWaveform(c);
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = this._getCSSVar('--bg-card') || '#1e293b';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (H / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const mid = H / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
    ctx.setLineDash([]);

    const maxLen = Math.max(raw?.length || 0, filtered?.length || 0);
    if (maxLen < 2) return;
    const stepX = W / Math.max(1, maxLen - 1);

    if (raw && raw.length >= 2) {
      this._plotLine(ctx, raw, stepX, H, 'rgba(34, 197, 94, 0.55)', Math.max(1, W / 800));
    }
    if (filtered && filtered.length >= 2) {
      this._plotLine(ctx, filtered, stepX, H, '#3b82f6', Math.max(1.8, W / 500));
    }
  }

  _plotLine(ctx, data, stepX, H, color, lineWidth) {
    let min = Infinity, max = -Infinity;
    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(1e-6, max - min);
    const pad = H * 0.12;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = pad + ((data[i] - min) / range) * (H - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  updateStatus(kind, text, subtext) {
    const overlay = this.els.statusOverlay;
    const icon = this.els.statusIcon;
    const tEl = this.els.statusText;
    const sEl = this.els.statusSubtext;
    if (!overlay) return;

    const iconMap = {
      idle: '',
      loading: 'loading',
      success: 'success',
      error: 'error',
      warning: 'warning',
      detecting: 'loading'
    };
    if (kind === 'hide') {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    icon.className = 'status-icon ' + (iconMap[kind] || '');
    if (tEl) tEl.textContent = text || '';
    if (sEl) sEl.textContent = subtext || '';
  }

  updateBPM(value, confidence = 0, diagnostics = null) {
    const el = this.els.bpmValue;
    if (el) {
      if (value != null) {
        el.textContent = String(value);
        this._updateBPMColor(el, value);
        if (value !== this._lastBPM) {
          el.classList.remove('pulse');
          void el.offsetWidth;
          el.classList.add('pulse');
          this._lastBPM = value;
        }
      } else if (diagnostics && diagnostics.lastAttemptedBPM && diagnostics.nullBPMStreak >= 6) {
        el.textContent = `~${Math.round(diagnostics.lastAttemptedBPM)}`;
        el.style.color = '';
      } else {
        el.textContent = '--';
        el.style.color = '';
      }
    }
    const badge = this.els.bpmConfidence;
    if (badge) {
      let level = 'poor', label = '差';
      if (value != null && confidence >= 0.65) { level = 'good'; label = '良好'; }
      else if (value != null && confidence >= 0.35) { level = 'medium'; label = '一般'; }
      badge.className = 'confidence-badge ' + (value == null ? '' : level);
      if (value != null) {
        badge.textContent = confidence === 0 ? '信号: --' : `信号: ${label} (${Math.round(confidence * 100)}%)`;
      } else if (diagnostics && diagnostics.nullBPMStreak >= 6) {
        const parts = [];
        if (diagnostics.lastAttemptedBPM) parts.push(`估算 ~${Math.round(diagnostics.lastAttemptedBPM)}`);
        if (diagnostics.algorithm) parts.push(`算法:${diagnostics.algorithm}`);
        if (diagnostics.lastFailReason) parts.push(diagnostics.lastFailReason);
        badge.textContent = parts.length ? parts.join(' · ') : '信号: 估算中...';
      } else {
        badge.textContent = '信号: 累积采样中...';
      }
    }
  }

  _updateBPMColor(el, bpm) {
    let color;
    if (bpm >= 60 && bpm <= 100) {
      color = '#22c55e';
    } else if ((bpm >= 50 && bpm < 60) || (bpm > 100 && bpm <= 120)) {
      color = '#f59e0b';
    } else {
      color = '#ef4444';
    }
    el.style.background = 'none';
    el.style.webkitBackgroundClip = 'text';
    el.style.backgroundClip = 'text';
    el.style.webkitTextFillColor = color;
    el.style.color = color;
  }

  updateInfo({ fps, samples, stability, cameraLabel }) {
    if (this.els.fpsValue) this.els.fpsValue.textContent = fps ?? '--';
    if (this.els.windowValue && samples != null) {
      const fs = (fps && isFinite(fps) && fps > 5) ? fps : 30;
      const seconds = Math.max(1, Math.round(samples / fs));
      this.els.windowValue.textContent = `${samples} (${seconds}s)`;
    }
    if (this.els.stabilityValue) {
      this.els.stabilityValue.textContent = stability == null ? '--%' : `${stability}%`;
    }
    if (this.els.cameraLabel) {
      this.els.cameraLabel.textContent = cameraLabel || '未连接';
    }
  }

  setButtonsState({ started }) {
    const startBtn = this.els.btnStart;
    const stopBtn = this.els.btnStop;
    if (startBtn) { startBtn.disabled = started; }
    if (stopBtn) { stopBtn.disabled = !started; }
  }

  _getCSSVar(name) {
    if (typeof getComputedStyle === 'undefined') return null;
    const val = getComputedStyle(document.documentElement).getPropertyValue(name);
    return val ? val.trim() : null;
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
  }
}

if (typeof window !== 'undefined') {
  window.Visualizer = Visualizer;
}
