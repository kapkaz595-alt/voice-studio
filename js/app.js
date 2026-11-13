// app.js - 入口、页面切换、录音页、变声页、安装与离线
import { Recorder, isSupported, explainError } from './recorder.js';
import { WavePlayer, decodeBlob, computePeaks } from './player.js';
import { PRESETS, applyPreset, resolveShift, estimateF0 } from './effects.js';
import { audioBufferToWav } from './export.js';
import { initEditor } from './editor.js';
import { initLibrary } from './library.js';
import { t, setText, applyAll, getLang, setLang, LANGS, onLangChange } from './i18n.js';

// 全局状态
// recording = { blob, mimeType, duration, url, buffer(AudioBuffer), f0 }  原始录音
// processed = { buffer, blob, url, presetId, tune, ftune }                变声后的结果
// edited    = { buffer, blob, url }                                       编辑后的结果（最终成品）
export const state = { recording: null, processed: null, edited: null };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 通用：带波形的播放器 ---------- */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function formatShort(sec) {
  const tt = Math.floor(sec || 0);
  return Math.floor(tt / 60) + ':' + String(tt % 60).padStart(2, '0');
}

const players = [];

function makePlayer({ canvas, audio, btn, time }) {
  const p = new WavePlayer({
    canvas: $(canvas),
    audio: $(audio),
    onChange: ({ current, duration, playing }) => {
      $(time).textContent = `${formatShort(current)} / ${formatShort(duration)}`;
      $(btn).classList.toggle('playing', playing);
      $(btn).setAttribute('aria-label', t(playing ? 'pause' : 'play'));
    },
  });
  $(btn).addEventListener('click', () => p.toggle());
  players.push(p);
  return p;
}

const player = makePlayer({ canvas: 'rec-wave', audio: 'rec-audio', btn: 'play-btn', time: 'play-time' });
const fxPlayer = makePlayer({ canvas: 'fx-wave', audio: 'fx-audio', btn: 'fx-play-btn', time: 'fx-play-time' });

const editor = initEditor({
  $, state, makePlayer, computePeaks, audioBufferToWav,
  goRecord: () => showPage('record'),
});

const library = initLibrary({
  $, state,
  // 把已保存的录音载回编辑
  onLoad: async item => {
    clearResult();
    await showRecording({ blob: item.blob, mimeType: item.blob.type || 'audio/wav', duration: item.duration });
    showPage('editor');
  },
});

/* ---------- 页面切换 ---------- */
const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');
const title = $('page-title');
let currentPage = 'record';

function showPage(name) {
  currentPage = name;
  player.pause();
  fxPlayer.pause();
  editor.pause();
  library.pause();
  pages.forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  tabs.forEach(tb => tb.classList.toggle('active', tb.dataset.page === name));
  setText(title, 'page.' + name);
  if (name === 'effects') refreshEffects();
  if (name === 'editor') editor.refresh();
  if (name === 'library') library.refresh();
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => showPage(tab.dataset.page));
});

/* ---------- 录音页 ---------- */
const recBtn = $('rec-btn');
const recTimer = $('rec-timer');
const recMeter = $('rec-meter');
const recStatus = $('rec-status');
const recError = $('rec-error');
const recResult = $('rec-result');
const recInfo = $('rec-info');
const recDiscard = $('rec-discard');

const recorder = new Recorder({
  onLevel: level => { recMeter.style.width = Math.round(level * 100) + '%'; },
  onTick: sec => { recTimer.textContent = formatTime(sec); },
});

let recUi = 'idle'; // idle | recording | done

function renderRecUi() {
  setText(recStatus, 'rec.status.' + recUi);
  recBtn.setAttribute('aria-label', t(recUi === 'recording' ? 'rec.aria.stop' : 'rec.aria.start'));
  recBtn.classList.toggle('recording', recUi === 'recording');
}

function showError(key, params) {
  setText(recError, key || null, params);
  recError.hidden = !key;
}

function clearResult() {
  player.reset();
  resetEffects();
  editor.reset();
  if (state.recording) URL.revokeObjectURL(state.recording.url);
  state.recording = null;
  recResult.hidden = true;
  recTimer.textContent = '00:00.0';
  recBtn.hidden = false;
  recUi = 'idle';
  renderRecUi();
}

// 显示一段录音（新录的，或从“我的”载入的）
async function showRecording(result) {
  result.url = URL.createObjectURL(result.blob);
  state.recording = result;

  // 解码并计算波形（解码失败也能正常播放，只是波形为占位、不能变声）
  let peaks = null;
  try {
    result.buffer = await decodeBlob(result.blob);
    result.duration = result.buffer.duration;
    peaks = computePeaks(result.buffer);
  } catch (e) {
    console.warn('解码失败：', e);
  }

  recResult.hidden = false;
  recBtn.hidden = true;
  recUi = 'done';
  renderRecUi();
  recTimer.textContent = formatTime(result.duration);
  recInfo.textContent = `${formatTime(result.duration)} · ${(result.blob.size / 1024).toFixed(0)} KB`;
  player.load({ url: result.url, peaks, duration: result.duration });
}

async function startRecording() {
  showError();
  try {
    await recorder.start();
  } catch (err) {
    showError(...explainError(err));
    return;
  }
  recUi = 'recording';
  renderRecUi();
}

async function stopRecording() {
  recUi = 'idle';
  renderRecUi();
  try {
    const result = await recorder.stop();
    await showRecording(result);
  } catch (err) {
    showError(...explainError(err));
  }
}

recBtn.addEventListener('click', () => {
  if (recorder.state === 'recording') stopRecording();
  else startRecording();
});

recDiscard.addEventListener('click', clearResult);

if (!isSupported()) showError(...explainError());

/* ---------- 变声页 ---------- */
const fxEmpty = $('fx-empty');
const fxMain = $('fx-main');
const fxGrid = $('fx-grid');
const fxTune = $('fx-tune');
const fxTuneVal = $('fx-tune-val');
const fxFormant = $('fx-formant');
const fxFormantVal = $('fx-formant-val');
const fxStatus = $('fx-status');
const abProc = $('fx-ab-proc');
const abOrig = $('fx-ab-orig');

const fx = {
  forUrl: null, presetId: 'original', tune: 0, ftune: 0, token: 0,
  url: null, origUrl: null, peaksProc: null, peaksOrig: null, ab: 'proc',
};

PRESETS.forEach(p => {
  const b = document.createElement('button');
  b.className = 'fx-btn';
  b.dataset.id = p.id;
  b.innerHTML = `<span data-i18n="fx.${p.id}.name"></span><small data-i18n="fx.${p.id}.desc"></small>`;
  b.addEventListener('click', () => {
    fx.presetId = p.id;
    resetSliders();
    runEffect();
  });
  fxGrid.appendChild(b);
});

function setBusy(busy) {
  fxGrid.querySelectorAll('.fx-btn').forEach(b => {
    b.disabled = busy;
    b.classList.toggle('active', b.dataset.id === fx.presetId);
  });
  fxTune.disabled = busy;
  fxFormant.disabled = busy;
  abProc.disabled = busy;
  abOrig.disabled = busy;
}

const signed = v => (v > 0 ? '+' : '') + v;

function resetSliders() {
  fx.tune = 0;
  fx.ftune = 0;
  fxTune.value = 0;
  fxFormant.value = 0;
  fxTuneVal.textContent = '0';
  fxFormantVal.textContent = '0';
}

function updateAb() {
  abProc.classList.toggle('active', fx.ab === 'proc');
  abOrig.classList.toggle('active', fx.ab === 'orig');
}

async function runEffect() {
  const rec = state.recording;
  if (!rec || !rec.buffer) return;
  const preset = PRESETS.find(p => p.id === fx.presetId);
  const token = ++fx.token;
  fxPlayer.pause();
  setBusy(true);
  setText(fxStatus, 'fx.status.processing');
  await sleep(30); // 让界面先刷新

  let out;
  let shift;
  try {
    if (rec.f0 === undefined) rec.f0 = estimateF0(rec.buffer);
    const extra = { pitch: fx.tune, formant: fx.ftune, f0: rec.f0.f0 };
    shift = resolveShift(preset, extra);
    out = await applyPreset(rec.buffer, preset, extra);
  } catch (e) {
    if (token === fx.token) {
      setBusy(false);
      setText(fxStatus, 'fx.status.failed', { m: e.message || String(e) });
    }
    return;
  }
  if (token !== fx.token) return;

  const blob = audioBufferToWav(out);
  const url = URL.createObjectURL(blob);
  if (fx.url) URL.revokeObjectURL(fx.url);
  fx.url = url;
  fx.peaksProc = computePeaks(out);
  if (!fx.origUrl) {
    fx.origUrl = URL.createObjectURL(audioBufferToWav(rec.buffer));
    fx.peaksOrig = computePeaks(rec.buffer);
  }
  state.processed = { buffer: out, blob, url, presetId: preset.id, tune: fx.tune, ftune: fx.ftune };
  state.edited = null; // 变声结果变了，之前的编辑作废（进入编辑页时重新生成）
  fx.ab = 'proc';
  updateAb();
  fxPlayer.load({ url, peaks: fx.peaksProc, duration: out.duration });
  setBusy(false);

  if (preset.id === 'original' && !fx.tune && !fx.ftune) {
    setText(fxStatus, 'fx.status.original');
  } else if (shift.auto) {
    const st = Math.round((shift.pitch - fx.tune) * 10) / 10;
    setText(fxStatus, 'fx.status.auto', { f0: Math.round(rec.f0.f0), target: preset.target, st: signed(st) });
  } else {
    setText(fxStatus, 'fx.status.applied');
  }
}

function resetEffects() {
  fx.token++;
  fxPlayer.reset();
  if (fx.url) URL.revokeObjectURL(fx.url);
  if (fx.origUrl) URL.revokeObjectURL(fx.origUrl);
  fx.url = null;
  fx.origUrl = null;
  fx.peaksProc = null;
  fx.peaksOrig = null;
  fx.forUrl = null;
  state.processed = null;
}

function refreshEffects() {
  const rec = state.recording;
  const ok = !!(rec && rec.buffer);
  fxEmpty.hidden = ok;
  fxMain.hidden = !ok;
  setText($('fx-empty-text'), rec && !rec.buffer ? 'empty.cannotDecode.fx' : 'empty.needRecording');
  if (!ok) return;

  if (fx.forUrl !== rec.url) {
    fx.forUrl = rec.url;
    fx.presetId = 'original';
    resetSliders();
    runEffect();
  }
}

fxTune.addEventListener('input', () => { fxTuneVal.textContent = signed(Number(fxTune.value)); });
fxTune.addEventListener('change', () => {
  fx.tune = Number(fxTune.value);
  runEffect();
});

fxFormant.addEventListener('input', () => { fxFormantVal.textContent = signed(Number(fxFormant.value)); });
fxFormant.addEventListener('change', () => {
  fx.ftune = Number(fxFormant.value);
  runEffect();
});

// 原声 / 变声 对比
abProc.addEventListener('click', () => {
  if (!fx.url || fx.ab === 'proc') return;
  fx.ab = 'proc';
  updateAb();
  fxPlayer.swap({ url: fx.url, peaks: fx.peaksProc });
});
abOrig.addEventListener('click', () => {
  if (!fx.origUrl || fx.ab === 'orig') return;
  fx.ab = 'orig';
  updateAb();
  fxPlayer.swap({ url: fx.origUrl, peaks: fx.peaksOrig });
});

$('fx-goto').addEventListener('click', () => showPage('record'));

/* ---------- 添加到主屏幕 / 离线缓存 ---------- */
const installBtn = $('install-btn');
const installTip = $('install-tip');
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone()) installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch (e) { /* 忽略 */ }
  deferredPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  installBtn.hidden = true;
});

// iPhone Safari 没有安装按钮，只显示操作提示
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) installTip.hidden = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------- 语言切换 ---------- */
const langSelect = $('lang-select');
Object.entries(LANGS).forEach(([code, label]) => {
  const o = document.createElement('option');
  o.value = code;
  o.textContent = label;
  langSelect.appendChild(o);
});
langSelect.value = getLang();
langSelect.addEventListener('change', () => setLang(langSelect.value));

onLangChange(() => {
  langSelect.value = getLang();
  renderRecUi();
  players.forEach(p => p._emit());
  editor.relabel();
  library.relabel();
});

setText(title, 'page.record');
renderRecUi();
applyAll();
