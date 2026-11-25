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

console.log("\n=== 4. iOS ワンタップ即時再生 AbortError 根治 & MediaSession 完全修飾・Data URL 化の検証 ===");

runTest("audio-engine.js: primeAudioElement で再生中は無音WAV代入をスキップし、primePromise を追跡する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /if\s*\(!audioEl\.paused\s*&&\s*audioEl\.src\s*&&\s*!audioEl\.src\.startsWith\("data:audio\/wav"\)\)\s*\{\s*return;\s*\}/);
  assert.match(code, /primePromise\s*=\s*audioEl\.play\(\)/);
});

runTest("audio-engine.js: loadAndPlay で src 変更前に primePromise を await して AbortError を防止する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /if\s*\(primePromise\)\s*\{\s*try\s*\{\s*await primePromise;\s*\}\s*catch\s*\(_\)\s*\{\}\s*primePromise\s*=\s*null;\s*\}\s*const oldUrl = state\.currentObjectUrl;\s*state\.currentObjectUrl = targetUrl;\s*audioEl\.src = targetUrl;/);
});

runTest("audio-engine.js: playPreloadedSync で isPlaying: true および loadingTrackId: null が即座に確定する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /function playPreloadedSync[\s\S]*?appState\.set\(\{[\s\S]*?isPlaying:\s*true,[\s\S]*?loadingTrackId:\s*null/);
});

runTest("audio-engine.js: prewarmCache が 60秒破棄ではなく最大30曲の LRU キャッシュとして維持される", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /const MAX_PREWARM_ENTRIES\s*=\s*30;/);
  assert.match(code, /function trimPrewarmCache\(\)\s*\{/);
  assert.ok(!code.includes("setTimeout(() => { const e = prewarmCache.get(trackId);"), "60秒タイマー破棄が削除されていること");
});

runTest("audio-engine.js & mini-player.js: toAbsoluteUrl で MediaSession とミニプレイヤーのアートワークが完全絶対URL化される", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(aeCode, /export function toAbsoluteUrl\(url\)/);
  assert.match(aeCode, /toAbsoluteUrl\("icons\/icon-512\.png"\)/);
  assert.match(aeCode, /toAbsoluteUrl\("icons\/icon-192\.png"\)/);

  const mpCode = fs.readFileSync(path.join(__dirname, "../js/ui/mini-player.js"), "utf8");
  assert.match(mpCode, /toAbsoluteUrl/);
  assert.match(mpCode, /FALLBACK_ART_SRC\s*=\s*"icons\/icon-192\.png"/);
});

runTest("audio-engine.js & mini-player.js: アルバム名 Google Drive や不明アルバムがロック画面・ミニプレイヤーでサニタイズされる", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(aeCode, /const isPlaceholderAlbum = !track\.album\s*\|\|\s*track\.album === "Google Drive"\s*\|\|\s*track\.album === "\(不明アルバム\)"/);

  const mpCode = fs.readFileSync(path.join(__dirname, "../js/ui/mini-player.js"), "utf8");
  assert.match(mpCode, /track\.album === "Google Drive"/);
});

runTest("library-db.js & view-library.js: ingestFile および ensureTrackMetadataInBackground で artworkDataUrl が保存・補完される", () => {
  const vlCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-library.js"), "utf8");
  assert.match(vlCode, /artworkDataUrl:\s*meta\.artworkDataUrl\s*\|\|\s*\(existing\s*&&\s*existing\.artworkDataUrl\)\s*\|\|\s*"",/);

  const ldbCode = fs.readFileSync(path.join(__dirname, "../js/store/library-db.js"), "utf8");
  assert.match(ldbCode, /patch\.artworkDataUrl = await blobToDataUrl\(track\.artworkBlob, 500\);/);
});

console.log("\n=== 4. ギャップレス・スタンバイ要素 (次曲の先読み再生) の検証 ===");

runTest("audio-engine.js: prepareStandby が存在し、設定・EQ・キーチェンジのゲートを持つ", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /function prepareStandby\(track, blob\)/);
  assert.match(code, /pub\.enableGaplessStandby === false/);
  assert.match(code, /if \(pub\.enableAudioEffects\) return;/);
  assert.match(code, /if \(isEqWired\(\)\) return;/);
  assert.match(code, /if \(shift !== 0\) return;/);
});

runTest("audio-engine.js: schedulePreload が getBlob 完了時に prepareStandby を呼び、clearPreload が teardownStandby を呼ぶ", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /state\.preloadUrl = url;\s*\n\s*\/\/ ギャップレス: 同じ blob で非アクティブ要素も先読みしておく\s*\n\s*prepareStandby\(track, blob\);/);
  const cpMatch = code.match(/function clearPreload\(\) \{[\s\S]*?\n\}/);
  assert.ok(cpMatch, "clearPreload が見つかること");
  assert.ok(cpMatch[0].includes("teardownStandby();"), "clearPreload 内で teardownStandby を呼ぶこと");
});

runTest("audio-engine.js: advanceFromEnded / playNext が preloadUrl パスより前に consumeStandby を確認する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const advMatch = code.match(/function advanceFromEnded\(\) \{[\s\S]*?\n\}/);
  assert.ok(advMatch, "advanceFromEnded が見つかること");
  const adv = advMatch[0];
  assert.ok(adv.indexOf("consumeStandby(track)") >= 0, "advanceFromEnded が consumeStandby を使うこと");
  assert.ok(adv.indexOf("consumeStandby(track)") < adv.indexOf("state.preloadUrl && state.preloadTrackId === track.id"), "スタンバイ確認が preloadUrl パスより前であること");
  const pnMatch = code.match(/export async function playNext\(\) \{[\s\S]*?\n\}/);
  assert.ok(pnMatch, "playNext が見つかること");
  const pn = pnMatch[0];
  assert.ok(pn.indexOf("consumeStandby(t)") >= 0, "playNext が consumeStandby を使うこと");
  assert.ok(pn.indexOf("consumeStandby(t)") < pn.indexOf("state.preloadUrl && state.preloadTrackId === t.id"), "スタンバイ確認が preloadUrl パスより前であること");
});

runTest("audio-engine.js: playPreloadedSync は standbyEl 指定時に src を差し替えず要素切替のみで再生する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /function playPreloadedSync\(index, track, url, \{ isDirectStream = false, standbyEl = null \} = \{\}\)/);
  assert.match(code, /if \(!useStandby\) audioEl\.src = url;/);
  const ppsMatch = code.match(/function playPreloadedSync\([\s\S]*?\n\}/);
  assert.ok(ppsMatch, "playPreloadedSync が見つかること");
  assert.ok(ppsMatch[0].includes("setActiveAudioElement(standbyEl);"), "スタンバイ時は standbyEl をアクティブ化すること");
  assert.ok(ppsMatch[0].includes('session.sourceType = "cached_blob";'), "スタンバイ時は blob 経路として扱うこと");
});

runTest("settings: enableGaplessStandby のデフォルトと設定画面トグルが存在する", () => {
  const settingsCode = fs.readFileSync(path.join(__dirname, "../js/store/settings.js"), "utf8");
  assert.match(settingsCode, /enableGaplessStandby: true/);
  const viewCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf8");
  assert.ok(viewCode.includes('id="gapless-chk"'), "設定画面に gapless-chk トグルがあること");
  assert.ok(viewCode.includes("enableGaplessStandby: refs.gaplessChk.checked"), "トグルが setPublic に反映されること");
});

runTest("audio-engine.js: 曲間遷移の診断記録 (noteTransition / transition* フィールド) が存在する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(code, /function noteTransition\(via, type, track\)/);
  assert.match(code, /TRANSITION_DIAG_KEY = "music-player\.transition-diag"/);
  assert.match(code, /transitionType: transitionDiag\?\.type/);
  assert.match(code, /transitionGapMs: transitionDiag\?\.gapMs/);
  assert.ok(code.includes('noteTransition("ended", "standby", track)'), "advanceFromEnded のスタンバイ分岐で記録すること");
  assert.ok(code.includes('noteTransition("next", "standby", t)'), "playNext のスタンバイ分岐で記録すること");
});

console.log("\n============================================================");
console.log(`合計: ${total} / 成功: ${passed} / 失敗: ${total - passed}`);
if (total === passed) {
  console.log("全テスト成功 ✓\n");
} else {
  process.exit(1);
}
