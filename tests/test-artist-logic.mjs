import { groupTracksIntoArtists, sortArtists, getArtistKey, normalizeArtistText } from "../js/metadata/artist-util.js";

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.error(`  ✗ ${desc}`);
  }
}

function assertEqual(actual, expected, desc) {
  assert(actual === expected, `${desc} (expected: ${expected}, got: ${actual})`);
}

console.log("=== アーティスト集計ロジックのテスト ===");

// 1. 基本的なグルーピング
{
  const tracks = [
    { id: "1", title: "Song A", artist: "Artist 1", album: "Album 1" },
    { id: "2", title: "Song B", artist: "Artist 1", album: "Album 1" },
    { id: "3", title: "Song C", artist: "Artist 1", album: "Album 2" },
    { id: "4", title: "Song D", artist: "Artist 2", album: "Album 3" },
  ];
  const artists = groupTracksIntoArtists(tracks);
  assertEqual(artists.length, 2, "2名のアーティストに正しく分類される");

  const a1 = artists.find((a) => a.name === "Artist 1");
  assertEqual(a1?.trackCount, 3, "Artist 1 の曲数は 3");
  assertEqual(a1?.albumCount, 2, "Artist 1 のアルバム数は 2");

  const a2 = artists.find((a) => a.name === "Artist 2");
  assertEqual(a2?.trackCount, 1, "Artist 2 の曲数は 1");
  assertEqual(a2?.albumCount, 1, "Artist 2 のアルバム数は 1");
}

// 2. albumArtist の優先とフォールバック
{
  const tracks = [
    { id: "1", title: "Song 1", artist: "Featured Vocal", albumArtist: "Main Artist", album: "Album X" },
    { id: "2", title: "Song 2", artist: "Main Artist", album: "Album X" },
  ];
  const artists = groupTracksIntoArtists(tracks);
  assertEqual(artists.length, 1, "albumArtist が指定されている場合は同一アーティストとして統合される");
  assertEqual(artists[0].name, "Main Artist", "アーティスト名は Main Artist");
  assertEqual(artists[0].trackCount, 2, "2曲とも所属する");
}

// 3. 大文字小文字と前後の空白の正規化
{
  const tracks = [
    { id: "1", title: "A", artist: "  The Beatles " },
    { id: "2", title: "B", artist: "the beatles" },
    { id: "3", title: "C", artist: "THE BEATLES" },
  ];
  const artists = groupTracksIntoArtists(tracks);
  assertEqual(artists.length, 1, "大文字小文字・空白の違いを吸収して1組に統合される");
  assertEqual(artists[0].trackCount, 3, "3曲すべて同一アーティストに入る");
}

// 4. アーティスト不在のフォールバック
{
  const tracks = [
    { id: "1", title: "Unknown Song", artist: "", albumArtist: "" },
  ];
  const artists = groupTracksIntoArtists(tracks);
  assertEqual(artists.length, 1, "空のアーティストも安全に処理される");
  assertEqual(artists[0].name, "不明なアーティスト", "「不明なアーティスト」にフォールバック");
}

// 5. ソートのテスト
{
  const artists = [
    { name: "Charlie", trackCount: 5, albumCount: 1 },
    { name: "Alice", trackCount: 20, albumCount: 3 },
    { name: "Bob", trackCount: 10, albumCount: 5 },
  ];

  const byNameAsc = sortArtists(artists, "name-asc");
  assertEqual(byNameAsc[0].name, "Alice", "名前昇順: Aliceが先頭");
  assertEqual(byNameAsc[2].name, "Charlie", "名前昇順: Charlieが末尾");

  const byTracksDesc = sortArtists(artists, "tracks-desc");
  assertEqual(byTracksDesc[0].name, "Alice", "曲数降順: Alice (20曲) が先頭");
  assertEqual(byTracksDesc[1].name, "Bob", "曲数降順: Bob (10曲) が2番目");

  const byAlbumsDesc = sortArtists(artists, "albums-desc");
  assertEqual(byAlbumsDesc[0].name, "Bob", "アルバム数降順: Bob (5枚) が先頭");
  assertEqual(byAlbumsDesc[1].name, "Alice", "アルバム数降順: Alice (3枚) が2番目");
}

// 6. 元の配列を破壊しない
{
  const original = [
    { id: "1", title: "Song 1", artist: "Z" },
    { id: "2", title: "Song 2", artist: "A" },
  ];
  const copy = [...original];
  groupTracksIntoArtists(original);
  assertEqual(JSON.stringify(original), JSON.stringify(copy), "元の tracks 配列を破壊しない");
}

console.log(`\n合計: ${passed + failed} / 成功: ${passed} / 失敗: ${failed}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("全テスト成功 ✓");
}
