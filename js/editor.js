// editor.js - 编辑：选区裁剪/删除、撤销、音量、淡入淡出

const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

function makeBuffer(ch, len, sr) {
  return new OfflineCtx(1, 1, sr).createBuffer(ch, Math.max(1, len), sr);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

  const ed = {
    source: null, base: null, undo: [],
    selStart: 0, selEnd: 1,
    gain: 100, fadeIn: 0, fadeOut: 0,
    url: null,
  };

  const wholeSelected = () => ed.selStart <= 0.001 && ed.selEnd >= 0.999;

  function resetParams() {
    ed.gain = 100; ed.fadeIn = 0; ed.fadeOut = 0;
    gainIn.value = 100; fadeInIn.value = 0; fadeOutIn.value = 0;
    $('ed-gain-val').textContent = '100%';
    $('ed-fadein-val').textContent = '0.0 秒';
    $('ed-fadeout-val').textContent = '0.0 秒';
  }

  function updateSel() {
    sel.style.left = ed.selStart * 100 + '%';
    sel.style.right = (1 - ed.selEnd) * 100 + '%';
    const d = ed.base ? ed.base.duration : 0;
    info.textContent =
      `选区 ${fmt(ed.selStart * d)} – ${fmt(ed.selEnd * d)}（${((ed.selEnd - ed.selStart) * d).toFixed(1)} 秒） · 总长 ${d.toFixed(1)} 秒`;
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
    status.textContent = ed.gain > 100 && peakOf(out) > 1 ? '音量过大，可能失真，建议调低音量' : '';
  }

  function applyBase(newBase) {
    ed.undo.push(ed.base);
    if (ed.undo.length > 10) ed.undo.shift();
    ed.base = newBase;
    ed.selStart = 0;
    ed.selEnd = 1;
    render();
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

  /* 按钮 */
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

  /* 滑块：拖动时更新文字，松手后重新生成 */
  gainIn.addEventListener('input', () => { $('ed-gain-val').textContent = gainIn.value + '%'; });
  gainIn.addEventListener('change', () => { ed.gain = Number(gainIn.value); render(); });
  fadeInIn.addEventListener('input', () => { $('ed-fadein-val').textContent = Number(fadeInIn.value).toFixed(1) + ' 秒'; });
  fadeInIn.addEventListener('change', () => { ed.fadeIn = Number(fadeInIn.value); render(); });
  fadeOutIn.addEventListener('input', () => { $('ed-fadeout-val').textContent = Number(fadeOutIn.value).toFixed(1) + ' 秒'; });
  fadeOutIn.addEventListener('change', () => { ed.fadeOut = Number(fadeOutIn.value); render(); });

  $('ed-goto').addEventListener('click', goRecord);

  /* 进入编辑页：源音频 = 变声结果（若有）否则原始录音 */
  function refresh() {
    const rec = state.recording;
    const src = (state.processed && state.processed.buffer) || (rec && rec.buffer) || null;
    $('ed-empty').hidden = !!src;
    $('ed-main').hidden = !src;
    $('ed-empty-text').textContent = rec && !rec.buffer
      ? '当前录音无法解码，不能编辑。请换用 Chrome 或 Safari 重新录音。'
      : '请先在“录音”页录一段声音。';
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
  }

  return { refresh, reset, pause: () => player.pause() };
}
