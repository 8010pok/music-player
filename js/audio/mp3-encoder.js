/**
 * MP3 エンコーダー & ID3 タグビルダー
 *
 * - Web Audio API の AudioBuffer / PCM データを MP3 (標準 320kbps) にエンコード
 * - 音源のトリミング（開始・終了秒数の切り出し）に対応
 * - ID3v2.3 タグ（曲名、アーティスト、アルバム、年、カバー画像）の埋め込みに対応
 */

import { lamejs } from "./lame.min.js";

/**
 * ID3v2.3 タグバイナリを構築
 * @param {object} meta
 * @param {string} [meta.title]
 * @param {string} [meta.artist]
 * @param {string} [meta.album]
 * @param {string|number} [meta.year]
 * @param {Uint8Array|ArrayBuffer} [meta.artworkBuffer]
 * @param {string} [meta.artworkMime]
 * @returns {Uint8Array}
 */
export function buildId3Tag({ title = "", artist = "", album = "", year = "", artworkBuffer = null, artworkMime = "image/jpeg" } = {}) {
  const frames = [];

  const addTextFrame = (id, text) => {
    if (!text) return;
    const str = String(text);
    // ID3v2.3: エンコーディングバイト 0x01 = UTF-16LE with BOM
    const bom = [0xff, 0xfe];
    const encoded = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      encoded.push(code & 0xff, (code >> 8) & 0xff);
    }
    const body = new Uint8Array([0x01, ...bom, ...encoded]);
    const frameHeader = new Uint8Array(10);
    // Frame ID (4 bytes ASCII)
    for (let i = 0; i < 4; i++) frameHeader[i] = id.charCodeAt(i);
    // Frame Size (4 bytes big-endian)
    const sz = body.length;
    frameHeader[4] = (sz >> 24) & 0xff;
    frameHeader[5] = (sz >> 16) & 0xff;
    frameHeader[6] = (sz >> 8) & 0xff;
    frameHeader[7] = sz & 0xff;
    // Flags (2 bytes, 0)
    frameHeader[8] = 0;
    frameHeader[9] = 0;

    frames.push(frameHeader, body);
  };

  addTextFrame("TIT2", title); // 曲名
  addTextFrame("TPE1", artist); // アーティスト
  addTextFrame("TALB", album); // アルバム
  if (year) addTextFrame("TYER", String(year)); // 年

  // カバー画像 (APIC フレーム)
  if (artworkBuffer) {
    const artBytes = artworkBuffer instanceof Uint8Array ? artworkBuffer : new Uint8Array(artworkBuffer);
    if (artBytes.length > 0) {
      const mime = artworkMime || "image/jpeg";
      const mimeBytes = [];
      for (let i = 0; i < mime.length; i++) mimeBytes.push(mime.charCodeAt(i));
      mimeBytes.push(0); // null terminator

      // encoding(1 byte=0 ISO-8859-1) + mimeBytes + pictureType(1 byte=3 Front Cover) + description(1 byte null=0) + pictureData
      const apicBody = new Uint8Array(1 + mimeBytes.length + 1 + 1 + artBytes.length);
      apicBody[0] = 0; // ISO-8859-1
      apicBody.set(mimeBytes, 1);
      apicBody[1 + mimeBytes.length] = 3; // Front Cover
      apicBody[1 + mimeBytes.length + 1] = 0; // Empty description null
      apicBody.set(artBytes, 1 + mimeBytes.length + 2);

      const frameHeader = new Uint8Array(10);
      frameHeader[0] = 65; frameHeader[1] = 80; frameHeader[2] = 73; frameHeader[3] = 67; // APIC
      const sz = apicBody.length;
      frameHeader[4] = (sz >> 24) & 0xff;
      frameHeader[5] = (sz >> 16) & 0xff;
      frameHeader[6] = (sz >> 8) & 0xff;
      frameHeader[7] = sz & 0xff;

      frames.push(frameHeader, apicBody);
    }
  }

  if (frames.length === 0) {
    return new Uint8Array(0);
  }

  let totalFramesSize = 0;
  for (const f of frames) totalFramesSize += f.length;

  // ID3v2 ヘッダー (10 bytes)
  const header = new Uint8Array(10);
  header[0] = 0x49; // 'I'
  header[1] = 0x44; // 'D'
  header[2] = 0x33; // '3'
  header[3] = 0x03; // version 2.3
  header[4] = 0x00; // revision 0
  header[5] = 0x00; // flags

  // synchsafe integer (7 bits per byte)
  header[6] = (totalFramesSize >> 21) & 0x7f;
  header[7] = (totalFramesSize >> 14) & 0x7f;
  header[8] = (totalFramesSize >> 7) & 0x7f;
  header[9] = totalFramesSize & 0x7f;

  const result = new Uint8Array(10 + totalFramesSize);
  result.set(header, 0);
  let offset = 10;
  for (const f of frames) {
    result.set(f, offset);
    offset += f.length;
  }

  return result;
}

/**
 * AudioBuffer から指定区間（または全体）の音量ラウドネス（Peak / RMS）を計測
 * @param {AudioBuffer} audioBuffer
 * @param {object} [opts]
 * @param {number} [opts.startTime=0]
 * @param {number} [opts.endTime=null]
 * @returns {{ peak: number, peakDb: number, rms: number, rmsDb: number }}
 */
export function analyzeAudioLoudness(audioBuffer, { startTime = 0, endTime = null } = {}) {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;

  const startSec = Math.max(0, Number(startTime) || 0);
  const endSec = endTime != null && Number(endTime) > startSec ? Number(endTime) : audioBuffer.duration;

  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const endSample = Math.min(audioBuffer.length, Math.floor(endSec * sampleRate));
  const len = Math.max(0, endSample - startSample);

  if (len === 0) {
    return { peak: 0, peakDb: -100, rms: 0, rmsDb: -100 };
  }

  // 高速化のため、最大 200,000 サンプル（またはステップサンプリング）で走査
  const step = Math.max(1, Math.floor(len / 200000));
  let peak = 0;
  let sumSquare = 0;
  let sampleCount = 0;

  for (let c = 0; c < numChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = startSample; i < endSample; i += step) {
      const val = Math.abs(channelData[i]);
      if (val > peak) peak = val;
      sumSquare += val * val;
      sampleCount++;
    }
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquare / sampleCount) : 0;
  const peakDb = peak > 0.000001 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -100;
  const rmsDb = rms > 0.000001 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -100;

  return { peak, peakDb, rms, rmsDb };
}

/**
 * ノーマライズに必要なゲイン（倍率 & dB）を算出
 * @param {object} params
 * @param {{ peak: number, peakDb: number, rms: number, rmsDb: number }} params.sourceLoudness 元音源のラウドネス
 * @param {"reference"|"peak"|"manual"|"none"} [params.mode="reference"]
 * @param {number} [params.targetRmsDb=-14.0] 基準曲（または目標）の RMS dBFS
 * @param {number} [params.manualGainDb=0] 手動調整時のゲイン dB
 * @param {number} [params.maxPeakDb=-0.3] クリッピング防止上限 dBFS (デフォルト -0.3dB)
 * @returns {{ gain: number, gainDb: number, limited: boolean, finalPeakDb: number, finalRmsDb: number }}
 */
export function calculateNormalizeGain({
  sourceLoudness,
  mode = "reference",
  targetRmsDb = -14.0,
  manualGainDb = 0,
  maxPeakDb = -0.3,
}) {
  if (!sourceLoudness || sourceLoudness.peak <= 0.00001) {
    return { gain: 1.0, gainDb: 0, limited: false, finalPeakDb: -100, finalRmsDb: -100 };
  }

  const maxAllowedPeakLinear = Math.pow(10, maxPeakDb / 20); // 約 0.966
  const maxSafeGain = maxAllowedPeakLinear / Math.max(0.0001, sourceLoudness.peak);

  let desiredGain = 1.0;

  if (mode === "none") {
    desiredGain = 1.0;
  } else if (mode === "peak") {
    // ピークを maxPeakDb (-0.3dB) に合わせる
    desiredGain = maxSafeGain;
  } else if (mode === "reference") {
    // 目標 RMS との差分をゲインとして計算
    const deltaDb = targetRmsDb - sourceLoudness.rmsDb;
    desiredGain = Math.pow(10, deltaDb / 20);
  } else if (mode === "manual") {
    desiredGain = Math.pow(10, manualGainDb / 20);
  }

  // クリッピング防止のため、最大安全ゲインで制限（安全ガード）
  let finalGain = desiredGain;
  let limited = false;
  if (finalGain > maxSafeGain) {
    finalGain = maxSafeGain;
    limited = true;
  }

  // 極端な減衰（-24dB 以下）や過大増幅（+24dB 以上）を防ぐ安全クランプ
  finalGain = Math.max(0.063, Math.min(15.8, finalGain));

  const gainDb = Math.round(20 * Math.log10(finalGain) * 10) / 10;
  const finalPeakDb = Math.min(maxPeakDb, Math.round((sourceLoudness.peakDb + gainDb) * 10) / 10);
  const finalRmsDb = Math.round((sourceLoudness.rmsDb + gainDb) * 10) / 10;

  return {
    gain: finalGain,
    gainDb,
    limited,
    finalPeakDb,
    finalRmsDb,
  };
}

/**
 * PCM サンプルから MP3 Blob を生成
 * @param {number} channels 1 (mono) または 2 (stereo)
 * @param {number} sampleRate 例: 44100, 48000
 * @param {Float32Array|Int16Array} leftChannel
 * @param {Float32Array|Int16Array} [rightChannel]
 * @param {object} [opts]
 * @param {number} [opts.bitrate=320] MP3 ビットレート (kbps, デフォルト 320)
 * @param {number} [opts.gain=1.0] 音量ゲイン倍率 (ノーマライズ用)
 * @param {object} [opts.metadata] ID3 タグ情報
 * @param {(pct: number) => void} [opts.onProgress]
 * @returns {Blob}
 */
export function encodePcmToMp3(channels, sampleRate, leftChannel, rightChannel = null, { bitrate = 320, gain = 1.0, metadata = null, onProgress = null } = {}) {
  const encChannels = channels >= 2 && rightChannel ? 2 : 1;
  const numSamples = leftChannel.length;
  const kbps = parseInt(bitrate, 10) || 320;
  const applyGain = typeof gain === "number" && !isNaN(gain) && gain > 0 ? gain : 1.0;

  const mp3encoder = new lamejs.Mp3Encoder(encChannels, sampleRate, kbps);
  const mp3Data = [];

  // ID3 タグの構築と先頭追加
  if (metadata) {
    const id3Bytes = buildId3Tag(metadata);
    if (id3Bytes.length > 0) {
      mp3Data.push(id3Bytes);
    }
  }

  const blockSize = 1152; // LAME エンコードブロックサイズ
  const leftInt16 = new Int16Array(blockSize);
  const rightInt16 = encChannels === 2 ? new Int16Array(blockSize) : null;

  const isLeftFloat = leftChannel instanceof Float32Array;
  const isRightFloat = rightChannel instanceof Float32Array;

  let processed = 0;
  for (let i = 0; i < numSamples; i += blockSize) {
    const chunkLen = Math.min(blockSize, numSamples - i);

    for (let j = 0; j < chunkLen; j++) {
      const idx = i + j;
      if (isLeftFloat) {
        let s = leftChannel[idx] * applyGain;
        if (s > 1.0) s = 1.0;
        else if (s < -1.0) s = -1.0;
        leftInt16[j] = s < 0 ? Math.max(-32768, Math.round(s * 32768)) : Math.min(32767, Math.round(s * 32767));
      } else {
        let s = leftChannel[idx] * applyGain;
        leftInt16[j] = s < -32768 ? -32768 : (s > 32767 ? 32767 : Math.round(s));
      }

      if (encChannels === 2) {
        if (isRightFloat) {
          let s = rightChannel[idx] * applyGain;
          if (s > 1.0) s = 1.0;
          else if (s < -1.0) s = -1.0;
          rightInt16[j] = s < 0 ? Math.max(-32768, Math.round(s * 32768)) : Math.min(32767, Math.round(s * 32767));
        } else {
          let s = rightChannel[idx] * applyGain;
          rightInt16[j] = s < -32768 ? -32768 : (s > 32767 ? 32767 : Math.round(s));
        }
      }
    }

    // chunkLen が blockSize 未満の場合は末尾をゼロ埋め
    if (chunkLen < blockSize) {
      for (let j = chunkLen; j < blockSize; j++) {
        leftInt16[j] = 0;
        if (encChannels === 2) rightInt16[j] = 0;
      }
    }

    let mp3buf;
    if (encChannels === 2) {
      mp3buf = mp3encoder.encodeBuffer(leftInt16, rightInt16);
    } else {
      mp3buf = mp3encoder.encodeBuffer(leftInt16);
    }

    if (mp3buf.length > 0) {
      mp3Data.push(new Uint8Array(mp3buf));
    }

    processed += chunkLen;
    if (onProgress && (i % (blockSize * 20) === 0 || processed >= numSamples)) {
      onProgress(Math.min(99, Math.round((processed / numSamples) * 100)));
    }
  }

  const flushed = mp3encoder.flush();
  if (flushed.length > 0) {
    mp3Data.push(new Uint8Array(flushed));
  }

  if (onProgress) onProgress(100);

  return new Blob(mp3Data, { type: "audio/mpeg" });
}

/**
 * Web Audio API の AudioBuffer をトリミングして MP3 320kbps にエンコード
 * @param {AudioBuffer} audioBuffer
 * @param {object} [opts]
 * @param {number} [opts.startTime=0] 切り出し開始時間 (秒)
 * @param {number} [opts.endTime=null] 切り出し終了時間 (秒, null の場合は曲末尾)
 * @param {number} [opts.bitrate=320] MP3 ビットレート (デフォルト 320kbps)
 * @param {number} [opts.gain=1.0] 音量ノーマライズ用ゲイン
 * @param {object} [opts.metadata] ID3 メタデータ
 * @param {(pct: number) => void} [opts.onProgress]
 * @returns {Blob}
 */
export function sliceAndEncodeAudio(audioBuffer, { startTime = 0, endTime = null, bitrate = 320, gain = 1.0, metadata = null, onProgress = null } = {}) {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;

  const startSec = Math.max(0, Number(startTime) || 0);
  const endSec = endTime != null && Number(endTime) > startSec ? Number(endTime) : audioBuffer.duration;

  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const endSample = Math.min(audioBuffer.length, Math.floor(endSec * sampleRate));
  const sliceLen = Math.max(0, endSample - startSample);

  if (sliceLen === 0) {
    throw new Error("指定されたカット範囲が無効です（長さが0です）");
  }

  const leftChannel = audioBuffer.getChannelData(0).subarray(startSample, endSample);
  const rightChannel = numChannels >= 2 ? audioBuffer.getChannelData(1).subarray(startSample, endSample) : null;

  return encodePcmToMp3(numChannels, sampleRate, leftChannel, rightChannel, {
    bitrate: bitrate || 320,
    gain: typeof gain === "number" ? gain : 1.0,
    metadata,
    onProgress,
  });
}
