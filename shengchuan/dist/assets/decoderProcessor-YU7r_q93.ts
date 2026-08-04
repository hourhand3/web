// AudioWorklet 解码器处理器 - 接收端实时音频解码 (纯 JavaScript)

const P = {
  fftSize: 512,
  cyclicPrefix: 64,
  subcarrierStart: 193,
  subcarrierCount: 20,
  rsN: 255,
  rsK: 223,
  payloadBytes: 128,
};
const PREAMBLE_SAMPLES = 960;
const GUARD_SAMPLES = 100;
const SYNC_SYMBOLS = 2;
const HEADER_SYMBOLS = 1;
const TAIL_SAMPLES = 100;
const HEADER_BYTES = 5;
const SYMBOL_LEN = P.fftSize + P.cyclicPrefix;
const BITS_PER_SYMBOL = P.subcarrierCount * 2;
const NSYM = P.rsN - P.rsK;
const BLOCK_BYTES = HEADER_BYTES + P.payloadBytes;
const DATA_SYMBOLS_PER_FRAME = Math.ceil(((BLOCK_BYTES + NSYM) * 8) / BITS_PER_SYMBOL);
const TOTAL_OFDM_SYMBOLS = SYNC_SYMBOLS + HEADER_SYMBOLS + DATA_SYMBOLS_PER_FRAME;
const FRAME_SAMPLES = PREAMBLE_SAMPLES + GUARD_SAMPLES + TOTAL_OFDM_SYMBOLS * SYMBOL_LEN + TAIL_SAMPLES;

const DETECT_THRESHOLD = 0.35;
const MIN_FRAME_GAP = PREAMBLE_SAMPLES;

// GF(256) 查找表
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  const poly = 0x11d;
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= poly;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function gfDiv(a, b) {
  if (a === 0) return 0;
  if (b === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}
function gfInv(a) {
  if (a === 0) return 0;
  return GF_EXP[255 - GF_LOG[a]];
}

// RS 解码
function rsGeneratorPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = ng;
  }
  return g;
}

function rsSyndromes(r, nsym) {
  const synd = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    let s = 0;
    for (let j = 0; j < r.length; j++) {
      s = gfMul(s, GF_EXP[i]) ^ r[j];
    }
    synd[i] = s;
  }
  return synd;
}

function rsDecode(r, nsym) {
  const n = r.length;

  const synd = rsSyndromes(r, nsym);
  let hasError = false;
  for (let i = 0; i < nsym; i++) {
    if (synd[i] !== 0) { hasError = true; break; }
  }
  if (!hasError) return r.slice(0, n - nsym);

  // Berlekamp-Massey
  let errLoc = [1];
  let oldLoc = [1];

  for (let i = 0; i < nsym; i++) {
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[i - j]);
    }

    oldLoc.unshift(0);

    if (delta !== 0) {
      if (errLoc.length < oldLoc.length) {
        const factor = gfInv(delta);
        const newLoc = oldLoc.map((c) => gfMul(c, factor));
        oldLoc = errLoc.map((c) => gfMul(c, delta));
        errLoc = newLoc;
      }
      const maxLen = Math.max(errLoc.length, oldLoc.length);
      const result = new Array(maxLen).fill(0);
      for (let j = 0; j < errLoc.length; j++) result[j] = errLoc[j];
      for (let j = 0; j < oldLoc.length; j++) result[j] ^= gfMul(oldLoc[j], delta);
      errLoc = result;
    }
  }

  const numErrors = errLoc.length - 1;
  if (numErrors * 2 > nsym) return null;

  // Chien 搜索
  const errorPositions = [];
  for (let i = 0; i < n; i++) {
    let val = 0;
    for (let j = 0; j < errLoc.length; j++) {
      val ^= gfMul(errLoc[j], GF_EXP[(j * i) % 255]);
    }
    if (val === 0) {
      errorPositions.push(n - 1 - i);
    }
  }

  if (errorPositions.length !== numErrors) return null;

  // Forney 算法
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    for (let j = 0; j <= i; j++) {
      if (j < errLoc.length) {
        omega[i] ^= gfMul(synd[i - j], errLoc[j]);
      }
    }
  }

  const corrected = [...r];
  for (let k = 0; k < errorPositions.length; k++) {
    const pos = errorPositions[k];
    const exp = n - 1 - pos;
    const Xk = GF_EXP[exp % 255];
    const XkInv = gfInv(Xk);

    let omegaVal = 0;
    for (let j = 0; j < omega.length; j++) {
      omegaVal ^= gfMul(omega[j], GF_EXP[(j * (255 - exp)) % 255]);
    }

    let denom = 1;
    for (let j = 0; j < errorPositions.length; j++) {
      if (j === k) continue;
      const expJ = n - 1 - errorPositions[j];
      const Xj = GF_EXP[expJ % 255];
      const term = 1 ^ gfMul(Xj, XkInv);
      denom = gfMul(denom, term);
    }

    if (denom === 0) return null;

    const magnitude = gfMul(Xk, gfDiv(omegaVal, denom));
    corrected[pos] ^= magnitude;
  }

  const verifySynd = rsSyndromes(corrected, nsym);
  for (let i = 0; i < nsym; i++) {
    if (verifySynd[i] !== 0) return null;
  }

  return corrected.slice(0, n - nsym);
}

// FFT
function fftInPlace(re, im, inverse) {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = sign * 2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const xr = re[i + k], xi = im[i + k];
        const yr = re[i + k + half] * wr - im[i + k + half] * wi;
        const yi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = xr + yr;
        im[i + k] = xi + yi;
        re[i + k + half] = xr - yr;
        im[i + k + half] = xi - yi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// Chirp 匹配滤波器
let matchedFilter = null;
function getMatchedFilter() {
  if (matchedFilter) return matchedFilter;
  const n = PREAMBLE_SAMPLES;
  const f0 = 18000, f1 = 20000;
  const T = n / sampleRate;
  const k = (f1 - f0) / T;
  const chirp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    chirp[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  matchedFilter = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    matchedFilter[i] = chirp[n - 1 - i];
  }
  return matchedFilter;
}

// 同步序列
let syncRefRe = null;
let syncRefIm = null;
function getSyncRef() {
  if (syncRefRe) return;
  const total = P.subcarrierCount * SYNC_SYMBOLS;
  syncRefRe = new Float32Array(total);
  syncRefIm = new Float32Array(total);
  const QPSK = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const norm = 1 / Math.SQRT2;
  let lfsr = 0xace1;
  for (let i = 0; i < total; i++) {
    let bit0 = lfsr & 1; lfsr >>= 1; if (bit0) lfsr ^= 0xb400;
    let bit1 = lfsr & 1; lfsr >>= 1; if (bit1) lfsr ^= 0xb400;
    const idx = (bit0 << 1) | bit1;
    syncRefRe[i] = QPSK[idx][0] * norm;
    syncRefIm[i] = QPSK[idx][1] * norm;
  }
}

// 解码器状态
const DecoderState = { SEARCHING: 0, BUFFERING: 1, DECODING: 2 };

// 解码器处理器
class DecoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = DecoderState.SEARCHING;
    this.ringBuffer = new Float32Array(FRAME_SAMPLES * 2);
    this.writePos = 0;
    this.bufferFill = 0;
    this.frameStartOffset = 0;
    this.lastDetectPos = -MIN_FRAME_GAP;
    this.isListening = false;
    this.frameCount = 0;
    this.snr = 0;
    this.samplesProcessed = 0;
    this.detectCheckInterval = 32;
    this.detectCounter = 0;
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'startRx':
        this.isListening = true;
        this.state = DecoderState.SEARCHING;
        this.bufferFill = 0;
        this.writePos = 0;
        this.frameCount = 0;
        break;
      case 'stopRx':
        this.isListening = false;
        this.state = DecoderState.SEARCHING;
        break;
    }
  }

  chirpCorrelation(pos) {
    const filter = getMatchedFilter();
    const n = filter.length;
    let corr = 0;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const s = this.ringBuffer[(pos + i) % this.ringBuffer.length];
      corr += s * filter[i];
      energy += s * s;
    }
    const filterEnergy = n / 2;
    if (energy < 1e-6) return 0;
    return Math.abs(corr) / Math.sqrt(energy * filterEnergy);
  }

  decodeFrame() {
    getSyncRef();
    const startPos = this.frameStartOffset;

    const ofdmStart = startPos + PREAMBLE_SAMPLES + GUARD_SAMPLES;
    const ofdmLength = TOTAL_OFDM_SYMBOLS * SYMBOL_LEN;

    const allRe = new Float32Array(TOTAL_OFDM_SYMBOLS * P.subcarrierCount);
    const allIm = new Float32Array(TOTAL_OFDM_SYMBOLS * P.subcarrierCount);

    for (let s = 0; s < TOTAL_OFDM_SYMBOLS; s++) {
      const symStart = ofdmStart + s * SYMBOL_LEN + P.cyclicPrefix;
      const freqRe = new Float32Array(P.fftSize);
      const freqIm = new Float32Array(P.fftSize);
      for (let i = 0; i < P.fftSize; i++) {
        freqRe[i] = this.ringBuffer[(symStart + i) % this.ringBuffer.length];
      }
      fftInPlace(freqRe, freqIm, false);

      for (let i = 0; i < P.subcarrierCount; i++) {
        const bin = P.subcarrierStart + i;
        allRe[s * P.subcarrierCount + i] = freqRe[bin];
        allIm[s * P.subcarrierCount + i] = freqIm[bin];
      }
    }

    // 信道均衡
    if (syncRefRe && syncRefIm) {
      const hRe = new Float32Array(P.subcarrierCount);
      const hIm = new Float32Array(P.subcarrierCount);
      for (let i = 0; i < P.subcarrierCount; i++) {
        let rxRe = 0, rxIm = 0;
        for (let s = 0; s < SYNC_SYMBOLS; s++) {
          rxRe += allRe[s * P.subcarrierCount + i];
          rxIm += allIm[s * P.subcarrierCount + i];
        }
        rxRe /= SYNC_SYMBOLS;
        rxIm /= SYNC_SYMBOLS;
        const refRe = syncRefRe[i];
        const refIm = syncRefIm[i];
        const denom = refRe * refRe + refIm * refIm;
        hRe[i] = (rxRe * refRe + rxIm * refIm) / denom;
        hIm[i] = (rxIm * refRe - rxRe * refIm) / denom;
      }

      for (let s = 0; s < TOTAL_OFDM_SYMBOLS; s++) {
        for (let i = 0; i < P.subcarrierCount; i++) {
          const idx = s * P.subcarrierCount + i;
          const sr = allRe[idx];
          const si = allIm[idx];
          const denom = hRe[i] * hRe[i] + hIm[i] * hIm[i];
          if (denom < 1e-10) continue;
          allRe[idx] = (sr * hRe[i] + si * hIm[i]) / denom;
          allIm[idx] = (si * hRe[i] - sr * hIm[i]) / denom;
        }
      }
    }

    // 信噪比
    let noisePower = 0;
    let signalPower = 0;
    if (syncRefRe && syncRefIm) {
      for (let s = 0; s < SYNC_SYMBOLS; s++) {
        for (let i = 0; i < P.subcarrierCount; i++) {
          const idx = s * P.subcarrierCount + i;
          const dr = allRe[idx] - syncRefRe[i];
          const di = allIm[idx] - syncRefIm[i];
          noisePower += dr * dr + di * di;
          signalPower += syncRefRe[i] * syncRefRe[i] + syncRefIm[i] * syncRefIm[i];
        }
      }
    }
    this.snr = noisePower > 1e-10 ? 10 * Math.log10(signalPower / noisePower) : 30;

    // QPSK 解调
    const dataStart = SYNC_SYMBOLS * P.subcarrierCount;
    const dataSymCount = TOTAL_OFDM_SYMBOLS - SYNC_SYMBOLS;
    const dataBitCount = dataSymCount * BITS_PER_SYMBOL;
    const bits = new Array(dataBitCount);
    for (let s = 0; s < dataSymCount; s++) {
      for (let i = 0; i < P.subcarrierCount; i++) {
        const idx = dataStart + s * P.subcarrierCount + i;
        const bitIdx = s * BITS_PER_SYMBOL + i * 2;
        bits[bitIdx] = allRe[idx] >= 0 ? 0 : 1;
        bits[bitIdx + 1] = allIm[idx] >= 0 ? 0 : 1;
      }
    }

    // 比特 → 字节
    const codewordLen = BLOCK_BYTES + NSYM;
    const codeword = new Array(codewordLen);
    for (let i = 0; i < codewordLen; i++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) {
        byte = (byte << 1) | (bits[i * 8 + b] || 0);
      }
      codeword[i] = byte;
    }

    // RS 解码
    const rsK_actual = BLOCK_BYTES;
    const fullCodeword = [...new Array(P.rsK - rsK_actual).fill(0), ...codeword];
    const decoded = rsDecode(fullCodeword, NSYM);

    if (decoded) {
      const actualData = decoded.slice(P.rsK - rsK_actual);

      if (actualData.length >= HEADER_BYTES) {
        const frameIndex = actualData[0];
        const totalFrames = actualData[1];
        const dataLength = actualData[2];
        const dataType = actualData[3];

        const payload = new Uint8Array(actualData.slice(HEADER_BYTES, HEADER_BYTES + dataLength));

        this.frameCount++;
        this.port.postMessage({
          type: 'rxFrame',
          frame: {
            frameIndex,
            totalFrames,
            dataType,
            payload: payload.buffer,
          },
          stats: {
            snr: this.snr,
            signalQuality: Math.max(0, Math.min(1, (this.snr + 5) / 20)),
            framesReceived: this.frameCount,
          },
        });
      }
    } else {
      this.port.postMessage({
        type: 'rxError',
        error: 'RS decode failed',
      });
    }

    this.state = DecoderState.SEARCHING;
  }

  process(inputs, outputs) {
    if (!this.isListening) return true;

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const channel = input[0];
    const quantum = channel.length;

    for (let i = 0; i < quantum; i++) {
      this.ringBuffer[this.writePos] = channel[i];
      this.writePos = (this.writePos + 1) % this.ringBuffer.length;
      this.bufferFill = Math.min(this.bufferFill + 1, this.ringBuffer.length);
    }

    this.samplesProcessed += quantum;

    if (this.state === DecoderState.SEARCHING) {
      this.detectCounter += quantum;
      if (this.detectCounter >= this.detectCheckInterval && this.bufferFill >= PREAMBLE_SAMPLES + 100) {
        this.detectCounter = 0;

        const checkPos = (this.writePos - PREAMBLE_SAMPLES + this.ringBuffer.length) % this.ringBuffer.length;
        const corr = this.chirpCorrelation(checkPos);

        if (corr > DETECT_THRESHOLD) {
          let bestPos = checkPos;
          let bestCorr = corr;
          const searchRange = 48;
          for (let offset = -searchRange; offset <= searchRange; offset++) {
            const pos = (checkPos + offset + this.ringBuffer.length) % this.ringBuffer.length;
            const c = this.chirpCorrelation(pos);
            if (c > bestCorr) {
              bestCorr = c;
              bestPos = pos;
            }
          }

          const distance = (bestPos - this.lastDetectPos + this.ringBuffer.length) % this.ringBuffer.length;
          if (distance > MIN_FRAME_GAP || this.lastDetectPos < 0) {
            this.frameStartOffset = bestPos;
            this.lastDetectPos = bestPos;
            this.state = DecoderState.BUFFERING;

            this.port.postMessage({
              type: 'rxStats',
              stats: {
                state: 'receiving',
                snr: 0,
                signalQuality: Math.min(1, bestCorr * 2),
              },
            });
          }
        }
      }
    } else if (this.state === DecoderState.BUFFERING) {
      const samplesAfterFrameStart = (this.writePos - this.frameStartOffset + this.ringBuffer.length) % this.ringBuffer.length;
      if (samplesAfterFrameStart >= FRAME_SAMPLES) {
        this.state = DecoderState.DECODING;
        this.decodeFrame();
      }
    }

    return true;
  }
}

registerProcessor('decoder-processor', DecoderProcessor);
