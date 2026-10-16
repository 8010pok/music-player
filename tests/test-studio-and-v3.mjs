/**
 * テスト: 耳コピ機能の完全撤去・iOS連続再生復元・Drive高速キャッシュ＆認証永続化・メタデータ検索精度向上
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inferMetadataFromFileName,
  fetchDriveAudioHeader,
} from "../js/gdrive/drive-service.js";

import {
  cleanQuery,
  extractSearchTokens,
  scoreAndSortResults,
} from "../js/metadata/musicbrainz.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let total = 0;

function runTest(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
  }
}

console.log("\n=== 1. 耳コピ・練習スタジオ機能の完全撤去と <audio> 直結復元の検証 ===");

runTest("js/player/studio-service.js が完全に削除されている", () => {
  const filePath = path.join(__dirname, "../js/player/studio-service.js");
  assert.equal(fs.existsSync(filePath), false, "studio-service.js は存在してはならない");
});

runTest("audio-engine.js: studio 関連の import / ロジック / スワップ用 standbyAudioEl が撤去されている", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.ok(!code.includes("studio-service.js"), "studio-service.js を import してはならない");
  assert.ok(!code.includes("checkStudioLoop"), "checkStudioLoop を呼び出してはならない");
  assert.ok(!code.includes("standbyAudioEl"), "デュアル audio のピンポン standbyAudioEl は廃止されている");
  assert.match(code, /function playPreloadedSync/, "単一 audioEl の同期再生関数 playPreloadedSync が存在する");
});

runTest("view-player.js & views.css: 耳コピ用UI / スタイルが完全に削除されている", () => {
  const pCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf8");
  assert.ok(!pCode.includes("studio-section"), "studio-section は削除されている");
  assert.ok(!pCode.includes("btn-studio-toggle"), "btn-studio-toggle は削除されている");
  assert.ok(!pCode.includes("btn-rewind-chip"), "btn-rewind-chip は削除されている");

  const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
  assert.ok(!css.includes(".studio-section"), ".studio-section CSS は削除されている");
  assert.ok(!css.includes(".player-quick-rewind"), ".player-quick-rewind CSS は削除されている");
});

runTest("index.html: audio-el-b が削除され、単一 <audio id=\"audio-el\"> に整理されている", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.ok(!html.includes('id="audio-el-b"'), "audio-el-b は存在してはならない");
  assert.ok(html.includes('id="audio-el"'), "単一 audio-el が存在する");
});

console.log("\n=== 2. Last.fm 二重 Scrobble 完全防止の保持 ===");

runTest("audio-engine.js: timeupdate 発火の最初の同期1行目で hasScrobbledSession がセットされる", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /if\s*\(!state\.hasScrobbledSession[^}]+state\.hasScrobbledSession\s*=\s*true;/);
  assert.match(code, /state\.playSessionId\s*=/);
});

runTest("scrobble.js: sendScrobble 入口で playSessionId のべき等性ガードが存在する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/lastfm/scrobble.js"), "utf8");
  assert.match(code, /scrobbledSessions\.has\(sessionId\)/);
  assert.match(code, /scrobbledSessions\.add\(sessionId\)/);
  assert.match(code, /isFlushingQueue/);
});

console.log("\n=== 3. ミニプレイヤー復帰時同期＆ArtworkDataUrl 優先参照 ===");

runTest("mini-player.js: pageshow / visibilitychange イベントで画面復帰時の情報同期が行われる", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/ui/mini-player.js"), "utf8");
  assert.match(code, /pageshow/);
  assert.match(code, /visibilitychange/);
});

runTest("artwork-cache.js: track.artworkDataUrl が最優先で参照される", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/ui/artwork-cache.js"), "utf8");
  assert.match(code, /track\.artworkDataUrl/);
  assert.match(code, /return track\.artworkDataUrl/);
});

console.log("\n=== 4. Google Drive 先頭ヘッダ拡大 (1.5MB) & ファイル名メタデータ推測修正 ===");

runTest("drive-service.js: fetchDriveAudioHeader のデフォルト maxBytes が 1.5MB (1572864) に拡大されている", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/gdrive/drive-service.js"), "utf8");
  assert.match(code, /maxBytes\s*=\s*1572864/);
});

runTest("inferMetadataFromFileName: 「10 - 曲名.mp3」でアーティストが10にならず、曲名とトラック番号に分離される", () => {
  const meta = inferMetadataFromFileName("10 - 夜に駆ける.mp3");
  assert.equal(meta.trackNo, "10");
  assert.equal(meta.title, "夜に駆ける");
  assert.equal(meta.artist, ""); // フォルダ名未指定なら空、10 には絶対にならない
});

runTest("inferMetadataFromFileName: 「01. YOASOBI - 夜に駆ける.flac」が正しくパースされる", () => {
  const meta = inferMetadataFromFileName("01. YOASOBI - 夜に駆ける.flac");
  assert.equal(meta.trackNo, "1");
  assert.equal(meta.artist, "YOASOBI");
  assert.equal(meta.title, "夜に駆ける");
});

runTest("inferMetadataFromFileName: 「YOASOBI - 夜に駆ける.mp3」が正しくパースされる", () => {
  const meta = inferMetadataFromFileName("YOASOBI - 夜に駆ける.mp3");
  assert.equal(meta.trackNo, "");
  assert.equal(meta.artist, "YOASOBI");
  assert.equal(meta.title, "夜に駆ける");
});

console.log("\n=== 5. メタデータ複合 AND 検索 & スコアリングソートの検証 ===");

runTest("extractSearchTokens: 複合クエリを適切に小文字トークンへ分割する", () => {
  const tokens = extractSearchTokens("ガゼット　reila (Google Drive) 01-");
  assert.deepEqual(tokens, ["ガゼット", "reila"]);
});

runTest("scoreAndSortResults: 複数トークンすべてに合致するアイテムが最上位にソートされる", () => {
  const tokens = ["ガゼット", "reila"];
  const items = [
    { id: 1, title: "reila", artist: "別のバンド", source: "iTunes" },
    { id: 2, title: "reila", artist: "the GazettE", source: "iTunes" },
    { id: 3, title: "Cassis", artist: "the GazettE", source: "iTunes" },
    { id: 4, title: "reila -Lesson G-", artist: "ガゼット", source: "iTunes" },
  ];

  const sorted = scoreAndSortResults(items, tokens);
  // ガゼット と reila の両方に一致する id: 4 または id: 2 が上位
  assert.equal(sorted[0].id, 4);
});

console.log("\n============================================================");
console.log(`合計: ${total} / 成功: ${passed} / 失敗: ${total - passed}`);
if (total === passed) {
  console.log("全テスト成功 ✓\n");
} else {
  process.exit(1);
}
