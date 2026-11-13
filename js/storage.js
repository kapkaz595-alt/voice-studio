// storage.js - 本地保存（IndexedDB）
// 记录结构：{ id, name, createdAt, duration, sampleRate, size, desc, blob(WAV) }

const DB_NAME = 'voice-studio';
const STORE = 'recordings';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('当前浏览器不支持本地保存'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开本地数据库'));
  });
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('本地数据库出错')); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('保存失败（空间不足？）')); };
  });
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const saveRecording = rec => run('readwrite', s => s.put(rec));

export const deleteRecording = id => run('readwrite', s => s.delete(id));

export async function listRecordings() {
  const all = await run('readonly', s => s.getAll());
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}
