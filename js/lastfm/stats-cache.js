/**
 * Last.fm API レスポンスのローカルキャッシュ (IndexedDB)
 *
 * - レート制限 (5 req/sec) 対策と通信節約
 * - キャッシュ有効判定は「同じ JST 日付か」で行う（日が変わったら無効）。
 *   従来の「fetchedAt から N 時間」TTL より、ユーザの直感に合う。
 * - key は呼び出し側で組み立てる (例: `top-artists:overall:50:UserName`)
 *
 * IndexedDB は 1 ストア (`cache`) のみで構造を単純化。
 *   { key: string, data: any, fetchedAt: number, fetchDate: "YYYY-MM-DD" }
 */

import { getJSTDateString } from "./stats-storage.js";

/**
 * キャッシュキー組み立て。フィールドに ':' 等の区切り文字が含まれてもキーが
 * 衝突しないよう、各フィールドを encodeURIComponent でエスケープして ':' 連結する。
 * 例: ckey("trackinfo", "A:B", "C", user) → "trackinfo:A%3AB:C:..."
 *   旧来の `trackinfo:${artist}:${track}:${user}` 直書きでは、曲名/アーティスト名に
 *   ':' を含むタイトル(実在する)で隣接フィールドの境界が曖昧になり、別エンティティの
 *   listeners/playcount を取り違えてキャッシュ・表示する衝突が起きうる。
 */
export function ckey(...parts) {
  return parts.map((p) => encodeURIComponent(String(p == null ? "" : p))).join(":");
}

const DB_NAME = "music-player.statsCache";
const DB_VERSION = 1;
const STORE = "cache";

let _dbPromise = null;

function openDb() {
  // Promise 自体をキャッシュして多重 open を防ぐ (stats-storage.js と同じ理由)。
  // 旧実装は解決済みハンドルを onsuccess でセットしていたため、初回の並列
  // getCache/setCache 呼び出しで indexedDB.open() が多重実行され得た。
  // open 失敗時は _dbPromise を null に戻して次回再試行できるようにする。
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // open 成功後のクローズ/versionchange でもキャッシュを破棄し再接続させる
      // (library-db と同じ対策。同一性ガードで後発 open の _dbPromise を誤消去しない)。
      db.onclose = () => { if (_dbPromise && _dbPromise._db === db) _dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch {} if (_dbPromise && _dbPromise._db === db) _dbPromise = null; };
      _dbPromise._db = db;
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

function txReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * キャッシュ取得。
 *   - 通常レコード: JST 日付が今日と一致しなければ null (日次失効)
 *   - persistent レコード: 日付チェックをスキップして常に有効
 *     (確定済みの過去週チャートなど「不変データ」用。毎日の全再取得を防ぐ)
 */
export async function getCache(key) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const rec = await txReq(tx.objectStore(STORE).get(key));
    if (!rec) return null;
    // persistent(不変データ)は日付失効なし
    if (rec.persistent === true) return rec.data;
    // 日付が変わっていれば無効化
    if (rec.fetchDate !== getJSTDateString()) return null;
    return rec.data;
  } catch {
    return null;
  }
}

/**
 * 複数キーのキャッシュを「1 トランザクションで一括取得」する。
 *   - 振り返り/比較は週次チャートを数百件読むため、getCache を直列 await すると
 *     IndexedDB 往復のオーバーヘッドだけで数秒かかる。1 つの readonly tx 上で
 *     全件の get を並行発行し、まとめて待つことで直列待機を解消する。
 *   - 戻り値は keys と同じ並びの配列。各要素はヒット時 data、ミス/期限切れ時 null。
 *   - persistent レコードは日付失効をスキップ (getCache と同じ規則)。
 */
export async function getCacheMany(keys) {
  if (!keys || keys.length === 0) return [];
  try {
    const db = await openDb();
    const today = getJSTDateString();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    // 同一トランザクション上で全 get を並行発行 (保留リクエストがある限り
    // tx は auto-commit されないため、Promise.all で安全に待てる)。
    const recs = await Promise.all(keys.map((k) => txReq(store.get(k)).catch(() => null)));
    return recs.map((rec) => {
      if (!rec) return null;
      if (rec.persistent === true) return rec.data;
      if (rec.fetchDate !== today) return null;
      return rec.data;
    });
  } catch {
    // 失敗時は全件ミス扱い (呼び出し側がネットワーク取得にフォールバック)
    return keys.map(() => null);
  }
}

/**
 * キャッシュ書き込み（JST 日付付き。persistent=true で日次失効を免除）
 */
export async function setCache(key, data, { persistent = false } = {}) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      key,
      data,
      fetchedAt: Date.now(),
      fetchDate: getJSTDateString(),
      persistent: persistent === true,
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error); // abort 時も Promise を解決し await のハングを防ぐ
    });
  } catch {
    // 失敗してもアプリは動くので無視
  }
}

/**
 * キャッシュ全消去 (手動更新ボタンや「全削除」時に使う)
 */
export async function clearCache() {
  // 進行中の取得(in-flight)も破棄する。これをしないと refresh() の
  // cancel→clearCache→runFetch で、clearCache 前に発射された旧 fetch に新 run が
  // 合流し「最新のつもりで旧データ」を掴む鮮度競合が起きる(クリティック指摘)。
  _inflight.clear();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error); // abort 時も Promise を解決し await のハングを防ぐ
    });
  } catch {}
}

// 同一キーの in-flight fetch を共有する Map (cache stampede 防止)。
// 初回ロードでは weekly-list 等を複数タスクが同時に cached() するため、
// これが無いと同一リクエストが最大10並行で二重発射される。
const _inflight = new Map();

/**
 * 「JST 日付付き fetch ラッパ」
 *   - 今日のキャッシュがあればそれを返す
 *   - 無ければ fetcher() を呼んで結果をキャッシュ
 *   - forceRefresh=true でキャッシュ無視
 *   - persistent=true で日次失効を免除 (確定済み過去週チャート等の不変データ用)
 *   - 同一キーの並行呼び出しは 1 本のネットワーク要求に合流する
 *     (forceRefresh 同士/混在でも同一パラメータの読み取り API なので結果は同一)
 */
export async function cached(key, fetcher, { forceRefresh = false, persistent = false } = {}) {
  if (!forceRefresh) {
    const hit = await getCache(key);
    if (hit != null) return hit;
  }
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    const data = await fetcher();
    await setCache(key, data, { persistent });
    return data;
  })();
  _inflight.set(key, p);
  // 成功・失敗どちらでも必ず解放する (失敗 Promise を共有し続けない)。
  // ★ 同一性ガード: clearCache() の _inflight.clear() 後に旧 run の p_old が
  //   遅れて settle すると、無条件 delete(key) は新 run が登録した p_new を誤って
  //   消し、同一キーの後続 cached() が dedup されず余計なネットワーク要求を撃つ。
  //   「今この key に入っているのが自分(p)のときだけ」削除する。
  p.finally(() => {
    if (_inflight.get(key) === p) _inflight.delete(key);
  }).catch(() => {});
  return p;
}

/**
 * 期限切れキャッシュの刈り込み。
 *   - 非 persistent かつ fetchDate が今日でないレコードは getCache で常に無効
 *     なのに IndexedDB に残り続けるため、定期的に削除して肥大を防ぐ
 *     (trackinfo:曲名 等のコンテンツキー型は曲数に比例して増える)。
 *   - persistent レコード(過去週チャート)は残す (アカウント週数で有界)。
 *   - runFetch から fire-and-forget で呼ばれる。失敗は無視。
 */
export async function pruneCache() {
  try {
    const db = await openDb();
    const today = getJSTDateString();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cursorReq = store.openCursor();
    return new Promise((resolve) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(); return; }
        const rec = cursor.value;
        if (rec.persistent !== true && rec.fetchDate !== today) {
          cursor.delete();
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    });
  } catch {}
}

/**
 * 直近の fetchedAt を返す (UI の「最終更新: X分前」表示用)
 */
export async function getLatestFetchedAt(prefix) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    let latest = 0;
    const cursorReq = store.openCursor();
    return new Promise((resolve) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(latest); return; }
        if (!prefix || cursor.key.startsWith(prefix)) {
          if (cursor.value.fetchedAt > latest) latest = cursor.value.fetchedAt;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}
