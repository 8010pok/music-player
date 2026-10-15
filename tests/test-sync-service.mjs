/**
 * 端末間同期・エクスポート/インポートサービスの単体テスト
 *
 * 実行: node tests/test-sync-service.mjs
 */

import { strictEqual, ok, deepStrictEqual, rejects } from "node:assert";
import { importLibraryData } from "../js/store/sync-service.js";

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

// IndexedDB モックのセットアップ (Node.js 環境用)
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
            objectStore: (name) => ({
              getAll: () => {
                const getReq = {
                  result: name === "tracks" ? Array.from(tracksStore.values()) : Array.from(playlistsStore.values()),
                  onsuccess: null,
                  transaction: tx,
                };
                queueMicrotask(() => {
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return getReq;
              },
              put: (item) => {
                if (name === "tracks") tracksStore.set(item.id, item);
                if (name === "playlists") playlistsStore.set(item.id, item);
                const putReq = { result: item.id, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (putReq.onsuccess) putReq.onsuccess({ target: putReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return putReq;
              },
              get: (id) => {
                const getReq = {
                  result: name === "tracks" ? tracksStore.get(id) : playlistsStore.get(id),
                  onsuccess: null,
                  transaction: tx,
                };
                queueMicrotask(() => {
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return getReq;
              },
              delete: (id) => {
                if (name === "tracks") tracksStore.delete(id);
                if (name === "playlists") playlistsStore.delete(id);
                const delReq = { result: id, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (delReq.onsuccess) delReq.onsuccess({ target: delReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return delReq;
              },
            }),
          };
          return tx;
        },
        close: () => {},
      },
      onsuccess: null,
      onupgradeneeded: null,
      onerror: null,
    };
    queueMicrotask(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  },
};

console.log("=== 端末間同期データ検証テスト ===");

await asyncTest("不正なJSON文字列でエラーを投げる", async () => {
  await rejects(
    async () => {
      await importLibraryData("{ invalid json }");
    },
    { message: /無効な JSON フォーマット/ }
  );
});

await asyncTest("tracks配列が含まれない場合エラーを投げる", async () => {
  await rejects(
    async () => {
      await importLibraryData({ version: 1 });
    },
    { message: /曲データ \(tracks\) が含まれていません/ }
  );
});

await asyncTest("スマート差分マージ: 既存曲のメモ・曲名・お気に入り・並び順が更新され、既存artworkBlobが維持される", async () => {
  tracksStore.clear();
  playlistsStore.clear();

  // 端末A（iPhone）にある既存トラック
  const mockArtwork = new Blob(["mock-image-data"], { type: "image/jpeg" });
  const localTrack = {
    id: "t-track1",
    title: "Old Title",
    artist: "Age Factory",
    album: "RIVER",
    memo: "",
    loved: false,
    order: 1000,
    playCount: 5,
    artworkBlob: mockArtwork,
  };
  tracksStore.set(localTrack.id, localTrack);

  // 端末B（iPad）から届いた同期データ（曲名、メモ、お気に入り、並び順を変更）
  const syncPayload = {
    app: "music-player",
    version: 2,
    tracks: [
      {
        id: "t-track1",
        title: "RIVER",
        artist: "Age Factory",
        album: "RIVER",
        memo: "京都大作戦2025 ライブ盤",
        loved: true,
        order: 2000,
        playCount: 10,
        lyrics: "川の流れのように...",
        userEdited: true,
      },
    ],
    playlists: [
      {
        id: "pl-1",
        name: "お気に入りライブ音源",
        trackIds: ["t-track1"],
        createdAt: 1234567890,
      },
    ],
  };

  const result = await importLibraryData(syncPayload);

  strictEqual(result.updatedCount, 1, "1曲が更新されること");
  strictEqual(result.addedCount, 0, "新規追加は0件であること");
  strictEqual(result.playlistsCount, 1, "1件のプレイリストが同期されること");

  const updated = tracksStore.get("t-track1");
  ok(updated, "トラックが存在すること");
  strictEqual(updated.title, "RIVER", "曲名が同期されること");
  strictEqual(updated.memo, "京都大作戦2025 ライブ盤", "メモが同期されること");
  strictEqual(updated.loved, true, "お気に入りが同期されること");
  strictEqual(updated.order, 2000, "並び順が同期されること");
  strictEqual(updated.lyrics, "川の流れのように...", "歌詞が同期されること");
  strictEqual(updated.playCount, 10, "再生回数がマージされること");
  strictEqual(updated.userEdited, true, "ユーザー編集フラグが引き継がれること");
  strictEqual(updated.artworkBlob, mockArtwork, "既存のartworkBlobが破壊されず維持されること");

  const pl = playlistsStore.get("pl-1");
  ok(pl, "プレイリストが存在すること");
  strictEqual(pl.name, "お気に入りライブ音源");
});

await asyncTest("新規Google Drive曲の追加", async () => {
  const syncPayload = {
    app: "music-player",
    version: 2,
    tracks: [
      {
        id: "gd-file123",
        title: "New Cloud Track",
        artist: "Cloud Artist",
        album: "Drive Album",
        memo: "YouTubeからの保存音源",
        source: "gdrive",
        driveFileId: "file-id-abc",
      },
    ],
    playlists: [],
  };

  const result = await importLibraryData(syncPayload);
  strictEqual(result.addedCount, 1, "新規曲が1曲追加されること");

  const newTrack = tracksStore.get("gd-file123");
  ok(newTrack, "Google Drive曲が追加されていること");
  strictEqual(newTrack.title, "New Cloud Track");
  strictEqual(newTrack.driveFileId, "file-id-abc");
  strictEqual(newTrack.memo, "YouTubeからの保存音源");
});

await asyncTest("ノーマライズ情報のスマート差分マージ", async () => {
  const localTrack = {
    id: "t-norm1",
    title: "Norm Song",
    artist: "Artist",
    normalized: false,
    normalizedGainDb: 0,
  };
  tracksStore.set(localTrack.id, localTrack);

  const syncPayload = {
    app: "music-player",
    version: 2,
    tracks: [
      {
        id: "t-norm1",
        title: "Norm Song",
        artist: "Artist",
        normalized: true,
        normalizedGainDb: -2.5,
        originalRmsDb: -11.5,
        targetRmsDb: -14.0,
        originalPeakDb: -0.1,
      },
    ],
  };

  const result = await importLibraryData(syncPayload);
  strictEqual(result.updatedCount, 1, "1曲更新");

  const updated = tracksStore.get("t-norm1");
  strictEqual(updated.normalized, true, "normalizedフラグがマージされること");
  strictEqual(updated.normalizedGainDb, -2.5, "normalizedGainDbがマージされること");
  strictEqual(updated.originalRmsDb, -11.5, "originalRmsDbがマージされること");
  strictEqual(updated.targetRmsDb, -14.0, "targetRmsDbがマージされること");
  strictEqual(updated.originalPeakDb, -0.1, "originalPeakDbがマージされること");
});


console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("同期サービス テスト成功 ✓");
