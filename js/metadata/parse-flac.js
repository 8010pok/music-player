/**
 * FLAC パーサ
 *
 * 構造:
 *   "fLaC" マジック + メタデータブロック群 + フレーム群
 * メタデータブロック:
 *   STREAMINFO (type 0) ... 必須
 *   VORBIS_COMMENT (type 4)
 *   PICTURE (type 6)
 *
 * 取得項目:
 *   STREAMINFO: sample rate, total samples → duration
 *   VORBIS_COMMENT: TITLE/ARTIST/ALBUM/ALBUMARTIST/TRACKNUMBER/DATE/GENRE
 *   PICTURE: アートワーク
 */

import { Reader, decode, bytesToImageBlob, readSlice } from "./util.js";
import { applyVorbisLyricTag, hasLyrics } from "./lyrics.js";

export async function parseFlac(blob) {
  const meta = makeEmpty();
  const headBuf = await readSlice(blob, 0, 4);
  const head = new Uint8Array(headBuf);
  if (head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) {
    // fLaC マジック無し
    return meta;
  }

  let p = 4;
  while (true) {
    const blkHeadBuf = await readSlice(blob, p, p + 4);
    if (blkHeadBuf.byteLength < 4) break;
    const bh = new Uint8Array(blkHeadBuf);
    const isLast = (bh[0] & 0x80) !== 0;
    const type = bh[0] & 0x7f;
    const len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    const blkStart = p + 4;
    if (type === 0 /* STREAMINFO */) {
      const buf = await readSlice(blob, blkStart, blkStart + len);
      parseStreamInfo(new Uint8Array(buf), meta);
    } else if (type === 4 /* VORBIS_COMMENT */) {
      const buf = await readSlice(blob, blkStart, blkStart + len);
      parseVorbisComment(new Uint8Array(buf), meta);
    } else if (type === 6 /* PICTURE */) {
      const buf = await readSlice(blob, blkStart, blkStart + len);
      parsePicture(new Uint8Array(buf), meta);
    }
    p = blkStart + len;
    if (isLast) break;
    if (p >= blob.size) break;
  }

  // 歌詞が結局空なら null に正規化
  if (meta.lyrics && !hasLyrics(meta.lyrics)) meta.lyrics = null;

  return meta;
}

function makeEmpty() {
  return {
    title: "", artist: "", album: "", albumArtist: "",
    year: "", genre: "", trackNo: "",
    composer: "", discNo: "", bpm: "",
    duration: 0,
    artworkBlob: null,
    audioProps: null,
    lyrics: null,
  };
}

/**
 * STREAMINFO (34 bytes)
 *   min/max block size, min/max frame size, sample rate (20bit), channels (3bit),
 *   bits per sample (5bit), total samples (36bit)
 */
function parseStreamInfo(bytes, meta) {
  if (bytes.length < 18) return;
  // sample rate は 10..13 バイト目の 20bit
  const sr = (bytes[10] << 12) | (bytes[11] << 4) | (bytes[12] >> 4);
  // channels (3bit) + bits per sample (5bit)
  const channels = ((bytes[12] >> 1) & 0x07) + 1;
  const bitDepth = (((bytes[12] & 0x01) << 4) | (bytes[13] >> 4)) + 1;
  // total samples (36bit): 12 の下位4bit + 13..16 ではなく、 13 の下位 4bit + 14..17 (FLAC 仕様)
  // bytes index: 0-17 = min/maxBlockSize + min/maxFrameSize + (sampleRate20 + channels3 + bitDepth5 + total36 = 64bit)
  const totalHi = (bytes[13] & 0x0f);
  const totalLo = (bytes[14] << 24) | (bytes[15] << 16) | (bytes[16] << 8) | bytes[17];
  const totalSamples = totalHi * 0x100000000 + (totalLo >>> 0);
  if (sr > 0 && totalSamples > 0) {
    meta.duration = totalSamples / sr;
  }
  meta.audioProps = {
    codec: "FLAC",
    sampleRate: sr,
    bitrate: null, // 平均ビットレートは呼び出し側で fileSize/duration から算出
    channels,
    bitDepth,
    vbr: null,     // FLAC は可逆圧縮で VBR/CBR の概念なし
  };
}

/**
 * Vorbis Comment ブロック
 *   vendor_len (u32 LE) + vendor + comment_count (u32 LE) +
 *   for each: comment_len (u32 LE) + "KEY=VALUE"
 */
function parseVorbisComment(bytes, meta) {
  if (bytes.length < 4) return;
  const r = new Reader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const vendorLen = r.readU32LE();
  r.skip(vendorLen);
  if (r.remaining() < 4) return;
  const count = r.readU32LE();
  for (let i = 0; i < count; i++) {
    if (r.remaining() < 4) break;
    const len = r.readU32LE();
    if (len > r.remaining()) break;
    const txt = decode(r.readBytes(len), "utf-8");
    const eq = txt.indexOf("=");
    if (eq < 0) continue;
    const key = txt.substring(0, eq).toUpperCase();
    const val = txt.substring(eq + 1).trim();
    applyVorbisTag(key, val, meta);
  }
}

function applyVorbisTag(key, val, meta) {
  // 歌詞キー(SYNCEDLYRICS/UNSYNCEDLYRICS/LYRICS)は共通モジュールで処理
  if (applyVorbisLyricTag(key, val, meta)) return;
  switch (key) {
    case "TITLE": meta.title = meta.title || val; break;
    case "ARTIST": meta.artist = meta.artist || val; break;
    case "ALBUM": meta.album = meta.album || val; break;
    case "ALBUMARTIST":
    case "ALBUM ARTIST":
      meta.albumArtist = meta.albumArtist || val; break;
    case "DATE":
    case "YEAR":
      meta.year = meta.year || val; break;
    case "GENRE": meta.genre = meta.genre || val; break;
    case "TRACKNUMBER": meta.trackNo = meta.trackNo || val; break;
    case "COMPOSER": meta.composer = meta.composer || val; break;
    case "DISCNUMBER":
    case "DISC":
      meta.discNo = meta.discNo || val; break;
    case "BPM": meta.bpm = meta.bpm || val; break;
  }
}

/**
 * PICTURE ブロック
 *   type(u32 BE) | mime_len(u32 BE) | mime | desc_len(u32 BE) | desc |
 *   width(u32 BE) | height | depth | colors | pic_len(u32 BE) | picture
 */
function parsePicture(bytes, meta) {
  const r = new Reader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  try {
    /* const type = */ r.readU32BE();
    const mimeLen = r.readU32BE();
    const mime = decode(r.readBytes(mimeLen), "iso-8859-1");
    const descLen = r.readU32BE();
    r.skip(descLen);
    r.skip(16); // width/height/depth/colors
    const picLen = r.readU32BE();
    if (picLen > 0 && picLen <= r.remaining()) {
      const pic = r.readBytes(picLen);
      meta.artworkBlob = bytesToImageBlob(pic, mime || "image/jpeg");
    }
  } catch {}
}
