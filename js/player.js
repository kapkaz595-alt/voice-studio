// player.js - 解码、波形峰值计算、播放与波形绘制

// 解码录音为 AudioBuffer（后续变声、编辑也会用到）
export async function decodeBlob(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const data = await blob.arrayBuffer();
    return await ctx.decodeAudioData(data);
  } finally {
    ctx.close().catch(() => {});
  }
}

// 计算 n 个峰值（0~1，已归一化）
export function computePeaks(audioBuffer, n = 400) {
  const data = audioBuffer.getChannelData(0);
  const size = Math.max(1, Math.floor(data.length / n));
  const peaks = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min((i + 1) * size, data.length);
    for (let j = i * size; j < end; j++) {
      const a = Math.abs(data[j]);
      if (a > m) m = a;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  if (max > 0.001) for (let i = 0; i < n; i++) peaks[i] /= max;
  return peaks;
}

export class WavePlayer {
  // onChange({ current, duration, playing })
  constructor({ canvas, audio, onChange }) {
    this.canvas = canvas;
    this.audio = audio;
    this.onChange = onChange || (() => {});
    this.peaks = null;
    this.duration = 0;
    this.rafId = 0;
    this.dragging = false;

    audio.addEventListener('play', () => { this._loop(); this._emit(); });
    audio.addEventListener('pause', () => { cancelAnimationFrame(this.rafId); this._refresh(); });
    audio.addEventListener('ended', () => {
      cancelAnimationFrame(this.rafId);
      audio.currentTime = 0;
      this._refresh();
    });

    canvas.addEventListener('pointerdown', e => {
      if (!this.duration) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this._seekFromEvent(e);
    });
    canvas.addEventListener('pointermove', e => { if (this.dragging) this._seekFromEvent(e); });
    const end = () => { this.dragging = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    if (window.ResizeObserver) new ResizeObserver(() => this._draw()).observe(canvas);
  }

  load({ url, peaks, duration }) {
    this.audio.src = url;
    this.peaks = peaks || new Float32Array(400).fill(0.08);
    this.duration = duration || 0;
    this._refresh();
  }

  get playing() { return !this.audio.paused && !this.audio.ended; }

  get current() { return Math.min(this.audio.currentTime || 0, this.duration || 0); }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() { return this.audio.play().catch(() => {}); }

  pause() { this.audio.pause(); }

  reset() {
    this.pause();
    cancelAnimationFrame(this.rafId);
    this.audio.removeAttribute('src');
    this.audio.load();
    this.peaks = null;
    this.duration = 0;
    this._refresh();
  }

  _seekFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.audio.currentTime = ratio * this.duration;
    this._refresh();
  }

  _loop() {
    this._refresh();
    if (this.playing) this.rafId = requestAnimationFrame(() => this._loop());
  }

  _refresh() {
    this._draw();
    this._emit();
  }

  _emit() {
    this.onChange({ current: this.current, duration: this.duration, playing: this.playing });
  }

  _draw() {
    const cv = this.canvas;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks) return;

    const css = getComputedStyle(document.documentElement);
    const played = css.getPropertyValue('--accent').trim() || '#ff4d5e';
    const rest = css.getPropertyValue('--wave').trim() || '#4a5163';

    const bar = 3;
    const gap = 2;
    const n = Math.max(1, Math.floor(w / (bar + gap)));
    const progress = this.duration ? this.current / this.duration : 0;
    const len = this.peaks.length;

    for (let i = 0; i < n; i++) {
      const s = Math.floor((i * len) / n);
      const e = Math.max(s + 1, Math.floor(((i + 1) * len) / n));
      let m = 0;
      for (let k = s; k < e && k < len; k++) if (this.peaks[k] > m) m = this.peaks[k];
      const bh = Math.max(3, m * (h - 16));
      ctx.fillStyle = (i + 0.5) / n <= progress ? played : rest;
      ctx.fillRect(i * (bar + gap), (h - bh) / 2, bar, bh);
    }

    // 播放头
    const x = Math.min(w - 1, progress * w);
    ctx.fillStyle = played;
    ctx.fillRect(x, 0, 1.5, h);
  }
}
