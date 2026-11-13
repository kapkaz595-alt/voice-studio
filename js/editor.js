// editor.js - 编辑：选区裁剪/删除、撤销、音量、淡入淡出、降噪、标准化、变速、拼接

import { FFT, hann, toMono, pitchFormantShift } from './effects.js';
import { listRecordings } from './storage.js';
import { decodeBlob } from './player.js';
import { t, setText } from './i18n.js';

const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

function makeBuffer(ch, len, sr) {
  return new OfflineCtx(1, 1, sr).createBuffer(ch, Math.max(1, len), sr);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 音频处理函数 ---------- */

// 保留 [start, end] 秒
export function sliceBuffer(buf, start, end) {
  const sr = buf.sampleRate;
  const s = clamp(Math.round(start * sr), 0, buf.length - 1);
  const e = clamp(Math.round(end * sr), s + 1, buf.length);
  const out = makeBuffer(buf.numberOfChannels, e - s, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).slice(s, e), c);
  }
  return out;
}

// 删除 [start, end] 秒，前后两段接起来
export function cutBuffer(buf, start, end) {
  const sr = buf.sampleRate;
  const s = clamp(Math.round(start * sr), 0, buf.length);
  const e = clamp(Math.round(end * sr), s, buf.length);
  const len = buf.length - (e - s);
  const out = makeBuffer(buf.numberOfChannels, len, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const o = new Float32Array(Math.max(1, len));
    o.set(d.subarray(0, s), 0);
    o.set(d.subarray(e), s);
    out.copyToChannel(o, c);
  }
  return out;
}

// 音量（倍数）+ 淡入淡出（秒，线性）。无需处理时返回原 buffer
export function applyGainFade(buf, { gain = 1, fadeIn = 0, fadeOut = 0 } = {}) {
  if (gain === 1 && !fadeIn && !fadeOut) return buf;
  const sr = buf.sampleRate;
  const len = buf.length;
  const fi = Math.min(Math.round(fadeIn * sr), len);
  const fo = Math.min(Math.round(fadeOut * sr), len);
  const out = makeBuffer(buf.numberOfChannels, len, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const o = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let g = gain;
      if (i < fi) g *= i / fi;
      const r = len - 1 - i;
      if (r < fo) g *= r / fo;
      o[i] = d[i] * g;
    }
    out.copyToChannel(o, c);
  }
  return out;
}

export function peakOf(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// 音量标准化：最大峰值调到 target
export function normalizeBuffer(buf, target = 0.95) {
  const peak = peakOf(buf);
  if (peak < 1e-4) return buf;
  return applyGainFade(buf, { gain: target / peak });
}

// 降噪（谱减法）：用录音里最安静的 10% 片段作为噪声样本。strength 0~1
export function denoiseBuffer(buf, strength) {
  const N = 1024;
  const half = N / 2;
  const hop = N / 4;
  const fft = new FFT(N);
  const win = hann(N);
  const scale = 1 / 1.5;
  const alpha = 1 + 2.5 * strength;
  const floor = 0.03 + (1 - strength) * 0.25;
  const out = makeBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    const len = x.length;
    const total = len + 2 * N;
    const xp = new Float32Array(total);
    xp.set(x, N);
    const frame = s => {
      for (let i = 0; i < N; i++) { re[i] = xp[s + i] * win[i]; im[i] = 0; }
      fft.transform(re, im, false);
    };

    // 1) 每帧能量
    const starts = [];
    for (let s = 0; s + N <= total; s += hop) starts.push(s);
    const energy = new Float64Array(starts.length);
    for (let f = 0; f < starts.length; f++) {
      let e = 0;
      const s = starts[f];
      for (let i = 0; i < N; i++) e += xp[s + i] * xp[s + i];
      energy[f] = e;
    }

    // 2) 噪声谱 = 最安静 10% 帧的平均幅度
    const order = Array.from(energy.keys()).sort((a, b) => energy[a] - energy[b]);
    const nq = Math.max(3, Math.floor(starts.length * 0.1));
    const noise = new Float64Array(half + 1);
    for (let i = 0; i < nq; i++) {
      frame(starts[order[i]]);
      for (let k = 0; k <= half; k++) noise[k] += Math.hypot(re[k], im[k]) / nq;
    }

    // 3) 逐帧谱减 + 时间平滑
    const outp = new Float64Array(total);
    const prev = new Float64Array(half + 1).fill(1);
    for (const s of starts) {
      frame(s);
      for (let k = 0; k <= half; k++) {
        const m = Math.hypot(re[k], im[k]);
        let g = Math.max(floor, 1 - (alpha * noise[k]) / (m + 1e-9));
        g = 0.6 * g + 0.4 * prev[k];
        prev[k] = g;
        re[k] *= g;
        im[k] *= g;
      }
      for (let k = 1; k < half; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      im[0] = 0;
      im[half] = 0;
      fft.transform(re, im, true);
      for (let i = 0; i < N; i++) outp[s + i] += re[i] * win[i] * scale;
    }

    const o = new Float32Array(len);
    for (let i = 0; i < len; i++) o[i] = outp[N + i];
    out.copyToChannel(o, c);
  }
  return out;
}

// 变速不变调：s > 1 更快。先重采样改变速度，再把音调和音色恢复
export function changeSpeed(buf, s) {
  if (Math.abs(s - 1) < 0.01) return buf;
  const sr = buf.sampleRate;
  const x = toMono(buf);
  const len = Math.max(1, Math.round(x.length / s));
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * s;
    const i0 = Math.floor(p);
    const f = p - i0;
    y[i] = (x[i0] || 0) * (1 - f) + (x[i0 + 1] || 0) * f;
  }
  const st = -12 * Math.log2(s);
  const z = pitchFormantShift(y, sr, st, st);
  const out = makeBuffer(1, len, sr);
  out.copyToChannel(z, 0);
  return out;
}

async function resampleTo(buf, sr) {
  if (buf.sampleRate === sr) return buf;
  const ctx = new OfflineCtx(buf.numberOfChannels, Math.ceil((buf.length * sr) / buf.sampleRate), sr);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

// 把 other 插入 base 的 atSec 秒处
export async function insertBuffer(base, other, atSec) {
  const sr = base.sampleRate;
  other = await resampleTo(other, sr);
  const at = clamp(Math.round(atSec * sr), 0, base.length);
  const len = base.length + other.length;
  const out = makeBuffer(base.numberOfChannels, len, sr);
  for (let c = 0; c < base.numberOfChannels; c++) {
    const b = base.getChannelData(c);
    const a = other.getChannelData(Math.min(c, other.numberOfChannels - 1));
    const o = new Float32Array(len);
    o.set(b.subarray(0, at), 0);
    o.set(a, at);
    o.set(b.subarray(at), at + a.length);
    out.copyToChannel(o, c);
  }
  return out;
}

/* ---------- 编辑页界面 ---------- */
const fmt = sec => {
  const m = Math.floor(sec / 60);
  return String(m).padStart(2, '0') + ':' + (sec - m * 60).toFixed(1).padStart(4, '0');
};

export function initEditor({ $, state, makePlayer, computePeaks, audioBufferToWav, goRecord }) {
  const player = makePlayer({ canvas: 'ed-wave', audio: 'ed-audio', btn: 'ed-play-btn', time: 'ed-play-time' });
  const box = $('ed-box');
  const sel = $('ed-sel');
  const info = $('ed-sel-info');
  const status = $('ed-status');
  const btnCrop = $('ed-crop');
  const btnCut = $('ed-cut');
  const btnUndo = $('ed-undo');
  const btnReset = $('ed-reset');
  const gainIn = $('ed-gain');
  const fadeInIn = $('ed-fadein');
  const fadeOutIn = $('ed-fadeout');
  const denoiseIn = $('ed-denoise');
  const speedIn = $('ed-speed');
  const picker = $('ed-picker');
  const toolEls = [$('ed-normalize'), $('ed-denoise-btn'), $('ed-speed-btn'), $('ed-append'), denoiseIn, speedIn];

  const ed = {
    source: null, base: null, undo: [],
    selStart: 0, selEnd: 1,
    gain: 100, fadeIn: 0, fadeOut: 0,
    url: null,
  };

  const wholeSelected = () => ed.selStart <= 0.001 && ed.selEnd >= 0.999;
  const secText = v => `${Number(v).toFixed(1)} ${t('unit.sec')}`;

  function setLabels() {
    $('ed-gain-val').textContent = gainIn.value + '%';
    $('ed-fadein-val').textContent = secText(fadeInIn.value);
    $('ed-fadeout-val').textContent = secText(fadeOutIn.value);
    $('ed-denoise-val').textContent = denoiseIn.value + '%';
    $('ed-speed-val').textContent = Number(speedIn.value).toFixed(2) + '×';
  }

  function resetParams() {
    ed.gain = 100; ed.fadeIn = 0; ed.fadeOut = 0;
    gainIn.value = 100; fadeInIn.value = 0; fadeOutIn.value = 0;
    denoiseIn.value = 50; speedIn.value = 1;
    setLabels();
  }

  function updateSel() {
    sel.style.left = ed.selStart * 100 + '%';
    sel.style.right = (1 - ed.selEnd) * 100 + '%';
    const d = ed.base ? ed.base.duration : 0;
    setText(info, 'ed.selInfo', {
      a: fmt(ed.selStart * d), b: fmt(ed.selEnd * d),
      c: ((ed.selEnd - ed.selStart) * d).toFixed(1), d: d.toFixed(1),
    });
    btnCrop.disabled = wholeSelected();
    btnCut.disabled = wholeSelected();
    btnUndo.disabled = ed.undo.length === 0;
  }

  function render() {
    player.pause();
    const out = applyGainFade(ed.base, {
      gain: ed.gain / 100, fadeIn: ed.fadeIn, fadeOut: ed.fadeOut,
    });
    const blob = audioBufferToWav(out);
    const url = URL.createObjectURL(blob);
    if (ed.url) URL.revokeObjectURL(ed.url);
    ed.url = url;
    state.edited = { buffer: out, blob, url };
    player.load({ url, peaks: computePeaks(out), duration: out.duration });
    updateSel();
    if (ed.gain > 100 && peakOf(out) > 1) setText(status, 'ed.warn.loud');
    else setText(status, null);
  }

  function applyBase(newBase) {
    ed.undo.push(ed.base);
    if (ed.undo.length > 10) ed.undo.shift();
    ed.base = newBase;
    ed.selStart = 0;
    ed.selEnd = 1;
    render();
  }

  // 耗时操作：先提示“处理中”，再在下一帧执行
  async function runTool(fn) {
    if (!ed.base) return;
    toolEls.forEach(e => { e.disabled = true; });
    setText(status, 'ed.processing');
    await sleep(40);
    try {
      const out = await fn();
      if (out && out !== ed.base) {
        applyBase(out);
        setText(status, 'ed.done');
      } else {
        setText(status, null);
      }
    } catch (e) {
      setText(status, 'ed.fail', { m: e.i18n ? t(e.i18n) : (e.message || String(e)) });
    } finally {
      toolEls.forEach(el => { el.disabled = false; });
    }
  }

  /* 选区手柄 */
  function bindHandle(h, isLeft) {
    let drag = false;
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      drag = true;
    });
    h.addEventListener('pointermove', e => {
      if (!drag || !ed.base) return;
      const r = box.getBoundingClientRect();
      const v = clamp((e.clientX - r.left) / r.width, 0, 1);
      const gap = Math.min(0.5, 0.05 / ed.base.duration);
      if (isLeft) ed.selStart = Math.min(v, ed.selEnd - gap);
      else ed.selEnd = Math.max(v, ed.selStart + gap);
      ed.selStart = Math.max(0, ed.selStart);
      ed.selEnd = Math.min(1, ed.selEnd);
      updateSel();
    });
    const end = () => { drag = false; };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }
  bindHandle($('ed-h-left'), true);
  bindHandle($('ed-h-right'), false);

  /* 基本按钮 */
  $('ed-play-sel').addEventListener('click', () => {
    if (!ed.base) return;
    const d = ed.base.duration;
    player.playRange(ed.selStart * d, ed.selEnd * d);
  });
  btnCrop.addEventListener('click', () => {
    if (wholeSelected()) return;
    const d = ed.base.duration;
    applyBase(sliceBuffer(ed.base, ed.selStart * d, ed.selEnd * d));
  });
  btnCut.addEventListener('click', () => {
    if (wholeSelected()) return;
    const d = ed.base.duration;
    applyBase(cutBuffer(ed.base, ed.selStart * d, ed.selEnd * d));
  });
  btnUndo.addEventListener('click', () => {
    if (!ed.undo.length) return;
    ed.base = ed.undo.pop();
    ed.selStart = 0;
    ed.selEnd = 1;
    render();
  });
  btnReset.addEventListener('click', () => {
    if (!ed.source) return;
    ed.base = ed.source;
    ed.undo = [];
    ed.selStart = 0;
    ed.selEnd = 1;
    resetParams();
    render();
  });

  /* 音量 / 淡入淡出：拖动时更新文字，松手后重新生成 */
  gainIn.addEventListener('input', setLabels);
  gainIn.addEventListener('change', () => { ed.gain = Number(gainIn.value); render(); });
  fadeInIn.addEventListener('input', setLabels);
  fadeInIn.addEventListener('change', () => { ed.fadeIn = Number(fadeInIn.value); render(); });
  fadeOutIn.addEventListener('input', setLabels);
  fadeOutIn.addEventListener('change', () => { ed.fadeOut = Number(fadeOutIn.value); render(); });

  /* 工具：标准化 / 降噪 / 变速 */
  denoiseIn.addEventListener('input', setLabels);
  speedIn.addEventListener('input', setLabels);
  $('ed-normalize').addEventListener('click', () => runTool(() => normalizeBuffer(ed.base)));
  $('ed-denoise-btn').addEventListener('click', () =>
    runTool(() => denoiseBuffer(ed.base, Number(denoiseIn.value) / 100)));
  $('ed-speed-btn').addEventListener('click', () =>
    runTool(() => changeSpeed(ed.base, Number(speedIn.value))));

  /* 追加 / 插入已保存的录音 */
  async function openPicker() {
    picker.hidden = false;
    const list = $('ed-picker-list');
    list.replaceChildren();
    let items = [];
    try {
      items = await listRecordings();
    } catch (e) {
      setText(status, 'ed.fail', { m: e.i18n ? t(e.i18n) : (e.message || String(e)) });
    }
    $('ed-picker-empty').hidden = items.length > 0;
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'picker-row';
      const name = document.createElement('div');
      name.className = 'picker-name';
      name.textContent = `${it.name} · ${Math.floor(it.duration / 60)}:${String(Math.floor(it.duration % 60)).padStart(2, '0')}`;
      const acts = document.createElement('div');
      acts.className = 'picker-acts';
      const add = (label, atEnd) => {
        const b = document.createElement('button');
        b.className = 'btn-secondary btn-small';
        b.textContent = label;
        b.addEventListener('click', () => {
          picker.hidden = true;
          runTool(async () => {
            const other = await decodeBlob(it.blob);
            return insertBuffer(ed.base, other, atEnd ? ed.base.duration : ed.selStart * ed.base.duration);
          });
        });
        acts.appendChild(b);
      };
      add(t('ed.pickEnd'), true);
      add(t('ed.pickAt'), false);
      row.append(name, acts);
      list.appendChild(row);
    }
  }
  $('ed-append').addEventListener('click', openPicker);
  $('ed-picker-close').addEventListener('click', () => { picker.hidden = true; });
  picker.addEventListener('click', e => { if (e.target === picker) picker.hidden = true; });

  $('ed-goto').addEventListener('click', goRecord);

  /* 进入编辑页：源音频 = 变声结果（若有）否则原始录音 */
  function refresh() {
    const rec = state.recording;
    const src = (state.processed && state.processed.buffer) || (rec && rec.buffer) || null;
    $('ed-empty').hidden = !!src;
    $('ed-main').hidden = !src;
    setText($('ed-empty-text'), rec && !rec.buffer ? 'empty.cannotDecode.ed' : 'empty.needRecording');
    if (!src) return;
    if (src !== ed.source) {
      ed.source = src;
      ed.base = src;
      ed.undo = [];
      ed.selStart = 0;
      ed.selEnd = 1;
      resetParams();
      render();
    } else if (!state.edited) {
      render();
    }
  }

  function reset() {
    player.reset();
    if (ed.url) URL.revokeObjectURL(ed.url);
    ed.url = null;
    ed.source = null;
    ed.base = null;
    ed.undo = [];
    state.edited = null;
    picker.hidden = true;
  }

  function relabel() {
    setLabels();
    if (!picker.hidden) openPicker();
  }

  setLabels();
  return { refresh, reset, relabel, pause: () => player.pause() };
}
