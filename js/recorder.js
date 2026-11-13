// recorder.js - 录音（MediaRecorder）与麦克风权限处理
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

function pickMime() {
  return MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// 把错误转成 [词条 key, 参数]，界面按当前语言显示
export function explainError(err) {
  if (!window.isSecureContext) return ['err.https'];
  if (!isSupported()) return ['err.unsupported'];
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return ['err.denied'];
    case 'NotFoundError':
    case 'OverconstrainedError':
      return ['err.nomic'];
    case 'NotReadableError':
    case 'AbortError':
      return ['err.busy'];
    default:
      return ['err.generic', { m: (err && err.message) || '?' }];
  }
}

export class Recorder {
  constructor({ onLevel, onTick } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.state = 'idle'; // idle | recording
    this._reset();
  }

  _reset() {
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.audioCtx = null;
    this.rafId = 0;
    this.timerId = 0;
    this.startTime = 0;
  }

  async start() {
    if (this.state === 'recording') return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = pickMime();
    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(250);

    this._startMeter();
    this.startTime = performance.now();
    this.timerId = setInterval(() => {
      if (this.onTick) this.onTick((performance.now() - this.startTime) / 1000);
    }, 100);
    this.state = 'recording';
  }

  _startMeter() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !this.onLevel) return;
    this.audioCtx = new Ctx();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      this.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (this.state !== 'recording' || !this.mediaRecorder) {
        reject(new Error('当前没有在录音'));
        return;
      }
      const mr = this.mediaRecorder;
      const duration = (performance.now() - this.startTime) / 1000;
      mr.onstop = () => {
        const mimeType = mr.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        this._cleanup();
        resolve({ blob, mimeType, duration });
      };
      mr.stop();
    });
  }

  _cleanup() {
    cancelAnimationFrame(this.rafId);
    clearInterval(this.timerId);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
    if (this.onLevel) this.onLevel(0);
    this.state = 'idle';
    this._reset();
  }
}
