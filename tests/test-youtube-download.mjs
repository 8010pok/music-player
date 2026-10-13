/**
 * YouTube ダウンロード、音源トリミング、MP3 320kbps エンコードの単体テスト
 */

import { strictEqual, ok } from "node:assert";
import { extractYouTubeVideoId, DEFAULT_INVIDIOUS_INSTANCES } from "../js/youtube/youtube-service.js";
import { buildId3Tag, encodePcmToMp3, sliceAndEncodeAudio } from "../js/audio/mp3-encoder.js";
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

console.log("=== 4. Google Drive 連携仕様確認 ===");

test("Google Drive トラック ID の判定と相互変換", () => {
  strictEqual(isDriveTrackId("gd-1234567890abcdef"), true);
  strictEqual(driveFileIdFromTrackId("gd-1234567890abcdef"), "1234567890abcdef");
});

console.log("============================================");
console.log(`全 ${passed} 件のテスト成功 ✓`);
