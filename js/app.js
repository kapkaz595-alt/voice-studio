// app.js - 入口、页面切换、录音页逻辑
import { Recorder, isSupported, explainError } from './recorder.js';

// 全局状态：当前录音（后续步骤的播放、变声、编辑都用它）
export const state = { recording: null };

/* ---------- 页面切换 ---------- */
const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');
const title = document.getElementById('page-title');

function showPage(name, label) {
  pages.forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  tabs.forEach(t => t.classList.toggle('active', t.dataset.page === name));
  title.textContent = label;
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => showPage(tab.dataset.page, tab.dataset.title));
});

/* ---------- 录音页 ---------- */
const $ = id => document.getElementById(id);
const recBtn = $('rec-btn');
const recTimer = $('rec-timer');
const recMeter = $('rec-meter');
const recStatus = $('rec-status');
const recError = $('rec-error');
const recResult = $('rec-result');
const recAudio = $('rec-audio');
const recInfo = $('rec-info');
const recDiscard = $('rec-discard');

const recorder = new Recorder({
  onLevel: level => { recMeter.style.width = Math.round(level * 100) + '%'; },
  onTick: sec => { recTimer.textContent = formatTime(sec); },
});

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function showError(msg) {
  recError.textContent = msg;
  recError.hidden = !msg;
}

function clearResult() {
  if (state.recording) URL.revokeObjectURL(state.recording.url);
  state.recording = null;
  recAudio.removeAttribute('src');
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
    recAudio.src = result.url;
    recInfo.textContent =
      `${formatTime(result.duration)} · ${(result.blob.size / 1024).toFixed(0)} KB`;
    recResult.hidden = false;
    recBtn.hidden = true;
    recStatus.textContent = '录音完成';
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
