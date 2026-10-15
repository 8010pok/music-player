/**
 * 音量ノーマライズ サービス
 *
 * - Google Drive 音源およびローカル音源のラウドネス解析 & ノーマライズ処理
 * - Web Audio API によるデコード & PCM ラウドネス（RMS / Peak）計測
 * - 基準曲（目標ラウドネス）またはピーク値に合わせたゲイン適用 & MP3 320kbps エンコード
 * - クリッピング（音割れ）防止の安全リミッター（ピーク -0.3dBFS で安全クランプ）
 * - IndexedDB キャッシュおよび Google Drive 上のファイル更新に対応
 */

import {
  analyzeAudioLoudness,
  calculateNormalizeGain,
  sliceAndEncodeAudio,
} from "./mp3-encoder.js";
import { getBlob, putTrack, updateTrack } from "../store/library-db.js";
import { getPublic, setPublic } from "../store/settings.js";
import { appState } from "../state.js";
import { fetchDriveAudioBlob, getDriveToken, isDriveTrackId } from "../gdrive/drive-service.js";

/**
 * 音声 Blob をデコードしてラウドネス（Peak / RMS）を計測
 * @param {Blob} blob
 * @returns {Promise<{ loudness: { peak: number, peakDb: number, rms: number, rmsDb: number }, audioBuffer: AudioBuffer }>}
 */
export async function analyzeBlobLoudness(blob) {
  if (!blob) throw new Error("音声データが見つかりませんでした");
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("Web Audio API がサポートされていません");

  const audioCtx = new AC();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const loudness = analyzeAudioLoudness(audioBuffer);
    return { loudness, audioBuffer };
  } finally {
    try { await audioCtx.close(); } catch (_) {}
  }
}

/**
 * 音声 Blob にゲインを適用してノーマライズ済み MP3 Blob を生成
 * @param {Blob|AudioBuffer} sourceBlobOrBuffer
 * @param {object} params
 * @param {object} [params.track] トラックメタデータ（ID3埋め込み用）
 * @param {"reference"|"peak"|"manual"|"none"} [params.mode="reference"]
 * @param {number} [params.targetRmsDb=-14.0] 基準曲の RMS dBFS
 * @param {number} [params.manualGainDb=0] 手動ゲイン dB
 * @param {number} [params.bitrate=320] MP3 ビットレート (kbps)
 * @param {(pct: number) => void} [params.onProgress] 進捗コールバック
 * @returns {Promise<{
 *   normalizedBlob: Blob,
 *   gain: number,
 *   gainDb: number,
 *   sourceLoudness: object,
 *   finalPeakDb: number,
 *   finalRmsDb: number,
 *   limited: boolean
 * }>}
 */
export async function processAudioNormalization(sourceBlobOrBuffer, {
  track = {},
  mode = "reference",
  targetRmsDb = -14.0,
  targetRms = null,
  manualGainDb = 0,
  bitrate = 320,
  onProgress = null,
} = {}) {
  const effectiveTargetRmsDb = typeof targetRmsDb === "number" ? targetRmsDb : (typeof targetRms === "number" ? targetRms : -14.0);
  let audioBuffer = null;
  let audioCtx = null;

  if (sourceBlobOrBuffer instanceof AudioBuffer) {
    audioBuffer = sourceBlobOrBuffer;
  } else if (sourceBlobOrBuffer instanceof Blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("Web Audio API がサポートされていません");
    audioCtx = new AC();
    const ab = await sourceBlobOrBuffer.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(ab);
  } else {
    throw new Error("無効な音声データソースです");
  }

  try {
    if (onProgress) onProgress(15);

    // 1. ラウドネス解析
    const sourceLoudness = analyzeAudioLoudness(audioBuffer);
    if (onProgress) onProgress(30);

    // 2. ノーマライズゲイン算出
    const gainResult = calculateNormalizeGain({
      sourceLoudness,
      mode,
      targetRmsDb: effectiveTargetRmsDb,
      manualGainDb,
      maxPeakDb: -0.3,
    });

    if (onProgress) onProgress(45);

    // 3. カバー画像バッファの準備
    let artworkBuffer = null;
    if (track.artworkBlob) {
      try {
        artworkBuffer = await track.artworkBlob.arrayBuffer();
      } catch (_) {}
    }

    // 4. LAME MP3 エンコーダーでゲイン適用エンコード
    const normalizedBlob = sliceAndEncodeAudio(audioBuffer, {
      startTime: 0,
      endTime: audioBuffer.duration,
      bitrate: bitrate || 320,
      gain: gainResult.gain,
      metadata: {
        title: track.title || "",
        artist: track.artist || "",
        album: track.album || "",
        year: track.year || "",
        artworkBuffer,
      },
      onProgress: (pct) => {
        if (onProgress) {
          // 45% 〜 100% の範囲に進捗をマッピング
          onProgress(45 + Math.round(pct * 0.55));
        }
      },
    });

    return {
      normalizedBlob,
      blob: normalizedBlob,
      gain: gainResult.gain,
      gainDb: gainResult.gainDb,
      sourceLoudness,
      finalPeakDb: gainResult.finalPeakDb,
      finalRmsDb: gainResult.finalRmsDb,
      limited: gainResult.limited,
    };
  } finally {
    if (audioCtx) {
      try { await audioCtx.close(); } catch (_) {}
    }
  }
}

/**
 * Google Drive 上の既存音源ファイルを PATCH で上書き更新
 * @param {string} fileId
 * @param {Blob} blob
 * @param {string} [mimeType="audio/mpeg"]
 * @returns {Promise<boolean>}
 */
export async function updateDriveFileContent(fileId, blob, mimeType = "audio/mpeg") {
  if (!fileId || !blob) return false;
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません");

  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;
  const res = await fetch(uploadUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mimeType,
    },
    body: blob,
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Google Drive 認証の有効期限が切れています。再接続してください");
    }
    const errText = await res.text().catch(() => "");
    throw new Error(`Google Drive 更新失敗: HTTP ${res.status} ${errText}`);
  }

  return true;
}

/**
 * トラックの音源データを取得（IndexedDB キャッシュ優先、無ければ Google Drive から取得）
 * @param {object} track
 * @returns {Promise<Blob>}
 */
export async function getTrackAudioBlob(track) {
  if (!track || !track.id) throw new Error("トラックが指定されていません");

  // 1. ローカル IndexedDB から取得
  const localBlob = await getBlob(track.id);
  if (localBlob && localBlob.size > 0) {
    return localBlob;
  }

  // 2. Google Drive トラックの場合は Drive API からダウンロード
  const driveFileId = track.driveFileId || (isDriveTrackId(track.id) ? track.id.slice(3) : null);
  if (driveFileId) {
    const driveBlob = await fetchDriveAudioBlob(driveFileId);
    if (driveBlob && driveBlob.size > 0) {
      return driveBlob;
    }
  }

  throw new Error("曲の音源データが見つかりませんでした");
}

/**
 * 単一トラックのノーマライズ戦略を判定（非破壊か再エンコードか）
 * @param {object} params
 * @param {number} params.gainDb 計算された必要ゲイン (dB)
 * @param {boolean} [params.preferNonDestructive=true]
 * @param {boolean} [params.forceReencode=false]
 * @returns {"non-destructive"|"reencoded"}
 */
export function determineNormalizationStrategy({ gainDb, preferNonDestructive = true, forceReencode = false }) {
  if (forceReencode) return "reencoded";
  // ゲインが 0.05dB 以下（音量を下げるか、ほぼ変化なし）なら非破壊で十分かつ音質劣化ゼロ
  if (preferNonDestructive && gainDb <= 0.05) {
    return "non-destructive";
  }
  // 音量を大きくする（プラスゲイン）場合は、iOS WebKit の <audio>.volume <= 1.0 制約のため
  // PCM増幅＋LAME.js による MP3 320kbps 再エンコードが必要
  return "reencoded";
}

/**
 * 単一トラックの音量をノーマライズし、IndexedDB（およびオプションで Google Drive）に保存
 * - ハイブリッド制御: マイナスゲイン時は非破壊（音質無劣化・瞬時完了）、プラス増幅時は高品質再エンコード
 * @param {object} track
 * @param {object} [options]
 * @param {"reference"|"peak"|"manual"|"none"} [options.mode="reference"]
 * @param {number} [options.targetRmsDb] 基準音量 (未指定時は設定または -14.0dBFS)
 * @param {number} [options.manualGainDb=0]
 * @param {boolean} [options.preferNonDestructive=true] 音量を下げる曲で非破壊を優先
 * @param {boolean} [options.forceReencode=false] 常に再エンコードを強制
 * @param {boolean} [options.updateDrive=false] Google Drive 上のファイルも上書き更新するか
 * @param {(progress: { percent: number, statusText: string }) => void} [options.onProgress]
 * @returns {Promise<{
 *   track: object,
 *   gain: number,
 *   gainDb: number,
 *   finalPeakDb: number,
 *   finalRmsDb: number,
 *   limited: boolean,
 *   strategy: "non-destructive"|"reencoded"
 * }>}
 */
export async function normalizeTrackAudio(track, {
  mode = "reference",
  targetRmsDb = null,
  manualGainDb = 0,
  preferNonDestructive = true,
  forceReencode = false,
  updateDrive = false,
  onProgress = null,
} = {}) {
  if (!track || !track.id) throw new Error("対象の曲が指定されていません");

  if (onProgress) onProgress({ percent: 5, statusText: "音源データを読み込み中…" });

  // 1. 音源データの取得
  const sourceBlob = await getTrackAudioBlob(track);

  // 2. ターゲット RMS の決定
  let effectiveTargetRmsDb = -14.0;
  if (typeof targetRmsDb === "number") {
    effectiveTargetRmsDb = targetRmsDb;
  } else {
    const pub = getPublic();
    const ref = pub.normalizeReferenceTrack;
    if (ref && typeof ref.rmsDb === "number") {
      effectiveTargetRmsDb = ref.rmsDb;
    }
  }

  if (onProgress) onProgress({ percent: 15, statusText: "音量を解析中…" });

  // 3. ラウドネス解析
  const { loudness: sourceLoudness, audioBuffer } = await analyzeBlobLoudness(sourceBlob);
  if (onProgress) onProgress({ percent: 35, statusText: "ゲインを算出中…" });

  // 4. ノーマライズゲイン算出
  const gainResult = calculateNormalizeGain({
    sourceLoudness,
    mode,
    targetRmsDb: effectiveTargetRmsDb,
    manualGainDb,
    maxPeakDb: -0.3,
  });

  // 5. ハイブリッド戦略の決定
  const strategy = determineNormalizationStrategy({
    gainDb: gainResult.gainDb,
    preferNonDestructive,
    forceReencode,
  });

  if (strategy === "non-destructive") {
    // === 非破壊ノーマライズ (Non-destructive) ===
    // 音量を下げるだけなので再エンコードを行わず、メタデータに normalizedGainDb を記録。
    // 再生時に <audio>.volume をスケールさせることで音質劣化ゼロ・エンコード時間ゼロ。
    if (onProgress) onProgress({ percent: 85, statusText: "非破壊ゲイン情報を保存中…" });

    const patch = {
      normalized: true,
      normalizedType: "non-destructive",
      normalizedGainDb: gainResult.gainDb,
      normalizedAt: Date.now(),
      originalRmsDb: sourceLoudness.rmsDb,
      originalPeakDb: sourceLoudness.peakDb,
      normalizedRmsDb: gainResult.finalRmsDb,
      normalizedPeakDb: gainResult.finalPeakDb,
    };

    await updateTrack(track.id, patch);
    const updatedTrack = { ...track, ...patch };

    // 再生中の曲なら appState も更新
    const cur = appState.get().currentTrack;
    if (cur && cur.id === track.id) {
      appState.set({ currentTrack: updatedTrack });
    }

    if (onProgress) onProgress({ percent: 100, statusText: "完了（非破壊・音質無劣化）！" });

    return {
      track: updatedTrack,
      gain: gainResult.gain,
      gainDb: gainResult.gainDb,
      finalPeakDb: gainResult.finalPeakDb,
      finalRmsDb: gainResult.finalRmsDb,
      limited: gainResult.limited,
      strategy: "non-destructive",
    };
  }

  // === 再エンコードノーマライズ (Re-encoded) ===
  // 音量をプラス増幅するため、iOS の <audio>.volume <= 1.0 制約を突破すべく
  // LAME.js による MP3 320kbps 高品質再エンコードを実行
  if (onProgress) onProgress({ percent: 45, statusText: "増幅用エンコードを開始…" });

  const result = await processAudioNormalization(audioBuffer, {
    track,
    mode,
    targetRmsDb: effectiveTargetRmsDb,
    manualGainDb,
    bitrate: 320,
    onProgress: (pct) => {
      if (onProgress) {
        onProgress({
          percent: pct,
          statusText: `ノーマライズ変換中 (${pct}%)…`,
        });
      }
    },
  });

  if (onProgress) onProgress({ percent: 90, statusText: "ライブラリに保存中…" });

  const patch = {
    cached: true,
    normalized: true,
    normalizedType: "reencoded",
    normalizedGainDb: 0, // 音源自体が増幅済みのため再生時ゲインは0
    appliedGainDb: result.gainDb,
    normalizedAt: Date.now(),
    originalRmsDb: result.sourceLoudness.rmsDb,
    originalPeakDb: result.sourceLoudness.peakDb,
    normalizedRmsDb: result.finalRmsDb,
    normalizedPeakDb: result.finalPeakDb,
    fileSize: result.normalizedBlob.size,
    format: "mp3",
    mime: "audio/mpeg",
  };

  const updatedTrack = { ...track, ...patch };

  // IndexedDB に新しい音源 Blob と更新メタデータを保存
  await putTrack(updatedTrack, result.normalizedBlob);

  // 再生中の曲なら appState も更新
  const cur = appState.get().currentTrack;
  if (cur && cur.id === track.id) {
    appState.set({ currentTrack: updatedTrack });
  }

  // 6. Google Drive 上のファイルを更新（オプション）
  if (updateDrive && (track.driveFileId || isDriveTrackId(track.id))) {
    const driveFileId = track.driveFileId || track.id.slice(3);
    if (onProgress) onProgress({ percent: 95, statusText: "Google Drive に上書き保存中…" });
    try {
      await updateDriveFileContent(driveFileId, result.normalizedBlob, "audio/mpeg");
    } catch (driveErr) {
      console.warn("[normalize-service] Google Drive 上書き失敗 (ローカルは保存済):", driveErr);
      throw new Error(`ライブラリへの保存は完了しましたが、Google Drive の上書きに失敗しました: ${driveErr.message}`);
    }
  }

  if (onProgress) onProgress({ percent: 100, statusText: "完了！" });

  return {
    track: updatedTrack,
    gain: result.gain,
    gainDb: result.gainDb,
    finalPeakDb: result.finalPeakDb,
    finalRmsDb: result.finalRmsDb,
    limited: result.limited,
    strategy: "reencoded",
  };
}
