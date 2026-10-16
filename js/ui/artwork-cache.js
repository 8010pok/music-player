/**
 * アートワーク Blob → Object URL のキャッシュ
 *
 * 同じトラックを複数箇所（再生画面 / ミニプレイヤー / ライブラリ一覧）で
 * 表示するたびに createObjectURL/revokeObjectURL を繰り返すと、
 *   - URL 切替の隙間で画像が一瞬消える
 *   - blob URL を共有先で先に revoke してしまい <img> がロード失敗する
 * といった不具合が起きる。
 *
 * このモジュールは「ID -> URL」を保持し、同じ ID なら同じ URL を返す。
 * メモリリークになり得るが、音楽プレイヤーの想定規模では問題にならない。
 */

const idToUrl = new Map();
const brokenIds = new Set();

/**
 * トラックに対応するアートワーク URL を返す。
 * 無ければ null。
 *
 * ⚠️ 重要: キャッシュのキーは track.id のみで、artworkBlob の内容変化は検知しない。
 *   そのため、同じ id のアートワークを差し替えた場合(例: メタデータ再スキャンで
 *   artworkBlob を更新)は、再描画(getArtworkUrl 再呼び出し)を起こす **前** に
 *   必ず releaseArtwork(id) を呼ぶこと。解放しないと古い URL がキャッシュヒットで
 *   返り続け、新しいアートワークが表示されない(view-library.js rescanMeta 参照)。
 *
 * @param {object} track  { id, artworkBlob? }
 * @returns {string|null}
 */
export function getArtworkUrl(track) {
  if (!track || !track.id) return null;
  if (brokenIds.has(track.id)) return null;
  // ★ Base64 Data URL があれば最優先（revoke されず iOS MediaSession でも完全安定）
  if (track.artworkDataUrl && typeof track.artworkDataUrl === "string" && track.artworkDataUrl.startsWith("data:")) {
    return track.artworkDataUrl;
  }
  if (!track.artworkBlob) return null;

  const cached = idToUrl.get(track.id);
  if (cached) return cached;

  const blob = normalizeBlob(track.artworkBlob);
  if (!blob || blob.size < 8) return null;

  try {
    const u = URL.createObjectURL(blob);
    idToUrl.set(track.id, u);
    return u;
  } catch {
    return null;
  }
}

/**
 * 画像ロード失敗時に呼び出し、壊れた URL のキャッシュを破棄して以降の「？」表示を防ぐ。
 * @param {string} id
 */
export function markArtworkBroken(id) {
  if (!id) return;
  brokenIds.add(id);
  const u = idToUrl.get(id);
  if (u) {
    try { URL.revokeObjectURL(u); } catch {}
    idToUrl.delete(id);
  }
}

/**
 * 指定 ID のキャッシュ URL を破棄する（トラック削除時やアートワーク差し替え時など）。
 */
export function releaseArtwork(id) {
  brokenIds.delete(id);
  const u = idToUrl.get(id);
  if (u) {
    try { URL.revokeObjectURL(u); } catch {}
    idToUrl.delete(id);
  }
}

/**
 * 全キャッシュ URL を破棄する（全データ削除など、ライブラリ全消去時）。
 * releaseArtwork は単一 ID 用なので、全削除では idToUrl に溜まった全 Object URL が
 * revoke されず blob がページ寿命まで残存する。この関数で全件 revoke して map を空に
 * する。解放後に再描画されれば getArtworkUrl が遅延再生成するため表示には影響しない。
 */
export function releaseAllArtwork() {
  brokenIds.clear();
  for (const u of idToUrl.values()) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  idToUrl.clear();
}

function normalizeBlob(b) {
  if (!b) return null;
  if (typeof Blob !== "undefined" && b instanceof Blob) return b;
  try {
    if (b.buffer instanceof ArrayBuffer) {
      return new Blob([b]);
    }
    if (b instanceof ArrayBuffer) {
      return new Blob([b]);
    }
    if (Array.isArray(b) || (b.data && Array.isArray(b.data))) {
      return new Blob([new Uint8Array(b.data || b)]);
    }
  } catch {}
  return null;
}
