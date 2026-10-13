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
 * PCM サンプルから MP3 Blob を生成
 * @param {number} channels 1 (mono) または 2 (stereo)
 * @param {number} sampleRate 例: 44100, 48000
 * @param {Float32Array|Int16Array} leftChannel
 * @param {Float32Array|Int16Array} [rightChannel]
 * @param {object} [opts]
 * @param {number} [opts.bitrate=320] MP3 ビットレート (kbps, デフォルト 320)
 * @param {object} [opts.metadata] ID3 タグ情報
 * @param {(pct: number) => void} [opts.onProgress]
 * @returns {Blob}
 */
export function encodePcmToMp3(channels, sampleRate, leftChannel, rightChannel = null, { bitrate = 320, metadata = null, onProgress = null } = {}) {
  const encChannels = channels >= 2 && rightChannel ? 2 : 1;
  const numSamples = leftChannel.length;
  const kbps = parseInt(bitrate, 10) || 320;

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
        const s = leftChannel[idx];
        leftInt16[j] = s < 0 ? Math.max(-32768, Math.round(s * 32768)) : Math.min(32767, Math.round(s * 32767));
      } else {
        leftInt16[j] = leftChannel[idx];
      }

      if (encChannels === 2) {
        if (isRightFloat) {
          const s = rightChannel[idx];
          rightInt16[j] = s < 0 ? Math.max(-32768, Math.round(s * 32768)) : Math.min(32767, Math.round(s * 32767));
        } else {
          rightInt16[j] = rightChannel[idx];
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
 * @param {object} [opts.metadata] ID3 メタデータ
 * @param {(pct: number) => void} [opts.onProgress]
 * @returns {Blob}
 */
export function sliceAndEncodeAudio(audioBuffer, { startTime = 0, endTime = null, bitrate = 320, metadata = null, onProgress = null } = {}) {
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
    metadata,
    onProgress,
  });
}
