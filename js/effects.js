// effects.js - 变声：音调与音色（共振峰）分开调整 + EQ + 机器人
//
// pitch   = 音调（半音）：正数更高，负数更低
// formant = 音色（半音）：正数更尖细（像更小的人），负数更粗壮（像更大的人）
// 男声 -> 女声：音调大幅升高，音色小幅升高；男声 -> 大叔：音调降低，音色小幅降低

export const PRESETS = [
  { id: 'original', name: '原声', desc: '不处理', pitch: 0, formant: 0 },
  {
    id: 'uncle', name: '大叔', desc: '低沉浑厚', pitch: -4, formant: -2,
    filters: [{ type: 'lowshelf', frequency: 200, gain: 3 }],
  },
  {
    id: 'woman', name: '中年女声', desc: '适合男声录音', pitch: 6, formant: 3,
    filters: [
      { type: 'lowshelf', frequency: 180, gain: -3 },
      { type: 'peaking', frequency: 3000, gain: 2, Q: 0.8 },
    ],
  },
  {
    id: 'child', name: '儿童', desc: '尖细可爱', pitch: 9, formant: 5,
    filters: [{ type: 'lowshelf', frequency: 250, gain: -5 }],
  },
  {
    id: 'robot', name: '机器人', desc: '单一音高', pitch: 0, formant: 0, robot: 110,
    filters: [
      { type: 'highpass', frequency: 100 },
      { type: 'peaking', frequency: 1500, gain: 3, Q: 1 },
    ],
  },
  {
    id: 'monster', name: '怪兽', desc: '极低沉', pitch: -9, formant: -5,
    filters: [
      { type: 'lowshelf', frequency: 200, gain: 5 },
      { type: 'lowpass', frequency: 4500 },
    ],
  },
];

/* ---------- FFT ---------- */
class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.rev[i] = (this.rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  // 原地变换；inverse 时已除以 n
  transform(re, im, inverse) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const wr = this.cos[k];
          const wi = inverse ? this.sin[k] : -this.sin[k];
          const l = j + half;
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function toMono(buffer) {
  const n = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < n; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / n;
  }
  return out;
}

/* ---------- 音调 + 音色 分离（相位声码器 + 倒谱包络） ---------- */
export function pitchFormantShift(x, sr, pitchSt, formantSt) {
  const P = Math.pow(2, pitchSt / 12);
  const F = Math.pow(2, formantSt / 12);
  const N = sr >= 32000 ? 2048 : 1024;
  const half = N / 2;
  const osamp = 4;
  const hop = N / osamp;
  const twoPi = 2 * Math.PI;
  const expct = (twoPi * hop) / N;
  const q = Math.max(20, Math.round(sr / 450)); // 倒谱截断：包络平滑度

  const fft = new FFT(N);
  const win = hann(N);
  let wsum = 0;
  for (let j = 0; j < osamp; j++) wsum += win[j * hop] * win[j * hop];
  const scale = 1 / wsum;

  const len = x.length;
  const total = len + 2 * N;
  const xp = new Float32Array(total);
  xp.set(x, N);
  const outp = new Float64Array(total);

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const cre = new Float64Array(N);
  const cim = new Float64Array(N);
  const magn = new Float64Array(half + 1);
  const anaFreq = new Float64Array(half + 1);
  const env = new Float64Array(half + 1);
  const resid = new Float64Array(half + 1);
  const lastPhase = new Float64Array(half + 1);
  const sumPhase = new Float64Array(half + 1);

  for (let s = 0; s + N <= total; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = xp[s + i] * win[i]; im[i] = 0; }
    fft.transform(re, im, false);

    // 分析：幅度 + 精确频率（单位：bin）
    for (let k = 0; k <= half; k++) {
      magn[k] = Math.hypot(re[k], im[k]);
      const ph = Math.atan2(im[k], re[k]);
      let tmp = ph - lastPhase[k] - k * expct;
      lastPhase[k] = ph;
      tmp -= twoPi * Math.round(tmp / twoPi);
      anaFreq[k] = k + (osamp * tmp) / twoPi;
    }

    // 频谱包络（倒谱平滑）
    for (let k = 0; k <= half; k++) { cre[k] = Math.log(magn[k] + 1e-7); cim[k] = 0; }
    for (let k = 1; k < half; k++) { cre[N - k] = cre[k]; cim[N - k] = 0; }
    fft.transform(cre, cim, true);
    for (let n = q + 1; n < N - q; n++) { cre[n] = 0; cim[n] = 0; }
    fft.transform(cre, cim, false);
    for (let k = 0; k <= half; k++) {
      env[k] = Math.exp(cre[k]);
      resid[k] = magn[k] / env[k];
    }

    // 合成：谐波结构按 P 重映射，包络按 F 重映射
    re.fill(0);
    im.fill(0);
    for (let k = 0; k <= half; k++) {
      const j = Math.round(k / P);
      let m = 0;
      let freq = k;
      if (j <= half) {
        freq = anaFreq[j] * P;
        const pos = k / F;
        let e;
        if (pos >= half) e = env[half];
        else {
          const i0 = Math.floor(pos);
          e = env[i0] + (env[i0 + 1] - env[i0]) * (pos - i0);
        }
        m = resid[j] * e;
      }
      let tmp = ((freq - k) * twoPi) / osamp + k * expct;
      sumPhase[k] += tmp;
      const ph = sumPhase[k];
      re[k] = m * Math.cos(ph);
      im[k] = m * Math.sin(ph);
    }
    for (let k = 1; k < half; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    im[0] = 0;
    im[half] = 0;
    fft.transform(re, im, true);

    for (let i = 0; i < N; i++) outp[s + i] += re[i] * win[i] * scale;
  }

  const out = new Float32Array(len);
  let ein = 0;
  let eout = 0;
  for (let i = 0; i < len; i++) {
    out[i] = outp[N + i];
    ein += x[i] * x[i];
    eout += out[i] * out[i];
  }
  // 与原声保持同样响度
  const g = eout > 1e-12 ? Math.sqrt(ein / eout) : 1;
  for (let i = 0; i < len; i++) out[i] *= g;
  return out;
}

/* ---------- 机器人：每帧相位清零 -> 固定音高的脉冲串 ---------- */
export function robotize(x, sr, f0 = 110) {
  const N = 2048;
  const half = N / 2;
  const hop = Math.max(64, Math.round(sr / f0));
  const fft = new FFT(N);
  const win = hann(N);
  const len = x.length;
  const total = len + 2 * N;
  const xp = new Float32Array(total);
  xp.set(x, N);
  const outp = new Float64Array(total);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let s = 0; s + N <= total; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = xp[s + i] * win[i]; im[i] = 0; }
    fft.transform(re, im, false);
    for (let k = 0; k < N; k++) { re[k] = Math.hypot(re[k], im[k]); im[k] = 0; }
    fft.transform(re, im, true);
    for (let i = 0; i < N; i++) outp[s + i] += re[(i + half) % N] * win[i];
  }

  const out = new Float32Array(len);
  let ein = 0;
  let eout = 0;
  for (let i = 0; i < len; i++) {
    out[i] = outp[N + i];
    ein += x[i] * x[i];
    eout += out[i] * out[i];
  }
  const g = eout > 0 ? Math.sqrt(ein / eout) : 1; // 与原声同样响度
  for (let i = 0; i < len; i++) out[i] *= g;
  return out;
}

const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// 应用预设，返回新的 AudioBuffer（单声道）。extra = { pitch, formant } 为用户微调（半音）
export async function applyPreset(buffer, preset, extra = {}) {
  const pitch = (preset.pitch || 0) + (extra.pitch || 0);
  const formant = (preset.formant || 0) + (extra.formant || 0);
  if (pitch === 0 && formant === 0 && !preset.filters && !preset.robot) return buffer;

  const sr = buffer.sampleRate;
  let data = toMono(buffer);
  if (preset.robot) data = robotize(data, sr, preset.robot);
  if (pitch !== 0 || formant !== 0) data = pitchFormantShift(data, sr, pitch, formant);

  const ctx = new OfflineCtx(1, data.length, sr);
  const buf = ctx.createBuffer(1, data.length, sr);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  let node = src;
  for (const f of preset.filters || []) {
    const bq = ctx.createBiquadFilter();
    bq.type = f.type;
    bq.frequency.value = f.frequency;
    if (f.gain !== undefined) bq.gain.value = f.gain;
    if (f.Q) bq.Q.value = f.Q;
    node.connect(bq);
    node = bq;
  }
  node.connect(ctx.destination);
  src.start();

  const out = await ctx.startRendering();
  const d = out.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.98) {
    const k = 0.98 / peak;
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return out;
}
