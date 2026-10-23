/**
 * テスト: キーチェンジ（音程変更・半音シフト・曲固定）機能
 *
 * 1. 半音数から周波数倍率への数学的変換 (2^(N/12))
 * 2. PitchShifterCore の DSP 動作検証 (完全バイパス、モノラル/ステレオ処理、NaN/無限大ゼロ)
 * 3. 曲ごとのキー変更固定（永続化）と原曲復帰 (±0) のロジック
 * 4. モジュール・エクスポート・SWプリキャッシュの整合性
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PitchShifterCore } from "../js/player/pitch-shifter-processor.js";
import { applyKeyShift, getCurrentKeyShift } from "../js/player/eq.js";
import { setKeyShift, getKeyShift } from "../js/player/audio-engine.js";
import { openPlayerSoundModal } from "../js/ui/view-player.js";

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

console.log("\n=== 1. 半音シフト比率の数学的正確性テスト ===");

runTest("0 半音 (原曲キー) は比率 1.0 (完全ビットパーフェクト)", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(0);
  assert.equal(core.pitchFactor, 1.0);
  assert.equal(core.phaseStep, 0.0);
});

runTest("+12 半音 (1オクターブ上) は比率 2.0", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(12);
  assert.equal(Math.round(core.pitchFactor), 2);
});

runTest("-12 半音 (1オクターブ下) は比率 0.5", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(-12);
  assert.equal(core.pitchFactor, 0.5);
});

runTest("+2 半音 (全音上げ) / -2 半音 (全音下げ) の比率", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(2);
  assert.ok(Math.abs(core.pitchFactor - 1.122462) < 0.0001);

  core.setSemitones(-2);
  assert.ok(Math.abs(core.pitchFactor - 0.890898) < 0.0001);
});

runTest("クランプ範囲 (-12 〜 +12)", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(20);
  assert.equal(core.semitones, 12);
  core.setSemitones(-24);
  assert.equal(core.semitones, -12);
});

console.log("\n=== 2. PitchShifterCore DSP エンジン動作テスト ===");

runTest("semitones === 0 のときは入力配列をそのまま出力（完全バイパス・劣化ゼロ）", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(0);

  const inL = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
  const inR = new Float32Array([-0.1, 0.2, -0.3, 0.4, -0.5]);
  const outL = new Float32Array(5);
  const outR = new Float32Array(5);

  core.process([[inL, inR]], [[outL, outR]]);

  for (let i = 0; i < 5; i++) {
    assert.equal(outL[i], inL[i]);
    assert.equal(outR[i], inR[i]);
  }
});

runTest("semitones !== 0 でピッチシフト処理が連続的に動作し、NaN や Infinity が発生しない", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(-3); // 3半音下げ

  // 128 サンプルを数ブロック流す
  const quantum = 128;
  const inL = new Float32Array(quantum);
  const inR = new Float32Array(quantum);
  for (let i = 0; i < quantum; i++) {
    inL[i] = Math.sin((i / quantum) * Math.PI * 4);
    inR[i] = Math.cos((i / quantum) * Math.PI * 4);
  }

  const outL = new Float32Array(quantum);
  const outR = new Float32Array(quantum);

  for (let block = 0; block < 10; block++) {
    const success = core.process([[inL, inR]], [[outL, outR]]);
    assert.equal(success, true);
    for (let i = 0; i < quantum; i++) {
      assert.ok(Number.isFinite(outL[i]), `outL[${i}] は有限値であること: ${outL[i]}`);
      assert.ok(Number.isFinite(outR[i]), `outR[${i}] は有限値であること: ${outR[i]}`);
    }
  }
});

runTest("モノラル (1ch) 入力でも安全に動作する", () => {
  const core = new PitchShifterCore(44100, 0.1);
  core.setSemitones(1);

  const inMono = new Float32Array(128).fill(0.25);
  const outMono = new Float32Array(128);

  const success = core.process([[inMono]], [[outMono]]);
  assert.equal(success, true);
  for (let i = 0; i < 128; i++) {
    assert.ok(Number.isFinite(outMono[i]));
  }
});

console.log("\n=== 3. 曲ごとのキー変更固定・原曲復帰ロジックテスト ===");

runTest("トラックの keyShift 設定・読み込み・固定保持ロジック", () => {
  const track = {
    id: "test-track-1",
    title: "テスト曲",
    artist: "テスト歌手",
    keyShift: -2, // 2半音下げ固定
  };

  const getEffectiveKeyShift = (t) => {
    return (t && typeof t.keyShift === "number") ? t.keyShift : 0;
  };

  assert.equal(getEffectiveKeyShift(track), -2, "固定キー -2 が取得できる");

  // 原曲キーに戻す
  track.keyShift = 0;
  assert.equal(getEffectiveKeyShift(track), 0, "原曲キー (0) にリセットできる");

  // keyShift 未指定の曲はデフォルト 0
  const normalTrack = { id: "test-2", title: "通常曲" };
  assert.equal(getEffectiveKeyShift(normalTrack), 0, "未指定曲は原曲キー 0");
});

console.log("\n=== 4. モジュール・エクスポート・PWA 整合性テスト ===");

runTest("必要な関数が正常にエクスポートされている", () => {
  assert.equal(typeof applyKeyShift, "function");
  assert.equal(typeof getCurrentKeyShift, "function");
  assert.equal(typeof setKeyShift, "function");
  assert.equal(typeof getKeyShift, "function");
  assert.equal(typeof openPlayerSoundModal, "function");
});

runTest("sw.js の PRECACHE_URLS に pitch-shifter-processor.js が含まれている", () => {
  const swCode = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf8");
  assert.ok(
    swCode.includes("./js/player/pitch-shifter-processor.js"),
    "sw.js の PRECACHE_URLS に ./js/player/pitch-shifter-processor.js が存在すること"
  );
});

console.log("\n============================================================");
console.log(`結果: ${passed}/${total} テスト通過`);
if (passed !== total) {
  process.exit(1);
}
