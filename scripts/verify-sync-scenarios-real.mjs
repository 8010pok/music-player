import { strictEqual, ok, deepStrictEqual } from "node:assert";

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
const playlistsStore = new Map();

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
              const target = name === "playlists" ? playlistsStore : tracksStore;
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

const { importLibraryData, exportLibraryData } = await import("../js/store/sync-service.js");
const { getTombstones, recordTombstone, clearTombstones, mergeTombstones } = await import("../js/store/tombstone.js");

console.log("=== 実sync-service.js を使った手動同期 8大シナリオ検証 ===");

// 共通リセット関数
function resetAll() {
  tracksStore.clear();
  playlistsStore.clear();
  localStorage.clear();
}

// ----------------------------------------------------
// シナリオ 1: Aで曲を追加し、Bで同期
// ----------------------------------------------------
{
  resetAll();
  const track1 = { id: "trk-1", title: "Song 1", artist: "Artist A", duration: 180, addedAt: Date.now() };
  tracksStore.set("trk-1", track1);

  const exportedA = await exportLibraryData();
  resetAll(); // 端末B環境

  await importLibraryData(exportedA);
  ok(tracksStore.has("trk-1"), "シナリオ1: 端末Bに曲1が同期されること");
  strictEqual(tracksStore.get("trk-1").title, "Song 1");
  console.log("✓ シナリオ 1 PASS: Aで曲追加 -> Bで同期");
}

// ----------------------------------------------------
// シナリオ 2: Aで曲を編集し、Bで同期
// ----------------------------------------------------
{
  resetAll();
  const original = { id: "trk-1", title: "Song 1", artist: "Artist A", duration: 180, updatedAt: 1000 };
  tracksStore.set("trk-1", original);

  // Aで編集
  tracksStore.set("trk-1", { ...original, title: "Song 1 (Remaster)", memo: "Live ver", updatedAt: 2000, userEdited: true });
  const exportedA = await exportLibraryData();

  // B環境 (編集前を保持)
  resetAll();
  tracksStore.set("trk-1", original);

  await importLibraryData(exportedA);
  strictEqual(tracksStore.get("trk-1").title, "Song 1 (Remaster)", "タイトル更新が反映されること");
  strictEqual(tracksStore.get("trk-1").memo, "Live ver", "memo更新が反映されること");
  console.log("✓ シナリオ 2 PASS: Aで曲編集 -> Bで同期");
}

// ----------------------------------------------------
// シナリオ 3: Aで曲を削除し、Bで同期
// ----------------------------------------------------
{
  resetAll();
  const t = { id: "trk-1", title: "Song 1", artist: "Artist A", duration: 180, updatedAt: 1000 };
  tracksStore.set("trk-1", t);

  // Aで削除
  tracksStore.delete("trk-1");
  recordTombstone("trk-1", "track", Date.now());

  const exportedA = await exportLibraryData();
  ok(exportedA.tombstones.some(tb => tb.id === "trk-1"), "エクスポートデータにTombstoneが含まれること");

  // B環境 (まだ曲を持っている)
  resetAll();
  tracksStore.set("trk-1", t);

  await importLibraryData(exportedA);
  ok(!tracksStore.has("trk-1"), "B環境でも曲1が削除されていること");
  ok(getTombstones().some(tb => tb.id === "trk-1"), "B環境にもTombstoneが保存されること");
  console.log("✓ シナリオ 3 PASS: Aで曲削除 -> Bで同期");
}

// ----------------------------------------------------
// シナリオ 4: Aでプレイリストを追加し、Bで同期
// ----------------------------------------------------
{
  resetAll();
  const pl1 = { id: "pl-1", name: "Favorites", trackIds: ["trk-1", "trk-2"], updatedAt: 1000 };
  playlistsStore.set("pl-1", pl1);

  const exportedA = await exportLibraryData();
  resetAll(); // B環境

  await importLibraryData(exportedA);
  ok(playlistsStore.has("pl-1"), "B環境にプレイリストが同期されること");
  deepStrictEqual(playlistsStore.get("pl-1").trackIds, ["trk-1", "trk-2"]);
  console.log("✓ シナリオ 4 PASS: Aでプレイリスト追加 -> Bで同期");
}

// ----------------------------------------------------
// シナリオ 5: Aでプレイリストから曲を削除し、Bで同期
// ----------------------------------------------------
{
  resetAll();
  const pl1 = { id: "pl-1", name: "Favorites", trackIds: ["trk-1", "trk-2"], updatedAt: 1000 };
  // Aで更新
  playlistsStore.set("pl-1", { ...pl1, trackIds: ["trk-1"], updatedAt: 2000 });

  const exportedA = await exportLibraryData();

  // B環境 (旧プレイリスト)
  resetAll();
  playlistsStore.set("pl-1", pl1);

  await importLibraryData(exportedA);
  deepStrictEqual(playlistsStore.get("pl-1").trackIds, ["trk-1"], "プレイリスト内の曲削除がBに反映されること");
  console.log("✓ シナリオ 5 PASS: Aでプレイリストから曲削除 -> Bで同期");
}

// ----------------------------------------------------
// シナリオ 6: AとBで別々の曲を追加してから同期
// ----------------------------------------------------
{
  resetAll();
  tracksStore.set("trk-A", { id: "trk-A", title: "Song A", updatedAt: 1000 });
  const exportedA = await exportLibraryData();

  // B環境 (trk-B を持っている)
  resetAll();
  tracksStore.set("trk-B", { id: "trk-B", title: "Song B", updatedAt: 1000 });

  // B が Aのデータをインポート
  await importLibraryData(exportedA);
  ok(tracksStore.has("trk-A") && tracksStore.has("trk-B"), "Bに双方の曲が存在すること");

  // B からエクスポートして A にインポート
  const exportedB = await exportLibraryData();
  resetAll();
  tracksStore.set("trk-A", { id: "trk-A", title: "Song A", updatedAt: 1000 });

  await importLibraryData(exportedB);
  ok(tracksStore.has("trk-A") && tracksStore.has("trk-B"), "Aにも双方の曲が存在すること");
  console.log("✓ シナリオ 6 PASS: AとBで別々の曲を追加してから同期");
}

// ----------------------------------------------------
// シナリオ 7: AとBで同じ曲の異なる項目を編集してから同期
// ----------------------------------------------------
{
  resetAll();
  const base = { id: "trk-common", title: "Common Song", keyShift: 0, rating: 0, memo: "", loved: false, updatedAt: 1000 };
  // A edits keyShift and rating
  tracksStore.set("trk-common", { ...base, keyShift: 2, rating: 5, updatedAt: 2000 });
  const exportedA = await exportLibraryData();

  // B edits memo and loved
  resetAll();
  tracksStore.set("trk-common", { ...base, memo: "Awesome vibe", loved: true, updatedAt: 2000 });

  await importLibraryData(exportedA);
  const mergedInB = tracksStore.get("trk-common");

  console.log("マージ結果 (B側):", {
    title: mergedInB.title,
    keyShift: mergedInB.keyShift,
    rating: mergedInB.rating,
    memo: mergedInB.memo,
    loved: mergedInB.loved
  });

  // 検証:
  // keyShift: 2 (Aで変更)
  // rating: 5 (Aで変更)
  // loved: true (Bで変更)
  // memo: "Awesome vibe" (Bで変更され、Aからの空memoで潰されず維持)
  strictEqual(mergedInB.keyShift, 2, "AのkeyShiftが反映されること");
  strictEqual(mergedInB.rating, 5, "Aのratingが反映されること");
  strictEqual(mergedInB.loved, true, "Bのlovedが反映されること");
  strictEqual(mergedInB.memo, "Awesome vibe", "Bのmemoが維持されること");
  console.log("✓ シナリオ 7 PASS: AとBで同じ曲の異なる項目を編集してから同期");
}

// ----------------------------------------------------
// シナリオ 8: 30日以上同期していない端末から削除曲が復活しないか
// ----------------------------------------------------
{
  resetAll();
  const now = Date.now();
  const thirtyFiveDaysAgo = now - 35 * 24 * 60 * 60 * 1000;
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

  // Aで10日前に削除
  recordTombstone("trk-old", "track", tenDaysAgo);
  const exportedA = await exportLibraryData();

  // 35日間放置されていた端末C環境
  resetAll();
  tracksStore.set("trk-old", { id: "trk-old", title: "Old Song", updatedAt: thirtyFiveDaysAgo });

  await importLibraryData(exportedA);
  ok(!tracksStore.has("trk-old"), "35日前放置端末でもTombstoneにより曲が削除され復活しないこと");
  console.log("✓ シナリオ 8 PASS: 30日以上同期していない端末から削除曲が復活しないか");
}
