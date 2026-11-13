// library.js - “我的”页：保存当前作品、作品列表、播放、分享、载入编辑、重命名、删除、下载

import { listRecordings, saveRecording, deleteRecording, newId } from './storage.js';
import { audioBufferToWav, audioBufferToMp3, downloadBlob } from './export.js';
import { decodeBlob } from './player.js';
import { t, setText } from './i18n.js';

const pad = n => String(n).padStart(2, '0');
const fmtDur = sec => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
const fmtDate = ts => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtSize = b => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const safeName = n => (n || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'voice';
const defaultName = () => t('lib.defaultName', { t: fmtDate(Date.now()) });

const ICON_PLAY = '<svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

// parts 例如 ['fx:uncle', 'edited'] -> “变声：大叔 · 已编辑”
function partsText(parts) {
  const list = (parts || []).map(p =>
    p === 'edited' ? t('lib.edited') : t('lib.fx', { name: t('fx.' + p.slice(3) + '.name') }));
  return list.join(' · ');
}

export function initLibrary({ $, state, onLoad }) {
  const audio = $('lib-audio');
  const list = $('lib-list');
  const nameInput = $('lib-name');
  const msgEl = $('lib-msg');
  let msgTimer = 0;
  let current = { id: null, url: null };

  function msg(key, params) {
    setText(msgEl, key, params);
    clearTimeout(msgTimer);
    if (key) msgTimer = setTimeout(() => setText(msgEl, null), 6000);
  }

  function showErr(e) {
    if (e && e.i18n) msg(e.i18n);
    else msg('lib.error', { m: (e && e.message) || String(e) });
  }

  async function withBusy(btn, busyKey, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = t(busyKey);
    try {
      await new Promise(r => setTimeout(r, 30));
      await fn();
    } catch (e) {
      showErr(e);
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
    if (p && (p.presetId !== 'original' || p.tune || p.ftune)) parts.push('fx:' + p.presetId);
    if (e && e.buffer !== base) parts.push('edited');
    return {
      buffer,
      parts,
      wav: () => (e && e.blob && e.buffer === buffer ? e.blob : (p && p.blob && p.buffer === buffer ? p.blob : audioBufferToWav(buffer))),
      duration: buffer.duration,
    };
  }

  function refreshCurrent() {
    const f = getFinal();
    $('lib-current-actions').hidden = !f;
    const info = $('lib-current-info');
    if (f) {
      info.removeAttribute('data-k');
      info.textContent = t('lib.current', { desc: `${partsText(f.parts) || t('lib.original')} · ${fmtDur(f.duration)}` });
    } else {
      setText(info, state.recording && !state.recording.buffer ? 'lib.cannotDecode' : 'lib.noRecording');
    }
    if (f && (!nameInput.value || nameInput.dataset.auto === '1')) {
      nameInput.value = defaultName();
      nameInput.dataset.auto = '1';
    }
  }
  nameInput.addEventListener('input', () => { nameInput.dataset.auto = '0'; });

  async function shareBlob(blob, name) {
    const file = new File([blob], safeName(name) + '.wav', { type: 'audio/wav' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
      return;
    }
    downloadBlob(blob, file.name);
    msg('lib.shareFallback');
  }

  $('lib-save').addEventListener('click', ev => {
    const f = getFinal();
    if (!f) return;
    withBusy(ev.currentTarget, 'lib.saving', async () => {
      const wav = f.wav();
      await saveRecording({
        id: newId(),
        name: nameInput.value.trim() || defaultName(),
        createdAt: Date.now(),
        duration: f.duration,
        sampleRate: f.buffer.sampleRate,
        size: wav.size,
        parts: f.parts,
        blob: wav,
      });
      nameInput.dataset.auto = '1';
      nameInput.value = defaultName();
      msg('lib.saved');
      await renderList();
    });
  });

  $('lib-share').addEventListener('click', ev => {
    const f = getFinal();
    if (!f) return;
    withBusy(ev.currentTarget, 'lib.sharing', () => shareBlob(f.wav(), nameInput.value.trim() || 'voice'));
  });

  $('lib-dl-wav').addEventListener('click', () => {
    const f = getFinal();
    if (f) downloadBlob(f.wav(), safeName(nameInput.value) + '.wav');
  });

  $('lib-dl-mp3').addEventListener('click', ev => {
    const f = getFinal();
    if (!f) return;
    withBusy(ev.currentTarget, 'lib.encoding', async () => {
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

  function mkBtn(labelKey, cls, fn) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = t(labelKey);
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
    play.setAttribute('aria-label', t('play'));
    play.innerHTML = ICON_PLAY + ICON_PAUSE;
    play.addEventListener('click', () => togglePlay(item));
    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const nm = document.createElement('div');
    nm.className = 'lib-name';
    nm.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const extra = item.parts ? partsText(item.parts) : '';
    sub.textContent = `${fmtDate(item.createdAt)} · ${fmtDur(item.duration)} · ${fmtSize(item.size)}${extra ? ' · ' + extra : ''}`;
    meta.append(nm, sub);
    top.append(play, meta);

    const acts = document.createElement('div');
    acts.className = 'lib-actions';
    acts.append(
      mkBtn('lib.edit', 'btn-secondary btn-small', async ev => {
        if (state.recording && !confirm(t('lib.loadConfirm'))) return;
        stopAudio();
        await withBusy(ev.currentTarget, 'lib.loading', () => onLoad(item));
      }),
      mkBtn('lib.share', 'btn-secondary btn-small', ev =>
        withBusy(ev.currentTarget, 'lib.sharing', () => shareBlob(item.blob, item.name))),
      mkBtn('lib.wav', 'btn-secondary btn-small', () => downloadBlob(item.blob, safeName(item.name) + '.wav')),
      mkBtn('lib.mp3', 'btn-secondary btn-small', ev => withBusy(ev.currentTarget, 'lib.encoding', async () => {
        const buf = await decodeBlob(item.blob);
        downloadBlob(await audioBufferToMp3(buf), safeName(item.name) + '.mp3');
      })),
      mkBtn('lib.rename', 'btn-secondary btn-small', async () => {
        const n = prompt(t('lib.renamePrompt'), item.name);
        if (n === null || !n.trim()) return;
        try {
          await saveRecording({ ...item, name: n.trim().slice(0, 40) });
          await renderList();
        } catch (e) { showErr(e); }
      }),
      mkBtn('lib.delete', 'btn-secondary btn-small btn-danger', async () => {
        if (!confirm(t('lib.deleteConfirm', { name: item.name }))) return;
        try {
          if (current.id === item.id) stopAudio();
          await deleteRecording(item.id);
          await renderList();
        } catch (e) { showErr(e); }
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
      showErr(e);
    }
    list.replaceChildren(...items.map(buildItem));
    $('lib-empty').hidden = items.length > 0;
    updatePlayingUi();
  }

  function refresh() {
    refreshCurrent();
    renderList();
  }

  return { refresh, relabel: refresh, pause: () => audio.pause() };
}
