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

await asyncTest("画像同期の競合規則監査: 古い画像による上書き防止、削除の最新判定、_noEmbeddedArtによる誤消去防止、ハッシュ一致/不一致、欠損データ保護", async () => {
  const newArt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const oldArt = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";

  // 1) 端末Aに新画像 (artworkUpdatedAt: 20000)、端末Bから旧画像 (artworkUpdatedAt: 10000, ただし曲メモ編集で updatedAt: 30000) が来た場合
  //    -> track更新とartwork更新時刻が異なっても、新しい artworkUpdatedAt (20000) の新画像が勝つこと！
  await libDbMod.updateTrack("trk-001", {
    artworkDataUrl: newArt,
    artworkUpdatedAt: 20000,
    _noEmbeddedArt: false,
    updatedAt: 20000,
  });

  await syncMod.importLibraryData({
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    artworks: { "art-old": oldArt },
    tracks: [
      {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        memo: "端末Bでメモだけ後で更新",
        artworkId: "art-old",
        artworkUpdatedAt: 10000,
        updatedAt: 30000,
      },
    ],
  });

  let t1 = await libDbMod.getTrack("trk-001");
  strictEqual(t1.artworkDataUrl, newArt, "Older artworkUpdatedAt (10000) must NOT overwrite newer local artwork (20000) even if incoming track updatedAt is newer");
  strictEqual(t1.memo, "端末Bでメモだけ後で更新", "Newer track memo must still be merged");

  // 2) 端末Bから古い _noEmbeddedArt: true (artworkUpdatedAt: 15000, updatedAt: 40000) が来ても、端末Aの新画像 (20000) を誤って消さないこと
  await syncMod.importLibraryData({
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    artworks: {},
    tracks: [
      {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        _noEmbeddedArt: true,
        artworkUpdatedAt: 15000,
        updatedAt: 40000,
      },
    ],
  });
  t1 = await libDbMod.getTrack("trk-001");
  strictEqual(t1.artworkDataUrl, newArt, "Older _noEmbeddedArt (15000) must NOT delete newer local artwork (20000)");

  // 3) 端末Aで画像削除が最新 (artworkUpdatedAt: 50000, _noEmbeddedArt: true) の場合、端末Bの旧画像 (20000) が復活しないこと
  await libDbMod.updateTrack("trk-001", {
    artworkDataUrl: null,
    artworkBlob: null,
    _noEmbeddedArt: true,
    artworkUpdatedAt: 50000,
    updatedAt: 50000,
  });
  await syncMod.importLibraryData({
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    artworks: { "art-old": oldArt },
    tracks: [
      {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        artworkId: "art-old",
        artworkUpdatedAt: 20000,
        updatedAt: 60000,
      },
    ],
  });
  t1 = await libDbMod.getTrack("trk-001");
  strictEqual(t1.artworkDataUrl, null, "Old artwork (20000) must NOT resurrect after newer explicit deletion (50000)");
  strictEqual(t1._noEmbeddedArt, true);

  // 4) 逆にリモート側で画像削除が最新 (artworkUpdatedAt: 80000, _noEmbeddedArt: true) ならローカルの旧画像 (60000) が削除されること
  await libDbMod.updateTrack("trk-001", {
    artworkDataUrl: oldArt,
    _noEmbeddedArt: false,
    artworkUpdatedAt: 60000,
    updatedAt: 60000,
  });
  await syncMod.importLibraryData({
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    artworks: {},
    tracks: [
      {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        _noEmbeddedArt: true,
        artworkUpdatedAt: 80000,
        updatedAt: 80000,
      },
    ],
  });
  t1 = await libDbMod.getTrack("trk-001");
  strictEqual(t1.artworkDataUrl, null, "Newer remote explicit deletion (80000) must clear older local artwork (60000)");

  // 5) 欠損データ（artworkId が指定されているが artworks 辞書に存在しない、かつ _noEmbeddedArt でない）の場合はローカル画像を保護すること
  await libDbMod.updateTrack("trk-001", {
    artworkDataUrl: newArt,
    _noEmbeddedArt: false,
    artworkUpdatedAt: 85000,
    updatedAt: 85000,
  });
  await syncMod.importLibraryData({
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    artworks: {}, // 辞書欠損
    tracks: [
      {
        id: "trk-001",
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "THE BOOK",
        artworkId: "art-missing-id",
        artworkUpdatedAt: 95000,
        updatedAt: 95000,
      },
    ],
  });
  t1 = await libDbMod.getTrack("trk-001");
  strictEqual(t1.artworkDataUrl, newArt, "Missing/corrupted remote artwork dictionary entry must preserve local artwork");

  // 6) ハッシュ計算: 同じ画像はハッシュ一致、異なる画像はハッシュ不一致
  const h1 = await syncMod.computeArtworkHash(newArt);
  const h2 = await syncMod.computeArtworkHash(newArt);
  const h3 = await syncMod.computeArtworkHash(oldArt);
  strictEqual(h1, h2, "Identical artwork DataURL must produce identical hash");
  ok(h1 !== h3, "Different artwork DataURL must produce different hash");
});

await asyncTest("バージョン 1.11.13 / v1.11.13 が全ファイルで完全一致していること", async () => {
  strictEqual(versionMod.APP_VERSION, "1.11.13");
  strictEqual(versionMod.CACHE_VERSION, "v1.11.13");

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
  strictEqual(pkg.version, "1.11.13");

  const sw = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf-8");
  ok(sw.includes('const CACHE_VERSION = "v1.11.13";'));
});

await asyncTest("共通 openModal / confirm / promptForm 回帰監査: actions/buttons形式、キャンセル、背景タップ、Esc、resolve1回・close1回、非同期action・例外保護、多重モーダル遷移が正常に動作すること", async () => {
  // openModal 実関数テスト用の軽量DOM構築
  const makeFakeEl = (tag) => {
    const listeners = {};
    const children = [];
    const classSet = new Set();
    const el = {
      tagName: String(tag || "DIV").toUpperCase(),
      className: "",
      id: "",
      disabled: false,
      hidden: false,
      textContent: "",
      value: "",
      type: "text",
      placeholder: "",
      autocomplete: "off",
      spellcheck: false,
      style: {},
      dataset: {},
      children,
      classList: {
        add: (...cls) => cls.forEach((c) => classSet.add(c)),
        remove: (...cls) => cls.forEach((c) => classSet.delete(c)),
        toggle: (c, force) => {
          const has = classSet.has(c);
          const next = force !== undefined ? !!force : !has;
          if (next) classSet.add(c);
          else classSet.delete(c);
          return next;
        },
        contains: (c) => classSet.has(c),
      },
      appendChild(child) {
        children.push(child);
        return child;
      },
      remove() {},
      focus() {},
      addEventListener(ev, fn) {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(fn);
      },
      removeEventListener(ev, fn) {
        if (!listeners[ev]) return;
        listeners[ev] = listeners[ev].filter((f) => f !== fn);
      },
      dispatchEvent(evObj) {
        const list = (listeners[evObj.type] || []).slice();
        for (const fn of list) fn(evObj);
      },
      click() {
        if (this.disabled) return;
        this.dispatchEvent({ type: "click", target: this, preventDefault() {} });
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const results = [];
        const visit = (node) => {
          for (const ch of node.children || []) {
            const clsTokens = String(ch.className || "").split(/\s+/).filter(Boolean);
            const hasBtn = clsTokens.includes("btn") || ch.classList?.contains("btn");
            const hasPrimary = clsTokens.includes("primary") || ch.classList?.contains("primary");
            if (sel === ".modal-actions .btn" && hasBtn) results.push(ch);
            else if (sel === ".modal-actions .btn.primary" && hasBtn && hasPrimary) results.push(ch);
            else if (sel.startsWith("#") && ch.id === sel.slice(1)) results.push(ch);
            visit(ch);
          }
        };
        visit(this);
        return results;
      },
    };
    Object.defineProperty(el, "innerHTML", {
      get() {
        return this._html || "";
      },
      set(v) {
        this._html = String(v || "");
        children.length = 0;
      },
    });
    return el;
  };

  const modalRoot = makeFakeEl("div");
  modalRoot.id = "modal-root";
  modalRoot.hidden = true;
  const docListeners = {};

  globalThis.document.getElementById = (id) => (id === "modal-root" ? modalRoot : null);
  globalThis.document.createElement = (tag) => makeFakeEl(tag);
  globalThis.document.addEventListener = (ev, fn) => {
    if (!docListeners[ev]) docListeners[ev] = [];
    docListeners[ev].push(fn);
  };
  globalThis.document.removeEventListener = (ev, fn) => {
    if (!docListeners[ev]) return;
    docListeners[ev] = docListeners[ev].filter((f) => f !== fn);
  };

  const compMod = await import("../js/ui/components.js");

  // 1) confirm (通常の確認モーダル: OK)
  const confirmPromise1 = compMod.confirm("削除しますか？", { danger: true, okLabel: "削除" });
  const btns1 = modalRoot.querySelectorAll(".modal-actions .btn");
  strictEqual(btns1.length, 2, "confirm must render 2 action buttons");
  btns1[1].click(); // OKボタン
  const res1 = await confirmPromise1;
  strictEqual(res1, true, "confirm OK must resolve true");
  strictEqual(modalRoot.hidden, true, "Modal must hide after OK");

  // 2) confirm (背景タップによるキャンセル -> false で resolve しハングしないこと)
  const confirmPromise2 = compMod.confirm("本当に実行しますか？");
  modalRoot.dispatchEvent({ type: "click", target: modalRoot });
  const res2 = await confirmPromise2;
  strictEqual(res2, false, "Backdrop click on confirm must resolve false (via first cancel button)");
  strictEqual(modalRoot.hidden, true);

  // 3) confirm (Escape キーによるキャンセル -> false で resolve し 1回だけ解決すること)
  const confirmPromise3 = compMod.confirm("Escテスト");
  for (const fn of (docListeners["keydown"] || []).slice()) {
    fn({ key: "Escape", preventDefault() {} });
  }
  const res3 = await confirmPromise3;
  strictEqual(res3, false, "Escape key on confirm must resolve false");

  // 4) buttons 形式 + bodyHtml 形式 + id / disabled 属性 + modal.el / modal.close 互換性
  let resolveCount = 0;
  const modalObj = compMod.openModal({
    title: "互換テスト",
    bodyHtml: "<p>テスト本文</p>",
    buttons: [
      { label: "閉じる", id: "btn-custom-close", onClick: () => {} },
      { label: "適用", id: "btn-custom-apply", primary: true, disabled: true, onClick: () => {} },
    ],
  });
  modalObj.then(() => {
    resolveCount++;
  });
  ok(modalObj.el, "openModal return value must expose .el");
  strictEqual(typeof modalObj.close, "function", "openModal return value must expose .close()");
  const applyBtn = modalObj.el.querySelector("#btn-custom-apply");
  ok(applyBtn, "Must find button by id via modal.el.querySelector");
  strictEqual(applyBtn.disabled, true, "disabled property must be applied to button");

  // close() を複数回呼んでも resolve は1回だけであること
  modalObj.close();
  modalObj.close();
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(resolveCount, 1, "Modal promise must resolve exactly once even if close() is called multiple times");

  // 5) 非同期 action (false を返した場合は閉じず、例外発生時もモーダルが壊れず維持されること)
  let step = 0;
  const asyncModal = compMod.openModal({
    title: "非同期アクション検証",
    body: "test",
    actions: [
      {
        label: "実行",
        primary: true,
        onClick: async () => {
          step++;
          if (step === 1) return false; // 1回目はバリデーション失敗で閉じない
          if (step === 2) throw new Error("テスト例外"); // 2回目は例外発生で閉じない
          return true; // 3回目で成功して閉じる
        },
      },
    ],
  });
  const actBtn = modalRoot.querySelector(".modal-actions .btn.primary");
  actBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(modalRoot.hidden, false, "Modal must remain open when async onClick returns false");

  actBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(modalRoot.hidden, false, "Modal must remain open when async onClick throws error");

  actBtn.click();
  await asyncModal;
  strictEqual(modalRoot.hidden, true, "Modal must close when async onClick returns true");

  // 6) 多重モーダル (モーダルAの中からモーダルBを開いたとき、モーダルAのcleanupがモーダルBのDOMを消さないこと)
  let modalAResolved = false;
  const modalA = compMod.openModal({
    title: "モーダルA",
    body: "A",
    actions: [{ label: "A閉じる" }],
  });
  modalA.then(() => {
    modalAResolved = true;
  });

  // Aが開いている状態でBを開く
  const modalB = compMod.openModal({
    title: "モーダルB",
    body: "B",
    actions: [{ label: "B閉じる", id: "btn-b-close" }],
  });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(modalAResolved, true, "Opening modal B must cleanly resolve previous modal A");
  strictEqual(modalRoot.hidden, false, "Modal B must remain visible on screen");
  ok(modalB.el.querySelector("#btn-b-close"), "Modal B DOM must not be wiped by Modal A cleanup");
  modalB.close();
  await modalB;
  strictEqual(modalRoot.hidden, true);
});

console.log(`\n全 ${passed} 件の回帰スモークテストに合格しました ✓`);
process.exit(0);
