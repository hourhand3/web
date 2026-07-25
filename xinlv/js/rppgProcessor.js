class RPPGProcessor {
  constructor(options = {}) {
    this.options = {
      algorithm: 'green',
      windowSize: 300,
      fpsEstimate: 30,
      minBPM: 42,
      maxBPM: 240,
      bandpassOrder: 2,
      ...options
    };
    this.buffer = [];
    this.rawSignals = { r: [], g: [], b: [] };
    this.filteredSignal = [];
    this.timestamps = [];
    this.currentBPM = null;
    this.bpmHistory = [];
    this.confidence = 0;
    this._peakTimes = [];
    this._lastPeakIndex = -1;
    this._onUpdateCallbacks = [];
    this._butterB = null;
    this._butterA = null;
    this._filterState = { zi: null };
    this._butterCache = {};
    this._lastStableBPM = null;
    this._nullBPMStreak = 0;
    this._lastFailReason = '';
    this._lastAttemptedBPM = null;
    this._lastAttemptedConfidence = 0;
  }

  get sampleCount() { return this.buffer.length; }
  get windowSize() { return this.options.windowSize; }
  get bpm() { return this.currentBPM; }
  get signalQuality() { return this._calcSignalQuality(); }
  get diagnostics() {
    return {
      nullBPMStreak: this._nullBPMStreak,
      lastFailReason: this._lastFailReason,
      lastAttemptedBPM: this._lastAttemptedBPM,
      lastAttemptedConfidence: this._lastAttemptedConfidence,
      algorithm: this.options.algorithm,
      fps: this._currentFPS || null,
      filteredLen: this.filteredSignal.length
    };
  }

  setOptions(opt) {
    Object.assign(this.options, opt);
    this._initBandpass();
  }

  _initBandpass() {
    this._filterState.zi = null;
  }

  setAlgorithm(algo) {
    const valid = ['pos', 'green', 'chrom'];
    if (valid.includes(algo)) {
      this.options.algorithm = algo;
    }
  }

  onUpdate(cb) {
    if (typeof cb === 'function') this._onUpdateCallbacks.push(cb);
  }

  reset() {
    this.buffer = [];
    this.rawSignals = { r: [], g: [], b: [] };
    this.filteredSignal = [];
    this.timestamps = [];
    this.currentBPM = null;
    this.bpmHistory = [];
    this.confidence = 0;
    this._peakTimes = [];
    this._lastPeakIndex = -1;
    this._filterState.zi = null;
    this._butterCache = {};
    this._lastStableBPM = null;
  }

  pushSample(rgb, timestampMs) {
    this.buffer.push(rgb);
    this.rawSignals.r.push(rgb.r);
    this.rawSignals.g.push(rgb.g);
    this.rawSignals.b.push(rgb.b);
    this.timestamps.push(timestampMs);

    const ws = this.options.windowSize;
    if (this.buffer.length > ws + 60) {
      const excess = this.buffer.length - (ws + 60);
      this.buffer.splice(0, excess);
      this.rawSignals.r.splice(0, excess);
      this.rawSignals.g.splice(0, excess);
      this.rawSignals.b.splice(0, excess);
      this.timestamps.splice(0, excess);
      if (this._peakTimes.length) {
        this._peakTimes = this._peakTimes.filter(t => t >= this.timestamps[0]);
      }
    }

    if (this.buffer.length >= 60) {
      this._process();
    }
    this._emit();
  }

  _process() {
    const N = Math.min(this.buffer.length, this.options.windowSize);
    const start = this.buffer.length - N;
    const r = this.rawSignals.r.slice(start);
    const g = this.rawSignals.g.slice(start);
    const b = this.rawSignals.b.slice(start);
    const ts = this.timestamps.slice(start);

    const fps = this._estimateFPS(ts);
    this._currentFPS = fps;

    const algos = [this.options.algorithm];
    if (this._nullBPMStreak >= 10) {
      const fallback = ['green', 'chrom', 'pos'];
      for (let fi = 0; fi < fallback.length; fi++) {
        if (algos.indexOf(fallback[fi]) === -1) algos.push(fallback[fi]);
      }
    }

    let rawSignal = null;
    let usedAlgo = this.options.algorithm;
    for (let ai = 0; ai < algos.length; ai++) {
      const algo = algos[ai];
      let s;
      switch (algo) {
        case 'chrom':
          s = this._chrom(r, g, b); break;
        case 'green':
          s = this._greenMethod(r, g, b); break;
        case 'pos':
        default:
          s = this._pos(r, g, b);
      }
      s = this._detrend(s, 5);
      s = this._normalize(s);
      const stdS = this._std(s);
      if (stdS > 0.05 || ai === algos.length - 1) {
        rawSignal = s;
        usedAlgo = algo;
        break;
      }
    }
    this._rawSignalView = rawSignal.slice();
    this._usedAlgoLast = usedAlgo;

    const fs = Math.max(10, fps);
    const filtered = this._bandpass(rawSignal, fs);
    this.filteredSignal = filtered;

    const result = this._estimateBPM(filtered, fs, ts);
    this._lastAttemptedBPM = result.bpm;
    this._lastAttemptedConfidence = result.confidence;

    if (result.bpm) {
      this.confidence = result.confidence;
      this._updateBPM(result.bpm, ts);
      this._nullBPMStreak = 0;
      this._lastFailReason = '';
      if (result.peaks && result.peaks.length) {
        this._lastPeakIndex = start + result.peaks[result.peaks.length - 1];
      }
    } else {
      this._nullBPMStreak++;
      if (filtered.length < 36) this._lastFailReason = `帧数不足(${filtered.length})`;
      else if (!result.peaks || result.peaks.length < 2) this._lastFailReason = `FFT 峰不足(尝试${usedAlgo})`;
      else this._lastFailReason = `BPM 超范围(置信度${(result.confidence * 100).toFixed(0)}%)`;
    }
  }

  _emit() {
    for (const cb of this._onUpdateCallbacks) {
      try {
        cb({
          bpm: this.currentBPM,
          confidence: this.confidence,
          samples: this.buffer.length,
          raw: this._rawSignalView || [],
          filtered: this.filteredSignal || [],
          fps: this._currentFPS || null,
          peakIndex: this._lastPeakIndex,
          diagnostics: this.diagnostics
        });
      } catch (e) { console.error(e); }
    }
  }

  _estimateFPS(timestamps) {
    if (timestamps.length < 2) return this.options.fpsEstimate;
    const dt = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
    if (dt <= 0) return this.options.fpsEstimate;
    return (timestamps.length - 1) / dt;
  }

  _greenMethod(r, g, b) {
    return g.slice();
  }

  _chrom(r, g, b) {
    const N = r.length;
    const X = new Array(N);
    const Y = new Array(N);
    for (let i = 0; i < N; i++) {
      const Rn = isFinite(r[i]) ? r[i] : 0;
      const Gn = isFinite(g[i]) ? g[i] : 0;
      const Bn = isFinite(b[i]) ? b[i] : 0;
      X[i] = 3 * Rn - 2 * Gn;
      Y[i] = 1.5 * Rn + Gn - 1.5 * Bn;
    }
    const Xs = this._standardize(X);
    const Ys = this._standardize(Y);
    const Xf = this._bandpassSimple(Xs, 0.75, 3.0);
    const Yf = this._bandpassSimple(Ys, 0.75, 3.0);
    const sX = this._std(Xf);
    const sY = this._std(Yf);
    const alpha = (sY <= 0 || !isFinite(sY) || !isFinite(sX)) ? 0 : sX / sY;
    const S = new Array(N);
    for (let i = 0; i < N; i++) {
      const v = Xf[i] - alpha * Yf[i];
      S[i] = isFinite(v) ? v : 0;
    }
    return S;
  }

  _pos(r, g, b) {
    const N = r.length;
    const C = new Array(N);
    for (let i = 0; i < N; i++) {
      C[i] = [r[i], g[i], b[i]];
    }
    const H = new Array(Math.max(0, N - 32));
    for (let m = 0; m < H.length; m++) {
      const end = m + 32;
      const Cw = C.slice(m, end);
      const mean = [0, 0, 0];
      for (const c of Cw) { mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2]; }
      mean[0] /= 32; mean[1] /= 32; mean[2] /= 32;
      if (!isFinite(mean[0]) || !isFinite(mean[1]) || !isFinite(mean[2]) || mean[0] <= 0 || mean[1] <= 0 || mean[2] <= 0) {
        H[m] = 0;
        continue;
      }
      const Cn = Cw.map(c => [c[0] / mean[0] - 1, c[1] / mean[1] - 1, c[2] / mean[2] - 1]);
      const S1 = new Array(32); const S2 = new Array(32);
      for (let i = 0; i < 32; i++) {
        S1[i] = Cn[i][0] - Cn[i][1];
        S2[i] = Cn[i][0] + Cn[i][1] - 2 * Cn[i][2];
      }
      const std1 = this._std(S1);
      const std2 = this._std(S2);
      const alpha = std2 === 0 || !isFinite(std2) ? 0 : (isFinite(std1) ? std1 / std2 : 0);
      const P = new Array(32);
      for (let i = 0; i < 32; i++) P[i] = S1[i] - (isFinite(alpha) ? alpha : 0) * S2[i];
      const avg = this._mean(P);
      H[m] = isFinite(avg) ? avg : 0;
    }
    if (H.length === 0) {
      const s = g.slice();
      for (let i = 0; i < s.length; i++) if (!isFinite(s[i])) s[i] = 0;
      return s;
    }
    const padLen = Math.max(0, N - H.length);
    const firstPadded = new Array(padLen).fill(isFinite(H[0]) ? H[0] : 0);
    return firstPadded.concat(H.map(v => isFinite(v) ? v : 0));
  }

  _bandpass(signal, fs) {
    const low = Math.max(0.75, this.options.minBPM / 60);
    const high = Math.min(2.5, this.options.maxBPM / 60);
    let out = this._butterworthBandpass(signal, fs, low, high, this.options.bandpassOrder);
    const outStd = this._std(out);
    if (out.some(function(v){return !isFinite(v)}) || outStd < 0.01 || outStd > 100) {
      out = this._bandpassSimple(signal, low, high, fs);
    }
    return out;
  }

  _bandpassSimple(signal, lowHz, highHz, fs) {
    const fs_ = (fs && isFinite(fs) && fs > 5) ? fs : 30;
    let s = this._detrend(signal, 3);
    s = this._smooth(s, Math.max(3, Math.floor(fs_ / (highHz * 5))));
    const baseline = this._smooth(s, Math.max(5, Math.floor(fs_ / lowHz)));
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] - baseline[i];
    return out;
  }

  _butterworthBandpass(x, fs, low, high, order) {
    const nyq = fs / 2;
    const Wn = [low / nyq, high / nyq];
    const cacheKey = `${order}_${Wn[0].toFixed(6)}_${Wn[1].toFixed(6)}`;
    let coeffs = this._butterCache[cacheKey];
    if (!coeffs) {
      coeffs = this._butterCoeffs(order, Wn);
      this._butterCache[cacheKey] = coeffs;
    }
    return this._filtfilt(x, coeffs.b, coeffs.a);
  }

  _butterCoeffs(order, Wn) {
    const [Wl, Wh] = Wn;
    const tanL = Math.tan(Math.PI * Wl / 2);
    const tanH = Math.tan(Math.PI * Wh / 2);
    let b = new Array(2 * order + 1).fill(0);
    let a = new Array(2 * order + 1).fill(0);
    b[0] = 1; a[0] = 1;
    for (let i = 0; i < order; i++) {
      const theta = Math.PI * (2 * i + 1) / (2 * order);
      const sp = Math.sin(theta);
      const cp = Math.cos(theta);
      const Q = tanH * tanH - tanL * tanL;
      const K = 1 + (2 * tanH * tanL) / (1 + cp);
      const A = tanH * tanH + (2 * tanL * tanH) * sp / (1 + cp) + 1;
      const B1 = -2 * Q;
      const B2 = (1 - 2 * cp) * tanL * tanL + tanH * tanH * (1 + 2 * cp) + 2 * (tanH * tanH - 1) * cp;
      const B3 = 2 * Q;
      const B4 = (1 - 2 * cp) * tanH * tanH + tanL * tanL * (1 + 2 * cp) - 2 * (tanH * tanH - 1) * cp;
      const A4 = 1 + (tanL * tanH) * (2 * tanL * tanH / (1 - cp) - 2 * sp);
      const scale = A / A4;
      const bb = [scale, 0, -2 * scale, 0, scale];
      const aa = [1, B1 / A4, B2 / A4, B3 / A4, A4 !== 0 ? 1 : 1];
      b = this._polyMul(b, bb);
      a = this._polyMul(a, aa);
    }
    const gain = b.reduce((s, v) => s + v, 0) / a.reduce((s, v) => s + v, 0) || 1;
    return { b: b.map(v => v / gain), a };
  }

  _polyMul(p1, p2) {
    const n = p1.length, m = p2.length;
    const out = new Array(n + m - 1).fill(0);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++)
        out[i + j] += p1[i] * p2[j];
    return out;
  }

  _filtfilt(x, b, a) {
    const y1 = this._filter(x, b, a, true);
    const rev = y1.slice().reverse();
    const y2 = this._filter(rev, b, a, true);
    return y2.reverse();
  }

  _filter(x, b, a, resetState = false) {
    const N = x.length;
    const nb = b.length, na = a.length;
    const y = new Array(N).fill(0);
    const zi = resetState
      ? new Array(Math.max(nb, na) - 1).fill(0)
      : (this._filterState.zi && this._filterState.zi.length === Math.max(nb, na) - 1
          ? this._filterState.zi.slice()
          : new Array(Math.max(nb, na) - 1).fill(0));
    const a0 = a[0] || 1;
    for (let n = 0; n < N; n++) {
      let yn = b[0] * x[n] + zi[0];
      for (let i = 1; i < Math.min(nb, zi.length + 1); i++) {
        zi[i - 1] = b[i] * x[n] + zi[i];
      }
      if (nb > zi.length + 1 && zi.length > 0) {
        zi[zi.length - 1] = b[nb - 1] * x[n];
      }
      for (let i = 1; i < na && i <= zi.length; i++) {
        zi[i - 1] -= (a[i] / a0) * yn;
      }
      y[n] = yn;
    }
    if (!resetState) {
      this._filterState.zi = zi.slice();
    }
    return y;
  }

  _detrend(signal, lambda = 10) {
    const N = signal.length;
    if (N < 3) return signal.slice();
    const window = Math.min(N, Math.max(5, Math.floor(N / 4)));
    const baseline = this._smooth(signal, window);
    const out = new Array(N);
    for (let i = 0; i < N; i++) out[i] = signal[i] - baseline[i];
    return out;
  }

  _smooth(x, windowSize) {
    const N = x.length;
    const w = Math.max(3, Math.min(windowSize, N));
    const half = Math.floor(w / 2);
    const out = new Array(N);
    let sum = 0;
    for (let i = 0; i < w && i < N; i++) sum += x[i];
    for (let i = 0; i < N; i++) {
      if (i > half && i + half < N) {
        if (i + half < N) sum += x[i + half];
        if (i - half - 1 >= 0) sum -= x[i - half - 1];
        out[i] = sum / w;
      } else {
        let s = 0, c = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(N - 1, i + half); j++) {
          s += x[j]; c++;
        }
        out[i] = s / c;
      }
    }
    return out;
  }

  _normalize(x) {
    const mu = this._mean(x);
    const s = this._std(x) || 1;
    return x.map(v => (v - mu) / s);
  }

  _standardize(x) { return this._normalize(x); }

  _mean(x) {
    let s = 0; for (const v of x) s += v;
    return s / Math.max(1, x.length);
  }

  _std(x) {
    if (x.length < 2) return 0;
    const m = this._mean(x);
    let s = 0;
    for (const v of x) s += (v - m) ** 2;
    return Math.sqrt(s / (x.length - 1));
  }

  _estimateBPM(filtered, fs, timestamps) {
    const N = filtered.length;
    if (N < 36 || fs <= 0) return { bpm: null, peaks: [], confidence: 0 };

    const result = this._bpmFromACF(filtered, fs);
    if (result.bpm) {
      return result;
    }
    return this._bpmFromFFT(filtered, fs);
  }

  _bpmFromACF(signal, fs) {
    const N = signal.length;
    if (N < 36) return { bpm: null, peaks: [], confidence: 0 };

    const minLag = Math.max(2, Math.floor(fs * 60 / 150));
    const maxLag = Math.min(Math.floor(N / 2), Math.floor(fs * 60 / 45));

    if (minLag >= maxLag) return { bpm: null, peaks: [], confidence: 0 };

    const acf = new Array(maxLag + 1).fill(0);
    const mean = this._mean(signal);
    let varSum = 0;
    for (let i = 0; i < N; i++) varSum += (signal[i] - mean) ** 2;

    if (varSum < 1e-10) return { bpm: null, peaks: [], confidence: 0 };

    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < N - lag; i++) {
        sum += (signal[i] - mean) * (signal[i + lag] - mean);
      }
      acf[lag] = sum / varSum;
    }

    let maxAcf = -1, maxLag_ = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (acf[lag] > maxAcf) {
        maxAcf = acf[lag];
        maxLag_ = lag;
      }
    }

    if (maxLag_ < 0 || maxAcf < 0.25) return { bpm: null, peaks: [], confidence: 0 };

    const periodSamples = maxLag_;
    const periodSeconds = periodSamples / fs;
    const bpm = 60 / periodSeconds;

    if (bpm < 45 || bpm > 150) return { bpm: null, peaks: [], confidence: 0 };

    const confidence = Math.max(0, Math.min(1, (maxAcf - 0.2) * 1.5));
    return { bpm, peaks: [], confidence };
  }

  _bpmFromFFT(signal, fs) {
    const N = signal.length;
    if (N < 36) return { bpm: null, peaks: [], confidence: 0 };
    const M = 1 << Math.ceil(Math.log2(N));
    const re = signal.slice();
    while (re.length < M) re.push(0);
    const im = new Array(M).fill(0);
    this._fft(re, im, false);
    const minFreq = 45 / 60;
    const maxFreq = 150 / 60;
    const minIdx = Math.max(1, Math.floor(minFreq * M / fs));
    const maxIdx = Math.min(M / 2 - 1, Math.ceil(maxFreq * M / fs));
    let maxAmp = -1, maxIdx_ = -1;
    const mags = new Array(maxIdx + 1);
    for (let i = minIdx; i <= maxIdx; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      mags[i] = m;
      if (m > maxAmp) { maxAmp = m; maxIdx_ = i; }
    }
    if (maxIdx_ < 0) return { bpm: null, peaks: [], confidence: 0 };
    const freq = maxIdx_ * fs / M;
    const bpm = freq * 60;
    let sumAll = 0, sumPeak = 0;
    const band = Math.max(2, Math.floor(0.06 * M / fs));
    for (let i = minIdx; i <= maxIdx; i++) {
      sumAll += mags[i] * mags[i];
      if (i >= maxIdx_ - band && i <= maxIdx_ + band) sumPeak += mags[i] * mags[i];
    }
    const snr = sumAll > 0 ? sumPeak / sumAll : 0;
    const confidence = Math.max(0, Math.min(0.9, snr * 1.1));
    return { bpm, peaks: [], confidence };
  }

  _fft(real, imag, invert) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (invert ? -2 : 2) * Math.PI / len;
      const wRe0 = Math.cos(ang), wIm0 = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        for (let k = 0; k < half; k++) {
          const uRe = real[i + k], uIm = imag[i + k];
          const vRe = real[i + k + half] * wRe - imag[i + k + half] * wIm;
          const vIm = real[i + k + half] * wIm + imag[i + k + half] * wRe;
          real[i + k] = uRe + vRe;
          imag[i + k] = uIm + vIm;
          real[i + k + half] = uRe - vRe;
          imag[i + k + half] = uIm - vIm;
          const nwRe = wRe * wRe0 - wIm * wIm0;
          wIm = wRe * wIm0 + wIm * wRe0;
          wRe = nwRe;
        }
      }
    }
    if (invert) {
      for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; }
    }
  }

  _findPeaks(x, options) {
    const N = x.length;
    const {
      minDistance = 1,
      minProminence = 0,
      minHeight = -Infinity
    } = options;
    const peaks = [];
    for (let i = 1; i < N - 1; i++) {
      if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] >= minHeight) {
        peaks.push(i);
      }
    }
    if (peaks.length < 2) return peaks;

    const prominences = new Map();
    for (const p of peaks) {
      let leftMin = x[p], rightMin = x[p];
      for (let i = p - 1; i >= 0 && x[i] <= x[p]; i--) leftMin = Math.min(leftMin, x[i]);
      for (let i = p + 1; i < N && x[i] <= x[p]; i++) rightMin = Math.min(rightMin, x[i]);
      const prom = x[p] - Math.max(leftMin, rightMin);
      prominences.set(p, prom);
    }

    const filtered = peaks.filter(p => (prominences.get(p) || 0) >= minProminence);
    filtered.sort((a, b) => (prominences.get(b) || 0) - (prominences.get(a) || 0));

    const kept = [];
    const mask = new Set();
    for (const p of filtered) {
      if (mask.has(p)) continue;
      kept.push(p);
      for (let j = Math.max(0, p - minDistance); j <= Math.min(N - 1, p + minDistance); j++) mask.add(j);
    }
    kept.sort((a, b) => a - b);
    return kept;
  }

  _updateBPM(newBPM, timestamps) {
    this.bpmHistory.push(newBPM);
    const maxHist = 30;
    if (this.bpmHistory.length > maxHist) this.bpmHistory.shift();

    const recent = this.bpmHistory.slice(-10);
    recent.sort((a, b) => a - b);
    const median = recent.length % 2 === 1
      ? recent[(recent.length - 1) / 2]
      : (recent[recent.length / 2 - 1] + recent[recent.length / 2]) / 2;

    if (this._lastStableBPM === null) {
      this._lastStableBPM = newBPM;
    } else {
      const rateLimit = 8;
      const clampedMedian = Math.max(
        this._lastStableBPM - rateLimit,
        Math.min(this._lastStableBPM + rateLimit, median)
      );
      const alpha = 0.12;
      this._lastStableBPM = this._lastStableBPM * (1 - alpha) + clampedMedian * alpha;
    }
    this.currentBPM = Math.round(this._lastStableBPM);
  }

  _calcSignalQuality() {
    if (this.buffer.length < 100) return 0;
    const stdRatio = this.filteredSignal.length
      ? (this._std(this._rawSignalView || []) / (this._std(this.filteredSignal) || 1))
      : 0;
    const confPart = this.confidence || 0;
    const lenPart = Math.min(1, this.buffer.length / this.options.windowSize);
    return Math.round((0.4 * confPart + 0.35 * lenPart + 0.25 * Math.min(1, 1 / Math.max(0.3, stdRatio))) * 100);
  }
}

if (typeof window !== 'undefined') {
  window.RPPGProcessor = RPPGProcessor;
}
