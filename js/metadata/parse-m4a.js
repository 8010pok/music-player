/**
 * M4A / MP4 (ISO BMFF) パーサ
 *
 * 構造:
 *   ftyp ... moov ... mdat
 *   moov → udta → meta → ilst → ©nam / ©ART / ©alb / aART / trkn / ©day / ©gen / covr ...
 *
 * 主要 atom:
 *   ©nam = title
 *   ©ART = artist
 *   ©alb = album
 *   aART = album artist
 *   trkn = track number (binary)
 *   ©day = year
 *   ©gen = genre (text)
 *   gnre = genre (binary index, ID3v1 互換)
 *   covr = cover art (jpeg/png)
 *
 * トラックの再生時間は moov.mvhd の timescale / duration から算出。
 */

import { Reader, decode, bytesToImageBlob, readSlice } from "./util.js";
import { makeLyrics, hasLyrics } from "./lyrics.js";

export async function parseM4a(blob) {
  const meta = makeEmpty();

  // 全体を読むのは大きすぎる可能性があるため、moov の位置をたどる
  // 多くのファイルは moov が先頭付近にあるが、末尾配置のものもある。
  // 安全のため: ftyp の後の box を順に追って moov を見つける
  try {
    const moovBuf = await locateMoov(blob);
    if (moovBuf) {
      parseMoov(new Uint8Array(moovBuf), meta);
    }
  } catch (e) {
    console.warn("m4a parse error", e);
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
 * MP4 のトップレベル box を走査して moov 全体を返す
 */
async function locateMoov(blob) {
  let p = 0;
  const max = blob.size;
  while (p + 8 <= max) {
    const headBuf = await readSlice(blob, p, p + 16);
    const head = new DataView(headBuf);
    let size = head.getUint32(0, false);
    const type = String.fromCharCode(
      head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7)
    );
    let headerLen = 8;
    if (size === 1) {
      // 64bit largesize。16バイトのヘッダが読めない(EOF 近辺の壊れた box)なら中断。
      if (head.byteLength < 16) break;
      const hi = head.getUint32(8, false);
      const lo = head.getUint32(12, false);
      size = hi * 0x100000000 + lo;
      headerLen = 16;
    } else if (size === 0) {
      // ファイル末尾まで
      size = max - p;
    }
    if (size < headerLen || size > max - p) {
      // 壊れた構造
      break;
    }
    if (type === "moov") {
      return readSlice(blob, p + headerLen, p + size);
    }
    p += size;
  }
  return null;
}

/**
 * moov box の中身を解析
 */
function parseMoov(moovBytes, meta) {
  const r = new Reader(moovBytes.buffer.slice(moovBytes.byteOffset, moovBytes.byteOffset + moovBytes.byteLength));
  walkBoxes(r, moovBytes.byteLength, (type, payload) => {
    if (type === "mvhd") parseMvhd(payload, meta);
    else if (type === "udta") parseUdta(payload, meta);
    else if (type === "trak") {
      // trak 内の mdia/mdhd でも duration が取れることがある（mvhdが信頼できない時の保険）
      // mdia → minf → stbl → stsd から音声プロパティ (sampleRate, channels) も取得
      walkBoxes(new Reader(payload.buffer, payload.byteOffset), payload.byteLength, (t2, p2) => {
        if (t2 === "mdia") {
          walkBoxes(new Reader(p2.buffer, p2.byteOffset), p2.byteLength, (t3, p3) => {
            if (t3 === "mdhd" && !meta.duration) parseMdhd(p3, meta);
            else if (t3 === "minf") {
              walkBoxes(new Reader(p3.buffer, p3.byteOffset), p3.byteLength, (t4, p4) => {
                if (t4 === "stbl") {
                  walkBoxes(new Reader(p4.buffer, p4.byteOffset), p4.byteLength, (t5, p5) => {
                    if (t5 === "stsd") parseStsd(p5, meta);
                  });
                }
              });
            }
          });
        }
      });
    }
  });
}

/**
 * stsd (Sample Description Box) → 音声プロパティを取得
 *   構造: version(1) flags(3) entry_count(4) [SampleEntry...]
 *   SampleEntry: size(4) type(4) reserved(6) data_reference_index(2)
 *   AudioSampleEntry: 上 + reserved(8) channels(2) sample_size(2) reserved(2) reserved(2) sample_rate(4 = 16.16 fixed)
 *   type: "mp4a" (AAC) / "alac" / "samr" / "sawb" etc
 */
function parseStsd(payload, meta) {
  try {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    // version/flags (1+3) + entry_count (4) = 8 byte skip
    let p = 8;
    if (p + 8 > dv.byteLength) return;
    p += 4; // entry size
    const codecBytes = [dv.getUint8(p), dv.getUint8(p+1), dv.getUint8(p+2), dv.getUint8(p+3)];
    const codec = String.fromCharCode(...codecBytes);
    p += 4 + 6 + 2 + 8; // type(4) reserved(6) dataref(2) reserved(8)
    if (p + 16 > dv.byteLength) return;
    const channels = dv.getUint16(p, false); p += 2;
    const sampleSize = dv.getUint16(p, false); p += 2;
    p += 4; // reserved
    const sampleRate = dv.getUint32(p, false) >>> 16; // 16.16 fixed の上位 16bit
    const codecLabel = codec === "mp4a" ? "AAC" : codec === "alac" ? "ALAC" : codec;
    meta.audioProps = {
      codec: codecLabel,
      sampleRate,
      bitrate: null,        // 平均ビットレート (ファイルサイズ / 時間で計算は呼び出し側で)
      channels,
      bitDepth: sampleSize || null,
      vbr: null,
    };
  } catch {}
}

function walkBoxes(reader, totalLen, cb) {
  const end = reader.offset + totalLen;
  while (reader.offset + 8 <= end) {
    const start = reader.offset;
    let size = reader.readU32BE();
    const type = reader.readFourCC();
    let headerLen = 8;
    if (size === 1) {
      // 64bit largesize。readU64BE は更に8バイト読むため、範囲内か確認してから読む
      // (壊れた box で end を読み越して RangeError になるのを防ぐ)。
      if (reader.offset + 8 > end) break;
      size = reader.readU64BE();
      headerLen = 16;
    } else if (size === 0) {
      size = end - start;
    }
    if (size < headerLen || start + size > end) break;
    const payload = reader.u8.subarray(reader.offset, start + size);
    cb(type, payload);
    reader.offset = start + size;
  }
}

function parseMvhd(payload, meta) {
  // 壊れた/切り詰められた mvhd を無防備に読むと DataView ゲッタが RangeError を投げ、
  // それが walkBoxes→parseM4a の catch まで伝播して moov 走査全体が中断し、後続の
  // udta/ilst にある全タグ(タイトル/アーティスト/アートワーク等)を失う。必要バイト数を
  // 検証して足りなければ return する(version 1=32 / version 0=20 バイト。parseStsd と同じ防御)。
  if (payload.byteLength < 4) return;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = dv.getUint8(0);
  if (payload.byteLength < (version === 1 ? 32 : 20)) return;
  let p = 4;
  let timescale = 0, duration = 0;
  if (version === 1) {
    // 64bit
    p += 16; // creation/modification 8+8
    timescale = dv.getUint32(p, false); p += 4;
    const hi = dv.getUint32(p, false);
    const lo = dv.getUint32(p + 4, false);
    duration = hi * 0x100000000 + lo;
  } else {
    p += 8;
    timescale = dv.getUint32(p, false); p += 4;
    duration = dv.getUint32(p, false);
  }
  if (timescale > 0 && duration > 0) {
    meta.duration = duration / timescale;
  }
}

function parseMdhd(payload, meta) {
  // mvhd と同様、切り詰められた mdhd で RangeError を投げて moov 走査を中断させない。
  if (payload.byteLength < 4) return;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = dv.getUint8(0);
  if (payload.byteLength < (version === 1 ? 32 : 20)) return;
  let p = 4;
  let timescale = 0, duration = 0;
  if (version === 1) {
    p += 16;
    timescale = dv.getUint32(p, false); p += 4;
    const hi = dv.getUint32(p, false);
    const lo = dv.getUint32(p + 4, false);
    duration = hi * 0x100000000 + lo;
  } else {
    p += 8;
    timescale = dv.getUint32(p, false); p += 4;
    duration = dv.getUint32(p, false);
  }
  if (timescale > 0 && duration > 0 && !meta.duration) {
    meta.duration = duration / timescale;
  }
}

function parseUdta(payload, meta) {
  walkBoxes(new Reader(payload.buffer, payload.byteOffset), payload.byteLength, (t, p) => {
    if (t === "meta") {
      // meta は 4 バイトのバージョン/フラグの後に box が続く
      const inner = p.subarray(4);
      walkBoxes(new Reader(inner.buffer, inner.byteOffset), inner.byteLength, (t2, p2) => {
        if (t2 === "ilst") parseIlst(p2, meta);
      });
    }
  });
}

function parseIlst(payload, meta) {
  walkBoxes(new Reader(payload.buffer, payload.byteOffset), payload.byteLength, (type, p) => {
    // 各 atom 内に data atom が入っている
    walkBoxes(new Reader(p.buffer, p.byteOffset), p.byteLength, (t2, p2) => {
      if (t2 !== "data") return;
      // data: type-int(4) | locale(4) | value...
      if (p2.byteLength < 8) return;
      const dv = new DataView(p2.buffer, p2.byteOffset, p2.byteLength);
      const dataType = dv.getUint32(0, false) & 0x00ffffff; // 上位1バイトはバージョン
      const value = p2.subarray(8);

      switch (type) {
        case "©nam": meta.title = decodeMaybeText(value, dataType); break;
        case "©ART": meta.artist = decodeMaybeText(value, dataType); break;
        case "©alb": meta.album = decodeMaybeText(value, dataType); break;
        case "aART":      meta.albumArtist = decodeMaybeText(value, dataType); break;
        case "©day": meta.year = decodeMaybeText(value, dataType); break;
        case "©gen": meta.genre = decodeMaybeText(value, dataType); break;
        case "©wrt": meta.composer = decodeMaybeText(value, dataType); break; // 作曲者
        case "©lyr": {
          // 歌詞(非同期テキストのみ。MP4 規格に同期歌詞アトムは無い)
          const t = decodeMaybeText(value, dataType);
          if (t) { meta.lyrics = meta.lyrics || makeLyrics(); if (!meta.lyrics.unsynced) meta.lyrics.unsynced = t; }
          break;
        }
        case "gnre": {
          if (value.byteLength >= 2) {
            const dv2 = new DataView(value.buffer, value.byteOffset);
            const idx = dv2.getUint16(0, false);
            meta.genre = id3v1Genre(idx - 1) || "";
          }
          break;
        }
        case "trkn": {
          // 0x00 0x00 [trackNo:2] [totalNo:2]
          if (value.byteLength >= 6) {
            const dv2 = new DataView(value.buffer, value.byteOffset);
            const tn = dv2.getUint16(2, false);
            const tot = dv2.getUint16(4, false);
            meta.trackNo = tot ? `${tn}/${tot}` : String(tn);
          }
          break;
        }
        case "disk": {
          // ディスク番号 (trkn と同じ構造)
          if (value.byteLength >= 6) {
            const dv2 = new DataView(value.buffer, value.byteOffset);
            const dn = dv2.getUint16(2, false);
            const tot = dv2.getUint16(4, false);
            meta.discNo = tot ? `${dn}/${tot}` : String(dn);
          }
          break;
        }
        case "tmpo": {
          // BPM 2バイトの整数
          if (value.byteLength >= 2) {
            const dv2 = new DataView(value.buffer, value.byteOffset);
            meta.bpm = String(dv2.getUint16(0, false));
          }
          break;
        }
        case "covr": {
          // data type 13 = jpeg, 14 = png
          // 0 バイトの covr で空 Blob をアートワーク設定しないよう非空のときだけ採用する。
          if (value && value.byteLength > 0) {
            const mime = dataType === 14 ? "image/png" : "image/jpeg";
            meta.artworkBlob = bytesToImageBlob(value, mime);
          }
          break;
        }
      }
    });
  });
}

function decodeMaybeText(bytes, dataType) {
  // dataType: 1=UTF-8, 2=UTF-16, それ以外もテキスト的に解釈
  if (dataType === 2) return decode(bytes, "utf-16");
  return decode(bytes, "utf-8");
}

// ID3v1 ジャンル番号 -> 名前（よく使う領域のみ）
function id3v1Genre(i) {
  const list = [
    "Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop","Jazz","Metal",
    "New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock","Techno","Industrial",
    "Alternative","Ska","Death Metal","Pranks","Soundtrack","Euro-Techno","Ambient","Trip-Hop",
    "Vocal","Jazz+Funk","Fusion","Trance","Classical","Instrumental","Acid","House","Game",
    "Sound Clip","Gospel","Noise","AlternRock","Bass","Soul","Punk","Space","Meditative",
    "Instrumental Pop","Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial",
    "Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy","Cult","Gangsta",
    "Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret","New Wave",
    "Psychadelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz",
    "Polka","Retro","Musical","Rock & Roll","Hard Rock"
  ];
  return list[i] || "";
}
