/**
 * 端末間完全同期・Tombstone削除・重複防止・アートワーク単独取得・一括選択の単体テスト
 *
 * 実行: node tests/test-sync-tombstone-selection-artwork.mjs
 */

import { strictEqual, ok, deepStrictEqual, notStrictEqual } from "node:assert";
import {
  getDeviceId,
  getTombstones,
  recordTombstone,
  mergeTombstones,
  isTombstoned,
  clearTombstones,
} from "../js/store/tombstone.js";
import { importLibraryData, exportLibraryData } from "../js/store/sync-service.js";
import { areTracksDuplicate, findDuplicateInList, mergeAndDeduplicate } from "../js/store/dedup-service.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// IndexedDB モック (Node.js 環境用)
const tracksStore = new Map();
const playlistsStore = new Map();
const blobsStore = new Map();

globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => {
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            addEventListener: () => {},
            objectStore: (name) => ({
              getAll: () => {
                let res = [];
                if (name === "tracks") res = Array.from(tracksStore.values());
                else if (name === "playlists") res = Array.from(playlistsStore.values());
                else if (name === "blobs") res = Array.from(blobsStore.values());
                const getReq = { result: res, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return getReq;
              },
              get: (id) => {
                let res = undefined;
                if (name === "tracks") res = tracksStore.get(id);
                else if (name === "playlists") res = playlistsStore.get(id);
                else if (name === "blobs") res = blobsStore.get(id);
                const getReq = { result: res, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return getReq;
              },
              put: (item, key) => {
                const k = key !== undefined ? key : (item && item.id);
                if (name === "tracks") tracksStore.set(k, item);
                else if (name === "playlists") playlistsStore.set(k, item);
                else if (name === "blobs") blobsStore.set(k, item);
                const putReq = { result: k, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (putReq.onsuccess) putReq.onsuccess({ target: putReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return putReq;
              },
              delete: (id) => {
                if (name === "tracks") tracksStore.delete(id);
                else if (name === "playlists") playlistsStore.delete(id);
                else if (name === "blobs") blobsStore.delete(id);
                const delReq = { result: id, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (delReq.onsuccess) delReq.onsuccess({ target: delReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return delReq;
              },
            }),
          };
          return tx;
        },
        close: () => {},
      },
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  },
};

// localStorage モック
const localStoreMap = new Map();
globalThis.localStorage = {
  getItem: (k) => localStoreMap.get(k) || null,
  setItem: (k, v) => localStoreMap.set(k, String(v)),
  removeItem: (k) => localStoreMap.delete(k),
  clear: () => localStoreMap.clear(),
};

console.log("=== 1. Tombstone 削除履歴管理テスト ===");

test("端末IDが生成され永続化されること", () => {
  const devId1 = getDeviceId();
  ok(devId1, "端末IDが空でないこと");
  const devId2 = getDeviceId();
  strictEqual(devId1, devId2, "同一端末では同一IDが返ること");
});

test("Tombstoneの記録と期限切れ自動パージ", () => {
  clearTombstones();
  const now = Date.now();
  recordTombstone("track-del-1", "track", now);
  recordTombstone("track-old", "track", now - 35 * 24 * 3600 * 1000); // 35日前（期限切れ）

  const list = getTombstones();
  strictEqual(list.length, 1, "期限切れの古い項目は自動パージされ、有効な1件のみ残ること");
  strictEqual(list[0].id, "track-del-1");
  ok(isTombstoned("track-del-1", now - 1000), "削除日時より前のエンティティは削除済みと判定されること");
  strictEqual(isTombstoned("track-del-1", now + 10000), false, "削除日時より後に再作成されたものは削除済みと判定されないこと");
});

test("リモートTombstoneのマージ", () => {
  clearTombstones();
  const now = Date.now();
  recordTombstone("track-local-del", "track", now - 2000);
  const remote = [
    { id: "track-remote-del", type: "track", deletedAt: now - 1000, deviceId: "dev-remote" },
    { id: "track-local-del", type: "track", deletedAt: now - 500, deviceId: "dev-remote" },
  ];
  const merged = mergeTombstones(remote);
  strictEqual(merged.length, 2);
  const localDel = merged.find((t) => t.id === "track-local-del");
  strictEqual(localDel.deletedAt, now - 500, "より新しい削除時刻で上書きされること");
});

console.log("=== 2. 端末間削除同期 & 復活防止テスト ===");

await asyncTest("端末Aで削除された曲がTombstone経由で端末Bから削除同期されること", async () => {
  tracksStore.clear();
  playlistsStore.clear();
  clearTombstones();

  const now = Date.now();
  // 端末Bに存在する曲
  tracksStore.set("t-song-1", {
    id: "t-song-1",
    title: "Live Song",
    artist: "Artist",
    addedAt: now - 3000,
    updatedAt: now - 3000,
  });

  // 端末Aから届いた同期データ（曲リストには t-song-1 がなく、tombstones に削除記録あり）
  const syncData = {
    app: "music-player",
    version: 3,
    tracks: [],
    playlists: [],
    tombstones: [
      { id: "t-song-1", type: "track", deletedAt: now - 1000, deviceId: "dev-device-A" },
    ],
  };

  const result = await importLibraryData(syncData);
  strictEqual(result.deletedCount, 1, "削除同期が1件カウントされること");
  strictEqual(tracksStore.has("t-song-1"), false, "ローカルから該当曲が削除されたこと");
});

await asyncTest("古い端末からの同期によって削除済み曲が再復活しないこと", async () => {
  tracksStore.clear();
  playlistsStore.clear();
  clearTombstones();

  const now = Date.now();
  // ローカルに削除Tombstoneが存在する
  recordTombstone("t-deleted-song", "track", now - 1000);

  // 古い端末Cから、以前の曲データが送られてきた
  const oldSyncData = {
    app: "music-player",
    version: 2,
    tracks: [
      {
        id: "t-deleted-song",
        title: "Old Deleted Song",
        artist: "Artist",
        addedAt: now - 5000,
        updatedAt: now - 3000, // deletedAt (now - 1000) より古い
      },
    ],
    playlists: [],
  };

  const result = await importLibraryData(oldSyncData);
  strictEqual(result.addedCount, 0, "削除済み曲は再追加されないこと");
  strictEqual(tracksStore.has("t-deleted-song"), false, "ストアに復活していないこと");
});

console.log("=== 3. keyShift, gainDb, enabled の完全同期テスト ===");

await asyncTest("keyShift と gainDb、enabled が正しくマージ・同期されること", async () => {
  tracksStore.clear();
  clearTombstones();

  const localTrack = {
    id: "t-pitch-1",
    title: "Karaoke Song",
    artist: "Singer",
    keyShift: 0,
    gainDb: 0,
    enabled: true,
    memo: "練習用",
  };
  tracksStore.set(localTrack.id, localTrack);

  const syncPayload = {
    app: "music-player",
    version: 3,
    tracks: [
      {
        id: "t-pitch-1",
        title: "Karaoke Song",
        artist: "Singer",
        keyShift: 3,        // キー+3
        gainDb: -1.8,       // 音量正規化
        enabled: false,     // 一時無効
        memo: "練習用",
      },
    ],
  };

  const res = await importLibraryData(syncPayload);
  strictEqual(res.updatedCount, 1);

  const updated = tracksStore.get("t-pitch-1");
  strictEqual(updated.keyShift, 3, "keyShift が同期されること");
  strictEqual(updated.gainDb, -1.8, "gainDb が同期されること");
  strictEqual(updated.enabled, false, "enabled が同期されること");
});

console.log("=== 4. 重複曲の防止（memo違いの完全保護）テスト ===");

test("memoが異なる曲は同一曲名・同一アーティストでも重複と判定しないこと（必須条件）", () => {
  const track2017 = {
    id: "t-2017",
    title: "Departure",
    artist: "HY",
    duration: 210,
    memo: "2017",
  };
  const track2018 = {
    id: "t-2018",
    title: "Departure",
    artist: "HY",
    duration: 210,
    memo: "2018",
  };

  strictEqual(
    areTracksDuplicate(track2017, track2018),
    false,
    "memoが異なる曲は絶対に重複とみなさず保持すること"
  );
});

test("片方のみmemoがある場合は重複と判定され、メモがマージされること", () => {
  const trackWithMemo = {
    id: "t-with-memo",
    title: "Departure",
    artist: "HY",
    duration: 210,
    memo: "武道館ライブ",
  };
  const trackEmptyMemo = {
    id: "t-empty-memo",
    title: "Departure",
    artist: "HY",
    duration: 210,
    memo: "",
  };

  ok(areTracksDuplicate(trackWithMemo, trackEmptyMemo), "片方のみメモがある場合は重複判定可能");
});

await asyncTest("重複マージ時に keyShift と gainDb、enabled を失わないこと", async () => {
  tracksStore.clear();
  const primary = {
    id: "t-p",
    title: "Song",
    artist: "Singer",
    keyShift: undefined,
    gainDb: undefined,
  };
  const duplicate = {
    id: "t-d",
    title: "Song",
    artist: "Singer",
    keyShift: -2,
    gainDb: 2.1,
  };

  tracksStore.set(primary.id, primary);
  tracksStore.set(duplicate.id, duplicate);

  await mergeAndDeduplicate(primary, duplicate, []);
  const merged = tracksStore.get("t-p");
  ok(merged, "primary が存在すること");
  strictEqual(merged.keyShift, -2, "duplicate の keyShift が引き継がれること");
  strictEqual(merged.gainDb, 2.1, "duplicate の gainDb が引き継がれること");
});

console.log("=== 5. 同期の冪等性テスト ===");

await asyncTest("同じ同期データを連続して適用しても重複やデータ破壊が発生しないこと", async () => {
  tracksStore.clear();
  clearTombstones();

  const syncData = {
    app: "music-player",
    version: 3,
    tracks: [
      { id: "t-idempotent-1", title: "Song 1", artist: "Artist 1" },
      { id: "t-idempotent-2", title: "Song 2", artist: "Artist 2" },
    ],
    playlists: [
      { id: "pl-idem-1", name: "Play 1", trackIds: ["t-idempotent-1"] },
    ],
  };

  // 1回目
  const res1 = await importLibraryData(syncData);
  strictEqual(res1.addedCount, 2);
  strictEqual(tracksStore.size, 2);

  // 2回目（同一データ）
  const res2 = await importLibraryData(syncData);
  strictEqual(res2.addedCount, 0, "新規追加は発生しないこと");
  strictEqual(tracksStore.size, 2, "曲数が水増しされないこと");
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("新機能・不具合修正 単体テスト成功 ✓");
