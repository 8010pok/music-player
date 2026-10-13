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
    .replace(/\s*[\(\[（【「『](?:feat\.|remaster(?:ed)?|official|version|audio|video|explicit|bonus|live|mv|lyric|theme|op|ed)[^\)\]）】」』]*[\)\]）】」』]/gi, "")
    .replace(/^[0-9]+[.\-\s]+/, "") // 先頭の "01 - " や "01. " を除去
    .trim();
}

/**
 * 括弧やハイフン以降のサブタイトルを完全に削ぎ落としたコアタイトル
 */
export function stripParenthesesAndSubtitles(title) {
  if (!title || typeof title !== "string") return "";
  return title
    .replace(/\.[a-zA-Z0-9]{2,4}$/, "")
    .replace(/^[0-9]+[.\-\s]+/, "")
    .replace(/\s*[\(\[（【「『].*?[\)\]）】」』]/g, "") // 全角・半角カッコ全削除
    .replace(/\s*[-–—~〜].*$/, "") // ハイフンや波ダッシュ以降のサブタイトル全削除
    .replace(/^[0-9]+[.\-\s]+/, "")
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
    .replace(/\s*[\(\[（【](?:feat\.|official)[^\)\]）】]*[\)\]）】]/gi, "")
    .trim();
}

/**
 * コラボやフィーチャリングから第一（メイン）アーティストを抽出
 */
export function extractPrimaryArtist(artist) {
  if (!artist || typeof artist !== "string") return "";
  const c = cleanArtistForLyrics(artist);
  return c
    .split(/\s*(?:feat\.|ft\.|with|&|\/|×|,|、)\s*/i)[0]
    .replace(/\s*[\(\[（【].*?[\)\]）】]/g, "")
    .trim();
}

const LRCLIB_HEADERS = {
  "User-Agent": "MusicPlayer/1.0 (https://music-player.app)",
};

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

  const tryGet = async (t, a, alb, dur) => {
    try {
      const params = new URLSearchParams({ track_name: t });
      if (a) params.set("artist_name", a);
      if (alb && alb !== "(Google Drive)" && alb !== "(不明)") {
        params.set("album_name", alb);
      }
      if (dur && dur > 0) {
        params.set("duration", Math.round(dur).toString());
      }
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: LRCLIB_HEADERS,
      });
      if (res.ok) {
        const data = await res.json();
        const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
        const unsynced = data.plainLyrics || null;
        if (synced || unsynced) return { synced, unsynced };
      }
    } catch (_) {}
    return null;
  };

  const trySearch = async (queryText, preferArtist = "") => {
    try {
      const q = queryText.trim();
      if (!q) return null;
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
        headers: LRCLIB_HEADERS,
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items) && items.length > 0) {
          // アーティスト名指定がある場合、アーティスト名が一致・部分一致するものを優先
          let matched = items;
          if (preferArtist) {
            const pLower = preferArtist.toLowerCase();
            const artistMatches = items.filter((x) =>
              (x.artistName || "").toLowerCase().includes(pLower) || pLower.includes((x.artistName || "").toLowerCase())
            );
            if (artistMatches.length > 0) matched = artistMatches;
          }
          // 同期歌詞 (syncedLyrics) を持っている候補を最優先
          const candidate = matched.find((x) => x.syncedLyrics) || matched[0];
          const synced = candidate.syncedLyrics ? parseLrc(candidate.syncedLyrics) : null;
          const unsynced = candidate.plainLyrics || null;
          if (synced || unsynced) return { synced, unsynced };
        }
      }
    } catch (_) {}
    return null;
  };

  // 1. /api/get によるピンポイント取得 (アルバム・再生時間あり)
  let found = await tryGet(cTitle, cArtist, album, duration);
  if (found) {
    lyricsCache.set(cacheKey, found);
    return found;
  }

  // 2. /api/get を曲名＋アーティスト名のみで再試行 (アルバム名・duration 誤差の救済)
  if (album || duration) {
    found = await tryGet(cTitle, cArtist, null, null);
    if (found) {
      lyricsCache.set(cacheKey, found);
      return found;
    }
  }

  // 3. /api/search による通常テキストあいまい検索
  const searchQ = cArtist ? `${cArtist} ${cTitle}` : cTitle;
  found = await trySearch(searchQ, cArtist);
  if (found) {
    lyricsCache.set(cacheKey, found);
    return found;
  }

  // 4. カッコやサブタイトルを完全に削ぎ落としたベースタイトルでの多段階フォールバック
  const baseTitle = stripParenthesesAndSubtitles(title);
  const primaryArtist = extractPrimaryArtist(artist);
  if (baseTitle && (baseTitle !== cTitle || primaryArtist !== cArtist)) {
    // 4-1: ベースタイトル + プライマリアーティストでピンポイント
    if (primaryArtist) {
      found = await tryGet(baseTitle, primaryArtist, null, null);
      if (found) {
        lyricsCache.set(cacheKey, found);
        return found;
      }
    }
    // 4-2: ベースタイトル + アーティスト名であいまい検索
    const baseQ = primaryArtist ? `${primaryArtist} ${baseTitle}` : baseTitle;
    found = await trySearch(baseQ, primaryArtist || cArtist);
    if (found) {
      lyricsCache.set(cacheKey, found);
      return found;
    }
  }

  // 5. タイトル単体でのあいまい検索 (アーティスト表記揺れへの最終救済)
  const fallbackTitle = baseTitle || cTitle;
  if (fallbackTitle) {
    found = await trySearch(fallbackTitle, primaryArtist || cArtist);
    if (found) {
      lyricsCache.set(cacheKey, found);
      return found;
    }
  }

  lyricsCache.set(cacheKey, null);
  return null;
}
