/**
 * 重複楽曲検出・統合・クリーンアップサービスの単体テスト
 *
 * 実行: node tests/test-dedup-service.mjs
 */

import { strictEqual, ok, deepStrictEqual } from "node:assert";
import {
  normalizeTrackString,
  areTracksDuplicate,
  findDuplicateInList,
  scoreTrackQuality,
  findDuplicateGroups,
  mergeAndDeduplicate,
} from "../js/store/dedup-service.js";

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

console.log("=== 1. 文字列正規化テスト ===");

test("括弧内の装飾タグが除去され、全角半角が統一される", () => {
  strictEqual(normalizeTrackString("RIVER [Official Video]"), "river");
  strictEqual(normalizeTrackString("RIVER（MV）"), "river");
  strictEqual(normalizeTrackString("ＲＩＶＥＲ (Live Ver.)"), "river");
  strictEqual(normalizeTrackString("Age Factory - RIVER 【公式】"), "age factory river");
  strictEqual(normalizeTrackString("  Ｓｏｎｇ   Ｎａｍｅ  "), "song name");
});

console.log("=== 2. 重複楽曲判定テスト ===");

test("同一IDなら重複と判定", () => {
  ok(areTracksDuplicate({ id: "t1", title: "A" }, { id: "t1", title: "B" }));
});

test("同一 Google Drive ファイルIDなら重複と判定", () => {
  ok(
    areTracksDuplicate(
      { id: "t1", driveFileId: "file-xyz", title: "Track 1" },
      { id: "t2", driveFileId: "file-xyz", title: "Track 2" }
    )
  );
});

test("同一ファイル名かつ同一サイズなら重複と判定", () => {
  ok(
    areTracksDuplicate(
      { id: "t1", originalName: "river.mp3", fileSize: 5000000 },
      { id: "t2", originalName: "river.mp3", fileSize: 5000000 }
    )
  );
});

test("タイトルとアーティストが一致し再生時間が近い場合（4秒差以内）は重複と判定", () => {
  const a = { id: "t1", title: "RIVER [MV]", artist: "Age Factory", duration: 180 };
  const b = { id: "t2", title: "RIVER", artist: "Age Factory", duration: 182 };
  ok(areTracksDuplicate(a, b), "4秒差以内は重複とみなす");
});

test("タイトルが一致しても再生時間が大きく異なる場合は重複とみなさない（同名別曲/ショート版）", () => {
  const full = { id: "t1", title: "RIVER", artist: "Age Factory", duration: 240 };
  const shortVer = { id: "t2", title: "RIVER", artist: "Age Factory", duration: 90 };
  strictEqual(areTracksDuplicate(full, shortVer), false, "大幅な時間差は別曲と判定");
});

test("タイトルが一致してもアーティストが異なる場合は重複とみなさない", () => {
  const a = { id: "t1", title: "RIVER", artist: "Age Factory", duration: 180 };
  const b = { id: "t2", title: "RIVER", artist: "AKB48", duration: 180 };
  strictEqual(areTracksDuplicate(a, b), false, "別アーティストは重複しない");
});

test("アーティストが不明表記（'不明なアーティスト' と '(不明アーティスト)' 等）でもタイトルが一致すれば重複とみなす", () => {
  const a = { id: "t1", title: "Track Title", artist: "不明なアーティスト", duration: 200 };
  const b = { id: "t2", title: "Track Title", artist: "(不明アーティスト)", duration: 200 };
  ok(areTracksDuplicate(a, b), "不明アーティスト表記の違いを吸収して重複判定されること");
});

console.log("=== 3. 重複グループ検出テスト ===");

test("全トラックから重複クラスタを検出し、最適な方を primary に選定する", () => {
  const tracks = [
    { id: "t1", title: "RIVER", artist: "Age Factory", duration: 180, source: "local", userEdited: true, memo: "京都大作戦" },
    { id: "t2", title: "RIVER [MV]", artist: "Age Factory", duration: 180, source: "gdrive", userEdited: false, memo: "" },
    { id: "t3", title: "Dance", artist: "Age Factory", duration: 200, source: "local" },
  ];

  const groups = findDuplicateGroups(tracks);
  strictEqual(groups.length, 1, "重複グループは1つ");
  strictEqual(groups[0].primary.id, "t1", "ローカル音源かつメモありの t1 が primary に選ばれる");
  strictEqual(groups[0].duplicates.length, 1);
  strictEqual(groups[0].duplicates[0].id, "t2");
});

console.log("=== 4. 重複統合 & マージ削除テスト ===");

const tracksStore = new Map();
const playlistsStore = new Map();
const blobsStore = new Map();

globalThis.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => {
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            addEventListener: () => {},
            objectStore: (name) => ({
              getAll: () => {
                let res = [];
                if (name === "tracks") res = Array.from(tracksStore.values());
                else if (name === "playlists") res = Array.from(playlistsStore.values());
                else if (name === "blobs") res = Array.from(blobsStore.values());
                const getReq = { result: res, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return getReq;
              },
              get: (id) => {
                let res = undefined;
                if (name === "tracks") res = tracksStore.get(id);
                else if (name === "playlists") res = playlistsStore.get(id);
                else if (name === "blobs") res = blobsStore.get(id);
                const getReq = { result: res, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return getReq;
              },
              put: (item, key) => {
                const k = key !== undefined ? key : (item && item.id);
                if (name === "tracks") tracksStore.set(k, item);
                else if (name === "playlists") playlistsStore.set(k, item);
                else if (name === "blobs") blobsStore.set(k, item);
                const putReq = { result: k, onsuccess: null, transaction: tx };
                queueMicrotask(() => {
                  if (putReq.onsuccess) putReq.onsuccess({ target: putReq });
                  if (tx.oncomplete) tx.oncomplete();
                });
                return putReq;
              },
              delete: (id) => {
                if (name === "tracks") tracksStore.delete(id);
                else if (name === "playlists") playlistsStore.delete(id);
                else if (name === "blobs") blobsStore.delete(id);
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
      onerror: null,
    };
    queueMicrotask(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  },
};

await asyncTest("重複曲のマージ削除: メモやお気に入りが統合され、重複曲が削除、プレイリスト参照が置換される", async () => {
  tracksStore.clear();
  playlistsStore.clear();
  blobsStore.clear();

  const primary = {
    id: "t-primary",
    title: "RIVER",
    artist: "Age Factory",
    memo: "", // 空
    loved: false,
    playCount: 2,
    source: "local",
  };
  const duplicate = {
    id: "t-duplicate",
    title: "RIVER",
    artist: "Age Factory",
    memo: "京都大作戦2025",
    loved: true,
    playCount: 10,
    source: "gdrive",
    driveFileId: "gdrive-123",
  };

  tracksStore.set(primary.id, primary);
  tracksStore.set(duplicate.id, duplicate);

  const playlist = {
    id: "pl-1",
    name: "プレイリスト",
    trackIds: ["t-other", "t-duplicate"],
  };
  playlistsStore.set(playlist.id, playlist);

  await mergeAndDeduplicate(primary, duplicate, [playlist]);

  // 検証1: duplicate が削除されたこと
  strictEqual(tracksStore.has("t-duplicate"), false, "duplicate が削除されたこと");
  strictEqual(tracksStore.has("t-primary"), true, "primary は保持されること");

  // 検証2: primary に memo や loved、playCount が統合されたこと
  const updatedPrimary = tracksStore.get("t-primary");
  strictEqual(updatedPrimary.memo, "京都大作戦2025", "メモが統合されたこと");
  strictEqual(updatedPrimary.loved, true, "お気に入りが統合されたこと");
  strictEqual(updatedPrimary.playCount, 10, "再生回数が統合されたこと");
  strictEqual(updatedPrimary.driveFileId, "gdrive-123", "driveFileId が統合されたこと");

  // 検証3: プレイリストの trackIds が t-primary に置換されたこと
  const updatedPl = playlistsStore.get("pl-1");
  deepStrictEqual(updatedPl.trackIds, ["t-other", "t-primary"], "プレイリスト内の参照が置換されたこと");
});

asyncTest("重複曲マージ: duplicate 側のノーマライズ情報・音源キャッシュが primary に引き継がれる", async () => {
  const p = {
    id: "t-uncached-drive",
    title: "Song",
    artist: "Artist",
    source: "gdrive",
    cached: false,
    normalized: false,
  };
  const d = {
    id: "t-cached-norm",
    title: "Song",
    artist: "Artist",
    source: "gdrive",
    cached: true,
    normalized: true,
    normalizedGainDb: 3.5,
  };

  tracksStore.set(p.id, p);
  tracksStore.set(d.id, d);
  blobsStore.set(d.id, { id: d.id, blob: new Blob(["normalized-audio-data"], { type: "audio/mpeg" }) });

  await mergeAndDeduplicate(p, d, []);

  strictEqual(tracksStore.has(d.id), false, "duplicate は削除される");
  const mergedP = tracksStore.get(p.id);
  strictEqual(mergedP.cached, true, "cached: true に昇格されること");
  strictEqual(mergedP.normalized, true, "normalized: true が引き継がれること");
  strictEqual(mergedP.normalizedGainDb, 3.5, "normalizedGainDb が引き継がれること");
  ok(blobsStore.has(p.id), "音源 Blob が primary に引き継がれたこと");
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("重複管理サービス テスト成功 ✓");
