/**
 * LRCLIB (https://lrclib.net) オンライン歌詞取得サービス
 *
 * - 無料・API キー不要・CORS 対応
 * - 同期歌詞 (LRC / syncedLyrics) および プレーン歌詞 (plainLyrics) を取得
 * - 曲名・アーティスト名で検索し、既存の parseLrc で正規化
 */

import { parseLrc } from "./lyrics.js";

// メモリ内キャッシュ (セッション中の同一曲の重複フェッチ防止)
const lyricsCache = new Map();

/**
 * 検索用の曲名をクリーンアップ
 * - 末尾の拡張子 (.flac, .mp3, etc.)
 * - (Remastered), (Official Video), [feat. xxx] 等の補助表記を除去
 */
export function cleanTitleForLyrics(title) {
  if (!title || typeof title !== "string") return "";
  return title
    .replace(/\.[a-zA-Z0-9]{2,4}$/, "")
    .replace(/\s*[\(\[](?:feat\.|remaster(?:ed)?|official|version|audio|video|explicit|bonus|live)[^\)\]]*[\)\]]/gi, "")
    .replace(/^[0-9]+[.\-\s]+/, "") // 先頭の "01 - " や "01. " を除去
    .trim();
}

/**
 * 検索用のアーティスト名をクリーンアップ
 */
export function cleanArtistForLyrics(artist) {
  if (!artist || typeof artist !== "string") return "";
  const a = artist.trim();
  if (a === "(Google Drive)" || a === "(不明)" || a === "Unknown Artist") return "";
  return a
    .replace(/\s*[\(\[](?:feat\.|official)[^\)\]]*[\)\]]/gi, "")
    .trim();
}

/**
 * LRCLIB から歌詞を取得する
 *
 * @param {object} param
 * @param {string} param.title - 曲名
 * @param {string} [param.artist] - アーティスト名
 * @param {string} [param.album] - アルバム名
 * @param {number} [param.duration] - 再生時間(秒)
 * @returns {Promise<{ synced: Array<{timeMs: number, text: string}>|null, unsynced: string|null }|null>}
 */
export async function fetchOnlineLyrics({ title, artist, album, duration } = {}) {
  const cTitle = cleanTitleForLyrics(title);
  const cArtist = cleanArtistForLyrics(artist);
  if (!cTitle) return null;

  const cacheKey = `${cArtist.toLowerCase()}|||${cTitle.toLowerCase()}`;
  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  // 1. /api/get によるピンポイント取得 (最も高速・正確)
  try {
    const params = new URLSearchParams({ track_name: cTitle });
    if (cArtist) params.set("artist_name", cArtist);
    if (album && album !== "(Google Drive)" && album !== "(不明)") {
      params.set("album_name", album);
    }
    if (duration && duration > 0) {
      params.set("duration", Math.round(duration).toString());
    }

    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
      const unsynced = data.plainLyrics || null;
      if (synced || unsynced) {
        const result = { synced, unsynced };
        lyricsCache.set(cacheKey, result);
        return result;
      }
    }
  } catch (e) {
    // ネットワーク一時エラー等は検索へフォールバック
  }

  // 2. /api/get を曲名＋アーティスト名のみで再試行 (アルバム名・duration 誤差の救済)
  if (album || duration) {
    try {
      const params = new URLSearchParams({ track_name: cTitle });
      if (cArtist) params.set("artist_name", cArtist);
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
        const unsynced = data.plainLyrics || null;
        if (synced || unsynced) {
          const result = { synced, unsynced };
          lyricsCache.set(cacheKey, result);
          return result;
        }
      }
    } catch (e) {}
  }

  // 3. /api/search によるあいまい検索
  try {
    const q = cArtist ? `${cArtist} ${cTitle}` : cTitle;
    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0) {
        // 同期歌詞 (syncedLyrics) を持っている候補を最優先
        const candidate = items.find((x) => x.syncedLyrics) || items[0];
        const synced = candidate.syncedLyrics ? parseLrc(candidate.syncedLyrics) : null;
        const unsynced = candidate.plainLyrics || null;
        if (synced || unsynced) {
          const result = { synced, unsynced };
          lyricsCache.set(cacheKey, result);
          return result;
        }
      }
    }
  } catch (e) {}

  lyricsCache.set(cacheKey, null);
  return null;
}
