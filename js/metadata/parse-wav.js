/**
 * WAV (RIFF) パーサ
 *
 * 構造:
 *   "RIFF" size(4 LE) "WAVE"
 *   その後にチャンク群: "fmt ", "data", "LIST"(INFOサブ)
 *
 * fmt: 16〜18 バイト
 *   audio_format(2), channels(2), sample_rate(4), byte_rate(4),
 *   block_align(2), bits(2)
 *
 * LIST/INFO: 楽曲メタ（オプショナル）
 *   "INFO" の後に 4文字タグ + size(4 LE) + テキスト
 *   INAM=title, IART=artist, IPRD=album, ICRD=year, IGNR=genre, ITRK=trackNo
 */

import { Reader, decode, readSlice, trimNullTerminated } from "./util.js";
import { extractId3Lyrics } from "./lyrics.js";

export async function parseWav(blob) {
  const meta = makeEmpty();
  const head = new Uint8Array(await readSlice(blob, 0, 12));
  if (head.length < 12) return meta;
  if (!(head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46)) return meta;
  if (!(head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45)) return meta;

  // 各チャンクを辿る
  let p = 12;
  let sampleRate = 0;
  let dataLen = 0;
  let byteRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0; // 1 = PCM, 3 = float, 0xfffe = extensible

  while (p + 8 <= blob.size) {
    const hd = new Uint8Array(await readSlice(blob, p, p + 8));
    if (hd.length < 8) break;
    const id = String.fromCharCode(hd[0], hd[1], hd[2], hd[3]);
    const size = (new DataView(hd.buffer, hd.byteOffset)).getUint32(4, true);
    const dataStart = p + 8;
    const dataEnd = dataStart + size;

    if (id === "fmt ") {
      const buf = new Uint8Array(await readSlice(blob, dataStart, Math.min(dataEnd, dataStart + 16)));
      if (buf.length >= 16) {
        const dv = new DataView(buf.buffer, buf.byteOffset);
        audioFormat = dv.getUint16(0, true);
        channels = dv.getUint16(2, true);
        sampleRate = dv.getUint32(4, true);
        byteRate = dv.getUint32(8, true);
        bitsPerSample = dv.getUint16(14, true);
      }
    } else if (id === "data") {
      dataLen = size;
    } else if (id === "LIST") {
      const buf = new Uint8Array(await readSlice(blob, dataStart, dataEnd));
      if (buf.length >= 4) {
        const subType = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
        if (subType === "INFO") parseInfo(buf.subarray(4), meta);
      }
    } else if (id === "id3 " || id === "ID3 ") {
      // WAV に埋め込まれた ID3v2 タグ。歌詞(USLT/SYLT)があれば抽出する
      // (RIFF/INFO には歌詞の標準タグが無いため、これが唯一の歌詞経路)
      try {
        const tag = new Uint8Array(await readSlice(blob, dataStart, dataEnd));
        const ly = extractId3Lyrics(tag);
        if (ly) meta.lyrics = ly;
      } catch {}
    }
    // チャンクは偶数バイト境界。次チャンク先頭へ進める。
    const next = dataEnd + (size & 1);
    // 前進しない異常時だけ中断する。旧実装は `next <= dataStart`(= size===0)で
    // break しており、空の PAD/FLLR 等のサイズ0チャンクに当たると以降の
    // fmt/data/LIST/id3 を全て取りこぼしていた。ヘッダ8バイト分は必ず進むため、
    // 現在位置 p を超えない場合(理論上の異常)のみ中断する。
    if (next <= p) break;
    p = next;
  }

  if (sampleRate > 0 && dataLen > 0 && byteRate > 0) {
    meta.duration = dataLen / byteRate;
  }
  if (sampleRate > 0) {
    const codec = audioFormat === 1 ? "PCM" : audioFormat === 3 ? "IEEE Float" : audioFormat === 0xfffe ? "Extensible" : "WAV";
    meta.audioProps = {
      codec,
      sampleRate,
      bitrate: byteRate > 0 ? Math.round(byteRate * 8 / 1000) : null,
      channels: channels || null,
      bitDepth: bitsPerSample || null,
      vbr: null,
    };
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
    lyrics: null,
  };
}

function parseInfo(bytes, meta) {
  let p = 0;
  while (p + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[p], bytes[p+1], bytes[p+2], bytes[p+3]);
    const size = (new DataView(bytes.buffer, bytes.byteOffset + p)).getUint32(4, true);
    const value = trimNullTerminated(decode(bytes.subarray(p + 8, p + 8 + size), "utf-8")).trim();
    switch (id) {
      case "INAM": meta.title = meta.title || value; break;
      case "IART": meta.artist = meta.artist || value; break;
      case "IPRD": meta.album = meta.album || value; break;
      case "ICRD": meta.year = meta.year || value; break;
      case "IGNR": meta.genre = meta.genre || value; break;
      case "ITRK": meta.trackNo = meta.trackNo || value; break;
      case "IMUS": meta.composer = meta.composer || value; break; // IMUS = Music (作曲者として扱う非標準)
    }
    p += 8 + size + (size & 1);
  }
}
