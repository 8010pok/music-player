/**
 * 動画（MP4 / MOV / WebM など）からの音声抽出 & カット編集モーダル
 *
 * - 端末のカメラロールやファイルから動画を取得し、音声トラックを直接デコード
 * - 動画サムネイルをカバーアートとして自動キャプチャ
 * - 開始・終了位置のカット編集（はやえもん風）
 * - 音量ノーマライズ & 高品質 MP3 320kbps エンコード
 * - ライブラリ（IndexedDB）および Google Drive への自動保存
 */

import { openModal, toast, confirm, escapeHtml, escapeAttr } from "./components.js";
import {
  extractAudioBufferFromVideoBlob,
  captureVideoFrameAsBlob,
  inferMetadataFromFilename,
  encodeVideoAudioTrack,
} from "../audio/video-audio-extractor.js";
import { putTrack } from "../store/library-db.js";
import { getPublic } from "../store/settings.js";
import { isDriveConnected, uploadFileToDrive } from "../gdrive/drive-service.js";

/**
 * 動画ファイルから音声抽出モーダルを開く
 * @param {File|Blob} videoFile
 * @param {object} [opts]
 * @param {(track: object) => void} [opts.onSaved] 保存完了時のコールバック
 */
export async function openVideoExtractModal(videoFile, { onSaved = null } = {}) {
  if (!videoFile) return;

  const container = document.createElement("div");
  container.className = "video-extract-modal-container";

  const filename = videoFile.name || "video.mp4";
  const { title: initialTitle, artist: initialArtist } = inferMetadataFromFilename(filename);

  container.innerHTML = `
    <style>
      .ve-modal { font-size: 13px; color: var(--fg); }
      .ve-card { background: var(--bg-elev-1); border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid var(--border); }
      .ve-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
      .ve-input { flex: 1; height: 36px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-elev-2); color: var(--fg); font-size: 13px; }
      .ve-input:focus { outline: none; border-color: var(--accent); }
      .ve-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: var(--bg-elev-2); color: var(--fg-muted); }
      .ve-badge.accent { background: rgba(0, 113, 227, 0.15); color: var(--accent); }
      .ve-progress-bar-wrap { height: 8px; border-radius: 4px; background: var(--bg-elev-2); overflow: hidden; margin: 8px 0 4px; }
      .ve-progress-bar-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.15s ease; }
    </style>

    <div class="ve-modal">
      <!-- 読み込み中インジケータ -->
      <div id="ve-loading-wrap" style="text-align: center; padding: 30px 10px;">
        <div style="font-size: 28px; margin-bottom: 8px;">⏳</div>
        <div style="font-size: 14px; font-weight: 700; color: var(--accent); margin-bottom: 4px;">
          動画から音声を抽出しています…
        </div>
        <div style="font-size: 12px; color: var(--fg-muted);" id="ve-loading-status">
          動画の音声トラックを PCM デコード中
        </div>
      </div>

      <!-- メイン編集エリア (デコード完了後に表示) -->
      <div id="ve-main-wrap" style="display: none;">
        <!-- ジャケット & 基本情報カード -->
        <div class="ve-card" style="display: flex; gap: 14px; align-items: flex-start;">
          <div style="position: relative; width: 72px; height: 72px; border-radius: 8px; overflow: hidden; background: #222; flex-shrink: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.2);">
            <img id="ve-artwork-img" style="width: 100%; height: 100%; object-fit: cover;" alt="Artwork" />
            <div id="ve-artwork-placeholder" style="width: 100%; height: 100%; display: none; align-items: center; justify-content: center; font-size: 28px;">🎬</div>
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span class="ve-badge accent">🎥 動画音源</span>
              <button type="button" class="btn" id="btn-ve-change-art" style="font-size: 11px; padding: 2px 8px;">画像を変更…</button>
              <input type="file" id="ve-art-file-input" accept="image/*" style="display: none;" />
            </div>
            <div style="font-size: 12px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" id="ve-file-info">
              ${escapeHtml(filename)}
            </div>
            <div style="font-size: 11px; color: var(--fg-muted); margin-top: 2px;" id="ve-duration-info">
              長さ: 計算中…
            </div>
          </div>
        </div>

        <!-- タグ入力カード -->
        <div class="ve-card">
          <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px;">🏷 楽曲情報の入力</div>
          <div style="margin-bottom: 8px;">
            <label style="font-size: 11px; color: var(--fg-muted); display: block; margin-bottom: 2px;">曲名 (Title)</label>
            <input type="text" id="ve-title-input" class="ve-input" value="${escapeAttr(initialTitle)}" placeholder="曲名" style="width: 100%; box-sizing: border-box;" />
          </div>
          <div style="margin-bottom: 8px;">
            <label style="font-size: 11px; color: var(--fg-muted); display: block; margin-bottom: 2px;">アーティスト名 (Artist)</label>
            <input type="text" id="ve-artist-input" class="ve-input" value="${escapeAttr(initialArtist)}" placeholder="アーティスト名" style="width: 100%; box-sizing: border-box;" />
          </div>
          <div>
            <label style="font-size: 11px; color: var(--fg-muted); display: block; margin-bottom: 2px;">アルバム名 (Album)</label>
            <input type="text" id="ve-album-input" class="ve-input" value="動画から抽出" placeholder="アルバム名" style="width: 100%; box-sizing: border-box;" />
          </div>
        </div>

        <!-- カット編集カード (はやえもん風トリミング) -->
        <div class="ve-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 700; font-size: 13px;">✂ カット編集 (トリミング)</div>
            <span class="ve-badge" id="ve-cut-duration-badge">00:00 - 00:00</span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
            <div style="background: var(--bg-elev-2); padding: 8px 10px; border-radius: 8px;">
              <label style="font-size: 11px; color: var(--fg-muted); display: block; margin-bottom: 4px;">開始位置 (秒)</label>
              <input type="number" id="ve-start-time-input" min="0" step="0.5" value="0" class="ve-input" style="width: 100%; height: 32px; box-sizing: border-box;" />
            </div>
            <div style="background: var(--bg-elev-2); padding: 8px 10px; border-radius: 8px;">
              <label style="font-size: 11px; color: var(--fg-muted); display: block; margin-bottom: 4px;">終了位置 (秒)</label>
              <input type="number" id="ve-end-time-input" min="0" step="0.5" value="0" class="ve-input" style="width: 100%; height: 32px; box-sizing: border-box;" />
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 11px; color: var(--fg-muted);">
              前後の余白や不要なイントロをカット可能
            </div>
            <button type="button" class="btn" id="btn-ve-preview-toggle" style="font-size: 12px; font-weight: 600; padding: 4px 12px;">
              ▶ 試聴プレビュー
            </button>
          </div>
        </div>

        <!-- 音量ノーマライズ設定 -->
        <div class="ve-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 700; font-size: 13px;">🔊 音量ノーマライズ</div>
            <select id="ve-norm-select" class="ve-input" style="width: auto; height: 30px; font-weight: 600;">
              <option value="reference" selected>🎯 基準の曲に合わせる (推奨)</option>
              <option value="peak">⚡ 最大音量ノーマライズ (-0.3dB)</option>
              <option value="none">オフ (動画の音量のまま)</option>
            </select>
          </div>
          <div style="font-size: 11px; color: var(--fg-muted);" id="ve-norm-desc">
            抽出と同時に音量を均一化し、他の音楽と同じ聴き心地に調整します
          </div>
        </div>

        <!-- 保存先オプション -->
        <div class="ve-card" style="padding: 10px 14px;">
          <div style="margin-bottom: 6px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
              <input type="checkbox" id="ve-drive-save-cb" checked style="width: 16px; height: 16px; cursor: pointer;" />
              <div>
                <div style="font-weight: 600; font-size: 12px; color: var(--fg);">
                  ☁ Google Drive にも保存する (同期対応)
                </div>
                <div style="font-size: 11px; color: var(--fg-muted);">
                  チェックすると Google Drive の「MUSIC-PLAYER」フォルダに保存され他端末と自動同期
                </div>
              </div>
            </label>
          </div>
          <div style="padding-top: 6px; border-top: 1px solid var(--border);">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
              <input type="checkbox" id="ve-download-file-cb" style="width: 16px; height: 16px; cursor: pointer;" />
              <div>
                <div style="font-weight: 600; font-size: 12px; color: var(--fg);">
                  💾 端末のファイルにも MP3 を書き出す
                </div>
                <div style="font-size: 11px; color: var(--fg-muted);">
                  チェックするとブラウザのダウンロードとして MP3 ファイルをローカルに保存
                </div>
              </div>
            </label>
          </div>
        </div>

        <!-- 保存進行状況プログレスバー -->
        <div id="ve-progress-wrap" style="display: none; margin-top: 12px;">
          <div id="ve-progress-status" style="font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 4px;">
            MP3 に変換中…
          </div>
          <div class="ve-progress-bar-wrap">
            <div class="ve-progress-bar-fill" id="ve-progress-bar"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  let decodedAudioBuffer = null;
  let currentArtworkBlob = null;
  let previewSourceNode = null;
  let previewAudioCtx = null;
  let isPreviewPlaying = false;

  // モーダルを表示
  const modalClose = openModal({
    title: "🎥 動画から音声を抽出",
    body: container,
    actions: [
      {
        label: "キャンセル",
        onClick: () => {
          stopPreview();
        },
      },
      {
        label: "💾 ライブラリに追加",
        primary: true,
        id: "btn-ve-save",
        onClick: async () => {
          return await executeSave();
        },
      },
    ],
  });

  const loadingWrap = container.querySelector("#ve-loading-wrap");
  const loadingStatus = container.querySelector("#ve-loading-status");
  const mainWrap = container.querySelector("#ve-main-wrap");
  const artworkImg = container.querySelector("#ve-artwork-img");
  const artworkPlaceholder = container.querySelector("#ve-artwork-placeholder");
  const changeArtBtn = container.querySelector("#btn-ve-change-art");
  const artFileInput = container.querySelector("#ve-art-file-input");
  const fileInfo = container.querySelector("#ve-file-info");
  const durationInfo = container.querySelector("#ve-duration-info");
  const titleInput = container.querySelector("#ve-title-input");
  const artistInput = container.querySelector("#ve-artist-input");
  const albumInput = container.querySelector("#ve-album-input");
  const cutDurationBadge = container.querySelector("#ve-cut-duration-badge");
  const startTimeInput = container.querySelector("#ve-start-time-input");
  const endTimeInput = container.querySelector("#ve-end-time-input");
  const previewToggleBtn = container.querySelector("#btn-ve-preview-toggle");
  const normSelect = container.querySelector("#ve-norm-select");
  const driveSaveCb = container.querySelector("#ve-drive-save-cb");
  const downloadFileCb = container.querySelector("#ve-download-file-cb");
  const progressWrap = container.querySelector("#ve-progress-wrap");
  const progressStatus = container.querySelector("#ve-progress-status");
  const progressBar = container.querySelector("#ve-progress-bar");

  // Google Drive 接続状態に応じた初期トグル
  const driveConn = await isDriveConnected().catch(() => false);
  if (!driveConn && driveSaveCb) {
    driveSaveCb.checked = false;
    driveSaveCb.disabled = true;
    driveSaveCb.title = "Google Drive が未接続です";
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }

  function updateCutDisplay() {
    if (!decodedAudioBuffer) return;
    const dur = decodedAudioBuffer.duration;
    let st = parseFloat(startTimeInput.value) || 0;
    let et = parseFloat(endTimeInput.value) || dur;

    st = Math.max(0, Math.min(st, dur));
    et = Math.max(st, Math.min(et, dur));

    cutDurationBadge.textContent = `${formatTime(st)} - ${formatTime(et)} (${formatTime(et - st)})`;
  }

  function stopPreview() {
    if (previewSourceNode) {
      try { previewSourceNode.stop(); } catch (_) {}
      previewSourceNode = null;
    }
    if (previewAudioCtx) {
      try { previewAudioCtx.close(); } catch (_) {}
      previewAudioCtx = null;
    }
    isPreviewPlaying = false;
    if (previewToggleBtn) previewToggleBtn.textContent = "▶ 試聴プレビュー";
  }

  function togglePreview() {
    if (!decodedAudioBuffer) return;

    if (isPreviewPlaying) {
      stopPreview();
      return;
    }

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      previewAudioCtx = new AC();

      const dur = decodedAudioBuffer.duration;
      let st = parseFloat(startTimeInput.value) || 0;
      let et = parseFloat(endTimeInput.value) || dur;
      st = Math.max(0, Math.min(st, dur));
      et = Math.max(st, Math.min(et, dur));

      previewSourceNode = previewAudioCtx.createBufferSource();
      previewSourceNode.buffer = decodedAudioBuffer;
      previewSourceNode.connect(previewAudioCtx.destination);

      previewSourceNode.onended = () => {
        stopPreview();
      };

      const playLength = Math.max(0.1, et - st);
      previewSourceNode.start(0, st, playLength);
      isPreviewPlaying = true;
      if (previewToggleBtn) previewToggleBtn.textContent = "⏹ 停止";
    } catch (e) {
      console.warn("[video-extract-modal] 試聴エラー:", e);
      stopPreview();
    }
  }

  // アートワーク画像切り替え
  changeArtBtn.addEventListener("click", () => {
    artFileInput.click();
  });

  artFileInput.addEventListener("change", () => {
    const file = artFileInput.files?.[0];
    if (file) {
      currentArtworkBlob = file;
      artworkImg.src = URL.createObjectURL(file);
      artworkImg.style.display = "block";
      artworkPlaceholder.style.display = "none";
    }
  });

  startTimeInput.addEventListener("input", updateCutDisplay);
  endTimeInput.addEventListener("input", updateCutDisplay);
  previewToggleBtn.addEventListener("click", togglePreview);

  // 保存処理
  async function executeSave() {
    if (!decodedAudioBuffer) {
      toast("動画の音声データが準備できていません", "err");
      return false;
    }

    stopPreview();

    const title = titleInput.value.trim() || initialTitle || "無題の楽曲";
    const artist = artistInput.value.trim() || initialArtist || "不明なアーティスト";
    const album = albumInput.value.trim() || "動画から抽出";
    const startTime = parseFloat(startTimeInput.value) || 0;
    const endTime = parseFloat(endTimeInput.value) || decodedAudioBuffer.duration;
    const normMode = normSelect.value;
    const saveToDrive = driveSaveCb && driveSaveCb.checked && !driveSaveCb.disabled;
    const downloadFile = downloadFileCb && downloadFileCb.checked;

    mainWrap.style.display = "none";
    loadingWrap.style.display = "none";
    progressWrap.style.display = "block";

    const saveBtn = document.querySelector("#btn-ve-save");
    if (saveBtn) saveBtn.disabled = true;

    try {
      progressStatus.textContent = "MP3 320kbps に高品質エンコード中…";
      progressBar.style.width = "20%";

      const pub = getPublic();
      let targetRmsDb = -14.0;
      if (pub.normalizeReferenceTrack && typeof pub.normalizeReferenceTrack.rmsDb === "number") {
        targetRmsDb = pub.normalizeReferenceTrack.rmsDb;
      }

      // 1. エンコード実行
      const encResult = await encodeVideoAudioTrack(decodedAudioBuffer, {
        startTime,
        endTime,
        title,
        artist,
        album,
        artworkBlob: currentArtworkBlob,
        normalizeMode: normMode,
        targetRmsDb,
        onProgress: (pct) => {
          progressBar.style.width = `${pct}%`;
          progressStatus.textContent = `MP3 に変換中 (${pct}%)…`;
        },
      });

      progressBar.style.width = "85%";
      progressStatus.textContent = "ライブラリに保存中…";

      // 2. トラックメタデータの構築
      const trackId = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newTrack = {
        id: trackId,
        title,
        artist,
        album,
        duration: encResult.duration,
        format: "mp3",
        mime: "audio/mpeg",
        fileSize: encResult.mp3Blob.size,
        addedAt: Date.now(),
        source: "video-extract",
        cached: true,
        artworkBlob: currentArtworkBlob || null,
        normalized: normMode !== "none",
        normalizedType: normMode !== "none" ? "reencoded" : undefined,
        normalizedGainDb: 0,
        appliedGainDb: encResult.gainDb,
      };

      // 3. IndexedDB へ保存
      await putTrack(newTrack, encResult.mp3Blob);

      // 4. Google Drive にアップロード（オプション）
      if (saveToDrive) {
        progressBar.style.width = "95%";
        progressStatus.textContent = "Google Drive に保存中…";
        try {
          const driveFilename = `${artist} - ${title}.mp3`.replace(/[/\\?%*:|"<>]/g, "_");
          const driveFile = await uploadFileToDrive(encResult.mp3Blob, driveFilename, "audio/mpeg");
          if (driveFile && driveFile.id) {
            newTrack.driveFileId = driveFile.id;
            await putTrack(newTrack, encResult.mp3Blob);
          }
        } catch (driveErr) {
          console.warn("[video-extract-modal] Google Drive 保存失敗 (ローカルは保存済):", driveErr);
          toast("Google Drive への保存に失敗しましたが、端末ライブラリには保存されました", "err");
        }
      }

      // 5. ローカルダウンロード（オプション）
      if (downloadFile) {
        try {
          const downloadUrl = URL.createObjectURL(encResult.mp3Blob);
          const a = document.createElement("a");
          a.href = downloadUrl;
          a.download = `${artist} - ${title}.mp3`.replace(/[/\\?%*:|"<>]/g, "_");
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(downloadUrl);
          }, 1000);
        } catch (_) {}
      }

      progressBar.style.width = "100%";
      toast(`✅ 「${title}」の音声を抽出してライブラリに追加しました！`, "ok", 4000);

      if (typeof onSaved === "function") {
        onSaved(newTrack);
      }

      return true;
    } catch (err) {
      console.error("[video-extract-modal] 保存エラー:", err);
      toast(`保存に失敗しました: ${err.message}`, "err");
      progressWrap.style.display = "none";
      mainWrap.style.display = "block";
      if (saveBtn) saveBtn.disabled = false;
      return false;
    }
  }

  // 初期化: 音声デコード & サムネイルキャプチャを並行実行
  (async () => {
    try {
      loadingStatus.textContent = "音声トラックを PCM デコード中…";

      // 1. 音声デコード
      decodedAudioBuffer = await extractAudioBufferFromVideoBlob(videoFile);

      // 2. サムネイル自動キャプチャ
      loadingStatus.textContent = "動画のサムネイルを自動抽出中…";
      currentArtworkBlob = await captureVideoFrameAsBlob(videoFile, 1.0, 640).catch(() => null);

      if (currentArtworkBlob) {
        artworkImg.src = URL.createObjectURL(currentArtworkBlob);
        artworkImg.style.display = "block";
        artworkPlaceholder.style.display = "none";
      } else {
        artworkImg.style.display = "none";
        artworkPlaceholder.style.display = "flex";
      }

      const dur = decodedAudioBuffer.duration;
      durationInfo.textContent = `総再生時間: ${formatTime(dur)} (${dur.toFixed(1)} 秒)`;
      startTimeInput.max = dur;
      endTimeInput.max = dur;
      endTimeInput.value = dur.toFixed(1);
      updateCutDisplay();

      loadingWrap.style.display = "none";
      mainWrap.style.display = "block";
    } catch (err) {
      console.error("[video-extract-modal] 初期化エラー:", err);
      loadingWrap.innerHTML = `
        <div style="font-size: 28px; margin-bottom: 8px;">❌</div>
        <div style="font-size: 14px; font-weight: 700; color: var(--err); margin-bottom: 6px;">
          動画の解析に失敗しました
        </div>
        <div style="font-size: 12px; color: var(--fg-muted); line-height: 1.5; padding: 0 10px;">
          ${escapeHtml(err.message || "動画から音声トラックを抽出できませんでした")}
        </div>
      `;
    }
  })();
}
