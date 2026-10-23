/**
 * メタデータパーサのエントリポイント
 *
 * ファイル拡張子 → 該当パーサにルーティング。
 * 失敗時は「ファイル名から推測した最低限のメタ」を返す。
 */

import { formatFromName, mimeFromName, blobToDataUrl } from "./util.js";
import { parseMp3 } from "./parse-mp3.js";
import { parseM4a } from "./parse-m4a.js";
import { parseFlac } from "./parse-flac.js";
import { parseOgg } from "./parse-ogg.js";
import { parseWav } from "./parse-wav.js";
import { parseWebm } from "./parse-webm.js";
import { parseArtistAndTitle } from "../lastfm/scrobble-cleaner.js";

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

  // 必須項目を埋める: タグからアーティスト名が取れなかった場合、ファイル名からの自動分離を試みる
  const rawBaseName = stripExt(filename);
  if (!parsed.artist || parsed.artist === "(不明アーティスト)") {
    const fromFilename = parseArtistAndTitle(rawBaseName);
    if (fromFilename) {
      parsed.artist = fromFilename.artist;
      if (!parsed.title || parsed.title === rawBaseName) {
        parsed.title = fromFilename.title;
      }
      if (!parsed.albumArtist) {
        parsed.albumArtist = fromFilename.artist;
      }
    } else {
      parsed.artist = "(不明アーティスト)";
    }
  }

  if (!parsed.title) parsed.title = rawBaseName || "(無題)";

  // 音声プロパティの補完: パーサが audioProps を返さなかった場合でもデフォルトを生成し、
  // bitrate が未設定かつ duration > 0 の場合は fileSize / duration から平均値を算出
  // ※ 部分ヘッダ Blob (_isPartialHeader) の場合は _fullFileSize を優先し、切り出しサイズ(1.5MB等)での誤算出を防ぐ
  const fileSize = (fileOrBlob && (fileOrBlob._fullFileSize || (!fileOrBlob._isPartialHeader ? fileOrBlob.size : 0))) || 0;
  if (!parsed.audioProps) {
    parsed.audioProps = {
      codec: (format || "AUDIO").toUpperCase(),
      sampleRate: null,
      bitrate: (fileSize > 0 && parsed.duration > 0) ? Math.round((fileSize * 8) / parsed.duration / 1000) : null,
      channels: null,
      bitDepth: null,
      vbr: null,
    };
  } else if (!parsed.audioProps.bitrate && fileSize > 0 && parsed.duration > 0) {
    parsed.audioProps = {
      ...parsed.audioProps,
      bitrate: Math.round((fileSize * 8) / parsed.duration / 1000),
    };
  }

  // アートワークの健全性チェック: 空または極小(8バイト未満)の不正 Blob を除外
  if (parsed.artworkBlob) {
    if (!(parsed.artworkBlob instanceof Blob) || parsed.artworkBlob.size < 8) {
      parsed.artworkBlob = null;
    } else {
      try {
        parsed.artworkDataUrl = await blobToDataUrl(parsed.artworkBlob, 500);
      } catch {}
    }
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
