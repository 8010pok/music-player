/**
 * 統計データの永続化（表示用に整形された最小データのみ）
 *
 * - DB: music-player.stats
 *   - store "current" : 現在表示するデータ一式 { id:"current", user, fetchDate, sections, timestamp }
 *   - store "history" : 日付別アーカイブ（提案E: 過去Nヶ月の履歴）
 *
 * - 日付は JST (Asia/Tokyo) ベースで判定。
 *   ローカルタイムゾーンに依存せず、ユーザの感覚と一致させるため。
 *
 * - 「大量データを保持しない」原則：
 *   Last.fm の生レスポンス（recent tracks 全件 = 数 MB 超）は保持せず、
 *   画面に表示するために整形された最小限のデータ（合計サイズ数百 KB 程度）のみ保存する。
 */

const DB_NAME = "music-player.stats";
const DB_VERSION = 1;
const STORE_CURRENT = "current";
const STORE_HISTORY = "history";

let _dbPromise = null;

function openDb() {
  // ★ library-db.js と同じく「Promise 自体」をキャッシュする。
  //   旧実装は解決済みハンドル (_db) を onsuccess でセットして待っていたため、
  //   onsuccess 発火前に複数の呼び出しが来ると全員が _db===null を通過し、
  //   indexedDB.open() が多重実行されるレースがあった。統計サービスは初回
  //   ロードで saveCurrent/saveHistory 等を並列に多発するため実際に競合する。
  //   Promise をキャッシュすれば in-flight の 1 本を共有でき open は 1 回で済む。
  //   open 失敗時は _dbPromise を null に戻し、次回呼び出しで再試行できるようにする。
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CURRENT)) {
        db.createObjectStore(STORE_CURRENT, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "date" });
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

/**
 * JST (Asia/Tokyo) ベースで "YYYY-MM-DD" 形式の日付文字列を返す
 *
 * Intl.DateTimeFormat の timeZone:"Asia/Tokyo" を使うことで
 * ローカル時計が UTC でも EST でも常に東京の日付を取得できる。
 */
export function getJSTDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

/**
 * 指定の YYYY-MM-DD 文字列が「今日 (JST)」と一致するか
 */
export function isToday(dateStr) {
  return !!dateStr && dateStr === getJSTDateString();
}

/**
 * 現在の表示用データを取得（無ければ null）
 */
export async function loadCurrent() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_CURRENT, "readonly");
      const req = tx.objectStore(STORE_CURRENT).get("current");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * 現在の表示用データを保存
 *   payload: { user, fetchDate, sections, complete? }
 *   complete: この run が全セクションを新データで完全に更新できたか。
 *     false のとき、startIfNeeded は当日でも再取得する(古い/部分データの固定を防ぐ)。
 *     省略時(旧形式)は true 扱い(後方互換)。
 */
export async function saveCurrent(payload) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CURRENT, "readwrite");
      tx.objectStore(STORE_CURRENT).put({
        id: "current",
        user: payload.user,
        fetchDate: payload.fetchDate,
        sections: payload.sections,
        // 明示的に false のときだけ未完了として記録(省略・true は完了扱い)
        complete: payload.complete !== false,
        timestamp: Date.now(),
      });
      tx.oncomplete = () => resolve();
      // 他の書込関数(clearCurrent/wipeAll 等)と統一し、保存失敗でも reject せず
      // resolve する。保存失敗はアプリを止めない設計で、reject は .catch 漏れ箇所で
      // unhandled rejection になるため避ける。失敗は warn でログに残す。
      tx.onerror = () => { console.warn("[stats-storage] saveCurrent tx エラー", tx.error); resolve(); };
      // コミット時 abort(クォータ等)で onerror を伴わない場合も resolve し、
      // saveCurrent を await する集計パイプラインがハングしないようにする。
      tx.onabort = () => { console.warn("[stats-storage] saveCurrent tx abort", tx.error); resolve(); };
    });
  } catch (e) {
    console.warn("[stats-storage] saveCurrent 失敗", e);
  }
}

/**
 * 現在のデータを破棄
 */
export async function clearCurrent() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_CURRENT, "readwrite");
      tx.objectStore(STORE_CURRENT).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve(); // abort 時もハングしないよう resolve(非致命設計)
    });
  } catch {}
}

/**
 * 日付別スナップショット保存（提案E）
 *   軽量サマリーのみ。将来の比較分析・トレンド表示に利用できる。
 */
export async function saveHistory(dateStr, payload) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY, "readwrite");
      tx.objectStore(STORE_HISTORY).put({
        date: dateStr,
        user: payload.user,
        summary: payload.summary,
        timestamp: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => { console.warn("[stats-storage] saveHistory tx エラー", tx.error); resolve(); };
      tx.onabort = () => { console.warn("[stats-storage] saveHistory tx abort", tx.error); resolve(); };
    });
  } catch (e) {
    console.warn("[stats-storage] saveHistory 失敗", e);
  }
}

/**
 * 日付別スナップショット読み出し
 */
export async function loadHistory(dateStr) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_HISTORY, "readonly");
      const req = tx.objectStore(STORE_HISTORY).get(dateStr);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * 保存されている履歴日付の一覧
 */
export async function listHistoryDates() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_HISTORY, "readonly");
      const req = tx.objectStore(STORE_HISTORY).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * 直近 keepDays 日分のみ残し、それより古い履歴を削除
 *   既定で30日分保持。
 */
export async function pruneHistory(keepDays = 30) {
  try {
    const dates = await listHistoryDates();
    const sorted = (dates || []).slice().sort();
    if (sorted.length <= keepDays) return;
    const toDelete = sorted.slice(0, sorted.length - keepDays);
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_HISTORY, "readwrite");
      const store = tx.objectStore(STORE_HISTORY);
      for (const date of toDelete) store.delete(date);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve(); // abort 時もハングしないよう resolve(非致命設計)
    });
  } catch {}
}

/**
 * 全削除（「全データ消去」設定で使用）
 */
export async function wipeAll() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction([STORE_CURRENT, STORE_HISTORY], "readwrite");
      tx.objectStore(STORE_CURRENT).clear();
      tx.objectStore(STORE_HISTORY).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve(); // 全削除フローで await されるため abort 時も resolve
    });
  } catch {}
}
