/**
 * 重複楽曲検出・統合・クリーンアップサービス
 *
 * - ライブラリ追加時（YouTube、ファイル、Google Drive）に重複曲の二重保存を防止
 * - 既存ライブラリ内の重複曲を安全にマージ（メモ、お気に入り、再生回数、歌詞を保護）して削除
 * - プレイリスト内の参照を自動置換
 */

import { getAllTracks, putTrack, updateTrack, deleteTrack, getAllPlaylists, savePlaylist } from "./library-db.js";
import { releaseArtwork } from "../ui/artwork-cache.js";
import { appState } from "../state.js";

/**
 * 比較用に文字列を正規化
 * - 全角・半角統一 (NFKC)
 * - 小文字化
 * - 括弧付きタグ [Official Video], (MV), (Live) などの除去
 * - 記号や余分な空白の除去
 */
export function normalizeTrackString(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .normalize("NFKC")
    .toLowerCase()
    // 括弧内の装飾テキスト [Official Video], (Lyric Video), (MV), 【公式】 等を除去
    .replace(/[\[\(\{\<【〔〈（［｛][^\]\)\}\>】〕〉）］\}]*[\]\)\}\>】〕〉）］\}]/g, " ")
    // 特殊記号や区切り文字を空白に変換
    .replace(/[_\-\/\|:：・,，.。]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 2つのトラックが同一曲（重複）かどうかを判定
 *
 * 判定基準:
 * 1. 同一 ID の場合 -> 一致
 * 2. 同一 Google Drive ファイルID の場合 -> 一致
 * 3. 同一ファイル名かつ同一ファイルサイズ (>0) の場合 -> 一致
 * 4. メタデータ比較:
 *    - タイトルとアーティストの正規化文字列が完全一致
 *    - かつ、両方に再生時間（duration）がある場合は差が4秒以内（無音部やエンコード差異を許容）
 *      （大幅に再生時間が違う場合は別バージョン・同名異曲と判断して重複とみなさない）
 */
export function areTracksDuplicate(trackA, trackB) {
  if (!trackA || !trackB) return false;
  if (trackA.id === trackB.id) return true;

  // Google Drive 同一ファイル
  if (trackA.driveFileId && trackB.driveFileId && trackA.driveFileId === trackB.driveFileId) {
    return true;
  }

  // 同一ファイル名 & サイズ
  if (
    trackA.originalName &&
    trackB.originalName &&
    trackA.fileSize &&
    trackB.fileSize &&
    trackA.fileSize > 0 &&
    trackA.originalName === trackB.originalName &&
    trackA.fileSize === trackB.fileSize
  ) {
    return true;
  }

  const titleA = normalizeTrackString(trackA.title);
  const titleB = normalizeTrackString(trackB.title);
  if (!titleA || !titleB || titleA !== titleB) return false;

  const artistA = normalizeTrackString(trackA.artist);
  const artistB = normalizeTrackString(trackB.artist);

  // アーティスト名のチェック（不明の場合はタイトル一致を重く見る）
  const isUnknownA = !artistA || artistA === "不明" || artistA === "unknown" || artistA === "不明アーティスト";
  const isUnknownB = !artistB || artistB === "不明" || artistB === "unknown" || artistB === "不明アーティスト";

  if (!isUnknownA && !isUnknownB && artistA !== artistB) {
    return false;
  }

  // 再生時間のチェック（両方に有効な duration がある場合、4秒以上の開きがあれば同名別曲の可能性が高い）
  const durA = Number(trackA.duration) || 0;
  const durB = Number(trackB.duration) || 0;
  if (durA > 0 && durB > 0) {
    const diff = Math.abs(durA - durB);
    if (diff > 4) {
      return false;
    }
  }

  return true;
}

/**
 * リストの中から target と重複するトラックを1件検索
 * @param {object} target
 * @param {Array<object>} list
 * @returns {object|null}
 */
export function findDuplicateInList(target, list) {
  if (!target || !Array.isArray(list)) return null;
  for (const item of list) {
    if (item.id === target.id) continue;
    if (areTracksDuplicate(target, item)) {
      return item;
    }
  }
  return null;
}

/**
 * トラックの「品質・優先度スコア」を算出
 * 重複した2曲のうち、どちらを残すべきかを決定する
 */
export function scoreTrackQuality(track) {
  let score = 0;
  // 1. ローカル音源（IndexedDBに本体Blobがある、オフライン再生可能）
  if (track.source !== "gdrive" && !String(track.id).startsWith("gd-")) {
    score += 100;
  }
  // 2. キャッシュ済み
  if (track.cached) {
    score += 40;
  }
  // 3. ユーザーが手動編集したメタデータ
  if (track.userEdited) {
    score += 30;
  }
  // 4. メモが入力されている
  if (track.memo && track.memo.trim()) {
    score += 25;
  }
  // 5. お気に入り (loved)
  if (track.loved) {
    score += 15;
  }
  // 6. 歌詞がある
  if (track.lyrics && track.lyrics.trim()) {
    score += 10;
  }
  // 7. アートワークがある
  if (track.artworkBlob) {
    score += 10;
  }
  // 8. 再生回数（最大20点）
  score += Math.min(track.playCount || 0, 20);

  return score;
}

/**
 * 全トラックの中から重複しているグループを抽出
 * @param {Array<object>} tracks
 * @returns {Array<{ primary: object, duplicates: Array<object>, all: Array<object> }>}
 */
export function findDuplicateGroups(tracks) {
  if (!Array.isArray(tracks) || tracks.length <= 1) return [];

  const visited = new Set();
  const groups = [];

  for (let i = 0; i < tracks.length; i++) {
    const tA = tracks[i];
    if (visited.has(tA.id)) continue;

    const cluster = [tA];
    for (let j = i + 1; j < tracks.length; j++) {
      const tB = tracks[j];
      if (visited.has(tB.id)) continue;

      if (areTracksDuplicate(tA, tB)) {
        cluster.push(tB);
        visited.add(tB.id);
      }
    }

    if (cluster.length > 1) {
      visited.add(tA.id);
      // スコアが最も高いトラックを primary（残す曲）にする
      cluster.sort((a, b) => {
        const diff = scoreTrackQuality(b) - scoreTrackQuality(a);
        if (diff !== 0) return diff;
        return (a.addedAt || 0) - (b.addedAt || 0); // スコア同じなら先に追加された方を優先
      });

      const primary = cluster[0];
      const duplicates = cluster.slice(1);
      groups.push({ primary, duplicates, all: cluster });
    }
  }

  return groups;
}

/**
 * 重複する2曲のメタデータを安全にマージして1曲を残し、もう1曲を削除する
 *
 * @param {object} primary - 残す側のトラック
 * @param {object} duplicate - 削除する側のトラック
 * @param {Array<object>} [playlists] - 全プレイリスト（省略時は内部で取得）
 * @returns {Promise<object>} 更新された primary トラック
 */
export async function mergeAndDeduplicate(primary, duplicate, playlists = null) {
  // メタデータ・情報のマージ（duplicate 側にしかない情報を primary に引き継ぐ）
  const patch = {};

  if (!primary.memo && duplicate.memo) {
    patch.memo = duplicate.memo;
    primary.memo = duplicate.memo;
  }
  if (!primary.loved && duplicate.loved) {
    patch.loved = true;
    primary.loved = true;
  }
  if (!primary.lyrics && duplicate.lyrics) {
    patch.lyrics = duplicate.lyrics;
    primary.lyrics = duplicate.lyrics;
  }
  if (!primary.artworkBlob && duplicate.artworkBlob) {
    patch.artworkBlob = duplicate.artworkBlob;
    primary.artworkBlob = duplicate.artworkBlob;
  }
  if (!primary.driveFileId && duplicate.driveFileId) {
    patch.driveFileId = duplicate.driveFileId;
    primary.driveFileId = duplicate.driveFileId;
  }
  if (!primary.userEdited && duplicate.userEdited) {
    patch.userEdited = true;
    primary.userEdited = true;
  }

  // 再生回数・最終再生日時は大きい方を採用
  const maxPlayCount = Math.max(primary.playCount || 0, duplicate.playCount || 0);
  if (maxPlayCount !== (primary.playCount || 0)) {
    patch.playCount = maxPlayCount;
    primary.playCount = maxPlayCount;
  }

  const maxLastPlayed = Math.max(primary.lastPlayedAt || 0, duplicate.lastPlayedAt || 0);
  if (maxLastPlayed !== (primary.lastPlayedAt || 0)) {
    patch.lastPlayedAt = maxLastPlayed;
    primary.lastPlayedAt = maxLastPlayed;
  }

  if (Object.keys(patch).length > 0) {
    await updateTrack(primary.id, patch);
  }

  // プレイリストの参照更新（duplicate.id を primary.id に置換）
  const allPl = playlists || (await getAllPlaylists().catch(() => []));
  for (const pl of allPl) {
    if (!Array.isArray(pl.trackIds)) continue;
    let modified = false;
    const newTrackIds = [];
    for (const tid of pl.trackIds) {
      if (tid === duplicate.id) {
        // 重複曲の参照を primary.id に差し替える（既に primary.id がある場合は重複させない）
        if (!newTrackIds.includes(primary.id)) {
          newTrackIds.push(primary.id);
        }
        modified = true;
      } else {
        newTrackIds.push(tid);
      }
    }
    if (modified) {
      pl.trackIds = newTrackIds;
      await savePlaylist(pl).catch(() => {});
    }
  }

  // 再生中トラックが削除対象だった場合は primary に切り替え
  const current = appState.get().currentTrack;
  if (current && current.id === duplicate.id) {
    appState.set({ currentTrack: primary });
  }

  // アートワークキャッシュ解放とトラック削除
  releaseArtwork(duplicate.id);
  await deleteTrack(duplicate.id);

  return primary;
}

/**
 * ライブラリ全体の重複楽曲を一括クリーンアップ
 *
 * @param {object} [opts]
 * @param {(progress: { current: number, total: number }) => void} [opts.onProgress]
 * @returns {Promise<{ groupsCount: number, removedCount: number }>}
 */
export async function cleanDuplicateTracks({ onProgress } = {}) {
  const tracks = await getAllTracks();
  const groups = findDuplicateGroups(tracks);

  if (groups.length === 0) {
    return { groupsCount: 0, removedCount: 0 };
  }

  const playlists = await getAllPlaylists().catch(() => []);
  let removedCount = 0;
  const totalDuplicates = groups.reduce((acc, g) => acc + g.duplicates.length, 0);

  for (const group of groups) {
    const primary = group.primary;
    for (const dup of group.duplicates) {
      await mergeAndDeduplicate(primary, dup, playlists);
      removedCount++;
      if (typeof onProgress === "function") {
        onProgress({ current: removedCount, total: totalDuplicates });
      }
    }
  }

  return {
    groupsCount: groups.length,
    removedCount,
  };
}
