/**
 * OGG / OPUS パーサ
 *
 * OGG コンテナを最小限解析し、最初のページの Vorbis/Opus セットアップから
 * VORBIS_COMMENT 相当を取り出す。
 *
 *   OggS ページ:
 *     0..3 "OggS"
 *     4    version (0)
 *     5    header_type
 *     6..13 granule_position (LE 64)
 *     14..17 bitstream serial number
 *     18..21 page sequence
 *     22..25 checksum
 *     26 segments count (n)
 *     27..27+n segment_table
 *     その後にデータ
 *
 * 中身が Vorbis なら 2 番目のパケット(タイプ=3) が comment、
 * 中身が Opus  なら 1 番目のパケットの直後の "OpusTags" が comment。
 *
 * 簡略化のため、最初の数ページだけ読んでパケットを連結し、
 *   "vorbis" シグネチャ + 0x03 か、"OpusTags" を探す方針とする。
 */

import { Reader, decode, readSlice } from "./util.js";
import { applyVorbisLyricTag, hasLyrics } from "./lyrics.js";

export async function parseOgg(blob) {
  const meta = makeEmpty();

  // 先頭 64KB だけ読めば多くの場合 comment ヘッダに到達できる
  const head = new Uint8Array(await readSlice(blob, 0, Math.min(blob.size, 65536)));
  const pages = readPages(head);
  if (pages.length === 0) return meta;

  // 各ストリームのパケット連結
  const streams = new Map(); // serial -> { segments: [Uint8Array], lastIsContinued: bool }
  for (const page of pages) {
    let s = streams.get(page.serial);
    if (!s) { s = { packets: [], cur: [] }; streams.set(page.serial, s); }
    for (let i = 0; i < page.segments.length; i++) {
      const seg = page.segments[i];
      s.cur.push(seg);
      if (seg.length < 255) {
        // パケット境界
        const total = s.cur.reduce((a, b) => a + b.length, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of s.cur) { buf.set(c, off); off += c.length; }
        s.packets.push(buf);
        s.cur = [];
      }
    }
  }

  // 全パケットを集めて Vorbis/Opus の identification + comment を検索
  let foundComment = false;
  for (const [, s] of streams) {
    for (const pkt of s.packets) {
      // Vorbis identification ヘッダ: 0x01 + "vorbis"
      if (pkt.length > 7 && pkt[0] === 0x01 &&
          pkt[1] === 0x76 && pkt[2] === 0x6f && pkt[3] === 0x72 &&
          pkt[4] === 0x62 && pkt[5] === 0x69 && pkt[6] === 0x73) {
        parseVorbisId(pkt, meta);
        continue;
      }
      // Opus identification: "OpusHead"
      if (pkt.length > 8 &&
          pkt[0] === 0x4f && pkt[1] === 0x70 && pkt[2] === 0x75 && pkt[3] === 0x73 &&
          pkt[4] === 0x48 && pkt[5] === 0x65 && pkt[6] === 0x61 && pkt[7] === 0x64) {
        parseOpusId(pkt, meta);
        continue;
      }
      // Vorbis comment ヘッダ: 0x03 + "vorbis"
      if (!foundComment && pkt.length > 7 && pkt[0] === 0x03 &&
          pkt[1] === 0x76 && pkt[2] === 0x6f && pkt[3] === 0x72 &&
          pkt[4] === 0x62 && pkt[5] === 0x69 && pkt[6] === 0x73) {
        parseVorbisComment(pkt.subarray(7), meta);
        foundComment = true;
        continue;
      }
      // Opus comment ヘッダ: "OpusTags"
      if (!foundComment && pkt.length > 8 &&
          pkt[0] === 0x4f && pkt[1] === 0x70 && pkt[2] === 0x75 && pkt[3] === 0x73 &&
          pkt[4] === 0x54 && pkt[5] === 0x61 && pkt[6] === 0x67 && pkt[7] === 0x73) {
        parseVorbisComment(pkt.subarray(8), meta);
        foundComment = true;
        continue;
      }
    }
  }

  // 再生時間: 末尾ページの granule_position / sample_rate
  // meta を渡してコーデック別に正しいサンプルレートで秒換算する(下記参照)
  meta.duration = await estimateOggDuration(blob, meta);

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
 * バッファから OggS ページを順次読む
 */
function readPages(bytes) {
  const pages = [];
  let p = 0;
  while (p + 27 <= bytes.length) {
    if (!(bytes[p] === 0x4f && bytes[p+1] === 0x67 && bytes[p+2] === 0x67 && bytes[p+3] === 0x53)) {
      p++;
      continue;
    }
    const segCount = bytes[p + 26];
    const segTableEnd = p + 27 + segCount;
    if (segTableEnd > bytes.length) break;
    const segments = [];
    let off = segTableEnd;
    for (let i = 0; i < segCount; i++) {
      const len = bytes[p + 27 + i];
      if (off + len > bytes.length) { segments.length = 0; break; }
      segments.push(bytes.subarray(off, off + len));
      off += len;
    }
    if (segments.length === segCount) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + p);
      const serial = dv.getUint32(14, true);
      pages.push({ serial, segments });
    }
    p = off;
  }
  return pages;
}

function parseVorbisComment(bytes, meta) {
  const r = new Reader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (r.remaining() < 4) return;
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
    // 歌詞キー(SYNCEDLYRICS/UNSYNCEDLYRICS/LYRICS)は共通モジュールで処理
    if (applyVorbisLyricTag(key, val, meta)) continue;
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
}

/**
 * Vorbis identification header (パケット先頭が 0x01 + "vorbis")
 *   構造: type(1) "vorbis"(6) version(4) channels(1) sample_rate(4) bitrate_max(4) bitrate_nominal(4) bitrate_min(4)
 */
function parseVorbisId(pkt, meta) {
  if (pkt.length < 30) return;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const channels = pkt[11];
  const sampleRate = dv.getUint32(12, true);
  const bitrateNom = dv.getInt32(20, true); // nominal bitrate
  meta.audioProps = {
    codec: "Vorbis",
    sampleRate,
    bitrate: bitrateNom > 0 ? Math.round(bitrateNom / 1000) : null,
    channels,
    bitDepth: null,
    vbr: true, // Vorbis は VBR が一般的
  };
}

/**
 * Opus identification header (パケット先頭が "OpusHead")
 *   構造: "OpusHead"(8) version(1) channels(1) pre_skip(2) input_sample_rate(4) gain(2) channel_map(1)
 */
function parseOpusId(pkt, meta) {
  if (pkt.length < 19) return;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const channels = pkt[9];
  const sampleRate = dv.getUint32(12, true); // 元のサンプルレート (再生は常に 48kHz だが)
  meta.audioProps = {
    codec: "Opus",
    sampleRate: sampleRate || 48000,
    bitrate: null,
    channels,
    bitDepth: null,
    vbr: true,
  };
}

/**
 * 再生時間の概算: 末尾ページの granule_position を使う
 * 厳密ではないので失敗時は 0
 */
async function estimateOggDuration(blob, meta) {
  try {
    // 末尾 64KB から最後のページを探す
    const tailStart = Math.max(0, blob.size - 65536);
    const tail = new Uint8Array(await readSlice(blob, tailStart, blob.size));
    let lastGranule = 0;
    let p = 0;
    while (p + 27 <= tail.length) {
      if (tail[p] === 0x4f && tail[p+1] === 0x67 && tail[p+2] === 0x67 && tail[p+3] === 0x53) {
        const dv = new DataView(tail.buffer, tail.byteOffset + p);
        // granule_position は signed 64; ここでは正の概算でOK
        const lo = dv.getUint32(6, true);
        const hi = dv.getUint32(10, true);
        lastGranule = hi * 0x100000000 + lo;
        const segCount = tail[p + 26];
        let total = 27 + segCount;
        for (let i = 0; i < segCount; i++) total += tail[p + 27 + i];
        p += total;
      } else {
        p++;
      }
    }
    if (lastGranule > 0) {
      // granule_position を秒へ変換する際のサンプルレート:
      //   - Opus: granule は常に 48kHz 単位 (RFC 7845) なので 48000 固定が正しい。
      //   - Vorbis: granule はストリームの実サンプルレート単位。parseVorbisId が
      //     meta.audioProps.sampleRate に格納済みならそれを使う(44.1kHz 等で
      //     duration が短く出る誤差を防ぐ)。
      //   - 不明時は 48000 にフォールバック。
      const codec = meta && meta.audioProps && meta.audioProps.codec;
      const sr = (codec === "Vorbis" && meta.audioProps.sampleRate > 0)
        ? meta.audioProps.sampleRate
        : 48000;
      return lastGranule / sr;
    }
  } catch {}
  return 0;
}
