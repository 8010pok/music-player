/**
 * test-artist-navigation-key-match.mjs
 *
 * アーティスト詳細画面へのキー遷移・正規化照合・URLラウンドトリップ・後方互換性テスト
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

await test("album-util.js の normalizeAlbumText がアーティスト専用記号の影響を受けず独立していること", () => {
  // normalizeAlbumText では \u02BC 等は通常クォートに変換されない（アルバム名の独自仕様を維持）
  strictEqual(normalizeAlbumText("Album’s Title"), "album's title");
  strictEqual(normalizeAlbumText("cali≠gari"), "cali≠gari");
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

console.log("\n=== 3. 20アーティストの実URLラウンドトリップ検証 (全5経路) ===");

const complexArtists = [
  "B'z",
  "B’z",
  "Bʼz",
  "the GazettE",
  "X JAPAN",
  "DIR EN GREY",
  "THE YELLOW MONKEY",
  "MUCC",
  "ムック",
  "Guns N' Roses",
  "L'Arc-en-Ciel",
  "D'espairsRay",
  "cali≠gari",
  "米津　玄師",
  "The   Beatles",
  "ずっと真夜中でいいのに。",
  "AC/DC",
  "100% Free",
  "Plus+Tech Squeeze Box",
  "YOASOBI & 初音ミク",
];

// テスト用DBへ投入
idbTracks.clear();
complexArtists.forEach((name, idx) => {
  idbTracks.set(String(idx + 1), {
    id: String(idx + 1),
    title: `Song of ${name}`,
    artist: name,
    albumArtist: name,
    album: `Album of ${name}`,
  });
});

await test("全20アーティストについて URL round-trip (key & name 併用) で view-artist.mount が成功すること", async () => {
  const allTracks = Array.from(idbTracks.values());
  const allArtists = groupTracksIntoArtists(allTracks);

  for (const name of complexArtists) {
    const artist = allArtists.find((a) => normalizeArtistText(a.name) === normalizeArtistText(name));
    ok(artist, `Artist must be found in allArtists: ${name}`);
    const key = artist.key;

    // 1. groupTracksIntoArtists -> artist.key 取得
    // 2. URLSearchParams へ格納
    // 3. URL 文字列化
    const qs = new URLSearchParams({ key, name }).toString();
    location.hash = `#/artist?${qs}`;

    // 4. view-artist.mount による再解決
    const root = createMockRoot();
    const cleanup = await viewArtist.mount(root);
    ok(typeof cleanup === "function", `mount must succeed for ${name} with hash ${location.hash}`);
    ok(root.innerHTML.length > 0, `root HTML must not be empty for ${name}`);
    cleanup();
  }
});

await test("全20アーティストについて key のみの新URL で view-artist.mount が成功すること", async () => {
  const allTracks = Array.from(idbTracks.values());
  const allArtists = groupTracksIntoArtists(allTracks);

  for (const name of complexArtists) {
    const artist = allArtists.find((a) => normalizeArtistText(a.name) === normalizeArtistText(name));
    const key = artist.key;

    const qs = new URLSearchParams({ key }).toString();
    location.hash = `#/artist?${qs}`;

    const root = createMockRoot();
    const cleanup = await viewArtist.mount(root);
    ok(typeof cleanup === "function", `mount must succeed for key-only ${name}`);
    cleanup();
  }
});

await test("全20アーティストについて name のみの旧URL (後方互換) で view-artist.mount が成功すること", async () => {
  for (const name of complexArtists) {
    const qs = new URLSearchParams({ name }).toString();
    location.hash = `#/artist?${qs}`;

    const root = createMockRoot();
    const cleanup = await viewArtist.mount(root);
    ok(typeof cleanup === "function", `mount must succeed for name-only legacy URL ${name}`);
    cleanup();
  }
});

await test("v1.11.17 形式のエンコード済みキー (art:%20 等) でも後方互換で view-artist.mount が成功すること", async () => {
  for (const name of complexArtists) {
    const encodedKey = `art:${encodeURIComponent(normalizeArtistText(name))}`;
    const qs = new URLSearchParams({ key: encodedKey }).toString();
    location.hash = `#/artist?${qs}`;

    const root = createMockRoot();
    const cleanup = await viewArtist.mount(root);
    ok(typeof cleanup === "function", `mount must succeed for v1.11.17 encoded key ${name}`);
    cleanup();
  }
});

await test("不正な key + 有効な name でも安全に name フォールバックで解決されること", async () => {
  const qs = new URLSearchParams({ key: "art:invalid_random_key_12345", name: "the GazettE" }).toString();
  location.hash = `#/artist?${qs}`;

  const root = createMockRoot();
  const cleanup = await viewArtist.mount(root);
  ok(typeof cleanup === "function", "the GazettE must resolve via name fallback");
  ok(root.innerHTML.includes("the GazettE"), "rendered name must match");
  cleanup();
});

console.log("\n=== 4. view-library.js の data-key 埋め込みとナビゲーション検証 ===");

await test("view-library.js でアーティスト行に data-key / data-name が出力され、go('artist', { key, name }) が呼ばれること", async () => {
  const fs = await import("node:fs");
  const libSrc = fs.readFileSync(new URL("../js/ui/view-library.js", import.meta.url), "utf8");
  ok(libSrc.includes('data-key="${escapeAttr(a.key)}"'), "artist-row に data-key が出力されていること");
  ok(libSrc.includes('data-name="${escapeAttr(a.name)}"'), "artist-row に data-name が出力されていること");
  ok(libSrc.includes("go(\"artist\", {"), "go('artist', ...) がオブジェクト形式で呼ばれること");
  ok(libSrc.includes("key: row.dataset.key"), "key が渡されていること");
  ok(libSrc.includes("name: row.dataset.name"), "name が渡されていること");
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
  cleanup();
});

console.log(`\n全 ${testCount} テスト PASSED ✓`);
