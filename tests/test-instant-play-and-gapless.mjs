/**
 * テスト: 曲タップ即時再生（再生ボタン不要化）＆アルバム1曲目→2曲目のギャップレス連続再生
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("\n=== 1. 曲タップ即時再生（User Gesture 維持 & 再生ボタン不要化）の検証 ===");

runTest("audio-engine.js: setQueueAndPlay で prewarmed な曲は即時完全同期で playPreloadedSync 再生される", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /const prewarmed = prewarmCache\.get\(cur\.id\);/);
  assert.match(code, /if\s*\(prewarmed\s*&&\s*prewarmed\.objectUrl\)\s*\{[^}]+playPreloadedSync\(/);
});

runTest("audio-engine.js: loadAndPlay 内で waitForLoadedMetadata のブロッキング await が排除されている", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const lapMatch = code.match(/async function loadAndPlay\([\s\S]*?\n\}/);
  assert.ok(lapMatch, "loadAndPlay が見つかること");
  assert.ok(!lapMatch[0].includes("waitForLoadedMetadata("), "loadAndPlay 内で waitForLoadedMetadata を呼び出してはならない");
  assert.match(code, /audioEl\.src = targetUrl;[\s\S]*?audioEl\.play\(\)/);
});

console.log("\n=== 2. アルバム1曲目→2曲目のギャップレス連続再生の検証 ===");

runTest("audio-engine.js: playPreloadedSync で不要な audioEl.load() が排除されギャップが最小化されている", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  // playPreloadedSync 関数本体内で audioEl.src = url の直後に audioEl.load() が呼ばれていないこと
  const ppsMatch = code.match(/function playPreloadedSync\([\s\S]*?\n\}/);
  assert.ok(ppsMatch, "playPreloadedSync が見つかること");
  assert.ok(!ppsMatch[0].includes("audioEl.load()"), "playPreloadedSync 内で audioEl.load() は不要");
});

runTest("audio-engine.js: onTimeUpdate 内で Preload Watchdog が常駐し、次曲プリロードが確実に保証される", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /if\s*\(!state\.preloadUrl\s*&&\s*!state\.preloadingId\s*&&\s*computeNextIndex\(\)\s*>=\s*0\)\s*\{\s*schedulePreload\(\);/);
});

console.log("\n=== 3. ビュー側での先行プリウォーム & アルバムトラック順保証の検証 ===");

runTest("view-album.js: マウント時にアルバム内トラックが先行プリウォームされる", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-album.js"), "utf8");
  assert.match(code, /prewarmTracks\(album\.tracks\.map/);
});

runTest("view-album.js: 曲タップ時にシャッフルが解除されアルバム曲順で連続再生される", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-album.js"), "utf8");
  assert.match(code, /setShuffleMode\(false\)/);
});

runTest("view-library.js & view-playlist.js & view-artist.js: prewarmTracks が利用されている", () => {
  const libCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-library.js"), "utf8");
  assert.match(libCode, /prewarmTracks/);

  const plCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-playlist.js"), "utf8");
  assert.match(plCode, /prewarmTracks/);

  const artCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-artist.js"), "utf8");
  assert.match(artCode, /prewarmTracks/);
});

console.log("\n============================================================");
console.log(`合計: ${total} / 成功: ${passed} / 失敗: ${total - passed}`);
if (total === passed) {
  console.log("全テスト成功 ✓\n");
} else {
  process.exit(1);
}
