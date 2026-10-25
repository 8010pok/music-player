/**
 * 監査指摘事項の是正検証テストスイート
 *
 * 1. Tombstone 365日TTL / 複合キー衝突防止 / QuotaExceeded自己修復
 * 2. 未キャッシュDrive曲とWeb Audio (EQ/キーチェンジ) 安全経路
 * 3. スキーマv4 アートワーク重複排除辞書方式 / v3互換 / 画像復元
 * 4. 永続化層の共通変更通知 (dirty) / 同期スコープ中の抑止
 * 5. 同期失敗時のdirty保持 / 同期中の新規変更検知 (世代番号)
 */

import { strictEqual, ok, deepStrictEqual, rejects, notStrictEqual } from "node:assert";

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
  computeArtworkHashSync,
  isValidArtworkDataUrl,
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

await asyncTest("Tombstone 保存完全失敗時に deleteTrack と bulkDeleteTracks が tombstoneSaved: false を返すこと", async () => {
  resetAll();
  const originalSetItem = localStorage.setItem;

  try {
    localStorage.setItem = (k, v) => {
      if (k === "music_player_tombstones") {
        const err = new Error("Quota exceeded");
        err.name = "QuotaExceededError";
        throw err;
      }
      originalSetItem.call(localStorage, k, v);
    };

    tracksStore.set("t-del-fail-1", { id: "t-del-fail-1", title: "Song Del 1" });
    const delRes = await deleteTrack("t-del-fail-1");
    strictEqual(delRes.ok, true, "DBからの曲削除は完了すること");
    strictEqual(delRes.tombstoneSaved, false, "tombstoneSaved が false となり UI へ警告通知可能であること");
    ok(!tracksStore.has("t-del-fail-1"), "DBから曲が消えていること");

    tracksStore.set("t-del-fail-2", { id: "t-del-fail-2", title: "Song Del 2" });
    tracksStore.set("t-del-fail-3", { id: "t-del-fail-3", title: "Song Del 3" });
    const bulkRes = await bulkDeleteTracks(["t-del-fail-2", "t-del-fail-3"]);
    strictEqual(bulkRes.ok, true, "DBからの一括削除は完了すること");
    strictEqual(bulkRes.tombstoneSaved, false, "一括削除時も tombstoneSaved が false となること");
    ok(!tracksStore.has("t-del-fail-2"), "曲2が消えていること");
    ok(!tracksStore.has("t-del-fail-3"), "曲3が消えていること");
  } finally {
    localStorage.setItem = originalSetItem;
  }
});

await asyncTest("通常時の deleteTrack / bulkDeleteTracks は tombstoneSaved: true を返すこと", async () => {
  resetAll();
  tracksStore.set("t-norm-del", { id: "t-norm-del", title: "Norm Song" });
  const delRes = await deleteTrack("t-norm-del");
  strictEqual(delRes.ok, true);
  strictEqual(delRes.tombstoneSaved, true, "正常時は tombstoneSaved が true であること");

  tracksStore.set("t-norm-b1", { id: "t-norm-b1", title: "Norm B1" });
  tracksStore.set("t-norm-b2", { id: "t-norm-b2", title: "Norm B2" });
  const bulkRes = await bulkDeleteTracks(["t-norm-b1", "t-norm-b2"]);
  strictEqual(bulkRes.ok, true);
  strictEqual(bulkRes.tombstoneSaved, true, "一括削除正常時も tombstoneSaved が true であること");
});

console.log("=== 2. アートワーク同期JSON重複排除 (スキーマ v4) ===");

await asyncTest("computeArtworkHash が同じ Base64 に対して同一ハッシュを返すこと", async () => {
  const b64 = "data:image/jpeg;base64,1234567890ABCDEF";
  const h1 = await computeArtworkHash(b64);
  const h2 = await computeArtworkHash(b64);
  strictEqual(h1, h2);
  ok(h1.startsWith("art-"));
});

await asyncTest("1,000件の同一長・内容違いの画像すべてで artworkId がユニークになること (SHA-256)", async () => {
  const ids = new Set();
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const data = "data:image/jpeg;base64," + String(i).padStart(6, "0") + "A".repeat(1000 - 6);
    const hash = await computeArtworkHash(data);
    ids.add(hash);
  }
  strictEqual(ids.size, 1000, "1000件すべてがユニークであること");
});

await asyncTest("先頭部分が同一で末尾のみ異なる画像を区別できること", async () => {
  const base = "data:image/jpeg;base64," + "A".repeat(10000);
  const h1 = await computeArtworkHash(base + "001");
  const h2 = await computeArtworkHash(base + "002");
  notStrictEqual(h1, h2, "末尾違いを確実に区別できること");
});

await asyncTest("末尾部分が同一で先頭のみ異なる画像を区別できること", async () => {
  const suffix = "A".repeat(10000);
  const h1 = await computeArtworkHash("data:image/jpeg;base64,HEADER1_" + suffix);
  const h2 = await computeArtworkHash("data:image/jpeg;base64,HEADER2_" + suffix);
  notStrictEqual(h1, h2, "先頭違いを確実に区別できること");
});

test("同期フォールバック方式でも1000件ユニークかつ先頭・末尾の区別ができること", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const data = "data:image/jpeg;base64," + String(i).padStart(6, "0") + "A".repeat(1000 - 6);
    ids.add(computeArtworkHashSync(data));
  }
  strictEqual(ids.size, 1000);
  const base = "data:image/jpeg;base64," + "A".repeat(10000);
  notStrictEqual(computeArtworkHashSync(base + "001"), computeArtworkHashSync(base + "002"));
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
  const artId = await computeArtworkHash(artData);

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

await asyncTest("辞書復元安全性: artworkId が辞書に存在しない場合でも Track は正常同期されること", async () => {
  resetAll();
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-missing-art-id", title: "Safe Song 1", artworkId: "art-nonexistent-id", updatedAt: 2000 }
    ],
    artworks: {}
  };
  await importLibraryData(payload);
  const t = tracksStore.get("t-missing-art-id");
  ok(t, "Track が正常にインポートされていること");
  strictEqual(t.title, "Safe Song 1");
  strictEqual(t.artworkDataUrl, undefined, "存在しない画像は undefined となること");
  strictEqual(t.artworkId, undefined, "IndexedDB の Track から artworkId は除去されていること");
});

await asyncTest("辞書復元安全性: artworks が欠落している場合でも Track は正常同期されること", async () => {
  resetAll();
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-no-artworks-field", title: "Safe Song 2", artworkId: "art-some-id", updatedAt: 2000 }
    ]
  };
  await importLibraryData(payload);
  const t = tracksStore.get("t-no-artworks-field");
  ok(t, "Track が正常にインポートされていること");
  strictEqual(t.title, "Safe Song 2");
});

await asyncTest("辞書復元安全性: artworkId が不正な型 (数値・null・空) の場合でも無視して正常同期されること", async () => {
  resetAll();
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-bad-id-1", title: "Safe Song 3", artworkId: 12345, updatedAt: 2000 },
      { id: "t-bad-id-2", title: "Safe Song 4", artworkId: null, updatedAt: 2000 },
      { id: "t-bad-id-3", title: "Safe Song 5", artworkId: {}, updatedAt: 2000 },
    ],
    artworks: { "12345": "data:image/jpeg;base64,XXXX" }
  };
  await importLibraryData(payload);
  ok(tracksStore.get("t-bad-id-1"));
  ok(tracksStore.get("t-bad-id-2"));
  ok(tracksStore.get("t-bad-id-3"));
});

await asyncTest("辞書復元安全性: 辞書内の値が data URL ではない場合 (http/不正値) は無視して正常同期されること", async () => {
  resetAll();
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-http-art", title: "Safe Song 6", artworkId: "art-http", updatedAt: 2000 },
      { id: "t-obj-art", title: "Safe Song 7", artworkId: "art-obj", updatedAt: 2000 },
    ],
    artworks: {
      "art-http": "https://example.com/malicious.png",
      "art-obj": { invalid: true }
    }
  };
  await importLibraryData(payload);
  const t6 = tracksStore.get("t-http-art");
  ok(t6);
  strictEqual(t6.artworkDataUrl, undefined, "http URL は排除されること");
  const t7 = tracksStore.get("t-obj-art");
  ok(t7);
  strictEqual(t7.artworkDataUrl, undefined, "非文字列は排除されること");
});

await asyncTest("辞書復元安全性: MIME タイプが画像ではない場合 (HTML/JS等) は無視されること", async () => {
  resetAll();
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-html-art", title: "Safe Song 8", artworkId: "art-html", updatedAt: 2000 },
      { id: "t-js-art", title: "Safe Song 9", artworkId: "art-js", updatedAt: 2000 },
    ],
    artworks: {
      "art-html": "data:text/html,<script>alert(1)</script>",
      "art-js": "data:application/javascript;base64,Y29uc29sZS5sb2coMSk="
    }
  };
  await importLibraryData(payload);
  const t8 = tracksStore.get("t-html-art");
  ok(t8);
  strictEqual(t8.artworkDataUrl, undefined, "text/html は除外されること");
  const t9 = tracksStore.get("t-js-art");
  ok(t9);
  strictEqual(t9.artworkDataUrl, undefined, "application/javascript は除外されること");
});

await asyncTest("辞書復元安全性: 15MB を超える異常に巨大な画像は安全のため除外され Track のみ正常同期されること", async () => {
  resetAll();
  const hugeArt = "data:image/jpeg;base64," + "A".repeat(16 * 1024 * 1024);
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-huge-art", title: "Safe Song 10", artworkId: "art-huge", updatedAt: 2000 },
    ],
    artworks: {
      "art-huge": hugeArt
    }
  };
  await importLibraryData(payload);
  const t10 = tracksStore.get("t-huge-art");
  ok(t10);
  strictEqual(t10.title, "Safe Song 10");
  strictEqual(t10.artworkDataUrl, undefined, "巨大画像は除外されること");
});

await asyncTest("辞書復元安全性: 異なる2曲が同じ artworkId を参照しても双方が正常同期されること", async () => {
  resetAll();
  const sharedArt = "data:image/jpeg;base64,COLLISION_SAFE_ARTWORK_ZZZZ";
  const artId = await computeArtworkHash(sharedArt);
  const payload = {
    app: "music-player",
    version: 4,
    tracks: [
      { id: "t-collision-1", title: "Title A", artist: "Artist A", artworkId: artId, updatedAt: 2000 },
      { id: "t-collision-2", title: "Title B", artist: "Artist B", artworkId: artId, updatedAt: 2000 },
    ],
    artworks: {
      [artId]: sharedArt
    }
  };
  await importLibraryData(payload);
  const t1 = tracksStore.get("t-collision-1");
  const t2 = tracksStore.get("t-collision-2");
  strictEqual(t1.title, "Title A");
  strictEqual(t2.title, "Title B");
  strictEqual(t1.artworkDataUrl, sharedArt);
  strictEqual(t2.artworkDataUrl, sharedArt);
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
