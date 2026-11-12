// effects.js - 变声预设与音频处理（变调 + 音色 EQ + 机器人环形调制）

export const PRESETS = [
  { id: 'original', name: '原声', desc: '不处理', semitones: 0 },
  {
    id: 'uncle', name: '大叔', desc: '低沉浑厚', semitones: -4,
    filters: [
      { type: 'lowshelf', frequency: 220, gain: 5 },
      { type: 'highshelf', frequency: 4000, gain: -3 },
    ],
  },
  {
    id: 'woman', name: '中年女声', desc: '适合男声录音', semitones: 5,
    filters: [
      { type: 'lowshelf', frequency: 200, gain: -4 },
      { type: 'peaking', frequency: 2500, gain: 3, Q: 0.8 },
    ],
  },
  {
    id: 'child', name: '儿童', desc: '尖细可爱', semitones: 8,
    filters: [
      { type: 'lowshelf', frequency: 250, gain: -6 },
      { type: 'highshelf', frequency: 3500, gain: 3 },
    ],
  },
  {
    id: 'robot', name: '机器人', desc: '金属颤音', semitones: 0, ring: 45,
    filters: [{ type: 'highpass', frequency: 120 }],
  },
  {
    id: 'monster', name: '怪兽', desc: '极低沉', semitones: -9,
    filters: [
      { type: 'lowshelf', frequency: 200, gain: 6 },
      { type: 'lowpass', frequency: 4000 },
    ],
  },
];

function toMono(buffer) {
  const n = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < n; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / n;
  }
  return out;
}

// WSOLA 时间拉伸：音高不变，长度变为 alpha 倍
function wsola(x, alpha, sr) {
  const N = Math.max(256, Math.round((sr * 0.024) / 2) * 2); // 帧长约 24ms
  const Hs = N >> 1;
  const Ha = Hs / alpha;
  const tol = Math.round(sr * 0.012); // 搜索范围约 ±12ms
  const len = x.length;

  const xp = new Float32Array(len + N + tol + 4); // 末尾补零
  xp.set(x);

  const outLen = Math.ceil(len * alpha) + N;
  const out = new Float32Array(outLen);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  let prev = 0;
  for (let k = 0; ; k++) {
    const outPos = k * Hs;
    if (outPos + N > outLen) break;
    const nominal = Math.round(k * Ha);
    let best = Math.min(nominal, len);

    if (k > 0) {
      const ref = prev + Hs; // 上一帧的自然延续
      const lo = Math.max(0, nominal - tol);
      const hi = Math.min(len, nominal + tol);
      let bestScore = -Infinity;
      for (let c = lo; c <= hi; c += 2) {
        let dot = 0;
        let en = 1e-9;
        for (let i = 0; i < N; i += 4) {
          const a = xp[c + i];
          dot += a * xp[ref + i];
          en += a * a;
        }
        const score = dot / Math.sqrt(en);
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }

    for (let i = 0; i < N; i++) out[outPos + i] += xp[best + i] * win[i];
    prev = best;
  }
  return out;
}

// 变调（长度不变）：先拉伸 r 倍，再按 r 倍速重采样
export function pitchShift(x, sr, semitones) {
  const r = Math.pow(2, semitones / 12);
  const stretched = wsola(x, r, sr);
  const res = new Float32Array(x.length);
  for (let i = 0; i < res.length; i++) {
    const p = i * r;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = stretched[i0] || 0;
    const b = stretched[i0 + 1] || 0;
    res[i] = a + (b - a) * f;
  }
  return res;
}

const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// 应用预设，返回新的 AudioBuffer（单声道）。extraSemitones 为用户微调
export async function applyPreset(buffer, preset, extraSemitones = 0) {
  const st = preset.semitones + extraSemitones;
  if (st === 0 && !preset.filters && !preset.ring) return buffer;

  const sr = buffer.sampleRate;
  let data = toMono(buffer);
  if (st !== 0) data = pitchShift(data, sr, st);

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
  if (preset.ring) {
    const g = ctx.createGain();
    g.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.frequency.value = preset.ring;
    osc.connect(g.gain);
    osc.start();
    node.connect(g);
    node = g;
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
