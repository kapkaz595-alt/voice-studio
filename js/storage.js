// storage.js - 本地保存（IndexedDB）
// 记录结构：{ id, name, createdAt, duration, sampleRate, size, parts, blob(WAV) }
// parts：作品经过的处理，如 ['fx:uncle', 'edited']

const DB_NAME = 'voice-studio';
const STORE = 'recordings';

// 带词条 key 的错误，界面按当前语言显示
const E = key => Object.assign(new Error(key), { i18n: key });

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(E('storage.unsupported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(E('storage.open'));
  });
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(E('storage.error')); };
    tx.onabort = () => { db.close(); reject(E('storage.full')); };
  });
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const saveRecording = rec => run('readwrite', s => s.put(rec));

export const deleteRecording = id => run('readwrite', s => s.delete(id));

export async function listRecordings() {
  const all = await run('readonly', s => s.getAll());
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}
