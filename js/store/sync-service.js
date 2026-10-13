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

    const existing = existingMap.get(incoming.id);

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

      // artworkBlob は既存のものがあれば維持
      if (existing.artworkBlob instanceof Blob) {
        merged.artworkBlob = existing.artworkBlob;
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
    const folderId = await getOrCreateDriveFolder("MUSIC-PLAYER");
    const file = await findDriveFileByName(SYNC_FILE_NAME, folderId);
    if (file) {
      return {
        exists: true,
        id: file.id,
        modifiedTime: file.modifiedTime,
        size: file.size,
      };
    }
    // ルートフォルダも検索
    const rootFile = await findDriveFileByName(SYNC_FILE_NAME, null);
    if (rootFile) {
      return {
        exists: true,
        id: rootFile.id,
        modifiedTime: rootFile.modifiedTime,
        size: rootFile.size,
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

  const folderId = await getOrCreateDriveFolder("MUSIC-PLAYER");
  let file = await findDriveFileByName(SYNC_FILE_NAME, folderId);
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
