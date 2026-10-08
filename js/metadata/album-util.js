/**
 * アルバム集計・正規化・ソート用ユーティリティ
 *
 * - 既存の tracks 配列からインメモリでアルバム情報を動的に抽出・集計
 * - 副作用のない純粋関数として実装（単体テスト容易性を確保）
 */

/**
 * アルバム識別比較用テキスト正規化
 * - 前後の空白を除去し、小文字化
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAlbumText(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

/**
 * トラック番号またはディスク番号の文字列から整数を抽出する
 * - "1", "01", "1/12", "2/2" などの先頭数値をパース
 * - 解析不能時は fallback を返す
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parseTrackIndex(value, fallback = 0) {
  if (value == null) return fallback;
  const str = String(value).trim();
  if (!str) return fallback;
  const match = str.match(/^(\d+)/);
  if (!match) return fallback;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * トラックからアルバムアーティスト名を取得する（表示用）
 * - albumArtist || artist || "不明なアーティスト"
 * - タグの元の表記（大文字小文字など）を維持
 * @param {object} track
 * @returns {string}
 */
export function getAlbumArtist(track) {
  if (!track) return "不明なアーティスト";
  const aa = String(track.albumArtist || "").trim();
  if (aa) return aa;
  const a = String(track.artist || "").trim();
  if (a) return a;
  return "不明なアーティスト";
}

/**
 * トラックからアルバム名を取得する（表示用）
 * - album || "不明なアルバム"
 * - タグの元の表記を維持
 * @param {object} track
 * @returns {string}
 */
export function getAlbumTitle(track) {
  if (!track) return "不明なアルバム";
  const alb = String(track.album || "").trim();
  return alb || "不明なアルバム";
}

/**
 * アルバム識別用の一意キーを生成する
 * - albumArtist (または artist) と album の組み合わせ
 * - 前後空白・大文字小文字を正規化して同一判定
 * - year は初期版ではアルバムキーに含めない
 * @param {object} track
 * @returns {string}
 */
export function getAlbumKey(track) {
  const normArtist = normalizeAlbumText(getAlbumArtist(track));
  const normAlbum = normalizeAlbumText(getAlbumTitle(track));
  return `alb:${encodeURIComponent(normArtist)}:${encodeURIComponent(normAlbum)}`;
}

/**
 * アルバム内の曲順ソート比較関数
 * 1. discNo (未指定は Disc 1 扱い)
 * 2. trackNo (番号あり優先、未指定は番号付きの後ろ)
 * 3. title (五十音/アルファベット順)
 * 4. originalName (ファイル名順)
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareAlbumTracks(a, b) {
  // 1. discNo (未指定は Disc 1)
  const discA = parseTrackIndex(a?.discNo, 1);
  const discB = parseTrackIndex(b?.discNo, 1);
  if (discA !== discB) return discA - discB;

  // 2. trackNo の有無判定
  const strA = a?.trackNo != null ? String(a.trackNo).trim() : "";
  const strB = b?.trackNo != null ? String(b.trackNo).trim() : "";
  const hasA = /^\d+/.test(strA);
  const hasB = /^\d+/.test(strB);

  if (hasA && hasB) {
    const numA = parseTrackIndex(strA, 0);
    const numB = parseTrackIndex(strB, 0);
    if (numA !== numB) return numA - numB;
  } else if (hasA !== hasB) {
    // trackNo がある曲が前、ない曲が後ろ
    return hasA ? -1 : 1;
  }

  // 3. title
  const titleA = String(a?.title || "").trim();
  const titleB = String(b?.title || "").trim();
  const cmpTitle = titleA.localeCompare(titleB, "ja");
  if (cmpTitle !== 0) return cmpTitle;

  // 4. originalName
  const origA = String(a?.originalName || "").trim();
  const origB = String(b?.originalName || "").trim();
  return origA.localeCompare(origB, "ja");
}

/**
 * 全トラック配列をアルバム単位に動的グループ化する
 * - 元の tracks 配列を破壊しない
 * - アルバムごとに曲一覧を compareAlbumTracks で整列
 * - artworkTrack には artworkBlob を持つ最初の曲を採用
 * @param {Array<object>} tracks
 * @returns {Array<{key: string, title: string, albumArtist: string, year: string, tracks: Array<object>, trackCount: number, discCount: number, artworkTrack: object|null}>}
 */
export function groupTracksIntoAlbums(tracks) {
  if (!Array.isArray(tracks)) return [];
  const map = new Map();

  for (const t of tracks) {
    if (!t) continue;
    const key = getAlbumKey(t);
    let album = map.get(key);
    if (!album) {
      album = {
        key,
        title: getAlbumTitle(t),
        albumArtist: getAlbumArtist(t),
        year: String(t.year || "").trim(),
        tracks: [],
        trackCount: 0,
        discCount: 1,
        artworkTrack: null,
      };
      map.set(key, album);
    }
    // 初回に year が空だった場合、後続トラックで値があれば反映
    if (!album.year && t.year) {
      album.year = String(t.year).trim();
    }
    album.tracks.push(t);
  }

  const result = [];
  for (const album of map.values()) {
    // トラック配列のコピーを作ってソート（入力不変）
    album.tracks.sort(compareAlbumTracks);
    album.trackCount = album.tracks.length;

    // ディスク数集計
    const discs = new Set(album.tracks.map((t) => parseTrackIndex(t.discNo, 1)));
    album.discCount = Math.max(1, discs.size);

    // artworkBlob を持つ先頭トラック
    album.artworkTrack = album.tracks.find((t) => t && t.artworkBlob) || null;

    result.push(album);
  }

  return result;
}

/**
 * アルバム一覧の並び替え
 * - 元の albums 配列を破壊しない
 * @param {Array<object>} albums
 * @param {string} sortKey "title-asc" | "title-desc" | "artist-asc" | "year-desc" | "year-asc" | "recent"
 * @returns {Array<object>}
 */
export function sortAlbums(albums, sortKey = "title-asc") {
  if (!Array.isArray(albums)) return [];
  const list = albums.slice();

  switch (sortKey) {
    case "title-desc":
      return list.sort((a, b) => (b.title || "").localeCompare(a.title || "", "ja"));
    case "artist-asc":
      return list.sort((a, b) => {
        const c = (a.albumArtist || "").localeCompare(b.albumArtist || "", "ja");
        if (c !== 0) return c;
        return (a.title || "").localeCompare(b.title || "", "ja");
      });
    case "year-desc":
      return list.sort((a, b) => {
        const yA = parseInt(a.year, 10) || 0;
        const yB = parseInt(b.year, 10) || 0;
        if (yB !== yA) return yB - yA;
        return (a.title || "").localeCompare(b.title || "", "ja");
      });
    case "year-asc":
      return list.sort((a, b) => {
        const yA = parseInt(a.year, 10) || 99999;
        const yB = parseInt(b.year, 10) || 99999;
        if (yA !== yB) return yA - yB;
        return (a.title || "").localeCompare(b.title || "", "ja");
      });
    case "recent":
    case "added-desc":
      return list.sort((a, b) => {
        const maxA = Math.max(0, ...a.tracks.map((t) => t.addedAt || 0));
        const maxB = Math.max(0, ...b.tracks.map((t) => t.addedAt || 0));
        if (maxB !== maxA) return maxB - maxA;
        return (a.title || "").localeCompare(b.title || "", "ja");
      });
    case "title-asc":
    default:
      return list.sort((a, b) => (a.title || "").localeCompare(b.title || "", "ja"));
  }
}
