/**
 * 動画からの音声抽出サービス (video-audio-extractor.js) の単体テスト
 */

import { strictEqual, ok } from "node:assert";
import {
  inferMetadataFromFilename,
  encodeVideoAudioTrack,
} from "../js/audio/video-audio-extractor.js";

let passed = 0;
const pendingTests = [];
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

function asyncTest(name, fn) {
  const p = (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}`);
      throw e;
    }
  })();
  pendingTests.push(p);
}

console.log("=== 1. 動画ファイル名からのメタデータ推測テスト ===");

test("Artist - Title 形式の動画ファイル名を綺麗に分離・正規化できる", () => {
  const r1 = inferMetadataFromFilename("YOASOBI - アイドル.mp4");
  strictEqual(r1.artist, "YOASOBI");
  strictEqual(r1.title, "アイドル");

  const r2 = inferMetadataFromFilename("King Gnu - 白日 [Official Video].mov");
  strictEqual(r2.artist, "King Gnu");
  strictEqual(r2.title, "白日");

  const r3 = inferMetadataFromFilename("Ado - 唱 【MV】.webm");
  strictEqual(r3.artist, "Ado");
  strictEqual(r3.title, "唱");
});

test("アーティスト名がない動画ファイル名はタイトルのみ抽出し、アーティストは「不明」にフォールバック", () => {
  const r1 = inferMetadataFromFilename("2026-10-15_ギター練習.mp4");
  strictEqual(r1.title, "2026-10-15_ギター練習");
  strictEqual(r1.artist, "不明なアーティスト");

  const r2 = inferMetadataFromFilename("");
  strictEqual(r2.title, "無題の楽曲");
  strictEqual(r2.artist, "不明なアーティスト");

  const r3 = inferMetadataFromFilename(null);
  strictEqual(r3.title, "無題の楽曲");
  strictEqual(r3.artist, "不明なアーティスト");
});

console.log("=== 2. 音声バッファのトリミング & MP3 320kbps エンコードテスト ===");

asyncTest("encodeVideoAudioTrack でトリミングと MP3 エンコードが正常に完了する", async () => {
  const sampleRate = 44100;
  const numSamples = sampleRate * 2; // 2秒
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const val = 0.25 * Math.sin(2 * Math.PI * 440 * (i / sampleRate));
    left[i] = val;
    right[i] = val;
  }

  class MockAudioBuffer {
    constructor() {
      this.sampleRate = sampleRate;
      this.numberOfChannels = 2;
      this.duration = 2.0;
      this.length = numSamples;
    }
    getChannelData(c) {
      return c === 0 ? left : right;
    }
  }

  const mockBuf = new MockAudioBuffer();
  globalThis.AudioBuffer = MockAudioBuffer;

  let progressReported = false;
  const result = await encodeVideoAudioTrack(mockBuf, {
    startTime: 0.5,
    endTime: 1.5,
    title: "動画テスト曲",
    artist: "動画アーティスト",
    album: "動画アルバム",
    normalizeMode: "reference",
    targetRmsDb: -14.0,
    onProgress: (pct) => {
      progressReported = true;
      ok(pct >= 0 && pct <= 100);
    },
  });

  ok(result, "エンコード結果オブジェクトが返ること");
  ok(result.mp3Blob, "MP3 Blob が生成されていること");
  strictEqual(result.mp3Blob.type, "audio/mpeg");
  ok(result.mp3Blob.size > 20000, `MP3 サイズが十分にあること (${result.mp3Blob.size} bytes)`);

  // カット後の長さは 1.5 - 0.5 = 1.0秒
  strictEqual(result.duration, 1.0);
  ok(result.gain > 0, "ノーマライズゲインが算出されていること");
  ok(progressReported, "進捗コールバックが呼ばれたこと");
});

asyncTest("encodeVideoAudioTrack で normalizeMode='none' の時はゲイン 1.0", async () => {
  const sampleRate = 44100;
  const numSamples = sampleRate * 1;
  const left = new Float32Array(numSamples);
  const right = new Float32Array(numSamples);

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

  const result = await encodeVideoAudioTrack(new MockAudioBuffer(), {
    startTime: 0,
    endTime: 1.0,
    normalizeMode: "none",
  });

  strictEqual(result.gain, 1.0);
  strictEqual(result.gainDb, 0.0);
});

// 非同期テストの完了を待機
await Promise.all(pendingTests);

console.log(`\n========================================`);
console.log(`全 ${passed} 件の動画音声抽出テストが正常に通過しました！`);
console.log(`========================================\n`);
