// app.js - 入口、页面切换、录音页、变声页逻辑
import { Recorder, isSupported, explainError } from './recorder.js';
import { WavePlayer, decodeBlob, computePeaks } from './player.js';
import { PRESETS, applyPreset } from './effects.js';
import { audioBufferToWav } from './export.js';

// 全局状态（后续步骤的编辑、导出都用它）
// recording = { blob, mimeType, duration, url, buffer(AudioBuffer) }  原始录音
// processed = { buffer, blob, url, presetId, tune }                    变声后的结果
export const state = { recording: null, processed: null };

const $ = id => document.getElementById(id);

/* ---------- 通用：带波形的播放器 ---------- */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function formatShort(sec) {
  const t = Math.floor(sec || 0);
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

function makePlayer({ canvas, audio, btn, time }) {
  const p = new WavePlayer({
    canvas: $(canvas),
    audio: $(audio),
    onChange: ({ current, duration, playing }) => {
      $(time).textContent = `${formatShort(current)} / ${formatShort(duration)}`;
      $(btn).classList.toggle('playing', playing);
      $(btn).setAttribute('aria-label', playing ? '暂停' : '播放');
    },
  });
  $(btn).addEventListener('click', () => p.toggle());
  return p;
}

const player = makePlayer({ canvas: 'rec-wave', audio: 'rec-audio', btn: 'play-btn', time: 'play-time' });
const fxPlayer = makePlayer({ canvas: 'fx-wave', audio: 'fx-audio', btn: 'fx-play-btn', time: 'fx-play-time' });

/* ---------- 页面切换 ---------- */
const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');
const title = document.getElementById('page-title');

function showPage(name, label) {
  player.pause();
  fxPlayer.pause();
  pages.forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  tabs.forEach(t => t.classList.toggle('active', t.dataset.page === name));
  title.textContent = label;
  if (name === 'effects') refreshEffects();
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => showPage(tab.dataset.page, tab.dataset.title));
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

function showError(msg) {
  recError.textContent = msg;
  recError.hidden = !msg;
}

function clearResult() {
  player.reset();
  resetEffects();
  if (state.recording) URL.revokeObjectURL(state.recording.url);
  state.recording = null;
  recResult.hidden = true;
  recTimer.textContent = '00:00.0';
  recStatus.textContent = '点击开始录音';
  recBtn.hidden = false;
}

async function startRecording() {
  showError('');
  try {
    await recorder.start();
  } catch (err) {
    showError(explainError(err));
    return;
  }
  recBtn.classList.add('recording');
  recBtn.setAttribute('aria-label', '停止录音');
  recStatus.textContent = '录音中…点击停止';
}

async function stopRecording() {
  recBtn.classList.remove('recording');
  recBtn.setAttribute('aria-label', '开始录音');
  try {
    const result = await recorder.stop();
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
    recStatus.textContent = '录音完成';
    recInfo.textContent =
      `${formatTime(result.duration)} · ${(result.blob.size / 1024).toFixed(0)} KB`;
    player.load({ url: result.url, peaks, duration: result.duration });
  } catch (err) {
    showError(explainError(err));
    recStatus.textContent = '点击开始录音';
  }
}

recBtn.addEventListener('click', () => {
  if (recorder.state === 'recording') stopRecording();
  else startRecording();
});

recDiscard.addEventListener('click', clearResult);

if (!isSupported()) showError(explainError());

/* ---------- 变声页 ---------- */
const fxEmpty = $('fx-empty');
const fxMain = $('fx-main');
const fxGrid = $('fx-grid');
const fxTune = $('fx-tune');
const fxTuneVal = $('fx-tune-val');
const fxFormant = $('fx-formant');
const fxFormantVal = $('fx-formant-val');
const fxStatus = $('fx-status');

const fx = { forUrl: null, presetId: 'original', tune: 0, ftune: 0, token: 0, url: null };

PRESETS.forEach(p => {
  const b = document.createElement('button');
  b.className = 'fx-btn';
  b.dataset.id = p.id;
  b.innerHTML = `${p.name}<small>${p.desc}</small>`;
  b.addEventListener('click', () => {
    fx.presetId = p.id;
    resetSliders();
    runEffect();
  });
  fxGrid.appendChild(b);
});

function setBusy(busy, text) {
  fxGrid.querySelectorAll('.fx-btn').forEach(b => {
    b.disabled = busy;
    b.classList.toggle('active', b.dataset.id === fx.presetId);
  });
  fxTune.disabled = busy;
  fxFormant.disabled = busy;
  fxStatus.textContent = text || '';
}

function formatTune(v) {
  return (v > 0 ? '+' : '') + v;
}

function resetSliders() {
  fx.tune = 0;
  fx.ftune = 0;
  fxTune.value = 0;
  fxFormant.value = 0;
  fxTuneVal.textContent = '0';
  fxFormantVal.textContent = '0';
}

async function runEffect() {
  const rec = state.recording;
  if (!rec || !rec.buffer) return;
  const preset = PRESETS.find(p => p.id === fx.presetId);
  const token = ++fx.token;
  fxPlayer.pause();
  setBusy(true, '处理中…');
  await new Promise(r => setTimeout(r, 30)); // 让界面先刷新

  let out;
  try {
    out = await applyPreset(rec.buffer, preset, { pitch: fx.tune, formant: fx.ftune });
  } catch (e) {
    if (token === fx.token) setBusy(false, '处理失败：' + (e.message || e));
    return;
  }
  if (token !== fx.token) return;

  const blob = audioBufferToWav(out);
  const url = URL.createObjectURL(blob);
  if (fx.url) URL.revokeObjectURL(fx.url);
  fx.url = url;
  state.processed = { buffer: out, blob, url, presetId: preset.id, tune: fx.tune, ftune: fx.ftune };
  fxPlayer.load({ url, peaks: computePeaks(out), duration: out.duration });
  setBusy(false, preset.id === 'original' && !fx.tune && !fx.ftune ? '当前：原声' : `已应用：${preset.name}`);
}

function resetEffects() {
  fx.token++;
  fxPlayer.reset();
  if (fx.url) URL.revokeObjectURL(fx.url);
  fx.url = null;
  fx.forUrl = null;
  state.processed = null;
}

function refreshEffects() {
  const rec = state.recording;
  const ok = !!(rec && rec.buffer);
  fxEmpty.hidden = ok;
  fxMain.hidden = !ok;
  $('fx-empty-text').textContent = rec && !rec.buffer
    ? '当前录音无法解码，不能变声。请换用 Chrome 或 Safari 重新录音。'
    : '请先在“录音”页录一段声音。';
  if (!ok) return;

  if (fx.forUrl !== rec.url) {
    fx.forUrl = rec.url;
    fx.presetId = 'original';
    resetSliders();
    runEffect();
  }
}

fxTune.addEventListener('input', () => { fxTuneVal.textContent = formatTune(Number(fxTune.value)); });
fxTune.addEventListener('change', () => {
  fx.tune = Number(fxTune.value);
  runEffect();
});

fxFormant.addEventListener('input', () => { fxFormantVal.textContent = formatTune(Number(fxFormant.value)); });
fxFormant.addEventListener('change', () => {
  fx.ftune = Number(fxFormant.value);
  runEffect();
});

$('fx-goto').addEventListener('click', () => showPage('record', '录音'));
