/**
 * 端末間ライブラリ同期・バックアップサービス
 *
 * - iPad ↔ iPhone などの端末間でライブラリ（曲情報、Google Drive音源リンク、プレイリスト、お気に入り等）を同期
 * - iOS Web Share API (AirDrop / iCloud Drive / ファイル共有) に対応
 * - Google Drive 音源は曲 ID (gd-xxx) と Google Drive fileId を引き継ぐため、
 *   インポート先端末でもそのままストリーミング＆キャッシュ再生が可能
 */

import { getAllTracks, putTrack, getAllPlaylists, savePlaylist } from "./library-db.js";
import { getPublic, setPublic } from "./settings.js";

/**
 * ライブラリ全体のデータを JSON オブジェクトとしてエクスポート
 * @returns {Promise<object>}
 */
export async function exportLibraryData() {
  const tracks = await getAllTracks();
  const playlists = await getAllPlaylists();
  const pub = getPublic();

  return {
    app: "music-player",
    version: 1,
    exportedAt: new Date().toISOString(),
    tracksCount: tracks.length,
    playlistsCount: playlists.length,
    tracks,
    playlists,
    settings: {
      gdriveClientId: pub.gdriveClientId || "",
      gdriveAutoCache: pub.gdriveAutoCache !== false,
      theme: pub.theme || "system",
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
 * @param {string|object} input
 * @returns {Promise<{ tracksCount: number, playlistsCount: number }>}
 */
export async function importLibraryData(input) {
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

  let tracksCount = 0;
  for (const track of data.tracks) {
    if (!track || !track.id) continue;
    // トラックメタデータを upsert (Google Drive 音源は driveFileId を持つため blob は null で登録し、再生時に取得)
    await putTrack(track, null);
    tracksCount++;
  }

  let playlistsCount = 0;
  if (Array.isArray(data.playlists)) {
    for (const pl of data.playlists) {
      if (!pl || !pl.id || !pl.name) continue;
      await savePlaylist(pl);
      playlistsCount++;
    }
  }

  // 設定の引き継ぎ (Client ID や キャッシュ設定)
  if (data.settings && typeof data.settings === "object") {
    const patch = {};
    if (data.settings.gdriveClientId) patch.gdriveClientId = data.settings.gdriveClientId;
    if (typeof data.settings.gdriveAutoCache === "boolean") patch.gdriveAutoCache = data.settings.gdriveAutoCache;
    setPublic(patch);
  }

  return { tracksCount, playlistsCount };
}
