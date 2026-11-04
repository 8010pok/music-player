/**
 * test-drive-import-album-placement.mjs
 *
 * Google Drive インポート時のアルバム分類・明示的追加先 (importTarget)・安全な比較用正規化の検証テスト
 */

import { strictEqual, deepStrictEqual, ok } from "node:assert";

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
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
};

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

// モジュール動的インポート
const albumUtil = await import("../js/metadata/album-util.js");
const driveMod = await import("../js/gdrive/drive-service.js");
const libDbMod = await import("../js/store/library-db.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// fetch モック (ヘッダ取得用)
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(0),
  json: async () => ({ files: [] }),
});

console.log("=== 1. importTarget (明示的アルバム追加) テスト ===");

await test("新規曲: importTarget が埋め込みタグより優先され album と albumArtist が保存されること", async () => {
  idbTracks.clear();
  driveMod.clearImportAlbumDiagnoses();

  const driveFile = {
    id: "file_new_target_1",
    name: "01. Song.mp3",
    size: "5000000",
    mimeType: "audio/mpeg",
  };

  const importTarget = {
    targetType: "album",
    album: "ユーザーが指定した既存アルバム",
    albumArtist: "メインアーティスト",
    albumKey: "alb:%E3%83%A1%E3%82%A4%E3%83%B3%E3%82%A2%E3%83%BC%E3%83%86%E3%82%A3%E3%82%B9%E3%83%88:%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC%E3%81%8C%E6%8C%87%E5%AE%9A%E3%81%97%E3%81%9F%E6%97%A2%E5%AD%98%E3%82%A2%E3%83%AB%E3%83%90%E3%83%A0",
  };

  // buildDriveTrackRecord 単体検証
  const extractedMeta = {
    title: "Tag Song Title",
    artist: "Tag Sub Artist",
    album: "タグに書かれた別アルバム名",
    albumArtist: "タグの別アルバムアーティスト",
  };

  const rec = driveMod.buildDriveTrackRecord({
    file: driveFile,
    existing: null,
    extractedMeta,
    inferred: { title: "Song", artist: "", album: "FolderName" },
    folder: "FolderName",
    importTarget,
  });

  strictEqual(rec.album, "ユーザーが指定した既存アルバム", "importTarget.album が最優先されること");
  strictEqual(rec.albumArtist, "メインアーティスト", "importTarget.albumArtist が最優先されること");
  strictEqual(rec._importDiagnosis.albumDecisionSource, "import_target");
  strictEqual(rec._importDiagnosis.selectedTargetAlbum, "ユーザーが指定した既存アルバム");

  // importDriveFilesToLibrary 経由の保存検証
  const res = await driveMod.importDriveFilesToLibrary([driveFile], {
    cacheBlobs: false,
    importTarget,
  });

  strictEqual(res.added, 1);
  const saved = await libDbMod.getTrack("gd-file_new_target_1");
  strictEqual(saved.album, "ユーザーが指定した既存アルバム");
  strictEqual(saved.albumArtist, "メインアーティスト");
  strictEqual(saved._importDiagnosis.albumDecisionSource, "import_target");
});

await test("汎用インポート: importTarget がない場合は従来の埋め込みタグ・フォルダ名順序が使用されること", async () => {
  idbTracks.clear();

  const driveFile = {
    id: "file_generic_1",
    name: "02. Track.mp3",
    size: "4000000",
    mimeType: "audio/mpeg",
  };

  const extractedMeta = {
    title: "Track Title",
    artist: "Solo Artist",
    album: "Original Album Tag",
    albumArtist: "Solo Artist",
  };

  const rec = driveMod.buildDriveTrackRecord({
    file: driveFile,
    existing: null,
    extractedMeta,
    folder: "ParentFolder",
    importTarget: null, // 汎用インポート
  });

  strictEqual(rec.album, "Original Album Tag", "汎用インポートでは埋め込みタグが使用されること");
  strictEqual(rec.albumArtist, "Solo Artist");
  strictEqual(rec._importDiagnosis.albumDecisionSource, "embedded_tag");
  strictEqual(rec._importDiagnosis.selectedTargetAlbum, null);
});

console.log("\n=== 2. userEdited 既存曲の保護と再インポート優先順位テスト ===");

await test("同一 file ID かつ userEdited=true: ユーザー手動編集の既存 album / albumArtist が保護され上書きされないこと", async () => {
  idbTracks.clear();

  const initialTrack = {
    id: "gd-file_user_edited_123",
    driveFileId: "file_user_edited_123",
    title: "手動編集した曲名",
    artist: "手動編集したアーティスト",
    album: "手動編集した大切なアルバム名",
    albumArtist: "手動編集アルバムアーティスト",
    userEdited: true,
    fileSize: 5000000,
    source: "gdrive",
  };
  await libDbMod.putTrack(initialTrack, null);

  const driveFile = {
    id: "file_user_edited_123",
    name: "renamed.mp3",
    size: "5000000",
    mimeType: "audio/mpeg",
  };

  // 別のアルバム詳細から再インポートを実行
  const importTarget = {
    targetType: "album",
    album: "別のアルバム画面",
    albumArtist: "別のアーティスト",
  };

  const rec = driveMod.buildDriveTrackRecord({
    file: driveFile,
    existing: initialTrack,
    extractedMeta: { album: "Tag Album", albumArtist: "Tag Artist" },
    importTarget,
  });

  strictEqual(rec.album, "手動編集した大切なアルバム名", "userEdited=true の既存アルバム名が維持されること");
  strictEqual(rec.albumArtist, "手動編集アルバムアーティスト", "userEdited=true の既存 albumArtist が維持されること");
  strictEqual(rec._importDiagnosis.albumDecisionSource, "user_edited");
  ok(rec._importDiagnosis.importTargetMismatch, "importTarget との差異が診断に安全記録されること");
  strictEqual(rec._importDiagnosis.importTargetMismatch.targetAlbum, "別のアルバム画面");
  strictEqual(rec._importDiagnosis.importTargetMismatch.preservedAlbum, "手動編集した大切なアルバム名");
});

await test("同一 file ID かつ userEdited=false: 明示的 importTarget があれば適用されること", async () => {
  idbTracks.clear();

  const initialTrack = {
    id: "gd-file_auto_imported_456",
    driveFileId: "file_auto_imported_456",
    title: "自動取り込み曲",
    artist: "アーティスト",
    album: "古い自動分類アルバム",
    albumArtist: "アーティスト",
    userEdited: false,
    fileSize: 4500000,
    source: "gdrive",
  };
  await libDbMod.putTrack(initialTrack, null);

  const driveFile = {
    id: "file_auto_imported_456",
    name: "song.mp3",
    size: "4500000",
    mimeType: "audio/mpeg",
  };

  const importTarget = {
    targetType: "album",
    album: "再割り当て先アルバム",
    albumArtist: "再割り当てアーティスト",
  };

  const rec = driveMod.buildDriveTrackRecord({
    file: driveFile,
    existing: initialTrack,
    extractedMeta: { album: "Tag Album" },
    importTarget,
  });

  strictEqual(rec.album, "再割り当て先アルバム", "userEdited=false の場合は importTarget が適用されること");
  strictEqual(rec.albumArtist, "再割り当てアーティスト");
  strictEqual(rec._importDiagnosis.albumDecisionSource, "import_target");
});

console.log("\n=== 3. 安全な比較用テキスト正規化 (normalizeAlbumText) テスト ===");

await test("normalizeAlbumText: 安全な正規化対象が同一化されること", () => {
  // 1. Unicode NFC 正規化 (Mac等の結合文字 NFD "ガ" = U+30AB + U+3099 vs NFC "ガ" = U+30AC)
  const nfd = "\u30AB\u3099";
  const nfc = "\u30AC";
  strictEqual(albumUtil.normalizeAlbumText(nfd), albumUtil.normalizeAlbumText(nfc), "NFC正規化で結合文字が同一化されること");

  // 2. 前後空白・連続空白・全角スペース
  strictEqual(albumUtil.normalizeAlbumText("  Album   Title  "), "album title", "連続空白と前後空白が統一されること");
  strictEqual(albumUtil.normalizeAlbumText("Album　Title"), "album title", "全角スペースが半角スペースとして統一されること");

  // 3. ゼロ幅文字・BOM
  strictEqual(albumUtil.normalizeAlbumText("Album\u200BTitle\uFEFF"), "albumtitle", "ゼロ幅文字とBOMが除去されること");

  // 4. スマートクォート
  strictEqual(albumUtil.normalizeAlbumText("Rock ’n’ Roll"), "rock 'n' roll", "スマートシングルクォートが ' に統一されること");
  strictEqual(albumUtil.normalizeAlbumText("“Best” Album"), '"best" album', "スマートダブルクォートが \" に統一されること");

  // 5. 英字大文字小文字
  strictEqual(albumUtil.normalizeAlbumText("GREAT ALBUM"), "great album", "大文字小文字が小文字へ統一されること");
});

await test("normalizeAlbumText: 意図的に正規化しない記号・エディションが区別されること", () => {
  // 波ダッシュと全角チルダは誤統合防止のため安易に統一しない
  const tild1 = albumUtil.normalizeAlbumText("作品名〜始まり〜");
  const tild2 = albumUtil.normalizeAlbumText("作品名～始まり～");
  strictEqual(tild1 !== tild2, true, "波ダッシュと全角チルダは意図的に同一視しないこと");

  // ハイフンと長音
  const hyp1 = albumUtil.normalizeAlbumText("スーパー・ベスト");
  const hyp2 = albumUtil.normalizeAlbumText("スーパー-ベスト");
  strictEqual(hyp1 !== hyp2, true, "中点やハイフンは意図的に同一視しないこと");

  // エディション違い
  const base = albumUtil.normalizeAlbumText("Masterpiece");
  const remastered = albumUtil.normalizeAlbumText("Masterpiece (Remastered)");
  const deluxe = albumUtil.normalizeAlbumText("Masterpiece [Deluxe Edition]");
  const live = albumUtil.normalizeAlbumText("Masterpiece Live");
  const complete = albumUtil.normalizeAlbumText("Masterpiece 完全盤");
  strictEqual(base !== remastered, true, "Remastered は通常盤と統合しないこと");
  strictEqual(base !== deluxe, true, "Deluxe は通常盤と統合しないこと");
  strictEqual(base !== live, true, "Live は通常盤と統合しないこと");
  strictEqual(base !== complete, true, "完全盤は通常盤と統合しないこと");
});

console.log("\n=== 4. groupTracksIntoAlbums & Disc 分割テスト ===");

await test("groupTracksIntoAlbums: 同一 album + albumArtist で discNo が異なるトラックが同一アルバムにまとめられ整列されること", () => {
  const tracks = [
    { id: "t1", title: "Disc 2 Track 1", album: "The Wall", albumArtist: "Pink Floyd", discNo: "2", trackNo: "1" },
    { id: "t2", title: "Disc 1 Track 1", album: "The Wall", albumArtist: "Pink Floyd", discNo: "1", trackNo: "1" },
    { id: "t3", title: "Disc 1 Track 2", album: "The Wall", albumArtist: "Pink Floyd", discNo: "1", trackNo: "2" },
  ];

  const albums = albumUtil.groupTracksIntoAlbums(tracks);
  strictEqual(albums.length, 1, "Disc 1 と Disc 2 が1つのアルバムとしてまとめられること");
  const alb = albums[0];
  strictEqual(alb.title, "The Wall");
  strictEqual(alb.discCount, 2, "discCount が 2 となること");
  strictEqual(alb.trackCount, 3);

  // 曲順ソート検証 (Disc 1 Track 1 -> Disc 1 Track 2 -> Disc 2 Track 1)
  strictEqual(alb.tracks[0].id, "t2");
  strictEqual(alb.tracks[1].id, "t3");
  strictEqual(alb.tracks[2].id, "t1");
});

await test("groupTracksIntoAlbums: コンピレーションで個別アーティストが異なっても albumArtist が共通なら同一アルバムにまとまること", () => {
  const tracks = [
    { id: "va1", title: "Song by A", artist: "Artist A", album: "Mega Hits 2026", albumArtist: "Various Artists", trackNo: "1" },
    { id: "va2", title: "Song by B", artist: "Artist B", album: "Mega Hits 2026", albumArtist: "Various Artists", trackNo: "2" },
  ];

  const albums = albumUtil.groupTracksIntoAlbums(tracks);
  strictEqual(albums.length, 1, "Various Artists の曲が1アルバムにまとまること");
  strictEqual(albums[0].albumArtist, "Various Artists");
  strictEqual(albums[0].tracks.length, 2);
});

await test("groupTracksIntoAlbums: 同名アルバムでも albumArtist が異なれば別アルバムとして分離されること", () => {
  const tracks = [
    { id: "best1", title: "Best Track", artist: "Artist One", album: "Greatest Hits", albumArtist: "Artist One" },
    { id: "best2", title: "Best Track", artist: "Artist Two", album: "Greatest Hits", albumArtist: "Artist Two" },
  ];

  const albums = albumUtil.groupTracksIntoAlbums(tracks);
  strictEqual(albums.length, 2, "同名アルバムでもアーティストが異なれば2アルバムに分離されること");
});

console.log("\n=== 5. アルバム分類診断 (Diagnoses) と機密情報除外テスト ===");

await test("診断情報: 機密情報 (トークン、URL、アカウント情報、file ID全文) が除外され最新50件上限で保持されること", async () => {
  driveMod.clearImportAlbumDiagnoses();

  const file = {
    id: "ya29_fake_secret_drive_file_id_abcdef123456",
    name: "01. Test.mp3",
    size: "1000",
  };

  const rec = driveMod.buildDriveTrackRecord({
    file,
    existing: null,
    extractedMeta: { album: "Diagnose Album", artist: "Diagnose Artist" },
  });

  const diag = rec._importDiagnosis;
  ok(diag, "診断オブジェクトが存在すること");
  strictEqual(diag.driveFileIdSuffix, "123456", "file ID は末尾6文字のみ保持されること");
  strictEqual(diag.fileName, "01. Test.mp3");
  strictEqual(diag.finalAlbum, "Diagnose Album");

  // 機密情報が含まれていないことの検査
  const str = JSON.stringify(diag);
  ok(!str.includes("ya29_fake_secret_drive_file_id"), "file ID 全文が含まれないこと");
  ok(!str.includes("Bearer"), "Bearer が含まれないこと");
  ok(!str.includes("token"), "token プロパティが含まれないこと");
  ok(!str.includes("google.com"), "Google URL が含まれないこと");

  // 55件連続インポートで最新50件に制限されることの検証
  for (let i = 0; i < 55; i++) {
    const f = { id: `file_idx_${i}_ending`, name: `song_${i}.mp3`, size: "100" };
    await driveMod.importDriveFilesToLibrary([f], { cacheBlobs: false });
  }

  const recent = driveMod.getRecentImportAlbumDiagnoses();
  strictEqual(recent.length, 50, "診断情報は最新50件上限で保たれること");
  strictEqual(recent[recent.length - 1].fileName, "song_54.mp3", "最新の項目が記録されていること");
});

console.log(`\n🎉 全 ${passed} 件のアルバム分類検証テストにすべて合格しました！`);
