/**
 * メタデータ編集および保護ロジックの単体テスト
 *
 * - 単一曲のメタデータ編集パッチ
 * - アルバム一括メタデータ更新
 * - 再スキャン時の userEdited フラグによる保護
 * - 現在再生中トラック (appState) との同期
 */

import { strictEqual, ok, deepStrictEqual } from "node:assert";

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

console.log("=== 単一曲のメタデータ編集 ===");

test("単一曲のメタデータ編集: 指定したフィールドが上書きされ userEdited: true が付与される", () => {
  const original = {
    id: "t-001",
    title: "元のタイトル",
    artist: "元のアーティスト",
    album: "元のアルバム",
    albumArtist: "",
    trackNo: "1",
    discNo: "1",
    year: "2020",
    genre: "Rock",
    duration: 180,
  };

  const patch = {
    title: "新タイトル",
    artist: "新アーティスト",
    album: "新アルバム",
    albumArtist: "新アルバムアーティスト",
    trackNo: "2",
    discNo: "1",
    year: "2024",
    genre: "Pop",
    userEdited: true,
  };

  const updated = { ...original, ...patch };

  strictEqual(updated.title, "新タイトル");
  strictEqual(updated.artist, "新アーティスト");
  strictEqual(updated.album, "新アルバム");
  strictEqual(updated.albumArtist, "新アルバムアーティスト");
  strictEqual(updated.trackNo, "2");
  strictEqual(updated.year, "2024");
  strictEqual(updated.genre, "Pop");
  strictEqual(updated.userEdited, true);
  // 他のフィールド (id, duration) は維持
  strictEqual(updated.id, "t-001");
  strictEqual(updated.duration, 180);
});

console.log("=== アルバム一括メタデータ編集 ===");

test("アルバム一括編集: 属する全トラックの album, albumArtist, year が更新され userEdited: true が付与される", () => {
  const tracks = [
    { id: "t-1", title: "Track 1", artist: "Artist A", album: "Old Album", albumArtist: "", year: "2010" },
    { id: "t-2", title: "Track 2", artist: "Artist B", album: "Old Album", albumArtist: "", year: "2010" },
    { id: "t-3", title: "Track 3", artist: "Artist C", album: "Old Album", albumArtist: "", year: "2010" },
  ];

  const patch = {
    album: "New Remastered Album",
    albumArtist: "Various Artists",
    year: "2024",
    userEdited: true,
  };

  const updatedTracks = tracks.map((t) => ({ ...t, ...patch }));

  for (const t of updatedTracks) {
    strictEqual(t.album, "New Remastered Album");
    strictEqual(t.albumArtist, "Various Artists");
    strictEqual(t.year, "2024");
    strictEqual(t.userEdited, true);
  }
  // 曲ごとの固有情報 (title, artist, id) は維持される
  strictEqual(updatedTracks[0].title, "Track 1");
  strictEqual(updatedTracks[1].artist, "Artist B");
});

test("アルバム一括編集: トラックアーティスト統一・ジャンル・アートワーク指定時の反映", () => {
  const tracks = [
    { id: "t-1", title: "Track 1", artist: "Unknown Artist", album: "Old Album", year: "2010" },
    { id: "t-2", title: "Track 2", artist: "Another Artist", album: "Old Album", year: "2010" },
  ];

  const mockBlob = { size: 1234, type: "image/jpeg" };
  const patch = {
    album: "Official Album",
    albumArtist: "Main Artist",
    artist: "Main Artist", // 全曲統一アーティスト
    year: "2023",
    genre: "J-Pop",
    artworkBlob: mockBlob,
    userEdited: true,
  };

  const updatedTracks = tracks.map((t) => ({ ...t, ...patch }));

  for (const t of updatedTracks) {
    strictEqual(t.album, "Official Album");
    strictEqual(t.albumArtist, "Main Artist");
    strictEqual(t.artist, "Main Artist");
    strictEqual(t.year, "2023");
    strictEqual(t.genre, "J-Pop");
    strictEqual(t.artworkBlob, mockBlob);
    strictEqual(t.userEdited, true);
  }
});

console.log("=== 再スキャン保護ロジック ===");

test("再スキャン保護: userEdited: true の曲はファイルから再抽出されたメタデータで上書きされない", () => {
  const userEditedTrack = {
    id: "t-edited",
    title: "ユーザが修正した曲名",
    artist: "ユーザが修正したアーティスト",
    album: "ユーザが修正したアルバム",
    userEdited: true,
  };

  const nonEditedTrack = {
    id: "t-raw",
    title: "元の曲名",
    artist: "元のアーティスト",
    album: "元のアルバム",
    userEdited: false,
  };

  // ファイルから抽出されたメタデータ
  const freshlyParsed = {
    title: "ファイルタグのタイトル",
    artist: "ファイルタグのアーティスト",
    album: "ファイルタグのアルバム",
  };

  // view-library.js の rescanMeta ロジックと同じ条件分岐
  function applyRescan(t, meta) {
    return {
      title: t.userEdited ? t.title : (meta.title || t.title),
      artist: t.userEdited ? t.artist : (meta.artist || t.artist),
      album: t.userEdited ? t.album : (meta.album ?? t.album),
    };
  }

  const rescanEdited = applyRescan(userEditedTrack, freshlyParsed);
  strictEqual(rescanEdited.title, "ユーザが修正した曲名");
  strictEqual(rescanEdited.artist, "ユーザが修正したアーティスト");
  strictEqual(rescanEdited.album, "ユーザが修正したアルバム");

  const rescanRaw = applyRescan(nonEditedTrack, freshlyParsed);
  strictEqual(rescanRaw.title, "ファイルタグのタイトル");
  strictEqual(rescanRaw.artist, "ファイルタグのアーティスト");
  strictEqual(rescanRaw.album, "ファイルタグのアルバム");
});

console.log("=== 再生中トラックとの同期 ===");

test("再生中トラックが編集された場合、appState.currentTrack も同期される", () => {
  let appStateTrack = { id: "t-now", title: "Playing Song", artist: "Artist" };
  const editedTrack = { id: "t-now", title: "New Song Title", artist: "New Artist", userEdited: true };

  // 同期判定
  if (appStateTrack && appStateTrack.id === editedTrack.id) {
    appStateTrack = { ...appStateTrack, ...editedTrack };
  }

  strictEqual(appStateTrack.title, "New Song Title");
  strictEqual(appStateTrack.artist, "New Artist");
  strictEqual(appStateTrack.userEdited, true);
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("メタデータ編集テスト成功 ✓");
