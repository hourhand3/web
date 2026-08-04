// AudioWorklet 编码器处理器 - 发送端实时音频生成 (纯 JavaScript)

const P = {
  fftSize: 512,
  cyclicPrefix: 64,
  subcarrierStart: 193,
  subcarrierCount: 20,
  rsN: 255,
  rsK: 223,
  payloadBytes: 128,
  modulationOrder: 4,
};
const PREAMBLE_SAMPLES = 960;
const GUARD_SAMPLES = 100;
const SYNC_SYMBOLS = 2;
const TAIL_SAMPLES = 100;
const HEADER_BYTES = 5;
const SYMBOL_LEN = P.fftSize + P.cyclicPrefix;
const BITS_PER_SYMBOL = P.subcarrierCount * 2;
const NSYM = P.rsN - P.rsK;
const DATA_SYMBOLS_PER_FRAME = Math.ceil(((HEADER_BYTES + P.payloadBytes + NSYM) * 8) / BITS_PER_SYMBOL);

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

// RS 编码
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
function rsEncode(data, nsym) {
  const gen = rsGeneratorPoly(nsym);
  const padded = [...data, ...new Array(nsym).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = padded[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        padded[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return [...data, ...padded.slice(data.length)];
}

// FFT/IFFT
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

// QPSK 映射
const QPSK = [
  [1, 1], [1, -1], [-1, 1], [-1, -1]
];
const QPSK_NORM = 1 / Math.SQRT2;

// 同步序列
let syncRe = null;
let syncIm = null;
function getSyncSequence() {
  if (syncRe) return;
  const total = P.subcarrierCount * SYNC_SYMBOLS;
  syncRe = new Float32Array(total);
  syncIm = new Float32Array(total);
  let lfsr = 0xace1;
  for (let i = 0; i < total; i++) {
    let bit0 = lfsr & 1; lfsr >>= 1; if (bit0) lfsr ^= 0xb400;
    let bit1 = lfsr & 1; lfsr >>= 1; if (bit1) lfsr ^= 0xb400;
    const idx = (bit0 << 1) | bit1;
    syncRe[i] = QPSK[idx][0] * QPSK_NORM;
    syncIm[i] = QPSK[idx][1] * QPSK_NORM;
  }
}

// Chirp 前导码
let chirpCache = null;
function getChirp() {
  if (chirpCache) return chirpCache;
  const n = PREAMBLE_SAMPLES;
  chirpCache = new Float32Array(n);
  const f0 = 18000, f1 = 20000;
  const T = n / sampleRate;
  const k = (f1 - f0) / T;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    chirpCache[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return chirpCache;
}

// OFDM 调制
function ofdmModSymbol(dataRe, dataIm, symOffset, output, outOffset) {
  const freqRe = new Float32Array(P.fftSize);
  const freqIm = new Float32Array(P.fftSize);
  for (let i = 0; i < P.subcarrierCount; i++) {
    const bin = P.subcarrierStart + i;
    const idx = symOffset + i;
    freqRe[bin] = dataRe[idx];
    freqIm[bin] = dataIm[idx];
    freqRe[P.fftSize - bin] = dataRe[idx];
    freqIm[P.fftSize - bin] = -dataIm[idx];
  }
  fftInPlace(freqRe, freqIm, true);
  for (let i = 0; i < P.cyclicPrefix; i++) {
    output[outOffset + i] = freqRe[P.fftSize - P.cyclicPrefix + i];
  }
  for (let i = 0; i < P.fftSize; i++) {
    output[outOffset + P.cyclicPrefix + i] = freqRe[i];
  }
}

// 帧编码
function encodeFrameAudio(frameIndex, totalFrames, dataType, payload) {
  getSyncSequence();
  const chirp = getChirp();

  const blockLen = HEADER_BYTES + P.payloadBytes;
  const block = new Array(blockLen).fill(0);
  block[0] = frameIndex & 0xff;
  block[1] = totalFrames & 0xff;
  block[2] = payload.length & 0xff;
  block[3] = dataType & 0xff;
  block[4] = 0;
  for (let i = 0; i < payload.length && i < P.payloadBytes; i++) {
    block[HEADER_BYTES + i] = payload[i];
  }

  const rsInput = [...new Array(P.rsK - blockLen).fill(0), ...block];
  const encoded = rsEncode(rsInput, NSYM);
  const codeword = encoded.slice(P.rsK - blockLen);

  const totalBits = codeword.length * 8;
  const bits = new Array(totalBits);
  for (let i = 0; i < codeword.length; i++) {
    for (let b = 7; b >= 0; b--) {
      bits[i * 8 + (7 - b)] = (codeword[i] >> b) & 1;
    }
  }

  const symCount = Math.ceil(bits.length / BITS_PER_SYMBOL) * P.subcarrierCount;
  while (bits.length < symCount / P.subcarrierCount * BITS_PER_SYMBOL) bits.push(0);
  const numSymbols = Math.floor(bits.length / 2);
  const allRe = new Float32Array((SYNC_SYMBOLS + DATA_SYMBOLS_PER_FRAME) * P.subcarrierCount);
  const allIm = new Float32Array((SYNC_SYMBOLS + DATA_SYMBOLS_PER_FRAME) * P.subcarrierCount);

  if (syncRe && syncIm) {
    allRe.set(syncRe);
    allIm.set(syncIm);
  }

  for (let i = 0; i < numSymbols; i++) {
    const idx = (SYNC_SYMBOLS * P.subcarrierCount) + i;
    const qIdx = (bits[i * 2] << 1) | bits[i * 2 + 1];
    allRe[idx] = QPSK[qIdx][0] * QPSK_NORM;
    allIm[idx] = QPSK[qIdx][1] * QPSK_NORM;
  }

  const totalSyms = SYNC_SYMBOLS + DATA_SYMBOLS_PER_FRAME;
  const ofdmLen = totalSyms * SYMBOL_LEN;
  const ofdmOutput = new Float32Array(ofdmLen);
  for (let s = 0; s < totalSyms; s++) {
    ofdmModSymbol(allRe, allIm, s * P.subcarrierCount, ofdmOutput, s * SYMBOL_LEN);
  }

  const totalLen = PREAMBLE_SAMPLES + GUARD_SAMPLES + ofdmLen + TAIL_SAMPLES;
  const frame = new Float32Array(totalLen);
  frame.set(chirp, 0);
  frame.set(ofdmOutput, PREAMBLE_SAMPLES + GUARD_SAMPLES);

  return frame;
}

// 编码器处理器
class EncoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameQueue = [];
    this.sampleBuffer = new Float32Array(0);
    this.bufferOffset = 0;
    this.isTransmitting = false;
    this.isPaused = false;
    this.currentFrame = 0;
    this.totalFrames = 0;
    this.startTime = 0;
    this.bytesSent = 0;
    this.amplitude = 0.8;
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'enqueueData':
        this.frameQueue = msg.frames.map((f) => ({
          index: f.index,
          total: f.total,
          dataType: f.dataType,
          payload: new Uint8Array(f.payload),
        }));
        this.totalFrames = this.frameQueue.length;
        this.currentFrame = 0;
        this.bytesSent = 0;
        break;

      case 'startTx':
        this.isTransmitting = true;
        this.isPaused = false;
        this.startTime = currentTime;
        this.encodeNextFrame();
        break;

      case 'stopTx':
        this.isTransmitting = false;
        this.frameQueue = [];
        this.sampleBuffer = new Float32Array(0);
        this.currentFrame = 0;
        break;

      case 'pauseTx':
        this.isPaused = true;
        break;

      case 'resumeTx':
        this.isPaused = false;
        break;

      case 'setAmplitude':
        this.amplitude = Math.max(0, Math.min(1, msg.value));
        break;
    }
  }

  encodeNextFrame() {
    if (this.frameQueue.length === 0) {
      this.isTransmitting = false;
      this.port.postMessage({ type: 'txDone' });
      return;
    }

    const frame = this.frameQueue.shift();
    const audio = encodeFrameAudio(frame.index, frame.total, frame.dataType, frame.payload);

    const newBuffer = new Float32Array(this.sampleBuffer.length - this.bufferOffset + audio.length);
    newBuffer.set(this.sampleBuffer.subarray(this.bufferOffset), 0);
    newBuffer.set(audio, this.sampleBuffer.length - this.bufferOffset);
    this.sampleBuffer = newBuffer;
    this.bufferOffset = 0;

    this.currentFrame = frame.index + 1;
    this.bytesSent += frame.payload.length;

    this.port.postMessage({
      type: 'txStats',
      stats: {
        currentFrame: this.currentFrame,
        totalFrames: this.totalFrames,
        progress: this.totalFrames > 0 ? this.currentFrame / this.totalFrames : 0,
        bitrate: this.calculateBitrate(),
        signalQuality: 1.0,
      },
    });
  }

  calculateBitrate() {
    if (this.startTime === 0 || this.bytesSent === 0) return 0;
    const elapsed = currentTime - this.startTime;
    if (elapsed <= 0) return 0;
    return Math.floor((this.bytesSent * 8) / elapsed);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const renderQuantum = channel.length;

    if (!this.isTransmitting || this.isPaused) {
      channel.fill(0);
      return true;
    }

    const remaining = this.sampleBuffer.length - this.bufferOffset;
    if (remaining < renderQuantum * 4 && this.frameQueue.length > 0) {
      this.encodeNextFrame();
    }

    const available = this.sampleBuffer.length - this.bufferOffset;
    if (available >= renderQuantum) {
      for (let i = 0; i < renderQuantum; i++) {
        channel[i] = this.sampleBuffer[this.bufferOffset + i] * this.amplitude;
      }
      this.bufferOffset += renderQuantum;
    } else if (available > 0) {
      for (let i = 0; i < available; i++) {
        channel[i] = this.sampleBuffer[this.bufferOffset + i] * this.amplitude;
      }
      for (let i = available; i < renderQuantum; i++) {
        channel[i] = 0;
      }
      this.bufferOffset += available;
    } else {
      if (this.frameQueue.length > 0) {
        this.encodeNextFrame();
      } else {
        channel.fill(0);
        if (this.isTransmitting) {
          this.isTransmitting = false;
          this.port.postMessage({ type: 'txDone' });
        }
      }
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    return true;
  }
}

registerProcessor('encoder-processor', EncoderProcessor);
