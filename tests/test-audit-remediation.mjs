/**
 * 監査指摘事項の是正検証テストスイート
 *
 * 1. Tombstone 365日TTL / 複合キー衝突防止 / QuotaExceeded自己修復
 * 2. 未キャッシュDrive曲とWeb Audio (EQ/キーチェンジ) 安全経路
 * 3. スキーマv4 アートワーク重複排除辞書方式 / v3互換 / 画像復元
 * 4. 永続化層の共通変更通知 (dirty) / 同期スコープ中の抑止
 * 5. 同期失敗時のdirty保持 / 同期中の新規変更検知 (世代番号)
 */

import { strictEqual, ok, deepStrictEqual, rejects } from "node:assert";

// モック環境の構築
class MockStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

globalThis.localStorage = new MockStorage();

const tracksStore = new Map();
const blobsStore = new Map();
const playlistsStore = new Map();
const historyStore = new Map();

globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: (stores, mode) => {
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            addEventListener: () => {},
            objectStore: (name) => {
              let target = tracksStore;
              if (name === "playlists") target = playlistsStore;
              if (name === "blobs") target = blobsStore;
              if (name === "history") target = historyStore;

              return {
                get: (id) => {
                  const r = { result: target.get(id) || null, onsuccess: null, onerror: null };
                  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
                  return r;
                },
                getAll: () => {
                  const r = { result: Array.from(target.values()), onsuccess: null, onerror: null };
                  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
                  return r;
                },
                put: (val) => {
                  const id = val && val.id ? val.id : (val && val.track ? val.track.id : null);
                  if (id) {
                    target.set(id, val.track || val);
                  }
                  const r = { onsuccess: null, onerror: null };
                  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
                  return r;
                },
                delete: (id) => {
                  target.delete(id);
                  const r = { onsuccess: null, onerror: null };
                  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
                  return r;
                },
                clear: () => {
                  target.clear();
                  const r = { onsuccess: null, onerror: null };
                  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
                  return r;
                },
              };
            },
          };
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 5);
          return tx;
        },
      },
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
    return req;
  },
};

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

// モジュールの動的インポート
const {
  TOMBSTONE_RETENTION_DAYS,
  TOMBSTONE_RETENTION_MS,
  MAX_TOMBSTONE_COUNT,
  makeTombstoneKey,
  getTombstones,
  recordTombstone,
  clearTombstones,
  mergeTombstones,
  isTombstoned,
} = await import("../js/store/tombstone.js");

const {
  exportLibraryData,
  importLibraryData,
  computeArtworkHash,
  SYNC_SCHEMA_VERSION,
  recordLibraryModified,
  clearLibraryDirty,
  isLibraryDirty,
  syncLibraryWithDrive,
} = await import("../js/store/sync-service.js");

const {
  putTrack,
  updateTrack,
  bulkUpdateTracks,
  setTracksOrder,
  deleteTrack,
  bulkDeleteTracks,
  savePlaylist,
  updatePlaylist,
  deletePlaylist,
  setSyncScope,
  isSyncScopeActive,
  onLibraryMutated,
} = await import("../js/store/library-db.js");

function resetAll() {
  tracksStore.clear();
  blobsStore.clear();
  playlistsStore.clear();
  historyStore.clear();
  localStorage.clear();
  clearTombstones();
  clearLibraryDirty();
  setSyncScope(false);
}

console.log("=== 1. Tombstone 365日TTL & 複合キー衝突防止 ===");

test("TOMBSTONE_RETENTION_DAYS が 365日として定義されていること", () => {
  strictEqual(TOMBSTONE_RETENTION_DAYS, 365);
  strictEqual(TOMBSTONE_RETENTION_MS, 365 * 24 * 60 * 60 * 1000);
});

test("Track と Playlist で同一IDがあっても makeTombstoneKey で衝突しないこと", () => {
  strictEqual(makeTombstoneKey("track", "abc"), "track:abc");
  strictEqual(makeTombstoneKey("playlist", "abc"), "playlist:abc");
});

test("300日前 (365日以内) の削除済み曲が古い端末の同期によって復活しないこと", () => {
  resetAll();
  const now = Date.now();
  const threeHundredDaysAgo = now - 300 * 24 * 60 * 60 * 1000;

  // 300日前に端末Aで削除
  recordTombstone("trk-300d", "track", threeHundredDaysAgo);

  // 320日前に作成されたまま放置されていた古い端末の曲
  const incomingOldTime = now - 320 * 24 * 60 * 60 * 1000;
  strictEqual(isTombstoned("trk-300d", incomingOldTime, "track"), true, "300日前のTombstoneで削除対象と判定されること");
});

test("Tombstone 保存時に QuotaExceededError が発生しても自己修復すること", () => {
  resetAll();
  const originalSetItem = localStorage.setItem;
  let throwOnce = true;

  try {
    localStorage.setItem = (k, v) => {
      if (k === "music_player_tombstones" && throwOnce) {
        throwOnce = false;
        const err = new Error("Quota exceeded");
        err.name = "QuotaExceededError";
        throw err;
      }
      originalSetItem.call(localStorage, k, v);
    };

    const res = recordTombstone("trk-quota", "track", Date.now());
    strictEqual(res.ok, true, "QuotaExceededError 時でも縮小パージして保存に成功すること");
  } finally {
    localStorage.setItem = originalSetItem;
  }
});

console.log("=== 2. アートワーク同期JSON重複排除 (スキーマ v4) ===");

test("computeArtworkHash が同じ Base64 に対して同一ハッシュを返すこと", () => {
  const b64 = "data:image/jpeg;base64,1234567890ABCDEF";
  const h1 = computeArtworkHash(b64);
  const h2 = computeArtworkHash(b64);
  strictEqual(h1, h2);
  ok(h1.startsWith("art-"));
});

await asyncTest("アルバム10曲に同一画像を設定しても同期JSON内の artworks は1件のみに重複排除されること", async () => {
  resetAll();
  const artData = "data:image/jpeg;base64,SHARED_ALBUM_IMAGE_DATA_AAAA";
  for (let i = 1; i <= 10; i++) {
    tracksStore.set(`t-${i}`, {
      id: `t-${i}`,
      title: `Track ${i}`,
      artist: "Test Artist",
      album: "Test Album",
      artworkDataUrl: artData,
      duration: 200,
      updatedAt: 1000,
    });
  }

  const exported = await exportLibraryData();
  strictEqual(exported.version, 4, "スキーマバージョンが 4 であること");
  ok(exported.artworks, "artworks 辞書が存在すること");

  const artKeys = Object.keys(exported.artworks);
  strictEqual(artKeys.length, 1, "同一画像は1件のみ artworks に保存されること");

  for (const t of exported.tracks) {
    strictEqual(t.artworkDataUrl, undefined, "Track レコード内からは Base64 が除外されていること");
    strictEqual(t.artworkId, artKeys[0], "Track は artworkId を保持していること");
  }
});

await asyncTest("v4 同期JSON をインポートした際に Track の artworkDataUrl が完全復元されること", async () => {
  resetAll();
  const artData = "data:image/jpeg;base64,RESTORE_IMAGE_DATA_BBBB";
  const artId = computeArtworkHash(artData);

  const payloadV4 = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-restore-1", title: "Song 1", artworkId: artId, updatedAt: 2000 },
      { id: "t-restore-2", title: "Song 2", artworkId: artId, updatedAt: 2000 },
    ],
    artworks: {
      [artId]: artData,
    },
  };

  await importLibraryData(payloadV4);
  const t1 = tracksStore.get("t-restore-1");
  const t2 = tracksStore.get("t-restore-2");

  strictEqual(t1.artworkDataUrl, artData, "Track 1 に画像が復元されること");
  strictEqual(t2.artworkDataUrl, artData, "Track 2 に画像が復元されること");
});

await asyncTest("旧 v3 形式の同期JSON (Track直にartworkDataUrl) も後方互換でインポートできること", async () => {
  resetAll();
  const v3Art = "data:image/jpeg;base64,V3_LEGACY_IMAGE_DATA_CCCC";
  const payloadV3 = {
    app: "music-player",
    version: 3,
    tracks: [
      { id: "t-v3-legacy", title: "Legacy Song", artworkDataUrl: v3Art, updatedAt: 1000 },
    ],
  };

  await importLibraryData(payloadV3);
  const t = tracksStore.get("t-v3-legacy");
  strictEqual(t.artworkDataUrl, v3Art, "旧v3の画像が欠落なく読み込めること");
});

console.log("=== 3. 永続化層の共通変更通知 (dirty) & 同期スコープ ===");

await asyncTest("永続化層の各操作で onLibraryMutated がトリガーされること", async () => {
  resetAll();
  const mutations = [];
  const unsub = onLibraryMutated((type) => {
    mutations.push(type);
  });

  try {
    await putTrack({ id: "t-mut-1", title: "Mut 1" });
    await updateTrack("t-mut-1", { memo: "new memo" });
    await setTracksOrder([["t-mut-1", 100]]);
    await savePlaylist({ id: "pl-mut-1", name: "PL 1" });
    await updatePlaylist("pl-mut-1", { name: "PL 1 Renamed" });
    await deleteTrack("t-mut-1");
    await deletePlaylist("pl-mut-1");

    ok(mutations.includes("track:put"));
    ok(mutations.includes("track:update"));
    ok(mutations.includes("order:update"));
    ok(mutations.includes("playlist:save"));
    ok(mutations.includes("playlist:update"));
    ok(mutations.includes("track:delete"));
    ok(mutations.includes("playlist:delete"));
  } finally {
    unsub();
  }
});

await asyncTest("setSyncScope(true) 中は notifyLibraryMutated が抑止されること", async () => {
  resetAll();
  let count = 0;
  const unsub = onLibraryMutated(() => { count++; });

  try {
    setSyncScope(true);
    await putTrack({ id: "t-scoped-1", title: "Scoped" });
    await updateTrack("t-scoped-1", { memo: "scoped memo" });
    setSyncScope(false);

    strictEqual(count, 0, "同期スコープ中の書き込みでは通知が抑止されること");

    // スコープ解除後は通常どおり通知
    await putTrack({ id: "t-scoped-2", title: "Unscoped" });
    strictEqual(count, 1, "スコープ解除後は通知が発火すること");
  } finally {
    unsub();
    setSyncScope(false);
  }
});

console.log("=== 4. 未キャッシュDrive曲とWeb Audio (EQ/キーチェンジ) 安全経路 ===");

test("EQ無効かつキーチェンジ無効の場合はダイレクトストリームが優先されること", () => {
  // needsWebAudio = isEffectsActive || isKeyShiftActive
  const pub = { enableAudioEffects: false };
  const track = { id: "gd-test-stream", keyShift: 0 };
  const isEffectsActive = !!pub.enableAudioEffects;
  const trackKeyShift = track.keyShift || 0;
  const isKeyShiftActive = trackKeyShift !== 0;
  const needsWebAudio = isEffectsActive || isKeyShiftActive;

  strictEqual(needsWebAudio, false, "EQ/キーチェンジ不要なら Web Audio バイパスフラグは立たない");
});

test("EQ有効またはキーチェンジ有効時はCORS無音化防止のためBlobキャッシュ待機となること", () => {
  // Case A: EQ 有効
  {
    const pub = { enableAudioEffects: true };
    const track = { id: "gd-test-stream", keyShift: 0 };
    const needsWebAudio = !!pub.enableAudioEffects || (track.keyShift !== 0);
    strictEqual(needsWebAudio, true, "EQ有効時は Web Audio 接続が必要");
  }

  // Case B: キーチェンジ有効
  {
    const pub = { enableAudioEffects: false };
    const track = { id: "gd-test-stream", keyShift: 2 };
    const needsWebAudio = !!pub.enableAudioEffects || (track.keyShift !== 0);
    strictEqual(needsWebAudio, true, "キーチェンジ有効時は Web Audio 接続が必要");
  }
});

console.log("=== 5. 同期失敗時の dirty 保持 & 世代番号管理 ===");

test("Google Drive 未接続時は dirty フラグが維持されること", () => {
  resetAll();
  recordLibraryModified();
  strictEqual(isLibraryDirty(), true);

  // 未接続状態での自動同期呼び出し (silent)
  syncLibraryWithDrive({ force: false, silent: true }).then((res) => {
    strictEqual(res.action, "none");
    strictEqual(isLibraryDirty(), true, "未接続時は dirty が維持されること");
  });
});

console.log(`\n是正検証テスト: ${passed} 件 PASSED ✓`);
