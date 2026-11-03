/**
 * test-drive-import-missing-tracks.mjs
 *
 * Google Drive インポート時のトラック消失防止・重複判定修正・ユーザーデータ保持の検証テスト
 *
 * 1. バリエーション曲 (Song, Song (Instrumental), Song (Live), Song [TV Size]) の独立保存検証
 * 2. 別アルバムの同名曲 (Intro, Interlude) およびアーティスト不明曲 (01, Track 1) の独立保存検証
 * 3. 同一 file ID の再インポート時のユーザーデータ完全保持 (playCount, loved, rating, memo, keyShift, lyrics, userEdited, user artwork等)
 * 4. buildDriveTrackRecord の単体検証
 * 5. fetchFolderAudioFilesRecursive のエラー耐性・401リフレッシュ・リトライ検証
 */

import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert";

// ==========================================
// テスト用グローバル環境モック (DOM / Storage / IndexedDB)
// ==========================================
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
};

globalThis.window = globalThis;
globalThis.screen = { width: 1170, height: 2532, colorDepth: 24 };
globalThis.document = {
  hidden: false,
  visibilityState: "visible",
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: (tag) => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
};

// IndexedDB インメモリDBモック
const idbTracks = new Map();
const idbBlobs = new Map();

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
            objectStore: (name) => ({
              get: (id) => {
                let val = undefined;
                if (name === "tracks") val = idbTracks.get(id);
                else if (name === "blobs") val = idbBlobs.get(id);
                const r = { result: val, onsuccess: null };
                queueMicrotask(() => {
                  if (r.onsuccess) r.onsuccess({ target: r });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
              },
              getAll: () => {
                let arr = [];
                if (name === "tracks") arr = Array.from(idbTracks.values());
                else if (name === "blobs") arr = Array.from(idbBlobs.values());
                const r = { result: arr, onsuccess: null };
                queueMicrotask(() => {
                  if (r.onsuccess) r.onsuccess({ target: r });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
              },
              put: (item, key) => {
                const k = key !== undefined ? key : (item && item.id);
                if (name === "tracks") idbTracks.set(k, { ...item });
                else if (name === "blobs") idbBlobs.set(k, item);
                const r = { result: k, onsuccess: null };
                queueMicrotask(() => {
                  if (r.onsuccess) r.onsuccess({ target: r });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
              },
              delete: (id) => {
                if (name === "tracks") idbTracks.delete(id);
                else if (name === "blobs") idbBlobs.delete(id);
                const r = { result: id, onsuccess: null };
                queueMicrotask(() => {
                  if (r.onsuccess) r.onsuccess({ target: r });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
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

// モジュール読み込み
const driveMod = await import("../js/gdrive/drive-service.js");
const libDbMod = await import("../js/store/library-db.js");
const settingsMod = await import("../js/store/settings.js");

console.log("=== 1. バリエーション曲・同名曲の独立保存テスト (重複判定すげ替え廃止の検証) ===");

await asyncTest("バリエーション曲 (Song, Song (Instrumental), Song (Live), Song [TV Size]) が同一IDに乗っ取られずすべて独立保存されること", async () => {
  idbTracks.clear();

  const driveFiles = [
    { id: "gd_file_v1", name: "Lemon.mp3", size: "8000000", mimeType: "audio/mpeg" },
    { id: "gd_file_v2", name: "Lemon (Instrumental).mp3", size: "7900000", mimeType: "audio/mpeg" },
    { id: "gd_file_v3", name: "Lemon (Live at Tokyo Dome).mp3", size: "8500000", mimeType: "audio/mpeg" },
    { id: "gd_file_v4", name: "Lemon [TV Size].mp3", size: "3000000", mimeType: "audio/mpeg" },
  ];

  // fetchDriveAudioHeader をモック
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      blob: async () => new Blob([], { type: "audio/mpeg" }),
    };
  };

  const { added, failed } = await driveMod.importDriveFilesToLibrary(driveFiles, {
    cacheBlobs: false,
    defaultAlbumName: "Lemon EP",
  });

  strictEqual(added, 4, "4曲すべて追加成功すること");
  strictEqual(failed, 0, "失敗は0件であること");

  const all = await libDbMod.getAllTracks();
  strictEqual(all.length, 4, "ライブラリに4曲すべてが独立して保存されていること");

  const trackIds = all.map((t) => t.id).sort();
  deepStrictEqual(trackIds, [
    "gd-gd_file_v1",
    "gd-gd_file_v2",
    "gd-gd_file_v3",
    "gd-gd_file_v4",
  ], "各曲のIDがそれぞれの Drive file ID に1対1で対応し、他曲を上書きしていないこと");
});

await asyncTest("別アルバムの同名曲 (Intro, Interlude) およびアーティスト不明曲 (01, Track 1) が共存保存されること", async () => {
  idbTracks.clear();

  // まずアルバムAの曲をインポート
  const albumAFiles = [
    { id: "gd_alb_a_1", name: "01 Intro.flac", size: "12000000", mimeType: "audio/flac" },
    { id: "gd_alb_a_2", name: "02 Track 1.flac", size: "25000000", mimeType: "audio/flac" },
  ];
  await driveMod.importDriveFilesToLibrary(albumAFiles, {
    cacheBlobs: false,
    defaultAlbumName: "Album Alpha",
  });

  // 次にアルバムBの同名曲をインポート
  const albumBFiles = [
    { id: "gd_alb_b_1", name: "01 Intro.flac", size: "14000000", mimeType: "audio/flac" },
    { id: "gd_alb_b_2", name: "02 Track 1.flac", size: "28000000", mimeType: "audio/flac" },
  ];
  const { added, failed } = await driveMod.importDriveFilesToLibrary(albumBFiles, {
    cacheBlobs: false,
    defaultAlbumName: "Album Beta",
  });

  strictEqual(added, 2, "アルバムBの2曲も追加成功すること");
  strictEqual(failed, 0);

  const all = await libDbMod.getAllTracks();
  strictEqual(all.length, 4, "アルバムAとアルバムBの同名曲が4曲すべて保存されていること");

  const trackA1 = all.find((t) => t.id === "gd-gd_alb_a_1");
  const trackB1 = all.find((t) => t.id === "gd-gd_alb_b_1");
  ok(trackA1, "アルバムAのIntroが存在すること");
  ok(trackB1, "アルバムBのIntroが存在すること");
  strictEqual(trackA1.album, "Album Alpha", "アルバムAのアルバム名が維持されていること");
  strictEqual(trackB1.album, "Album Beta", "アルバムBのアルバム名が維持されていること");
});

console.log("\n=== 2. 同一 file ID の再インポート時のユーザーデータ完全保持テスト ===");

await asyncTest("同一 Drive file ID の再インポート時、ユーザーデータが完全に保持され、実体情報のみ更新されること", async () => {
  idbTracks.clear();

  // 事前にユーザー編集済み・再生履歴ありのトラックを保存
  const initialTrack = {
    id: "gd-existing_song_123",
    driveFileId: "existing_song_123",
    title: "手動編集した曲名",
    artist: "手動編集したアーティスト",
    album: "手動編集したアルバム",
    albumArtist: "手動アルバムアーティスト",
    year: "2024",
    genre: "J-Rock",
    trackNo: "5",
    discNo: "1",
    memo: "ライブ定番曲・京都大作戦",
    keyShift: -2,
    loved: true,
    rating: 5,
    playCount: 42,
    lastPlayedAt: 1730000000000,
    addedAt: 1720000000000,
    enabled: true,
    userEdited: true,
    lyrics: "[00:10.00]テスト歌詞",
    artworkDataUrl: "data:image/jpeg;base64,USER_CUSTOM_ARTWORK",
    artworkBlob: null,
    artworkUpdatedAt: 1725000000000,
    _noEmbeddedArt: false,
    fileSize: 10000000,
    originalName: "old_filename.mp3",
    source: "gdrive",
    cached: true,
  };
  await libDbMod.putTrack(initialTrack, null);

  // Drive 側でファイル名やサイズ、更新日時が変わった同ファイルを再インポート
  const updatedDriveFile = {
    id: "existing_song_123",
    name: "new_filename_renamed.mp3",
    size: "10500000",
    modifiedTime: "2026-11-04T00:00:00Z",
    mimeType: "audio/mpeg",
  };

  const { added, failed } = await driveMod.importDriveFilesToLibrary([updatedDriveFile], {
    cacheBlobs: false,
    defaultAlbumName: "Different Folder",
  });

  strictEqual(added, 1);
  strictEqual(failed, 0);

  const updated = await libDbMod.getTrack("gd-existing_song_123");
  ok(updated, "トラックが存在すること");

  // 1. 保持されるべきユーザーデータ
  strictEqual(updated.title, "手動編集した曲名", "userEdited の title が保持されること");
  strictEqual(updated.artist, "手動編集したアーティスト", "userEdited の artist が保持されること");
  strictEqual(updated.album, "手動編集したアルバム", "userEdited の album が保持されること");
  strictEqual(updated.albumArtist, "手動アルバムアーティスト", "userEdited の albumArtist が保持されること");
  strictEqual(updated.year, "2024", "userEdited の year が保持されること");
  strictEqual(updated.genre, "J-Rock", "userEdited の genre が保持されること");
  strictEqual(updated.trackNo, "5", "userEdited の trackNo が保持されること");
  strictEqual(updated.memo, "ライブ定番曲・京都大作戦", "memo が保持されること");
  strictEqual(updated.keyShift, -2, "keyShift が保持されること");
  strictEqual(updated.loved, true, "loved (favorite) が保持されること");
  strictEqual(updated.rating, 5, "rating が保持されること");
  strictEqual(updated.playCount, 42, "playCount が保持されること");
  strictEqual(updated.lastPlayedAt, 1730000000000, "lastPlayedAt が保持されること");
  strictEqual(updated.addedAt, 1720000000000, "addedAt が保持されること");
  strictEqual(updated.userEdited, true, "userEdited フラグが保持されること");
  strictEqual(updated.lyrics, "[00:10.00]テスト歌詞", "lyrics が保持されること");
  strictEqual(updated.artworkDataUrl, "data:image/jpeg;base64,USER_CUSTOM_ARTWORK", "カスタムアートワークが保持されること");
  strictEqual(updated.artworkUpdatedAt, 1725000000000, "artworkUpdatedAt が保持されること");
  strictEqual(updated.cached, true, "cached 状態が保持されること");

  // 2. 更新されるべき Drive 実体情報
  strictEqual(updated.originalName, "new_filename_renamed.mp3", "変更されたファイル名が更新されること");
  strictEqual(updated.fileSize, 10500000, "変更されたファイルサイズが更新されること");
  strictEqual(updated.driveModifiedTime, "2026-11-04T00:00:00Z", "Drive modifiedTime が記録されること");
});

console.log("\n=== 3. buildDriveTrackRecord 単体テスト ===");

await asyncTest("buildDriveTrackRecord: メタデータ優先度とフィールド構造の検証", async () => {
  const file = { id: "test_file_999", name: "03. My Artist - Great Song.mp3", size: "5000000" };
  const inferred = { title: "Great Song", artist: "My Artist", album: "My Album", trackNo: "3" };
  const extractedMeta = { title: "Tag Title", artist: "Tag Artist", album: "Tag Album", duration: 210, trackNo: "3" };

  const rec = driveMod.buildDriveTrackRecord({
    file,
    existing: null,
    extractedMeta,
    inferred,
    folder: "My Album Folder",
  });

  strictEqual(rec.id, "gd-test_file_999");
  strictEqual(rec.title, "Tag Title", "タグタイトルが推測より優先されること");
  strictEqual(rec.artist, "Tag Artist", "タグアーティストが推測より優先されること");
  strictEqual(rec.album, "Tag Album", "タグアルバムがフォルダ名より優先されること");
  strictEqual(rec.duration, 210);
  strictEqual(rec.trackNo, "3");
  strictEqual(rec.fileSize, 5000000);
  strictEqual(rec.source, "gdrive");
});

console.log("\n=== 4. fetchFolderAudioFilesRecursive エラー耐性・リフレッシュテスト ===");

await asyncTest("fetchFolderAudioFilesRecursive: 401時にトークンをリフレッシュして取得を完遂すること", async () => {
  settingsMod.setPublic({ gdriveClientId: "mock_client_id", gdriveUserEmail: "test@example.com" });
  let fetchAttempts = 0;

  // GIS モック
  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient(cfg) {
          return {
            requestAccessToken() {
              setTimeout(() => {
                cfg.callback({
                  access_token: "ya29.refreshed_token",
                  expires_in: 3600,
                });
              }, 5);
            },
          };
        },
      },
    },
  };

  // 1回目用のトークン
  await driveMod.setDriveToken("ya29.initial_token", { email: "test@example.com" });

  globalThis.fetch = async (url, opts) => {
    fetchAttempts++;
    const u = String(url);
    const authHeader = opts?.headers?.Authorization || "";

    // GIS サイレント更新時のユーザー情報確認リクエスト (about)
    if (u.includes("googleapis.com/drive/v3/about")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            emailAddress: "test@example.com",
            displayName: "Test User",
          },
        }),
      };
    }

    // 1回目のリクエストで 401 を返す
    if (authHeader.includes("ya29.initial_token")) {
      return { ok: false, status: 401, json: async () => ({}) };
    }

    // リフレッシュ後のトークンで正常応答
    return {
      ok: true,
      status: 200,
      json: async () => ({
        files: [
          { id: "sub_file_1", name: "Song1.mp3", mimeType: "audio/mpeg", size: "5000000" },
          { id: "sub_file_2", name: "Song2.mp3", mimeType: "audio/mpeg", size: "6000000" },
        ],
        nextPageToken: null,
      }),
    };
  };

  const audioFiles = await driveMod.fetchFolderAudioFilesRecursive("root_folder_test");
  strictEqual(audioFiles.length, 2, "401発生後もリフレッシュされて全2曲が取得されること");
  strictEqual(audioFiles[0].id, "sub_file_1");
  strictEqual(audioFiles[1].id, "sub_file_2");
});

console.log(`\n全 ${passed} 件のテストに合格しました ✓`);
process.exit(0);
