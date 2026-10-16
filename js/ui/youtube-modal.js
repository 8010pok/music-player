/**
 * YouTube 音源ダウンロード & カット編集 & Google Drive 保存モーダル
 *
 * - YouTube の URL から音源ストリームを抽出・ダウンロード
 * - 音声のカット編集（開始位置・終了位置の指定、波形・プレビュー再生）
 * - MP3 320kbps (標準設定) へのエンコード & ID3 タグ埋め込み
 * - Google Drive (「MUSIC-PLAYER」フォルダ) への直接保存 & ライブラリ自動登録
 * - 端末への直接ダウンロードにも対応
 */

import { openModal, toast, confirm, escapeHtml, escapeAttr } from "./components.js";
import {
  fetchVideoInfo,
  downloadAudioStream,
  downloadYouTubeAudio,
  extractYouTubeVideoId,
} from "../youtube/youtube-service.js";
import {
  sliceAndEncodeAudio,
  analyzeAudioLoudness,
  calculateNormalizeGain,
} from "../audio/mp3-encoder.js";
import { isDriveConnected, uploadFileToDrive, requestGisToken } from "../gdrive/drive-service.js";
import { putTrack, getAllTracks, getBlob } from "../store/library-db.js";
import { getPublic, setPublic } from "../store/settings.js";
import { setQueueAndPlay } from "../player/audio-engine.js";
import { findDuplicateInList } from "../store/dedup-service.js";
import { parseArtistAndTitle, cleanArtistName, cleanTrackTitle } from "../lastfm/scrobble-cleaner.js";

/**
 * YouTube ダウンロード & カット編集モーダルを開く
 * @param {object} [opts]
 * @param {() => void} [opts.onSaved] 保存完了時のコールバック（ライブラリ再描画用）
 */
export function openYouTubeDownloadModal({ onSaved = null } = {}) {
  const container = document.createElement("div");
  container.className = "yt-modal-container";

  // モーダル内全体スタイル
  container.innerHTML = `
    <style>
      .yt-modal-container { font-size: 13px; color: var(--fg); }
      .yt-card { background: var(--bg-elev-1); border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid var(--border); }
      .yt-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
      .yt-input { flex: 1; height: 36px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-elev-2); color: var(--fg); font-size: 13px; }
      .yt-input:focus { outline: none; border-color: var(--accent); }
      .yt-progress-bar-wrap { height: 8px; border-radius: 4px; background: var(--bg-elev-2); overflow: hidden; margin: 8px 0 4px; }
      .yt-progress-bar-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.15s ease; }
      .yt-waveform-wrap { position: relative; width: 100%; height: 80px; background: #111; border-radius: 8px; overflow: hidden; cursor: pointer; margin: 10px 0; }
      .yt-waveform-canvas { width: 100%; height: 100%; display: block; }
      .yt-time-ctrls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
      .yt-time-box { background: var(--bg-elev-2); padding: 10px; border-radius: 8px; }
      .yt-time-box label { font-size: 11px; color: var(--fg-muted); display: block; margin-bottom: 4px; }
      .yt-num-input { width: 90px; height: 30px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 13px; font-variant-numeric: tabular-nums; }
      .yt-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: var(--bg-elev-2); color: var(--fg-muted); }
      .yt-badge.accent { background: rgba(0, 113, 227, 0.15); color: var(--accent); }
    </style>

    <!-- ステップ 1: URL 入力エリア -->
    <div id="yt-step-input">
      <div style="margin-bottom: 12px; line-height: 1.5; color: var(--fg-muted); font-size: 12px;">
        YouTube のリンクを入力して音源を取得します。<br/>
        標準設定で <strong>最高音質 MP3 (320kbps)</strong> に変換し、不要な部分をカットして <strong>Google Drive</strong> へ直接保存できます。
      </div>
      <div class="yt-row">
        <input type="text" id="yt-url-input" class="yt-input" placeholder="YouTube URL (例: https://www.youtube.com/watch?v=...)" />
        <button class="btn primary" id="btn-yt-fetch" style="background: #cc0000; color: #fff; font-weight: 600; border: none;">音源取得</button>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
        <span style="font-size: 11px; color: var(--fg-muted);">または端末内の音声ファイルを選択:</span>
        <button class="btn" id="btn-yt-local-file" style="font-size: 11px; padding: 4px 10px;">📁 音声ファイルを選択</button>
        <input type="file" id="yt-file-input" accept="audio/*,video/*" style="display: none;" />
      </div>
    </div>

    <!-- 取得進行状況エリア -->
    <div id="yt-step-loading" style="display: none; margin: 16px 0;">
      <div id="yt-loading-status" style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">動画情報を取得中…</div>
      <div class="yt-progress-bar-wrap">
        <div class="yt-progress-bar-fill" id="yt-loading-bar"></div>
      </div>
    </div>

    <!-- ステップ 2: カット編集 & メタデータ & 保存設定エリア (音源取得後に表示) -->
    <div id="yt-step-editor" style="display: none;">
      <!-- メタデータカード -->
      <div class="yt-card" style="display: flex; gap: 12px; align-items: center;">
        <img id="yt-meta-art" src="" style="width: 64px; height: 64px; border-radius: 8px; object-fit: cover; background: #222;" alt="Artwork" />
        <div style="flex: 1; min-width: 0;">
          <input type="text" id="yt-meta-title" class="yt-input" style="height: 28px; font-weight: 600; margin-bottom: 4px;" placeholder="曲名" />
          <input type="text" id="yt-meta-artist" class="yt-input" style="height: 26px; font-size: 12px; margin-bottom: 4px;" placeholder="アーティスト名" />
          <input type="text" id="yt-meta-album" class="yt-input" style="height: 24px; font-size: 11px; margin-bottom: 4px;" value="YouTube" placeholder="アルバム名" />
          <input type="text" id="yt-meta-memo" class="yt-input" style="height: 24px; font-size: 11px;" placeholder="メモ (例: 京都大作戦2025 / ライブ盤等 ※Scrobble非干渉)" />
        </div>
      </div>

      <!-- 波形 & プレビュープレイヤー -->
      <div class="yt-card" id="yt-waveform-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <span style="font-weight: 600; font-size: 12px;">✂ 音源カット編集</span>
          <span id="yt-cur-time-display" style="font-size: 12px; font-variant-numeric: tabular-nums;">0:00.0 / 0:00.0</span>
        </div>

        <div class="yt-waveform-wrap" id="yt-waveform-wrap" title="クリックしてシーク">
          <canvas class="yt-waveform-canvas" id="yt-waveform-canvas" width="480" height="80"></canvas>
        </div>

        <!-- 再生コントロール -->
        <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between;">
          <div style="display: flex; gap: 6px;">
            <button class="btn" id="btn-yt-play-toggle" style="padding: 4px 10px;">▶ プレビュー</button>
            <button class="btn" id="btn-yt-play-selection" style="padding: 4px 10px;" title="カット範囲のみを再生">✂ カット範囲再生</button>
          </div>
          <button class="btn" id="btn-yt-reset-cut" style="padding: 4px 8px; font-size: 11px;">↺ 全体を選択</button>
        </div>

        <!-- カット範囲の数値・微調整設定 -->
        <div class="yt-time-ctrls">
          <div class="yt-time-box">
            <label>🚩 開始位置 (Start)</label>
            <div style="display: flex; gap: 4px; align-items: center; margin-bottom: 4px;">
              <input type="number" id="yt-start-num" class="yt-num-input" step="0.1" min="0" value="0.0" />
              <span style="font-size: 11px; color: var(--fg-muted);">秒</span>
            </div>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
              <button class="btn" id="btn-yt-set-start-here" style="font-size: 10px; padding: 2px 6px;">現在位置</button>
              <button class="btn" id="btn-yt-start-sub" style="font-size: 10px; padding: 2px 6px;">-1s</button>
              <button class="btn" id="btn-yt-start-add" style="font-size: 10px; padding: 2px 6px;">+1s</button>
            </div>
          </div>

          <div class="yt-time-box">
            <label>🏁 終了位置 (End)</label>
            <div style="display: flex; gap: 4px; align-items: center; margin-bottom: 4px;">
              <input type="number" id="yt-end-num" class="yt-num-input" step="0.1" min="0" value="0.0" />
              <span style="font-size: 11px; color: var(--fg-muted);">秒</span>
            </div>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
              <button class="btn" id="btn-yt-set-end-here" style="font-size: 10px; padding: 2px 6px;">現在位置</button>
              <button class="btn" id="btn-yt-end-sub" style="font-size: 10px; padding: 2px 6px;">-1s</button>
              <button class="btn" id="btn-yt-end-add" style="font-size: 10px; padding: 2px 6px;">+1s</button>
            </div>
          </div>
        </div>

        <div style="margin-top: 8px; text-align: center;">
          <span class="yt-badge accent" id="yt-cut-summary-badge">カット後の長さ: 0:00.0</span>
        </div>
      </div>

      <!-- 音量ノーマライズ設定 -->
      <div class="yt-card" id="yt-norm-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 6px;">
            <span>🔊 音量ノーマライズ</span>
            <span class="yt-badge accent" id="yt-norm-badge">自動 (+0.0 dB)</span>
          </div>
          <select id="yt-norm-mode" class="yt-input" style="width: auto; height: 30px; font-weight: 600;">
            <option value="reference" selected>🎯 基準の曲に合わせる (推奨)</option>
            <option value="peak">⚡ 最大音量にノーマライズ (0dB)</option>
            <option value="manual">🎚 手動調整 (ゲインスライダー)</option>
            <option value="none">オフ (元の音量のまま)</option>
          </select>
        </div>

        <!-- 基準曲情報エリア -->
        <div id="yt-norm-ref-area" style="background: var(--bg-elev-2); border-radius: 8px; padding: 10px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-size: 11px; color: var(--fg-muted);">基準にする曲:</span>
            <button type="button" class="btn" id="btn-yt-pick-ref" style="font-size: 11px; padding: 2px 8px;">曲を変更…</button>
          </div>
          <div id="yt-norm-ref-title" style="font-weight: 600; font-size: 12px; margin-bottom: 2px;">
            標準ラウドネス (-14.0 dBFS)
          </div>
          <div id="yt-norm-ref-desc" style="font-size: 11px; color: var(--fg-muted);">
            ライブラリの曲を選ぶと、その曲の音量に合わせて自動調整します
          </div>
        </div>

        <!-- 手動ゲイン調整エリア -->
        <div id="yt-norm-manual-area" style="display: none; background: var(--bg-elev-2); border-radius: 8px; padding: 10px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-size: 11px; color: var(--fg-muted);">ゲイン調整:</span>
            <span id="yt-norm-manual-label" style="font-weight: 600; font-size: 12px;">+0.0 dB</span>
          </div>
          <input type="range" id="yt-norm-gain-slider" min="-6" max="14" step="0.5" value="0" style="width: 100%; cursor: pointer;" />
        </div>

        <!-- 解析結果 & 適用サマリー -->
        <div id="yt-norm-summary" style="font-size: 11px; color: var(--fg-muted); line-height: 1.4;">
          音源読み込み後に音量を自動解析します
        </div>
      </div>

      <!-- 保存設定（MP3 ビットレート & 保存先） -->
      <div class="yt-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label style="font-weight: 600; font-size: 12px;">音質設定 (MP3 ビットレート)</label>
          <select id="yt-bitrate-select" class="yt-input" style="width: auto; height: 30px; font-weight: 600;">
            <option value="320" selected>MP3 320 kbps (最高音質・標準)</option>
            <option value="256">MP3 256 kbps (高音質)</option>
            <option value="192">MP3 192 kbps (標準)</option>
            <option value="128">MP3 128 kbps (軽量)</option>
          </select>
        </div>
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="yt-download-file-cb" style="cursor: pointer; width: 15px; height: 15px;" />
          <label for="yt-download-file-cb" style="font-size: 11px; color: var(--fg-muted); cursor: pointer; user-select: none;">
            端末の「ファイル」にも MP3 を書き出す (未チェックなら「○○で開く」を経由せず直接保存)
          </label>
        </div>
      </div>
    </div>

    <!-- 基準曲選択オーバーレイパネル -->
    <div id="yt-ref-picker-overlay" style="display: none; position: absolute; inset: 0; background: var(--bg-elev-1); z-index: 100; border-radius: 12px; padding: 16px; flex-direction: column; box-shadow: 0 4px 24px rgba(0,0,0,0.3);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <h3 style="margin: 0; font-size: 14px; font-weight: 700;">🎯 音量の基準にする曲を選択</h3>
        <button type="button" class="btn" id="btn-yt-close-ref-picker" style="font-size: 11px; padding: 3px 8px;">✕ 閉じる</button>
      </div>
      <div style="font-size: 11px; color: var(--fg-muted); margin-bottom: 10px; line-height: 1.4;">
        ライブラリの曲を選ぶと、その曲の音量（RMSラウドネス）を自動計測し、YouTubeの音源を同じ音量感に引き上げます。
      </div>
      <div style="margin-bottom: 8px; display: flex; gap: 6px;">
        <input type="text" id="yt-ref-search-input" class="yt-input" placeholder="曲名やアーティスト名で検索…" style="height: 32px;" />
        <button type="button" class="btn" id="btn-yt-reset-standard-ref" style="font-size: 11px; white-space: nowrap; padding: 0 8px;">標準 (-14dB) に戻す</button>
      </div>
      <div id="yt-ref-track-list" style="flex: 1; overflow-y: auto; max-height: 300px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev-2); padding: 4px;">
        <!-- 曲一覧がここに展開される -->
      </div>
      <div id="yt-ref-analyzing-msg" style="display: none; margin-top: 8px; text-align: center; color: var(--accent); font-size: 12px; font-weight: 600;">
        ⏳ 基準曲の音量を解析中…
      </div>
    </div>
  `;

  let currentAudioBuffer = null;
  let currentArtworkBlob = null;
  let audioDuration = 0;
  let cutStartTime = 0;
  let cutEndTime = 0;
  let isPlayingSelectionOnly = false;
  let animFrameId = null;

  // モーダル生成
  openModal({
    title: "YouTube 音源保存 & カット編集",
    body: container,
    actions: [
      {
        label: "閉じる",
        onClick: () => {
          cleanupPreview();
          return true;
        },
      },
      {
        label: "📱 ライブラリに直接保存 (即再生)",
        primary: true,
        onClick: async () => {
          return await handleExportAndSave("library");
        },
      },
      {
        label: "☁ Google Drive に保存",
        onClick: async () => {
          return await handleExportAndSave("gdrive");
        },
      },
    ],
  });

  const stepInput = container.querySelector("#yt-step-input");
  const stepLoading = container.querySelector("#yt-step-loading");
  const stepEditor = container.querySelector("#yt-step-editor");
  const loadingStatus = container.querySelector("#yt-loading-status");
  const loadingBar = container.querySelector("#yt-loading-bar");

  const urlInput = container.querySelector("#yt-url-input");
  const fetchBtn = container.querySelector("#btn-yt-fetch");
  const localFileBtn = container.querySelector("#btn-yt-local-file");
  const fileInput = container.querySelector("#yt-file-input");

  const metaArt = container.querySelector("#yt-meta-art");
  const metaTitle = container.querySelector("#yt-meta-title");
  const metaArtist = container.querySelector("#yt-meta-artist");
  const metaAlbum = container.querySelector("#yt-meta-album");
  const metaMemo = container.querySelector("#yt-meta-memo");

  const canvas = container.querySelector("#yt-waveform-canvas");
  const waveformWrap = container.querySelector("#yt-waveform-wrap");
  const curTimeDisplay = container.querySelector("#yt-cur-time-display");
  const playToggleBtn = container.querySelector("#btn-yt-play-toggle");
  const playSelectionBtn = container.querySelector("#btn-yt-play-selection");
  const resetCutBtn = container.querySelector("#btn-yt-reset-cut");

  const startNumInput = container.querySelector("#yt-start-num");
  const endNumInput = container.querySelector("#yt-end-num");
  const setStartHereBtn = container.querySelector("#btn-yt-set-start-here");
  const setEndHereBtn = container.querySelector("#btn-yt-set-end-here");
  const startSubBtn = container.querySelector("#btn-yt-start-sub");
  const startAddBtn = container.querySelector("#btn-yt-start-add");
  const endSubBtn = container.querySelector("#btn-yt-end-sub");
  const endAddBtn = container.querySelector("#btn-yt-end-add");
  const cutSummaryBadge = container.querySelector("#yt-cut-summary-badge");
  const bitrateSelect = container.querySelector("#yt-bitrate-select");
  const downloadFileCb = container.querySelector("#yt-download-file-cb");

  // 音量ノーマライズ関連 DOM 要素
  const normModeSelect = container.querySelector("#yt-norm-mode");
  const normBadge = container.querySelector("#yt-norm-badge");
  const normRefArea = container.querySelector("#yt-norm-ref-area");
  const normRefTitle = container.querySelector("#yt-norm-ref-title");
  const normRefDesc = container.querySelector("#yt-norm-ref-desc");
  const pickRefBtn = container.querySelector("#btn-yt-pick-ref");
  const normManualArea = container.querySelector("#yt-norm-manual-area");
  const normManualLabel = container.querySelector("#yt-norm-manual-label");
  const normGainSlider = container.querySelector("#yt-norm-gain-slider");
  const normSummary = container.querySelector("#yt-norm-summary");

  // 基準曲ピッカーオーバーレイ関連 DOM 要素
  const refPickerOverlay = container.querySelector("#yt-ref-picker-overlay");
  const closeRefPickerBtn = container.querySelector("#btn-yt-close-ref-picker");
  const refSearchInput = container.querySelector("#yt-ref-search-input");
  const resetStandardRefBtn = container.querySelector("#btn-yt-reset-standard-ref");
  const refTrackList = container.querySelector("#yt-ref-track-list");
  const refAnalyzingMsg = container.querySelector("#yt-ref-analyzing-msg");

  // 音量ノーマライズ状態
  let currentSourceLoudness = null; // { peak, peakDb, rms, rmsDb }
  let currentCalculatedGain = 1.0;
  let previewAudioCtx = null;
  let previewSourceNode = null;
  let previewGainNode = null;
  let isPreviewPlaying = false;
  let previewStartedAt = 0; // AudioContext.currentTime における再生開始時点
  let previewOffset = 0;    // 音源内の再生オフセット秒
  let previewDuration = 0;  // 再生予定の長さ（秒）

  // 音声プレビュークリーンアップ
  function cleanupPreview() {
    if (previewSourceNode) {
      try {
        previewSourceNode.onended = null;
        previewSourceNode.stop();
      } catch (_) {}
      previewSourceNode = null;
    }
    if (previewAudioCtx) {
      try { previewAudioCtx.close(); } catch (_) {}
      previewAudioCtx = null;
      previewGainNode = null;
    }
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    isPreviewPlaying = false;
    isPlayingSelectionOnly = false;
    if (playToggleBtn) playToggleBtn.textContent = "▶ プレビュー";
  }

  // 再生ヘッドの現在秒を取得
  function getPreviewCurrentTime() {
    if (!isPreviewPlaying || !previewAudioCtx) return previewOffset;
    const elapsed = previewAudioCtx.currentTime - previewStartedAt;
    const cur = previewOffset + elapsed;
    return Math.min(audioDuration, Math.max(0, cur));
  }

  // 指定位置・長さで高精度プレビュー再生を開始（Web Audio AudioBufferSourceNode）
  function startPreviewAt(offset, duration = null) {
    if (!currentAudioBuffer) return;
    cleanupPreview();

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      previewAudioCtx = new AC();
      if (previewAudioCtx.state === "suspended") {
        previewAudioCtx.resume();
      }

      previewGainNode = previewAudioCtx.createGain();
      previewGainNode.gain.value = currentCalculatedGain || 1.0;
      previewGainNode.connect(previewAudioCtx.destination);

      previewSourceNode = previewAudioCtx.createBufferSource();
      previewSourceNode.buffer = currentAudioBuffer;
      previewSourceNode.connect(previewGainNode);

      const st = Math.max(0, Math.min(offset, audioDuration));
      const maxLen = Math.max(0, audioDuration - st);
      const len = duration !== null ? Math.min(duration, maxLen) : maxLen;

      previewOffset = st;
      previewStartedAt = previewAudioCtx.currentTime;
      previewDuration = len;

      previewSourceNode.onended = () => {
        cleanupPreview();
        updateTimeDisplay();
        renderWaveform();
      };

      previewSourceNode.start(0, st, len);
      isPreviewPlaying = true;
      if (playToggleBtn) playToggleBtn.textContent = "⏸ 一時停止";

      const trackLoop = () => {
        if (isPreviewPlaying) {
          updateTimeDisplay();
          renderWaveform();
          animFrameId = requestAnimationFrame(trackLoop);
        }
      };
      animFrameId = requestAnimationFrame(trackLoop);
    } catch (e) {
      console.warn("[yt] プレビュー再生エラー:", e);
      cleanupPreview();
    }
  }

  // 音量ノーマライズの計算 & UI 表示更新
  function updateNormalizeDisplay() {
    if (!currentAudioBuffer) {
      normSummary.textContent = "音源読み込み後に音量を自動解析します";
      normBadge.textContent = "待機中";
      return;
    }

    // カット範囲内の音源ラウドネスを解析
    currentSourceLoudness = analyzeAudioLoudness(currentAudioBuffer, {
      startTime: cutStartTime,
      endTime: cutEndTime,
    });

    const mode = normModeSelect.value;
    const pub = getPublic();
    const refTrack = pub.normalizeReferenceTrack;

    // 基準曲のターゲット RMS dBFS
    let targetRmsDb = -14.0;
    let refLabel = "標準ラウドネス (-14.0 dBFS)";
    let refSub = "ライブラリの曲を選ぶと、その曲の音量に合わせて自動調整します";
    if (refTrack && typeof refTrack.rmsDb === "number") {
      targetRmsDb = refTrack.rmsDb;
      refLabel = `「${refTrack.title}」(${refTrack.artist || "不明"})`;
      refSub = `基準曲の音量: ${refTrack.rmsDb.toFixed(1)} dBFS (Peak: ${refTrack.peakDb ? refTrack.peakDb.toFixed(1) : "-"} dBFS)`;
    }

    normRefTitle.textContent = refLabel;
    normRefDesc.textContent = refSub;
    normRefArea.style.display = mode === "reference" ? "block" : "none";
    normManualArea.style.display = mode === "manual" ? "block" : "none";

    const manualGainDb = parseFloat(normGainSlider.value) || 0;
    normManualLabel.textContent = `${manualGainDb >= 0 ? "+" : ""}${manualGainDb.toFixed(1)} dB`;

    const result = calculateNormalizeGain({
      sourceLoudness: currentSourceLoudness,
      mode,
      targetRmsDb,
      manualGainDb,
      maxPeakDb: -0.3,
    });

    currentCalculatedGain = result.gain;

    if (previewGainNode) {
      try { previewGainNode.gain.value = currentCalculatedGain; } catch (_) {}
    }

    // バッジ & サマリー表示
    if (mode === "none") {
      normBadge.textContent = "オフ";
      normBadge.className = "yt-badge";
      normSummary.innerHTML = `音量調整なし (元音源 Peak: <strong>${currentSourceLoudness.peakDb.toFixed(1)} dBFS</strong>, RMS: <strong>${currentSourceLoudness.rmsDb.toFixed(1)} dBFS</strong>)`;
    } else {
      const sign = result.gainDb >= 0 ? "+" : "";
      normBadge.textContent = `${sign}${result.gainDb.toFixed(1)} dB (${result.gain.toFixed(2)}x)`;
      normBadge.className = "yt-badge accent";

      let detailMsg = "";
      if (mode === "reference") {
        detailMsg = `基準曲 (${targetRmsDb.toFixed(1)} dBFS) に合わせ <strong>${sign}${result.gainDb.toFixed(1)} dB</strong> (${result.gain.toFixed(2)}倍) 調整`;
      } else if (mode === "peak") {
        detailMsg = `ピークを最大音量 (-0.3 dBFS) まで <strong>${sign}${result.gainDb.toFixed(1)} dB</strong> (${result.gain.toFixed(2)}倍) ノーマライズ`;
      } else if (mode === "manual") {
        detailMsg = `手動ゲイン: <strong>${sign}${result.gainDb.toFixed(1)} dB</strong> (${result.gain.toFixed(2)}倍)`;
      }

      if (result.limited) {
        detailMsg += ` <span style="color: var(--accent); font-weight:600;">(⚠️ 音割れ防止のためピーク -0.3dB で安全制限)</span>`;
      }

      normSummary.innerHTML = `
        元音源: Peak ${currentSourceLoudness.peakDb.toFixed(1)} dB / RMS ${currentSourceLoudness.rmsDb.toFixed(1)} dB<br/>
        👉 ${detailMsg} → 調整後 Peak: <strong>${result.finalPeakDb.toFixed(1)} dB</strong>, RMS: <strong>${result.finalRmsDb.toFixed(1)} dB</strong>
      `;
    }
  }

  // 基準曲ピッカーのオープン
  async function openReferenceTrackPicker() {
    refPickerOverlay.style.display = "flex";
    refAnalyzingMsg.style.display = "none";
    refSearchInput.value = "";
    await renderReferenceTrackList("");
  }

  // 基準曲候補リストの描画
  async function renderReferenceTrackList(query = "") {
    refTrackList.innerHTML = '<div style="padding: 10px; color: var(--fg-muted); text-align: center;">曲リストを読み込み中…</div>';
    try {
      const allTracks = await getAllTracks();
      if (!allTracks || allTracks.length === 0) {
        refTrackList.innerHTML = '<div style="padding: 14px; color: var(--fg-muted); text-align: center; line-height: 1.5;">ライブラリに曲がまだありません。<br/>音源をライブラリに追加すると基準曲に選べるようになります。</div>';
        return;
      }

      const q = query.toLowerCase().trim();
      const filtered = allTracks.filter((t) => {
        if (!q) return true;
        return (t.title && t.title.toLowerCase().includes(q)) ||
               (t.artist && t.artist.toLowerCase().includes(q)) ||
               (t.album && t.album.toLowerCase().includes(q));
      });

      if (filtered.length === 0) {
        refTrackList.innerHTML = '<div style="padding: 14px; color: var(--fg-muted); text-align: center;">一致する曲が見つかりませんでした</div>';
        return;
      }

      refTrackList.innerHTML = "";
      for (const track of filtered.slice(0, 50)) {
        const item = document.createElement("div");
        item.style.padding = "8px 10px";
        item.style.borderBottom = "1px solid var(--border)";
        item.style.cursor = "pointer";
        item.style.display = "flex";
        item.style.justifyContent = "space-between";
        item.style.alignItems = "center";
        item.style.borderRadius = "6px";
        item.style.transition = "background 0.15s ease";
        item.onmouseenter = () => { item.style.background = "var(--bg-elev-3)"; };
        item.onmouseleave = () => { item.style.background = "transparent"; };

        item.innerHTML = `
          <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 8px;">
            <div style="font-weight: 600; font-size: 12px; color: var(--fg); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(track.title || "無題")}</div>
            <div style="font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(track.artist || "不明")} — ${escapeHtml(track.album || "")}</div>
          </div>
          <button type="button" class="btn" style="font-size: 10px; padding: 3px 8px; white-space: nowrap;">選択</button>
        `;

        item.addEventListener("click", async (e) => {
          e.stopPropagation();
          await selectReferenceTrack(track);
        });
        refTrackList.appendChild(item);
      }
    } catch (err) {
      refTrackList.innerHTML = `<div style="padding: 10px; color: var(--danger); text-align: center;">読込エラー: ${escapeHtml(err.message)}</div>`;
    }
  }

  // 基準曲の選択 & ラウドネス解析
  async function selectReferenceTrack(track) {
    refAnalyzingMsg.style.display = "block";
    refTrackList.style.pointerEvents = "none";
    try {
      const blob = await getBlob(track.id);
      if (!blob) throw new Error("曲の音声データが見つかりませんでした");

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuf = await blob.arrayBuffer();
      const decBuf = await audioCtx.decodeAudioData(arrayBuf);
      const loudness = analyzeAudioLoudness(decBuf);

      const refData = {
        trackId: track.id,
        title: track.title || "無題",
        artist: track.artist || "不明",
        rmsDb: loudness.rmsDb,
        peakDb: loudness.peakDb,
      };

      setPublic({ normalizeReferenceTrack: refData });
      toast(`「${refData.title}」を音量の基準曲に設定しました (${loudness.rmsDb.toFixed(1)} dBFS)`, "ok", 4000);
      refPickerOverlay.style.display = "none";
      updateNormalizeDisplay();
    } catch (err) {
      console.error("[yt] 基準曲解析エラー:", err);
      toast(`基準曲の解析に失敗しました: ${err.message}`, "err", 4000);
    } finally {
      refAnalyzingMsg.style.display = "none";
      refTrackList.style.pointerEvents = "auto";
    }
  }

  // ノーマライズイベントリスナー設定
  pickRefBtn.addEventListener("click", openReferenceTrackPicker);
  closeRefPickerBtn.addEventListener("click", () => {
    refPickerOverlay.style.display = "none";
  });
  refSearchInput.addEventListener("input", () => {
    renderReferenceTrackList(refSearchInput.value);
  });
  resetStandardRefBtn.addEventListener("click", () => {
    setPublic({ normalizeReferenceTrack: null });
    refPickerOverlay.style.display = "none";
    toast("基準曲を標準ラウドネス (-14.0 dBFS) にリセットしました", "info");
    updateNormalizeDisplay();
  });
  normModeSelect.addEventListener("change", updateNormalizeDisplay);
  normGainSlider.addEventListener("input", updateNormalizeDisplay);

  // YouTube 音源取得イベント
  fetchBtn.addEventListener("click", async () => {
    const rawUrl = urlInput.value.trim();
    if (!rawUrl) {
      toast("YouTube の URL を入力してください", "info");
      return;
    }

    stepLoading.style.display = "block";
    fetchBtn.disabled = true;
    loadingBar.style.width = "20%";
    loadingStatus.textContent = "動画情報を取得中…";

    try {
      // 1. YouTube 動画情報の取得 (oEmbed / Invidious で 100% 確実に取得)
      const info = await fetchVideoInfo(rawUrl);

      // サムネイル画像の取得
      let artworkBlob = null;
      if (info.thumbnailUrl) {
        try {
          const artRes = await fetch(info.thumbnailUrl);
          if (artRes.ok) artworkBlob = await artRes.blob();
        } catch (_) {}
      }
      currentArtworkBlob = artworkBlob;

      metaTitle.value = info.title || "無題";
      metaArtist.value = info.author || "YouTube";
      metaAlbum.value = "YouTube";
      if (info.thumbnailUrl) {
        metaArt.src = info.thumbnailUrl;
        metaArt.style.display = "block";
      }

      // 2. 音声ストリームの自動ダウンロード (Savetube 320kbps MP3 または直接ストリーム)
      loadingBar.style.width = "40%";
      loadingStatus.textContent = "高音質音源 (320kbps) をダウンロード中…";

      let audioArrayBuffer = null;
      let streamUrl = info.audioUrl || null;
      let totalBytes = 0;

      if (!streamUrl) {
        const audioFormats = (info.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio") && f.url);
        if (audioFormats.length > 0) {
          const bestAudio = audioFormats.find((f) => f.itag === "140") ||
                            audioFormats.find((f) => f.itag === "251") ||
                            audioFormats[0];
          streamUrl = bestAudio?.url || null;
          totalBytes = parseInt(bestAudio?.clen || "0", 10);
        }
      }

      if (streamUrl) {
        try {
          audioArrayBuffer = await downloadAudioStream(streamUrl, totalBytes, ({ percent, statusText }) => {
            loadingBar.style.width = `${40 + Math.round(percent * 0.55)}%`;
            loadingStatus.textContent = statusText;
          });
        } catch (streamErr) {
          console.warn("[yt] 第1ストリーム取得失敗、代替ソースを試行中…:", streamErr);
        }
      }

      // 代替取得試行 (ストリームプロキシ経由)
      if (!audioArrayBuffer && info.videoId) {
        loadingStatus.textContent = "代替サーバーから高音質音源を取得中…";
        try {
          const fallbackStreamUrl = `/api/youtube?action=stream&id=${info.videoId}`;
          audioArrayBuffer = await downloadAudioStream(fallbackStreamUrl, 0, ({ percent, statusText }) => {
            loadingBar.style.width = `${50 + Math.round(percent * 0.45)}%`;
            loadingStatus.textContent = statusText;
          });
        } catch (fErr) {
          console.warn("[yt] 代替ストリーム取得失敗:", fErr);
        }
      }

      // 3. ダウンロード成功時: 即座に編集画面へ移行！
      if (audioArrayBuffer) {
        loadingStatus.textContent = "波形エディタを準備中…";
        loadingBar.style.width = "100%";
        await loadAudioForEditing(audioArrayBuffer, {
          title: info.title,
          artist: info.author,
          album: "YouTube",
          artworkBlob,
          thumbnailUrl: info.thumbnailUrl,
        });
        stepLoading.style.display = "none";
        stepEditor.style.display = "block";
        fetchBtn.disabled = false;
        toast("音源の取得が完了しました！カット位置を調整できます", "ok");
        return;
      }

      // 4. 取得失敗時: Dirpy 画面は出さず、再試行可能な明確なエラーを表示
      throw new Error("音源の自動取得に失敗しました。動画URLを確認して再試行してください。");
    } catch (err) {
      stepLoading.style.display = "none";
      fetchBtn.disabled = false;
      toast(err.message || "動画情報の取得に失敗しました", "err", 5000);
    }
  });

  // ローカル音声ファイル選択
  localFileBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    stepLoading.style.display = "block";
    loadingStatus.textContent = "音声ファイルをデコード中…";
    loadingBar.style.width = "50%";

    try {
      const arrayBuffer = await file.arrayBuffer();
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      await loadAudioForEditing(arrayBuffer, {
        title: metaTitle.value && metaTitle.value !== "無題" ? metaTitle.value : baseName,
        artist: metaArtist.value && metaArtist.value !== "YouTube" ? metaArtist.value : "",
        album: metaAlbum.value || "Local Upload",
        artworkBlob: currentArtworkBlob,
        thumbnailUrl: metaArt.src,
      });

      stepLoading.style.display = "none";
      stepEditor.style.display = "block";
      toast("音声ファイルを読み込みました！カット位置を調整できます", "ok");
    } catch (err) {
      stepLoading.style.display = "none";
      toast(`ファイル読込失敗: ${err.message}`, "err");
    }
  });

  // 音声バッファのデコードと編集準備
  async function loadAudioForEditing(arrayBuffer, meta = {}) {
    cleanupPreview();

    const waveformCard = container.querySelector("#yt-waveform-card");
    if (waveformCard) waveformCard.style.display = "block";

    // 1. Web Audio API でデコード
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    currentAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    audioDuration = currentAudioBuffer.duration;
    cutStartTime = 0;
    cutEndTime = audioDuration;
    if (meta.artworkBlob) currentArtworkBlob = meta.artworkBlob;

    // 2. メタデータの反映
    if (meta.title && (!metaTitle.value || metaTitle.value === "無題")) metaTitle.value = meta.title;
    if (meta.artist && (!metaArtist.value || metaArtist.value === "YouTube")) metaArtist.value = meta.artist;
    if (meta.album && (!metaAlbum.value || metaAlbum.value === "YouTube")) metaAlbum.value = meta.album;
    if (meta.thumbnailUrl) {
      metaArt.src = meta.thumbnailUrl;
      metaArt.style.display = "block";
    } else {
      metaArt.style.display = "none";
    }

    // 3. 数値入力欄・カット範囲の初期化
    startNumInput.max = String(Math.floor(audioDuration * 10) / 10);
    endNumInput.max = String(Math.floor(audioDuration * 10) / 10);
    startNumInput.value = "0.0";
    endNumInput.value = (Math.floor(audioDuration * 10) / 10).toFixed(1);
    previewOffset = 0;

    updateCutDisplay();
    renderWaveform();
    updateNormalizeDisplay();
    updateTimeDisplay();
  }

  // 時間フォーマット (分:秒.小数点1桁)
  function formatSec(sec) {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const rem = (s % 60).toFixed(1);
    const padRem = parseFloat(rem) < 10 ? `0${rem}` : rem;
    return `${m}:${padRem}`;
  }

  function updateTimeDisplay() {
    const cur = getPreviewCurrentTime();
    curTimeDisplay.textContent = `${formatSec(cur)} / ${formatSec(audioDuration)}`;
  }

  function updateCutDisplay() {
    startNumInput.value = cutStartTime.toFixed(1);
    endNumInput.value = cutEndTime.toFixed(1);
    const selDuration = Math.max(0, cutEndTime - cutStartTime);
    cutSummaryBadge.textContent = `カット後の長さ: ${formatSec(selDuration)} (元の長さ: ${formatSec(audioDuration)})`;
    updateNormalizeDisplay();
  }

  // 波形描画
  function renderWaveform() {
    if (!canvas || !currentAudioBuffer) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // 背景
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, width, height);

    const data = currentAudioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    // 波形描画
    ctx.fillStyle = "#444";
    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[i * step + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      const y1 = (1 + min) * amp;
      const y2 = Math.max(1, (max - min) * amp);
      ctx.fillRect(i, y1, 1, y2);
    }

    // カット選択範囲のハイライト (半透明アクセント色)
    const startX = (cutStartTime / audioDuration) * width;
    const endX = (cutEndTime / audioDuration) * width;
    ctx.fillStyle = "rgba(0, 113, 227, 0.35)";
    ctx.fillRect(startX, 0, Math.max(2, endX - startX), height);

    // 開始マーカー線 (緑)
    ctx.fillStyle = "#30d158";
    ctx.fillRect(startX, 0, 2, height);

    // 終了マーカー線 (赤)
    ctx.fillStyle = "#ff453a";
    ctx.fillRect(Math.max(0, endX - 2), 0, 2, height);

    // 現在の再生ヘッド線 (白)
    const curTime = getPreviewCurrentTime();
    const curX = (curTime / audioDuration) * width;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(curX, 0, 2, height);
  }

  // 波形クリックでシーク
  waveformWrap.addEventListener("click", (e) => {
    if (!currentAudioBuffer || audioDuration <= 0) return;
    const rect = waveformWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekTime = ratio * audioDuration;
    previewOffset = seekTime;
    if (isPreviewPlaying) {
      startPreviewAt(seekTime, isPlayingSelectionOnly ? Math.max(0.1, cutEndTime - seekTime) : null);
    } else {
      updateTimeDisplay();
      renderWaveform();
    }
  });

  // 再生トグル
  playToggleBtn.addEventListener("click", () => {
    if (!currentAudioBuffer) return;
    if (isPreviewPlaying) {
      cleanupPreview();
      updateTimeDisplay();
      renderWaveform();
    } else {
      isPlayingSelectionOnly = false;
      const startPos = previewOffset >= audioDuration - 0.1 ? 0 : previewOffset;
      startPreviewAt(startPos);
    }
  });

  // カット範囲のみ再生
  playSelectionBtn.addEventListener("click", () => {
    if (!currentAudioBuffer) return;
    isPlayingSelectionOnly = true;
    const playLength = Math.max(0.1, cutEndTime - cutStartTime);
    startPreviewAt(cutStartTime, playLength);
  });

  // 現在位置を開始に設定
  setStartHereBtn.addEventListener("click", () => {
    const cur = getPreviewCurrentTime();
    cutStartTime = Math.min(cutEndTime - 0.1, Math.max(0, cur));
    updateCutDisplay();
    renderWaveform();
  });

  // 現在位置を終了に設定
  setEndHereBtn.addEventListener("click", () => {
    const cur = getPreviewCurrentTime();
    cutEndTime = Math.max(cutStartTime + 0.1, Math.min(audioDuration, cur));
    updateCutDisplay();
    renderWaveform();
  });

  // 微調整ボタン
  startSubBtn.addEventListener("click", () => {
    cutStartTime = Math.max(0, cutStartTime - 1.0);
    updateCutDisplay();
    renderWaveform();
  });
  startAddBtn.addEventListener("click", () => {
    cutStartTime = Math.min(cutEndTime - 0.1, cutStartTime + 1.0);
    updateCutDisplay();
    renderWaveform();
  });
  endSubBtn.addEventListener("click", () => {
    cutEndTime = Math.max(cutStartTime + 0.1, cutEndTime - 1.0);
    updateCutDisplay();
    renderWaveform();
  });
  endAddBtn.addEventListener("click", () => {
    cutEndTime = Math.min(audioDuration, cutEndTime + 1.0);
    updateCutDisplay();
    renderWaveform();
  });

  // 数値入力直接変更
  startNumInput.addEventListener("change", () => {
    const val = parseFloat(startNumInput.value) || 0;
    cutStartTime = Math.max(0, Math.min(cutEndTime - 0.1, val));
    updateCutDisplay();
    renderWaveform();
  });
  endNumInput.addEventListener("change", () => {
    const val = parseFloat(endNumInput.value) || audioDuration;
    cutEndTime = Math.max(cutStartTime + 0.1, Math.min(audioDuration, val));
    updateCutDisplay();
    renderWaveform();
  });

  // リセット
  resetCutBtn.addEventListener("click", () => {
    cutStartTime = 0;
    cutEndTime = audioDuration;
    updateCutDisplay();
    renderWaveform();
  });

  // エクスポート & 保存処理 (Google Drive またはローカルDL)
  async function handleExportAndSave(destination = "gdrive") {
    if (!currentAudioBuffer) {
      toast("先に音源を取得してください", "info");
      return false;
    }

    let title = metaTitle.value.trim() || "無題";
    let artist = metaArtist.value.trim() || "YouTube";
    let album = metaAlbum.value.trim() || "YouTube";
    const memo = metaMemo ? metaMemo.value.trim() : "";

    // もし artist が "YouTube" のままで、タイトルにアーティスト情報が含まれている場合は自動分離
    if (artist.toLowerCase() === "youtube") {
      const parsed = parseArtistAndTitle(title);
      if (parsed) {
        artist = parsed.artist;
        title = parsed.title;
      }
    }

    const bitrate = parseInt(bitrateSelect.value, 10) || 320;
    const filename = `${artist} - ${title}.mp3`.replace(/[\\/:*?"<>|]/g, "_");

    cleanupPreview();

    // 進行状況表示
    stepEditor.style.display = "none";
    stepLoading.style.display = "block";
    loadingStatus.textContent = `MP3 (${bitrate}kbps) にエンコード中…`;
    loadingBar.style.width = "0%";

    try {
      // 1. サムネイル ArrayBuffer の準備
      let artworkBuffer = null;
      if (currentArtworkBlob) {
        artworkBuffer = await currentArtworkBlob.arrayBuffer();
      }

      // 2. カット範囲の PCM を MP3 320kbps にエンコード (音量ノーマライズ適用)
      const mp3Blob = sliceAndEncodeAudio(currentAudioBuffer, {
        startTime: cutStartTime,
        endTime: cutEndTime,
        bitrate,
        gain: currentCalculatedGain,
        metadata: {
          title,
          artist,
          album,
          year: new Date().getFullYear(),
          artworkBuffer,
        },
        onProgress: (pct) => {
          loadingBar.style.width = `${Math.min(70, Math.round(pct * 0.7))}%`;
          loadingStatus.textContent = `MP3 (${bitrate}kbps) にエンコード中… ${pct}%`;
        },
      });

      // 端末ローカル保存 & ライブラリ追加 & 即時再生の共通ヘルパー
      async function saveToLocal({ downloadFile = false } = {}) {
        if (downloadFile) {
          loadingStatus.textContent = "端末へダウンロード中…";
          loadingBar.style.width = "85%";

          // 1. 端末へダウンロード（iOS のファイル保存 / 共有シートがトリガーされる）
          const dlUrl = URL.createObjectURL(mp3Blob);
          const a = document.createElement("a");
          a.href = dlUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(dlUrl);
          }, 1000);
        }

        // 2. ローカルライブラリ（IndexedDB）に登録（「○○で開く」を経由せず直接保存）
        loadingStatus.textContent = "ライブラリに曲を追加中…";
        loadingBar.style.width = "95%";

        // ★ 重複防止チェック: すでに同じ曲がライブラリに存在する場合は新規作成せず既存を更新
        const allExisting = await getAllTracks().catch(() => []);
        const candidate = {
          title,
          artist,
          album,
          duration: Math.round(cutEndTime - cutStartTime) || 0,
        };
        const duplicate = findDuplicateInList(candidate, allExisting);

        const trackId = duplicate ? duplicate.id : `loc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newTrack = {
          id: trackId,
          title,
          artist,
          album,
          albumArtist: artist,
          duration: candidate.duration,
          source: "local",
          format: "mp3",
          mimeType: "audio/mpeg",
          fileSize: mp3Blob.size,
          addedAt: duplicate ? (duplicate.addedAt || Date.now()) : Date.now(),
          userEdited: true,
          playCount: duplicate ? (duplicate.playCount || 0) : 0,
          lastPlayedAt: duplicate ? (duplicate.lastPlayedAt || 0) : 0,
          loved: duplicate ? !!duplicate.loved : false,
          enabled: duplicate ? (duplicate.enabled !== false) : true,
        };
        if (memo) {
          newTrack.memo = memo;
        } else if (duplicate && duplicate.memo) {
          newTrack.memo = duplicate.memo;
        }
        if (currentArtworkBlob) {
          newTrack.artworkBlob = currentArtworkBlob;
        } else if (duplicate && duplicate.artworkBlob) {
          newTrack.artworkBlob = duplicate.artworkBlob;
        }
        if (duplicate && typeof duplicate.order === "number") {
          newTrack.order = duplicate.order;
        }

        await putTrack(newTrack, mp3Blob);

        if (typeof onSaved === "function") {
          try { onSaved(newTrack); } catch (_) {}
        }

        // 3. 即座にライブラリから再生を開始！
        loadingBar.style.width = "100%";
        loadingStatus.textContent = "再生を開始中…";
        try {
          await setQueueAndPlay([newTrack], 0);
        } catch (playErr) {
          console.warn("[yt] 即時再生開始エラー:", playErr);
        }

        const isUpdated = !!duplicate;
        if (isUpdated) {
          toast(`✅ 既存の「${title}」を更新しました（重複保存を防止）`, "ok", 4000);
        } else if (downloadFile) {
          toast(`✅ 端末にダウンロードし、ライブラリに追加しました！（再生を開始）`, "ok", 4000);
        } else {
          toast(`✅ ライブラリに追加しました！（再生を開始）`, "ok", 4000);
        }
        return true;
      }

      if (destination === "library") {
        const shouldDownload = downloadFileCb ? downloadFileCb.checked : false;
        return await saveToLocal({ downloadFile: shouldDownload });
      }

      if (destination === "download") {
        return await saveToLocal({ downloadFile: true });
      }

      // 3. Google Drive 保存
      loadingStatus.textContent = "Google Drive 接続を確認中…";
      loadingBar.style.width = "75%";

      let connected = await isDriveConnected();
      if (!connected) {
        const pub = getPublic();
        if (pub.gdriveClientId) {
          try {
            loadingStatus.textContent = "Google Drive に再接続中…";
            await requestGisToken(pub.gdriveClientId);
            connected = await isDriveConnected();
          } catch (authErr) {
            console.warn("[yt] Google Drive 認証エラー:", authErr);
          }
        }
      }

      if (!connected) {
        toast("Google Drive 未接続のため、アプリ内ライブラリに直接保存しました", "info", 4500);
        return await saveToLocal({ downloadFile: false });
      }

      loadingStatus.textContent = "Google Drive「MUSIC-PLAYER」へアップロード中…";
      try {
        const uploaded = await uploadFileToDrive({
          name: filename,
          blob: mp3Blob,
          mimeType: "audio/mpeg",
          folderName: "MUSIC-PLAYER",
          onProgress: (pct) => {
            loadingBar.style.width = `${75 + Math.round(pct * 0.2)}%`;
          },
        });

        // 4. ライブラリに Google Drive トラックとして登録
        loadingStatus.textContent = "ライブラリに曲を追加中…";

        // ★ 重複防止チェック: 既存曲があればその ID を引き継ぎ二重登録を防ぐ
        const allExisting = await getAllTracks().catch(() => []);
        const candidate = {
          title,
          artist,
          album,
          duration: Math.round(cutEndTime - cutStartTime) || 0,
          driveFileId: uploaded.id,
        };
        const duplicate = findDuplicateInList(candidate, allExisting);

        const trackId = duplicate ? duplicate.id : `gd-${uploaded.id || Date.now()}`;
        const newTrack = {
          id: trackId,
          title,
          artist,
          album,
          albumArtist: artist,
          duration: candidate.duration,
          source: duplicate && duplicate.source === "local" ? "local" : "gdrive",
          format: "mp3",
          mimeType: "audio/mpeg",
          fileSize: mp3Blob.size,
          addedAt: duplicate ? (duplicate.addedAt || Date.now()) : Date.now(),
          userEdited: true,
          driveFileId: uploaded.id,
          driveFileName: filename,
          playCount: duplicate ? (duplicate.playCount || 0) : 0,
          lastPlayedAt: duplicate ? (duplicate.lastPlayedAt || 0) : 0,
          loved: duplicate ? !!duplicate.loved : false,
          enabled: duplicate ? (duplicate.enabled !== false) : true,
        };
        if (memo) {
          newTrack.memo = memo;
        } else if (duplicate && duplicate.memo) {
          newTrack.memo = duplicate.memo;
        }
        if (currentArtworkBlob) {
          newTrack.artworkBlob = currentArtworkBlob;
        } else if (duplicate && duplicate.artworkBlob) {
          newTrack.artworkBlob = duplicate.artworkBlob;
        }
        if (duplicate && typeof duplicate.order === "number") {
          newTrack.order = duplicate.order;
        }

        await putTrack(newTrack, mp3Blob);

        loadingBar.style.width = "100%";
        loadingStatus.textContent = "再生を開始中…";

        if (typeof onSaved === "function") {
          try {
            onSaved(newTrack);
          } catch (_) {}
        }

        // 5. 即座にライブラリから再生を開始！
        try {
          await setQueueAndPlay([newTrack], 0);
        } catch (playErr) {
          console.warn("[yt] 即時再生開始エラー:", playErr);
        }

        toast(`✅ Google Drive に保存し、「${title}」の再生を開始しました！`, "ok", 4000);
        return true;
      } catch (driveErr) {
        console.error("[yt] Google Drive アップロードエラー:", driveErr);
        toast(`Google Drive 保存に失敗したため、アプリ内ライブラリに直接保存しました (${driveErr.message || "通信エラー"})`, "info", 5000);
        return await saveToLocal({ downloadFile: false });
      }
    } catch (err) {
      stepLoading.style.display = "none";
      stepEditor.style.display = "block";
      toast(`保存エラー: ${err.message}`, "err", 5000);
      return false;
    }
  }
}
