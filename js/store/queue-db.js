/**
 * スクロブルキュー専用 IndexedDB
 *
 * Last.fm への送信に失敗、またはオフライン時に積まれる。
 * オンライン復帰時にバッチ送信する。
 *
 * stores:
 *   - scrobbles : { id (auto), artist, track, album?, timestamp, duration?, mbid?, albumArtist?, trackNumber? }
 */

const DB_NAME = "music-player-queue";
const DB_VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("scrobbles")) {
        const s = db.createObjectStore("scrobbles", { keyPath: "id", autoIncrement: true });
        s.createIndex("timestamp", "timestamp", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // ★ open 成功後のクローズ(iOS ストレージ逼迫の強制クローズ等)/versionchange でも
      //   キャッシュを破棄し再接続させる(library-db と同じ対策。同一性ガード付き)。
      db.onclose = () => { if (_dbPromise && _dbPromise._db === db) _dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch {} if (_dbPromise && _dbPromise._db === db) _dbPromise = null; };
      _dbPromise._db = db;
      resolve(db);
    };
    // ★ open 失敗時はキャッシュした reject 済み Promise を破棄する。これをしないと
    //   以後の openDb() がずっと同じ reject を返し、キュー操作が恒久的に壊れて
    //   ブラウザのキャッシュ消去以外で復帰不能になる(stats-cache/storage と同じ対策)。
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

function txReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // tx abort 時も reject し await のハングを防ぐ(正常時は不変)。
    const tx = req.transaction;
    if (tx) tx.addEventListener("abort", () => reject(tx.error || new Error("IndexedDB transaction aborted")));
  });
}

/**
 * キューに積む
 */
export async function enqueue(payload) {
  const db = await openDb();
  const tx = db.transaction("scrobbles", "readwrite");
  tx.objectStore("scrobbles").add(payload);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // abort 時 tx.error は null になり得るため fallback を付ける(reject(undefined) 回避)
    tx.onerror = () => reject(tx.error || new Error("IndexedDB enqueue failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB enqueue aborted"));
  });
}

/**
 * 先頭から最大 N 件取得（古い順）
 */
export async function peek(limit = 50) {
  const db = await openDb();
  const tx = db.transaction("scrobbles");
  const store = tx.objectStore("scrobbles");
  const all = await txReq(store.getAll());
  // timestamp 昇順
  all.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return all.slice(0, limit);
}

/**
 * 指定 ID 群を削除（送信成功分）
 */
export async function removeMany(ids) {
  if (!ids || ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction("scrobbles", "readwrite");
  const store = tx.objectStore("scrobbles");
  for (const id of ids) store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB removeMany failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB removeMany aborted"));
  });
}

/**
 * キュー件数
 */
export async function count() {
  const db = await openDb();
  return txReq(db.transaction("scrobbles").objectStore("scrobbles").count());
}

/**
 * 全消去
 */
export async function wipeQueue() {
  const db = await openDb();
  const tx = db.transaction("scrobbles", "readwrite");
  tx.objectStore("scrobbles").clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB wipeQueue failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB wipeQueue aborted"));
  });
}
