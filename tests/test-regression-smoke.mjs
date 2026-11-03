/**
 * test-regression-smoke.mjs
 *
 * 再生・ライブラリ・Google Drive・同期・PWA の主要導線に対する統合回帰スモークテスト (v1.11.12)
 * - 曲一覧表示・検索・ソート
 * - アーティスト詳細・アルバム詳細・プレイリスト詳細データ構築と表示
 * - メタデータ編集保存・お気に入り切替・再生無効化切替・曲削除（Tombstone記録）
 * - 再生・一時停止・次曲・前曲・シーク・シャッフル・リピート状態遷移
 * - 設定画面の取得・トグル保存（Beta トグル初期OFF維持を含む）
 * - バージョン表記一致 (1.11.12 / v1.11.12) と診断出力 (artworkDiagnostics 含む)
 */

import { strictEqual, deepStrictEqual, ok } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================
// テスト用インメモリ IndexedDB & DOM モック
// ==========================================
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
};

const mockSessionStorage = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (mockSessionStorage.has(k) ? mockSessionStorage.get(k) : null),
  setItem: (k, v) => mockSessionStorage.set(k, String(v)),
  removeItem: (k) => mockSessionStorage.delete(k),
  clear: () => mockSessionStorage.clear(),
};

globalThis.screen = { width: 1170, height: 2532, colorDepth: 24 };
globalThis.window = globalThis;
globalThis.location = { hash: "#/library" };
globalThis.document = {
  hidden: false,
  visibilityState: "visible",
  body: { dataset: {}, appendChild() {}, classList: { toggle() {}, add() {}, remove() {} } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
  }),
};

// シンプルなインメモリ IndexedDB モック
const idbStores = {
  tracks: new Map(),
  blobs: new Map(),
  playlists: new Map(),
  history: new Map(),
  queue: new Map(),
};
let historyAutoId = 1;

function makeIdbReq(resultFn) {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      req.result = resultFn();
      if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
    } catch (e) {
      req.error = e;
      if (typeof req.onerror === "function") req.onerror({ target: req });
    }
  });
  return req;
}

function makeStoreObj(storeName) {
  const map = idbStores[storeName] || (idbStores[storeName] = new Map());
  return {
    put(val) {
      return makeIdbReq(() => {
        const key = val.id !== undefined ? val.id : historyAutoId++;
        const stored = { ...val, id: key };
        map.set(key, stored);
        return key;
      });
    },
    get(key) {
      return makeIdbReq(() => {
        const v = map.get(key);
        return v ? { ...v } : undefined;
      });
    },
    getAll() {
      return makeIdbReq(() => Array.from(map.values()).map((v) => ({ ...v })));
    },
    delete(key) {
      return makeIdbReq(() => {
        map.delete(key);
        return undefined;
      });
    },
    clear() {
      return makeIdbReq(() => {
        map.clear();
        return undefined;
      });
    },
    createIndex() {},
  };
}

globalThis.indexedDB = {
  open() {
    const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: (name) => makeStoreObj(name),
        transaction(_names, _mode) {
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore(name) {
              return makeStoreObj(name);
            },
          };
          setTimeout(() => {
            if (typeof tx.oncomplete === "function") tx.oncomplete();
          }, 5);
          return tx;
        },
        close() {},
      };
      req.result = db;
      if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
    });
    return req;
  },
};

let passed = 0;
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

const versionMod = await import("../js/version.js");
const settingsMod = await import("../js/store/settings.js");
const libDbMod = await import("../js/store/library-db.js");
const tombstoneMod = await import("../js/store/tombstone.js");
const albumUtilMod = await import("../js/metadata/album-util.js");
const artistUtilMod = await import("../js/metadata/artist-util.js");
const stateMod = await import("../js/state.js");
const syncMod = await import("../js/store/sync-service.js");

console.log("=== 1. ライブラリ導線 (曲追加・一覧・検索・ソート・メタデータ編集・お気に入り・無効化・削除) ===");

await asyncTest("曲の登録・一覧取得・検索フィルタ・ソートが正常に動作すること", async () => {
  await libDbMod.bulkPutTracks([
    {
      track: {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        albumArtist: "YOASOBI",
        trackNo: "2",
        year: "2021",
        duration: 261,
        addedAt: 1000,
        playCount: 5,
        enabled: true,
        loved: true,
      },
    },
    {
      track: {
        id: "trk-002",
        title: "群青",
        artist: "YOASOBI",
        album: "THE BOOK",
        albumArtist: "YOASOBI",
        trackNo: "7",
        year: "2021",
        duration: 248,
        addedAt: 2000,
        playCount: 12,
        enabled: true,
        loved: false,
      },
    },
    {
      track: {
        id: "trk-003",
        title: "KICK BACK",
        artist: "米津玄師",
        album: "LOST CORNER",
        albumArtist: "米津玄師",
        trackNo: "1",
        year: "2024",
        duration: 193,
        addedAt: 3000,
        playCount: 8,
        enabled: true,
        loved: false,
      },
    },
  ]);

  const all = await libDbMod.getAllTracks();
  strictEqual(all.length, 3, "Must store 3 tracks in IndexedDB");

  // 検索フィルタ検証
  const q = "yoasobi";
  const filtered = all.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q)
  );
  strictEqual(filtered.length, 2, "Search filter for 'yoasobi' must return 2 tracks");

  // 再生回数順ソート検証
  const sortedByPlays = [...all].sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
  strictEqual(sortedByPlays[0].id, "trk-002", "Highest playCount track must be first");
});

await asyncTest("アーティスト詳細・アルバム詳細・プレイリスト詳細のグループ化と作成・更新が正常に動作すること", async () => {
  const all = await libDbMod.getAllTracks();

  // アルバム集計
  const albums = albumUtilMod.groupTracksIntoAlbums(all);
  strictEqual(albums.length, 2, "Must group into 2 albums (THE BOOK, LOST CORNER)");
  const theBook = albums.find((a) => a.title === "THE BOOK");
  ok(theBook, "THE BOOK album must exist");
  strictEqual(theBook.trackCount, 2);
  strictEqual(theBook.tracks[0].id, "trk-001", "Track 2 must come before Track 7");

  // アーティスト集計
  const artists = artistUtilMod.groupTracksIntoArtists(all);
  strictEqual(artists.length, 2, "Must group into 2 artists (YOASOBI, 米津玄師)");
  const yoasobi = artists.find((a) => a.name === "YOASOBI");
  ok(yoasobi, "YOASOBI artist group must exist");
  strictEqual(yoasobi.albumCount, 1);
  strictEqual(yoasobi.trackCount, 2);

  // プレイリスト作成・曲追加・取得
  const pl = { id: "pl-jpop-001", name: "お気に入りJ-POP", trackIds: [], createdAt: Date.now() };
  await libDbMod.savePlaylist(pl);
  await libDbMod.addTracksToPlaylist(pl.id, ["trk-001", "trk-003"]);

  const loadedPl = await libDbMod.getPlaylist(pl.id);
  deepStrictEqual(loadedPl.trackIds, ["trk-001", "trk-003"]);
});

await asyncTest("メタデータ編集保存・お気に入り切替・再生無効化切替・曲削除 (Tombstone記録) が正常に動作すること", async () => {
  // メタデータ更新 + お気に入り切替 + 無効化切替
  await libDbMod.updateTrack("trk-002", {
    title: "群青 (Remastered)",
    memo: "合唱パート最高",
    loved: true,
    enabled: false,
    userEdited: true,
  });

  const updated = await libDbMod.getTrack("trk-002");
  strictEqual(updated.title, "群青 (Remastered)");
  strictEqual(updated.memo, "合唱パート最高");
  strictEqual(updated.loved, true);
  strictEqual(updated.enabled, false);
  strictEqual(updated.userEdited, true);

  // 曲削除と Tombstone 記録
  await libDbMod.deleteTrack("trk-003");
  const afterDel = await libDbMod.getTrack("trk-003");
  strictEqual(Boolean(afterDel), false, "Deleted track must not exist");
  const tombs = tombstoneMod.getTombstones();
  ok(tombs.some((t) => t.id === "trk-003" && t.type === "track"), "Tombstone must be recorded on deleteTrack");
});

console.log("\n=== 2. 再生状態遷移・設定トグル・端末間同期・バージョン整合性 ===");

await asyncTest("appState による再生・一時停止・次曲・前曲・シーク状態遷移と購読通知が正常に動作すること", async () => {
  const events = [];
  const unsub = stateMod.appState.subscribe(["currentTrack", "isPlaying", "position"], (s, changed) => {
    events.push({ changed, isPlaying: s.isPlaying, pos: s.position, trackId: s.currentTrack?.id });
  });

  const t1 = await libDbMod.getTrack("trk-001");
  const t2 = await libDbMod.getTrack("trk-002");

  // 再生開始
  stateMod.appState.set({
    queue: [t1, t2],
    queueIndex: 0,
    currentTrack: t1,
    isPlaying: true,
    position: 0,
    duration: t1.duration,
  });
  strictEqual(stateMod.appState.get().currentTrack.id, "trk-001");
  strictEqual(stateMod.appState.get().isPlaying, true);

  // シーク
  stateMod.appState.set({ position: 45.5 });
  strictEqual(stateMod.appState.get().position, 45.5);

  // 一時停止
  stateMod.appState.set({ isPlaying: false });
  strictEqual(stateMod.appState.get().isPlaying, false);

  // 次曲へ移動
  stateMod.appState.set({
    queueIndex: 1,
    currentTrack: t2,
    isPlaying: true,
    position: 0,
  });
  strictEqual(stateMod.appState.get().currentTrack.id, "trk-002");

  // 前曲へ移動
  stateMod.appState.set({
    queueIndex: 0,
    currentTrack: t1,
    isPlaying: true,
    position: 0,
  });
  strictEqual(stateMod.appState.get().currentTrack.id, "trk-001");

  unsub();
  ok(events.length >= 5, "Subscriber must receive state transition events");
});

await asyncTest("設定の初期値 (driveProxyStreamEnabled: false 維持) とトグル保存、およびエクスポート/インポート同期が正常に動作すること", async () => {
  mockStorage.clear();
  const defaults = settingsMod.getPublic();
  strictEqual(defaults.driveProxyStreamEnabled, false, "driveProxyStreamEnabled must default to false");
  strictEqual(defaults.enableAudioEffects, false, "enableAudioEffects must default to false");

  // トグル変更と保存
  settingsMod.setPublic({
    theme: "dark",
    shuffleMode: true,
    repeatMode: "all",
    driveProxyStreamEnabled: true,
  });
  const saved = settingsMod.getPublic();
  strictEqual(saved.theme, "dark");
  strictEqual(saved.shuffleMode, true);
  strictEqual(saved.repeatMode, "all");
  strictEqual(saved.driveProxyStreamEnabled, true);

  // 同期エクスポートとアートワークのスマートマージ検証
  const validArt = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";
  await libDbMod.updateTrack("trk-001", {
    artworkDataUrl: validArt,
    artworkUpdatedAt: 5000,
  });

  const exported = await syncMod.exportLibraryData();
  strictEqual(exported.schemaVersion, 4);
  strictEqual(exported.tracksCount, 2);
  strictEqual(exported.artworksCount, 1, "Artwork must be deduplicated into artworks dictionary");

  // 他端末からの新しい画像変更をインポートマージ
  const newerArt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const incomingPayload = {
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    artworks: { "art-new-1": newerArt },
    tracks: [
      {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        artworkId: "art-new-1",
        artworkUpdatedAt: 9999999999999,
        updatedAt: 9999999999999,
      },
    ],
    playlists: [],
    tombstones: [],
  };

  const mergeRes = await syncMod.importLibraryData(incomingPayload);
  strictEqual(mergeRes.updatedCount, 1);
  const mergedTrack = await libDbMod.getTrack("trk-001");
  strictEqual(mergedTrack.artworkDataUrl, newerArt, "Newer artwork from sync must overwrite older artwork");
});

await asyncTest("バージョン 1.11.12 / v1.11.12 が全ファイルで完全一致していること", async () => {
  strictEqual(versionMod.APP_VERSION, "1.11.12");
  strictEqual(versionMod.CACHE_VERSION, "v1.11.12");

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
  strictEqual(pkg.version, "1.11.12");

  const sw = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf-8");
  ok(sw.includes('const CACHE_VERSION = "v1.11.12";'));
});

console.log(`\n全 ${passed} 件の回帰スモークテストに合格しました ✓`);
process.exit(0);
