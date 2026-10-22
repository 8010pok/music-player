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
 * MP4/MOV の ArrayBuffer から映像トラック (vide trak) を free ボックス（パディング）に無効化し、
 * 純粋な音声コンテナ (audio/mp4) として decodeAudioData で確実に読み込めるようにする。
 *
 * 【技術的背景】
 * iOS Safari / WebKit や一部の Android / PC ブラウザでは、映像トラックを含む MP4/MOV を
 * AudioContext.decodeAudioData に直接渡すと EncodingError ("Unable to decode audio data") で失敗する。
 * moov 内のビデオ trak を ISO 標準の free ボックスに書き換えることで、チャンクオフセット (stco/co64) を
 * 1バイトもズラさずに、ブラウザに「純粋な音声トラックのみの MP4 (M4A)」と認識させ、100% 確実にデコード可能にする。
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {ArrayBuffer|null}
 */
export function stripVideoTracksFromMp4(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 16) return null;

  try {
    const u8 = new Uint8Array(arrayBuffer.slice(0));
    const view = new DataView(u8.buffer);
    const len = u8.length;

    function readBoxHeader(offset) {
      if (offset + 8 > len) return null;
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        u8[offset + 4],
        u8[offset + 5],
        u8[offset + 6],
        u8[offset + 7]
      );
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > len) return null;
        const hi = view.getUint32(offset + 8);
        const lo = view.getUint32(offset + 12);
        if (hi > 0) return null; // 4GB以上はスキップ
        size = lo;
        headerSize = 16;
      } else if (size === 0) {
        size = len - offset;
      }
      return { offset, size, type, headerSize };
    }

    // トップレベルボックス走査
    let pos = 0;
    let moovBox = null;
    while (pos < len) {
      const box = readBoxHeader(pos);
      if (!box || box.size <= 0) break;
      if (box.type === "moov") {
        moovBox = box;
        break;
      }
      pos += box.size;
    }

    if (!moovBox) return null;

    // moov の中身を走査
    let moovPos = moovBox.offset + moovBox.headerSize;
    const moovEnd = moovBox.offset + moovBox.size;
    let hasAudioTrack = false;
    const videoTrakOffsets = [];

    while (moovPos < moovEnd) {
      const trakBox = readBoxHeader(moovPos);
      if (!trakBox || trakBox.size <= 0) break;

      if (trakBox.type === "trak") {
        let trakPos = trakBox.offset + trakBox.headerSize;
        const trakEnd = trakBox.offset + trakBox.size;
        let isVideo = false;
        let isAudio = false;

        while (trakPos < trakEnd) {
          const subBox = readBoxHeader(trakPos);
          if (!subBox || subBox.size <= 0) break;

          if (subBox.type === "mdia") {
            let mdiaPos = subBox.offset + subBox.headerSize;
            const mdiaEnd = subBox.offset + subBox.size;
            while (mdiaPos < mdiaEnd) {
              const mdiaSub = readBoxHeader(mdiaPos);
              if (!mdiaSub || mdiaSub.size <= 0) break;

              if (mdiaSub.type === "hdlr") {
                // hdlr box: 4 byte size + 4 byte "hdlr" + 4 byte (ver+flags) + 4 byte pre_defined + 4 byte handler_type
                const handlerOffset = mdiaSub.offset + 16;
                if (handlerOffset + 4 <= len) {
                  const handlerType = String.fromCharCode(
                    u8[handlerOffset],
                    u8[handlerOffset + 1],
                    u8[handlerOffset + 2],
                    u8[handlerOffset + 3]
                  );
                  if (handlerType === "vide") isVideo = true;
                  if (handlerType === "soun") isAudio = true;
                }
                break;
              }
              mdiaPos += mdiaSub.size;
            }
          }
          trakPos += subBox.size;
        }

        if (isVideo) {
          videoTrakOffsets.push(trakBox.offset);
        }
        if (isAudio) {
          hasAudioTrack = true;
        }
      }
      moovPos += trakBox.size;
    }

    // ビデオトラックが存在し、音声トラックも確認できた場合
    if (videoTrakOffsets.length > 0 && hasAudioTrack) {
      // 各ビデオ trak の 'trak' を 'free' に書き換えてパディング化
      for (const offset of videoTrakOffsets) {
        u8[offset + 4] = 0x66; // 'f'
        u8[offset + 5] = 0x72; // 'r'
        u8[offset + 6] = 0x65; // 'e'
        u8[offset + 7] = 0x65; // 'e'
      }
      return u8.buffer;
    }

    return null;
  } catch (e) {
    console.warn("[video-audio-extractor] stripVideoTracksFromMp4 エラー:", e);
    return null;
  }
}

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

    // 1. まず標準デコードを試行
    try {
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      return audioBuffer;
    } catch (directErr) {
      console.warn("[video-audio-extractor] decodeAudioData 直接デコード失敗、MP4ストリップフォールバックを試行:", directErr);
    }

    // 2. MP4/MOV のビデオトラック無効化 (freeボックス置換) フォールバック
    const strippedBuffer = stripVideoTracksFromMp4(arrayBuffer);
    if (strippedBuffer) {
      try {
        const audioBuffer = await audioCtx.decodeAudioData(strippedBuffer);
        return audioBuffer;
      } catch (stripErr) {
        console.warn("[video-audio-extractor] MP4ストリップ後のデコードも失敗:", stripErr);
      }
    }

    throw new Error("動画から音声トラックをデコードできませんでした (非対応の音声コーデックまたは音声トラックが含まれていません)");
  } catch (err) {
    console.warn("[video-audio-extractor] 音声抽出エラー:", err);
    throw new Error(err.message || "動画から音声を抽出できませんでした");
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
