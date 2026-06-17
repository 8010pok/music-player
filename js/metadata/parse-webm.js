/**
 * WebM (Matroska/EBML) パーサ
 *
 * Matroska は EBML ベース。ID/サイズは可変長 (VINT)。
 *
 * 必要箇所:
 *   Segment > Info > Duration, TimecodeScale
 *   Segment > Tags > Tag > SimpleTag (TagName, TagString)
 *
 * フル EBML 解析は複雑なので、必要 ID を直接スキャンする簡略版。
 * 取得項目: title/artist/album/albumArtist/genre/year/trackNo/duration
 *
 * 主要 ID (binary を hex で):
 *   0x1A45DFA3 EBML
 *   0x18538067 Segment
 *   0x1549A966 Info
 *   0x2AD7B1   TimecodeScale
 *   0x4489     Duration
 *   0x1254C367 Tags
 *   0x7373     Tag
 *   0x67C8     SimpleTag
 *   0x45A3     TagName
 *   0x4487     TagString
 */

import { decode, readSlice } from "./util.js";

export async function parseWebm(blob) {
  const meta = makeEmpty();
  // 先頭 256KB を読んで EBML を辿る（多くの場合 Info/Tags はファイル前半に存在）
  const probeSize = Math.min(blob.size, 262144);
  const bytes = new Uint8Array(await readSlice(blob, 0, probeSize));

  try {
    // EBML をルートとして読み進める
    const segOff = findId(bytes, 0, [0x18, 0x53, 0x80, 0x67]); // Segment
    if (segOff < 0) return meta;
    const segStart = skipSize(bytes, segOff + 4);
    if (segStart < 0) return meta;

    // Segment の中で Info と Tags を探す
    const infoOff = findId(bytes, segStart, [0x15, 0x49, 0xa9, 0x66]);
    if (infoOff >= 0) {
      const infoStart = skipSize(bytes, infoOff + 4);
      if (infoStart >= 0) parseInfo(bytes, infoStart, meta);
    }
    const tagsOff = findId(bytes, segStart, [0x12, 0x54, 0xc3, 0x67]);
    if (tagsOff >= 0) {
      const tagsStart = skipSize(bytes, tagsOff + 4);
      if (tagsStart >= 0) parseTags(bytes, tagsStart, meta);
    }
    // Tracks > TrackEntry > Audio から音声プロパティを取得
    const tracksOff = findId(bytes, segStart, [0x16, 0x54, 0xae, 0x6b]);
    if (tracksOff >= 0) {
      const tracksStart = skipSize(bytes, tracksOff + 4);
      if (tracksStart >= 0) parseTracksForAudio(bytes, tracksStart, meta);
    }
  } catch (e) {
    console.warn("webm parse error", e);
  }

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
    lyrics: null, // webm は今回歌詞抽出対象外(スキーマ統一のため初期値のみ)
  };
}

/**
 * 指定 ID のオフセットを線形検索（簡易）
 * id: バイト配列
 */
function findId(bytes, from, id) {
  outer: for (let i = from; i + id.length <= bytes.length; i++) {
    for (let j = 0; j < id.length; j++) {
      if (bytes[i + j] !== id[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * EBML VINT 長を読み、データ本体の開始オフセットを返す
 */
function readVintLen(bytes, off) {
  if (off >= bytes.length) return [0, 0];
  const first = bytes[off];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 8) return [0, 0];
  let v = first & (mask - 1);
  for (let i = 1; i < len; i++) {
    if (off + i >= bytes.length) return [0, 0];
    v = v * 256 + bytes[off + i];
  }
  return [v, len];
}

function skipSize(bytes, off) {
  const [, len] = readVintLen(bytes, off);
  return len > 0 ? off + len : -1;
}

/**
 * Info 内を逐次走査して TimecodeScale / Duration を取得
 */
function parseInfo(bytes, start, meta) {
  // 安全のため一定範囲だけ
  let timecodeScale = 1_000_000; // デフォルト 1ms = 1,000,000 ns
  let durationTicks = 0;
  let p = start;
  const end = Math.min(bytes.length, start + 65536);
  while (p + 2 < end) {
    // ID 1〜4 バイトを読む
    const [id, idLen] = readVintLen(bytes, p);
    if (idLen === 0) break;
    p += idLen;
    const [size, sLen] = readVintLen(bytes, p);
    if (sLen === 0) break;
    p += sLen;
    if (p + size > end) break;

    // TimecodeScale 0x2AD7B1 (id raw だが VINT で読むと値が異なる場合あり)
    // ID を「ヘッダ4バイトを直接見る」やり方にフォールバック
    const rawId = readRawId(bytes, p - idLen - sLen, idLen);
    if (rawId === 0x2AD7B1) {
      timecodeScale = readUintN(bytes, p, size) || timecodeScale;
    } else if (rawId === 0x4489) {
      // Duration は float
      if (size === 4) {
        durationTicks = new DataView(bytes.buffer, bytes.byteOffset + p, 4).getFloat32(0, false);
      } else if (size === 8) {
        durationTicks = new DataView(bytes.buffer, bytes.byteOffset + p, 8).getFloat64(0, false);
      }
    }
    p += size;
  }
  if (durationTicks > 0) {
    meta.duration = (durationTicks * timecodeScale) / 1e9;
  }
}

/**
 * Tags 内を逐次走査して SimpleTag の (TagName, TagString) を取り出す
 */
function parseTags(bytes, start, meta) {
  // Matroska の Tags は階層構造:
  //   Tags > Tag(0x7373) > SimpleTag(0x67C8) > { TagName(0x45A3), TagString(0x4487) }
  // Tag / SimpleTag は子要素を内包する master 要素なので、size 分スキップせず
  // 中へ降りる必要がある。フラット走査だと最上位の Tag を丸ごと飛ばしてしまい、
  // TagName/TagString に到達できず WebM のタグが一切抽出されない。
  const end = Math.min(bytes.length, start + 65536);
  walkTagTree(bytes, start, end, meta);
}

/**
 * Tags サブツリーを再帰的に降り、SimpleTag を見つけたら名前/値を取り出す
 * @param {number} depth 再帰の深さ（過剰再帰の防御に使用）
 */
function walkTagTree(bytes, start, end, meta, depth = 0) {
  // 不正にネストした master 要素 (例: Tag(0x7373) が延々と入れ子) による
  // スタックオーバーフローを防ぐ。正常な Matroska は Tags>Tag>SimpleTag の
  // 浅い階層なので、この上限に達するのは壊れたファイルのみ。
  if (depth > 8) return;
  let p = start;
  while (p + 2 < end) {
    const headOff = p;
    const [, idLen] = readVintLen(bytes, p);
    if (idLen === 0) break;
    p += idLen;
    const [size, sLen] = readVintLen(bytes, p);
    if (sLen === 0) break;
    p += sLen;
    if (p + size > end) break;

    const rawId = readRawId(bytes, headOff, idLen);
    if (rawId === 0x7373) {
      // Tag master → 子 (SimpleTag 群) を辿る
      walkTagTree(bytes, p, p + size, meta, depth + 1);
    } else if (rawId === 0x67C8) {
      // SimpleTag master → 直下の TagName/TagString を取り出して適用
      parseSimpleTag(bytes, p, p + size, meta);
    }
    p += size;
  }
}

/**
 * 1 つの SimpleTag (0x67C8) の直下から TagName / TagString を取り出して適用する。
 * ネストした SimpleTag (階層タグ) は今回対象外（フラット構造のみ対応）。
 */
function parseSimpleTag(bytes, start, end, meta) {
  let p = start;
  let name = "", value = "";
  while (p + 2 < end) {
    const headOff = p;
    const [, idLen] = readVintLen(bytes, p);
    if (idLen === 0) break;
    p += idLen;
    const [size, sLen] = readVintLen(bytes, p);
    if (sLen === 0) break;
    p += sLen;
    if (p + size > end) break;

    const rawId = readRawId(bytes, headOff, idLen);
    if (rawId === 0x45A3) {
      // TagName
      name = decode(bytes.subarray(p, p + size), "utf-8").toUpperCase();
    } else if (rawId === 0x4487) {
      // TagString
      value = decode(bytes.subarray(p, p + size), "utf-8");
    }
    p += size;
  }
  applyTag(name, value, meta);
}

function applyTag(name, value, meta) {
  if (!name || !value) return;
  switch (name) {
    case "TITLE": meta.title = meta.title || value; break;
    case "ARTIST": meta.artist = meta.artist || value; break;
    case "ALBUM": meta.album = meta.album || value; break;
    case "ALBUM_ARTIST":
    case "ALBUM/ARTIST":
    case "ALBUMARTIST":
      meta.albumArtist = meta.albumArtist || value; break;
    case "DATE":
    case "YEAR":
    case "DATE_RECORDED":
      meta.year = meta.year || value; break;
    case "GENRE": meta.genre = meta.genre || value; break;
    case "TRACKNUMBER":
    case "PART_NUMBER":
      meta.trackNo = meta.trackNo || value; break;
    case "COMPOSER": meta.composer = meta.composer || value; break;
    case "DISC_NUMBER":
    case "DISCNUMBER":
    case "DISC":
      meta.discNo = meta.discNo || value; break;
    case "BPM": meta.bpm = meta.bpm || value; break;
  }
}

/**
 * Tracks 内の TrackEntry を辿り、最初の音声トラックの CodecID と Audio 要素から
 * sampleRate / channels / bitDepth を取得
 *
 * 主要ID:
 *   0xAE  TrackEntry
 *   0x83  TrackType (1=video, 2=audio, ...)
 *   0x86  CodecID  (string)
 *   0xE1  Audio
 *   0xB5  SamplingFrequency (float)
 *   0x9F  Channels (uint)
 *   0x6264 BitDepth (uint)
 */
function parseTracksForAudio(bytes, start, meta) {
  let p = start;
  const end = Math.min(bytes.length, start + 65536);
  let curCodec = "", curType = 0, curSr = 0, curCh = 0, curBd = 0;
  while (p + 2 < end) {
    const headOff = p;
    const [, idLen] = readVintLen(bytes, p);
    if (idLen === 0) break;
    p += idLen;
    const [size, sLen] = readVintLen(bytes, p);
    if (sLen === 0) break;
    p += sLen;
    if (p + size > end) break;

    const rawId = readRawId(bytes, headOff, idLen);
    if (rawId === 0xAE) {
      // TrackEntry の子要素を順に走査して 1 トラック分のコーデック/種別/サンプルレート等を集約する。
      //   最初の音声トラック(type===2)だけを採用する(下の audioProps 既設ガード)。
      parseTrackEntry(bytes, p, p + size, (codec, type, sr, ch, bd) => {
        if (type === 2 /* audio */) {
          if (meta.audioProps) return; // 最初の音声トラックだけ
          const codecLabel = labelCodec(codec);
          meta.audioProps = {
            codec: codecLabel,
            sampleRate: sr || null,
            bitrate: null,
            channels: ch || null,
            bitDepth: bd || null,
            vbr: null,
          };
        }
      });
    }
    p += size;
  }
}

function parseTrackEntry(bytes, start, end, onComplete) {
  let p = start;
  let codec = "", type = 0, sr = 0, ch = 0, bd = 0;
  end = Math.min(bytes.length, end);
  while (p + 2 < end) {
    const headOff = p;
    const [, idLen] = readVintLen(bytes, p);
    if (idLen === 0) break;
    p += idLen;
    const [size, sLen] = readVintLen(bytes, p);
    if (sLen === 0) break;
    p += sLen;
    if (p + size > end) break;
    const rawId = readRawId(bytes, headOff, idLen);
    if (rawId === 0x83) {
      type = readUintN(bytes, p, size);
    } else if (rawId === 0x86) {
      codec = decode(bytes.subarray(p, p + size), "utf-8");
    } else if (rawId === 0xE1) {
      // Audio 子要素を走査
      let q = p, qEnd = p + size;
      while (q + 2 < qEnd) {
        const qh = q;
        const [, il] = readVintLen(bytes, q);
        if (il === 0) break;
        q += il;
        const [sz2, sl2] = readVintLen(bytes, q);
        if (sl2 === 0) break;
        q += sl2;
        if (q + sz2 > qEnd) break;
        const rid = readRawId(bytes, qh, il);
        if (rid === 0xB5) {
          if (sz2 === 4) sr = new DataView(bytes.buffer, bytes.byteOffset + q, 4).getFloat32(0, false);
          else if (sz2 === 8) sr = new DataView(bytes.buffer, bytes.byteOffset + q, 8).getFloat64(0, false);
        } else if (rid === 0x9F) {
          ch = readUintN(bytes, q, sz2);
        } else if (rid === 0x6264) {
          bd = readUintN(bytes, q, sz2);
        }
        q += sz2;
      }
    }
    p += size;
  }
  onComplete(codec, type, Math.round(sr), ch, bd);
}

function labelCodec(codecId) {
  if (!codecId) return "WebM";
  if (codecId.startsWith("A_OPUS")) return "Opus";
  if (codecId.startsWith("A_VORBIS")) return "Vorbis";
  if (codecId.startsWith("A_AAC")) return "AAC";
  if (codecId.startsWith("A_MPEG/L3")) return "MP3";
  return codecId.replace(/^A_/, "");
}

function readRawId(bytes, off, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = (v << 8) | bytes[off + i];
  return v >>> 0;
}

function readUintN(bytes, off, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + bytes[off + i];
  return v;
}
