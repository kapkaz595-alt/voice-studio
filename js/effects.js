// effects.js - 变声：音调与音色（共振峰）分开调整 + EQ + 特效
//
// pitch   = 音调（半音）：正数更高，负数更低
// formant = 音色（半音）：正数更尖细（像更小的人），负数更粗壮（像更大的人）
// target  = 目标基频（Hz）：有它时，按录音者自己的音高自动算出需要升/降多少半音

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// fpp = 音色变化量 / 音调变化量（自动模式下用）
export const PRESETS = [
  { id: 'original' },
  {
    id: 'uncle', target: 95, fpp: 0.5, pitch: -4, formant: -2,
    filters: [{ type: 'lowshelf', frequency: 200, gain: 3 }],
  },
  {
    id: 'woman', target: 185, fpp: 0.3, pitch: 6, formant: 3,
    filters: [
      { type: 'lowshelf', frequency: 180, gain: -3 },
      { type: 'peaking', frequency: 3000, gain: 2, Q: 0.8 },
    ],
  },
  {
    id: 'girl', target: 235, fpp: 0.35, pitch: 9, formant: 4.5,
    filters: [
      { type: 'lowshelf', frequency: 220, gain: -4 },
      { type: 'highshelf', frequency: 4000, gain: 2 },
    ],
  },
  {
    id: 'man', target: 115, fpp: 0.4, pitch: -6, formant: -3,
    filters: [{ type: 'lowshelf', frequency: 180, gain: 3 }],
  },
  {
    id: 'child', target: 300, fpp: 0.35, pitch: 9, formant: 5,
    filters: [{ type: 'lowshelf', frequency: 250, gain: -5 }],
  },
  {
    id: 'robot', robot: 110,
    filters: [
      { type: 'highpass', frequency: 100 },
      { type: 'peaking', frequency: 1500, gain: 3, Q: 1 },
    ],
  },
  {
    id: 'monster', pitch: -9, formant: -5,
    filters: [
      { type: 'lowshelf', frequency: 200, gain: 5 },
      { type: 'lowpass', frequency: 4500 },
    ],
  },
  {
    id: 'alien', pitch: 4, formant: 3,
    filters: [{ type: 'highpass', frequency: 200 }],
    fx: [{ kind: 'vibrato', rate: 7, depth: 0.004 }],
  },
  { id: 'echo', fx: [{ kind: 'echo', time: 0.3, feedback: 0.4, mix: 0.5 }] },
  { id: 'reverb', fx: [{ kind: 'reverb', seconds: 2.4, mix: 0.45 }] },
  {
    id: 'phone',
    filters: [
      { type: 'highpass', frequency: 400 },
      { type: 'lowpass', frequency: 3000 },
      { type: 'peaking', frequency: 1200, gain: 4, Q: 1 },
    ],
    fx: [{ kind: 'distort', amount: 3 }],
  },
];

/* ---------- FFT ---------- */
export class FFT {
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

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function toMono(buffer) {
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
      const tmp = ((freq - k) * twoPi) / osamp + k * expct;
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

/* ---------- 检测说话人的平均音高（Hz） ---------- */
export function estimateF0(buffer) {
  const sr = buffer.sampleRate;
  const x = toMono(buffer);
  const step = Math.max(1, Math.round(sr / 8000));
  const fs = sr / step;
  const n = Math.min(Math.floor(x.length / step), Math.floor(fs * 40)); // 最多分析 40 秒
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < step; j++) s += x[i * step + j];
    y[i] = s / step;
  }

  const win = Math.round(fs * 0.04);
  const hop = Math.round(fs * 0.03);
  const minLag = Math.floor(fs / 400);
  const maxLag = Math.ceil(fs / 70);
  const need = win + maxLag + 1;

  const frames = [];
  let emax = 0;
  for (let s = 0; s + need <= n; s += hop) {
    let e = 0;
    for (let i = 0; i < win; i++) e += y[s + i] * y[s + i];
    frames.push({ s, e });
    if (e > emax) emax = e;
  }
  if (!frames.length) return { f0: 0, voiced: 0 };

  const f0s = [];
  const r = new Float32Array(maxLag + 2);
  for (const fr of frames) {
    if (fr.e < emax * 0.03) continue; // 太安静
    const s = fr.s;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let d = 0;
      let e1 = 0;
      for (let i = 0; i < win; i++) {
        const b = y[s + i + lag];
        d += y[s + i] * b;
        e1 += b * b;
      }
      r[lag] = d / Math.sqrt(fr.e * e1 + 1e-12);
      if (r[lag] > best) best = r[lag];
    }
    if (best < 0.6) continue; // 不是有声音（清音/噪声）
    let pick = 0;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { pick = lag; break; }
    }
    if (pick) f0s.push(fs / pick);
  }
  if (f0s.length < 5) return { f0: 0, voiced: f0s.length / frames.length };
  f0s.sort((a, b) => a - b);
  return { f0: f0s[f0s.length >> 1], voiced: f0s.length / frames.length };
}

/* ---------- 预设 -> 实际要变的半音数 ---------- */
// extra = { pitch, formant, f0 }；有 f0 且预设有 target 时，自动按说话人音高计算
export function resolveShift(preset, extra = {}) {
  let pitch = preset.pitch || 0;
  let formant = preset.formant || 0;
  let auto = false;
  if (preset.target && extra.f0 > 0) {
    pitch = clamp(12 * Math.log2(preset.target / extra.f0), -14, 14);
    formant = clamp(pitch * preset.fpp, -6, 6);
    auto = true;
  }
  return { pitch: pitch + (extra.pitch || 0), formant: formant + (extra.formant || 0), auto };
}

/* ---------- 特效节点 ---------- */
function tailSeconds(fx) {
  let t = 0;
  for (const f of fx || []) {
    if (f.kind === 'echo') t += Math.min(2.5, f.time * 5);
    if (f.kind === 'reverb') t += f.seconds;
  }
  return t;
}

function addFx(ctx, input, f, sr) {
  if (f.kind === 'echo') {
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    delay.delayTime.value = f.time;
    fb.gain.value = f.feedback;
    wet.gain.value = f.mix;
    input.connect(dry); dry.connect(out);
    input.connect(delay); delay.connect(wet); wet.connect(out);
    delay.connect(fb); fb.connect(delay);
    return out;
  }
  if (f.kind === 'reverb') {
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.gain.value = 0.8;
    wet.gain.value = f.mix;
    const len = Math.round(sr * f.seconds);
    const ir = ctx.createBuffer(1, len, sr);
    const d = ir.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    input.connect(dry); dry.connect(out);
    input.connect(conv); conv.connect(wet); wet.connect(out);
    return out;
  }
  if (f.kind === 'vibrato') {
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.01;
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = f.rate;
    depth.gain.value = f.depth;
    lfo.connect(depth); depth.connect(delay.delayTime);
    lfo.start();
    input.connect(delay);
    return delay;
  }
  if (f.kind === 'distort') {
    const sh = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    const norm = Math.tanh(f.amount);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(f.amount * (i / 512 - 1)) / norm;
    sh.curve = curve;
    sh.oversample = '2x';
    input.connect(sh);
    return sh;
  }
  return input;
}

const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// 应用预设，返回新的 AudioBuffer（单声道）。extra = { pitch, formant, f0 }
export async function applyPreset(buffer, preset, extra = {}) {
  const { pitch, formant } = resolveShift(preset, extra);
  const noShift = Math.abs(pitch) < 0.01 && Math.abs(formant) < 0.01;
  if (noShift && !preset.filters && !preset.robot && !preset.fx) return buffer;

  const sr = buffer.sampleRate;
  let data = toMono(buffer);
  if (preset.robot) data = robotize(data, sr, preset.robot);
  if (!noShift) data = pitchFormantShift(data, sr, pitch, formant);

  const total = data.length + Math.round(sr * tailSeconds(preset.fx));
  const ctx = new OfflineCtx(1, total, sr);
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
  for (const f of preset.fx || []) node = addFx(ctx, node, f, sr);
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
