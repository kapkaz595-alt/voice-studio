// library.js - “我的”页：保存当前作品、作品列表、播放、重命名、删除、下载

import { listRecordings, saveRecording, deleteRecording, newId } from './storage.js';
import { audioBufferToWav, audioBufferToMp3, downloadBlob } from './export.js';
import { decodeBlob } from './player.js';

const pad = n => String(n).padStart(2, '0');
const fmtDur = sec => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
const fmtDate = ts => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtSize = b => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const safeName = n => (n || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '录音';
const defaultName = () => `录音 ${fmtDate(Date.now())}`;

const ICON_PLAY = '<svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

export function initLibrary({ $, state, PRESETS }) {
  const audio = $('lib-audio');
  const list = $('lib-list');
  const nameInput = $('lib-name');
  const msgEl = $('lib-msg');
  let msgTimer = 0;
  let current = { id: null, url: null };

  function msg(text) {
    msgEl.textContent = text || '';
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => { msgEl.textContent = ''; }, 6000);
  }

  async function withBusy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      await new Promise(r => setTimeout(r, 30));
      await fn();
    } catch (e) {
      msg(e.message || String(e));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  /* ---------- 当前作品 = 录音 -> 变声 -> 编辑 的最终结果 ---------- */
  function getFinal() {
    const rec = state.recording;
    if (!rec || !rec.buffer) return null;
    const e = state.edited;
    const p = state.processed;
    const base = (p && p.buffer) || rec.buffer;
    const buffer = (e && e.buffer) || base;
    const parts = [];
    if (p && (p.presetId !== 'original' || p.tune || p.ftune)) {
      const preset = PRESETS.find(x => x.id === p.presetId);
      parts.push('变声：' + (preset ? preset.name : p.presetId));
    }
    if (e && e.buffer !== base) parts.push('已编辑');
    return {
      buffer,
      wav: () => (e && e.blob && e.buffer === buffer ? e.blob : (p && p.blob && p.buffer === buffer ? p.blob : audioBufferToWav(buffer))),
      duration: buffer.duration,
      desc: `${parts.join(' · ') || '原声'} · ${fmtDur(buffer.duration)}`,
    };
  }

  function refreshCurrent() {
    const f = getFinal();
    $('lib-current-actions').hidden = !f;
    $('lib-current-info').textContent = f
      ? `当前作品：${f.desc}`
      : (state.recording && !state.recording.buffer
        ? '当前录音无法解码，不能保存或导出。'
        : '还没有录音。先去“录音”页录一段。');
    if (f && (!nameInput.value || nameInput.dataset.auto === '1')) {
      nameInput.value = defaultName();
      nameInput.dataset.auto = '1';
    }
  }
  nameInput.addEventListener('input', () => { nameInput.dataset.auto = '0'; });

  $('lib-save').addEventListener('click', ev => {
    const f = getFinal();
    if (!f) return;
    withBusy(ev.currentTarget, '保存中…', async () => {
      const wav = f.wav();
      await saveRecording({
        id: newId(),
        name: nameInput.value.trim() || defaultName(),
        createdAt: Date.now(),
        duration: f.duration,
        sampleRate: f.buffer.sampleRate,
        size: wav.size,
        desc: f.desc,
        blob: wav,
      });
      nameInput.dataset.auto = '1';
      nameInput.value = defaultName();
      msg('已保存到“我的录音”');
      await renderList();
    });
  });

  $('lib-dl-wav').addEventListener('click', () => {
    const f = getFinal();
    if (f) downloadBlob(f.wav(), safeName(nameInput.value) + '.wav');
  });

  $('lib-dl-mp3').addEventListener('click', ev => {
    const f = getFinal();
    if (!f) return;
    withBusy(ev.currentTarget, '编码中…', async () => {
      downloadBlob(await audioBufferToMp3(f.buffer), safeName(nameInput.value) + '.mp3');
    });
  });

  /* ---------- 作品列表 ---------- */
  function updatePlayingUi() {
    list.querySelectorAll('.lib-item').forEach(el => {
      const on = el.dataset.id === current.id && !audio.paused && !audio.ended;
      el.querySelector('.play-btn').classList.toggle('playing', on);
    });
  }
  ['play', 'pause', 'ended'].forEach(ev => audio.addEventListener(ev, updatePlayingUi));

  function stopAudio() {
    audio.pause();
    if (current.url) URL.revokeObjectURL(current.url);
    current = { id: null, url: null };
    audio.removeAttribute('src');
    audio.load();
  }

  function togglePlay(item) {
    if (current.id === item.id) {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
      return;
    }
    if (current.url) URL.revokeObjectURL(current.url);
    current = { id: item.id, url: URL.createObjectURL(item.blob) };
    audio.src = current.url;
    audio.play().catch(() => {});
    updatePlayingUi();
  }

  function mkBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function buildItem(item) {
    const el = document.createElement('div');
    el.className = 'lib-item';
    el.dataset.id = item.id;

    const top = document.createElement('div');
    top.className = 'lib-top';
    const play = document.createElement('button');
    play.className = 'play-btn small';
    play.setAttribute('aria-label', '播放');
    play.innerHTML = ICON_PLAY + ICON_PAUSE;
    play.addEventListener('click', () => togglePlay(item));
    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const nm = document.createElement('div');
    nm.className = 'lib-name';
    nm.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${fmtDate(item.createdAt)} · ${fmtDur(item.duration)} · ${fmtSize(item.size)}${item.desc ? ' · ' + item.desc.split(' · ').slice(0, -1).join(' · ') : ''}`;
    meta.append(nm, sub);
    top.append(play, meta);

    const acts = document.createElement('div');
    acts.className = 'lib-actions';
    acts.append(
      mkBtn('WAV', 'btn-secondary btn-small', () => downloadBlob(item.blob, safeName(item.name) + '.wav')),
      mkBtn('MP3', 'btn-secondary btn-small', ev => withBusy(ev.currentTarget, '编码中…', async () => {
        const buf = await decodeBlob(item.blob);
        downloadBlob(await audioBufferToMp3(buf), safeName(item.name) + '.mp3');
      })),
      mkBtn('重命名', 'btn-secondary btn-small', async () => {
        const n = prompt('新名称', item.name);
        if (n === null || !n.trim()) return;
        try {
          await saveRecording({ ...item, name: n.trim().slice(0, 40) });
          await renderList();
        } catch (e) { msg(e.message); }
      }),
      mkBtn('删除', 'btn-secondary btn-small btn-danger', async () => {
        if (!confirm(`删除“${item.name}”？`)) return;
        try {
          if (current.id === item.id) stopAudio();
          await deleteRecording(item.id);
          await renderList();
        } catch (e) { msg(e.message); }
      }),
    );
    el.append(top, acts);
    return el;
  }

  async function renderList() {
    let items = [];
    try {
      items = await listRecordings();
    } catch (e) {
      msg(e.message);
    }
    list.replaceChildren(...items.map(buildItem));
    $('lib-empty').hidden = items.length > 0;
    updatePlayingUi();
  }

  function refresh() {
    refreshCurrent();
    renderList();
  }

  return { refresh, pause: () => audio.pause() };
}
