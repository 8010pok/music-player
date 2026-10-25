/**
 * 端末間ライブラリ同期・バックアップサービス
 *
 * - iPad ↔ iPhone などの端末間でライブラリ（曲情報、メモ、Google Drive音源リンク、プレイリスト、お気に入り等）を同期
 * - Google Drive クラウド自動同期: ワンタップで Google Drive 経由で iPad ↔ iPhone 間を同期
 * - 自動同期スケジューラ: 編集後debounce、起動時、オンライン復帰時、バックグラウンド移行時に安全に自動同期
 * - 排他制御（Mutex）: 同時実行の防止と処理の安全な直列化
 * - Tombstone方式の削除同期: 端末Aでの削除が端末Bに確実に反映され、古い端末からの再復活を防止
 * - 競合検知とスマートマージ: keyShift, gainDb, enabled, memo, 愛聴度, 再生回数, アートワークを完全保護
 * - iOS Web Share API (AirDrop / iCloud Drive / ファイル共有) によるオフライン同期にも対応
 */

import {
  getAllTracks,
  putTrack,
  bulkPutTracks,
  getAllPlaylists,
  savePlaylist,
  updateTrack,
  deleteTrack,
  deletePlaylist,
} from "./library-db.js";
import { getPublic, setPublic } from "./settings.js";
import {
  isDriveConnected,
  saveOrUpdateDriveSyncFile,
  findDriveFileByName,
  fetchDriveTextFile,
  getOrCreateDriveFolder,
} from "../gdrive/drive-service.js";
import { findDuplicateInList } from "./dedup-service.js";
import {
  getDeviceId,
  getTombstones,
  recordTombstone,
  mergeTombstones,
  isTombstoned,
} from "./tombstone.js";

const SYNC_FILE_NAME = "music-player-library-sync.json";
const SYNC_SCHEMA_VERSION = 3;

/**
 * ライブラリ全体のデータを JSON オブジェクトとしてエクスポート
 * (artworkBlob などのバイナリ・秘密情報は除外し、メタデータを完全保持)
 * @returns {Promise<object>}
 */
export async function exportLibraryData() {
  const tracks = await getAllTracks();
  const playlists = await getAllPlaylists();
  const pub = getPublic() || {};
  const tombstones = getTombstones();
  const deviceId = getDeviceId();

  // artworkBlob (Blob) や 一時的な blob URL は JSON 破損防止のため除外し、メタデータを完全コピー
  const cleanTracks = tracks.map((t) => {
    const copy = { ...t };
    delete copy.artworkBlob;
    // 一時的な blob URL の混入を防止
    if (typeof copy.artworkDataUrl === "string" && copy.artworkDataUrl.startsWith("blob:")) {
      delete copy.artworkDataUrl;
    }
    return copy;
  });

  return {
    app: "music-player",
    version: SYNC_SCHEMA_VERSION,
    schemaVersion: SYNC_SCHEMA_VERSION,
    deviceId,
    exportedAt: new Date().toISOString(),
    tracksCount: cleanTracks.length,
    playlistsCount: playlists.length,
    tombstonesCount: tombstones.length,
    tracks: cleanTracks,
    playlists,
    tombstones,
    settings: {
      gdriveClientId: pub.gdriveClientId || "",
      gdriveAutoCache: pub.gdriveAutoCache !== false,
      theme: pub.theme || "system",
      customInvidiousUrl: pub.customInvidiousUrl || "",
    },
  };
}

/**
 * ライブラリデータを AirDrop / 共有シート または ファイルダウンロードで書き出し
 * @param {object} [data]
 * @returns {Promise<{ shared: boolean, downloaded: boolean, canceled: boolean }>}
 */
export async function shareOrDownloadLibrary(data) {
  const exportObj = data || (await exportLibraryData());
  const jsonStr = JSON.stringify(exportObj, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const filename = `music-player-library-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], filename, { type: "application/json" });

  // iOS Safari / iPadOS Safari では navigator.share で AirDrop を直接選択可能
  if (typeof navigator !== "undefined" && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "MUSIC-PLAYER ライブラリ同期",
        text: "iPad / iPhone 間同期用ライブラリデータ",
      });
      return { shared: true, downloaded: false, canceled: false };
    } catch (e) {
      if (e && e.name === "AbortError") {
        return { shared: false, downloaded: false, canceled: true };
      }
      // シェア失敗時はダウンロードへフォールバック
    }
  }

  // フォールバック: 通常のダウンロードリンク
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { shared: false, downloaded: true, canceled: false };
}

/**
 * JSON 文字列またはオブジェクトからライブラリデータをインポート
 * (既存の音源Blobを保持しながら、変更された曲名・メモ・お気に入り等のメタデータをスマートマージ)
 *
 * @param {string|object} input
 * @param {object} [opts]
 * @param {boolean} [opts.deleteMissing=false] - 送信元に無い曲をローカルから削除するか
 * @returns {Promise<{ tracksCount: number, updatedCount: number, addedCount: number, playlistsCount: number, deletedCount: number, conflictsCount: number }>}
 */
export async function importLibraryData(input, { deleteMissing = false } = {}) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error("無効な JSON フォーマットです。ファイルが破損していないか確認してください。");
    }
  }

  if (!data || typeof data !== "object") {
    throw new Error("ライブラリデータが不正です。");
  }

  if (!Array.isArray(data.tracks)) {
    throw new Error("曲データ (tracks) が含まれていません。");
  }

  // 1. Tombstone（削除履歴）のマージと後方互換対応
  if (Array.isArray(data.tombstones)) {
    mergeTombstones(data.tombstones);
  }

  const existingTracks = await getAllTracks();
  const existingMap = new Map(existingTracks.map((t) => [t.id, t]));

  let updatedCount = 0;
  let addedCount = 0;
  let deletedCount = 0;
  let conflictsCount = 0;
  const incomingIds = new Set();
  const tracksToPut = [];

  // 2. リモートのTombstoneに基づいてローカルの削除を実行
  const allTombstones = getTombstones();
  for (const tomb of allTombstones) {
    if (tomb.type === "track") {
      const localTrack = existingMap.get(tomb.id);
      if (localTrack) {
        const localTime = localTrack.updatedAt || localTrack.addedAt || 0;
        if (tomb.deletedAt >= localTime) {
          await deleteTrack(tomb.id).catch(() => {});
          existingMap.delete(tomb.id);
          deletedCount++;
        }
      }
    }
  }

  // 3. トラックのマージ
  for (const incoming of data.tracks) {
    if (!incoming || !incoming.id) continue;
    incomingIds.add(incoming.id);

    // ★ Tombstone判定: 過去にローカルまたは他端末で削除された曲なら、古い同期JSONからの復活を防止
    const incomingTime = incoming.updatedAt || incoming.addedAt || 0;
    if (isTombstoned(incoming.id, incomingTime)) {
      continue;
    }

    let existing = existingMap.get(incoming.id);
    if (!existing) {
      // ID が異なっていても、タイトル・アーティスト・時間の一致する曲を既存から探す
      const dup = findDuplicateInList(incoming, existingTracks);
      if (dup) {
        existing = dup;
      }
    }

    if (existing) {
      // 競合検知: 双方で memo または title が異なり、双方が編集されている場合
      if (
        existing.memo &&
        incoming.memo &&
        existing.memo !== incoming.memo &&
        existing.userEdited &&
        incoming.userEdited
      ) {
        conflictsCount++;
      }

      // 既存曲がある場合: メタデータを安全にマージ
      // 既存の音源 Blob や artworkBlob は絶対に破壊しない！
      const merged = {
        ...existing,
        title: incoming.title || existing.title,
        artist: incoming.artist || existing.artist,
        album: incoming.album || existing.album,
        albumArtist: incoming.albumArtist !== undefined ? incoming.albumArtist : existing.albumArtist,
        memo: incoming.memo !== undefined ? incoming.memo : (existing.memo || ""),
        trackNo: incoming.trackNo || existing.trackNo,
        discNo: incoming.discNo || existing.discNo,
        year: incoming.year || existing.year,
        genre: incoming.genre || existing.genre,
        userEdited: incoming.userEdited !== undefined ? incoming.userEdited : existing.userEdited,
        loved: incoming.loved !== undefined ? incoming.loved : existing.loved,
        order: typeof incoming.order === "number" ? incoming.order : existing.order,
        enabled: incoming.enabled !== undefined ? incoming.enabled : (existing.enabled !== undefined ? existing.enabled : true),
        playCount: Math.max(existing.playCount || 0, incoming.playCount || 0),
        lastPlayedAt: Math.max(existing.lastPlayedAt || 0, incoming.lastPlayedAt || 0),
        updatedAt: Math.max(existing.updatedAt || existing.addedAt || 0, incoming.updatedAt || incoming.addedAt || 0),
      };

      // キーチェンジ & ノーマライズ情報の完全同期
      if (incoming.keyShift !== undefined) merged.keyShift = incoming.keyShift;
      if (incoming.gainDb !== undefined) merged.gainDb = incoming.gainDb;
      if (incoming.hasArtwork !== undefined) merged.hasArtwork = incoming.hasArtwork;

      // 歌詞も同期
      if (incoming.lyrics) {
        merged.lyrics = incoming.lyrics;
      }

      // 音量ノーマライズ詳細情報の同期
      if (incoming.normalized !== undefined) merged.normalized = incoming.normalized;
      if (incoming.normalizedGainDb !== undefined) merged.normalizedGainDb = incoming.normalizedGainDb;
      if (incoming.originalRmsDb !== undefined) merged.originalRmsDb = incoming.originalRmsDb;
      if (incoming.targetRmsDb !== undefined) merged.targetRmsDb = incoming.targetRmsDb;
      if (incoming.originalPeakDb !== undefined) merged.originalPeakDb = incoming.originalPeakDb;

      // 評価・コメント・更新時刻
      if (incoming.rating !== undefined) merged.rating = incoming.rating;
      if (incoming.comments !== undefined) merged.comments = incoming.comments;
      if (incoming.userEditedAt) {
        merged.userEditedAt = Math.max(existing.userEditedAt || 0, incoming.userEditedAt || 0);
      }

      // artworkBlob は既存のものがあれば維持し、artworkDataUrl は送信元にあれば反映
      if (existing.artworkBlob instanceof Blob) {
        merged.artworkBlob = existing.artworkBlob;
      }
      if (incoming.artworkDataUrl !== undefined && !incoming.artworkDataUrl.startsWith("blob:")) {
        merged.artworkDataUrl = incoming.artworkDataUrl;
      } else if (existing.artworkDataUrl) {
        merged.artworkDataUrl = existing.artworkDataUrl;
      }

      // Google Drive 関連プロパティ
      if (incoming.driveFileId) merged.driveFileId = incoming.driveFileId;
      if (incoming.source) merged.source = incoming.source;

      tracksToPut.push({ track: merged });
      updatedCount++;
    } else {
      // 新規曲:
      // Google Drive 音源なら driveFileId を持つため、インポート先端末でもそのまま再生可能
      const newTrack = { ...incoming };
      delete newTrack.artworkBlob; // 破損した {} を除去
      if (newTrack.artworkDataUrl && newTrack.artworkDataUrl.startsWith("blob:")) {
        delete newTrack.artworkDataUrl;
      }
      if (!newTrack.updatedAt) {
        newTrack.updatedAt = newTrack.addedAt || Date.now();
      }
      tracksToPut.push({ track: newTrack });
      addedCount++;
    }
  }

  // 単一トランザクションで一括投入
  if (tracksToPut.length > 0) {
    await bulkPutTracks(tracksToPut);
  }

  // 4. deleteMissing オプションによる明示的削除（指定された場合のみ）
  if (deleteMissing) {
    for (const existing of existingTracks) {
      if (!incomingIds.has(existing.id)) {
        await deleteTrack(existing.id).catch(() => {});
        deletedCount++;
      }
    }
  }

  // 5. プレイリストの同期
  let playlistsCount = 0;
  if (Array.isArray(data.playlists)) {
    const existingPlaylists = await getAllPlaylists();
    const existingPlMap = new Map(existingPlaylists.map((p) => [p.id, p]));

    // Tombstone によるプレイリスト削除
    for (const tomb of allTombstones) {
      if (tomb.type === "playlist") {
        if (existingPlMap.has(tomb.id)) {
          await deletePlaylist(tomb.id).catch(() => {});
          existingPlMap.delete(tomb.id);
        }
      }
    }

    for (const pl of data.playlists) {
      if (!pl || !pl.id || !pl.name) continue;
      if (isTombstoned(pl.id, pl.updatedAt || pl.createdAt || 0)) continue;

      const curPl = existingPlMap.get(pl.id);
      if (!curPl || (pl.updatedAt || 0) >= (curPl.updatedAt || 0)) {
        await savePlaylist(pl);
        playlistsCount++;
      }
    }
  }

  // 6. 公開設定の引き継ぎ
  if (data.settings && typeof data.settings === "object") {
    const patch = {};
    if (data.settings.gdriveClientId) patch.gdriveClientId = data.settings.gdriveClientId;
    if (typeof data.settings.gdriveAutoCache === "boolean") patch.gdriveAutoCache = data.settings.gdriveAutoCache;
    if (data.settings.customInvidiousUrl) patch.customInvidiousUrl = data.settings.customInvidiousUrl;
    setPublic(patch);
  }

  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(
        new CustomEvent("music-player:library-synced", {
          detail: { updatedCount, addedCount, deletedCount, conflictsCount },
        })
      );
    }
  } catch (_) {}

  return {
    tracksCount: data.tracks.length,
    updatedCount,
    addedCount,
    playlistsCount,
    deletedCount,
    conflictsCount,
  };
}

/**
 * Google Drive 上の同期ファイルの情報を取得
 * @returns {Promise<{ exists: boolean, modifiedTime?: string, size?: number, id?: string }>}
 */
export async function getDriveSyncFileInfo() {
  const connected = await isDriveConnected();
  if (!connected) return { exists: false };

  try {
    let folderId = null;
    try {
      folderId = await getOrCreateDriveFolder("MUSIC-PLAYER");
    } catch (_) {}

    let file = null;
    if (folderId) {
      try {
        file = await findDriveFileByName(SYNC_FILE_NAME, folderId);
      } catch (_) {}
    }
    if (!file) {
      file = await findDriveFileByName(SYNC_FILE_NAME, null);
    }

    if (file) {
      return {
        exists: true,
        id: file.id,
        modifiedTime: file.modifiedTime,
        size: file.size,
      };
    }
  } catch (e) {
    console.warn("[sync-service] Drive同期ファイル情報取得失敗:", e);
  }

  return { exists: false };
}

/**
 * Google Drive へライブラリの最新データを保存（クラウド書き出し）
 * @returns {Promise<{ id: string, modifiedTime: string, tracksCount: number, playlistsCount: number }>}
 */
export async function exportLibraryToDrive() {
  const connected = await isDriveConnected();
  if (!connected) {
    throw new Error("Google Drive に接続されていません。設定画面から接続してください。");
  }

  const exportObj = await exportLibraryData();
  const jsonStr = JSON.stringify(exportObj, null, 2);

  const res = await saveOrUpdateDriveSyncFile(SYNC_FILE_NAME, jsonStr, "MUSIC-PLAYER");

  return {
    id: res.id,
    modifiedTime: res.modifiedTime,
    tracksCount: exportObj.tracksCount,
    playlistsCount: exportObj.playlistsCount,
  };
}

/**
 * Google Drive から同期データを読み込み、ライブラリへ差分反映（クラウド読み込み）
 * @param {object} [opts]
 * @param {boolean} [opts.deleteMissing=false]
 * @returns {Promise<{ tracksCount: number, updatedCount: number, addedCount: number, playlistsCount: number, deletedCount: number, conflictsCount: number, modifiedTime?: string }>}
 */
export async function importLibraryFromDrive({ deleteMissing = false } = {}) {
  const connected = await isDriveConnected();
  if (!connected) {
    throw new Error("Google Drive に接続されていません。設定画面から接続してください。");
  }

  let folderId = null;
  try {
    folderId = await getOrCreateDriveFolder("MUSIC-PLAYER");
  } catch (_) {}

  let file = null;
  if (folderId) {
    try {
      file = await findDriveFileByName(SYNC_FILE_NAME, folderId);
    } catch (_) {}
  }
  if (!file) {
    file = await findDriveFileByName(SYNC_FILE_NAME, null);
  }

  if (!file || !file.id) {
    throw new Error("Google Drive 上に同期ファイルが見つかりません。先に iPad 等から「Google Drive へ書き出し」を実行してください。");
  }

  const jsonText = await fetchDriveTextFile(file.id);
  const result = await importLibraryData(jsonText, { deleteMissing });

  return {
    ...result,
    modifiedTime: file.modifiedTime,
  };
}

const STORAGE_KEY_LAST_SYNC = "music_player_last_sync_time";
const STORAGE_KEY_LAST_MODIFIED = "music_player_last_modified_time";
const STORAGE_KEY_DIRTY = "music_player_sync_dirty";

/**
 * ライブラリに変更があったことを記録（タイムスタンプ更新 ＆ 自動同期トリガー）
 */
export function recordLibraryModified() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY_LAST_MODIFIED, new Date().toISOString());
      localStorage.setItem(STORAGE_KEY_DIRTY, "true");
    }
  } catch {}
  scheduleDebouncedAutoUpload();
}

/**
 * 変更未同期フラグをクリア
 */
export function clearLibraryDirty() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY_DIRTY);
    }
  } catch {}
}

/**
 * 未同期の変更があるか判定
 * @returns {boolean}
 */
export function isLibraryDirty() {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(STORAGE_KEY_DIRTY) === "true";
    }
  } catch {}
  return false;
}

/**
 * 最終同期時刻を取得
 * @returns {string|null}
 */
export function getLastSyncTime() {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(STORAGE_KEY_LAST_SYNC) || null;
    }
  } catch {}
  return null;
}

/**
 * 最終同期時刻を更新
 * @param {string} [timeStr]
 */
export function setLastSyncTime(timeStr) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY_LAST_SYNC, timeStr || new Date().toISOString());
    }
  } catch {}
}

/**
 * 最終ローカル編集時刻を取得
 * @returns {string|null}
 */
export function getLastLocalModifiedTime() {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(STORAGE_KEY_LAST_MODIFIED) || null;
    }
  } catch {}
  return null;
}

// 同期処理の重複実行防止ロック（Mutex）
let _activeSyncPromise = null;

// 自動アップロード用の debounce タイマー
let _debounceTimer = null;
const DEBOUNCE_DELAY_MS = 6000; // 変更後6秒待ってから自動アップロード

/**
 * 変更発生時に遅延して自動アップロードをスケジュール
 * @param {number} [delayMs]
 */
export function scheduleDebouncedAutoUpload(delayMs = DEBOUNCE_DELAY_MS) {
  if (typeof window === "undefined") return;
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
  }
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    // オフラインの場合はエラーを出さず、オンライン復帰時に実行する
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return;
    }
    syncLibraryWithDrive({ force: false, silent: true }).catch((err) => {
      console.warn("[sync-service] 自動同期アップロード待機/スキップ:", err && err.message);
    });
  }, delayMs);
}

/**
 * Google Drive とライブラリの双方向スマート完全同期
 *
 * iPad と iPhone などの複数端末間で、Google Drive 上の同期ファイルとローカルライブラリを比較・同期。
 * 排他制御（Mutex）により、複数箇所の同時実行や自動同期と手動同期の衝突を防止し、直列化する。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - 手動同期ボタン等で即時双方向フル同期する場合
 * @param {boolean} [opts.silent=false] - エラー時に例外を投げずステータス返却する場合
 * @returns {Promise<{ action: "full-sync" | "downloaded" | "uploaded" | "synced" | "none", updatedCount?: number, addedCount?: number, playlistsCount?: number, deletedCount?: number, conflictsCount?: number, message: string }>}
 */
export function syncLibraryWithDrive({ force = false, silent = false } = {}) {
  // 既に同期処理が進行中の場合は、その完了を待ってから直列実行する（直列化排他制御）
  if (_activeSyncPromise) {
    return _activeSyncPromise.then(() => {
      return executeSync({ force, silent });
    });
  }

  _activeSyncPromise = executeSync({ force, silent }).finally(() => {
    _activeSyncPromise = null;
  });

  return _activeSyncPromise;
}

async function executeSync({ force = false, silent = false } = {}) {
  // オフライン時のガード
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (silent) return { action: "none", message: "オフラインのため同期をスキップしました" };
    throw new Error("オフラインのため Google Drive と同期できません。インターネット接続を確認してください。");
  }

  const connected = await isDriveConnected();
  if (!connected) {
    if (silent) return { action: "none", message: "Google Drive 未接続" };
    throw new Error("Google Drive に接続されていません。設定画面から接続してください。");
  }

  const driveFile = await getDriveSyncFileInfo();

  // ケース 1: Drive 上にまだ同期ファイルがない場合 → ローカルデータを初回アップロード
  if (!driveFile.exists) {
    const res = await exportLibraryToDrive();
    setLastSyncTime(res.modifiedTime || new Date().toISOString());
    clearLibraryDirty();
    return {
      action: "uploaded",
      message: `Google Drive に初回同期データを保存しました (${res.tracksCount} 曲)`,
      tracksCount: res.tracksCount,
      playlistsCount: res.playlistsCount,
    };
  }

  const driveModifiedMs = driveFile.modifiedTime ? new Date(driveFile.modifiedTime).getTime() : 0;
  const lastSyncStr = getLastSyncTime();
  const lastSyncMs = lastSyncStr ? new Date(lastSyncStr).getTime() : 0;
  const lastLocalModStr = getLastLocalModifiedTime();
  const lastLocalModMs = lastLocalModStr ? new Date(lastLocalModStr).getTime() : 0;
  const isDirty = isLibraryDirty();

  // force: true の場合、または Drive 側がローカル同期時刻より新しい場合
  if (force || driveModifiedMs > lastSyncMs) {
    // まず Drive から最新データを取得してマージ
    const importRes = await importLibraryFromDrive({ deleteMissing: false });

    // force の場合、またはローカル側でも同期以降に変更があった場合は Drive へ再書き出ししてクラウドも最新状態に完全同期
    const shouldReExport = force || (lastLocalModMs > lastSyncMs) || isDirty || (importRes.addedCount > 0) || (importRes.deletedCount > 0);
    let exportRes = null;
    if (shouldReExport) {
      exportRes = await exportLibraryToDrive();
      setLastSyncTime(exportRes.modifiedTime || new Date().toISOString());
      clearLibraryDirty();
    } else {
      setLastSyncTime(driveFile.modifiedTime || new Date().toISOString());
      clearLibraryDirty();
    }

    const conflictMsg = importRes.conflictsCount > 0 ? ` (⚠️ ${importRes.conflictsCount}件の競合)` : "";
    return {
      action: shouldReExport ? "full-sync" : "downloaded",
      updatedCount: importRes.updatedCount,
      addedCount: importRes.addedCount,
      playlistsCount: importRes.playlistsCount,
      deletedCount: importRes.deletedCount,
      conflictsCount: importRes.conflictsCount,
      message: `${importRes.updatedCount} 曲を更新、${importRes.addedCount} 曲を追加、${importRes.deletedCount || 0} 曲を削除同期しました${conflictMsg}${shouldReExport ? " (Google Drive にも完全同期)" : ""}`,
    };
  }

  // Drive 側は更新されていないが、ローカルで変更がある場合 → アップロード
  if (lastLocalModMs > lastSyncMs || isDirty) {
    const res = await exportLibraryToDrive();
    setLastSyncTime(res.modifiedTime || new Date().toISOString());
    clearLibraryDirty();
    return {
      action: "uploaded",
      message: `変更されたライブラリデータを Google Drive へ保存しました (${res.tracksCount} 曲)`,
      tracksCount: res.tracksCount,
      playlistsCount: res.playlistsCount,
    };
  }

  // どちらも更新なし
  return {
    action: "synced",
    message: "ライブラリは最新の状態です",
  };
}

// ライフサイクル連携: オンライン復帰時に未同期の変更があれば自動同期
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", () => {
    if (isLibraryDirty()) {
      scheduleDebouncedAutoUpload(2000);
    }
  });

  // バックグラウンド移行直前に未同期の変更があれば同期をキック
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && isLibraryDirty()) {
        scheduleDebouncedAutoUpload(0);
      }
    });
  }
}
