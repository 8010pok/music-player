/**
 * test-drive-import-completeness.mjs
 *
 * Google Drive インポート完全性・耐障害性・セキュリティ検証テストスイート
 */

import { strictEqual, ok } from "node:assert";

// ==========================================
// 1. テスト環境モック (DOM / Storage / IndexedDB / Blob)
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

// Blob モックの健全性保証
if (typeof globalThis.Blob === "undefined") {
  globalThis.Blob = class {
    constructor(chunks = [], opts = {}) {
      this.chunks = chunks;
      this.type = opts.type || "";
      this.size = chunks.reduce((acc, c) => acc + (c?.length || c?.byteLength || 0), 0);
    }
    slice(start = 0, end = this.size) {
      return new Blob([], { type: this.type });
    }
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
  };
}

const idbTracks = new Map();
const idbBlobs = new Map();
let shouldFailPutTrack = false;

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
                if (shouldFailPutTrack && name === "tracks") {
                  const err = new Error("QuotaExceededError: IDB Disk Full");
                  queueMicrotask(() => {
                    if (tx.onerror) tx.onerror({ target: { error: err } });
                    if (tx.onabort) tx.onabort({ target: { error: err } });
                  });
                  throw err;
                }
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
const tombstoneMod = await import("../js/store/tombstone.js");
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

// デフォルト fetch モック
function setDefaultFetchMock() {
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => {
          const l = (h || "").toLowerCase();
          if (l === "content-type") return "audio/mpeg";
          if (l === "content-length") return "4000000";
          return null;
        },
      },
      json: async () => ({ files: [] }),
      blob: async () => new Blob([], { type: "audio/mpeg" }),
    };
  };
}

setDefaultFetchMock();

console.log("=== 1. フォーマット厳格判定テスト ===");

await test("isSupportedDriveAudioFile: 確認済み形式 (.mp3, .flac, .m4a, .wav, .aac, .ogg, .opus, .webm, 大文字) を許可すること", async () => {
  const supportedNames = [
    "track.mp3", "track.MP3", "track.flac", "track.FLAC",
    "track.m4a", "track.M4A", "track.wav", "track.WAV",
    "track.aac", "track.AAC", "track.ogg", "track.opus", "track.webm",
  ];
  for (const name of supportedNames) {
    ok(driveMod.isSupportedDriveAudioFile({ name, mimeType: "application/octet-stream" }), `${name} must be supported`);
  }
});

await test("isSupportedDriveAudioFile: 未確認形式 (.alac, .aiff, .wma, .exe, .txt, .zip) を除外すること", async () => {
  const unsupported = [
    { name: "song.alac", mimeType: "audio/alac" },
    { name: "song.aiff", mimeType: "audio/aiff" },
    { name: "song.wma", mimeType: "audio/x-ms-wma" },
    { name: "song.wma", mimeType: "application/octet-stream" },
    { name: "setup.exe", mimeType: "application/octet-stream" },
    { name: "notes.txt", mimeType: "text/plain" },
    { name: "archive.zip", mimeType: "application/zip" },
    { name: "folder", mimeType: "application/vnd.google-apps.folder" },
  ];
  for (const item of unsupported) {
    strictEqual(driveMod.isSupportedDriveAudioFile(item), false, `${item.name} (${item.mimeType}) must be rejected`);
  }
});

await test("isSupportedDriveAudioFile: application/octet-stream は音声拡張子がある場合のみ許可すること", async () => {
  ok(driveMod.isSupportedDriveAudioFile({ name: "my_song.FLAC", mimeType: "application/octet-stream" }));
  strictEqual(driveMod.isSupportedDriveAudioFile({ name: "data.bin", mimeType: "application/octet-stream" }), false);
  strictEqual(driveMod.isSupportedDriveAudioFile({ name: "noextension", mimeType: "application/octet-stream" }), false);
});

console.log("\n=== 2. 機密情報除外 (Sanitization) テスト ===");

await test("sanitizeDriveSafeError: トークン、Bearer、URL引数を完全に除去し、安全な情報のみ返すこと", async () => {
  const sensitiveErr = new Error("Failed at https://www.googleapis.com/drive/v3/files?access_token=ya29.a0AfH6SMSecretToken12345 with Authorization: Bearer ya29.SecretHeaderToken");
  sensitiveErr.status = 500;

  const sanitized = driveMod.sanitizeDriveSafeError(sensitiveErr, {
    folderName: "秘密のアルバム",
    folderId: "0B123456789abcdef",
    stage: "page_fetch",
  });

  ok(!sanitized.message.includes("ya29.a0AfH6SMSecretToken12345"), "Token in URL must be redacted");
  ok(!sanitized.message.includes("ya29.SecretHeaderToken"), "Token in Bearer header must be redacted");
  strictEqual(sanitized.folderName, "秘密のアルバム");
  strictEqual(sanitized.folderIdSuffix, "...abcdef");
  strictEqual(sanitized.status, 500);
  strictEqual(sanitized.errorCode, "HTTP_500");
});

console.log("\n=== 3. フォルダ再帰探索の耐障害性・再試行規則テスト ===");

await test("fetchFolderAudioFilesRecursive: 403 権限不足 (SERVICE_DISABLED) はリトライせず安全にスキップして partial=true を返すこと", async () => {
  let fetchCount = 0;
  const mockSleepCalls = [];

  globalThis.fetch = async (url) => {
    fetchCount++;
    return {
      ok: false,
      status: 403,
      clone: () => ({
        json: async () => ({
          error: {
            message: "Google Drive API has not been used in project",
            errors: [{ reason: "SERVICE_DISABLED" }],
          },
        }),
      }),
      json: async () => ({}),
    };
  };

  mockStorage.set("music_player_settings_public", JSON.stringify({ gdriveTokenExpiry: Date.now() + 3600000 }));
  await driveMod.setDriveToken("ya29.valid_token");

  const result = await driveMod.fetchFolderAudioFilesRecursive("folder_no_perm", {
    sleepFn: async (ms) => { mockSleepCalls.push(ms); },
  });

  strictEqual(fetchCount, 1, "403 SERVICE_DISABLED should not retry");
  strictEqual(mockSleepCalls.length, 0, "No backoff sleep for permission error");
  strictEqual(result.partial, true, "Result must be marked partial=true");
  strictEqual(result.failedFolders.length, 1, "Failed folder should be recorded");
  strictEqual(result.failedFolders[0].errorCode, "HTTP_403");
  strictEqual(result.files.length, 0, "Files should be empty");
});

await test("fetchFolderAudioFilesRecursive: 403 レート制限 (rateLimitExceeded) は指数バックオフで再試行すること", async () => {
  let fetchCount = 0;
  const mockSleepCalls = [];

  globalThis.fetch = async (url) => {
    fetchCount++;
    if (fetchCount === 1) {
      return {
        ok: false,
        status: 403,
        clone: () => ({
          json: async () => ({
            error: {
              message: "User Rate Limit Exceeded",
              errors: [{ reason: "rateLimitExceeded" }],
            },
          }),
        }),
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        files: [{ id: "song_rate_limit_recovered", name: "Recovered.mp3", mimeType: "audio/mpeg" }],
        nextPageToken: null,
      }),
    };
  };

  await driveMod.setDriveToken("ya29.valid_token");

  const result = await driveMod.fetchFolderAudioFilesRecursive("folder_rate_limit", {
    sleepFn: async (ms) => { mockSleepCalls.push(ms); },
  });

  strictEqual(fetchCount, 2, "Rate limit should be retried and succeed on second attempt");
  strictEqual(mockSleepCalls.length, 1, "One backoff sleep performed");
  strictEqual(result.partial, false, "Result should be fully successful");
  strictEqual(result.files.length, 1);
  strictEqual(result.files[0].id, "song_rate_limit_recovered");
});

await test("fetchFolderAudioFilesRecursive: 429 Too Many Requests の Retry-After ヘッダを尊重して再試行すること", async () => {
  let fetchCount = 0;
  const mockSleepCalls = [];

  globalThis.fetch = async (url) => {
    fetchCount++;
    if (fetchCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: {
          get: (h) => (h.toLowerCase() === "retry-after" ? "3" : null),
        },
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        files: [{ id: "song_after_429", name: "After429.flac", mimeType: "audio/flac" }],
        nextPageToken: null,
      }),
    };
  };

  await driveMod.setDriveToken("ya29.valid_token");

  const result = await driveMod.fetchFolderAudioFilesRecursive("folder_429", {
    sleepFn: async (ms) => { mockSleepCalls.push(ms); },
  });

  strictEqual(fetchCount, 2);
  strictEqual(mockSleepCalls.length, 1);
  strictEqual(mockSleepCalls[0], 3000, "Retry-After: 3 should result in 3000ms sleep");
  strictEqual(result.files.length, 1);
  strictEqual(result.files[0].id, "song_after_429");
});

await test("fetchFolderAudioFilesRecursive: 循環参照フォルダおよび重複ファイルの無限ループを確実に防止すること", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("parentA")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            { id: "parentB", name: "Folder B", mimeType: "application/vnd.google-apps.folder" },
            { id: "song_common", name: "Common.mp3", mimeType: "audio/mpeg" },
          ],
        }),
      };
    }
    if (u.includes("parentB")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            { id: "parentA", name: "Folder A (Circular Link)", mimeType: "application/vnd.google-apps.folder" },
            { id: "song_common", name: "Common.mp3", mimeType: "audio/mpeg" },
            { id: "song_unique", name: "Unique.mp3", mimeType: "audio/mpeg" },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ files: [] }) };
  };

  await driveMod.setDriveToken("ya29.valid_token");

  const result = await driveMod.fetchFolderAudioFilesRecursive("parentA", { maxDepth: 10 });

  strictEqual(result.files.length, 2, "Duplicate file ID should be de-duplicated (2 unique tracks)");
  ok(result.warnings.some((w) => w.includes("循環")), "Circular reference warning must be generated");
  strictEqual(result.foldersVisited, 2, "Only parentA and parentB visited once each");
});

await test("fetchFolderAudioFilesRecursive: AbortSignal によるユーザー中断時にリトライせず即時終了すること", async () => {
  const controller = new AbortController();
  controller.abort();

  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({ files: [] }) };
  };

  await driveMod.setDriveToken("ya29.valid_token");

  const result = await driveMod.fetchFolderAudioFilesRecursive("abort_folder", {
    signal: controller.signal,
  });

  strictEqual(fetchCalled, false, "Fetch should not be called when already aborted");
  strictEqual(result.aborted, true, "aborted flag must be true");
  strictEqual(result.partial, true, "partial flag must be true");
});

await test("fetchFolderAudioFilesRecursive: 戻り値がプレーンオブジェクトでありスプレッドやJSONシリアライズでプロパティが維持されること", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      files: [{ id: "song_spread_test", name: "Spread.mp3", mimeType: "audio/mpeg" }],
      nextPageToken: null,
    }),
  });

  await driveMod.setDriveToken("ya29.valid_token");

  const result = await driveMod.fetchFolderAudioFilesRecursive("spread_folder");

  strictEqual(Array.isArray(result), false, "戻り値は配列ではなくプレーンオブジェクトであること");
  ok(Array.isArray(result.files), "result.files は配列であること");
  strictEqual(result.files.length, 1);
  strictEqual(typeof result.foldersVisited, "number");
  strictEqual(typeof result.pagesFetched, "number");
  strictEqual(typeof result.partial, "boolean");
  strictEqual(typeof result.aborted, "boolean");
  strictEqual(typeof result.authRequired, "boolean");

  // スプレッド構文でコピーしても全プロパティが保持されること
  const spreadCopy = { ...result };
  strictEqual(spreadCopy.files.length, 1);
  strictEqual(spreadCopy.foldersVisited, result.foldersVisited);
  strictEqual(spreadCopy.partial, result.partial);
  strictEqual(spreadCopy.aborted, result.aborted);
  strictEqual(spreadCopy.authRequired, result.authRequired);

  // JSONシリアライズ/デシリアライズ後もプロパティが保持されること
  const jsonCopy = JSON.parse(JSON.stringify(result));
  strictEqual(jsonCopy.files.length, 1);
  strictEqual(jsonCopy.partial, result.partial);
  strictEqual(jsonCopy.aborted, result.aborted);
  strictEqual(jsonCopy.authRequired, result.authRequired);
});

console.log("\n=== 4. Tombstone (削除同期) 安全解除 & 同一性分離テスト ===");

setDefaultFetchMock();

await test("removeTombstone: 削除済みアイテムのTombstoneを明示解除できること", async () => {
  tombstoneMod.clearTombstones();
  tombstoneMod.recordTombstone("gd-track-deleted-1", "track");
  strictEqual(tombstoneMod.isTombstoned("gd-track-deleted-1", 0, "track"), true, "Should be tombstoned");

  const removed = tombstoneMod.removeTombstone("gd-track-deleted-1", "track");
  strictEqual(removed, true, "Should return true on successful removal");
  strictEqual(tombstoneMod.isTombstoned("gd-track-deleted-1", 0, "track"), false, "Tombstone must be cleared");
});

await test("importDriveFilesToLibrary: 削除済み曲をユーザーが明示再追加した際に putTrack 成功後にのみ Tombstone を安全解除し restored カウントすること", async () => {
  tombstoneMod.clearTombstones();
  const trackId = "gd-restored_file_999";
  tombstoneMod.recordTombstone(trackId, "track");
  strictEqual(tombstoneMod.isTombstoned(trackId, 0, "track"), true);

  const driveFile = {
    id: "restored_file_999",
    name: "Revived Track.mp3",
    size: "4000000",
    mimeType: "audio/mpeg",
  };

  const res = await driveMod.importDriveFilesToLibrary([driveFile], {
    cacheBlobs: false,
    defaultAlbumName: "Revival Album",
  });

  strictEqual(res.restored, 1, "restored count must be 1");
  strictEqual(res.tombstoned, 1, "tombstoned count must be 1");
  strictEqual(res.added, 1, "added count must be 1");
  strictEqual(tombstoneMod.isTombstoned(trackId, 0, "track"), false, "Tombstone must be removed from storage");
});

await test("Tombstone安全順序: putTrack 失敗時は Tombstone が維持され restored は増えず failed が加算されること", async () => {
  tombstoneMod.clearTombstones();
  const trackId = "gd-fail_save_file";
  tombstoneMod.recordTombstone(trackId, "track");
  strictEqual(tombstoneMod.isTombstoned(trackId, 0, "track"), true);

  // IndexedDB putTrack を失敗させる
  shouldFailPutTrack = true;

  try {
    const driveFile = {
      id: "fail_save_file",
      name: "Fail Save.mp3",
      size: "3000000",
      mimeType: "audio/mpeg",
    };

    const res = await driveMod.importDriveFilesToLibrary([driveFile], { cacheBlobs: false });

    strictEqual(res.failed, 1, "putTrack 失敗時は failed=1 となること");
    strictEqual(res.restored, 0, "保存失敗時は restored がカウントされないこと");
    strictEqual(res.added, 0, "保存失敗時は added がカウントされないこと");
    strictEqual(tombstoneMod.isTombstoned(trackId, 0, "track"), true, "保存失敗時は Tombstone が確実に維持されること");
  } finally {
    shouldFailPutTrack = false;
  }
});

await test("Tombstone解除失敗時: removeTombstone が失敗した場合は restored にカウントされず警告が記録されること", async () => {
  tombstoneMod.clearTombstones();
  const trackId = "gd-remove_fail_file";
  tombstoneMod.recordTombstone(trackId, "track");

  // Tombstone 保存(localStorage.setItem)を一時的に失敗させることで removeTombstone を false にする
  const originalSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (k, v) => {
    if (String(k).includes("tombstone")) {
      throw new Error("DiskIOError: Failed to save tombstone");
    }
    return originalSetItem(k, v);
  };

  try {
    const driveFile = {
      id: "remove_fail_file",
      name: "Remove Fail.mp3",
      size: "3500000",
      mimeType: "audio/mpeg",
    };

    const res = await driveMod.importDriveFilesToLibrary([driveFile], { cacheBlobs: false });

    strictEqual(res.added, 1, "トラック自体は保存成功するため added=1");
    strictEqual(res.restored, 0, "Tombstone解除失敗時は restored にカウントされないこと");
    ok(res.failures.some((f) => f.errorCode === "TOMBSTONE_REMOVE_FAILED"), "TOMBSTONE_REMOVE_FAILED 警告が failures に記録されること");
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
  }
});

await test("Tombstone分離: 削除済み曲と同名だが別Drive file IDの曲は Tombstone に引っかからず正常追加されること", async () => {
  tombstoneMod.clearTombstones();
  tombstoneMod.recordTombstone("gd-old_file_deleted", "track");

  const newDriveFile = {
    id: "new_file_different_id",
    name: "Deleted Song.mp3",
    size: "4500000",
    mimeType: "audio/mpeg",
  };

  const res = await driveMod.importDriveFilesToLibrary([newDriveFile], {
    cacheBlobs: false,
    defaultAlbumName: "Album",
  });

  strictEqual(res.added, 1);
  strictEqual(res.tombstoned, 0, "Different file ID should NOT be tombstoned");
  strictEqual(tombstoneMod.isTombstoned("gd-new_file_different_id", 0, "track"), false);
  strictEqual(tombstoneMod.isTombstoned("gd-old_file_deleted", 0, "track"), true, "Old ID remains tombstoned");
});

console.log("\n=== 5. 構造化インポート結果カウントテスト & 件数整合性 ===");

await test("importDriveFilesToLibrary: 新規追加、既存更新、非対応形式、Tombstone復元の構造化結果と件数整合性を正確に返却すること", async () => {
  tombstoneMod.clearTombstones();

  const existingTrack = {
    id: "gd-existing_id",
    title: "Existing Title",
    artist: "Artist",
    album: "Album",
    source: "gdrive",
    driveFileId: "existing_id",
    fileSize: 2000000,
    cached: true,
  };
  await libDbMod.putTrack(existingTrack, null);

  tombstoneMod.recordTombstone("gd-revived_id", "track");

  const files = [
    { id: "new_id", name: "Brand New.mp3", mimeType: "audio/mpeg", size: "3000000" },
    { id: "existing_id", name: "Existing.mp3", mimeType: "audio/mpeg", size: "2000000" }, // 実体変更なし
    { id: "revived_id", name: "Revived.mp3", mimeType: "audio/mpeg", size: "4000000" },
    { id: "unsupported_id", name: "video.mp4", mimeType: "video/mp4", size: "15000000" },
    { id: "wma_id", name: "song.wma", mimeType: "audio/x-ms-wma", size: "5000000" },
  ];

  const res = await driveMod.importDriveFilesToLibrary(files, { cacheBlobs: false });

  // 1. 件数定義の整合性検証
  // attempted = added + updated + failed + skippedSameFile
  // selected = attempted + unsupported
  // restored は added または updated の内数
  strictEqual(res.selected, 5, "selected = 5");
  strictEqual(res.unsupported, 2, "unsupported = 2 (mp4 video, wma)");
  strictEqual(res.added, 2, "added = 2 (new_id, revived_id)");
  strictEqual(res.updated, 1, "updated = 1 (existing_id)");
  strictEqual(res.failed, 0, "failed = 0 (no unexpected exceptions)");
  strictEqual(res.skippedSameFile, 0, "skippedSameFile = 0");
  strictEqual(res.attempted, res.added + res.updated + res.failed + res.skippedSameFile, "attempted = added + updated + failed + skippedSameFile");
  strictEqual(res.attempted, 3, "attempted = 3");
  strictEqual(res.selected, res.attempted + res.unsupported, "selected = attempted + unsupported");

  // 内数の検証
  strictEqual(res.restored, 1, "restored = 1 (revived_id)");
  strictEqual(res.tombstoned, 1, "tombstoned = 1 (revived_id)");
  ok(res.restored <= res.added + res.updated, "restored は added または updated の内数であり総数に二重加算されないこと");

  strictEqual(res.failures.length, 2, "failures contains 2 unsupported records");
  strictEqual(res.failures[0].errorCode, "UNSUPPORTED_FORMAT");
  strictEqual(res.failures[1].errorCode, "UNSUPPORTED_FORMAT");

  // 2. 実体不変の既存曲キャッシュ保持の検証
  const savedExisting = await libDbMod.getTrack("gd-existing_id");
  strictEqual(savedExisting.cached, true, "実体変更がない既存曲の cached: true が保持されること");
});

await test("Blobキャッシュ整合性: fileSize変更検知時に古いキャッシュBlobが削除され cached: false に更新されること", async () => {
  idbBlobs.set("gd-blob_invalidation_track", new Blob(["old_audio_data"]));

  const track = {
    id: "gd-blob_invalidation_track",
    title: "Blob Test Song",
    artist: "Artist",
    album: "Album",
    source: "gdrive",
    driveFileId: "blob_invalidation_track",
    fileSize: 1000000,
    driveModifiedTime: "2026-11-01T00:00:00Z",
    cached: true,
  };
  await libDbMod.putTrack(track, null);

  // Drive 側のサイズが 1000000 -> 2000000 に変更されたファイル
  const updatedDriveFile = {
    id: "blob_invalidation_track",
    name: "Blob Test Song.mp3",
    size: "2000000",
    modifiedTime: "2026-11-04T00:00:00Z",
    mimeType: "audio/mpeg",
  };

  const res = await driveMod.importDriveFilesToLibrary([updatedDriveFile], {
    cacheBlobs: false, // 今回は音源ダウンロードを行わないインポート
  });

  strictEqual(res.updated, 1, "updated = 1");
  const reloaded = await libDbMod.getTrack("gd-blob_invalidation_track");
  strictEqual(reloaded.fileSize, 2000000, "新しいファイルサイズに更新されること");
  strictEqual(reloaded.cached, false, "実体変更検知により cached: false に落とされること");
  strictEqual(idbBlobs.has("gd-blob_invalidation_track"), false, "古い音源キャッシュBlobが安全に削除されていること");
});

console.log(`\n🎉 全 ${passed} 件の完全性検証テストにすべて合格しました！`);
