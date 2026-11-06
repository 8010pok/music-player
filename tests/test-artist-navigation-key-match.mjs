/**
 * test-artist-navigation-key-match.mjs
 *
 * アーティスト詳細画面へのキー遷移・正規化照合・B'zなどのアポストロフィ表記揺れ・旧URL後方互換性テスト
 */

import { strictEqual, ok, deepStrictEqual } from "node:assert";

// ==========================================
// 1. テスト用モック環境
// ==========================================
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
};
globalThis.sessionStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
};

globalThis.window = globalThis;
globalThis.location = {
  hash: "",
  replace(h) { this.hash = h; },
};
globalThis.history = {
  replaceState: (_st, _title, url) => {
    if (url) location.hash = url.startsWith("#") ? url : url.slice(url.indexOf("#"));
  },
  pushState: (_st, _title, url) => {
    if (url) location.hash = url.startsWith("#") ? url : url.slice(url.indexOf("#"));
  },
};

const idbTracks = new Map();

globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => ({
          objectStore: () => ({
            getAll: () => {
              const r = { result: Array.from(idbTracks.values()), onsuccess: null, onerror: null };
              setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
              return r;
            },
            get: (id) => {
              const r = { result: idbTracks.get(id) || null, onsuccess: null, onerror: null };
              setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
              return r;
            },
          }),
        }),
      },
      onsuccess: null,
      onerror: null,
    };
    setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
    return req;
  },
};

function createMockRoot() {
  let mountedHtml = "";
  const createDummyEl = () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {} },
    value: "",
    style: {},
  });

  return {
    set innerHTML(val) { mountedHtml = val; },
    get innerHTML() { return mountedHtml; },
    querySelector: (sel) => createDummyEl(),
    querySelectorAll: (sel) => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

// ==========================================
// 2. モジュールの動的 import
// ==========================================
const { normalizeAlbumText } = await import("../js/metadata/album-util.js");
const { normalizeArtistText, getArtistKey, groupTracksIntoArtists } = await import("../js/metadata/artist-util.js");
const viewArtist = await import("../js/ui/view-artist.js");

let testCount = 0;
async function test(name, fn) {
  testCount++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✕ ${name}`);
    throw err;
  }
}

console.log("=== 1. アポストロフィ系文字種と正規化 (normalizeArtistText & getArtistKey) ===");

await test("B'z の各種表記が同一キー 'art:b\\'z' に正規化されること", () => {
  const expectedKey = "art:b'z";
  const expectedNorm = "b'z";

  // 通常アポストロフィ U+0027
  strictEqual(normalizeArtistText("B'z"), expectedNorm);
  strictEqual(getArtistKey("B'z"), expectedKey);

  // 右シングルクォート (スマートクォート) U+2019
  strictEqual(normalizeArtistText("B’z"), expectedNorm);
  strictEqual(getArtistKey("B’z"), expectedKey);

  // Modifier Letter Apostrophe U+02BC
  strictEqual(normalizeArtistText("Bʼz"), expectedNorm);
  strictEqual(getArtistKey("Bʼz"), expectedKey);

  // 左シングルクォート U+2018 + 大文字
  strictEqual(normalizeArtistText("B‘Z"), expectedNorm);
  strictEqual(getArtistKey("B‘Z"), expectedKey);

  // 通常クォート + 全大文字
  strictEqual(normalizeArtistText("B'Z"), expectedNorm);
  strictEqual(getArtistKey("B'Z"), expectedKey);

  // 全角アポストロフィ U+FF07
  strictEqual(normalizeArtistText("B＇z"), expectedNorm);
  strictEqual(getArtistKey("B＇z"), expectedKey);

  // 前後空白つき
  strictEqual(normalizeArtistText("  B'z  "), expectedNorm);
  strictEqual(getArtistKey("  B'z  "), expectedKey);

  // ゼロ幅スペース (U+200B) や BOM (U+FEFF)
  strictEqual(normalizeArtistText("B\u200B'z\uFEFF"), expectedNorm);
  strictEqual(getArtistKey("B\u200B'z\uFEFF"), expectedKey);
});

await test("回帰アーティスト名 (Guns N' Roses, L'Arc-en-Ciel 等) が正常に正規化されること", () => {
  strictEqual(normalizeArtistText("Guns N’ Roses"), "guns n' roses");
  strictEqual(normalizeArtistText("Guns N' Roses"), "guns n' roses");
  strictEqual(getArtistKey("Guns N’ Roses"), getArtistKey("Guns N' Roses"));

  strictEqual(normalizeArtistText("L'Arc〜en〜Ciel"), "l'arc〜en〜ciel");
  strictEqual(normalizeArtistText("L’Arc〜en〜Ciel"), "l'arc〜en〜ciel");
  strictEqual(getArtistKey("L’Arc〜en〜Ciel"), getArtistKey("L'Arc〜en〜Ciel"));

  strictEqual(normalizeArtistText("D'espairsRay"), "d'espairsray");
  strictEqual(normalizeArtistText("D’espairsRay"), "d'espairsray");
  strictEqual(getArtistKey("D’espairsRay"), getArtistKey("D'espairsRay"));

  strictEqual(normalizeArtistText("Janne Da Arc"), "janne da arc");
});

await test("安全な正規化: cali≠gari などの正式な記号を誤統合しないこと", () => {
  const cali1 = normalizeArtistText("cali≠gari");
  const cali2 = normalizeArtistText("cali=gari");
  const cali3 = normalizeArtistText("cali-gari");

  strictEqual(cali1, "cali≠gari", "≠ 記号が保持されること");
  ok(cali1 !== cali2, "cali≠gari と cali=gari が統合されないこと");
  ok(cali1 !== cali3, "cali≠gari と cali-gari が統合されないこと");
});

console.log("\n=== 2. groupTracksIntoArtists によるグループ集約とキー検証 ===");

await test("表記の異なる B'z の曲が単一アーティストグループに統合され、key が付与されること", () => {
  const tracks = [
    { id: "1", title: "Ultra Soul", artist: "B'z", album: "GREEN" },
    { id: "2", title: "Love Phantom", artist: "B’z", album: "LOOSE" },
    { id: "3", title: "ALONE", artist: "Bʼz", album: "IN THE LIFE" },
  ];

  const artists = groupTracksIntoArtists(tracks);
  strictEqual(artists.length, 1, "表記揺れがあっても1人のアーティストにまとまること");

  const bz = artists[0];
  strictEqual(bz.key, "art:b'z", "グループキーが art:b'z であること");
  strictEqual(bz.tracks.length, 3, "全3曲が含まれていること");
  strictEqual(bz.name, "B'z", "先頭の表示名が維持されること");
});

console.log("\n=== 3. view-artist.js の照合と後方互換性テスト ===");

// テスト用トラックデータ投入
idbTracks.clear();
idbTracks.set("1", { id: "1", title: "Ultra Soul", artist: "B’z", albumArtist: "B’z", album: "GREEN" });
idbTracks.set("2", { id: "2", title: "Sweet Child O' Mine", artist: "Guns N' Roses", album: "Appetite" });
idbTracks.set("3", { id: "3", title: "浸食", artist: "L’Arc〜en〜Ciel", album: "ray" });
idbTracks.set("4", { id: "4", title: "マグロ", artist: "cali≠gari", album: "第7実験室" });

await test("artist.key による遷移: #/artist?key=art%3Ab'z で正常に B'z がマウントされること", async () => {
  location.hash = "#/artist?key=art%3Ab'z";
  const root = createMockRoot();

  const cleanup = await viewArtist.mount(root);
  ok(typeof cleanup === "function", "正常に mount され cleanup 関数が返ること");
  ok(root.innerHTML.includes("B’z") || root.innerHTML.includes("アーティスト"), "アーティスト画面がレンダリングされること");
  if (typeof cleanup === "function") cleanup();
});

await test("旧URL後方互換: #/artist?name=B%27z (通常クォート) で開けること", async () => {
  location.hash = "#/artist?name=B%27z";
  const root = createMockRoot();

  const cleanup = await viewArtist.mount(root);
  ok(typeof cleanup === "function", "旧URLでもマウントが成功すること");
  if (typeof cleanup === "function") cleanup();
});

await test("旧URL後方互換: #/artist?name=B%E2%80%99z (スマートクォート) で開けること", async () => {
  location.hash = "#/artist?name=B%E2%80%99z";
  const root = createMockRoot();

  const cleanup = await viewArtist.mount(root);
  ok(typeof cleanup === "function", "スマートクォートURLでもマウントが成功すること");
  if (typeof cleanup === "function") cleanup();
});

await test("旧URL後方互換: #/artist?name=B%CA%BCz (U+02BC Modifier Apostrophe) で開けること", async () => {
  location.hash = "#/artist?name=B%CA%BCz";
  const root = createMockRoot();

  const cleanup = await viewArtist.mount(root);
  ok(typeof cleanup === "function", "U+02BC URLでもマウントが成功すること");
  if (typeof cleanup === "function") cleanup();
});

await test("大文字小文字差・前後空白・ゼロ幅文字URLでも開けること", async () => {
  const variants = [
    "#/artist?name=b%27z",
    "#/artist?name=B%27Z",
    "#/artist?name=%20B%27z%20%20",
    "#/artist?name=B%E2%80%8B%27z", // ゼロ幅スペース
  ];

  for (const h of variants) {
    location.hash = h;
    const root = createMockRoot();
    const cleanup = await viewArtist.mount(root);
    ok(typeof cleanup === "function", `URL ${h} で正常にマウントできること`);
    if (typeof cleanup === "function") cleanup();
  }
});

await test("L'Arc〜en〜Ciel や Guns N' Roses のキーまたは名前でも正常に開けること", async () => {
  location.hash = `#/artist?key=${encodeURIComponent(getArtistKey("L'Arc〜en〜Ciel"))}`;
  const root1 = createMockRoot();
  const cleanup1 = await viewArtist.mount(root1);
  ok(typeof cleanup1 === "function", "L'Arc〜en〜Ciel がマウントできること");
  if (typeof cleanup1 === "function") cleanup1();

  location.hash = `#/artist?name=${encodeURIComponent("Guns N’ Roses")}`;
  const root2 = createMockRoot();
  const cleanup2 = await viewArtist.mount(root2);
  ok(typeof cleanup2 === "function", "Guns N' Roses がマウントできること");
  if (typeof cleanup2 === "function") cleanup2();
});

console.log("\n=== 4. view-library.js の data-key 埋め込みとナビゲーション検証 ===");

await test("view-library.js でアーティスト行に data-key 属性が出力されていること", async () => {
  const fs = await import("node:fs");
  const libSrc = fs.readFileSync(new URL("../js/ui/view-library.js", import.meta.url), "utf8");
  ok(libSrc.includes('data-key="${escapeAttr(a.key)}"'), "artist-row に data-key が出力されていること");
  ok(libSrc.includes('go("artist", { key: row.dataset.key })'), "click 時に data.key を優先して go('artist', ...) を呼ぶこと");
  ok(libSrc.includes('go("artist", { name: row.dataset.name })'), "dataset.name へのフォールバックが維持されていること");
});

await test("アルバム画面からの遷移: #/artist?name=... によるリンク生成と view-artist の受容検証", async () => {
  const fs = await import("node:fs");
  const albSrc = fs.readFileSync(new URL("../js/ui/view-album.js", import.meta.url), "utf8");
  ok(albSrc.includes('#/artist?name='), "view-album.js の既存リンク形式がそのまま維持されていること");

  // view-album が生成するリンク（例: #/artist?name=B%E2%80%99z）が view-artist で正常解決されること
  location.hash = `#/artist?name=${encodeURIComponent("B’z")}`;
  const root = createMockRoot();
  const cleanup = await viewArtist.mount(root);
  ok(typeof cleanup === "function", "アルバム詳細からの遷移リンクが正常に解決されること");
  if (typeof cleanup === "function") cleanup();
});

console.log(`\n全 ${testCount} テスト PASSED ✓`);
