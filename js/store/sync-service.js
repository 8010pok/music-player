/**
 * 端末間ライブラリ同期・バックアップサービス
 *
 * - iPad ↔ iPhone などの端末間でライブラリ（曲情報、メモ、Google Drive音源リンク、プレイリスト、お気に入り等）を同期
 * - Google Drive クラウド自動同期: ワンタップで Google Drive 経由で iPad ↔ iPhone 間を同期
 * - iOS Web Share API (AirDrop / iCloud Drive / ファイル共有) によるオフライン同期にも対応
 * - 既存の曲の音源Blobやジャケット画像を破壊せず、変更されたメタデータ（曲名、メモ等）をスマートにマージ
 */

import { getAllTracks, putTrack, getAllPlaylists, savePlaylist, updateTrack, deleteTrack } from "./library-db.js";
import { getPublic, setPublic } from "./settings.js";
import {
  isDriveConnected,
  saveOrUpdateDriveSyncFile,
  findDriveFileByName,
  fetchDriveTextFile,
  getOrCreateDriveFolder,
} from "../gdrive/drive-service.js";
import { findDuplicateInList } from "./dedup-service.js";

const SYNC_FILE_NAME = "music-player-library-sync.json";

/**
 * ライブラリ全体のデータを JSON オブジェクトとしてエクスポート
 * (artworkBlob などのバイナリは JSON 破損防止のため除外し、メタデータを完全保持)
 * @returns {Promise<object>}
 */
export async function exportLibraryData() {
  const tracks = await getAllTracks();
  const playlists = await getAllPlaylists();
  const pub = getPublic();

  // artworkBlob (Blob) は JSON.stringify できないため除外し、メタデータを完全コピー
  const cleanTracks = tracks.map((t) => {
    const copy = { ...t };
    delete copy.artworkBlob;
    return copy;
  });

  return {
    app: "music-player",
    version: 2,
    exportedAt: new Date().toISOString(),
    tracksCount: cleanTracks.length,
    playlistsCount: playlists.length,
    tracks: cleanTracks,
    playlists,
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
      if (e.name === "AbortError") {
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
 * @returns {Promise<{ tracksCount: number, updatedCount: number, addedCount: number, playlistsCount: number, deletedCount: number }>}
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

  const existingTracks = await getAllTracks();
  const existingMap = new Map(existingTracks.map((t) => [t.id, t]));

  let updatedCount = 0;
  let addedCount = 0;
  const incomingIds = new Set();

  for (const incoming of data.tracks) {
    if (!incoming || !incoming.id) continue;
    incomingIds.add(incoming.id);

    let existing = existingMap.get(incoming.id);
    if (!existing) {
      // ID が異なっていても、タイトル・アーティスト・時間の一致する曲を既存から探す
      const dup = findDuplicateInList(incoming, existingTracks);
      if (dup) {
        existing = dup;
      }
    }

    if (existing) {
      // 既存曲がある場合: iPad/送信元で変更されたメタデータを安全にマージ！
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
        enabled: incoming.enabled !== undefined ? incoming.enabled : existing.enabled,
        playCount: Math.max(existing.playCount || 0, incoming.playCount || 0),
        lastPlayedAt: Math.max(existing.lastPlayedAt || 0, incoming.lastPlayedAt || 0),
      };

      // 歌詞も同期
      if (incoming.lyrics) {
        merged.lyrics = incoming.lyrics;
      }

      // 音量ノーマライズ情報の同期
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
      if (incoming.artworkDataUrl !== undefined) {
        merged.artworkDataUrl = incoming.artworkDataUrl;
      } else if (existing.artworkDataUrl) {
        merged.artworkDataUrl = existing.artworkDataUrl;
      }

      // Google Drive 関連プロパティ
      if (incoming.driveFileId) merged.driveFileId = incoming.driveFileId;
      if (incoming.source) merged.source = incoming.source;

      await putTrack(merged, null);
      updatedCount++;
    } else {
      // 新規曲:
      // Google Drive 音源なら driveFileId を持つため、インポート先端末でもそのまま再生可能
      const newTrack = { ...incoming };
      delete newTrack.artworkBlob; // 破損した {} を除去
      await putTrack(newTrack, null);
      addedCount++;
    }
  }

  // 削除の同期 (オプション)
  let deletedCount = 0;
  if (deleteMissing) {
    for (const existing of existingTracks) {
      if (!incomingIds.has(existing.id)) {
        await deleteTrack(existing.id).catch(() => {});
        deletedCount++;
      }
    }
  }

  // プレイリストの同期
  let playlistsCount = 0;
  if (Array.isArray(data.playlists)) {
    for (const pl of data.playlists) {
      if (!pl || !pl.id || !pl.name) continue;
      await savePlaylist(pl);
      playlistsCount++;
    }
  }

  // 設定の引き継ぎ
  if (data.settings && typeof data.settings === "object") {
    const patch = {};
    if (data.settings.gdriveClientId) patch.gdriveClientId = data.settings.gdriveClientId;
    if (typeof data.settings.gdriveAutoCache === "boolean") patch.gdriveAutoCache = data.settings.gdriveAutoCache;
    if (data.settings.customInvidiousUrl) patch.customInvidiousUrl = data.settings.customInvidiousUrl;
    setPublic(patch);
  }

  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("music-player:library-synced", {
        detail: { updatedCount, addedCount, deletedCount },
      }));
    }
  } catch (_) {}

  return {
    tracksCount: data.tracks.length,
    updatedCount,
    addedCount,
    playlistsCount,
    deletedCount,
  };
}

/**
 * Google Drive 上の同期ファイルの情報を取得
 * @returns {Promise<{ exists: boolean, modifiedTime?: string, size?: number }>}
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
 * @returns {Promise<{ tracksCount: number, updatedCount: number, addedCount: number, playlistsCount: number, deletedCount: number, modifiedTime?: string }>}
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

/**
 * ライブラリに変更があったことを記録（タイムスタンプ更新）
 */
export function recordLibraryModified() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY_LAST_MODIFIED, new Date().toISOString());
    }
  } catch {}
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

/**
 * Google Drive とライブラリの双方向スマート自動同期
 *
 * iPad と iPhone などの複数端末間で、Google Drive 上の同期ファイルとローカルライブラリを比較・同期。
 * - force: true の場合（「ワンタップ自動同期」ボタン）:
 *   1. Drive 上に同期ファイルがあればダウンロードして差分マージ（他端末での編集内容を即座に受信）
 *   2. マージ後のライブラリ全体を Drive に再保存（この端末の最新状態をクラウドにアップロード）
 *   3. 最終同期時刻を更新
 * - force: false の場合（起動時などのバックグラウンド自動判定）:
 *   1. Drive 上のファイルの modifiedTime とローカルの lastSyncTime を比較
 *   2. Drive の方が新しければダウンロード＆マージ。ローカルも変更されていればマージ後に再保存。
 *   3. ローカルのみが新しければ Drive へアップロード。
 *   4. どちらも変化がなければ何もしない（synced）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]
 * @param {boolean} [opts.silent=false]
 * @returns {Promise<{ action: "full-sync" | "downloaded" | "uploaded" | "synced" | "none", updatedCount?: number, addedCount?: number, playlistsCount?: number, message: string }>}
 */
export async function syncLibraryWithDrive({ force = false, silent = false } = {}) {
  const connected = await isDriveConnected();
  if (!connected) {
    if (silent) return { action: "none", message: "Google Drive 未接続" };
    throw new Error("Google Drive に接続されていません。設定画面から接続してください。");
  }

  const driveFile = await getDriveSyncFileInfo();

  // ケース 1: Drive 上にまだ同期ファイルがない場合 → ローカルデータを新規アップロード
  if (!driveFile.exists) {
    const res = await exportLibraryToDrive();
    setLastSyncTime(res.modifiedTime || new Date().toISOString());
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

  // force: true の場合、または Drive 側がローカル同期時刻より新しい場合
  if (force || driveModifiedMs > lastSyncMs) {
    // まず Drive から最新データを取得してマージ
    const importRes = await importLibraryFromDrive({ deleteMissing: false });

    // force の場合、またはローカル側でも同期以降に変更があった場合は Drive へ再書き出しして完全一致
    const shouldReExport = force || (lastLocalModMs > lastSyncMs) || (importRes.addedCount > 0);
    let exportRes = null;
    if (shouldReExport) {
      exportRes = await exportLibraryToDrive();
      setLastSyncTime(exportRes.modifiedTime || new Date().toISOString());
    } else {
      setLastSyncTime(driveFile.modifiedTime || new Date().toISOString());
    }

    return {
      action: shouldReExport ? "full-sync" : "downloaded",
      updatedCount: importRes.updatedCount,
      addedCount: importRes.addedCount,
      playlistsCount: importRes.playlistsCount,
      message: `${importRes.updatedCount} 曲の変更を反映、${importRes.addedCount} 曲を追加しました${shouldReExport ? " (Google Drive にも最新状態を保存)" : ""}`,
    };
  }

  // Drive 側は更新されていないが、ローカルで変更がある場合 → アップロード
  if (lastLocalModMs > lastSyncMs) {
    const res = await exportLibraryToDrive();
    setLastSyncTime(res.modifiedTime || new Date().toISOString());
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

