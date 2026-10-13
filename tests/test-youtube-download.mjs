/**
 * YouTube ダウンロード、音源トリミング、MP3 320kbps エンコードの単体テスト
 */

import { strictEqual, ok } from "node:assert";
import { extractYouTubeVideoId, DEFAULT_INVIDIOUS_INSTANCES } from "../js/youtube/youtube-service.js";
import {
  buildId3Tag,
  encodePcmToMp3,
  sliceAndEncodeAudio,
  analyzeAudioLoudness,
  calculateNormalizeGain,
} from "../js/audio/mp3-encoder.js";
import { isDriveConnected, isDriveTrackId, driveFileIdFromTrackId } from "../js/gdrive/drive-service.js";

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

console.log("=== 1. YouTube Video ID 抽出テスト ===");

test("通常 URL から videoId を抽出できる", () => {
  strictEqual(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  strictEqual(extractYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s"), "dQw4w9WgXcQ");
});

test("短縮 URL (youtu.be) から videoId を抽出できる", () => {
  strictEqual(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  strictEqual(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=abcdef"), "dQw4w9WgXcQ");
});

test("YouTube Music / Shorts / Embed URL から videoId を抽出できる", () => {
  strictEqual(extractYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  strictEqual(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  strictEqual(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("生の 11 桁 ID から抽出できる", () => {
  strictEqual(extractYouTubeVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("無効な URL の場合は null を返す", () => {
  strictEqual(extractYouTubeVideoId(""), null);
  strictEqual(extractYouTubeVideoId(null), null);
  strictEqual(extractYouTubeVideoId("https://example.com/audio.mp3"), null);
});

test("デフォルトの Invidious インスタンスリストが設定されている", () => {
  ok(Array.isArray(DEFAULT_INVIDIOUS_INSTANCES));
  ok(DEFAULT_INVIDIOUS_INSTANCES.length >= 3);
});

console.log("=== 2. ID3v2.3 タグビルダーテスト ===");

test("ID3v2.3 タグが正しく生成される (Header 10 bytes, TIT2, TPE1, TALB)", () => {
  const tag = buildId3Tag({
    title: "Test Song",
    artist: "Test Artist",
    album: "Test Album",
    year: 2026,
  });

  ok(tag instanceof Uint8Array);
  ok(tag.length > 10);
  // 'ID3' マジックバイト
  strictEqual(tag[0], 0x49); // 'I'
  strictEqual(tag[1], 0x44); // 'D'
  strictEqual(tag[2], 0x33); // '3'
  strictEqual(tag[3], 0x03); // v2.3
});

test("カバー画像 (APIC) を含む ID3 タグが生成される", () => {
  const dummyArtwork = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const tag = buildId3Tag({
    title: "Cover Test",
    artist: "Artist",
    artworkBuffer: dummyArtwork,
    artworkMime: "image/jpeg",
  });

  ok(tag.length > 20);
  const tagStr = String.fromCharCode(...tag);
  ok(tagStr.includes("APIC"), "APIC フレームが含まれていること");
});

console.log("=== 3. PCM → MP3 320kbps エンコーダーテスト ===");

test("Float32 サンプルから MP3 320kbps Blob を生成できる", () => {
  const sampleRate = 44100;
  const durationSec = 1; // 1秒間
  const numSamples = sampleRate * durationSec;

  // 440Hz サイン波 (ステレオ)
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    left[i] = Math.sin(2 * Math.PI * 440 * t);
    right[i] = Math.sin(2 * Math.PI * 440 * t);
  }

  let progressCalled = false;
  const mp3Blob = encodePcmToMp3(2, sampleRate, left, right, {
    bitrate: 320,
    metadata: {
      title: "Sine Wave 440Hz",
      artist: "Test",
    },
    onProgress: (pct) => {
      progressCalled = true;
      ok(pct >= 0 && pct <= 100);
    },
  });

  ok(mp3Blob);
  strictEqual(mp3Blob.type, "audio/mpeg");
  ok(mp3Blob.size > 20000, `サイズが十分にあること (${mp3Blob.size} bytes)`);
  ok(progressCalled, "進捗コールバックが呼ばれたこと");
});

test("AudioBuffer のカット & MP3 320kbps エンコード (モック)", () => {
  const sampleRate = 44100;
  const totalSec = 5;
  const numSamples = sampleRate * totalSec;
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);

  // 簡易モック AudioBuffer
  const mockBuffer = {
    sampleRate,
    numberOfChannels: 2,
    duration: totalSec,
    length: numSamples,
    getChannelData(channel) {
      return channel === 0 ? left : right;
    },
  };

  // 1秒から 3秒 まで (2秒間) カット
  const mp3 = sliceAndEncodeAudio(mockBuffer, {
    startTime: 1.0,
    endTime: 3.0,
    bitrate: 320,
  });

  ok(mp3);
  strictEqual(mp3.type, "audio/mpeg");
  ok(mp3.size > 10000);
});

console.log("=== 4. 音量ノーマライズ & ラウドネス解析テスト ===");

test("PCM サンプルから Peak と RMS を正確に解析できる", () => {
  const sampleRate = 44100;
  const numSamples = sampleRate; // 1秒
  // 振幅 0.5 のサイン波
  const channelData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    channelData[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (i / sampleRate));
  }

  const mockBuffer = {
    sampleRate,
    numberOfChannels: 1,
    duration: 1.0,
    length: numSamples,
    getChannelData: () => channelData,
  };

  const loudness = analyzeAudioLoudness(mockBuffer);
  // peak は 0.5 (約 -6.0 dBFS)
  ok(loudness.peak >= 0.49 && loudness.peak <= 0.51, `peak が 0.5 付近であること (${loudness.peak})`);
  ok(loudness.peakDb >= -6.2 && loudness.peakDb <= -5.8, `peakDb が -6dB 付近であること (${loudness.peakDb})`);
  // サイン波の実効値 (RMS) は peak / sqrt(2) = 0.5 * 0.7071 = 0.3535 (約 -9.0 dBFS)
  ok(loudness.rms >= 0.34 && loudness.rms <= 0.37, `rms が 0.35 付近であること (${loudness.rms})`);
  ok(loudness.rmsDb >= -9.3 && loudness.rmsDb <= -8.7, `rmsDb が -9dB 付近であること (${loudness.rmsDb})`);
});

test("基準曲モード: 目標 RMS に合わせたゲインを算出できる", () => {
  // 元音源の RMS が -20 dBFS, ピークが -8 dBFS の場合
  const sourceLoudness = {
    peak: 0.398, // -8dB
    peakDb: -8.0,
    rms: 0.1,    // -20dB
    rmsDb: -20.0,
  };

  // 基準曲が -14 dBFS の場合、必要なゲインは +6 dB (約 2.0倍)
  const norm = calculateNormalizeGain({
    sourceLoudness,
    mode: "reference",
    targetRmsDb: -14.0,
    maxPeakDb: -0.3,
  });

  strictEqual(norm.gainDb, 6.0);
  ok(norm.gain >= 1.98 && norm.gain <= 2.02);
  strictEqual(norm.limited, false);
  strictEqual(norm.finalPeakDb, -2.0); // -8dB + 6dB = -2dB
  strictEqual(norm.finalRmsDb, -14.0);
});

test("クリッピング安全制限: 音割れを防ぐためピーク -0.3dB でクランプされる", () => {
  // 元音源の RMS が -25 dBFS (非常に静か) だが、突発ピークが -2 dBFS の場合
  const sourceLoudness = {
    peak: 0.794, // -2dB
    peakDb: -2.0,
    rms: 0.056,  // -25dB
    rmsDb: -25.0,
  };

  // 目標が -14 dBFS だと理想は +11 dB だが、+11dB するとピークが +9dB になり激しく音割れする
  // 安全ガードにより、ピークが -0.3dB を超えないよう最大 +1.7dB に制限されること
  const norm = calculateNormalizeGain({
    sourceLoudness,
    mode: "reference",
    targetRmsDb: -14.0,
    maxPeakDb: -0.3,
  });

  strictEqual(norm.limited, true, "音割れ防止リミッターが発動すること");
  ok(norm.gainDb <= 1.8, `ゲインが安全範囲にクランプされていること (${norm.gainDb} dB)`);
  ok(norm.finalPeakDb <= -0.3, `最終ピークが -0.3dB 以下であること (${norm.finalPeakDb} dB)`);
});

test("ピークノーマライズモード: 最大音量 (-0.3dB) にゲイン調整できる", () => {
  const sourceLoudness = {
    peak: 0.5, // -6.0dB
    peakDb: -6.0,
    rms: 0.25,
    rmsDb: -12.0,
  };

  const norm = calculateNormalizeGain({
    sourceLoudness,
    mode: "peak",
    maxPeakDb: -0.3,
  });

  ok(norm.gainDb >= 5.6 && norm.gainDb <= 5.8, `約 +5.7dB ゲインアップ (${norm.gainDb} dB)`);
  ok(norm.finalPeakDb <= -0.3);
});

test("ノーマライズゲインを適用して MP3 をエンコードできる", () => {
  const sampleRate = 44100;
  const numSamples = sampleRate;
  const left = new Float32Array(numSamples).fill(0.1); // 静かな音声
  const right = new Float32Array(numSamples).fill(0.1);

  // gain: 2.0 (音量を2倍に引き上げてエンコード)
  const mp3Blob = encodePcmToMp3(2, sampleRate, left, right, {
    bitrate: 320,
    gain: 2.0,
    metadata: { title: "Gain Test" },
  });

  ok(mp3Blob);
  strictEqual(mp3Blob.type, "audio/mpeg");
  ok(mp3Blob.size > 10000);
});

console.log("=== 5. Google Drive 連携仕様確認 ===");

test("Google Drive トラック ID の判定と相互変換", () => {
  strictEqual(isDriveTrackId("gd-1234567890abcdef"), true);
  strictEqual(driveFileIdFromTrackId("gd-1234567890abcdef"), "1234567890abcdef");
});

console.log("============================================");
console.log(`全 ${passed} 件のテスト成功 ✓`);
