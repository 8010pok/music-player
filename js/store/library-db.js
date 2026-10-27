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

import { getPublic } from "./settings.js";
import { recordTombstone, clearTombstones } from "./tombstone.js";

const DB_NAME = "music-player-library";
const DB_VERSION = 1;

let _dbPromise = null;
let _mutationListeners = [];
let _syncScopeActive = false;

/**
 * 同期インポート処理中のスコープを設定（同期由来の書き込みでは dirty 通知を抑止）
 * @param {boolean} active
 */
export function setSyncScope(active) {
  _syncScopeActive = !!active;
}

/**
 * 現在同期スコープ内（インポート中）かどうかを判定
 * @returns {boolean}
 */
export function isSyncScopeActive() {
  return _syncScopeActive;
}

/**
 * ライブラリ変更通知リスナーを登録
 * @param {Function} cb
 * @returns {Function} 登録解除関数
 */
export function onLibraryMutated(cb) {
  if (typeof cb === "function") {
    _mutationListeners.push(cb);
  }
  return () => {
    _mutationListeners = _mutationListeners.filter((fn) => fn !== cb);
  };
}

/**
 * ライブラリ変更が発生したことを購読者へ通知
 * @param {string} mutationType 変更種別
 * @param {any} [details]
 */
export function notifyLibraryMutated(mutationType, details) {
  if (_syncScopeActive) return; // 同期インポート中は dirty 通知を抑止
  for (const cb of _mutationListeners) {
    try {
      cb(mutationType, details);
    } catch (e) {
      console.warn("[library-db] onLibraryMutated リスナーエラー:", e);
    }
  }
}

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
  const MAX_ATTEMPTS = 4;
  return (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await run();
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          // ★ 再試行前にキャッシュ接続を破棄し、次の openDb() に新しい接続を張り直させる。
          _dbPromise = null;
          await new Promise((r) => setTimeout(r, attempt * 120));
        }
      }
    }
    throw lastErr;
  })();
}

function notifyTrackUpdated(track, patch = null) {
  if (!track || !track.id) return;
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("music-player:track-updated", {
        detail: { id: track.id, track, patch },
      }));
    }
  } catch (_) {}
}

/**
 * Google Drive の先頭 1.5MB (1,572,864 bytes) 部分ヘッダのみから誤って CBR 計算された
 * 再生時間（例: 320kbps で約 39秒 = 0:39、256kbps で約 49秒、192kbps で約 65秒）かどうかを判定する。
 * @param {object} track
 * @returns {boolean}
 */
export function isSuspectPartialHeaderDuration(track) {
  if (!track || typeof track !== "object") return false;
  const dur = Number(track.duration) || 0;
  const fsize = Number(track.fileSize) || 0;
  if (dur <= 0 || fsize <= 2200000) return false;
  const isDrive = track.source === "gdrive" || Boolean(track.driveFileId) || (typeof track.id === "string" && track.id.startsWith("gd-"));
  if (!isDrive) return false;
  // ファイルサイズが 2.2MB 超（通常 3〜5分の曲）にもかかわらず、再生時間が 1.5MB ヘッダ由来の 34〜68秒になっている場合
  return dur >= 34 && dur <= 68;
}

/**
 * 音源 Blob から不足しているメタデータ・アートワーク・再生時間をバックグラウンドで補完し、
 * 更新があれば updateTrack 経由でミニプレイヤー・フルプレイヤー・ロック画面へ即時反映する。
 * @param {string} id
 * @param {Blob} blob
 * @param {object} [extraPatch]
 */
function ensureTrackMetadataInBackground(id, blob, extraPatch = null) {
  if (!id || !blob) return;
  (async () => {
    try {
      const track = await getTrack(id);
      if (!track) return;
      const missingArt = !track.artworkBlob && !track.artworkDataUrl && !track._noEmbeddedArt;
      const missingDataUrl = (track.artworkBlob || !track._noEmbeddedArt) && !track.artworkDataUrl;
      const suspectDuration = isSuspectPartialHeaderDuration(track);
      const missingDuration = !track.duration || track.duration <= 0 || suspectDuration;
      const { isPlaceholderArtist, parseArtistAndTitle } = await import("../lastfm/scrobble-cleaner.js");
      const isPlaceholderArtistVal = isPlaceholderArtist(track.artist) || typeof track.artist !== "string";
      const isPlaceholderAlbum =
        !track.album ||
        typeof track.album !== "string" ||
        track.album === "Google Drive" ||
        track.album === "マイドライブ" ||
        track.album.toLowerCase() === "true" ||
        track.album.toLowerCase() === "false" ||
        isPlaceholderArtist(track.album);
      const needsParse = missingDuration || missingArt || !track.userEdited || isPlaceholderArtistVal || isPlaceholderAlbum;

      const patch = extraPatch ? { ...extraPatch } : {};
      if (needsParse) {
        const { extractMetadata, readDurationViaAudio } = await import("../metadata/index.js");
        const meta = await extractMetadata(blob, track.originalName || track.title || "");
        let duration = meta.duration;
        if ((!duration || duration <= 0) && missingDuration && typeof document !== "undefined") {
          duration = await readDurationViaAudio(blob);
        }
        const isNumeric = (s) => typeof s === "string" && /^\d+$/.test(s.trim());
        let validArtist = meta.artist && !isPlaceholderArtist(meta.artist) && !isNumeric(meta.artist) ? meta.artist : null;
        if (!validArtist) {
          const parsed = parseArtistAndTitle(track.originalName || track.title || "");
          if (parsed && parsed.artist && !isPlaceholderArtist(parsed.artist) && !isNumeric(parsed.artist)) {
            validArtist = parsed.artist;
            if (!track.userEdited && parsed.title && (!meta.title || meta.title === "(無題)")) {
              patch.title = parsed.title;
            }
          }
        }
        const validAlbum = meta.album && meta.album !== "Google Drive" && !isPlaceholderArtist(meta.album) ? meta.album : null;

        if (!track.userEdited) {
          if (meta.title && meta.title !== "(無題)") patch.title = meta.title;
          if (validArtist) patch.artist = validArtist;
          if (validAlbum) patch.album = validAlbum;
          if (meta.albumArtist) patch.albumArtist = meta.albumArtist;
          if (meta.trackNo) patch.trackNo = meta.trackNo;
          if (meta.discNo) patch.discNo = meta.discNo;
          if (meta.year) patch.year = meta.year;
          if (meta.genre) patch.genre = meta.genre;
        } else {
          if (isPlaceholderArtistVal && validArtist) patch.artist = validArtist;
          if (isPlaceholderAlbum && validAlbum) patch.album = validAlbum;
        }

        // アートワークは userEdited (他端末からの同期後など) であっても未保持なら音源から補完する
        if (meta.artworkBlob && !track.artworkBlob) patch.artworkBlob = meta.artworkBlob;
        if (meta.artworkDataUrl && !track.artworkDataUrl) {
          patch.artworkDataUrl = meta.artworkDataUrl;
        } else if ((meta.artworkBlob || track.artworkBlob) && !track.artworkDataUrl && !patch.artworkDataUrl) {
          try {
            const { blobToDataUrl } = await import("../metadata/util.js");
            patch.artworkDataUrl = await blobToDataUrl(patch.artworkBlob || track.artworkBlob, 500);
          } catch (_) {}
        }
        if (!track.artworkBlob && !track.artworkDataUrl && !meta.artworkBlob && !meta.artworkDataUrl) {
          patch._noEmbeddedArt = true;
        }

        // ★ 0:39 固定バグなどの不正確な再生時間も、実ファイルからの duration で上書き修正する
        if (duration && duration > 0 && (!track.duration || track.duration <= 0 || suspectDuration || Math.abs(duration - track.duration) > 2)) {
          patch.duration = duration;
        }
      } else if (missingDataUrl && track.artworkBlob) {
        // パース不要だが artworkDataUrl がまだ生成されていない場合、Base64 Data URL を生成して補完
        try {
          const { blobToDataUrl } = await import("../metadata/util.js");
          patch.artworkDataUrl = await blobToDataUrl(track.artworkBlob, 500);
        } catch (_) {}
      }

      if (Object.keys(patch).length > 0) {
        await updateTrack(id, patch);
      }
    } catch (e) {
      console.warn("[library-db] メタデータ自動補完スキップ:", e);
    }
  })();
}

/**
 * トラックを追加（重複は upsert）
 * @param {object} track
 * @param {Blob} blob
 */
export function putTrack(track, blob) {
  const cleanTrack = sanitizeRecordForIdb(track);
  if (cleanTrack && cleanTrack.id && blob) {
    putMemoryBlob(cleanTrack.id, blob);
  }
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs"], "readwrite");
    tx.objectStore("tracks").put(cleanTrack);
    if (blob) {
      tx.objectStore("blobs").put({ id: cleanTrack.id, blob });
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        if (cleanTrack) notifyTrackUpdated(cleanTrack, cleanTrack);
        notifyLibraryMutated("track:put", cleanTrack);
        resolve();
      };
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  }).catch((err) => {
    // artworkBlob が GC/失効または容量圧迫を起こしている場合のフォールバック: artworkBlob を除いて再保存
    if (cleanTrack && cleanTrack.artworkBlob) {
      const stripped = { ...cleanTrack, artworkBlob: null };
      return withWriteRetry(async () => {
        const db = await openDb();
        const tx = db.transaction(["tracks", "blobs"], "readwrite");
        tx.objectStore("tracks").put(stripped);
        if (blob) tx.objectStore("blobs").put({ id: stripped.id, blob });
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => {
            notifyTrackUpdated(stripped, stripped);
            notifyLibraryMutated("track:put", stripped);
            resolve();
          };
          tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
          tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
        });
      });
    }
    throw err;
  });
}

/**
 * 複数トラック（および付随Blob）を【単一トランザクション】で一括追加・更新（upsert）する。
 * - 端末間同期 (sync-service.js) や Google Drive 一括追加時、N 回の個別トランザクションによる
 *   iOS Safari の abort / QuotaExceeded / トランザクション詰まりを完全防止する。
 * @param {Array<{ track: object, blob?: Blob }>} items
 * @returns {Promise<Array<object>>}
 */
export function bulkPutTracks(items) {
  if (!Array.isArray(items) || items.length === 0) return Promise.resolve([]);

  const runBatch = (stripBlob) => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(["tracks", "blobs"], "readwrite");
    const trackStore = tx.objectStore("tracks");
    const blobStore = tx.objectStore("blobs");
    const savedTracks = [];

    for (const item of items) {
      if (!item || !item.track || !item.track.id) continue;
      const clean = sanitizeRecordForIdb(item.track);
      if (stripBlob) {
        clean.artworkBlob = null;
      }
      try {
        trackStore.put(clean);
      } catch (_) {
        clean.artworkBlob = null;
        trackStore.put(clean);
      }
      if (item.blob) {
        try {
          blobStore.put({ id: clean.id, blob: item.blob });
        } catch (_) {}
      }
      savedTracks.push(clean);
    }

    tx.oncomplete = () => {
      for (const item of items) {
        if (item && item.track && item.track.id && item.blob) {
          putMemoryBlob(item.track.id, item.blob);
        }
      }
      for (const t of savedTracks) {
        notifyTrackUpdated(t, t);
      }
      notifyLibraryMutated("track:bulkPut", savedTracks);
      resolve(savedTracks);
    };
    tx.onerror = () => reject(tx.error || new Error("IndexedDB bulk put failed/aborted"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB bulk put failed/aborted"));
  }));

  return withWriteRetry(() => runBatch(false)).catch((err) => {
    console.warn("[library-db] bulkPutTracks 通常保存失敗、artworkBlob 除去フォールバックを実行:", err);
    return withWriteRetry(() => runBatch(true));
  });
}

/**
 * IndexedDB (特に iOS Safari / WebKit) での DataCloneError / InvalidStateError / QuotaExceeded を防ぐため、
 * トラックレコード内の artworkBlob を検証・正規化する。
 * - artworkDataUrl (Base64) がすでにある場合は、WebKit で失効しやすい生の artworkBlob を保持せず null に統一する。
 */
function sanitizeRecordForIdb(rec) {
  if (!rec || typeof rec !== "object") return rec;
  const copy = { ...rec };
  if (!copy.updatedAt) {
    copy.updatedAt = copy.addedAt || Date.now();
  }
  if (copy.artworkDataUrl && typeof copy.artworkDataUrl === "string" && copy.artworkDataUrl.startsWith("data:")) {
    // Base64 Data URL がある場合は生の Blob を IndexedDB に重複保存しない（iOS WebKit の stale Blob DataCloneError を完全防止）
    copy.artworkBlob = null;
  } else if (copy.artworkBlob != null) {
    if (typeof Blob !== "undefined" && !(copy.artworkBlob instanceof Blob)) {
      copy.artworkBlob = null;
    } else if (copy.artworkBlob.size === 0) {
      copy.artworkBlob = null;
    }
  }
  return copy;
}

const _repairedTrackIds = new Set();

function isCorruptedMetaField(val) {
  if (typeof val === "boolean") return true;
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase();
    return lower === "true" || lower === "false" || lower === "null" || lower === "undefined";
  }
  return false;
}

function sanitizeTrackRecord(t) {
  if (!t || typeof t !== "object") return false;
  let wasCorrupted = false;
  if (isCorruptedMetaField(t.album)) {
    t.album = "";
    wasCorrupted = true;
  }
  if (isCorruptedMetaField(t.artist)) {
    t.artist = "(不明アーティスト)";
    wasCorrupted = true;
  }
  if (isCorruptedMetaField(t.albumArtist)) {
    t.albumArtist = "";
    wasCorrupted = true;
  }
  // ★ 1.5MB (1,572,864 bytes) 部分ヘッダ由来の 0:39 (約39秒) 固定バグの即時補正
  if (isSuspectPartialHeaderDuration(t)) {
    t.duration = Math.round(t.duration * (t.fileSize / 1572864));
    wasCorrupted = true;
  }
  return wasCorrupted;
}

function repairCorruptedTracksInBackground(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  (async () => {
    let anyUpdated = false;
    try {
      const { extractMetadata } = await import("../metadata/index.js");
      const batchUpdates = [];
      for (const t of tracks) {
        if (!t || !t.id) continue;
        try {
          const patch = {
            album: typeof t.album === "string" ? t.album : "",
            artist: typeof t.artist === "string" ? t.artist : "(不明アーティスト)",
          };
          if (t.duration && t.duration > 0) {
            patch.duration = t.duration;
          }
          // 1. ローカル Blob があればそこからアルバム名・再生時間を復元
          const db = await openDb();
          const blobRow = await txReq(db.transaction("blobs").objectStore("blobs").get(t.id)).catch(() => null);
          let targetBlob = blobRow && blobRow.blob ? blobRow.blob : null;

          // 2. ローカル Blob が無く Google Drive 曲であれば先頭ヘッダからアルバム名・再生時間を復元
          if (!targetBlob && (t.driveFileId || (typeof t.id === "string" && t.id.startsWith("gd-")))) {
            const fileId = t.driveFileId || t.id.slice(3);
            try {
              const { fetchDriveAudioHeader } = await import("../gdrive/drive-service.js");
              targetBlob = await fetchDriveAudioHeader(fileId, 1572864, Number(t.fileSize) || 0);
            } catch (_) {}
          }

          if (targetBlob && targetBlob.size > 0) {
            const meta = await extractMetadata(targetBlob, t.originalName || t.title || "");
            if (meta) {
              if (!t.userEdited && meta.album && !isCorruptedMetaField(meta.album) && meta.album !== "Google Drive") {
                patch.album = meta.album;
              }
              if (!t.userEdited && meta.albumArtist && !isCorruptedMetaField(meta.albumArtist) && !t.albumArtist) {
                patch.albumArtist = meta.albumArtist;
              }
              if (meta.duration && meta.duration > 0) {
                patch.duration = meta.duration;
              }
              if (!t.userEdited) {
                if (meta.year && !t.year) patch.year = meta.year;
                if (meta.trackNo && !t.trackNo) patch.trackNo = meta.trackNo;
                if (meta.discNo && !t.discNo) patch.discNo = meta.discNo;
                if (meta.genre && !t.genre) patch.genre = meta.genre;
              }
            }
          }

          batchUpdates.push({ id: t.id, patch });
        } catch (err) {
          console.warn("[library-db] 破損メタデータ自動修復スキップ:", t.id, err);
        }
      }
      if (batchUpdates.length > 0) {
        await bulkUpdateTracks(batchUpdates);
        anyUpdated = true;
      }
      if (anyUpdated && typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("music-player:library-synced", { detail: { repaired: true } }));
      }
    } catch (e) {
      console.warn("[library-db] 一括修復エラー:", e);
    }
  })();
}

/**
 * トラック1件取得
 */
export async function getTrack(id) {
  const db = await openDb();
  const t = await txReq(db.transaction("tracks").objectStore("tracks").get(id));
  if (t && sanitizeTrackRecord(t) && !_repairedTrackIds.has(t.id)) {
    _repairedTrackIds.add(t.id);
    repairCorruptedTracksInBackground([t]);
  }
  return t;
}

// インメモリ Blob LRU キャッシュ (最大 10 曲)
// 直近再生・プリウォームされた曲をメモリ保持し、重複 IndexedDB トランザクションを 0ms に短縮
const _memoryBlobCache = new Map();
const MAX_MEMORY_BLOB_CACHE = 10;

export function putMemoryBlob(id, blob) {
  if (!id || !blob) return;
  if (_memoryBlobCache.has(id)) {
    _memoryBlobCache.delete(id);
  } else if (_memoryBlobCache.size >= MAX_MEMORY_BLOB_CACHE) {
    const oldestKey = _memoryBlobCache.keys().next().value;
    _memoryBlobCache.delete(oldestKey);
  }
  _memoryBlobCache.set(id, blob);
}

export function getMemoryBlob(id) {
  if (!id || !_memoryBlobCache.has(id)) return null;
  const blob = _memoryBlobCache.get(id);
  _memoryBlobCache.delete(id);
  _memoryBlobCache.set(id, blob);
  return blob;
}

export function hasMemoryBlob(id) {
  return !id ? false : _memoryBlobCache.has(id);
}

/**
 * トラック本体（Blob）取得
 * @param {string} id
 * @param {{ signal?: AbortSignal|null }} [opts]
 */
export async function getBlob(id, { signal = null } = {}) {
  const mem = getMemoryBlob(id);
  if (mem) {
    ensureTrackMetadataInBackground(id, mem);
    return mem;
  }

  let row = null;
  try {
    const db = await openDb();
    row = await txReq(db.transaction("blobs").objectStore("blobs").get(id));
  } catch (err) {
    console.warn("[library-db] getBlob 初回失敗、再接続リトライ:", err);
    try {
      _dbPromise = null;
      const db = await openDb();
      row = await txReq(db.transaction("blobs").objectStore("blobs").get(id));
    } catch (retryErr) {
      console.warn("[library-db] getBlob リトライも失敗:", retryErr);
    }
  }
  if (row && row.blob) {
    putMemoryBlob(id, row.blob);
    ensureTrackMetadataInBackground(id, row.blob);
    return row.blob;
  }

  // Google Drive 音源でローカル未キャッシュの場合、Google Drive から取得してキャッシュ
  if (typeof id === "string" && id.startsWith("gd-")) {
    const driveFileId = id.slice(3);
    try {
      const { fetchDriveAudioBlob } = await import("../gdrive/drive-service.js");
      const blob = await fetchDriveAudioBlob(driveFileId, { signal });
      if (blob) {
        putMemoryBlob(id, blob);
        let shouldCache = true;
        try {
          const pub = getPublic();
          if (pub && pub.gdriveAutoCache === false) shouldCache = false;
        } catch (_) {}

        if (shouldCache) {
          // blobs ストアにキャッシュ保存 (自動キャッシュ有効時のみ)
          await withWriteRetry(async () => {
            const wdb = await openDb();
            const tx = wdb.transaction("blobs", "readwrite");
            tx.objectStore("blobs").put({ id, blob });
            return new Promise((res, rej) => {
              tx.oncomplete = () => res();
              tx.onerror = () => rej(tx.error);
              tx.onabort = () => rej(tx.error);
            });
          });
        }

        // バックグラウンドでメタデータとアートワーク、再生時間を補完（再生開始をブロックしない）
        ensureTrackMetadataInBackground(id, blob, { cached: shouldCache });

        return blob;
      }
    } catch (err) {
      console.warn("[library-db] Google Drive からの音源取得に失敗:", id, err);
      throw err;
    }
  }

  return null;
}

/**
 * トラックの音源BlobがローカルIndexedDBにキャッシュされているかを判定する
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function hasCachedBlob(id) {
  if (!id) return false;
  if (hasMemoryBlob(id)) return true;
  try {
    const db = await openDb();
    const count = await txReq(db.transaction("blobs").objectStore("blobs").count(id));
    return count > 0;
  } catch {
    return false;
  }
}

const _cachingDriveIds = new Set();

/**
 * ダイレクトストリーミング再生開始後に、裏（バックグラウンド）で Google Drive 音源を
 * IndexedDB (blobs ストア) にキャッシュし、完全なメタデータ・アートワーク・正確な再生時間を補完する。
 * @param {string} id
 * @param {{ signal?: AbortSignal|null }} [opts]
 * @returns {Promise<void>}
 */
export function cacheDriveTrackInBackground(id, { signal = null } = {}) {
  if (!id || typeof id !== "string" || !id.startsWith("gd-")) return Promise.resolve();
  if (_cachingDriveIds.has(id)) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  _cachingDriveIds.add(id);
  return (async () => {
    try {
      const pub = getPublic();
      if (pub && pub.gdriveAutoCache === false) return;
      const already = await hasCachedBlob(id);
      if (already) return;
      if (signal?.aborted) return;
      await getBlob(id, { signal });
    } catch (e) {
      if (e?.name !== "AbortError" && !signal?.aborted) {
        console.warn("[library-db] バックグラウンドDriveキャッシュスキップ:", id, e);
      }
    } finally {
      _cachingDriveIds.delete(id);
    }
  })();
}

/**
 * 全トラック取得（順序は未保証＝IndexedDB の主キー id=コンテンツハッシュ順で、時系列順ではない）。
 *   表示順は呼び出し側(view-library の getComparator)が JS でソートする。ここで DB レベルの整列を
 *   前提にしないこと(addedAt index は定義済みだが本関数では未使用)。
 */
export async function getAllTracks() {
  const db = await openDb();
  const list = await txReq(db.transaction("tracks").objectStore("tracks").getAll());
  if (Array.isArray(list)) {
    const toRepair = [];
    for (const t of list) {
      if (sanitizeTrackRecord(t) && t.id && !_repairedTrackIds.has(t.id)) {
        _repairedTrackIds.add(t.id);
        toRepair.push(t);
      }
    }
    if (toRepair.length > 0) {
      repairCorruptedTracksInBackground(toRepair);
    }
  }
  return list;
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
  const runUpdate = (stripBlob) => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    const store = tx.objectStore("tracks");
    const req = store.get(id);
    let updated = null;
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(undefined); return; }
      Object.assign(cur, patch);
      cur.updatedAt = patch.updatedAt || Date.now();
      const clean = sanitizeRecordForIdb(cur);
      if (stripBlob) {
        clean.artworkBlob = null;
      }
      updated = clean;
      try {
        store.put(clean);
      } catch (putErr) {
        // 同期的な DataCloneError 等の場合は artworkBlob を除去して即座に再 put
        clean.artworkBlob = null;
        store.put(clean);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => {
      if (updated) notifyTrackUpdated(updated, patch);
      notifyLibraryMutated("track:update", { id, patch });
      resolve(updated);
    };
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  }));

  return withWriteRetry(() => runUpdate(false)).catch((err) => {
    console.warn("[library-db] updateTrack 通常保存失敗、artworkBlob 除去フォールバックを実行:", id, err);
    return withWriteRetry(() => runUpdate(true));
  });
}

/**
 * 複数トラックのメタデータを【単一トランザクション】で一括更新する（アルバム一括編集・複数選択一括編集用）。
 *   - 従来は N 曲分の updateTrack をループで N 回別々の readwrite トランザクションとして発行していたため、
 *     iOS Safari 等でトランザクション競合や DataCloneError / abort が起きやすく「IndexedDB library write failed/aborted」
 *     の原因になっていた。
 *   - 単一トランザクションにまとめることで N→1 トランザクションに削減し、万一 Blob クローンエラーや容量不足が
 *     発生しても自動で artworkBlob を整理して確実に保存を完了させる。
 * @param {Array<{ id: string, patch: object, onlyIfNotUserEdited?: boolean }>} updates
 * @returns {Promise<Array<object>>}
 */
export function bulkUpdateTracks(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return Promise.resolve([]);

  const runBatch = (stripBlob) => openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    const store = tx.objectStore("tracks");
    const updatedList = [];

    for (const item of updates) {
      if (!item || !item.id || !item.patch) continue;
      const req = store.get(item.id);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (item.onlyIfNotUserEdited && cur.userEdited && typeof cur.album === "string" && !isCorruptedMetaField(cur.album)) {
          return;
        }
        Object.assign(cur, item.patch);
        cur.updatedAt = item.patch.updatedAt || Date.now();
        const clean = sanitizeRecordForIdb(cur);
        if (stripBlob) {
          clean.artworkBlob = null;
        }
        try {
          store.put(clean);
        } catch (_) {
          clean.artworkBlob = null;
          store.put(clean);
        }
        updatedList.push({ track: clean, patch: item.patch });
      };
    }

    tx.oncomplete = () => {
      for (const u of updatedList) {
        notifyTrackUpdated(u.track, u.patch);
      }
      notifyLibraryMutated("track:bulkUpdate", updates);
      resolve(updatedList.map((u) => u.track));
    };
    tx.onerror = () => reject(tx.error || new Error("IndexedDB bulk track write failed/aborted"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB bulk track write failed/aborted"));
  }));

  return withWriteRetry(() => runBatch(false)).catch((err) => {
    console.warn("[library-db] bulkUpdateTracks 通常保存失敗、artworkBlob 除去フォールバックを実行:", err);
    return withWriteRetry(() => runBatch(true));
  });
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
    tx.oncomplete = () => {
      notifyLibraryMutated("order:update", { storeName, entries });
      resolve();
    };
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
 * トラック削除（blobも削除し、端末間同期用Tombstoneを記録）
 */
export function deleteTrack(id) {
  let tombstoneSaved = true;
  if (id) {
    _memoryBlobCache.delete(id);
    const tombRes = recordTombstone(id, "track");
    if (tombRes && !tombRes.ok) {
      tombstoneSaved = false;
      console.warn(`[library-db] ⚠️ 曲 ${id} の Tombstone 記録に失敗しました:`, tombRes.error);
    }
  }
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs"], "readwrite");
    tx.objectStore("tracks").delete(id);
    tx.objectStore("blobs").delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        notifyLibraryMutated("track:delete", { id });
        resolve({ ok: true, tombstoneSaved });
      };
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * 複数トラックを一括削除（単一トランザクションで確実に削除しTombstone記録）
 * @param {string[]} ids
 * @returns {Promise<{ ok: boolean, tombstoneSaved: boolean }>}
 */
export function bulkDeleteTracks(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve({ ok: true, tombstoneSaved: true });
  let allTombstonesSaved = true;
  for (const id of ids) {
    if (id) {
      _memoryBlobCache.delete(id);
      const tombRes = recordTombstone(id, "track");
      if (tombRes && !tombRes.ok) {
        allTombstonesSaved = false;
        console.warn(`[library-db] ⚠️ 曲 ${id} の一括削除 Tombstone 記録に失敗:`, tombRes.error);
      }
    }
  }
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs"], "readwrite");
    const trackStore = tx.objectStore("tracks");
    const blobStore = tx.objectStore("blobs");
    for (const id of ids) {
      if (id) {
        trackStore.delete(id);
        blobStore.delete(id);
      }
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        notifyLibraryMutated("track:bulkDelete", { ids });
        resolve({ ok: true, tombstoneSaved: allTombstonesSaved });
      };
      tx.onerror = () => reject(tx.error || new Error("IndexedDB bulk delete tracks failed/aborted"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB bulk delete tracks failed/aborted"));
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
      tx.oncomplete = () => {
        notifyLibraryMutated("playlist:save", pl);
        resolve();
      };
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
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
    tx.oncomplete = () => {
      notifyLibraryMutated("playlist:update", { id, patch });
      resolve(result);
    };
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

/**
 * 曲をプレイリスト末尾に追加（重複は除外）
 * （transaction 内 await を避ける統一パターン）
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
    tx.oncomplete = () => {
      notifyLibraryMutated("playlist:addTracks", { id, trackIdsToAdd });
      resolve(result);
    };
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

/**
 * プレイリストから指定曲を削除
 * （transaction 内 await を避ける統一パターン）
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
    tx.oncomplete = () => {
      notifyLibraryMutated("playlist:removeTracks", { id, trackIdsToRemove });
      resolve(result);
    };
    tx.onerror  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    tx.onabort  = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
  })));
}

export function deletePlaylist(id) {
  if (id) {
    const tombRes = recordTombstone(id, "playlist");
    if (tombRes && !tombRes.ok) {
      console.warn(`[library-db] ⚠️ プレイリスト ${id} の Tombstone 記録に失敗しました:`, tombRes.error);
    }
  }
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction("playlists", "readwrite");
    tx.objectStore("playlists").delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        notifyLibraryMutated("playlist:delete", { id });
        resolve();
      };
      tx.onerror = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
      // abort 時もハングしないよう reject（savePlaylist と同じ防御）。
      tx.onabort = () => reject(tx.error || new Error("IndexedDB library write failed/aborted"));
    });
  });
}

/**
 * 指定トラックを全プレイリストの trackIds から取り除く（ライブラリ削除のカスケード用）。
 */
export function removeTrackFromAllPlaylists(trackId) {
  return withWriteRetry(async () => {
    const db = await openDb();
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
      tx.oncomplete = () => {
        notifyLibraryMutated("playlist:removeTrackCascade", { trackId });
        resolve();
      };
      tx.onerror = () => reject(tx.error || new Error("removeTrackFromAllPlaylists failed"));
      tx.onabort = () => reject(tx.error || new Error("removeTrackFromAllPlaylists aborted"));
    });
  });
}

/**
 * すべてのライブラリデータを消去（設定 → 全消去用）
 */
export function wipeLibrary() {
  _memoryBlobCache.clear();
  clearTombstones();
  return withWriteRetry(async () => {
    const db = await openDb();
    const tx = db.transaction(["tracks", "blobs", "playlists", "history"], "readwrite");
    tx.objectStore("tracks").clear();
    tx.objectStore("blobs").clear();
    tx.objectStore("playlists").clear();
    tx.objectStore("history").clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        notifyLibraryMutated("library:wipe", {});
        resolve();
      };
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

/**
 * Google Drive 音源のローカルキャッシュ（blobs）のみを一括消去し、端末容量を解放する
 * トラックのメタデータ、プレイリスト、お気に入りは保持される
 * @returns {Promise<{ clearedCount: number }>}
 */
export async function clearDriveBlobCache() {
  for (const k of _memoryBlobCache.keys()) {
    if (typeof k === "string" && k.startsWith("gd-")) {
      _memoryBlobCache.delete(k);
    }
  }
  const db = await openDb();
  const allTracks = await getAllTracks();
  const driveTracks = allTracks.filter((t) => typeof t.id === "string" && t.id.startsWith("gd-"));
  if (driveTracks.length === 0) return { clearedCount: 0 };

  await withWriteRetry(async () => {
    const wdb = await openDb();
    const tx = wdb.transaction(["blobs", "tracks"], "readwrite");
    const blobStore = tx.objectStore("blobs");
    const trackStore = tx.objectStore("tracks");
    for (const track of driveTracks) {
      blobStore.delete(track.id);
      track.cached = false;
      trackStore.put(track);
    }
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  });

  return { clearedCount: driveTracks.length };
}
