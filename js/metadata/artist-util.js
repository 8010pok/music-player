/**
 * アーティスト集計・正規化・ソート用ユーティリティ
 *
 * - 既存の tracks 配列からインメモリでアーティスト情報（アルバム一覧・曲一覧）を動的に抽出・集計
 * - 副作用のない純粋関数として実装（単体テスト容易性を確保）
 */

import { getAlbumArtist, groupTracksIntoAlbums, normalizeAlbumText, sortAlbums } from "./album-util.js";

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
    // アルバム一覧を抽出 (リリース年・新しい順にデフォルト整列)
    artist.albums = sortAlbums(groupTracksIntoAlbums(artist.tracks), "year-desc");
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

/**
 * 日本の五十音・アルファベット標準インデックス文字リスト
 */
export const JAPANESE_INDEX_CHARS = [
  "あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "#"
];

/**
 * アーティスト名（またはテキスト）から五十音またはアルファベットのインデックス文字を判定
 * - カタカナはひらがなに正規化
 * - 英字は A-Z の大文字
 * - 数字・記号・漢字等は "#"
 *
 * @param {string} text
 * @returns {string}
 */
export function getIndexChar(text) {
  if (!text || typeof text !== "string") return "#";
  const trimmed = text.trim();
  if (!trimmed) return "#";

  // 先頭の記号・括弧・引用符をスキップ
  const stripped = trimmed.replace(/^["'「『（(【\[\s]+/, "");
  const first = stripped[0] || trimmed[0];
  if (!first) return "#";

  // 英字 (A-Z)
  if (/[a-zA-Z]/.test(first)) {
    return first.toUpperCase();
  }

  // カタカナをひらがなに変換
  let hira = first;
  const code = first.charCodeAt(0);
  if (code >= 0x30a1 && code <= 0x30f6) {
    hira = String.fromCharCode(code - 0x60);
  }

  // ひらがな五十音判定
  if (/^[あいうえおぁぃぅぇぉゔヴ]$/.test(hira)) return "あ";
  if (/^[かきくけこがぎぐげごヵヶ]$/.test(hira)) return "か";
  if (/^[さしすせそざじずぜぞ]$/.test(hira)) return "さ";
  if (/^[たちつてとだぢづでどっ]$/.test(hira)) return "た";
  if (/^[なにぬねの]$/.test(hira)) return "な";
  if (/^[はひふへほばびぶべぼぱぴぷぺぽ]$/.test(hira)) return "は";
  if (/^[まみむめも]$/.test(hira)) return "ま";
  if (/^[やゆよゃゅょ]$/.test(hira)) return "や";
  if (/^[らりるれろ]$/.test(hira)) return "ら";
  if (/^[わをんゎゐゑ]$/.test(hira)) return "わ";

  return "#";
}

