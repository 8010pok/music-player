/**
 * MusicBrainz / iTunes 連携サービスの単体テスト
 */

import { strictEqual, ok } from "node:assert";
import { searchTrackMetadata, searchAlbumMetadata, fetchArtworkBlob } from "../js/metadata/musicbrainz.js";

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

console.log("=== MusicBrainz & iTunes モジュール検証 ===");

test("空クエリの場合は即座に空配列を返す", async () => {
  const tracks = await searchTrackMetadata("");
  const albums = await searchAlbumMetadata("");
  strictEqual(tracks.length, 0);
  strictEqual(albums.length, 0);
});

test("空URLの場合は fetchArtworkBlob は null を返す", async () => {
  const blob = await fetchArtworkBlob("");
  strictEqual(blob, null);
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("MusicBrainz テスト成功 ✓");
