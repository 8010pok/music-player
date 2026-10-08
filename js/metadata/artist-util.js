/**
 * アーティスト集計・正規化・ソート用ユーティリティ
 *
 * - 既存の tracks 配列からインメモリでアーティスト情報（アルバム一覧・曲一覧）を動的に抽出・集計
 * - 副作用のない純粋関数として実装（単体テスト容易性を確保）
 */

import { getAlbumArtist, groupTracksIntoAlbums, normalizeAlbumText } from "./album-util.js";

/**
 * アーティスト識別比較用テキスト正規化
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeArtistText(value) {
  return normalizeAlbumText(value);
}

/**
 * アーティスト識別用の一意キーを生成
 * @param {string} artistName
 * @returns {string}
 */
export function getArtistKey(artistName) {
  const norm = normalizeArtistText(artistName || "不明なアーティスト");
  return `art:${encodeURIComponent(norm)}`;
}

/**
 * 全トラック配列をアーティスト単位にグループ化する
 * - 元の tracks 配列を破壊しない
 * - 各アーティストに所属するアルバム一覧（groupTracksIntoAlbums）と曲一覧を集計
 * - artworkTrack には artworkBlob または artworkUrl を持つ最初の曲を採用
 * @param {Array<object>} tracks
 * @returns {Array<{key: string, name: string, albums: Array<object>, albumCount: number, tracks: Array<object>, trackCount: number, artworkTrack: object|null}>}
 */
export function groupTracksIntoArtists(tracks) {
  if (!Array.isArray(tracks)) return [];
  const map = new Map();

  for (const t of tracks) {
    if (!t) continue;
    const name = getAlbumArtist(t);
    const key = getArtistKey(name);
    let artist = map.get(key);
    if (!artist) {
      artist = {
        key,
        name,
        tracks: [],
        albums: [],
        albumCount: 0,
        trackCount: 0,
        artworkTrack: null,
      };
      map.set(key, artist);
    }
    artist.tracks.push(t);
  }

  const result = [];
  for (const artist of map.values()) {
    // アルバム一覧を抽出
    artist.albums = groupTracksIntoAlbums(artist.tracks);
    artist.albumCount = artist.albums.length;
    artist.trackCount = artist.tracks.length;

    // アートワークを持つ先頭トラック（アルバムのアートワーク優先、なければ曲から）
    const albumWithArt = artist.albums.find((a) => a.artworkTrack);
    artist.artworkTrack = albumWithArt ? albumWithArt.artworkTrack : (artist.tracks.find((t) => t && (t.artworkBlob || t.artworkUrl)) || null);

    result.push(artist);
  }

  return result;
}

/**
 * アーティスト一覧の並び替え
 * - 元の artists 配列を破壊しない
 * @param {Array<object>} artists
 * @param {string} sortKey "name-asc" | "name-desc" | "tracks-desc" | "albums-desc"
 * @returns {Array<object>}
 */
export function sortArtists(artists, sortKey = "name-asc") {
  if (!Array.isArray(artists)) return [];
  const list = artists.slice();

  switch (sortKey) {
    case "name-desc":
      return list.sort((a, b) => (b.name || "").localeCompare(a.name || "", "ja"));
    case "tracks-desc":
      return list.sort((a, b) => {
        const diff = (b.trackCount || 0) - (a.trackCount || 0);
        if (diff !== 0) return diff;
        return (a.name || "").localeCompare(b.name || "", "ja");
      });
    case "albums-desc":
      return list.sort((a, b) => {
        const diff = (b.albumCount || 0) - (a.albumCount || 0);
        if (diff !== 0) return diff;
        return (a.name || "").localeCompare(b.name || "", "ja");
      });
    case "name-asc":
    default:
      return list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
  }
}
