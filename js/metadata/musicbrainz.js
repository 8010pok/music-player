/**
 * MusicBrainz & iTunes 音楽メタデータ検索サービス
 *
 * - 曲名・アーティスト名・アルバム名からメタデータ（タイトル、アーティスト、アルバム、年、ジャンル、トラック番号、アートワーク）を検索・取得
 * - iTunes Search API (CORS対応、高速、高解像度アートワーク)
 * - MusicBrainz API (オープン音楽データベース)
 */

/**
 * 曲のメタデータを検索
 * @param {string} query
 * @param {{ artist?: string }} [opts]
 * @returns {Promise<Array<{ title: string, artist: string, album: string, albumArtist: string, trackNo: string, year: string, genre: string, artworkUrl: string|null, source: string }>>}
 */
export async function searchTrackMetadata(query, { artist = "" } = {}) {
  const searchTerm = `${artist ? artist + " " : ""}${query}`.trim();
  if (!searchTerm) return [];

  const results = [];

  // 1. iTunes Search API (高速・高解像度アートワーク付き)
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=song&limit=8`;
    const res = await fetch(itunesUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          const year = item.releaseDate ? item.releaseDate.substring(0, 4) : "";
          const artUrl = item.artworkUrl100
            ? item.artworkUrl100.replace("100x100bb", "600x600bb")
            : null;
          results.push({
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
    }
  } catch (e) {
    console.warn("[musicbrainz] iTunes 曲検索失敗:", e);
  }

  // 2. MusicBrainz API (オープンデータベース)
  try {
    const mbQuery = artist
      ? `recording:"${query.replace(/"/g, "")}" AND artist:"${artist.replace(/"/g, "")}"`
      : `recording:"${query.replace(/"/g, "")}"`;
    const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(mbQuery)}&fmt=json&limit=5`;
    const res = await fetch(mbUrl, {
      headers: { "User-Agent": "MUSIC-PLAYER/1.0 (https://music-player.app)" },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.recordings)) {
        for (const rec of data.recordings) {
          const artistName = rec["artist-credit"]?.[0]?.name || rec["artist-credit"]?.[0]?.artist?.name || "";
          const release = rec.releases?.[0];
          const albumName = release?.title || "";
          const year = release?.date ? release.date.substring(0, 4) : "";
          const trackNo = release?.media?.[0]?.tracks?.[0]?.number || "";
          const genre = rec.tags?.[0]?.name || "";

          // 重複チェック (同一タイトル+アーティストがiTunesに無ければ追加)
          const isDup = results.some(
            (r) => r.title.toLowerCase() === rec.title.toLowerCase() && r.artist.toLowerCase() === artistName.toLowerCase()
          );
          if (!isDup) {
            results.push({
              title: rec.title || "",
              artist: artistName,
              album: albumName,
              albumArtist: artistName,
              trackNo,
              year,
              genre,
              artworkUrl: null,
              source: "MusicBrainz",
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn("[musicbrainz] MusicBrainz 曲検索失敗:", e);
  }

  return results;
}

/**
 * アルバムのメタデータを検索
 * @param {string} query
 * @param {{ artist?: string }} [opts]
 * @returns {Promise<Array<{ title: string, artist: string, albumArtist: string, year: string, genre: string, trackCount: number, artworkUrl: string|null, source: string }>>}
 */
export async function searchAlbumMetadata(query, { artist = "" } = {}) {
  const searchTerm = `${artist ? artist + " " : ""}${query}`.trim();
  if (!searchTerm) return [];

  const results = [];

  // 1. iTunes Search API (アルバム)
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=8`;
    const res = await fetch(itunesUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          const year = item.releaseDate ? item.releaseDate.substring(0, 4) : "";
          const artUrl = item.artworkUrl100
            ? item.artworkUrl100.replace("100x100bb", "600x600bb")
            : null;
          results.push({
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
    }
  } catch (e) {
    console.warn("[musicbrainz] iTunes アルバム検索失敗:", e);
  }

  // 2. MusicBrainz API (リリース)
  try {
    const mbQuery = artist
      ? `release:"${query.replace(/"/g, "")}" AND artist:"${artist.replace(/"/g, "")}"`
      : `release:"${query.replace(/"/g, "")}"`;
    const mbUrl = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(mbQuery)}&fmt=json&limit=5`;
    const res = await fetch(mbUrl, {
      headers: { "User-Agent": "MUSIC-PLAYER/1.0 (https://music-player.app)" },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.releases)) {
        for (const rel of data.releases) {
          const artistName = rel["artist-credit"]?.[0]?.name || rel["artist-credit"]?.[0]?.artist?.name || "";
          const year = rel.date ? rel.date.substring(0, 4) : "";
          const trackCount = rel["track-count"] || 0;

          const isDup = results.some(
            (r) => r.title.toLowerCase() === rel.title.toLowerCase() && r.artist.toLowerCase() === artistName.toLowerCase()
          );
          if (!isDup) {
            results.push({
              title: rel.title || "",
              artist: artistName,
              albumArtist: artistName,
              year,
              genre: "",
              trackCount,
              artworkUrl: null,
              source: "MusicBrainz",
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn("[musicbrainz] MusicBrainz アルバム検索失敗:", e);
  }

  return results;
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
