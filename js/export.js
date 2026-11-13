// export.js - 导出 wav / mp3（第 6 步完善；目前提供 WAV 编码）

// AudioBuffer -> 16-bit PCM WAV Blob
export function audioBufferToWav(buffer) {
  const ch = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytes = len * ch * 2;
  const ab = new ArrayBuffer(44 + bytes);
  const v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, bytes, true);

  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// 触发浏览器下载
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- MP3（lamejs，首次使用时从 CDN 加载，需要联网） ---------- */
const LAME_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js',
  'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
];
let lamePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('load failed: ' + src)); };
    document.head.appendChild(s);
  });
}

function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (!lamePromise) {
    lamePromise = (async () => {
      for (const url of LAME_URLS) {
        try {
          await loadScript(url);
          if (window.lamejs) return window.lamejs;
        } catch (e) { /* 试下一个地址 */ }
      }
      lamePromise = null;
      throw Object.assign(new Error('mp3.loadFail'), { i18n: 'mp3.loadFail' });
    })();
  }
  return lamePromise;
}

const toInt16 = f => {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
};

// AudioBuffer -> MP3 Blob
export async function audioBufferToMp3(buffer, kbps = 128) {
  const lamejs = await loadLame();
  const ch = Math.min(2, buffer.numberOfChannels);
  const enc = new lamejs.Mp3Encoder(ch, buffer.sampleRate, kbps);
  const L = toInt16(buffer.getChannelData(0));
  const R = ch > 1 ? toInt16(buffer.getChannelData(1)) : null;
  const block = 1152;
  const parts = [];
  for (let i = 0, n = 0; i < L.length; i += block, n++) {
    const l = L.subarray(i, i + block);
    const out = R ? enc.encodeBuffer(l, R.subarray(i, i + block)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
    if (n % 200 === 199) await new Promise(r => setTimeout(r)); // 让界面不卡死
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}
