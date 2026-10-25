/**
 * 削除同期用 Tombstone（削除履歴）管理モジュール
 *
 * 端末Aで曲やプレイリストを削除した際、その削除情報をTombstoneとして一定期間（365日間）保持し、
 * 端末Bとの同期時に削除を確実に伝播させ、古い端末からの再復活を防止する。
 *
 * 【仕様と制限】
 * - 保持期間: 365日間 (31,536,000,000 ms)
 * - 複合キー: Track と Playlist で同一IDが存在した場合の衝突を防ぐため、内部キーは `type:id` で管理。
 * - 366日以上の制限: 366日以上一度も同期していない端末を接続した場合、Tombstone が期限切れで
 *   パージされているため、その端末に残っていた削除済み曲がクラウド上に新規曲として再同期・復活する
 *   可能性があります。
 * - 容量制限と保護: localStorage 容量圧迫を防ぐため最大 5,000 件に制限し、QuotaExceededError 発生時は
 *   古い順にパージして自己修復します。
 */

export const STORAGE_KEY_TOMBSTONES = "music_player_tombstones";
export const STORAGE_KEY_DEVICE_ID = "music_player_device_id";

// Tombstone保持期間: 365日（マジックナンバーを排除し定数化）
export const TOMBSTONE_RETENTION_DAYS = 365;
export const TOMBSTONE_RETENTION_MS = TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const MAX_TOMBSTONE_AGE_MS = TOMBSTONE_RETENTION_MS; // 後方互換用エイリアス

// localStorage容量保護のための最大保持件数
export const MAX_TOMBSTONE_COUNT = 5000;

/**
 * Track と Playlist の ID 衝突を防ぐ複合キーを生成
 * @param {"track"|"playlist"} type
 * @param {string} id
 * @returns {string}
 */
export function makeTombstoneKey(type, id) {
  const normType = type === "playlist" ? "playlist" : "track";
  return `${normType}:${id}`;
}

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
 * localStorage への Tombstone 安全書き込み
 * (QuotaExceededError を捕捉し、古い順に自動パージして復旧)
 * @param {Array<object>} list
 * @returns {boolean} 保存に成功したか
 */
function safeSaveTombstones(list) {
  if (typeof localStorage === "undefined") return false;
  try {
    // 最大件数制限（最新順にソートして最大件数に収める）
    let toSave = list;
    if (toSave.length > MAX_TOMBSTONE_COUNT) {
      toSave = toSave.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)).slice(0, MAX_TOMBSTONE_COUNT);
    }
    localStorage.setItem(STORAGE_KEY_TOMBSTONES, JSON.stringify(toSave));
    return true;
  } catch (err) {
    console.warn("[tombstone] localStorage への Tombstone 保存失敗 (QuotaExceededError 検査):", err);
    // QuotaExceededError 時の自己修復: 古い順に半減パージして再試行
    if (err && (err.name === "QuotaExceededError" || err.code === 22 || err.code === 1014 || (err.message && err.message.includes("quota")))) {
      try {
        const sorted = list.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
        const reduced = sorted.slice(0, Math.max(10, Math.floor(sorted.length / 2)));
        localStorage.setItem(STORAGE_KEY_TOMBSTONES, JSON.stringify(reduced));
        console.warn(`[tombstone] 容量超過のため古い Tombstone を縮小保存しました (${list.length}件 -> ${reduced.length}件)`);
        return true;
      } catch (retryErr) {
        console.error("[tombstone] Tombstone 縮小保存の再試行も失敗しました:", retryErr);
      }
    }
    return false;
  }
}

/**
 * 有効なTombstone一覧を取得（365日経過の古い項目は自動パージ）
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
      return item && typeof item.id === "string" && typeof item.deletedAt === "number" && (now - item.deletedAt) < TOMBSTONE_RETENTION_MS;
    });

    if (valid.length !== list.length) {
      safeSaveTombstones(valid);
    }
    return valid;
  } catch (_) {
    return [];
  }
}

/**
 * 削除されたアイテムをTombstoneとして記録
 * Track と Playlist の同一ID衝突を防ぐため、複合キー (type:id) で管理する。
 *
 * @param {string} id 削除対象ID
 * @param {"track"|"playlist"} [type="track"] エンティティ種別
 * @param {number} [deletedAt] 削除時刻（省略時は現在時刻）
 * @param {string} [deviceId] 削除した端末ID
 * @returns {{ ok: boolean, error?: string }}
 */
export function recordTombstone(id, type = "track", deletedAt = Date.now(), deviceId = null) {
  if (!id || typeof id !== "string") {
    return { ok: false, error: "無効なIDです" };
  }
  const normType = type === "playlist" ? "playlist" : "track";
  const targetKey = makeTombstoneKey(normType, id);

  try {
    if (typeof localStorage === "undefined") {
      return { ok: false, error: "localStorage が利用できません" };
    }
    const list = getTombstones();
    const devId = deviceId || getDeviceId();

    // 複合キー (type:id) で既存エントリを検索
    const existingIndex = list.findIndex((t) => makeTombstoneKey(t.type, t.id) === targetKey);

    const entry = {
      id,
      type: normType,
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

    const saved = safeSaveTombstones(list);
    if (!saved) {
      console.warn(`[tombstone] ⚠️ 同期用 Tombstone (${normType}:${id}) の保存に失敗しました。端末間同期で削除が伝播しない恐れがあります。`);
      return { ok: false, error: "Tombstone 保存失敗 (ストレージ容量不足など)" };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[tombstone] recordTombstone 例外:`, err);
    return { ok: false, error: err && err.message ? err.message : "Tombstone 保存時例外" };
  }
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
  // 複合キー (type:id) をキーとする Map で衝突防止
  const map = new Map(local.map((t) => [makeTombstoneKey(t.type, t.id), t]));
  const now = Date.now();

  for (const inc of incomingTombstones) {
    if (!inc || !inc.id || typeof inc.deletedAt !== "number") continue;
    if ((now - inc.deletedAt) >= TOMBSTONE_RETENTION_MS) continue; // 365日経過パージ

    const normType = inc.type === "playlist" ? "playlist" : "track";
    const key = makeTombstoneKey(normType, inc.id);
    const cur = map.get(key);

    if (!cur || inc.deletedAt > cur.deletedAt) {
      map.set(key, {
        id: inc.id,
        type: normType,
        deletedAt: inc.deletedAt,
        deviceId: inc.deviceId || "dev-remote",
      });
    }
  }

  const merged = Array.from(map.values());
  safeSaveTombstones(merged);
  return merged;
}

/**
 * 指定したアイテムが指定時刻においてTombstone（削除済み）となっているか判定
 * @param {string} id
 * @param {number} [entityTimestamp=0] エンティティの最終更新日時（addedAt/updatedAt）
 * @param {"track"|"playlist"} [type="track"] エンティティ種別
 * @returns {boolean} true: 削除済みとみなす
 */
export function isTombstoned(id, entityTimestamp = 0, type = "track") {
  if (!id) return false;
  const list = getTombstones();
  const normType = type === "playlist" ? "playlist" : "track";
  const targetKey = makeTombstoneKey(normType, id);

  // 複合キーが一致し、かつエンティティ更新日時よりも新しい削除履歴があるか
  const found = list.find((t) => {
    // 互換性: 旧形式レコード (type が無い場合) は track とみなす
    const tKey = makeTombstoneKey(t.type, t.id);
    return tKey === targetKey;
  });

  if (!found) return false;
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
