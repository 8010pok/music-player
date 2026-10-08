/**
 * アルバム集計・並び替え純粋ロジックの単体テスト
 *
 * 実行: node tests/test-album-logic.mjs
 */

import {
  normalizeAlbumText,
  parseTrackIndex,
  getAlbumArtist,
  getAlbumTitle,
  getAlbumKey,
  compareAlbumTracks,
  groupTracksIntoAlbums,
  sortAlbums,
} from "../js/metadata/album-util.js";

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    const m = `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(m);
    console.error(`  ✗ ${m}`);
  }
}

function describe(name, fn) {
  console.log(`\n=== ${name} ===`);
  fn();
}

describe("normalizeAlbumText & parseTrackIndex", () => {
  assertEqual(normalizeAlbumText("  Abbey ROAD  "), "abbey road", "前後の空白除去と小文字化");
  assertEqual(normalizeAlbumText(null), "", "null 安全性");
  assertEqual(normalizeAlbumText(undefined), "", "undefined 安全性");

  assertEqual(parseTrackIndex("1", 0), 1, "単一数値文字列");
  assertEqual(parseTrackIndex("02", 0), 2, "ゼロ埋め数値");
  assertEqual(parseTrackIndex("1/12", 0), 1, "1/12 形式");
  assertEqual(parseTrackIndex("2/2", 0), 2, "2/2 形式");
  assertEqual(parseTrackIndex("10", 0), 10, "2桁数値");
  assertEqual(parseTrackIndex("", 1), 1, "空文字のフォールバック");
  assertEqual(parseTrackIndex(null, 1), 1, "null のフォールバック");
  assertEqual(parseTrackIndex("abc", 5), 5, "非数値のフォールバック");
});

describe("getAlbumArtist & getAlbumTitle", () => {
  assert(
    getAlbumArtist({ albumArtist: "Queen", artist: "Freddie Mercury" }) === "Queen",
    "albumArtist が存在すれば優先される"
  );
  assert(
    getAlbumArtist({ albumArtist: "", artist: "The Beatles" }) === "The Beatles",
    "albumArtist が空なら artist にフォールバック"
  );
  assert(
    getAlbumArtist({ artist: "  The Beatles  " }) === "The Beatles",
    "空白トリムされたアーティスト名を取得"
  );
  assert(
    getAlbumArtist({ artist: "" }) === "不明なアーティスト",
    "artist も空なら「不明なアーティスト」"
  );
  assert(
    getAlbumArtist(null) === "不明なアーティスト",
    "null トラックで「不明なアーティスト」"
  );

  assert(
    getAlbumTitle({ album: " Abbey Road " }) === "Abbey Road",
    "album タイトルをトリムして取得"
  );
  assert(
    getAlbumTitle({ album: "" }) === "不明なアルバム",
    "album が空なら「不明なアルバム」"
  );
  assert(
    getAlbumTitle({}) === "不明なアルバム",
    "album 未定義なら「不明なアルバム」"
  );
});

describe("getAlbumKey: アルバム識別キー生成", () => {
  const t1 = { albumArtist: "Queen", album: "A Night at the Opera" };
  const t2 = { albumArtist: " queen ", album: " a night at the OPERA " };
  const t3 = { artist: "Queen", album: "A Night at the Opera" };
  const t4 = { albumArtist: "Blind Guardian", album: "A Night at the Opera" };

  assertEqual(getAlbumKey(t1), getAlbumKey(t2), "大文字小文字と前後の空白の違いを吸収して同一キー");
  assertEqual(getAlbumKey(t1), getAlbumKey(t3), "albumArtist がない曲と同一アーティスト判定");
  assert(getAlbumKey(t1) !== getAlbumKey(t4), "同名アルバムでもアーティストが違えば別アルバムキー");

  const noAlbum = { artist: "Artist", album: "" };
  assert(getAlbumKey(noAlbum).includes(encodeURIComponent("不明なアルバム")), "アルバム名がない曲も安全にキー生成");
});

describe("compareAlbumTracks: 曲順ソート", () => {
  const tracks = [
    { id: "4", discNo: "2", trackNo: "1", title: "Disc 2 Track 1" },
    { id: "1", discNo: "1", trackNo: "1/12", title: "Disc 1 Track 1" },
    { id: "3", discNo: "1", trackNo: "10", title: "Disc 1 Track 10" },
    { id: "2", discNo: "1", trackNo: "02", title: "Disc 1 Track 2" },
    { id: "5", discNo: "2", trackNo: "", title: "Disc 2 No Number", originalName: "b.mp3" },
    { id: "6", discNo: "2", trackNo: "", title: "Disc 2 No Number", originalName: "a.mp3" },
  ];

  const sorted = tracks.slice().sort(compareAlbumTracks);
  assertEqual(sorted.map((t) => t.id), ["1", "2", "3", "4", "6", "5"], "Disc番号・トラック番号(1, 02, 10)・番号なし後回し・ファイル名タイブレーク");

  // discNo が未指定の曲は Disc 1 扱い
  const d1 = { discNo: "", trackNo: "1", title: "A" };
  const d2 = { discNo: "2", trackNo: "1", title: "B" };
  assert(compareAlbumTracks(d1, d2) < 0, "discNo 未指定は Disc 1 扱いで Disc 2 より前");
});

describe("groupTracksIntoAlbums: グループ化とアルバムオブジェクト構造", () => {
  const mockBlob = { size: 1000 };
  const inputTracks = [
    { id: "t1", album: "Greatest Hits", artist: "Queen", trackNo: "2", year: "1981" },
    { id: "t2", album: "Greatest Hits", artist: "Queen", trackNo: "1", artworkBlob: mockBlob },
    { id: "t3", album: "Greatest Hits", artist: "Aerosmith", trackNo: "1", year: "1980" },
    { id: "t4", album: "", artist: "Solo Singer", title: "Single 1" },
    { id: "t5", album: "Two Discs", albumArtist: "Band", discNo: "1", trackNo: "1" },
    { id: "t6", album: "Two Discs", albumArtist: "Band", discNo: "2", trackNo: "1" },
  ];

  // 元配列が破壊されないか確認するためディープコピーを保持
  const copyBefore = JSON.stringify(inputTracks);

  const albums = groupTracksIntoAlbums(inputTracks);

  assertEqual(JSON.stringify(inputTracks), copyBefore, "元の入力配列を破壊しない (不変性維持)");
  assert(albums.length === 4, `4つのアルバムに分割される (実際: ${albums.length})`);

  // Queen の Greatest Hits
  const queenHits = albums.find((a) => a.albumArtist === "Queen" && a.title === "Greatest Hits");
  assert(!!queenHits, "Queen の Greatest Hits が存在する");
  assertEqual(queenHits.trackCount, 2, "Queen の曲数は 2");
  assertEqual(queenHits.tracks[0].id, "t2", "アルバム内トラックが trackNo 昇順 (1 -> 2) に整列");
  assert(queenHits.artworkTrack?.id === "t2", "artworkBlob を持つ曲が artworkTrack になる");
  assertEqual(queenHits.year, "1981", "後続曲から year が正しく引き継がれる");

  // Aerosmith の Greatest Hits (同名だが別アルバム)
  const aeroHits = albums.find((a) => a.albumArtist === "Aerosmith" && a.title === "Greatest Hits");
  assert(!!aeroHits, "同名アルバムでもアーティストが違う Aerosmith は別アルバムになる");
  assert(aeroHits.key !== queenHits.key, "Queen と Aerosmith のアルバムキーが異なる");

  // 不明なアルバム
  const unknownAlb = albums.find((a) => a.title === "不明なアルバム");
  assert(!!unknownAlb, "アルバム名がない曲が「不明なアルバム」として集約される");
  assertEqual(unknownAlb.tracks[0].id, "t4", "不明なアルバムに t4 が格納される");

  // 複数ディスク
  const twoDiscs = albums.find((a) => a.title === "Two Discs");
  assert(!!twoDiscs, "Two Discs アルバムが存在する");
  assertEqual(twoDiscs.discCount, 2, "discCount が 2 になる");
});

describe("sortAlbums: アルバム一覧の並び替え", () => {
  const albums = [
    { title: "B", albumArtist: "Z", year: "2010", tracks: [{ addedAt: 100 }] },
    { title: "A", albumArtist: "Y", year: "2020", tracks: [{ addedAt: 300 }] },
    { title: "C", albumArtist: "X", year: "1990", tracks: [{ addedAt: 200 }] },
  ];

  const byTitleAsc = sortAlbums(albums, "title-asc");
  assertEqual(byTitleAsc.map((a) => a.title), ["A", "B", "C"], "タイトル昇順");

  const byTitleDesc = sortAlbums(albums, "title-desc");
  assertEqual(byTitleDesc.map((a) => a.title), ["C", "B", "A"], "タイトル降順");

  const byArtistAsc = sortAlbums(albums, "artist-asc");
  assertEqual(byArtistAsc.map((a) => a.albumArtist), ["X", "Y", "Z"], "アーティスト昇順");

  const byYearDesc = sortAlbums(albums, "year-desc");
  assertEqual(byYearDesc.map((a) => a.title), ["A", "B", "C"], "年 新しい順 (2020 -> 2010 -> 1990)");

  const byYearAsc = sortAlbums(albums, "year-asc");
  assertEqual(byYearAsc.map((a) => a.title), ["C", "B", "A"], "年 古い順 (1990 -> 2010 -> 2020)");

  const byRecent = sortAlbums(albums, "recent");
  assertEqual(byRecent.map((a) => a.title), ["A", "C", "B"], "最近追加順 (300 -> 200 -> 100)");
});

console.log("============================================================");
console.log(`合計: ${passCount + failCount} / 成功: ${passCount} / 失敗: ${failCount}`);
if (failCount > 0) {
  console.error("失敗詳細:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
} else {
  console.log("全テスト成功 ✓");
}
