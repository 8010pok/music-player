/**
 * ライブラリ用 IndexedDB
 *
 * stores:
 *   - tracks    : { id, title, artist, album, albumArtist, year, genre,
 *                   trackNo, duration, mime, addedAt, playCount, lastPlayedAt,
 *                   enabled, loved, fileSize, originalName, artworkBlob }
 *   - blobs     : { id (= track id), blob }   ※音源本体を別ストアに分離
 *   - playlists : { id, name, trackIds[], createdAt }
 *   - history   : { id (auto), trackId, startedAt, durationListened, scrobbled }
 */

const DB_NAME = "music-player-library";
const DB_VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("tracks")) {
        const s = db.createObjectStore("tracks", { keyPath: "id" });
        s.createIndex("title", "title", { unique: false });
        s.createIndex("artist", "artist", { unique: false });
        s.createIndex("album", "album", { unique: false });
        s.createIndex("addedAt", "addedAt", { unique: false });
        s.createIndex("playCount", "playCount", { unique: false });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("playlists")) {
        db.createObjectStore("playlists", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("history")) {
        const h = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        h.createIndex("trackId", "trackId", { unique: false });
        h.createIndex("startedAt", "startedAt", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // ★ open 成功後に接続が閉じられた場合(iOS のストレージ逼迫による強制クローズや、
      //   別タブからの versionchange)もキャッシュを破棄し、次回 openDb() で再接続させる。
      //   閉じた接続を掴み続けると以降の getBlob/getTrack 等が InvalidStateError で
      //   恒久的に失敗し、リロードでしか復帰できなくなるため(onerror と対の復旧策)。
      //   同一性ガード(_db)で、後発 open が登録した新しい _dbPromise を誤って消さない。
      db.onclose = () => { if (_dbPromise && _dbPromise._db === db) _dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch {} if (_dbPromise && _dbPromise._db === db) _dbPromise = null; };
      _dbPromise._db = db;
      resolve(db);
    };
    // ★ open 失敗時はキャッシュした reject 済み Promise を破棄する。これをしないと
    //   以後の openDb() がずっと同じ reject を返し、ライブラリ操作(getBlob 等)が
    //   恒久的に壊れて復帰不能になる。失敗時のみの追加で成功経路は不変。
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

/**
 * 単純な Promise ラッパ
 */
function txReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // tx が abort された場合(QuotaExceeded / version change 等で req.onerror が
    // 発火しないケース)も reject し、await のハングを防ぐ。正常時(onsuccess)は不変。
    const tx = req.transaction;
    if (tx) tx.addEventListener("abort", () => reject(tx.error || new Error("IndexedDB transaction aborted")));
  });
}

/**
 * IndexedDB 書き込みの一過性失敗を吸収する小さなリトライラッパ。
 *   - 主因: iOS のバックグラウンド遷移やストレージ逼迫で接続が onclose/onversionchange
 *     により閉じられたり、進行中トランザクションが abort することがある。これらは恒久
 *     障害ではなく、次の openDb() が接続を張り直せば成功するため再試行が有効。
 *   - 安全性: IndexedDB トランザクションは原子的で「abort=何もコミットされない」ため、
 *     失敗(reject)後の再試行は二重書き込みにならない(冪等)。get→put 型(updateTrack 等)も
 *     再試行時に最新を読み直すため lost update を起こさない。
 *   - QuotaExceededError は容量不足で再試行しても解決しないので即座に失敗させる。
 * @template T
 * @param {() => Promise<T>} run 1 回分の書き込みサンク(内部で openDb→transaction を行う)
 * @returns {Promise<T>}
 */
function withWriteRetry(run) {
  const MAX_ATTEMPTS = 3;
  return (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await run();
      } catch (err) {
        lastErr = err;
        if (err && err.name === "QuotaExceededError") break; // 容量不足は再試行不可
        if (attempt < MAX_ATTEMPTS) {
          // ★ 再試行前にキャッシュ接続を破棄し、次の openDb() に新しい接続を張り直させる。
          //   iOS ではバックグラウンド復帰後に接続が onclose を発火しないまま使用不能(InvalidStateError /
          //   tx abort)になることがあり、その壊れた接続を掴んだまま再試行すると同一接続上で連続失敗する。
          //   これが「再生無効トグルや並び替えが一度失敗すると、再タップしてもまた失敗(リロードまで復帰
          //   不能)」の主因。ここで参照を外せば openDb() が新接続を開き、操作内リトライと(全リトライ失敗後の)
          //   ユーザの再操作の両方が回復しやすくなる。実接続は close しない(進行中の別 tx を巻き込まない。
          //   IndexedDB は同一 DB への複数接続を許容し、参照されない旧接続は GC 時に閉じる)。
          //   QuotaExceededError は上で break 済みなので、容量不足での無駄な再接続は起きない。
          _dbPromise = null;
          // 短い待機で(iOS の一過性のサスペンド解除や再接続確立を)待ってから再試行する。
          await new Promise((r) => setTimeout(r, attempt * 100));
        }
      }
    }
    throw lastErr;
  })();
}

/**
 * トラックを追加（重複は upsert）
 * @param {object} track
 * @param {Blob} blob
 */
export function putTrack(track, blob) {
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs"], "readwrite");
    tx.objectStore("tracks").put(track);
    if (blob) {
      tx.objectStore("blobs").put({ id: track.id, blob });
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * トラック1件取得
 */
export async function getTrack(id) {
  const db = await openDb();
  return txReq(db.transaction("tracks").objectStore("tracks").get(id));
}

/**
 * トラック本体（Blob）取得
 */
export async function getBlob(id) {
  const db = await openDb();
  const row = await txReq(db.transaction("blobs").objectStore("blobs").get(id));
  return row && row.blob;
}

/**
 * 全トラック取得（順序は未保証＝IndexedDB の主キー id=コンテンツハッシュ順で、時系列順ではない）。
 *   表示順は呼び出し側(view-library の getComparator)が JS でソートする。ここで DB レベルの整列を
 *   前提にしないこと(addedAt index は定義済みだが本関数では未使用)。
 */
export async function getAllTracks() {
  const db = await openDb();
  return txReq(db.transaction("tracks").objectStore("tracks").getAll());
}

/**
 * トラック総数だけを取得する。
 *   count() は全レコードをデシリアライズしないため getAllTracks() より大幅に軽い
 *   (各 track レコードには artworkBlob が埋め込まれており、getAllTracks は全曲分の
 *    アートワークまで読み出す)。起動時の「曲が1曲でもあるか」判定など件数だけ要る用途に使う。
 */
export async function countTracks() {
  const db = await openDb();
  return txReq(db.transaction("tracks").objectStore("tracks").count());
}

/**
 * トラック更新（部分）
 *
 * ⚠️ transaction 内で await を使わない設計に統一している。
 * IndexedDB の readwrite transaction は「pending request がゼロ＋
 * イベントハンドラが return」した時点で auto-commit される仕様。
 * async/await（microtask）を挟むと WebKit (iOS Safari) では
 * onsuccess コールバック return → transaction が commit → その後の
 * store.put() が InvalidStateError になるケースがある。
 * get の onsuccess 内で put を同期的に呼び出すことで防ぐ。
 */
export function updateTrack(id, patch) {
  return withWriteRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    const store = tx.objectStore("tracks");
    const req = store.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(undefined); return; }
      Object.assign(cur, patch);
      store.put(cur);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

/**
 * 並び順(order)を【単一トランザクション】で一括更新する。
 *   - 従来はドラッグ並び替え後に件数ぶん updateTrack/updatePlaylist を逐次呼んでいた
 *     (N トランザクション)。iOS の一過性 abort は tx 単位で起こるため、N が多いほど
 *     「どれか1件が失敗」する確率が上がり「並び順の保存に失敗しました」が出やすかった。
 *     1 トランザクションに集約することで失敗機会を N→1 に減らし、かつ原子的(全件成功か
 *     全件未反映)にする。withWriteRetry の一過性リトライも tx 単位で効く。
 *   - get→order 代入→put を同一 readwrite tx 内で行う(tx 内 await を挟まない統一方針)。
 *     再試行は原子性(abort=未コミット)により冪等、現在値と同じ order は put をスキップ。
 * @param {string} storeName "tracks" | "playlists"
 * @param {Array<[string, number]>} entries [id, order] の配列
 * @param {{bumpUpdatedAt?: boolean}} [opts] playlists は updatePlaylist と同じく updatedAt も更新
 */
function bulkSetOrder(storeName, entries, { bumpUpdatedAt = false } = {}) {
  return withWriteRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const [id, order] of entries) {
      const req = store.get(id);
      req.onsuccess = () => {
        const cur = req.result;
        // 既に同値(再試行/並行編集)なら書き込まない。レコードが消えていればスキップ。
        if (cur && cur.order !== order) {
          cur.order = order;
          if (bumpUpdatedAt) cur.updatedAt = Date.now();
          store.put(cur);
        }
      };
      // 個別 get のエラーは tx を abort させ、下の onabort/onerror で reject される。
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB bulk order write failed/aborted"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB bulk order write failed/aborted"));
  })));
}

/** トラックの並び順を単一トランザクションで一括更新(ライブラリのドラッグ並び替え用)。 */
export function setTracksOrder(entries) {
  return bulkSetOrder("tracks", entries);
}

/** プレイリストの並び順を単一トランザクションで一括更新(プレイリスト一覧のドラッグ並び替え用)。 */
export function setPlaylistsOrder(entries) {
  return bulkSetOrder("playlists", entries, { bumpUpdatedAt: true });
}

/**
 * トラック削除（blobも）
 */
export function deleteTrack(id) {
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs"], "readwrite");
    tx.objectStore("tracks").delete(id);
    tx.objectStore("blobs").delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * 履歴記録（ローカル再生統計用）
 */
export function recordHistory(entry) {
  // 履歴の add は autoIncrement だが、abort 後の再試行では「前回 abort=未コミット」のため
  //   多重追加にならない(冪等)。一過性失敗で再生履歴が欠落する頻度を下げる。
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction("history", "readwrite");
    tx.objectStore("history").add(entry);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * 履歴全件取得
 */
export async function getAllHistory() {
  const db = await openDb();
  return txReq(db.transaction("history").objectStore("history").getAll());
}

/**
 * プレイリスト保存（新規・上書き共通）
 */
export function savePlaylist(pl) {
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction("playlists", "readwrite");
    tx.objectStore("playlists").put(pl);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      // クォータ超過や OS のストレージ退避で onerror を伴わず abort した場合に
      // Promise が永久に未解決(ハング)にならないよう、onabort でも reject する。
      // (updatePlaylist/addTracksToPlaylist 等と同じ防御パターンに統一)
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

export async function getAllPlaylists() {
  const db = await openDb();
  return txReq(db.transaction("playlists").objectStore("playlists").getAll());
}

/**
 * 単一プレイリスト取得
 */
export async function getPlaylist(id) {
  const db = await openDb();
  return txReq(db.transaction("playlists").objectStore("playlists").get(id));
}

/**
 * プレイリストの部分更新
 * （updateTrack と同様に transaction 内 await を避ける）
 */
export function updatePlaylist(id, patch) {
  return withWriteRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("playlists", "readwrite");
    const store = tx.objectStore("playlists");
    let result = null;
    const req = store.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(null); return; }
      Object.assign(cur, patch);
      cur.updatedAt = Date.now();
      result = cur;
      store.put(cur);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

/**
 * 曲をプレイリスト末尾に追加（重複は除外）
 * （transaction 内 await を避ける統一パターン）
 *
 * 戻り値契約(呼び出し側が依存): プレイリストが存在すれば
 *   { playlist: <更新後 playlist(trackIds 含む)>, addedCount: <実際に追加した件数> }
 * を resolve、存在しなければ null。
 * ※ removeTracksFromPlaylist は playlist を直接返す(形が非対称)点に注意。
 */
export function addTracksToPlaylist(id, trackIdsToAdd) {
  return withWriteRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("playlists", "readwrite");
    const store = tx.objectStore("playlists");
    let result = null;
    const req = store.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(null); return; }
      const existing = new Set(cur.trackIds || []);
      const added = [];
      for (const tid of trackIdsToAdd) {
        if (!existing.has(tid)) {
          existing.add(tid);
          added.push(tid);
        }
      }
      cur.trackIds = [...(cur.trackIds || []), ...added];
      cur.updatedAt = Date.now();
      result = { playlist: cur, addedCount: added.length };
      store.put(cur);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

/**
 * プレイリストから指定曲を削除
 * （transaction 内 await を避ける統一パターン）
 *
 * 戻り値契約(呼び出し側が依存): プレイリストが存在すれば <更新後 playlist(trackIds 含む)>
 * を直接 resolve、存在しなければ null。
 * ※ addTracksToPlaylist は { playlist, addedCount } を返す(形が非対称)点に注意。
 */
export function removeTracksFromPlaylist(id, trackIdsToRemove) {
  return withWriteRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("playlists", "readwrite");
    const store = tx.objectStore("playlists");
    let result = null;
    const req = store.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(null); return; }
      const remove = new Set(trackIdsToRemove);
      cur.trackIds = (cur.trackIds || []).filter((t) => !remove.has(t));
      cur.updatedAt = Date.now();
      result = cur;
      store.put(cur);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

export function deletePlaylist(id) {
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction("playlists", "readwrite");
    tx.objectStore("playlists").delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      // abort 時もハングしないよう reject（savePlaylist と同じ防御）。
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * 指定トラックを全プレイリストの trackIds から取り除く（ライブラリ削除のカスケード用）。
 *   - deleteTrack は tracks/blobs しか消さないため、これを併用しないと
 *     プレイリストに存在しない曲の孤児 id が残り、曲数表示の水増しや DB 肥大を招く。
 *   - 対象 id を含むプレイリストだけを 1 トランザクションでまとめて更新する。
 *   - 該当が無ければ即 resolve（無駄な書き込みをしない）。
 */
export function removeTrackFromAllPlaylists(trackId) {
  return withWriteRetry(async () => {
    const db = await openDb();
    // ★ 読み取りと書き込みを 1 つの readwrite transaction に収める(原子性)。
    //   getAll を別の readonly tx で先に取ると、その後の readwrite tx との間に
    //   別コンテキスト(別タブ等)が同じプレイリストを編集した分を上書きで失う
    //   (lost update)。getAll も readwrite tx 内で行い、onsuccess の中で同期的に
    //   put する(updateTrack 等と同じ「tx 内 await を挟まない」方針)。
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const store = tx.objectStore("playlists");
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        for (const pl of all) {
          if (Array.isArray(pl.trackIds) && pl.trackIds.includes(trackId)) {
            pl.trackIds = pl.trackIds.filter((t) => t !== trackId);
            pl.updatedAt = Date.now();
            store.put(pl);
          }
        }
      };
      req.onerror = () => reject(req.error || new Error("removeTrackFromAllPlaylists read failed"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("removeTrackFromAllPlaylists failed"));
      tx.onabort = () => reject(tx.error || new Error("removeTrackFromAllPlaylists aborted"));
    });
  });
}

/**
 * すべてのライブラリデータを消去（設定 → 全消去用）
 */
export function wipeLibrary() {
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs", "playlists", "history"], "readwrite");
    tx.objectStore("tracks").clear();
    tx.objectStore("blobs").clear();
    tx.objectStore("playlists").clear();
    tx.objectStore("history").clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      // 4ストア同時クリアは制約/クォータ起因の abort が起きやすい。onerror を
      // 伴わず abort した場合に await wipeLibrary() がハングしないよう reject する。
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * ストレージ使用量を取得（利用可能なら）
 */
export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    return navigator.storage.estimate();
  }
  return null;
}
