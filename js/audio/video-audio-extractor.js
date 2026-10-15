/**
 * 動画（MP4 / MOV / WebM など）からの音声抽出 & サムネイルキャプチャ サービス
 *
 * - 端末のカメラロールやファイルから動画を取得し、音声トラックを直接 PCM デコード
 * - 動画のワンシーンからカバーアート用サムネイルを自動抽出
 * - ファイル名からの曲名・アーティスト名自動推測
 * - カット編集 & MP3 320kbps エンコード & ID3 タグ埋め込み
 */

import {
  sliceAndEncodeAudio,
  analyzeAudioLoudness,
  calculateNormalizeGain,
} from "./mp3-encoder.js";
import {
  parseArtistAndTitle,
  cleanArtistName,
  cleanTrackTitle,
  isPlaceholderArtist,
} from "../lastfm/scrobble-cleaner.js";

/**
 * 動画 Blob からオーディオトラックを直接 PCM AudioBuffer としてデコード
 * @param {Blob} videoBlob - 動画データ (MP4, MOV, WebM 等)
 * @returns {Promise<AudioBuffer>}
 */
export async function extractAudioBufferFromVideoBlob(videoBlob) {
  if (!videoBlob) throw new Error("動画データが見つかりませんでした");

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("Web Audio API がサポートされていません");

  const audioCtx = new AC();
  try {
    const arrayBuffer = await videoBlob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } catch (err) {
    console.warn("[video-audio-extractor] decodeAudioData 失敗、フォールバックを試行:", err);
    throw new Error(`動画から音声トラックをデコードできませんでした: ${err.message || "非対応の音声コーデックです"}`);
  } finally {
    try { await audioCtx.close(); } catch (_) {}
  }
}

/**
 * 動画の特定秒数のフレームを画像 Blob (JPEG) としてキャプチャ
 * @param {Blob} videoBlob
 * @param {number} [atTimeSec=1.0] キャプチャ位置 (秒)
 * @param {number} [maxSize=640] 出力画像の最大幅/高さ (px)
 * @returns {Promise<Blob|null>}
 */
export async function captureVideoFrameAsBlob(videoBlob, atTimeSec = 1.0, maxSize = 640) {
  if (typeof document === "undefined" || !videoBlob) return null;

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    const objectUrl = URL.createObjectURL(videoBlob);
    let resolved = false;

    const cleanup = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      try { URL.revokeObjectURL(objectUrl); } catch (_) {}
    };

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null);
      }
    }, 8000);

    video.onloadedmetadata = () => {
      const dur = video.duration || 0;
      const targetTime = Math.min(Math.max(0.1, atTimeSec), Math.max(0.1, dur - 0.1));
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);

      try {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 480;

        // アスペクト比を維持して最大 maxSize px に縮小
        let dw = vw;
        let dh = vh;
        if (dw > maxSize || dh > maxSize) {
          if (dw >= dh) {
            dh = Math.round((dh * maxSize) / dw);
            dw = maxSize;
          } else {
            dw = Math.round((dw * maxSize) / dh);
            dh = maxSize;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, dw, dh);

        canvas.toBlob((blob) => {
          cleanup();
          resolve(blob || null);
        }, "image/jpeg", 0.88);
      } catch (e) {
        console.warn("[video-audio-extractor] サムネイルキャプチャ失敗:", e);
        cleanup();
        resolve(null);
      }
    };

    video.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve(null);
      }
    };

    video.src = objectUrl;
    video.load();
  });
}

/**
 * ファイル名からアーティスト名と曲名を自動推測・正規化
 * @param {string} filename (例: "YOASOBI - アイドル.mp4")
 * @returns {{ title: string, artist: string }}
 */
export function inferMetadataFromFilename(filename) {
  if (!filename) return { title: "無題の楽曲", artist: "不明なアーティスト" };

  // 拡張子を除去
  const baseName = filename.replace(/\.(mp4|mov|webm|m4v|avi|mkv|flv|wmv)$/i, "").trim();

  // "Artist - Title" の区切りを自動抽出
  const parsed = parseArtistAndTitle(baseName);
  let artist = "";
  let title = "";

  // 数字のみのアーティスト（西暦や通番等）は誤認のため弾く
  const isNumericOnly = parsed?.artist ? /^\d+$/.test(parsed.artist.trim()) : false;

  if (parsed?.artist && !isNumericOnly && !isPlaceholderArtist(parsed.artist)) {
    artist = cleanArtistName(parsed.artist);
    title = cleanTrackTitle(parsed.title);
  }

  // 有効なアーティストが分離できなかった場合は、baseName 全体をタイトルとする
  if (!title) {
    title = cleanTrackTitle(baseName);
  }

  if (!title) title = "無題の楽曲";
  if (!artist) artist = "不明なアーティスト";

  return { title, artist };
}

/**
 * デコード済み AudioBuffer をトリミング & ノーマライズして MP3 320kbps Blob を生成
 * @param {AudioBuffer} audioBuffer
 * @param {object} params
 * @param {number} [params.startTime=0]
 * @param {number} [params.endTime]
 * @param {string} [params.title=""]
 * @param {string} [params.artist=""]
 * @param {string} [params.album=""]
 * @param {Blob|null} [params.artworkBlob=null]
 * @param {string} [params.normalizeMode="reference"] "reference" | "peak" | "manual" | "none"
 * @param {number} [params.targetRmsDb=-14.0]
 * @param {number} [params.manualGainDb=0]
 * @param {(pct: number) => void} [params.onProgress]
 * @returns {Promise<{
 *   mp3Blob: Blob,
 *   duration: number,
 *   gain: number,
 *   gainDb: number,
 *   loudness: object
 * }>}
 */
export async function encodeVideoAudioTrack(audioBuffer, {
  startTime = 0,
  endTime = null,
  title = "",
  artist = "",
  album = "",
  artworkBlob = null,
  normalizeMode = "reference",
  targetRmsDb = -14.0,
  manualGainDb = 0,
  onProgress = null,
} = {}) {
  if (!audioBuffer) throw new Error("音声バッファがありません");

  const totalDuration = audioBuffer.duration;
  const start = Math.max(0, Math.min(startTime, totalDuration));
  const end = typeof endTime === "number" && endTime > start ? Math.min(endTime, totalDuration) : totalDuration;
  const duration = Math.max(0, end - start);

  if (onProgress) onProgress(15);

  // 1. ラウドネス解析
  const loudness = analyzeAudioLoudness(audioBuffer);
  if (onProgress) onProgress(35);

  // 2. ノーマライズゲイン算出
  let calculatedGain = 1.0;
  let calculatedGainDb = 0.0;
  if (normalizeMode !== "none") {
    const gainRes = calculateNormalizeGain({
      sourceLoudness: loudness,
      mode: normalizeMode,
      targetRmsDb,
      manualGainDb,
      maxPeakDb: -0.3,
    });
    calculatedGain = gainRes.gain;
    calculatedGainDb = gainRes.gainDb;
  }

  // 3. アートワークバッファの準備
  let artworkBuffer = null;
  if (artworkBlob && artworkBlob instanceof Blob) {
    try {
      artworkBuffer = await artworkBlob.arrayBuffer();
    } catch (_) {}
  }

  if (onProgress) onProgress(50);

  // 4. LAME.js による MP3 320kbps エンコード
  const mp3Blob = sliceAndEncodeAudio(audioBuffer, {
    startTime: start,
    endTime: end,
    bitrate: 320,
    gain: calculatedGain,
    metadata: {
      title: title || "無題の楽曲",
      artist: artist || "不明なアーティスト",
      album: album || "動画から抽出",
      artworkBuffer,
    },
    onProgress: (pct) => {
      if (onProgress) {
        // 50% 〜 100%
        onProgress(50 + Math.round(pct * 0.5));
      }
    },
  });

  return {
    mp3Blob,
    duration,
    gain: calculatedGain,
    gainDb: calculatedGainDb,
    loudness,
  };
}
