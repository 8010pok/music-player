/**
 * 音量ノーマライズ モーダル
 *
 * - Google Drive 音源・ローカル音源の音量（ラウドネス）を解析・調整
 * - 基準曲に合わせた自動調整、最大音量ノーマライズ、手動ゲイン調整
 * - 調整後音量のリアルタイムプレビュー試聴
 * - Google Drive 上のファイルへの上書き反映オプション
 */

import { openModal, toast, escapeHtml, escapeAttr } from "./components.js";
import { getArtworkUrl } from "./artwork-cache.js";
import { getPublic, setPublic } from "../store/settings.js";
import { getAllTracks, getBlob } from "../store/library-db.js";
import { isDriveConnected } from "../gdrive/drive-service.js";
import {
  analyzeAudioLoudness,
  calculateNormalizeGain,
} from "../audio/mp3-encoder.js";
import {
  getTrackAudioBlob,
  normalizeTrackAudio,
  determineNormalizationStrategy,
} from "../audio/normalize-service.js";
import {
  getAudioElement,
  getMainAudioElement,
  getStreamAudioElement,
} from "../player/audio-engine.js";

/**
 * トラックの音量ノーマライズモーダルを開く
 * @param {object} track 対象トラック
 * @param {object|((updatedTrack: object) => void)} [opts]
 * @param {(updatedTrack: object) => void} [opts.onCompleted] 保存完了時コールバック
 */
export async function openNormalizeModal(track, opts = {}) {
  if (!track || !track.id) return;

  const options = typeof opts === "function" ? { onCompleted: opts } : (opts || {});
  const onCompleted = options.onCompleted || null;

  const container = document.createElement("div");
  container.className = "normalize-modal-container";

  const isGdrive = !!(track.driveFileId || (typeof track.id === "string" && track.id.startsWith("gd-")));
  const artUrl = getArtworkUrl(track);

  container.innerHTML = `
    <style>
      .norm-modal { font-size: 13px; color: var(--fg); }
      .norm-card { background: var(--bg-elev-1); border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid var(--border); }
      .norm-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
      .norm-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: var(--bg-elev-2); color: var(--fg-muted); }
      .norm-badge.accent { background: rgba(0, 113, 227, 0.15); color: var(--accent); }
      .norm-progress-bar-wrap { height: 8px; border-radius: 4px; background: var(--bg-elev-2); overflow: hidden; margin: 8px 0 4px; }
      .norm-progress-bar-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.15s ease; }
    </style>

    <div class="norm-modal">
      <!-- 曲情報ヘッダー -->
      <div class="norm-card" style="display: flex; gap: 12px; align-items: center;">
        <div style="width: 56px; height: 56px; border-radius: 8px; overflow: hidden; background: #222; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
          ${artUrl ? `<img src="${escapeAttr(artUrl)}" style="width: 100%; height: 100%; object-fit: cover;" alt="Artwork" />` : `<span style="font-size: 24px;">🎵</span>`}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px;">
            ${escapeHtml(track.title || "(無題)")}
          </div>
          <div style="font-size: 12px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;">
            ${escapeHtml(track.artist || "不明")} • ${escapeHtml(track.album || "")}
          </div>
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            ${isGdrive ? `<span class="norm-badge" style="background: rgba(52, 168, 83, 0.15); color: #34a853;">☁ Google Drive</span>` : `<span class="norm-badge">📁 ローカル</span>`}
            <span class="norm-badge" id="norm-current-loudness-badge">解析中…</span>
          </div>
        </div>
      </div>

      <!-- 解析ステータス / ローディング -->
      <div id="norm-analyzing-wrap" style="text-align: center; padding: 20px 0;">
        <div style="font-size: 13px; font-weight: 600; color: var(--accent); margin-bottom: 6px;">
          ⏳ 音源の音量を解析しています…
        </div>
        <div style="font-size: 11px; color: var(--fg-muted);">
          音源データを読み込み、RMSラウドネスとピーク音量を計測中
        </div>
      </div>

      <!-- 設定エリア (解析完了後に表示) -->
      <div id="norm-controls-wrap" style="display: none;">
        <!-- 音量モード選択カード -->
        <div class="norm-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 6px;">
              <span>🔊 ノーマライズ方式</span>
              <span class="norm-badge accent" id="norm-gain-badge">+0.0 dB</span>
            </div>
            <select id="norm-mode-select" class="input" style="width: auto; height: 32px; font-weight: 600; padding: 0 8px; border-radius: 6px;">
              <option value="reference" selected>🎯 基準の曲に合わせる (推奨)</option>
              <option value="peak">⚡ 最大音量にノーマライズ (-0.3dB)</option>
              <option value="manual">🎚 手動調整 (ゲインスライダー)</option>
              <option value="none">オフ (元の音量のまま)</option>
            </select>
          </div>

          <!-- 基準曲エリア -->
          <div id="norm-ref-box" style="background: var(--bg-elev-2); border-radius: 8px; padding: 10px; margin-bottom: 10px; border: 1px solid var(--border);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-size: 11px; color: var(--fg-muted);">音量の基準にする曲:</span>
              <button type="button" class="btn" id="btn-norm-change-ref" style="font-size: 11px; padding: 2px 8px;">曲を変更…</button>
            </div>
            <div id="norm-ref-name" style="font-weight: 600; font-size: 12px; margin-bottom: 2px;">
              標準ラウドネス (-14.0 dBFS)
            </div>
            <div id="norm-ref-sub" style="font-size: 11px; color: var(--fg-muted);">
              ライブラリの曲を選ぶと、その曲と同じ音量感に自動調整します
            </div>
          </div>

          <!-- 手動スライダーエリア -->
          <div id="norm-manual-box" style="display: none; background: var(--bg-elev-2); border-radius: 8px; padding: 10px; margin-bottom: 10px; border: 1px solid var(--border);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-size: 11px; color: var(--fg-muted);">手動ゲイン調整:</span>
              <span id="norm-manual-val" style="font-weight: 700; font-size: 12px;">+0.0 dB</span>
            </div>
            <input type="range" id="norm-gain-slider" min="-6" max="14" step="0.5" value="0" style="width: 100%; cursor: pointer;" />
          </div>

          <!-- 調整サマリーメッセージ -->
          <div id="norm-detail-summary" style="font-size: 11px; color: var(--fg-muted); line-height: 1.5; padding: 6px 0;">
            計算中…
          </div>

          <!-- 処理戦略バッジ (非破壊 vs 再エンコード) -->
          <div id="norm-strategy-info" style="margin-top: 6px; padding: 8px; border-radius: 6px; background: var(--bg-elev-2); font-size: 11px; display: flex; align-items: center; justify-content: space-between;">
            <span style="color: var(--fg-muted);">保存方式:</span>
            <span id="norm-strategy-badge" class="norm-badge">自動判定中…</span>
          </div>

          <!-- 試聴プレビューバー -->
          <div style="margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 11px; color: var(--fg-muted);">
              🎧 調整後の音量をその場で試聴:
            </div>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="btn" id="btn-norm-preview-toggle" style="padding: 4px 10px; font-size: 12px; font-weight: 600;">
                ▶ 試聴プレビュー
              </button>
            </div>
          </div>
        </div>

        <!-- Google Drive 反映オプション -->
        ${isGdrive ? `
          <div class="norm-card" style="padding: 10px 14px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
              <input type="checkbox" id="norm-update-drive-cb" checked style="width: 16px; height: 16px; cursor: pointer;" />
              <div>
                <div style="font-weight: 600; font-size: 12px; color: var(--fg);">
                  ☁ Google Drive の音源ファイルも上書き保存する
                </div>
                <div style="font-size: 11px; color: var(--fg-muted);">
                  チェックすると Google Drive 上のファイル自体も更新され、他の端末と同期されます
                </div>
              </div>
            </label>
          </div>
        ` : ""}

        <!-- 進行状況バー (保存時用) -->
        <div id="norm-saving-progress-wrap" style="display: none; margin-top: 12px;">
          <div id="norm-saving-status" style="font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 4px;">
            ノーマライズ変換中…
          </div>
          <div class="norm-progress-bar-wrap">
            <div class="norm-progress-bar-fill" id="norm-saving-bar"></div>
          </div>
        </div>
      </div>

      <!-- 基準曲選択オーバーレイ -->
      <div id="norm-ref-picker-overlay" style="display: none; position: absolute; inset: 0; background: var(--bg-elev-1); z-index: 100; border-radius: 12px; padding: 16px; flex-direction: column; box-shadow: 0 4px 24px rgba(0,0,0,0.3);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h3 style="margin: 0; font-size: 14px; font-weight: 700;">🎯 音量の基準にする曲を選択</h3>
          <button type="button" class="btn" id="btn-norm-close-ref" style="font-size: 11px; padding: 3px 8px;">✕ 閉じる</button>
        </div>
        <div style="font-size: 11px; color: var(--fg-muted); margin-bottom: 10px; line-height: 1.4;">
          ライブラリの曲を選ぶと、その曲の音量を自動計測し、この曲を同じ音量感に引き上げます。
        </div>
        <div style="margin-bottom: 8px; display: flex; gap: 6px;">
          <input type="text" id="norm-ref-search-input" class="input" placeholder="曲名やアーティスト名で検索…" style="flex: 1; height: 32px; font-size: 12px; padding: 0 8px; border-radius: 6px;" />
          <button type="button" class="btn" id="btn-norm-reset-standard" style="font-size: 11px; white-space: nowrap; padding: 0 8px;">標準 (-14dB) に戻す</button>
        </div>
        <div id="norm-ref-list-box" style="flex: 1; overflow-y: auto; max-height: 260px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev-2); padding: 4px;"></div>
      </div>
    </div>
  `;

  let sourceAudioBuffer = null;
  let sourceLoudness = null;
  let currentCalculatedGain = 1.0;
  let previewAudioEl = null;
  let previewAudioCtx = null;
  let previewGainNode = null;
  let isPreviewPlaying = false;

  const mo = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      cleanupPreview();
      mo.disconnect();
    }
  });
  if (typeof document !== "undefined" && document.body) {
    mo.observe(document.body, { childList: true, subtree: true });
  }

  const modal = openModal({
    title: "🔊 音量ノーマライズ (Google Drive / ローカル)",
    body: container,
    actions: [
      {
        label: "キャンセル",
        onClick: () => {
          cleanupPreview();
          return true;
        },
      },
      {
        label: "💾 ノーマライズして保存",
        primary: true,
        id: "btn-norm-execute",
        onClick: async () => {
          return await executeNormalization();
        },
      },
    ],
  });

  const analyzingWrap = container.querySelector("#norm-analyzing-wrap");
  const controlsWrap = container.querySelector("#norm-controls-wrap");
  const currentLoudnessBadge = container.querySelector("#norm-current-loudness-badge");
  const modeSelect = container.querySelector("#norm-mode-select");
  const gainBadge = container.querySelector("#norm-gain-badge");
  const refBox = container.querySelector("#norm-ref-box");
  const refName = container.querySelector("#norm-ref-name");
  const refSub = container.querySelector("#norm-ref-sub");
  const changeRefBtn = container.querySelector("#btn-norm-change-ref");
  const manualBox = container.querySelector("#norm-manual-box");
  const manualVal = container.querySelector("#norm-manual-val");
  const gainSlider = container.querySelector("#norm-gain-slider");
  const detailSummary = container.querySelector("#norm-detail-summary");
  const previewToggleBtn = container.querySelector("#btn-norm-preview-toggle");
  const updateDriveCb = container.querySelector("#norm-update-drive-cb");
  const savingProgressWrap = container.querySelector("#norm-saving-progress-wrap");
  const savingStatus = container.querySelector("#norm-saving-status");
  const savingBar = container.querySelector("#norm-saving-bar");
  const strategyBadge = container.querySelector("#norm-strategy-badge");

  // 基準曲ピッカー要素
  const refOverlay = container.querySelector("#norm-ref-picker-overlay");
  const closeRefBtn = container.querySelector("#btn-norm-close-ref");
  const refSearchInput = container.querySelector("#norm-ref-search-input");
  const resetStandardBtn = container.querySelector("#btn-norm-reset-standard");
  const refListBox = container.querySelector("#norm-ref-list-box");

  function cleanupPreview() {
    if (previewAudioEl) {
      previewAudioEl.pause();
      if (previewAudioEl.src && previewAudioEl.src.startsWith("blob:")) {
        try { URL.revokeObjectURL(previewAudioEl.src); } catch (_) {}
      }
      previewAudioEl = null;
    }
    if (previewAudioCtx) {
      try { previewAudioCtx.close(); } catch (_) {}
      previewAudioCtx = null;
      previewGainNode = null;
    }
    isPreviewPlaying = false;
    if (previewToggleBtn) previewToggleBtn.textContent = "▶ 試聴プレビュー";
  }

  // 試聴プレビュー再生
  async function togglePreview() {
    if (!sourceAudioBuffer) return;

    if (isPreviewPlaying) {
      cleanupPreview();
      return;
    }

    try {
      cleanupPreview();

      // メインプレイヤーが再生中ならプレビュー試聴の邪魔にならないよう一時停止
      const curAudio = getAudioElement();
      if (curAudio && !curAudio.paused) {
        try { curAudio.pause(); } catch (_) {}
      }
      const streamAudio = getStreamAudioElement();
      if (streamAudio && !streamAudio.paused) {
        try { streamAudio.pause(); } catch (_) {}
      }
      const mainAudio = getMainAudioElement();
      if (mainAudio && !mainAudio.paused) {
        try { mainAudio.pause(); } catch (_) {}
      }

      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio API がサポートされていません");
      previewAudioCtx = new AC();

      // モバイル等で suspended の場合は resume する
      if (previewAudioCtx.state === "suspended") {
        await previewAudioCtx.resume();
      }

      // AudioBuffer から BufferSource を作って再生
      const bufferSource = previewAudioCtx.createBufferSource();
      bufferSource.buffer = sourceAudioBuffer;

      previewGainNode = previewAudioCtx.createGain();
      previewGainNode.gain.value = currentCalculatedGain;

      bufferSource.connect(previewGainNode);
      previewGainNode.connect(previewAudioCtx.destination);

      bufferSource.onended = () => {
        if (isPreviewPlaying) {
          cleanupPreview();
        }
      };

      bufferSource.start(0);
      isPreviewPlaying = true;
      if (previewToggleBtn) previewToggleBtn.textContent = "⏹ 停止";
    } catch (e) {
      console.warn("[norm-modal] プレビューエラー:", e);
      toast("プレビュー再生に失敗しました", "err");
      cleanupPreview();
    }
  }

  // 表示更新
  function updateDisplay() {
    if (!sourceLoudness) return;

    const mode = modeSelect.value;
    const pub = getPublic();
    const ref = pub.normalizeReferenceTrack;

    let targetRmsDb = -14.0;
    let refLabel = "標準ラウドネス (-14.0 dBFS)";
    let refDesc = "ライブラリの曲を選ぶと、その曲と同じ音量感に自動調整します";

    if (ref && typeof ref.rmsDb === "number") {
      targetRmsDb = ref.rmsDb;
      refLabel = `「${ref.title}」(${ref.artist || "不明"})`;
      refDesc = `基準曲の音量: ${ref.rmsDb.toFixed(1)} dBFS (Peak: ${ref.peakDb ? ref.peakDb.toFixed(1) : "-"} dBFS)`;
    }

    refName.textContent = refLabel;
    refSub.textContent = refDesc;
    refBox.style.display = mode === "reference" ? "block" : "none";
    manualBox.style.display = mode === "manual" ? "block" : "none";

    const manualGainDb = parseFloat(gainSlider.value) || 0;
    manualVal.textContent = `${manualGainDb >= 0 ? "+" : ""}${manualGainDb.toFixed(1)} dB`;

    const result = calculateNormalizeGain({
      sourceLoudness,
      mode,
      targetRmsDb,
      manualGainDb,
      maxPeakDb: -0.3,
    });

    currentCalculatedGain = result.gain;
    if (previewGainNode) {
      try { previewGainNode.gain.value = currentCalculatedGain; } catch (_) {}
    }

    if (mode === "none") {
      gainBadge.textContent = "オフ (0dB)";
      gainBadge.className = "norm-badge";
      if (strategyBadge) {
        strategyBadge.textContent = "変更なし";
        strategyBadge.className = "norm-badge";
        strategyBadge.style.color = "var(--fg-muted)";
      }
      detailSummary.innerHTML = `音量調整なし (元音源 Peak: <strong>${sourceLoudness.peakDb.toFixed(1)} dBFS</strong>, RMS: <strong>${sourceLoudness.rmsDb.toFixed(1)} dBFS</strong>)`;
    } else {
      const sign = result.gainDb >= 0 ? "+" : "";
      gainBadge.textContent = `${sign}${result.gainDb.toFixed(1)} dB (${result.gain.toFixed(2)}x)`;
      gainBadge.className = "norm-badge accent";

      const strategy = determineNormalizationStrategy({ gainDb: result.gainDb });
      if (strategyBadge) {
        if (strategy === "non-destructive") {
          strategyBadge.textContent = "✨ 非破壊 (音質無劣化・瞬時完了)";
          strategyBadge.className = "norm-badge accent";
          strategyBadge.style.color = "#34a853";
        } else {
          strategyBadge.textContent = "⚡ 高品質再エンコード (MP3 320kbps)";
          strategyBadge.className = "norm-badge accent";
          strategyBadge.style.color = "var(--accent)";
        }
      }

      let modeMsg = "";
      if (mode === "reference") {
        modeMsg = `基準曲 (${targetRmsDb.toFixed(1)} dBFS) に合わせ <strong>${sign}${result.gainDb.toFixed(1)} dB</strong> (${result.gain.toFixed(2)}倍) 調整`;
      } else if (mode === "peak") {
        modeMsg = `ピークを最大音量 (-0.3 dBFS) まで <strong>${sign}${result.gainDb.toFixed(1)} dB</strong> (${result.gain.toFixed(2)}倍) ノーマライズ`;
      } else if (mode === "manual") {
        modeMsg = `手動ゲイン: <strong>${sign}${result.gainDb.toFixed(1)} dB</strong> (${result.gain.toFixed(2)}倍)`;
      }

      let warningMsg = "";
      if (result.limited) {
        warningMsg = `<br/><span style="color: #ff9f0a; font-weight: 600;">⚠️ 音割れ防止のためピーク -0.3dB で安全制限されています</span>`;
      }

      detailSummary.innerHTML = `
        元音源: Peak ${sourceLoudness.peakDb.toFixed(1)} dB / RMS ${sourceLoudness.rmsDb.toFixed(1)} dB<br/>
        👉 ${modeMsg} → 調整後 Peak: <strong>${result.finalPeakDb.toFixed(1)} dB</strong>, RMS: <strong>${result.finalRmsDb.toFixed(1)} dB</strong>${warningMsg}
      `;
    }
  }

  // 基準曲ピッカー
  async function renderRefTrackList(query = "") {
    refListBox.innerHTML = '<div style="padding: 10px; color: var(--fg-muted); text-align: center;">曲リストを読み込み中…</div>';
    try {
      const all = await getAllTracks().catch(() => []);
      const q = query.toLowerCase().trim();
      const filtered = all.filter((t) => {
        if (!q) return true;
        return (t.title && t.title.toLowerCase().includes(q)) ||
               (t.artist && t.artist.toLowerCase().includes(q)) ||
               (t.album && t.album.toLowerCase().includes(q));
      });

      if (filtered.length === 0) {
        refListBox.innerHTML = '<div style="padding: 12px; color: var(--fg-muted); text-align: center;">一致する曲がありません</div>';
        return;
      }

      refListBox.innerHTML = "";
      for (const t of filtered.slice(0, 40)) {
        const item = document.createElement("div");
        item.style.padding = "6px 8px";
        item.style.borderBottom = "1px solid var(--border)";
        item.style.cursor = "pointer";
        item.style.display = "flex";
        item.style.justifyContent = "space-between";
        item.style.alignItems = "center";
        item.style.borderRadius = "6px";
        item.onmouseenter = () => { item.style.background = "var(--bg-elev-3)"; };
        item.onmouseleave = () => { item.style.background = "transparent"; };

        item.innerHTML = `
          <div style="flex: 1; min-width: 0; margin-right: 8px;">
            <div style="font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(t.title || "無題")}</div>
            <div style="font-size: 11px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(t.artist || "不明")}</div>
          </div>
          <button type="button" class="btn" style="font-size: 10px; padding: 2px 6px;">選択</button>
        `;

        item.addEventListener("click", async () => {
          toast("基準曲の音量を解析中…", "info");
          try {
            const blob = await getTrackAudioBlob(t);
            if (!blob) throw new Error("音源データが見つかりませんでした");
            const AC = window.AudioContext || window.webkitAudioContext;
            const ctx = new AC();
            const ab = await blob.arrayBuffer();
            const dec = await ctx.decodeAudioData(ab);
            const loud = analyzeAudioLoudness(dec);
            try { await ctx.close(); } catch (_) {}

            setPublic({
              normalizeReferenceTrack: {
                trackId: t.id,
                title: t.title || "無題",
                artist: t.artist || "不明",
                rmsDb: loud.rmsDb,
                peakDb: loud.peakDb,
              },
            });
            toast(`「${t.title}」を音量の基準曲に設定しました (${loud.rmsDb.toFixed(1)} dBFS)`, "ok");
            refOverlay.style.display = "none";
            updateDisplay();
          } catch (err) {
            toast(`基準曲の解析に失敗しました: ${err.message}`, "err");
          }
        });

        refListBox.appendChild(item);
      }
    } catch (e) {
      refListBox.innerHTML = `<div style="padding: 10px; color: var(--err);">読込エラー: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ノーマライズ実行処理
  async function executeNormalization() {
    cleanupPreview();
    controlsWrap.style.display = "none";
    savingProgressWrap.style.display = "block";

    const executeBtn = document.querySelector(".modal-actions .btn.primary");
    if (executeBtn) executeBtn.disabled = true;

    try {
      const mode = modeSelect.value;
      const manualGainDb = parseFloat(gainSlider.value) || 0;
      const updateDrive = updateDriveCb ? updateDriveCb.checked : false;

      const res = await normalizeTrackAudio(track, {
        mode,
        manualGainDb,
        updateDrive,
        onProgress: ({ percent, statusText }) => {
          savingBar.style.width = `${percent}%`;
          savingStatus.textContent = statusText;
        },
      });

      const strategyText = res.strategy === "non-destructive" ? "非破壊・無劣化" : "再エンコード";
      toast(`✅ 「${track.title || "曲"}」の音量をノーマライズしました (${res.gainDb >= 0 ? "+" : ""}${res.gainDb.toFixed(1)} dB / ${strategyText})`, "ok", 4000);
      if (typeof onCompleted === "function") {
        onCompleted(res.track);
      }
      return true;
    } catch (err) {
      console.error("[norm-modal] ノーマライズ失敗:", err);
      toast(`ノーマライズ失敗: ${err.message}`, "err", 5000);
      controlsWrap.style.display = "block";
      savingProgressWrap.style.display = "none";
      if (executeBtn) executeBtn.disabled = false;
      return false;
    }
  }

  // イベントリスナー設定
  modeSelect.addEventListener("change", updateDisplay);
  gainSlider.addEventListener("input", updateDisplay);
  previewToggleBtn.addEventListener("click", togglePreview);

  changeRefBtn.addEventListener("click", () => {
    refOverlay.style.display = "flex";
    refSearchInput.value = "";
    renderRefTrackList("");
  });
  closeRefBtn.addEventListener("click", () => {
    refOverlay.style.display = "none";
  });
  refSearchInput.addEventListener("input", () => {
    renderRefTrackList(refSearchInput.value);
  });
  resetStandardBtn.addEventListener("click", () => {
    setPublic({ normalizeReferenceTrack: null });
    refOverlay.style.display = "none";
    toast("基準曲を標準ラウドネス (-14.0 dBFS) にリセットしました", "info");
    updateDisplay();
  });

  // 初回解析の非同期実行
  (async () => {
    try {
      const sourceBlob = await getTrackAudioBlob(track);
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio API 非対応");

      const ctx = new AC();
      const ab = await sourceBlob.arrayBuffer();
      sourceAudioBuffer = await ctx.decodeAudioData(ab);
      sourceLoudness = analyzeAudioLoudness(sourceAudioBuffer);
      try { await ctx.close(); } catch (_) {}

      currentLoudnessBadge.textContent = `RMS: ${sourceLoudness.rmsDb.toFixed(1)} dB / Peak: ${sourceLoudness.peakDb.toFixed(1)} dB`;
      analyzingWrap.style.display = "none";
      controlsWrap.style.display = "block";
      updateDisplay();
    } catch (e) {
      console.error("[norm-modal] 音源解析エラー:", e);
      analyzingWrap.innerHTML = `
        <div style="color: var(--err); font-weight: 600; margin-bottom: 6px;">
          ✕ 音源データの読み込み・解析に失敗しました
        </div>
        <div style="font-size: 11px; color: var(--fg-muted);">
          ${escapeHtml(e.message)}
        </div>
      `;
    }
  })();
}
