/**
 * 音量ノーマライズサービス（Google Drive / ローカル共通）の単体テスト
 */

import { strictEqual, ok } from "node:assert";
import {
  analyzeAudioLoudness,
  calculateNormalizeGain,
  sliceAndEncodeAudio,
} from "../js/audio/mp3-encoder.js";
import {
  processAudioNormalization,
} from "../js/audio/normalize-service.js";
import {
  isDriveTrackId,
  driveFileIdFromTrackId,
  trackIdFromDriveFileId,
} from "../js/gdrive/drive-service.js";

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

console.log("=== 1. Google Drive トラック ID 判定・変換テスト ===");

test("isDriveTrackId で Google Drive 音源を正確に識別できる", () => {
  strictEqual(isDriveTrackId("gd-1A2b3C4d5E"), true);
  strictEqual(isDriveTrackId("gd-file123"), true);
  strictEqual(isDriveTrackId("local-track-123"), false);
  strictEqual(isDriveTrackId("yt-abc"), false);
  strictEqual(isDriveTrackId(null), false);
  strictEqual(isDriveTrackId(undefined), false);
});

test("driveFileIdFromTrackId と trackIdFromDriveFileId の双方向変換", () => {
  const originalFileId = "1zX9Yw8Vu7Ts6Rq5Po4";
  const trackId = trackIdFromDriveFileId(originalFileId);
  strictEqual(trackId, `gd-${originalFileId}`);

  const restoredFileId = driveFileIdFromTrackId(trackId);
  strictEqual(restoredFileId, originalFileId);

  // gd- プレフィックスがない通常IDはそのまま返る
  strictEqual(driveFileIdFromTrackId("some-other-id"), "some-other-id");
});

console.log("=== 2. ラウドネス解析 & ゲイン計算テスト ===");

test("ラウドネス解析 (analyzeAudioLoudness): 正確な Peak と RMS の計算", () => {
  const sampleRate = 44100;
  const numSamples = sampleRate; // 1秒間
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);

  // 振幅 0.25 のサイン波 (-12 dBFS Peak)
  for (let i = 0; i < numSamples; i++) {
    const val = 0.25 * Math.sin(2 * Math.PI * 440 * (i / sampleRate));
    left[i] = val;
    right[i] = val;
  }

  const mockBuffer = {
    sampleRate,
    numberOfChannels: 2,
    duration: 1.0,
    length: numSamples,
    getChannelData(c) {
      return c === 0 ? left : right;
    },
  };

  const loud = analyzeAudioLoudness(mockBuffer);
  ok(loud.peak >= 0.24 && loud.peak <= 0.26, `Peak が 0.25 付近 (${loud.peak})`);
  ok(loud.peakDb >= -12.3 && loud.peakDb <= -11.7, `PeakDb が -12dB 付近 (${loud.peakDb})`);
  ok(loud.rms >= 0.17 && loud.rms <= 0.185, `RMS が 0.177 付近 (${loud.rms})`);
  ok(loud.rmsDb >= -15.3 && loud.rmsDb <= -14.7, `RMSDb が -15dB 付近 (${loud.rmsDb})`);
});

test("基準曲モード (calculateNormalizeGain): 基準音量への増幅と安全リミッター", () => {
  const quietLoudness = {
    peak: 0.1,    // -20dB
    peakDb: -20.0,
    rms: 0.0316,  // -30dB
    rmsDb: -30.0,
  };

  // 目標が -14 dBFS の場合、ゲインは +16dB
  // 増幅後ピークは -20dB + 16dB = -4dB（-0.3dB以下なのでリミッター不要）
  const res1 = calculateNormalizeGain({
    sourceLoudness: quietLoudness,
    mode: "reference",
    targetRmsDb: -14.0,
    maxPeakDb: -0.3,
  });

  strictEqual(res1.gainDb, 16.0);
  strictEqual(res1.limited, false);
  strictEqual(res1.finalPeakDb, -4.0);
  strictEqual(res1.finalRmsDb, -14.0);

  // 音割れテスト: 元音源の RMS が -24dB だが Peak が -1dB の場合
  const dangerousLoudness = {
    peak: 0.891,  // -1dB
    peakDb: -1.0,
    rms: 0.063,   // -24dB
    rmsDb: -24.0,
  };

  // 理想ゲインは +10dB だが、そうするとピークが +9dB でクリッピングする
  // 安全ガードにより、ピークが -0.3dB で止まるよう +0.7dB に制限されること
  const res2 = calculateNormalizeGain({
    sourceLoudness: dangerousLoudness,
    mode: "reference",
    targetRmsDb: -14.0,
    maxPeakDb: -0.3,
  });

  strictEqual(res2.limited, true, "リミッターが発動すること");
  ok(res2.gainDb <= 0.75, `ゲインが +0.7dB 付近にクランプされること (${res2.gainDb})`);
  ok(res2.finalPeakDb <= -0.3, `最終ピークが -0.3dB 以下であること (${res2.finalPeakDb})`);
});

test("最大ピークモード & 手動ゲインモード & オフモード", () => {
  const loud = { peak: 0.5, peakDb: -6.0, rms: 0.25, rmsDb: -12.0 };

  // ピークモード: -6.0dB → -0.3dB (+5.7dB)
  const peakRes = calculateNormalizeGain({
    sourceLoudness: loud,
    mode: "peak",
    maxPeakDb: -0.3,
  });
  strictEqual(peakRes.gainDb, 5.7);
  strictEqual(peakRes.finalPeakDb, -0.3);

  // 手動モード: +3.0dB
  const manRes = calculateNormalizeGain({
    sourceLoudness: loud,
    mode: "manual",
    manualGainDb: 3.0,
    maxPeakDb: -0.3,
  });
  strictEqual(manRes.gainDb, 3.0);
  strictEqual(manRes.finalPeakDb, -3.0);

  // オフモード: 0dB
  const noneRes = calculateNormalizeGain({
    sourceLoudness: loud,
    mode: "none",
  });
  strictEqual(noneRes.gainDb, 0.0);
  strictEqual(noneRes.gain, 1.0);
  strictEqual(noneRes.finalPeakDb, -6.0);
});

console.log("=== 3. processAudioNormalization (AudioBuffer) 処理テスト ===");

asyncTest("processAudioNormalization でモック AudioBuffer から MP3 320kbps Blob を生成", async () => {
  const sampleRate = 44100;
  const numSamples = sampleRate * 1; // 1秒
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const val = 0.2 * Math.sin(2 * Math.PI * 440 * (i / sampleRate));
    left[i] = val;
    right[i] = val;
  }

  // AudioBuffer モッククラス
  class MockAudioBuffer {
    constructor() {
      this.sampleRate = sampleRate;
      this.numberOfChannels = 2;
      this.duration = 1.0;
      this.length = numSamples;
    }
    getChannelData(c) {
      return c === 0 ? left : right;
    }
  }

  const mockBuf = new MockAudioBuffer();
  // globalThis に AudioBuffer を設定
  globalThis.AudioBuffer = MockAudioBuffer;

  let progressCalled = false;
  const result = await processAudioNormalization(mockBuf, {
    track: {
      title: "Google Drive Test Track",
      artist: "Drive Artist",
      album: "Drive Album",
      year: "2026",
    },
    mode: "reference",
    targetRmsDb: -14.0,
    bitrate: 320,
    onProgress: (pct) => {
      progressCalled = true;
      ok(pct >= 0 && pct <= 100);
    },
  });

  ok(result, "ノーマライズ結果が返ること");
  ok(result.normalizedBlob || result.blob, "Blob が生成されていること");
  const blob = result.normalizedBlob || result.blob;
  strictEqual(blob.type, "audio/mpeg");
  ok(blob.size > 20000, `MP3 サイズが十分にあること (${blob.size} bytes)`);

  ok(result.gain > 0);
  ok(typeof result.gainDb === "number");
  ok(typeof result.finalPeakDb === "number");
  ok(typeof result.finalRmsDb === "number");
  ok(progressCalled, "進捗コールバックが呼ばれたこと");
});

console.log(`\n========================================`);
console.log(`全 ${passed} 件のノーマライズテストが正常に通過しました！`);
console.log(`========================================\n`);
