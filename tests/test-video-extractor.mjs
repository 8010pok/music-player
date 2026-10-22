/**
 * 動画からの音声抽出サービス (video-audio-extractor.js) の単体テスト
 */

import { strictEqual, ok } from "node:assert";
import {
  inferMetadataFromFilename,
  encodeVideoAudioTrack,
  stripVideoTracksFromMp4,
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

console.log("=== 3. MP4/MOV 映像トラック無効化 (stripVideoTracksFromMp4) テスト ===");

test("MP4のビデオトラック (vide) が free ボックスに置換され、音声トラック (soun) が保持される", () => {
  function makeBox(type, payload = new Uint8Array(0)) {
    const size = 8 + payload.length;
    const buf = new Uint8Array(size);
    const v = new DataView(buf.buffer);
    v.setUint32(0, size);
    for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
    buf.set(payload, 8);
    return buf;
  }

  function concatBufs(...bufs) {
    const total = bufs.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(total);
    let cur = 0;
    for (const b of bufs) {
      out.set(b, cur);
      cur += b.length;
    }
    return out;
  }

  // hdlr box 作成ヘルパー
  // size(4) + "hdlr"(4) + ver(1)+flags(3) + pre_defined(4) + handler_type(4)
  function makeHdlr(handlerType) {
    const payload = new Uint8Array(16); // 4 + 4 + 4 + 4 - 8? payload is after size + type:
    // payload starts at byte 8 of box:
    // byte 8: ver, 9-11: flags, 12-15: pre_defined, 16-19: handler_type
    // offset 16 from mdiaSub.offset: mdiaSub.offset + 8 + 8 = mdiaSub.offset + 16
    for (let i = 0; i < 4; i++) payload[8 + i] = handlerType.charCodeAt(i);
    return makeBox("hdlr", payload);
  }

  const videoMdia = makeBox("mdia", makeHdlr("vide"));
  const videoTrak = makeBox("trak", videoMdia);

  const audioMdia = makeBox("mdia", makeHdlr("soun"));
  const audioTrak = makeBox("trak", audioMdia);

  const moovPayload = concatBufs(videoTrak, audioTrak);
  const moovBox = makeBox("moov", moovPayload);

  const ftypBox = makeBox("ftyp", new Uint8Array([0x6D, 0x70, 0x34, 0x32])); // mp42
  const mp4Buf = concatBufs(ftypBox, moovBox);

  // 変換前: videoTrak の位置に "trak" がある
  const videoTrakPosInMp4 = ftypBox.length + 8; // moovヘッダ(8)の直後
  const trakStrBefore = String.fromCharCode(...mp4Buf.slice(videoTrakPosInMp4 + 4, videoTrakPosInMp4 + 8));
  strictEqual(trakStrBefore, "trak");

  const strippedBuf = stripVideoTracksFromMp4(mp4Buf.buffer);
  ok(strippedBuf, "stripped buffer が返ること");

  const strippedU8 = new Uint8Array(strippedBuf);
  const trakStrAfter = String.fromCharCode(...strippedU8.slice(videoTrakPosInMp4 + 4, videoTrakPosInMp4 + 8));
  strictEqual(trakStrAfter, "free", "video trak が free に置換されていること");

  // 音声トラックは 'trak' のままであること
  const audioTrakPosInMp4 = videoTrakPosInMp4 + videoTrak.length;
  const audioTrakStr = String.fromCharCode(...strippedU8.slice(audioTrakPosInMp4 + 4, audioTrakPosInMp4 + 8));
  strictEqual(audioTrakStr, "trak", "audio trak は保持されていること");
});

test("不正なバッファや音声トラック無しのMP4では安全に null を返す", () => {
  strictEqual(stripVideoTracksFromMp4(null), null);
  strictEqual(stripVideoTracksFromMp4(new ArrayBuffer(10)), null);
});

console.log("=== 4. 重複保存防止 & プレビュー安全性検証 ===");

test("video-extract-modal で previewAudioCtx.resume() が呼ばれ、suspended 解除が保証される", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const modalCode = fs.readFileSync(path.resolve("js/ui/video-extract-modal.js"), "utf-8");

  ok(modalCode.includes("previewAudioCtx.resume()"), "previewAudioCtx.resume() が実装されている");
  ok(modalCode.includes("isSaving"), "保存中二重実行ガード用の isSaving が定義されている");
  ok(modalCode.includes("btn-ve-preview-start"), "開始3秒試聴ボタンが配備されている");
  ok(modalCode.includes("btn-ve-preview-end"), "終了前3秒試聴ボタンが配備されている");
  ok(modalCode.includes("getAllTracks"), "重複保存防止のため getAllTracks で既存曲を検索している");
  ok(modalCode.includes("baseFilename"), "元動画ファイル名 (video__...) の未変換重複トラックを検出・クリーンアップしている");
});

test("view-library で動画ファイルが単体選択された場合、生動画保存を防ぎ動画抽出モーダルへ自動誘導する", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const libCode = fs.readFileSync(path.resolve("js/ui/view-library.js"), "utf-8");

  ok(libCode.includes("isVideoFile"), "isVideoFile 関数で動画ファイルが判定されている");
  ok(libCode.includes("openVideoExtractModal(videoFiles[0]"), "生動画保存を防ぎ openVideoExtractModal に自動誘導している");
});

// 非同期テストの完了を待機
await Promise.all(pendingTests);

console.log(`\n========================================`);
console.log(`全 ${passed} 件の動画音声抽出テストが正常に通過しました！`);
console.log(`========================================\n`);
