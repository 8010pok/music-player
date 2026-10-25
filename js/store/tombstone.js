/**
 * 削除同期用 Tombstone（削除履歴）管理モジュール
 *
 * 端末Aで曲やプレイリストを削除した際、その削除情報をTombstoneとして一定期間（30日間）保持し、
 * 端末Bとの同期時に削除を確実に伝播させ、古い端末からの再復活を防止する。
 */

const STORAGE_KEY_TOMBSTONES = "music_player_tombstones";
const STORAGE_KEY_DEVICE_ID = "music_player_device_id";
const MAX_TOMBSTONE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30日間保持

/**
 * 端末固有の識別子を取得（未設定なら自動生成）
 * @returns {string}
 */
export function getDeviceId() {
  try {
    if (typeof localStorage !== "undefined") {
      let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
      if (!id) {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          id = crypto.randomUUID();
        } else {
          id = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
        }
        localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
      }
      return id;
    }
  } catch (_) {}
  return "dev-unknown";
}

/**
 * 有効なTombstone一覧を取得（期限切れの古い項目は自動パージ）
 * @returns {Array<{ id: string, type: "track"|"playlist", deletedAt: number, deviceId: string }>}
 */
export function getTombstones() {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY_TOMBSTONES);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];

    const now = Date.now();
    const valid = list.filter((item) => {
      return item && typeof item.id === "string" && typeof item.deletedAt === "number" && (now - item.deletedAt) < MAX_TOMBSTONE_AGE_MS;
    });

    if (valid.length !== list.length) {
      localStorage.setItem(STORAGE_KEY_TOMBSTONES, JSON.stringify(valid));
    }
    return valid;
  } catch (_) {
    return [];
  }
}

/**
 * 削除されたアイテムをTombstoneとして記録
 * @param {string} id 削除対象ID
 * @param {"track"|"playlist"} [type="track"] エンティティ種別
 * @param {number} [deletedAt] 削除時刻（省略時は現在時刻）
 * @param {string} [deviceId] 削除した端末ID
 */
export function recordTombstone(id, type = "track", deletedAt = Date.now(), deviceId = null) {
  if (!id || typeof id !== "string") return;
  try {
    if (typeof localStorage === "undefined") return;
    const list = getTombstones();
    const devId = deviceId || getDeviceId();
    const existingIndex = list.findIndex((t) => t.id === id);

    const entry = {
      id,
      type: type === "playlist" ? "playlist" : "track",
      deletedAt: typeof deletedAt === "number" ? deletedAt : Date.now(),
      deviceId: devId,
    };

    if (existingIndex >= 0) {
      if (entry.deletedAt >= list[existingIndex].deletedAt) {
        list[existingIndex] = entry;
      }
    } else {
      list.push(entry);
    }

    localStorage.setItem(STORAGE_KEY_TOMBSTONES, JSON.stringify(list));
  } catch (_) {}
}

/**
 * リモート（Google Drive同期JSONなど）から取得したTombstone一覧をローカルとマージ
 * @param {Array<object>} incomingTombstones
 * @returns {Array<object>} マージ後のTombstone一覧
 */
export function mergeTombstones(incomingTombstones) {
  if (!Array.isArray(incomingTombstones) || incomingTombstones.length === 0) {
    return getTombstones();
  }

  const local = getTombstones();
  const map = new Map(local.map((t) => [t.id, t]));
  const now = Date.now();

  for (const inc of incomingTombstones) {
    if (!inc || !inc.id || typeof inc.deletedAt !== "number") continue;
    if ((now - inc.deletedAt) >= MAX_TOMBSTONE_AGE_MS) continue; // 期限切れ除外

    const cur = map.get(inc.id);
    if (!cur || inc.deletedAt > cur.deletedAt) {
      map.set(inc.id, {
        id: inc.id,
        type: inc.type === "playlist" ? "playlist" : "track",
        deletedAt: inc.deletedAt,
        deviceId: inc.deviceId || "dev-remote",
      });
    }
  }

  const merged = Array.from(map.values());
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TOMBSTONES, JSON.stringify(merged));
    }
  } catch (_) {}
  return merged;
}

/**
 * 指定したアイテムが指定時刻においてTombstone（削除済み）となっているか判定
 * @param {string} id
 * @param {number} [entityTimestamp=0] エンティティの最終更新日時（addedAt/updatedAt）
 * @returns {boolean} true: 削除済みとみなす
 */
export function isTombstoned(id, entityTimestamp = 0) {
  if (!id) return false;
  const list = getTombstones();
  const found = list.find((t) => t.id === id);
  if (!found) return false;
  // エンティティの更新日時よりも新しい削除履歴がある場合は削除済み
  return found.deletedAt >= (entityTimestamp || 0);
}

/**
 * Tombstoneをすべて消去（全データ初期化用）
 */
export function clearTombstones() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY_TOMBSTONES);
    }
  } catch (_) {}
}
