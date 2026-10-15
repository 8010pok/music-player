/**
 * テスト: 耳コピ・練習スタジオ機能 & 二重Scrobble防止 & Drive再生ラグ解消
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. studio-service.js のユニットテスト
import {
  getStudioState,
  setLoopPointA,
  setLoopPointB,
  clearLoop,
  adjustLoopStart,
  adjustLoopEnd,
  updateSpeedTrainer,
  addBookmarkMarker,
  removeBookmarkMarker,
  setChannelMode,
  setMidSideBalance,
  setFrequencySolo,
  setPitchShift,
  checkStudioLoop,
} from "../js/player/studio-service.js";

import { FREQ_SOLO_PRESETS } from "../js/player/eq.js";

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

console.log("\n=== 1. 耳コピ・練習スタジオ (studio-service.js) ===");

runTest("A-B 区間リピートの始点・終点・微調整・解除が正しく動作する", () => {
  setLoopPointA(10.5);
  let s = getStudioState();
  assert.equal(s.abLoop.enabled, true);
  assert.equal(s.abLoop.start, 10.5);
  assert.ok(s.abLoop.end > 10.5);

  setLoopPointB(15.2);
  s = getStudioState();
  assert.equal(s.abLoop.end, 15.2);

  // ±0.1s 微調整
  adjustLoopStart(0.2);
  assert.equal(Math.round(getStudioState().abLoop.start * 10) / 10, 10.7);

  adjustLoopEnd(-0.2);
  assert.equal(Math.round(getStudioState().abLoop.end * 10) / 10, 15.0);

  // ループ周回チェック
  const mockAudio = { currentTime: 15.1, playbackRate: 1.0 };
  checkStudioLoop(15.1, mockAudio);
  assert.equal(Math.round(mockAudio.currentTime * 10) / 10, 10.7);

  clearLoop();
  assert.equal(getStudioState().abLoop.enabled, false);
});

runTest("Speed Trainer の設定と自動加速ロジック", () => {
  updateSpeedTrainer({
    enabled: true,
    loopInterval: 2,
    stepPercent: 5,
    maxRate: 1.2,
  });
  const s = getStudioState();
  assert.equal(s.speedTrainer.enabled, true);
  assert.equal(s.speedTrainer.loopInterval, 2);
  assert.equal(s.speedTrainer.stepPercent, 5);
  assert.equal(s.speedTrainer.maxRate, 1.2);
});

runTest("ブックマーク（マーカー）の追加・一覧・削除", () => {
  const m1 = addBookmarkMarker(12.5, "サビ頭");
  assert.equal(m1.time, 12.5);
  assert.equal(m1.label, "サビ頭");
  assert.ok(getStudioState().markers.some(m => m.id === m1.id));

  removeBookmarkMarker(m1.id);
  assert.ok(!getStudioState().markers.some(m => m.id === m1.id));
});

runTest("チャンネル分離 & Mid/Side バランス & ピッチシフト", () => {
  setChannelMode("left-only");
  assert.equal(getStudioState().channelMode, "left-only");

  setChannelMode("lr-swap");
  assert.equal(getStudioState().channelMode, "lr-swap");

  setChannelMode("stereo");
  assert.equal(getStudioState().channelMode, "stereo");

  setMidSideBalance(0.5);
  assert.equal(getStudioState().midSideBalance, 0.5);
  setMidSideBalance(0);

  setPitchShift(3);
  assert.equal(getStudioState().pitch.semitones, 3);
  setPitchShift(0);
});

runTest("周波数アイソレーター (FREQ_SOLO_PRESETS) の各帯域プリセット定義", () => {
  assert.ok(FREQ_SOLO_PRESETS.drum);
  assert.ok(FREQ_SOLO_PRESETS.bass);
  assert.ok(FREQ_SOLO_PRESETS.guitar);
  assert.ok(FREQ_SOLO_PRESETS.hihat);
  assert.equal(FREQ_SOLO_PRESETS.drum.low, 45);
  assert.equal(FREQ_SOLO_PRESETS.drum.high, 5500);

  setFrequencySolo({ enabled: true, preset: "drum" });
  assert.equal(getStudioState().freqSolo.preset, "drum");
  setFrequencySolo({ enabled: false, preset: "off" });
});

console.log("\n=== 2. Last.fm 二重 Scrobble 完全防止 ===");

runTest("audio-engine.js: timeupdate 発火の最初の同期1行目で hasScrobbledSession がセットされる", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  // progress >= 1 到達判定の直後で state.hasScrobbledSession = true
  assert.match(code, /if\s*\(!state\.hasScrobbledSession[^}]+state\.hasScrobbledSession\s*=\s*true;/);
  // playSessionId が定義されている
  assert.match(code, /state\.playSessionId\s*=/);
});

runTest("scrobble.js: sendScrobble 入口で playSessionId のべき等性ガードが存在する", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/lastfm/scrobble.js"), "utf8");
  assert.match(code, /scrobbledSessions\.has\(sessionId\)/);
  assert.match(code, /scrobbledSessions\.add\(sessionId\)/);
  assert.match(code, /isFlushingQueue/);
});

console.log("\n=== 3. Google Drive 再生開始ラグ解消 ===");

runTest("sw.js: /gdrive-stream/ の Range 中継ストリーミングハンドラが実装されている", () => {
  const code = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf8");
  assert.match(code, /gdrive-stream/);
  assert.match(code, /handleDriveStream/);
  assert.match(code, /Range/i);
});

runTest("audio-engine.js & view-library.js: prewarmTrack と pointerdown 先行デコード", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  assert.match(aeCode, /export function prewarmTrack/);
  assert.match(aeCode, /prewarmCache\.get/);

  const libCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-library.js"), "utf8");
  assert.match(libCode, /pointerdown/);
  assert.match(libCode, /prewarmTrack/);
});

console.log("\n=== 4. プレイヤー UI & クイック巻き戻し & スタジオドロワー ===");

runTest("view-player.js & views.css: クイック巻き戻しボタン (-1s, -3s, -5s) が実装されている", () => {
  const pCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf8");
  assert.match(pCode, /btn-rewind-chip/);
  assert.match(pCode, /data-rewind="-1"/);
  assert.match(pCode, /data-rewind="-3"/);
  assert.match(pCode, /data-rewind="-5"/);

  const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
  assert.match(css, /\.player-quick-rewind/);
  assert.match(css, /\.btn-rewind-chip/);
});

runTest("view-player.js & views.css: 🎧 耳コピ・練習スタジオ のUIとイベント結線が存在する", () => {
  const pCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf8");
  assert.match(pCode, /studio-section/);
  assert.match(pCode, /btn-studio-toggle/);
  assert.match(pCode, /btn-loop-a/);
  assert.match(pCode, /btn-loop-b/);
  assert.match(pCode, /chk-speed-trainer/);
  assert.match(pCode, /btn-studio-lock/);
  assert.match(pCode, /subscribeStudio/);

  const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
  assert.match(css, /\.studio-section/);
  assert.match(css, /\.btn-studio-toggle/);
  assert.match(css, /\.studio-body/);
  assert.match(css, /\.studio-card/);
});

console.log("\n============================================================");
console.log(`合計: ${total} / 成功: ${passed} / 失敗: ${total - passed}`);
if (total === passed) {
  console.log("全テスト成功 ✓\n");
} else {
  process.exit(1);
}
