/**
 * MusicBrainz & iTunes 音楽メタデータ検索サービス
 *
 * - 曲名・アーティスト名・アルバム名からメタデータ（タイトル、アーティスト、アルバム、年、ジャンル、トラック番号、アートワーク、トラックリスト）を高精度で検索・取得
 * - iTunes Search API (CORS対応、高速、高解像度アートワーク、日本ストア対応でJ-POP/アニソン等のヒット率向上)
 * - MusicBrainz API (オープン音楽データベース)
 */

/**
 * 検索キーワードのノイズ除去（拡張子、(Google Drive)、トラック番号プレフィクス等を除去）
 * @param {string} str
 * @returns {string}
 */
export function cleanQuery(str) {
  if (!str) return "";
  return str
    .replace(/\.(mp3|flac|m4a|aac|ogg|opus|wav|webm|wma|alac)$/i, "")
    .replace(/\(Google Drive\)/gi, "")
    .replace(/Google Drive/gi, "")
    .replace(/\(不明アーティスト\)/gi, "")
    .replace(/\[.*?\]|\(.*?\)/g, (m) => (m.length > 20 ? "" : m))
    .replace(/^[0-9]+[\s.\-_]+/, "")
    .trim();
}

/**
 * 検索キーワードからトークン（単語配列）を抽出
 * 数字や記号のみの単語（トラック番号等のノイズ）を除去し、検索ヒット率を向上
 * @param {string} str
 * @returns {Array<string>}
 */
export function extractSearchTokens(str) {
  if (!str) return [];
  return cleanQuery(str)
    .toLowerCase()
    .split(/[\s　]+/)
    .map((t) => t.replace(/^[0-9]+[\s.\-_]+/, "").replace(/^[\s.\-_]+|[\s.\-_]+$/g, ""))
    .filter((t) => t.length > 0 && !/^[\d.\-_]+$/.test(t));
}

/**
 * 検索結果をクエリトークンとの合致度でスコアリングソート
 * @param {Array<object>} items
 * @param {Array<string>} tokens
 * @returns {Array<object>}
 */
export function scoreAndSortResults(items, tokens) {
  if (!tokens || tokens.length === 0) return items;

  return items
    .map((item) => {
      let score = 0;
      const titleLower = (item.title || "").toLowerCase();
      const artistLower = (item.artist || item.albumArtist || "").toLowerCase();
      const albumLower = (item.album || "").toLowerCase();
      const combined = `${titleLower} ${artistLower} ${albumLower}`;

      let matchedTokens = 0;
      for (const tok of tokens) {
        if (titleLower.includes(tok)) {
          score += 20;
          if (titleLower === tok) score += 30;
          matchedTokens++;
        } else if (artistLower.includes(tok)) {
          score += 15;
          if (artistLower === tok) score += 25;
          matchedTokens++;
        } else if (albumLower.includes(tok)) {
          score += 10;
          if (albumLower === tok) score += 15;
          matchedTokens++;
        } else if (combined.includes(tok)) {
          score += 5;
          matchedTokens++;
        }
      }

      // 複数キーワードすべてが含まれている場合は最上位に大きく引き上げ
      if (matchedTokens === tokens.length) {
        score += 100;
      }

      // iTunes の方がジャケット画像の解像度・信頼度が高いため微小加点
      if (item.source === "iTunes") {
        score += 5;
      }

      return { item, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

/**
 * 曲のメタデータを検索
 * @param {string} query
 * @param {{ artist?: string }} [opts]
 * @returns {Promise<Array<{ id?: string|number, title: string, artist: string, album: string, albumArtist: string, trackNo: string, year: string, genre: string, artworkUrl: string|null, source: string }>>}
 */
export async function searchTrackMetadata(query, { artist = "" } = {}) {
  const cleanQ = cleanQuery(query);
  const cleanA = cleanQuery(artist);
  const rawTerm = `${cleanA ? cleanA + " " : ""}${cleanQ}`.trim();
  if (!rawTerm) return [];

  const tokens = extractSearchTokens(rawTerm);
  const results = [];
  const seenIds = new Set();

  // 1. iTunes Search API (日本ストア優先、limit=25 でヒット率向上)
  try {
    let itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(rawTerm)}&entity=song&country=jp&lang=ja_jp&limit=25`;
    let res = await fetch(itunesUrl);
    let data = res.ok ? await res.json() : null;

    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      // フォールバック: グローバルストア
      itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(rawTerm)}&entity=song&limit=25`;
      res = await fetch(itunesUrl);
      if (res.ok) data = await res.json();
    }

    if (data && Array.isArray(data.results)) {
      for (const item of data.results) {
        const id = `itunes-${item.trackId}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const year = item.releaseDate ? item.releaseDate.substring(0, 4) : "";
        const artUrl = item.artworkUrl100
          ? item.artworkUrl100.replace("100x100bb", "600x600bb")
          : null;
        results.push({
          id: item.trackId,
          title: item.trackName || "",
          artist: item.artistName || "",
          album: item.collectionName || "",
          albumArtist: item.artistName || "",
          trackNo: item.trackNumber ? String(item.trackNumber) : "",
          year,
          genre: item.primaryGenreName || "",
          artworkUrl: artUrl,
          source: "iTunes",
        });
      }
    }
  } catch (e) {
    console.warn("[musicbrainz] iTunes 曲検索失敗:", e);
  }

  // 2. MusicBrainz API (AND 検索クエリ対応)
  try {
    const queryCandidates = [];
    if (tokens.length > 1) {
      // 複合AND検索: (token1) AND (token2)
      const andQuery = tokens.map((t) => `(${t.replace(/["\\]/g, "")})`).join(" AND ");
      queryCandidates.push(andQuery);
    }
    const safeQ = cleanQ.replace(/["\\]/g, "");
    const safeA = cleanA.replace(/["\\]/g, "");
    if (safeA && safeQ) {
      queryCandidates.push(`recording:"${safeQ}" AND artist:"${safeA}"`);
    }
    queryCandidates.push(rawTerm);

    let recordings = [];
    for (const qStr of queryCandidates) {
      try {
        const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(qStr)}&fmt=json&limit=15`;
        const res = await fetch(mbUrl, {
          headers: { "User-Agent": "MUSIC-PLAYER/1.0 (https://music-player.app)" },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.recordings) && data.recordings.length > 0) {
            recordings = data.recordings;
            break;
          }
        }
      } catch (err) {
        // 次のクエリ候補へ
      }
    }

    for (const rec of recordings) {
      const id = `mb-${rec.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const artistName = rec["artist-credit"]?.[0]?.name || rec["artist-credit"]?.[0]?.artist?.name || "";
      const release = rec.releases?.[0];
      const albumName = release?.title || "";
      const year = release?.date ? release.date.substring(0, 4) : "";
      const trackNo = release?.media?.[0]?.tracks?.[0]?.number || "";
      const genre = rec.tags?.[0]?.name || "";
      const releaseId = release?.id;
      const artworkUrl = releaseId
        ? `https://coverartarchive.org/release/${releaseId}/front-500`
        : null;

      results.push({
        id: rec.id,
        title: rec.title || "",
        artist: artistName,
        album: albumName,
        albumArtist: artistName,
        trackNo,
        year,
        genre,
        artworkUrl,
        source: "MusicBrainz",
      });
    }
  } catch (e) {
    console.warn("[musicbrainz] MusicBrainz 曲検索失敗:", e);
  }

  return scoreAndSortResults(results, tokens);
}

/**
 * アルバムのメタデータを検索
 * @param {string} query
 * @param {{ artist?: string }} [opts]
 * @returns {Promise<Array<{ id: string|number, title: string, artist: string, albumArtist: string, year: string, genre: string, trackCount: number, artworkUrl: string|null, source: string }>>}
 */
export async function searchAlbumMetadata(query, { artist = "" } = {}) {
  const cleanQ = cleanQuery(query);
  const cleanA = cleanQuery(artist);
  const rawTerm = `${cleanA ? cleanA + " " : ""}${cleanQ}`.trim();
  if (!rawTerm) return [];

  const tokens = extractSearchTokens(rawTerm);
  const results = [];
  const seenIds = new Set();

  // 1. iTunes Search API (アルバム) - 日本ストア優先、limit=25
  try {
    let itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(rawTerm)}&entity=album&country=jp&lang=ja_jp&limit=25`;
    let res = await fetch(itunesUrl);
    let data = res.ok ? await res.json() : null;

    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(rawTerm)}&entity=album&limit=25`;
      res = await fetch(itunesUrl);
      if (res.ok) data = await res.json();
    }

    if (data && Array.isArray(data.results)) {
      for (const item of data.results) {
        const id = `itunes-${item.collectionId}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const year = item.releaseDate ? item.releaseDate.substring(0, 4) : "";
        const artUrl = item.artworkUrl100
          ? item.artworkUrl100.replace("100x100bb", "600x600bb")
          : null;
        results.push({
          id: item.collectionId,
          title: item.collectionName || "",
          artist: item.artistName || "",
          albumArtist: item.artistName || "",
          year,
          genre: item.primaryGenreName || "",
          trackCount: item.trackCount || 0,
          artworkUrl: artUrl,
          source: "iTunes",
        });
      }
    }
  } catch (e) {
    console.warn("[musicbrainz] iTunes アルバム検索失敗:", e);
  }

  // 2. MusicBrainz API (リリース & Cover Art Archive)
  try {
    const queryCandidates = [];
    if (tokens.length > 1) {
      const andQuery = tokens.map((t) => `(${t.replace(/["\\]/g, "")})`).join(" AND ");
      queryCandidates.push(andQuery);
    }
    const safeQ = cleanQ.replace(/["\\]/g, "");
    const safeA = cleanA.replace(/["\\]/g, "");
    if (safeA && safeQ) {
      queryCandidates.push(`release:"${safeQ}" AND artist:"${safeA}"`);
    }
    queryCandidates.push(rawTerm);

    let releases = [];
    for (const qStr of queryCandidates) {
      try {
        const mbUrl = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(qStr)}&fmt=json&limit=15`;
        const res = await fetch(mbUrl, {
          headers: { "User-Agent": "MUSIC-PLAYER/1.0 (https://music-player.app)" },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.releases) && data.releases.length > 0) {
            releases = data.releases;
            break;
          }
        }
      } catch (err) {}
    }

    for (const rel of releases) {
      const id = `mb-${rel.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const artistName = rel["artist-credit"]?.[0]?.name || rel["artist-credit"]?.[0]?.artist?.name || "";
      const year = rel.date ? rel.date.substring(0, 4) : "";
      const trackCount = rel["track-count"] || 0;
      const artworkUrl = rel.id
        ? `https://coverartarchive.org/release/${rel.id}/front-500`
        : null;

      results.push({
        id: rel.id,
        title: rel.title || "",
        artist: artistName,
        albumArtist: artistName,
        year,
        genre: "",
        trackCount,
        artworkUrl,
        source: "MusicBrainz",
      });
    }
  } catch (e) {
    console.warn("[musicbrainz] MusicBrainz アルバム検索失敗:", e);
  }

  return scoreAndSortResults(results, tokens);
}

/**
 * アルバム検索結果から収録曲一覧（トラックリスト）を取得
 * @param {object} albumResult  searchAlbumMetadata の戻り値オブジェクト
 * @returns {Promise<Array<{ trackNo: string, discNo: string, title: string, artist: string, duration: number }>>}
 */
export async function fetchAlbumTracklist(albumResult) {
  if (!albumResult || !albumResult.id) return [];

  if (albumResult.source === "iTunes") {
    try {
      let url = `https://itunes.apple.com/lookup?id=${albumResult.id}&entity=song&country=jp&lang=ja_jp`;
      let res = await fetch(url);
      let data = res.ok ? await res.json() : null;

      if (!data || !Array.isArray(data.results) || data.results.length <= 1) {
        url = `https://itunes.apple.com/lookup?id=${albumResult.id}&entity=song`;
        res = await fetch(url);
        if (res.ok) data = await res.json();
      }

      if (data && Array.isArray(data.results)) {
        // 先頭要素 (collection) を除き、曲 (wrapperType === "track" または kind === "song") を抽出
        const songs = data.results.filter((x) => x.wrapperType === "track" || x.kind === "song");
        return songs.map((s) => ({
          trackNo: s.trackNumber ? String(s.trackNumber) : "",
          discNo: s.discNumber ? String(s.discNumber) : "1",
          title: s.trackName || "",
          artist: s.artistName || albumResult.artist || "",
          duration: s.trackTimeMillis ? Math.round(s.trackTimeMillis / 1000) : 0,
        }));
      }
    } catch (e) {
      console.warn("[musicbrainz] iTunes トラックリスト取得失敗:", e);
    }
  } else if (albumResult.source === "MusicBrainz") {
    try {
      const url = `https://musicbrainz.org/ws/2/release/${albumResult.id}?inc=recordings+artist-credits&fmt=json`;
      const res = await fetch(url, { headers: { "User-Agent": "MUSIC-PLAYER/1.0 (https://music-player.app)" } });
      if (res.ok) {
        const data = await res.json();
        const tracks = [];
        for (const medium of data.media || []) {
          const discNo = String(medium.position || "1");
          for (const t of medium.tracks || []) {
            tracks.push({
              trackNo: String(t.position || t.number || ""),
              discNo,
              title: t.title || t.recording?.title || "",
              artist: t["artist-credit"]?.[0]?.name || albumResult.artist || "",
              duration: t.length ? Math.round(t.length / 1000) : 0,
            });
          }
        }
        return tracks;
      }
    } catch (e) {
      console.warn("[musicbrainz] MusicBrainz トラックリスト取得失敗:", e);
    }
  }

  return [];
}

/**
 * 画像 URL から Blob をダウンロード（アートワーク適用用）
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
export async function fetchArtworkBlob(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch (e) {
    console.warn("[musicbrainz] アートワーク取得失敗:", e);
    return null;
  }
}
