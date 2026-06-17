/**
 * メタデータパーサのエントリポイント
 *
 * ファイル拡張子 → 該当パーサにルーティング。
 * 失敗時は「ファイル名から推測した最低限のメタ」を返す。
 */

import { formatFromName, mimeFromName } from "./util.js";
import { parseMp3 } from "./parse-mp3.js";
import { parseM4a } from "./parse-m4a.js";
import { parseFlac } from "./parse-flac.js";
import { parseOgg } from "./parse-ogg.js";
import { parseWav } from "./parse-wav.js";
import { parseWebm } from "./parse-webm.js";

/**
 * File または Blob+name から共通メタデータを抽出
 * @param {File|Blob} fileOrBlob
 * @param {string} [name]
 * @returns {Promise<{title, artist, album, albumArtist, year, genre, trackNo, duration, mime, format, artworkBlob}>}
 */
export async function extractMetadata(fileOrBlob, name) {
  const filename = name || (fileOrBlob && fileOrBlob.name) || "";
  const format = formatFromName(filename);
  const mime = mimeFromName(filename) || (fileOrBlob && fileOrBlob.type) || "application/octet-stream";

  let parsed = makeFallback(filename);
  try {
    switch (format) {
      case "mp3":  parsed = await parseMp3(fileOrBlob); break;
      case "m4a":  parsed = await parseM4a(fileOrBlob); break;
      case "flac": parsed = await parseFlac(fileOrBlob); break;
      case "ogg":  parsed = await parseOgg(fileOrBlob); break;
      case "wav":  parsed = await parseWav(fileOrBlob); break;
      case "webm": parsed = await parseWebm(fileOrBlob); break;
      default:
        // 不明拡張子は <audio> に任せる。タイトルだけファイル名から起こす
        parsed = makeFallback(filename);
        break;
    }
  } catch (e) {
    console.warn("メタ解析失敗 → フォールバック", filename, e);
    parsed = makeFallback(filename);
  }

  // 必須項目を埋める
  if (!parsed.title) parsed.title = stripExt(filename) || "(無題)";
  if (!parsed.artist) parsed.artist = "(不明アーティスト)";

  // 音声プロパティの bitrate が未設定の場合、 fileSize / duration から平均値を算出
  if (parsed.audioProps && !parsed.audioProps.bitrate && fileOrBlob && fileOrBlob.size && parsed.duration > 0) {
    parsed.audioProps = {
      ...parsed.audioProps,
      bitrate: Math.round((fileOrBlob.size * 8) / parsed.duration / 1000),
    };
  }

  return { ...parsed, mime, format: format || "unknown" };
}

function makeFallback(name) {
  return {
    title: stripExt(name),
    artist: "",
    album: "",
    albumArtist: "",
    year: "",
    genre: "",
    trackNo: "",
    duration: 0,
    artworkBlob: null,
    lyrics: null,
  };
}

function stripExt(name) {
  return String(name || "").replace(/\.[^./\\]+$/, "");
}

/**
 * <audio> 経由で duration を取り直す（パーサが 0 を返した時の保険）
 * @returns {Promise<number>}
 */
export function readDurationViaAudio(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("audio");
    let done = false;
    const fin = (val) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch {}
      a.remove();
      resolve(val);
    };
    a.preload = "metadata";
    a.src = url;
    a.addEventListener("loadedmetadata", () => fin(isFinite(a.duration) ? a.duration : 0));
    a.addEventListener("error", () => fin(0));
    // 念のためタイムアウト
    setTimeout(() => fin(0), 10000);
  });
}
