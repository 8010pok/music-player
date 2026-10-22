/**
 * オンライン歌詞取得・マルチプロバイダ統合サービス (lrclib.js)
 *
 * - LRCLIB (https://lrclib.net): 高品質な同期歌詞 (LRC) & プレーン歌詞
 * - Lyrics.ovh: 洋楽・邦楽のプレーン歌詞フォールバック
 * - プチリリ (PetitLyrics) / 歌ネット (Uta-Net) / UtaTen / J-Lyric へのダイレクト検索連携
 * - アーティスト名・曲名・再生時間の厳格照合による「全く違う曲の歌詞」誤マッチの完全撲滅
 */

import { parseLrc } from "./lyrics.js";

// メモリ内キャッシュ (同一曲の重複フェッチ防止)
const lyricsCache = new Map();

/**
 * 検索用の曲名をクリーンアップ
 * - 末尾の拡張子 (.flac, .mp3, etc.)
 * - (Remastered), (Official Video), [feat. xxx], (TV Size), [OP], [ED] 等の補助表記を除去
 */
export function cleanTitleForLyrics(title) {
  if (!title || typeof title !== "string") return "";
  return title
    .replace(/\.[a-zA-Z0-9]{2,4}$/, "")
    .replace(/\s*[\(\[（【「『](?:feat\.|remaster(?:ed)?|official|version|audio|video|explicit|bonus|live|mv|lyric|theme|op|ed|tv\s*(?:size|ver\.?)|anime|short\s*ver\.?)[^\)\]）】」』]*[\)\]）】」』]/gi, "")
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
    .replace(/\s*[-–—~〜:：].*$/, "") // ハイフンや波ダッシュ以降のサブタイトル全削除
    .replace(/^[0-9]+[.\-\s]+/, "")
    .trim();
}

/**
 * 検索用のアーティスト名をクリーンアップ
 */
export function cleanArtistForLyrics(artist) {
  if (!artist || typeof artist !== "string") return "";
  const a = artist.trim();
  if (
    a === "(Google Drive)" ||
    a === "(不明)" ||
    a === "(不明アーティスト)" ||
    a === "Unknown Artist" ||
    a.toLowerCase() === "music" ||
    a.toLowerCase() === "download"
  ) {
    return "";
  }
  return a
    .replace(/\s*[\(\[（【](?:feat\.|official|cv[:：])[^\)\]）】]*[\)\]）】]/gi, "")
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

/**
 * アーティスト名の一致・類似性を厳格に照合（ミスマッチ誤判定の完全防止）
 * @param {string} candidateArtist
 * @param {string} expectedArtist
 * @returns {boolean}
 */
export function isArtistMatch(candidateArtist, expectedArtist) {
  if (!expectedArtist || !expectedArtist.trim()) return true; // アーティスト指定なしの場合は許可
  if (!candidateArtist || !candidateArtist.trim()) return false;

  const normalize = (s) =>
    s
      .toLowerCase()
      .replace(/[\s\-_・/／\\()（）[\]「」『』feat.ft.with×,、&・:：'"]+/gi, "")
      .trim();

  const cNorm = normalize(candidateArtist);
  const eNorm = normalize(expectedArtist);

  if (!cNorm || !eNorm) return false;
  if (cNorm === eNorm) return true;

  // 包含関係（メインアーティストとコラボ表記など）
  if (cNorm.includes(eNorm) || eNorm.includes(cNorm)) return true;

  return false;
}

/**
 * 曲名の一致・類似性を照合
 * @param {string} candidateTitle
 * @param {string} expectedTitle
 * @returns {boolean}
 */
export function isTitleMatch(candidateTitle, expectedTitle) {
  if (!candidateTitle || !expectedTitle) return false;

  const normalize = (s) =>
    s
      .toLowerCase()
      .replace(/\s*[\(\[（【「『].*?[\)\]）】」』]/g, "")
      .replace(/[\s\-_・/／\\~〜!！?？:：'"]+/g, "")
      .trim();

  const cNorm = normalize(candidateTitle);
  const eNorm = normalize(expectedTitle);

  if (!cNorm || !eNorm) return false;
  if (cNorm === eNorm) return true;

  if (cNorm.includes(eNorm) || eNorm.includes(cNorm)) return true;

  return false;
}

/**
 * 再生時間（曲長）が許容誤差（デフォルト±35秒）以内か照合
 * @param {number} candidateDur
 * @param {number} expectedDur
 * @param {number} [maxDiffSec=35]
 * @returns {boolean}
 */
export function isDurationMatch(candidateDur, expectedDur, maxDiffSec = 35) {
  if (!expectedDur || expectedDur <= 0 || !candidateDur || candidateDur <= 0) return true;
  return Math.abs(candidateDur - expectedDur) <= maxDiffSec;
}

const LRCLIB_HEADERS = {
  "User-Agent": "MusicPlayer/1.0 (https://music-player.app)",
  "Lrclib-Client": "MusicPlayer-PWA (https://github.com/8010pok/music-player)",
};

/**
 * LRCLIB 単一トラック詳細取得 (/api/get)
 */
async function fetchLrclibGet(title, artist = "", album = "", duration = 0) {
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) params.set("artist_name", artist);
    if (album && album !== "(Google Drive)" && album !== "(不明)" && album !== "Google Drive") {
      params.set("album_name", album);
    }
    if (duration && duration > 0) {
      params.set("duration", Math.round(duration).toString());
    }

    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: LRCLIB_HEADERS,
    });
    if (res.ok) {
      const data = await res.json();
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        // 取得データの整合性チェック
        if (isArtistMatch(data.artistName, artist) && isTitleMatch(data.trackName, title)) {
          const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
          const unsynced = data.plainLyrics || null;
          if (synced || unsynced) {
            return {
              synced,
              unsynced,
              source: "lrclib",
              artistName: data.artistName,
              trackName: data.trackName,
            };
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * LRCLIB フィールド検索 (/api/search?track_name=...&artist_name=...)
 */
async function fetchLrclibSearchFields(title, artist = "", duration = 0) {
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) params.set("artist_name", artist);

    const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
      headers: LRCLIB_HEADERS,
    });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0) {
        // 厳格照合: artistName と trackName がマッチし、曲長差が許容範囲内の候補をフィルタ
        const valid = items.filter((x) =>
          isArtistMatch(x.artistName, artist) &&
          isTitleMatch(x.trackName, title) &&
          isDurationMatch(x.duration, duration)
        );

        if (valid.length > 0) {
          // 同期歌詞 (syncedLyrics) を持つものを最優先、曲長が近いものを優先
          valid.sort((a, b) => {
            if (a.syncedLyrics && !b.syncedLyrics) return -1;
            if (!a.syncedLyrics && b.syncedLyrics) return 1;
            if (duration > 0 && a.duration && b.duration) {
              return Math.abs(a.duration - duration) - Math.abs(b.duration - duration);
            }
            return 0;
          });

          const best = valid[0];
          const synced = best.syncedLyrics ? parseLrc(best.syncedLyrics) : null;
          const unsynced = best.plainLyrics || null;
          if (synced || unsynced) {
            return {
              synced,
              unsynced,
              source: "lrclib",
              artistName: best.artistName,
              trackName: best.trackName,
            };
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * LRCLIB 全文クエリ検索 (/api/search?q=...) - 厳格照合ガード付き
 */
async function fetchLrclibSearchQ(queryText, expectedArtist = "", expectedTitle = "", duration = 0) {
  try {
    const q = queryText.trim();
    if (!q) return null;

    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
      headers: LRCLIB_HEADERS,
    });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0) {
        // ★ 厳格マッチング: 全文検索でもアーティスト名・曲名が合致しないものは絶対に除外！
        const valid = items.filter((x) => {
          const artMatch = expectedArtist ? isArtistMatch(x.artistName, expectedArtist) : true;
          const titMatch = expectedTitle ? isTitleMatch(x.trackName, expectedTitle) : true;
          const durMatch = isDurationMatch(x.duration, duration);
          return artMatch && titMatch && durMatch;
        });

        if (valid.length > 0) {
          valid.sort((a, b) => {
            if (a.syncedLyrics && !b.syncedLyrics) return -1;
            if (!a.syncedLyrics && b.syncedLyrics) return 1;
            return 0;
          });

          const best = valid[0];
          const synced = best.syncedLyrics ? parseLrc(best.syncedLyrics) : null;
          const unsynced = best.plainLyrics || null;
          if (synced || unsynced) {
            return {
              synced,
              unsynced,
              source: "lrclib",
              artistName: best.artistName,
              trackName: best.trackName,
            };
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Lyrics.ovh からのプレーン歌詞フォールバック取得
 */
async function fetchLyricsOvh(title, artist) {
  if (!title || !artist) return null;
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.lyrics && typeof data.lyrics === "string" && data.lyrics.trim().length > 10) {
        return {
          synced: null,
          unsynced: data.lyrics.trim(),
          source: "lyrics.ovh",
          artistName: artist,
          trackName: title,
        };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * オンライン歌詞を複数サービスからスマートに取得する
 *
 * @param {object} param
 * @param {string} param.title - 曲名
 * @param {string} [param.artist] - アーティスト名
 * @param {string} [param.album] - アルバム名
 * @param {number} [param.duration] - 再生時間(秒)
 * @returns {Promise<{ synced: Array<{timeMs: number, text: string}>|null, unsynced: string|null, source?: string, artistName?: string, trackName?: string }|null>}
 */
export async function fetchOnlineLyrics({ title, artist = "", album = "", duration = 0 } = {}) {
  const cTitle = cleanTitleForLyrics(title);
  const cArtist = cleanArtistForLyrics(artist);
  if (!cTitle) return null;

  const cacheKey = `${cArtist.toLowerCase()}|||${cTitle.toLowerCase()}`;
  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  const baseTitle = stripParenthesesAndSubtitles(title);
  const primaryArtist = extractPrimaryArtist(artist);

  // 1. LRCLIB: /api/get (曲名 + アーティスト + アルバム + duration 完全一致)
  let found = await fetchLrclibGet(cTitle, cArtist, album, duration);
  if (found) {
    lyricsCache.set(cacheKey, found);
    return found;
  }

  // 2. LRCLIB: /api/get (曲名 + アーティスト名のみ)
  if (album || duration) {
    found = await fetchLrclibGet(cTitle, cArtist, null, 0);
    if (found) {
      lyricsCache.set(cacheKey, found);
      return found;
    }
  }

  // 3. LRCLIB: /api/search?track_name=...&artist_name=... (フィールド指定検索・最も確実)
  found = await fetchLrclibSearchFields(cTitle, cArtist, duration);
  if (found) {
    lyricsCache.set(cacheKey, found);
    return found;
  }

  // 4. ベースタイトル (サブタイトル・カッコ除去) + プライマリアーティストで再試行
  if (baseTitle && (baseTitle !== cTitle || primaryArtist !== cArtist)) {
    found = await fetchLrclibSearchFields(baseTitle, primaryArtist || cArtist, duration);
    if (found) {
      lyricsCache.set(cacheKey, found);
      return found;
    }
  }

  // 5. LRCLIB: 全文検索 (アーティスト名・曲名の厳格マッチングガード付き)
  const searchQ = cArtist ? `${cArtist} ${cTitle}` : cTitle;
  found = await fetchLrclibSearchQ(searchQ, cArtist, cTitle, duration);
  if (found) {
    lyricsCache.set(cacheKey, found);
    return found;
  }

  // 6. Lyrics.ovh フォールバック (洋楽・邦楽のプレーンテキスト歌詞)
  if (cArtist && cTitle) {
    found = await fetchLyricsOvh(cTitle, cArtist);
    if (found) {
      lyricsCache.set(cacheKey, found);
      return found;
    }
    if (baseTitle && baseTitle !== cTitle) {
      found = await fetchLyricsOvh(baseTitle, primaryArtist || cArtist);
      if (found) {
        lyricsCache.set(cacheKey, found);
        return found;
      }
    }
  }

  lyricsCache.set(cacheKey, null);
  return null;
}

/**
 * ユーザーが手動選択できるように、検索条件に一致する歌詞候補一覧を取得
 * @param {object} param
 * @param {string} param.title
 * @param {string} [param.artist]
 * @returns {Promise<Array<{ id: number|string, title: string, artist: string, album?: string, duration?: number, hasSynced: boolean, syncedLyrics?: string, plainLyrics?: string }>>}
 */
export async function fetchLyricsCandidates({ title, artist = "" } = {}) {
  const cTitle = cleanTitleForLyrics(title);
  const cArtist = cleanArtistForLyrics(artist);
  if (!cTitle) return [];

  const candidates = [];
  const seen = new Set();

  try {
    const q = cArtist ? `${cArtist} ${cTitle}` : cTitle;
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: LRCLIB_HEADERS });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items)) {
        for (const it of items) {
          if (!it || (!it.syncedLyrics && !it.plainLyrics)) continue;
          const key = `${it.artistName}|||${it.trackName}|||${Math.round(it.duration || 0)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          candidates.push({
            id: it.id,
            title: it.trackName,
            artist: it.artistName,
            album: it.albumName || "",
            duration: it.duration || 0,
            hasSynced: !!it.syncedLyrics,
            syncedLyrics: it.syncedLyrics,
            plainLyrics: it.plainLyrics,
            source: "LRCLIB",
          });
        }
      }
    }
  } catch (_) {}

  return candidates;
}

/**
 * プチリリ、歌ネット、UtaTen、J-Lyric、Google へのダイレクト検索リンク URL を生成
 * @param {string} title
 * @param {string} [artist]
 * @returns {{ petitLyrics: string, utaNet: string, utaTen: string, jLyric: string, google: string }}
 */
export function getExternalLyricsUrls(title, artist = "") {
  const cTitle = cleanTitleForLyrics(title) || title || "";
  const cArtist = cleanArtistForLyrics(artist) || artist || "";
  const t = encodeURIComponent(cTitle);
  const a = encodeURIComponent(cArtist);
  const combined = encodeURIComponent(`${cArtist} ${cTitle}`.trim());

  return {
    petitLyrics: `https://petitlyrics.com/search_lyrics?title=${t}&artist=${a}`,
    utaNet: `https://www.uta-net.com/search/?Aselect=2&Bselect=3&Keyword=${combined}`,
    utaTen: `https://utaten.com/search?sort=popular_sort_asc&artist_name=${a}&title=${t}`,
    jLyric: `https://j-lyric.net/index.php?kt=${t}&ct=2&ka=${a}&ca=2`,
    google: `https://www.google.com/search?q=${encodeURIComponent(`${cArtist} ${cTitle} 歌詞`.trim())}`,
  };
}
