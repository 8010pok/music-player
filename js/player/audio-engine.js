/**
 * 音声再生エンジン
 *
 * === 設計原則（最重要） ===
 * iOS のロック画面 / バックグラウンド再生を維持するため、
 *   - 音声経路は <audio> 要素を直接スピーカに接続するルートのみ
 *   - AudioContext を音声経路に挟まない（EQ ON 時を除く）
 *   - 解析（スペクトラム / RMS / Peak）は decodeAudioData による
 *     別系統の PCM を currentTime で同期参照する
 *
 * EQ など AudioContext 経由になる機能は enableAudioEffects=true 時のみ
 * 有効化される。設定画面で警告つきで切替可能だが、iOS 端末ではデフォルト
 * オフ（バックグラウンド再生が止まるため）。
 *
 * === iOS ロック画面の挙動対策 ===
 * - MediaSession の play / pause action は「discrete」ハンドラ（toggle しない）
 * - 「ユーザが明示的に pause した」フラグを保持し、visibilitychange での
 *   自動 resume を抑止する
 * - 「currentTrack なしで再生」要求が来たら自動的に先頭曲を再生する
 *   （統合前 mp3player の挙動を踏襲）
 */

import { appState } from "../state.js";
import { getBlob, getTrack, getMemoryBlob, hasCachedBlob, cacheDriveTrackInBackground, isSuspectPartialHeaderDuration, recordHistory, updateTrack, getAllTracks } from "../store/library-db.js";
import {
  applyEffectsSetting,
  applyEqGains,
  applyPreamp,
  applyBassBoost,
  applyCompressor,
  applyPan,
  applyMidSide,
  applyNoiseReduction,
  applyKeyShift,
  resetPitchShifter,
  getCurrentKeyShift,
  setAudioOutputDevice,
  resumeEqContext,
  getOutputRms,
  recreateAudioContext,
} from "./eq.js";
import { getPublic, setPublic } from "../store/settings.js";
// アートワーク URL は UI と共通の「ID 単位で安定なキャッシュ」を使う。
// 毎回 createObjectURL / revokeObjectURL を繰り返すと、iOS の
// 背景フェッチ（ロック画面メタデータ反映）と競合し、リピートで同じ曲に
// 戻ったときに lockscreen のアートワーク画像が空白になる事象を起こす。
import { getArtworkUrl, releaseArtwork } from "../ui/artwork-cache.js";
// 再生エラー時のスキップ通知。components.js は UI レイヤだが、
// ユーザに「読み込めない曲をスキップした」ことを知らせるために最小依存で使う。
import { toast } from "../ui/components.js";
import {
  getDriveToken,
  getDriveStreamUrl,
  promptDriveReconnectModal,
  isDriveTrack,
  getDriveFileId,
} from "../gdrive/drive-service.js";

const UNCACHED_STREAM_TOAST_KEY = "music_player_uncached_fast_stream_notified";
function notifyUncachedFastStreamOnce() {
  try {
    if (typeof sessionStorage !== "undefined") {
      if (sessionStorage.getItem(UNCACHED_STREAM_TOAST_KEY)) return;
      sessionStorage.setItem(UNCACHED_STREAM_TOAST_KEY, "1");
    }
  } catch {}
  try {
    toast("未キャッシュ曲のため高速再生中です。EQ・キー変更は次回再生から適用されます。", "info", 4000);
  } catch {}
}

let activeBackgroundCacheController = null;
let activeBackgroundCacheTrackId = null;

function abortActiveBackgroundCache() {
  if (activeBackgroundCacheController) {
    try { activeBackgroundCacheController.abort(); } catch {}
    activeBackgroundCacheController = null;
    activeBackgroundCacheTrackId = null;
  }
}

function startBackgroundDriveCache(trackId, t0) {
  if (!trackId || typeof trackId !== "string" || !trackId.startsWith("gd-")) return;
  if (activeBackgroundCacheTrackId === trackId) return;
  activeBackgroundCacheTrackId = trackId;
  const controller = new AbortController();
  activeBackgroundCacheController = controller;
  logPerfMark(trackId, "background_cache_started", t0);

  cacheDriveTrackInBackground(trackId, { signal: controller.signal })
    .then(() => {
      if (!controller.signal.aborted) {
        logPerfMark(trackId, "background_cache_completed", t0);
        // ★ 重要: 再生中の audioEl.src は絶対に途中で Blob URL に差し替えない！
        // 音途切れ・位置飛び・Last.fm二重送信・ギャップレス破損を防止。
        // 次回再生時から自動的に IndexedDB キャッシュ (Blob URL) が使われる。
      }
    })
    .catch((e) => {
      if (e?.name !== "AbortError") {
        console.warn("[audio-engine] バックグラウンドDriveキャッシュエラー:", e);
      }
    })
    .finally(() => {
      if (activeBackgroundCacheController === controller) {
        activeBackgroundCacheController = null;
        activeBackgroundCacheTrackId = null;
      }
    });
}

let mainAudioEl = typeof document !== "undefined" ? document.getElementById("audio-el") : null;
if (!mainAudioEl && typeof document !== "undefined") {
  // index.html の <audio id="audio-el"> は iOS バックグラウンド再生の生命線で
  // あり、これが無い場合は他の全機能が動かない。警告ではなく throw して
  // 起動シーケンス全体を中断し、ユーザに明示的に異常を伝える。
  // (app.js の main().catch() で起動失敗トーストが表示される)
  throw new Error("audio-el 要素が DOM に存在しません。index.html を確認してください。");
}

let streamAudioEl = typeof document !== "undefined" ? document.getElementById("stream-audio-el") : null;
if (!streamAudioEl && typeof document !== "undefined" && typeof document.createElement === "function") {
  try {
    streamAudioEl = document.createElement("audio");
    streamAudioEl.id = "stream-audio-el";
    streamAudioEl.preload = "metadata";
    streamAudioEl.setAttribute("playsinline", "");
    if (document.body) {
      document.body.appendChild(streamAudioEl);
    }
  } catch {}
}

let activeAudioEl = mainAudioEl;
let audioEl = activeAudioEl;

let pendingPlaybackState = null;

export function getPendingPlayback() {
  return pendingPlaybackState ? { ...pendingPlaybackState } : null;
}

export function clearPendingPlayback() {
  pendingPlaybackState = null;
}

export function setPendingPlayback(track, queue = [], queueIndex = -1, originalRoute = null) {
  pendingPlaybackState = {
    pendingTrackId: track?.id || null,
    pendingQueue: (queue || []).map((t) => (typeof t === "string" ? t : t?.id || null)).filter(Boolean),
    pendingQueueIndex: queueIndex,
    originalRoute: originalRoute || (typeof window !== "undefined" ? window.location.hash : ""),
    retryOnAuthSuccess: true,
  };
}

let sessionCounter = 0;

/**
 * 1回の再生セッション（曲の決定から再生・終了まで）のライフサイクルを一元追跡するクラス
 */
export class PlaybackSession {
  constructor({ track, queueIndex, startTime = 0 }) {
    this.sessionId = `sess-${Date.now()}-${++sessionCounter}`;
    this.playAttemptId = `att-${Date.now()}-${++playAttemptCounter}`;
    this.track = track;
    this.trackId = track?.id || null;
    this.queueIndex = queueIndex;
    this.startTime = startTime;
    this.activeElement = null; // mainAudioEl or streamAudioEl
    this.sourceType = "none";  // "memory_blob", "prewarm_cache", "cached_blob", "drive_stream", "direct_url"
    this.isDrive = isDriveTrack(track);
    this.isCached = false;
    this.requestedKeyShift = (track && typeof track.keyShift === "number" && !isNaN(track.keyShift)) ? track.keyShift : 0;
    this.appliedKeyShift = 0;
    this.playbackStatus = "loading";
    this.startedAt = Date.now();
    this.playingAt = 0;
    this.endedHandled = false;
    this.nextTransitionStarted = false;
    this.abortController = new AbortController();
    this.bgCacheController = null;
    this.watchdogId = null;
    this.silenceCheckTimer = null;
    this.hasRecoveredSilence = false;
    this.objectUrl = null;
    this.isStale = false;
  }

  destroy() {
    this.isStale = true;
    if (this.watchdogId) {
      clearTimeout(this.watchdogId);
      this.watchdogId = null;
    }
    if (this.silenceCheckTimer) {
      clearTimeout(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
    if (this.abortController) {
      try { this.abortController.abort(); } catch {}
    }
    if (this.bgCacheController) {
      try { this.bgCacheController.abort(); } catch {}
    }
    if (this.objectUrl && this.objectUrl.startsWith("blob:")) {
      try { URL.revokeObjectURL(this.objectUrl); } catch {}
      this.objectUrl = null;
    }
  }
}

let activePlaybackSession = null;

export function getCurrentPlaybackSession() {
  return activePlaybackSession;
}

/**
 * 新しいセッションを開始し、前セッションのタイマーや非同期処理、ピッチシフター状態を完全に破棄する
 */
export function beginPlaybackSession(track, queueIndex, startTime = 0) {
  if (activePlaybackSession) {
    activePlaybackSession.destroy();
  }
  // ★ 前曲のピッチシフター（バッファ・半音値）を必ず即時リセット
  try { resetPitchShifter(); } catch {}

  activePlaybackSession = new PlaybackSession({ track, queueIndex, startTime });
  state.currentPlayAttemptId = activePlaybackSession.playAttemptId;
  state.currentPlayAttemptStartTime = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
  return activePlaybackSession;
}

export function getMainAudioElement() { return mainAudioEl; }
export function getStreamAudioElement() { return streamAudioEl; }

/**
 * アクティブな再生要素を切り替え、待機側要素を確実に停止・消音する（排他制御）
 * @param {HTMLAudioElement} targetEl
 * @returns {HTMLAudioElement}
 */
function setActiveAudioElement(targetEl) {
  if (!targetEl) targetEl = mainAudioEl;
  if (targetEl !== mainAudioEl && targetEl !== streamAudioEl) {
    targetEl = mainAudioEl;
  }
  const standbyEl = targetEl === mainAudioEl ? streamAudioEl : mainAudioEl;
  if (standbyEl) {
    try { standbyEl.pause(); } catch {}
    try { standbyEl.removeAttribute("src"); } catch {}
    try { standbyEl.currentTime = 0; } catch {}
    try { standbyEl.load(); } catch {} // 待機側要素のネットワーク通信・デコーダを確実に中止
  }
  activeAudioEl = targetEl;
  audioEl = activeAudioEl;
  return activeAudioEl;
}

/**
 * 相対URLやパスを完全修飾絶対URLに変換する（iOS MediaSession / ロック画面用）
 * @param {string} url
 * @returns {string}
 */
export function toAbsoluteUrl(url) {
  if (!url || typeof url !== "string") return "";
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (typeof window !== "undefined" && window.location) {
    try {
      return new URL(url, window.location.href).href;
    } catch (_) {}
  }
  return url;
}

/**
 * 再生パフォーマンス計測 & 再生イベント詳細ログ用ヘルパー
 */
function isPerfDebugEnabled() {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("debug_audio_perf") === "true") {
      return true;
    }
  } catch (_) {}
  return false;
}

let playAttemptCounter = 0;

/**
 * 再生イベントの詳細ログを記録（セキュリティ配慮: トークン・フルURL等は一切出力しない）
 */
function logPlaybackEvent(event, { targetEl = activeAudioEl, track = null, attemptId = null, error = null, playPromiseResult = null, extra = null } = {}) {
  // ★ パフォーマンス最優先: デバッグフラグ (debug_audio_perf) が false かつエラーでなければ即時リターンし、
  //   毎フレーム・毎秒の大量イベント (timeupdate/progress 等) によるオブジェクト生成・文字列フォーマット負荷を完全根絶
  if (!error && !isPerfDebugEnabled()) return;

  const currentAttemptId = attemptId || state.currentPlayAttemptId || "none";
  const curTrack = track || appState.get().currentTrack;
  const trackId = curTrack?.id || "none";
  const element = targetEl === streamAudioEl ? "streamAudioEl" : (targetEl === mainAudioEl ? "mainAudioEl" : "unknown");
  const elapsedMs = state.currentPlayAttemptStartTime ? (performance.now() - state.currentPlayAttemptStartTime).toFixed(1) : "0.0";
  const readyState = targetEl?.readyState ?? -1;
  const networkState = targetEl?.networkState ?? -1;
  const paused = targetEl?.paused ?? true;
  const hasSrc = !!(targetEl?.src);
  let srcType = "none";
  if (hasSrc) {
    if (targetEl.src.startsWith("blob:")) srcType = "blob_url";
    else if (targetEl.src.startsWith("data:")) srcType = "data_url";
    else if (targetEl.src.includes("googleapis.com")) srcType = "drive_stream";
    else srcType = "other_url";
  }
  const isCached = !trackId ? false : (!trackId.startsWith("gd-") || (state.isDirectStream === false));
  let tokenExpiryState = "not_drive";
  if (trackId && typeof trackId === "string" && trackId.startsWith("gd-")) {
    tokenExpiryState = "checked";
  }
  const errorStr = error ? (error.name ? `${error.name}: ${error.message || ""}` : String(error)) : null;

  if (isPerfDebugEnabled() || error) {
    console.log(
      `[AudioPlayback] [${event}] attempt=${currentAttemptId} track=${trackId} el=${element} +${elapsedMs}ms ` +
      `ready=${readyState} net=${networkState} paused=${paused} hasSrc=${hasSrc} src=${srcType} ` +
      `cached=${isCached} tokenState=${tokenExpiryState}` +
      (errorStr ? ` err=${errorStr}` : "") +
      (playPromiseResult ? ` promise=${playPromiseResult}` : "") +
      (extra ? ` extra=${JSON.stringify(extra)}` : "")
    );
  }
}

function logPerfMark(trackId, markName, startTime) {
  if (!isPerfDebugEnabled()) return;
  const elapsed = (performance.now() - startTime).toFixed(1);
  console.log(`[AudioPerf] [${trackId}] ${markName}: +${elapsed}ms`);
}

// primeAudioElement の play() プロミス追跡用（AbortError 防止）
let primePromise = null;

// 内部状態
const state = {
  userVolume: 1.0,        // ユーザー設定音量 (0.0〜1.0)
  currentObjectUrl: null,
  isDirectStream: false,  // 現在再生中の URL が Google Drive HTTP Range などのストリーミング URL かどうか
  streamFallbackInProgress: false, // ストリーミング失敗時の Blob ダウンロードフォールバック処理中フラグ
  currentPlayAttemptId: null,      // 現在の再生試行固有ID (stale イベント・競合防止)
  currentPlayAttemptStartTime: 0,  // 現在の再生試行開始 timestamp (performance.now())
  playAttemptRetryCount: 0,        // 現在の再生試行のタイムアウト再試行回数 (最大1回)
  playingWatchdogTimer: null,      // play() 後の playing 未到達監視タイマー (10秒)
  // ※ artwork URL は artwork-cache モジュールが ID 単位で管理する。
  //   ここで個別に保持・revoke すると iOS ロック画面と競合するため持たない。
  sessionStartedAt: 0,
  sessionPlayed: 0,
  lastTickAt: 0,
  queue: [],
  queueIndex: -1,
  origQueue: null,
  onScrobble: null,
  onNowPlaying: null,
  // 再生セッション固有ID（べき等キー）と二重Scrobble防止用同期フラグ
  playSessionId: null,
  hasScrobbledSession: false,
  // 「ユーザが明示的に pause した」フラグ。
  // visibility 復帰時の自動 resume 抑止に使う
  userPausedExplicitly: false,
  // mediaSession.setPositionState スロットリング用
  lastPositionUpdateAt: 0,
  // 再開ウォッチドッグのタイマ ID。
  // リモート(ロック画面/イヤホン)やアプリ内の「再開」で play() を要求した後、
  // 実際に再生が進んだかを 1 秒後に確認し、進んでいなければ自動で再試行する。
  // (iOS コールドスタート時の「1 回目の再開だけ失敗する」既知挙動への対策)
  resumeWatchdogTimer: null,
  // 「loadAndPlay / playPreloadedSync の最中」フラグ。
  // 遷移中に発火する pause/timeupdate 由来の setPositionState や
  // playbackState="paused" の誤通知 (iOS 無音化原因) を抑止する。
  transitioning: false,
  // transitioning の世代トークン。曲遷移が短時間に複数回起きたとき
  // (ロック画面「次へ」連打 / ended と「次へ」がほぼ同時 など)、古い遷移の
  // play promise 解決やタイムアウトが「新しい遷移の最中」に transitioning を
  // false へ戻してしまうと、その隙に遅延 pause が playbackState="paused" を
  // iOS に送り 2 曲目以降が無音になる。各遷移は自分のトークンを保持し、
  // 自分が最新世代のときだけ transitioning を解除する。
  transitionToken: 0,
  // 連続スキップ回数。読み込めない・再生できない曲が現れた場合、
  // 自動的に次の曲に進む（プレイリスト・シャッフル再生中に 1 曲のロード失敗で
  // 全体が停止しないように）。
  // ただし全曲読み込めない異常状態で無限ループしないよう、上限で停止する。
  consecutiveSkips: 0,

  // === 次曲プリロード（iOS バックグラウンド自動遷移の生命線） ===
  //   現在の曲が再生開始したら、すぐに「次に再生される曲」の blob を取得して
  //   object URL を作り、ここに保持しておく。
  //   ended で次曲へ移る際、await getBlob() / await waitForLoadedMetadata() を
  //   経由せず、同期的に audioEl.src = preloadUrl → audioEl.play() できる。
  //   これにより iOS Safari が「音声停止 → JS suspend / audio session 解放」を
  //   行う前に次曲の再生を開始でき、画面オフのまま確実に次曲へ切り替わる。
  preloadTrackId: null,   // プリロード済みトラックの id
  preloadUrl: null,       // プリロード済み object URL（未使用なら revoke 対象）
  preloadToken: 0,        // プリロード要求の世代カウンタ（in-flight の stale 破棄用）
  preloadingId: null,     // 現在 getBlob 取得中のトラック id（二重取得防止）
  lastSessionSaveAt: 0,   // 再生セッション状態の localStorage 自動保存スロットリング用
};

// スリープタイマー管理 (オフ / 15分 / 30分 / 60分 / 曲終了時)
let sleepTimerId = null;
let sleepTimerTargetTime = 0;
let sleepTimerMode = "off";

// Pre-warm（先行事前取得）インメモリキャッシュ (最大30曲のLRU)
const prewarmCache = new Map();
const MAX_PREWARM_ENTRIES = 30;

function trimPrewarmCache() {
  while (prewarmCache.size > MAX_PREWARM_ENTRIES) {
    const oldestKey = prewarmCache.keys().next().value;
    const e = prewarmCache.get(oldestKey);
    if (e && e.objectUrl) {
      if (e.objectUrl !== state.currentObjectUrl && e.objectUrl !== state.preloadUrl) {
        try { URL.revokeObjectURL(e.objectUrl); } catch {}
      }
    }
    prewarmCache.delete(oldestKey);
  }
}

/**
 * ユーザーが曲をタップ（pointerdown / touchstart）した瞬間に
 * 先行して Blob 取得 / Object URL 生成を開始する
 * @param {string} trackId
 * @param {{ onlyIfCached?: boolean }} [options]
 */
export function prewarmTrack(trackId, { onlyIfCached = false } = {}) {
  if (!trackId || prewarmCache.has(trackId)) return;
  const entry = {
    promise: null,
    objectUrl: null,
    isStream: false,
    createdAt: Date.now(),
  };

  entry.promise = (async () => {
    try {
      const isDrive = typeof trackId === "string" && trackId.startsWith("gd-");

      // 1. インメモリ Blob キャッシュにある場合は 0ms で即座に Object URL を生成
      const memBlob = getMemoryBlob(trackId);
      if (memBlob) {
        const url = URL.createObjectURL(memBlob);
        entry.objectUrl = url;
        entry.isStream = false;
        return url;
      }

      // 2. Google Drive 曲の事前準備
      if (isDrive) {
        const cached = await hasCachedBlob(trackId);
        if (!cached) {
          // 未キャッシュでも、EQ 無効時はダイレクトストリーム URL を事前生成して即時再生可能にする
          if (!getPublic().enableAudioEffects) {
            try {
              const { getDriveToken, getDriveStreamUrl } = await import("../gdrive/drive-service.js");
              const token = await getDriveToken();
              if (token) {
                const streamUrl = await getDriveStreamUrl(trackId, token);
                if (streamUrl) {
                  entry.objectUrl = streamUrl;
                  entry.isStream = true;
                  return streamUrl;
                }
              }
            } catch (_) {}
          }
          if (onlyIfCached) {
            prewarmCache.delete(trackId);
            return null;
          }
        }
      }

      const blob = await getBlob(trackId);
      if (!blob) {
        prewarmCache.delete(trackId);
        return null;
      }
      const url = URL.createObjectURL(blob);
      entry.objectUrl = url;
      return url;
    } catch (e) {
      prewarmCache.delete(trackId);
      console.warn("[audio-engine] prewarm 失敗", trackId, e);
      return null;
    }
  })();

  prewarmCache.set(trackId, entry);
  trimPrewarmCache();
}

/**
 * 複数トラックの音源を先行プリウォーム（画面表示時の即時再生用）
 * - すでにローカル（IndexedDB）にキャッシュされている曲（最大3〜5曲まで）のみを対象とし、
 *   未キャッシュのGoogle Drive曲を勝手にバックグラウンド通信でフェッチしない
 * @param {Array<string>} trackIds
 * @param {number} [limit=5]
 */
export function prewarmTracks(trackIds, limit = 5) {
  if (!Array.isArray(trackIds)) return;
  const max = Math.min(Math.max(1, limit), 5);
  const targets = trackIds.slice(0, max);
  for (const id of targets) {
    if (id) prewarmTrack(id, { onlyIfCached: true });
  }
}

// 連続スキップで停止する閾値。これ以上連続でスキップしたら、無限ループの
// 可能性があると判断して停止し、ユーザに通知する。
const MAX_CONSECUTIVE_SKIPS = 5;

// イベントリスナー二重登録防止のための WeakSet
const attachedAudioElements = new WeakSet();
let audioEngineInitialized = false;

// === 再生安定化ウォッチドッグ (iOS / モバイル ストール・バッファ待ちからの自動復旧) ===
let stallRecoveryTimer = null;
const onStallOrWaiting = (target) => {
  if (target !== getAudioElement()) return;
  if (state.userPausedExplicitly || !appState.get().isPlaying || state.transitioning) return;
  if (stallRecoveryTimer) clearTimeout(stallRecoveryTimer);
  stallRecoveryTimer = setTimeout(() => {
    if (state.userPausedExplicitly || !appState.get().isPlaying || state.transitioning) return;
    const curEl = getAudioElement();
    if (curEl && curEl.paused && curEl.readyState >= 2) {
      console.warn("[audio-engine] ストール状態から再生を自動復帰します");
      curEl.play().catch((err) => console.warn("[audio-engine] ストール復帰失敗", err));
    }
  }, 2500);
};

function clearPlayingWatchdog() {
  if (state.playingWatchdogTimer) {
    clearTimeout(state.playingWatchdogTimer);
    state.playingWatchdogTimer = null;
  }
}

/**
 * 再生失敗の最終処理（勝手に次曲へスキップせず、ユーザーへ分かりやすく通知して停止）
 */
function handlePlaybackFinalFailure(attemptId, track, error) {
  clearPlayingWatchdog();
  if (attemptId && attemptId !== state.currentPlayAttemptId) return;
  state.transitioning = false;
  appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "error" });
  if (navigator.mediaSession) {
    try { navigator.mediaSession.playbackState = "none"; } catch {}
  }
  const curEl = getAudioElement();
  try { curEl.pause(); } catch {}

  let userMsg = "再生を開始できませんでした。もう一度お試しください";
  const errStr = error ? (error.message || String(error)) : "";
  if (/401|403|トークン|期限|接続/.test(errStr) || error?.name === "NetworkError") {
    userMsg = "Google Driveとの接続が切れています。再接続をお試しください";
  } else if (error?.name === "NotSupportedError" || /codec|decode|support/.test(errStr)) {
    userMsg = "この音源をブラウザで再生できませんでした";
  }
  try { toast(userMsg, "err", 5000); } catch {}
}

/**
 * play() 呼び出し後の playing 未到達監視タイマー (10秒)
 * 10秒以内に音が鳴らない場合、最大1回だけ安全な再試行を実行
 */
function startPlayingWatchdog(attemptId, track, startTime, isDirectStream) {
  clearPlayingWatchdog();
  state.playingWatchdogTimer = setTimeout(async () => {
    if (attemptId !== state.currentPlayAttemptId) return;
    if (state.userPausedExplicitly || appState.get().playbackStatus === "playing") return;

    // ★ playing 直前ガード: 要素がすでにデータを受信している (readyState >= 2)
    // または再生移行中 (!curEl.paused) の場合、playing 直前に強制解除して切断しない
    const curEl = getAudioElement();
    if (curEl && (!curEl.paused || curEl.readyState >= 2)) {
      return;
    }

    logPlaybackEvent("playing_timeout", { track, attemptId, error: new Error("10s watchdog timeout") });

    if (state.playAttemptRetryCount < 1) {
      state.playAttemptRetryCount++;
      console.warn(`[audio-engine] 10秒間 playing が発生しなかったため、安全な再試行を実行します (試行 ${state.playAttemptRetryCount}/1):`, track?.id);

      const newAttemptId = `att-${Date.now()}-${++playAttemptCounter}`;
      state.currentPlayAttemptId = newAttemptId;

      const curEl = getAudioElement();
      try { curEl.pause(); } catch {}
      try { curEl.removeAttribute("src"); } catch {}
      try { curEl.load(); } catch {}

      let retryUrl = null;
      if (isDirectStream && track?.id) {
        try {
          const token = await getDriveToken();
          if (token) {
            retryUrl = await getDriveStreamUrl(track.id, token);
          }
        } catch (_) {}
      } else if (track?.id) {
        try {
          const b = await getBlob(track.id);
          if (b) retryUrl = URL.createObjectURL(b);
        } catch (_) {}
      }

      if (retryUrl && newAttemptId === state.currentPlayAttemptId && !state.userPausedExplicitly) {
        state.currentObjectUrl = retryUrl;
        curEl.src = retryUrl;
        try { curEl.load(); } catch {}
        if (startTime > 0) {
          try { curEl.currentTime = startTime; } catch {}
        }
        startPlayingWatchdog(newAttemptId, track, startTime, isDirectStream);
        try {
          const p = curEl.play();
          if (p && typeof p.then === "function") {
            p.catch((retryErr) => {
              console.warn("[audio-engine] 再試行 play 失敗:", retryErr);
              handlePlaybackFinalFailure(newAttemptId, track, retryErr);
            });
          }
        } catch (retryErr) {
          console.warn("[audio-engine] 再試行 play 例外:", retryErr);
          handlePlaybackFinalFailure(newAttemptId, track, retryErr);
        }
        return;
      }
    }

    handlePlaybackFinalFailure(attemptId, track, new Error("Playback failed to start within timeout"));
  }, 10000);
}

/**
 * デュアル <audio> 用イベントリスナー登録
 * - WeakSet により同一要素への二重登録を完全防止
 * - スタンバイ要素の遅延イベントがアクティブ要素の再生状態を汚染しないよう厳密にガード
 * @param {HTMLAudioElement} el
 */
export function attachElementListeners(el) {
  if (!el || attachedAudioElements.has(el)) return;
  attachedAudioElements.add(el);

  // 非アクティブ要素から遅れて届いたイベントが現在の状態を上書きしないようガード
  const isFromActive = (e) => (e.currentTarget === getAudioElement() || (!e.currentTarget && e.target === getAudioElement()));

  el.addEventListener("loadstart", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("loadstart", { targetEl: e.currentTarget || el });
  });

  el.addEventListener("loadeddata", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("loadeddata", { targetEl: e.currentTarget || el });
  });

  el.addEventListener("play", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("play", { targetEl: e.currentTarget || el });
    onPlay(e);
  });

  el.addEventListener("playing", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("playing", { targetEl: e.currentTarget || el });
    clearPlayingWatchdog();
    if (stallRecoveryTimer) {
      clearTimeout(stallRecoveryTimer);
      stallRecoveryTimer = null;
    }
    onPlaying();
  });

  el.addEventListener("pause", (e) => {
    logPlaybackEvent("pause", { targetEl: e.currentTarget || el });
    if (!isFromActive(e)) return;
    onPause(e);
  });

  el.addEventListener("timeupdate", (e) => {
    if (!isFromActive(e)) return;
    onTimeUpdate(e);
  });

  const syncRealAudioDuration = (e) => {
    if (!isFromActive(e)) return;
    const curAudio = getAudioElement();
    if (state.transitioning || (curAudio?.src && curAudio.src.startsWith("data:audio/wav"))) return;
    const d = curAudio?.duration;
    if (isFinite(d) && d > 0.5) {
      appState.set({ duration: d });
      const cur = appState.get().currentTrack;
      // DB 上の duration が未設定、または 1.5MB ヘッダ由来の 0:39 (39秒) 等で実測値とズレている場合は即座に修正・永続化
      if (cur && cur.id && (!cur.duration || isSuspectPartialHeaderDuration(cur) || Math.abs(cur.duration - d) > 1.5)) {
        cur.duration = d;
        updateTrack(cur.id, { duration: d }).catch(() => {});
        updateMediaPositionState({ duration: d });
      }
    }
  };

  el.addEventListener("loadedmetadata", (e) => {
    logPlaybackEvent("loadedmetadata", { targetEl: e.currentTarget || el });
    syncRealAudioDuration(e);
  });

  el.addEventListener("durationchange", (e) => {
    logPlaybackEvent("durationchange", { targetEl: e.currentTarget || el });
    syncRealAudioDuration(e);
  });

  el.addEventListener("canplay", (e) => {
    logPlaybackEvent("canplay", { targetEl: e.currentTarget || el });
    if (!isFromActive(e)) return;
    const cur = appState.get().currentTrack;
    if (cur && cur.id) {
      logPerfMark(cur.id, "canplay", state.currentPlayAttemptStartTime);
    }
  });

  el.addEventListener("canplaythrough", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("canplaythrough", { targetEl: e.currentTarget || el });
  });

  el.addEventListener("ratechange", (e) => {
    if (!isFromActive(e)) return;
    const curAudio = getAudioElement();
    if (curAudio && isFinite(curAudio.playbackRate)) {
      appState.set({ playbackRate: curAudio.playbackRate });
    }
  });

  el.addEventListener("volumechange", (e) => {
    if (!isFromActive(e)) return;
    const curAudio = getAudioElement();
    if (curAudio && isFinite(curAudio.volume)) {
      state.userVolume = clampVolume(curAudio.volume);
    }
  });

  el.addEventListener("waiting", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("waiting", { targetEl: e.currentTarget || el });
    onStallOrWaiting(e.currentTarget || e.target);
  });

  el.addEventListener("stalled", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("stalled", { targetEl: e.currentTarget || el });
    onStallOrWaiting(e.currentTarget || e.target);
  });

  el.addEventListener("suspend", (e) => {
    if (!isFromActive(e)) return;
    logPlaybackEvent("suspend", { targetEl: e.currentTarget || el });
  });

  el.addEventListener("ended", (e) => {
    logPlaybackEvent("ended", { targetEl: e.currentTarget || el });
    if (!isFromActive(e)) return;
    onEnded(e);
  });

  el.addEventListener("error", async (e) => {
    const curAudio = e.currentTarget || el;
    logPlaybackEvent("error", { targetEl: curAudio, error: curAudio?.error });
    if (!isFromActive(e)) return;
    clearPlayingWatchdog();
    const cur = appState.get().currentTrack;
    console.warn("[audio-engine] audio error", e, curAudio?.error);

    handlePlaybackFinalFailure(state.currentPlayAttemptId, cur, curAudio?.error || new Error("HTMLAudioElement error event"));
  });
}

/**
 * 初期化（一度だけ呼ぶ）
 */
export function initAudioEngine({ onNowPlaying, onScrobble } = {}) {
  state.onNowPlaying = onNowPlaying || state.onNowPlaying || null;
  state.onScrobble = onScrobble || state.onScrobble || null;

  if (!audioEngineInitialized) {
    audioEngineInitialized = true;
    setupAudioSession();
    setupMediaSession();
    setupVisibilityGuard();
    setupTerminationCleanup();

    // ★ IndexedDB のトラック更新・端末間同期完了時に、現在曲・キュー・ミニプレイヤー・ロック画面へ即時反映
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("music-player:track-updated", (e) => {
        const detail = e?.detail;
        if (detail && detail.track) {
          applyUpdatedTrackToPlayer(detail.track, detail.patch);
        }
      });
      window.addEventListener("music-player:library-synced", () => {
        refreshPlayerMetadataFromDb().catch(() => {});
      });
    }
  }

  attachElementListeners(mainAudioEl);
  attachElementListeners(streamAudioEl);

  state.userVolume = clampVolume(mainAudioEl?.volume ?? 1.0);
  if (mainAudioEl) applyTrackVolume(mainAudioEl);
  if (streamAudioEl) streamAudioEl.volume = state.userVolume;

  // 起動時に EQ 設定（有効化時のみ初期化）と保存済みエフェクトを全て反映
  const pub = getPublic();
  if (pub.enableAudioEffects && mainAudioEl) {
    applyEffectsSetting(mainAudioEl, true);
    applyEqGains(pub.eqGains || {});
    applyPreamp(pub.preamp || 0);
    applyBassBoost(pub.bassBoost || 0);
    applyCompressor(pub.compressor || "off");
    applyPan(pub.pan || 0);
    applyMidSide({
      stereoWidth: pub.stereoWidth ?? 1,
      vocalRemove: pub.vocalRemove || 0,
      mono: !!pub.mono,
    });
    applyNoiseReduction(pub.noiseReduction || "off");
  }

  // 出力デバイス選択 (Androidのみ対応、iOSでは何もしない)
  if (pub.audioOutputDeviceId) {
    if (mainAudioEl) {
      setAudioOutputDevice(mainAudioEl, pub.audioOutputDeviceId).catch((e) => {
        // 失敗時は端末既定の出力に fallback。診断のためログのみ残す
        console.warn("[audio-engine] mainAudioEl 出力デバイス設定失敗", e);
      });
    }
    if (streamAudioEl) {
      setAudioOutputDevice(streamAudioEl, pub.audioOutputDeviceId).catch(() => {});
    }
  }

  // 再生速度・ピッチ維持 (audio要素プロパティのみ、AudioContext 不要)
  // ← これは iPhone ロック画面・バックグラウンド再生に影響しない安全な機能
  try {
    const rate = Number(pub.playbackRate) || 1.0;
    const preserves = pub.preservesPitch !== false;
    if (mainAudioEl) {
      mainAudioEl.playbackRate = rate;
      setPreservesPitch(mainAudioEl, preserves);
    }
    if (streamAudioEl) {
      streamAudioEl.playbackRate = rate;
      setPreservesPitch(streamAudioEl, preserves);
    }
  } catch (e) {
    // 一部の古いブラウザで playbackRate / preservesPitch が未サポート。
    // 機能が動かないだけで再生継続には影響しないので warn のみ
    console.warn("[audio-engine] playbackRate/preservesPitch 設定失敗", e);
  }

  // audio.loop は使わない（iOS のロック画面挙動に影響するため）。
  // 単曲リピートは onEnded → advanceFromEnded の JS 制御で実装する。
  if (mainAudioEl) mainAudioEl.loop = false;
  if (streamAudioEl) streamAudioEl.loop = false;
}

/**
 * トラック情報の更新（バックグラウンドメタデータ抽出・編集・同期）を
 * 再生中キュー・appState.currentTrack・ミニプレイヤー・ロック画面(MediaSession)へ即時反映する
 * @param {object} updatedTrack
 * @param {object} [patch]
 */
export function applyUpdatedTrackToPlayer(updatedTrack, patch = null) {
  if (!updatedTrack || !updatedTrack.id) return;
  const id = updatedTrack.id;

  // キュー内の該当トラックを最新情報に更新
  for (let i = 0; i < state.queue.length; i++) {
    if (state.queue[i] && state.queue[i].id === id) {
      state.queue[i] = { ...state.queue[i], ...updatedTrack };
    }
  }
  if (Array.isArray(state.origQueue)) {
    for (let i = 0; i < state.origQueue.length; i++) {
      if (state.origQueue[i] && state.origQueue[i].id === id) {
        state.origQueue[i] = { ...state.origQueue[i], ...updatedTrack };
      }
    }
  }

  const cur = appState.get().currentTrack;
  if (!cur || cur.id !== id) return;

  // playCount / lastPlayedAt のみの更新時は UI 再描画やアートワーク破棄を起こさない
  if (patch && typeof patch === "object") {
    const keys = Object.keys(patch);
    if (keys.length > 0 && keys.every((k) => k === "playCount" || k === "lastPlayedAt" || k === "_noEmbeddedArt")) {
      Object.assign(cur, patch);
      return;
    }
  }

  // アートワークが更新・補完された場合は ID キャッシュを解放して新 URL を生成させる
  if (
    !patch ||
    patch.artworkBlob !== undefined ||
    patch.artworkDataUrl !== undefined ||
    (!cur.artworkBlob && updatedTrack.artworkBlob) ||
    (!cur.artworkDataUrl && updatedTrack.artworkDataUrl)
  ) {
    releaseArtwork(id);
  }

  const mergedCur = { ...cur, ...updatedTrack };
  const nextDur = (mergedCur.duration && mergedCur.duration > 0)
    ? mergedCur.duration
    : (appState.get().duration || 0);

  appState.set({
    currentTrack: mergedCur,
    duration: nextDur,
  });
  updateMediaSessionMetadata(mergedCur);
}

/**
 * IndexedDB から指定トラックの最新レコードを読み出し、プレイヤー状態に反映する（非同期・ノンブロッキング）
 * @param {string} trackId
 */
function hydrateTrackMetadata(trackId) {
  if (!trackId) return;
  getTrack(trackId)
    .then((dbTrack) => {
      if (dbTrack && dbTrack.id === trackId) {
        applyUpdatedTrackToPlayer(dbTrack);
      }
    })
    .catch(() => {});
}

/**
 * ライブラリ同期完了時などに IndexedDB の全トラック最新メタデータを現在曲とキューに再反映する
 */
export async function refreshPlayerMetadataFromDb() {
  try {
    const cur = appState.get().currentTrack;
    if (!cur && state.queue.length === 0) return;
    const allTracks = await getAllTracks();
    if (!Array.isArray(allTracks) || allTracks.length === 0) return;
    const trackMap = new Map(allTracks.map((t) => [t.id, t]));

    for (let i = 0; i < state.queue.length; i++) {
      const fresh = trackMap.get(state.queue[i]?.id);
      if (fresh) state.queue[i] = { ...state.queue[i], ...fresh };
    }
    if (Array.isArray(state.origQueue)) {
      for (let i = 0; i < state.origQueue.length; i++) {
        const fresh = trackMap.get(state.origQueue[i]?.id);
        if (fresh) state.origQueue[i] = { ...state.origQueue[i], ...fresh };
      }
    }
    if (cur && trackMap.has(cur.id)) {
      applyUpdatedTrackToPlayer(trackMap.get(cur.id));
    }
  } catch (e) {
    console.warn("[audio-engine] refreshPlayerMetadataFromDb 失敗", e);
  }
}

/**
 * preservesPitch 属性をセット (Safari は webkitPreservesPitch)
 */
function setPreservesPitch(el, val) {
  if (!el) return;
  if ("preservesPitch" in el) el.preservesPitch = val;
  if ("mozPreservesPitch" in el) el.mozPreservesPitch = val;
  if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = val;
}

/**
 * 再生速度・ピッチ維持を更新する外部 API
 * @param {number} rate
 * @param {boolean} preservePitch
 */
export function setPlaybackRate(rate, preservePitch = true) {
  const r = Math.max(0.25, Math.min(4, Number(rate) || 1));
  const preserves = !!preservePitch;
  if (mainAudioEl) {
    try {
      mainAudioEl.playbackRate = r;
      setPreservesPitch(mainAudioEl, preserves);
    } catch (e) {
      console.warn("mainAudioEl playbackRate 適用失敗", e);
    }
  }
  if (streamAudioEl) {
    try {
      streamAudioEl.playbackRate = r;
      setPreservesPitch(streamAudioEl, preserves);
    } catch (e) {
      console.warn("streamAudioEl playbackRate 適用失敗", e);
    }
  }
}

/**
 * 現在再生中の曲のキー（音程）を変更し、曲データに固定保存する
 * @param {number} semitones -12 〜 +12 (0 で原曲キーに戻す)
 * @returns {number} 適用された半音シフト量
 */
export function setKeyShift(semitones) {
  const shift = Math.max(-12, Math.min(12, Math.round(Number(semitones) || 0)));
  applyKeyShift(shift, audioEl);
  appState.set({ currentKeyShift: shift });
  const cur = appState.get().currentTrack;
  if (cur && cur.id) {
    cur.keyShift = shift;
    updateTrack(cur.id, { keyShift: shift }).catch(() => {});
  }
  return shift;
}

/**
 * 現在適用中のキーシフト量を取得 (半音単位, 0 = 原曲)
 * @returns {number}
 */
export function getKeyShift() {
  return getCurrentKeyShift();
}

function clampVolume(v) {
  if (!isFinite(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

/**
 * ユーザー音量設定とトラック情報から実効音量を計算
 * 非破壊ノーマライズ適用曲の場合は normalizedGainDb (<= 0.05) に応じて減衰
 * @param {number} userVol ユーザー設定音量 (0.0〜1.0)
 * @param {object} [track] 対象トラック
 * @returns {number}
 */
export function computeTrackVolume(userVol, track) {
  const base = clampVolume(isFinite(userVol) ? userVol : 1.0);
  if (!track) return base;
  if (track.normalized && track.normalizedType === "non-destructive" && typeof track.normalizedGainDb === "number") {
    const gainLinear = Math.min(1.0, Math.pow(10, track.normalizedGainDb / 20));
    return clampVolume(base * gainLinear);
  }
  return base;
}

/**
 * 対象の <audio> 要素に実効音量を適用
 * @param {HTMLAudioElement} [targetEl]
 * @param {object} [targetTrack]
 */
export function applyTrackVolume(targetEl = audioEl, targetTrack = appState.get().currentTrack) {
  if (!targetEl) return;
  targetEl.volume = computeTrackVolume(state.userVolume, targetTrack);
}

/**
 * 保存された設定から実効再生速度を取得
 * @returns {number}
 */
export function getEffectivePlaybackRate() {
  const pub = getPublic();
  return Math.max(0.25, Math.min(4, Number(pub.playbackRate) || 1.0));
}

/**
 * iOS Safari / WebKit の CoreAudio が確実に有効な音声ストリームとして認識・再生維持できる
 * 100ms (8000Hz, 8bit Mono, 800サンプル) の無音 PCM WAV Data URI を生成する。
 * (0サンプルの空WAVヘッダでは iOS で即座に終了・エラーとなり User Gesture 保持に失敗するため)
 */
function createSilentWavDataUri() {
  const numSamples = 800;
  const buf = new Uint8Array(44 + numSamples);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + numSamples, true);
  buf.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // "WAVEfmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  buf.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, numSamples, true);
  buf.fill(0x80, 44);
  let bin = "";
  for (let i = 0; i < buf.length; i++) {
    bin += String.fromCharCode(buf[i]);
  }
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(buf).toString("base64");
  return "data:audio/wav;base64," + b64;
}

const SILENT_AUDIO_URI = createSilentWavDataUri();

let audioElementsUnlocked = false;

/**
 * ユーザーの最初の操作（pointerdown / click / keydown）で
 * mainAudioEl と streamAudioEl の両方を安全にアンロックする（iOS Safari Autoplay解除）
 */
export function unlockAudioElementsOnUserGesture() {
  if (audioElementsUnlocked) return;
  audioElementsUnlocked = true;
  setupAudioSession();

  const elements = [mainAudioEl, streamAudioEl].filter(Boolean);
  for (const el of elements) {
    if (!el.paused && el.src && !el.src.startsWith("data:audio/wav")) continue;
    if (state.transitioning) continue;
    try {
      if (!el.src || el.src === "" || el.src.startsWith("data:audio/wav")) {
        el.src = SILENT_AUDIO_URI;
      }
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.catch(() => {});
      }
    } catch (_) {}
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const unlockOnce = () => {
    unlockAudioElementsOnUserGesture();
    window.removeEventListener("pointerdown", unlockOnce, true);
    window.removeEventListener("click", unlockOnce, true);
    window.removeEventListener("keydown", unlockOnce, true);
  };
  window.addEventListener("pointerdown", unlockOnce, { capture: true, once: true });
  window.addEventListener("click", unlockOnce, { capture: true, once: true });
  window.addEventListener("keydown", unlockOnce, { capture: true, once: true });
}

/**
 * ユーザー操作 (click / tap) の同期コールスタック内で audio 要素を即座に起動する。
 *
 * モバイルブラウザ (iOS Safari / WebKit / Android Chrome 等) は、ユーザー操作起点で
 * 直ちに play() を呼ばないと、直後の await (IndexedDB や Drive 通信) で User Gesture
 * トークンが失効し、その後の play() が Autoplay 制限でブロックされて一時停止状態のままになる。
 * 同期スタック内で 100ms 無音 WAV ループを再生開始しておくことで、非同期ロード完了後に
 * 本体の音源を即座にワンタップで鳴らすことができる。
 * @param {HTMLAudioElement} [targetEl]
 */
function primeAudioElement() {
  try {
    setupAudioSession();
    unlockAudioElementsOnUserGesture();
    if (audioEl) {
      // 既にアクティブ再生中の場合は無音WAV代入をスキップ（音切れ・AbortError防止）
      if (!audioEl.paused && audioEl.src && !audioEl.src.startsWith("data:audio/wav")) {
        return;
      }
      state.transitioning = true;
      state.userPausedExplicitly = false;
      audioEl.loop = true;
      if (audioEl.src !== SILENT_AUDIO_URI) {
        audioEl.src = SILENT_AUDIO_URI;
      }
      primePromise = audioEl.play();
      if (primePromise && typeof primePromise.catch === "function") {
        primePromise.catch(() => {});
      }
    }
  } catch (e) {
    console.warn("[audio-engine] primeAudioElement 失敗", e);
  }
}

/* ============ 外部API ============ */

export async function playTrackImmediate(track) {
  if (!track) return;
  unlockAudioElementsOnUserGesture();
  const memBlob = getMemoryBlob(track.id);
  if (memBlob) {
    const objectUrl = URL.createObjectURL(memBlob);
    playPreloadedSync(state.queueIndex, track, objectUrl);
    return;
  }
  const prewarmed = prewarmCache.get(track.id);
  if (prewarmed && prewarmed.objectUrl) {
    prewarmCache.delete(track.id);
    playPreloadedSync(state.queueIndex, track, prewarmed.objectUrl, { isDirectStream: prewarmed.isStream });
    return;
  }
  primeAudioElement();
  await loadAndPlay(track);
}

export async function setQueueAndPlay(tracks, startIndex = 0) {
  unlockAudioElementsOnUserGesture();
  // ユーザー操作(曲タップ等)起点でセッションアクティベータを生成しておく。
  resumeSessionActivator();
  // 新しいキューを開始するので、旧キュー由来のプリロードは破棄
  clearPreload();
  state.consecutiveSkips = 0;
  state.queue = tracks.slice();
  state.queueIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
  state.origQueue = null;
  appState.set({ queue: state.queue.map((t) => t.id), queueIndex: state.queueIndex });
  if (appState.get().shuffleMode) {
    shuffleCurrentQueue();
  }
  const cur = state.queue[state.queueIndex];
  if (!cur) return;

  // ★ ユーザー操作（タップ）の同期コールスタックで即座に再生を開始（再生ボタンを押さずに即再生）
  // 1. インメモリ Blob キャッシュにある場合は 0ms で即座に再生 (User Gesture 100% 保持・ラグ 0ms)
  const memBlob = getMemoryBlob(cur.id);
  if (memBlob) {
    const objectUrl = URL.createObjectURL(memBlob);
    playPreloadedSync(state.queueIndex, cur, objectUrl);
    return;
  }

  // 2. もし prewarmCache に既に URL (Object URL または ダイレクトストリーム URL) があれば完全同期で即座に再生 (ラグ 0ms)
  const prewarmed = prewarmCache.get(cur.id);
  if (prewarmed && prewarmed.objectUrl) {
    prewarmCache.delete(cur.id);
    playPreloadedSync(state.queueIndex, cur, prewarmed.objectUrl, { isDirectStream: prewarmed.isStream });
    return;
  }

  // 3. まだメモリにない場合: ユーザー操作コンテキスト内で同期プライミングを行い
  //    ブラウザの User Gesture 失効を防ぎ、ワンタップで即座に再生させる
  primeAudioElement();

  await loadAndPlay(cur);
}

/**
 * 「次へ」ボタン用：ユーザが明示的に次の曲を要求している。
 * リピートモードに依らず必ず次の曲に進む（末尾なら停止 or all 時は先頭へ）。
 *
 * 注: 自然終了時の挙動は onEnded → advanceFromEnded で別途扱う。
 *     repeat="one" の効果はそちら（曲ループ）にのみ適用する。
 */
export async function playNext() {
  unlockAudioElementsOnUserGesture();
  if (state.queue.length === 0) return;
  const repeat = appState.get().repeatMode;
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (repeat === "all" || state.queue.length === 1) {
      next = 0;
    } else {
      // 複数曲・リピートなしの末尾で「次へ」が押された場合:
      // iOS ロック画面でスキップボタンが消える・無効化されるのを防ぐため先頭曲へ戻す
      next = 0;
    }
  }
  // 単一曲キューで同一曲の場合は頭出しシーク＆再生
  if (state.queue.length === 1 || next === state.queueIndex) {
    state.userPausedExplicitly = false;
    try { audioEl.currentTime = 0; } catch {}
    try { await audioEl.play(); } catch {}
    return;
  }
  const t = state.queue[next];
  if (!t) return;
  // プリロード済みの曲なら同期高速パスで即再生 (ロック画面の「次へ」操作でも
  // 音が途切れないように)。それ以外は通常の loadAndPlay。
  if (state.preloadUrl && state.preloadTrackId === t.id) {
    playPreloadedSync(next, t, state.preloadUrl);
    return;
  }
  const memBlob = getMemoryBlob(t.id);
  if (memBlob) {
    const objectUrl = URL.createObjectURL(memBlob);
    playPreloadedSync(next, t, objectUrl);
    return;
  }
  const prewarmed = prewarmCache.get(t.id);
  if (prewarmed && prewarmed.objectUrl) {
    prewarmCache.delete(t.id);
    playPreloadedSync(next, t, prewarmed.objectUrl, { isDirectStream: prewarmed.isStream });
    return;
  }
  state.queueIndex = next;
  appState.set({ queueIndex: next });
  primeAudioElement();
  await loadAndPlay(t);
}

/**
 * 「自然終了時に次に再生されるべきトラックの index」を返す（再生用）。
 *   - repeat="one"  : 同一曲ループは呼出側 (advanceFromEnded) が別途処理 → -1
 *   - キュー末尾 + repeat="all" : 先頭 (0) へ
 *   - キュー末尾 + repeat!="all": 次は無い → -1
 * シャッフルは shuffleCurrentQueue で事前に並べ替え済みのため、次曲は
 * 決定的 (queueIndex + 1) であり、プリロードできる。
 *
 * ★ 単一曲キュー + repeat="all" のときは next === queueIndex (= 同一曲) を返す。
 *   この「次が現在と同じ」ケースは advanceFromEnded が同期ループ再生で扱い、
 *   schedulePreload は「現在曲のプリロードは不要」としてスキップする。
 *   (以前ここで -1 を返していたため単一曲 repeat=all が停止する回帰があった)
 */
function computeNextIndex() {
  if (state.queue.length === 0) return -1;
  const repeat = appState.get().repeatMode;
  if (repeat === "one") return -1; // 同一曲ループは advanceFromEnded が処理
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (repeat === "all") next = 0;
    else return -1;
  }
  return next;
}

/**
 * プリロード済み object URL を破棄してフィールドをクリアする。
 * in-flight の getBlob を無効化するため token も進める。
 */
function clearPreload() {
  if (state.preloadUrl) {
    try { URL.revokeObjectURL(state.preloadUrl); } catch {}
  }
  state.preloadUrl = null;
  state.preloadTrackId = null;
  state.preloadingId = null;
  state.preloadToken++; // in-flight の getBlob を stale 化して破棄させる
}

/**
 * 「次に再生されるトラック」の blob を先読みして object URL を用意する。
 *
 * 現在の曲が再生開始した直後に呼ぶことで、ended までの数分間に余裕をもって
 * IndexedDB 読み出しを完了させ、ended 時には同期的に再生開始できる状態にする。
 *
 * - 既に正しい曲をプリロード済みなら何もしない
 * - 次曲が無い (末尾 + リピートなし / 単曲リピート) ならクリアのみ
 * - token で世代管理し、曲が変わって stale になった結果は破棄する
 */
function schedulePreload() {
  const nextIndex = computeNextIndex();
  if (nextIndex < 0) { clearPreload(); return; }
  // 次が現在と同じ曲 (単一曲キュー + repeat=all) は既にロード済みなのでプリロード不要。
  // advanceFromEnded が同期ループ再生で扱う。
  if (nextIndex === state.queueIndex) { clearPreload(); return; }
  const track = state.queue[nextIndex];
  if (!track || !track.id) { clearPreload(); return; }
  // 既に正しい曲をプリロード済み → 再取得不要
  if (state.preloadTrackId === track.id && state.preloadUrl) return;
  // 既に同じ曲を取得中 → 二重 getBlob を避ける (setShuffle/setRepeat 連打対策)
  if (state.preloadingId === track.id) return;

  // 古いプリロード (別曲) を破棄して新規取得 (clearPreload が token++ で in-flight を無効化)
  clearPreload();
  const token = state.preloadToken;
  const targetId = track.id;
  state.preloadingId = targetId;
  getBlob(targetId)
    .then((blob) => {
      // 取得中に曲が変わっていたら破棄 (stale)
      if (token !== state.preloadToken) return;
      if (!blob) return; // 見つからない → ended 時に fallback (loadAndPlay) でスキップ判定
      const url = URL.createObjectURL(blob);
      // createObjectURL までの間に再度変化していないか最終確認
      if (token !== state.preloadToken) {
        try { URL.revokeObjectURL(url); } catch {}
        return;
      }
      state.preloadTrackId = targetId;
      state.preloadUrl = url;
    })
    .catch((e) => console.warn("[audio-engine] 次曲プリロード失敗", e))
    .finally(() => {
      // この取得が現在の世代のものであれば in-flight フラグを解除。
      // (古い世代なら、より新しい schedulePreload が preloadingId を所有しているので触らない)
      if (token === state.preloadToken) state.preloadingId = null;
    });
}

/**
 * プリロード済み URL を使って「同期的に」次曲を再生開始する。
 *
 * ★ iOS バックグラウンド自動遷移の核心。
 *   この関数は ended イベントハンドラの同期実行コンテキストから呼ばれ、
 *   await を一切挟まずに audioEl.src 差替 → audioEl.play() まで到達する。
 *   これにより iOS Safari が音声停止を検知して JS を suspend / audio session を
 *   解放する前に次曲再生を開始でき、画面オフのまま音が途切れず次へ進む。
 *
 *   getBlob (IndexedDB) や waitForLoadedMetadata は呼ばない (どちらも await が
 *   必要でバックグラウンドで遅延するため)。duration はパース済みの
 *   track.duration を使って MediaSession に渡すので loadedmetadata 待ちは不要。
 */
function playPreloadedSync(index, track, url, { isDirectStream = false } = {}) {
  // 防御: url が無い場合は同期再生できないので通常パスへフォールバック。
  // (呼び出し側は state.preloadUrl を真偽判定済みだが、念のため)
  if (!url) {
    state.queueIndex = index;
    appState.set({ queueIndex: index });
    loadAndPlay(track).catch((e) => console.warn("[audio-engine] loadAndPlay 失敗", e));
    return;
  }

  const session = beginPlaybackSession(track, index, 0);
  const myAttemptId = session.playAttemptId;

  resetSession(track?.id);
  // この遷移の世代トークンを採番。clearTransitioning はこの世代が最新の
  // ときだけ transitioning を解除する (連打時に古い遷移が新しい遷移の
  // フラグを倒さないようにするため)。
  const myToken = ++state.transitionToken;
  state.transitioning = true;

  const oldUrl = state.currentObjectUrl;
  state.queueIndex = index;
  state.currentObjectUrl = url;
  state.isDirectStream = !!isDirectStream;
  state.streamFallbackInProgress = false;
  // プリロード枠を消費 (URL は currentObjectUrl に移譲したので revoke しない)
  state.preloadUrl = null;
  state.preloadTrackId = null;
  state.preloadingId = null;
  state.preloadToken++;
  abortActiveBackgroundCache();

  // ★ キーチェンジ（音程変更）の反映: track に固定された keyShift または 0 (前曲の値は絶対流用しない)
  const trackKeyShift = session.requestedKeyShift;

  const pub = getPublic() || {};
  const isEffectsActive = !!pub.enableAudioEffects;
  const isKeyShiftActive = trackKeyShift !== 0;
  const needsWebAudio = isEffectsActive || isKeyShiftActive;

  if (isDirectStream) {
    setActiveAudioElement(streamAudioEl);
    session.activeElement = streamAudioEl;
    session.sourceType = "drive_stream";
    session.appliedKeyShift = 0;
    applyKeyShift(0, streamAudioEl);
    appState.set({ currentKeyShift: 0 });
    if (needsWebAudio) {
      notifyUncachedFastStreamOnce();
    }
    // 未キャッシュダイレクトストリーム時は Web Audio をバイパス（CORS無音化防止）
  } else {
    setActiveAudioElement(mainAudioEl);
    session.activeElement = mainAudioEl;
    session.sourceType = "cached_blob";
    session.appliedKeyShift = trackKeyShift;
    // ★ 0 の場合も必ず Worklet リセットと完全バイパス直結を実施
    applyKeyShift(trackKeyShift, mainAudioEl);
    appState.set({ currentKeyShift: trackKeyShift });
    if (pub.enableAudioEffects && mainAudioEl) {
      try { applyEffectsSetting(mainAudioEl, true); } catch (_) {}
    }
    resumeEqContext().catch(() => {});
  }

  // ★ UI 状態 (currentTrack 等) は play() の前に同期で確定する。
  appState.set({
    currentTrack: track,
    queueIndex: index,
    duration: track.duration || 0,
    currentTime: 0,
    isPlaying: true,
    loadingTrackId: null,
    scrobbleProgress: 0,
    nowPlayingSent: false,
    scrobbledForCurrent: false,
    scrobbleResult: "none",
    scrobbleReason: null,
  });

  state.userPausedExplicitly = false;

  audioEl.src = url;
  audioEl.loop = false;
  audioEl.playbackRate = getEffectivePlaybackRate();
  applyTrackVolume(audioEl, track);

  updateMediaSessionMetadata(track);

  // 未キャッシュ Google Drive 曲のバックグラウンドキャッシュ開始（playing 到達時のみ・1回限定）
  if (isDirectStream && track?.id) {
    const onPlayingOnce = () => {
      audioEl.removeEventListener("playing", onPlayingOnce);
      startBackgroundDriveCache(track.id, Date.now());
    };
    audioEl.addEventListener("playing", onPlayingOnce);
  }

  // ★ 無音検知と安全な自動復旧（Web Audio 接続時の無音化防止・1セッション最大1回）
  if (!session.isStale && session.activeElement === mainAudioEl && needsWebAudio && !session.hasRecoveredSilence) {
    session.silenceCheckTimer = setTimeout(() => {
      if (session.isStale || session !== activePlaybackSession) return;
      const curAudio = getAudioElement();
      if (!curAudio || curAudio !== mainAudioEl || curAudio.paused) return;
      if (curAudio.volume <= 0 || curAudio.muted) return;
      if (curAudio.currentTime < 2.0) return;
      if (curAudio.readyState < 2) return;

      const rms = getOutputRms();
      if (rms === 0) {
        console.warn(`[audio-engine] Web Audio 無音状態を検知。自動復旧を実行します (1/1):`, session.trackId);
        session.hasRecoveredSilence = true;
        try {
          recreateAudioContext(mainAudioEl);
          const curPos = curAudio.currentTime;
          applyKeyShift(session.appliedKeyShift, mainAudioEl);
          curAudio.currentTime = curPos;
          curAudio.play().catch((recErr) => {
            console.warn("[audio-engine] 無音復旧 play 失敗:", recErr);
            handlePlaybackFinalFailure(session.playAttemptId, session.track, recErr);
          });
        } catch (recErr) {
          console.warn("[audio-engine] 無音復旧例外:", recErr);
          handlePlaybackFinalFailure(session.playAttemptId, session.track, recErr);
        }
      }
    }, 5000);
  }

  startPlayingWatchdog(myAttemptId, track, 0, isDirectStream);

  logPlaybackEvent("play_called", { targetEl: audioEl, track, attemptId: myAttemptId });
  const playPromise = audioEl.play();
  // --- play() 発火完了。以降は同期でなくてもよい ---

  // play() の「後」は position state のみ再確定する (新 MediaMetadata は作らない)。
  // loadAndPlay の Phase4 と同じ扱い。
  updateMediaPositionState({ position: 0, duration: track.duration });

  const clearTransitioning = () => {
    if (myToken === state.transitionToken) state.transitioning = false;
  };

  // 旧 URL は再生が新 URL に確実に移ってから遅延 revoke
  if (oldUrl && oldUrl !== url && oldUrl.startsWith("blob:")) {
    setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch {} }, 2000);
  }

  if (playPromise && typeof playPromise.then === "function") {
    playPromise
      .then(() => {
        logPlaybackEvent("play_resolved", { targetEl: audioEl, track, attemptId: myAttemptId, playPromiseResult: "resolved" });
        clearTransitioning();
        state.consecutiveSkips = 0;
        if (session) {
          session.playbackStatus = "playing";
          session.playingAt = Date.now();
        }
        hydrateTrackMetadata(track?.id);
        // 再生回数 / 最終再生日時を更新 (await 不要、失敗は無視)
        updateTrack(track.id, {
          playCount: (track.playCount || 0) + 1,
          lastPlayedAt: Date.now(),
        }).catch(() => {});
        schedulePreload();
      })
      .catch((e) => {
        logPlaybackEvent("play_rejected", { targetEl: audioEl, track, attemptId: myAttemptId, error: e, playPromiseResult: `rejected: ${e?.name || e?.message || e}` });
        clearTransitioning();
        if (session) {
          session.playbackStatus = "error";
        }
        handlePlaybackFinalFailure(myAttemptId, track, e);
        console.warn("[audio-engine] プリロード再生 play 失敗", e);
      });
  } else {
    // play() が promise を返さない古い実装 → 即クリア
    clearTransitioning();
    if (session) {
      session.playbackStatus = "playing";
      session.playingAt = Date.now();
    }
    schedulePreload();
  }
  // 保険: promise が解決しない異常時でも transitioning を必ず解除
  setTimeout(clearTransitioning, 1500);
}

/**
 * 自然終了時の自動遷移。repeat="one" ならループ。
 * 明示的「次へ」ボタンと挙動を分けるため独立した関数にする。
 *
 * ★ async ではなく同期関数にしてある。プリロード済みの通常ケースでは
 *   playPreloadedSync が同期的に play() まで到達することが重要 (iOS BG 対策)。
 */
function advanceFromEnded() {
  if (state.queue.length === 0) return;

  // ★ スリープタイマー: 「この曲の終わりで停止」
  if (sleepTimerMode === "end-of-track") {
    setSleepTimer("off");
    state.userPausedExplicitly = true;
    if (mainAudioEl) { try { mainAudioEl.pause(); } catch {} }
    if (streamAudioEl) { try { streamAudioEl.pause(); } catch {} }
    toast("曲の終了に合わせて再生を一時停止しました", "info");
    return;
  }

  const repeat = appState.get().repeatMode;
  const next = computeNextIndex();

  // 同一曲を頭から再生するケース:
  //   - repeat="one" (単曲リピート)
  //   - 単一曲キュー + repeat="all" (次が現在と同じ → 実質ループ)
  // どちらも reload せず同期で seek + play する (await ゼロ、iOS BG でも無音化しない)。
  if (repeat === "one" || (next >= 0 && next === state.queueIndex)) {
    state.userPausedExplicitly = false;
    const curTrack = state.queue[state.queueIndex];
    const session = beginPlaybackSession(curTrack, state.queueIndex, 0);
    session.activeElement = audioEl;
    session.appliedKeyShift = session.requestedKeyShift;
    applyKeyShift(session.appliedKeyShift, audioEl);
    session.playbackStatus = "playing";
    session.playingAt = Date.now();
    resetSession(curTrack?.id);
    appState.set({
      currentTime: 0,
      scrobbleProgress: 0,
      nowPlayingSent: false,
      scrobbledForCurrent: false,
      scrobbleResult: "none",
      scrobbleReason: null,
      currentKeyShift: session.appliedKeyShift,
    });
    try { audioEl.currentTime = 0; } catch {}
    const p = audioEl.play();
    if (p && typeof p.catch === "function") {
      p.catch((e) => console.warn("[audio-engine] ループ再生 play 失敗", e));
    }
    return;
  }
  if (next < 0) {
    // キューが末尾まで再生完了（リピートなし）。
    // currentPlaylistId をクリアすることで、プレイリスト画面の
    // 「すべて再生」/「シャッフル再生」ハイライトが自動的にオフになる。
    appState.set({ isPlaying: false, currentPlaylistId: null, currentPlaylistName: null });
    return;
  }
  const track = state.queue[next];
  if (!track) return;

  // ★ プリロード済みなら同期高速パス (iOS バックグラウンドで音が途切れない)
  if (state.preloadUrl && state.preloadTrackId === track.id) {
    playPreloadedSync(next, track, state.preloadUrl);
    return;
  }
  const memBlob = getMemoryBlob(track.id);
  if (memBlob) {
    const objectUrl = URL.createObjectURL(memBlob);
    playPreloadedSync(next, track, objectUrl);
    return;
  }
  const prewarmed = prewarmCache.get(track.id);
  if (prewarmed && prewarmed.objectUrl) {
    prewarmCache.delete(track.id);
    playPreloadedSync(next, track, prewarmed.objectUrl, { isDirectStream: prewarmed.isStream });
    return;
  }

  // フォールバック: プリロード未完了 (プリロードが間に合わなかった / blob 無し等)。
  // フォアグラウンドなら問題なく動作する。バックグラウンドで間に合わなかった
  // 場合は従来同様のリスクが残るが、通常は曲の長さに対し十分先読みが間に合う。
  state.queueIndex = next;
  appState.set({ queueIndex: next });
  loadAndPlay(track).catch((e) => console.warn("[audio-engine] loadAndPlay 失敗", e));
}

export async function playPrev() {
  unlockAudioElementsOnUserGesture();
  if (state.queue.length === 0) return;
  // 再生位置が 3 秒以上の場合は曲頭に戻すだけ（前曲には行かない）。
  // アプリ内操作および MediaSession (ロック画面/イヤホン) で完全統一
  const curTime = audioEl?.currentTime || appState.get().currentTime || 0;
  if (curTime >= 3) {
    try { audioEl.currentTime = 0; } catch {}
    appState.set({ currentTime: 0 });
    updateMediaPositionState({ position: 0 });
    return;
  }
  let prev = state.queueIndex - 1;
  if (prev < 0) {
    // キュー先頭での「前へ」: キューリピート時のみ末尾へ、それ以外は曲頭へ
    if (appState.get().repeatMode === "all") {
      prev = state.queue.length - 1;
    } else {
      try { audioEl.currentTime = 0; } catch {}
      appState.set({ currentTime: 0 });
      updateMediaPositionState({ position: 0 });
      return;
    }
  }
  state.queueIndex = prev;
  appState.set({ queueIndex: prev });
  const t = state.queue[prev];
  if (t) {
    const memBlob = getMemoryBlob(t.id);
    if (memBlob) {
      const objectUrl = URL.createObjectURL(memBlob);
      playPreloadedSync(prev, t, objectUrl);
      return;
    }
    const prewarmed = prewarmCache.get(t.id);
    if (prewarmed && prewarmed.objectUrl) {
      prewarmCache.delete(t.id);
      playPreloadedSync(prev, t, prewarmed.objectUrl, { isDirectStream: prewarmed.isStream });
      return;
    }
    primeAudioElement();
    await loadAndPlay(t);
  }
}

/**
 * 再生ボタン or 「play」アクションハンドラ用のトグル。
 * - currentTrack が無い場合はライブラリ先頭曲を自動再生（mp3player 互換）
 * - 既に paused なら play、playing なら pause
 * - 起動時のセッション復元直後など src 未ロード状態の場合は、保存された秒数から再生開始
 */
export async function togglePlay() {
  unlockAudioElementsOnUserGesture();
  const curTrack = appState.get().currentTrack;
  if (!curTrack) {
    primeAudioElement();
    await autoStartFirstTrack();
    return;
  }
  // 起動時のセッション復元直後など、src がまだロードされていない場合
  if (!state.currentObjectUrl || !audioEl.src) {
    primeAudioElement();
    const startSec = appState.get().currentTime || 0;
    await loadAndPlay(curTrack, { startTime: startSec });
    return;
  }
  // ★ iOS: 再生再開もユーザー操作起点で audioSession.type="playback" を再宣言する
  //   (マナーモード/画面ロックでのミュート対策。loadAndPlay と同じ理由)。
  setupAudioSession();
  // セッションアクティベータを resume (iOS audio session の再活性化。ユーザ操作起点。
  // 初回はここで AudioContext が生成されるため、以後のロック画面再開は resume だけで済む)
  await resumeSessionActivator();
  // EQ chain が存在し suspended なら resume（ユーザ操作起点・mainAudioEl再生時のみ）
  if (activeAudioEl === mainAudioEl) {
    await resumeEqContext();
  }
  if (audioEl.paused) {
    state.userPausedExplicitly = false;
    // アプリ内ボタンからの再開でも、コールドスタート時の無進行ストールに備えて
    // 進行監視を仕掛ける(正常に進行すれば何もしない)。
    armResumeWatchdog();
    try {
      await audioEl.play();
    } catch (err) {
      console.warn("play 失敗", err);
      appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "paused" });
      if (navigator.mediaSession) {
        try { navigator.mediaSession.playbackState = "paused"; } catch {}
      }
    }
  } else {
    state.userPausedExplicitly = true;
    // 保留中の自動再試行がこの明示 pause を覆さないように解除
    clearResumeWatchdog();
    if (mainAudioEl) { try { mainAudioEl.pause(); } catch {} }
    if (streamAudioEl) { try { streamAudioEl.pause(); } catch {} }
  }
}

/**
 * 任意のトラックを現在の曲の「次」に挿入する（割り込み再生）
 * @param {object} track
 */
export function playNextTrack(track) {
  if (!track || !track.id) return;
  if (state.queue.length === 0 || state.queueIndex < 0) {
    setQueueAndPlay([track], 0);
    return;
  }
  const insertIndex = state.queueIndex + 1;
  state.queue.splice(insertIndex, 0, track);
  if (state.origQueue) {
    state.origQueue.push(track);
  }
  appState.set({ queue: state.queue.map((t) => t.id) });
  saveSessionState();
  schedulePreload();
  toast(`「${track.title || "曲"}」を次に再生に設定しました`, "ok");
}

/**
 * 任意のトラックを再生キューの末尾に追加する
 * @param {object} track
 */
export function addToQueueEnd(track) {
  if (!track || !track.id) return;
  if (state.queue.length === 0 || state.queueIndex < 0) {
    setQueueAndPlay([track], 0);
    return;
  }
  state.queue.push(track);
  if (state.origQueue) {
    state.origQueue.push(track);
  }
  appState.set({ queue: state.queue.map((t) => t.id) });
  saveSessionState();
  schedulePreload();
  toast(`「${track.title || "曲"}」をキューの末尾に追加しました`, "ok");
}

/**
 * 再生キューから指定インデックスの曲を削除する
 * @param {number} index
 */
export async function removeFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;
  const removedTrack = state.queue[index];
  if (index === state.queueIndex) {
    if (state.queue.length === 1) {
      stopPlayback();
      return;
    }
    state.queue.splice(index, 1);
    if (state.origQueue && removedTrack) {
      const origIdx = state.origQueue.findIndex((t) => t.id === removedTrack.id);
      if (origIdx >= 0) state.origQueue.splice(origIdx, 1);
    }
    const nextIdx = index >= state.queue.length ? 0 : index;
    state.queueIndex = nextIdx;
    appState.set({ queue: state.queue.map((t) => t.id), queueIndex: state.queueIndex });
    saveSessionState();
    const nextTrack = state.queue[nextIdx];
    if (nextTrack) {
      await loadAndPlay(nextTrack);
    }
    return;
  }
  state.queue.splice(index, 1);
  if (state.origQueue && removedTrack) {
    const origIdx = state.origQueue.findIndex((t) => t.id === removedTrack.id);
    if (origIdx >= 0) state.origQueue.splice(origIdx, 1);
  }
  if (index < state.queueIndex) {
    state.queueIndex--;
  }
  appState.set({ queue: state.queue.map((t) => t.id), queueIndex: state.queueIndex });
  saveSessionState();
  schedulePreload();
}

/**
 * キューの指定インデックスへジャンプ再生
 * @param {number} index
 */
export async function jumpToQueueIndex(index) {
  unlockAudioElementsOnUserGesture();
  if (index < 0 || index >= state.queue.length) return;
  state.queueIndex = index;
  appState.set({ queueIndex: index });
  const track = state.queue[index];
  if (track) {
    const memBlob = getMemoryBlob(track.id);
    if (memBlob) {
      const objectUrl = URL.createObjectURL(memBlob);
      playPreloadedSync(index, track, objectUrl);
      return;
    }
    const prewarmed = prewarmCache.get(track.id);
    if (prewarmed && prewarmed.objectUrl) {
      prewarmCache.delete(track.id);
      playPreloadedSync(index, track, prewarmed.objectUrl, { isDirectStream: prewarmed.isStream });
      return;
    }
    primeAudioElement();
    await loadAndPlay(track);
  }
}

/**
 * スリープタイマーを設定する
 * @param {"off" | "15" | "30" | "60" | "end-of-track" | number} mode
 */
export function setSleepTimer(mode) {
  if (sleepTimerId) {
    clearInterval(sleepTimerId);
    sleepTimerId = null;
  }
  sleepTimerMode = String(mode);
  if (!mode || sleepTimerMode === "off") {
    sleepTimerTargetTime = 0;
    appState.set({ sleepTimer: { mode: "off", remainingSec: 0, active: false } });
    toast("スリープタイマーをオフにしました", "info");
    return;
  }

  if (sleepTimerMode === "end-of-track") {
    sleepTimerTargetTime = 0;
    appState.set({ sleepTimer: { mode: "end-of-track", remainingSec: 0, active: true } });
    toast("現在の曲の終了で停止します", "ok");
    return;
  }

  const mins = parseInt(sleepTimerMode, 10);
  if (mins > 0) {
    const totalSec = mins * 60;
    sleepTimerTargetTime = Date.now() + totalSec * 1000;
    appState.set({ sleepTimer: { mode: sleepTimerMode, remainingSec: totalSec, active: true } });
    toast(`スリープタイマーを ${mins} 分に設定しました`, "ok");

    sleepTimerId = setInterval(() => {
      const remainingMs = sleepTimerTargetTime - Date.now();
      const remSec = Math.max(0, Math.ceil(remainingMs / 1000));
      if (remSec <= 0) {
        clearInterval(sleepTimerId);
        sleepTimerId = null;
        sleepTimerMode = "off";
        sleepTimerTargetTime = 0;
        appState.set({ sleepTimer: { mode: "off", remainingSec: 0, active: false } });
        state.userPausedExplicitly = true;
        if (mainAudioEl) { try { mainAudioEl.pause(); } catch {} }
        if (streamAudioEl) { try { streamAudioEl.pause(); } catch {} }
        toast("スリープタイマーにより再生を一時停止しました", "info");
      } else {
        appState.set({ sleepTimer: { mode: sleepTimerMode, remainingSec: remSec, active: true } });
      }
    }, 1000);
  }
}

export function getSleepTimerState() {
  return appState.get().sleepTimer || { mode: "off", remainingSec: 0, active: false };
}

/**
 * 「曲なし」状態で再生要求があった時に呼ぶ：ライブラリ先頭から再生
 */
async function autoStartFirstTrack() {
  try {
    const tracks = await getAllTracks();
    let enabled = tracks.filter((t) => t.enabled !== false);
    if (enabled.length === 0) return;
    enabled.sort((a, b) => {
      const ao = (typeof a.order === "number") ? a.order : (a.addedAt || 0);
      const bo = (typeof b.order === "number") ? b.order : (b.addedAt || 0);
      return ao - bo;
    });
    state.userPausedExplicitly = false;
    // autoStart はライブラリ由来。プレイリストコンテキストをクリア。
    appState.set({ currentPlaylistId: null, currentPlaylistName: null });
    await setQueueAndPlay(enabled, 0);
  } catch (e) {
    console.warn("auto-start failed", e);
  }
}

export function seekTo(sec) {
  if (!isFinite(sec)) return;
  try { audioEl.currentTime = Math.max(0, sec); } catch (e) { console.warn("seek 失敗", e); }
}

export function setVolume(v) {
  state.userVolume = clampVolume(v);
  if (mainAudioEl) applyTrackVolume(mainAudioEl);
  if (streamAudioEl) applyTrackVolume(streamAudioEl);
}

/**
 * シャッフル ON/OFF
 * - ON にすると現在のキューを「現在曲先頭固定」でランダムに並べ替える
 * - 単曲リピート (repeat="one") とは排他: シャッフル ON 時に repeat="one" なら
 *   キューリピート (repeat="all") に下げる。キューリピートとは共存可能。
 */
export function setShuffleMode(on) {
  // 排他: シャッフル ON + 単曲リピートは禁止
  // 単曲リピート中にシャッフルを ON にしたら、リピートはキューリピートに下げる
  if (on && appState.get().repeatMode === "one") {
    appState.set({ repeatMode: "all" });
  }
  appState.set({ shuffleMode: !!on });
  if (on) {
    shuffleCurrentQueue();
  } else if (state.origQueue) {
    const curId = state.queue[state.queueIndex]?.id;
    state.queue = state.origQueue.slice();
    let idx = state.queue.findIndex((t) => t.id === curId);
    if (idx < 0) {
      // 現在曲が原キューに見つからない異常時(queueIndex 不整合や外部削除)。
      // 先頭にフォールバックするが、無言だと原因追跡できないため警告を残す(挙動は従来と同じ)。
      console.warn("[audio-engine] シャッフル解除時に現在曲が原キューに見つかりません。先頭にフォールバックします", curId);
      idx = 0;
    }
    state.queueIndex = idx;
    state.origQueue = null;
    appState.set({ queue: state.queue.map((t) => t.id), queueIndex: state.queueIndex });
  }
  // 再生モードを設定に永続化する(起動時 app.js が getPublic から復元する契約に対応)。
  //   排他で shuffle/repeat が連動変更されるため確定後の両値を保存する。
  //   setPublic は localStorage への書込のみで音声経路(audio/MediaSession/AudioContext)に無関係。
  setPublic({ shuffleMode: appState.get().shuffleMode, repeatMode: appState.get().repeatMode });
  // キュー順が変わったので「次曲」も変わる → プリロードを取り直す
  schedulePreload();
}

/**
 * リピートモード変更
 * - "none" / "all" / "one" を順に循環
 * - "one" (単曲リピート) のときはシャッフルを OFF にする（排他）
 * - "all" (キューリピート) はシャッフルと共存可能
 *
 * 重要: 以前は audio.loop = true でループしていたが、iOS のロック画面で
 *       一時停止すると別のアプリの音声に切り替わるデグレが発生したため、
 *       loop 属性は使わず JS の onEnded → advanceFromEnded で実装する。
 */
export function setRepeatMode(mode) {
  if (!["none", "one", "all"].includes(mode)) return;
  // 排他: 単曲リピートにする場合はシャッフルを OFF にし、原順序を復元する
  if (mode === "one" && appState.get().shuffleMode) {
    appState.set({ shuffleMode: false });
    if (state.origQueue) {
      const curId = state.queue[state.queueIndex]?.id;
      state.queue = state.origQueue.slice();
      let idx = state.queue.findIndex((t) => t.id === curId);
      if (idx < 0) {
        // 現在曲が原キューに見つからない異常時。先頭にフォールバック(挙動は従来と同じ)し警告を残す。
        console.warn("[audio-engine] 単曲リピート移行時に現在曲が原キューに見つかりません。先頭にフォールバックします", curId);
        idx = 0;
      }
      state.queueIndex = idx;
      state.origQueue = null;
      appState.set({ queue: state.queue.map((t) => t.id), queueIndex: state.queueIndex });
    }
  }
  appState.set({ repeatMode: mode });
  // ★ iOS ロック画面挙動を壊す原因になっていたため、audio.loop は使わない。
  //    単曲リピートは onEnded → advanceFromEnded 内で currentTime=0 + play() で実装。
  audioEl.loop = false;
  // 再生モードを設定に永続化する(起動時 app.js が getPublic から復元する契約に対応)。
  //   排他で shuffle/repeat が連動変更されるため確定後の両値を保存する。
  //   setPublic は localStorage への書込のみで音声経路に無関係。
  setPublic({ shuffleMode: appState.get().shuffleMode, repeatMode: appState.get().repeatMode });
  // リピートモード変更で「次曲」の判定が変わる
  //   (one ⇄ all/none で末尾の wrap や同一曲ループ可否が変わる) → プリロード取り直し
  schedulePreload();
}

/**
 * 再生を完全に停止し、キュー・現在曲・MediaSession を初期化する。
 * - 曲削除時 / 全データ削除時に呼ぶ
 */
export function stopPlayback() {
  abortActiveBackgroundCache();
  // ★ 進行中の loadAndPlay (await getBlob/loadedmetadata 中) を無効化する。
  //   transitionToken を進めることで、再開時の stale チェックで中断される
  //   (削除した曲が一瞬再生されたり、currentObjectUrl が再投入されるのを防ぐ)。
  //   transitioning も明示的に false に戻す (in-flight の finally は token 不一致で
  //   解除しないため、ここで確実にリセットしないと立ちっぱなしになる)。
  state.transitionToken++;
  state.transitioning = false;
  // 停止で再生コンテキストが終わるため連続スキップ計数も初期化(次回再生へ持ち越さない)。
  state.consecutiveSkips = 0;

  if (mainAudioEl) {
    try { mainAudioEl.pause(); } catch {}
    try { mainAudioEl.removeAttribute("src"); mainAudioEl.load(); } catch {}
  }
  if (streamAudioEl) {
    try { streamAudioEl.pause(); } catch {}
    try { streamAudioEl.removeAttribute("src"); streamAudioEl.load(); } catch {}
  }
  if (state.currentObjectUrl) {
    if (state.currentObjectUrl.startsWith("blob:")) {
      try { URL.revokeObjectURL(state.currentObjectUrl); } catch {}
    }
    state.currentObjectUrl = null;
  }
  state.isDirectStream = false;
  state.streamFallbackInProgress = false;
  // プリロード済み URL も破棄（リーク防止）
  clearPreload();
  applyKeyShift(0);
  appState.set({ currentKeyShift: 0 });
  // artwork URL は artwork-cache が ID 単位で管理しているため、ここでは
  // 明示 revoke しない（曲削除時 = releaseArtwork で個別に解放される）
  state.queue = [];
  state.queueIndex = -1;
  state.origQueue = null;
  state.userPausedExplicitly = true;
  state.sessionPlayed = 0;
  appState.set({
    currentTrack: null,
    isPlaying: false,
    loadingTrackId: null,
    playbackStatus: "paused",
    duration: 0,
    currentTime: 0,
    queue: [],
    queueIndex: -1,
    scrobbleProgress: 0,
    nowPlayingSent: false,
    scrobbledForCurrent: false,
    scrobbleResult: "none",
    scrobbleReason: null,
    // 再生コンテキスト（どのプレイリストから再生していたか）もクリア
    currentPlaylistId: null,
    currentPlaylistName: null,
  });
  if (navigator.mediaSession) {
    try { navigator.mediaSession.metadata = null; } catch {}
    try { navigator.mediaSession.playbackState = "none"; } catch {}
  }
  clearSessionState();
}

export function getAudioElement() { return activeAudioEl; }
export function getQueue() { return state.queue.slice(); }

/* ============ 内部実装 ============ */

/**
 * loadAndPlay の各 await 後に呼ぶ「世代 stale 判定 + 後始末」ヘルパ。
 *
 * await 中に別の遷移 (rapid playPrev/playNext 連打、ended→次曲、stopPlayback 等)
 * が始まっていたら myToken は最新でなくなる。その場合は自分が作った ownUrl が
 * 既に currentObjectUrl から外れていれば revoke してリークを防ぎ、true を返す。
 * 呼出側は true なら play せず return する。
 *
 * 2 箇所 (loadedmetadata 後 / resumeEqContext 後) で同一ロジックを使うため、
 * 判定と後始末を 1 関数に集約して両者が乖離しないようにする。
 */
function isSupersededTransition(myToken, ownUrl) {
  if (myToken === state.transitionToken) return false;
  // stale: 新しい遷移が currentObjectUrl を別 URL (or null) に置換済みのはず。
  // 自分の URL がもう使われていなければ revoke (二重 revoke は無害)。
  if (state.currentObjectUrl !== ownUrl && ownUrl && ownUrl.startsWith("blob:")) {
    try { URL.revokeObjectURL(ownUrl); } catch {}
  }
  return true;
}

async function loadAndPlay(track, { startTime = 0 } = {}) {
  if (!track) return;
  const t0 = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
  const session = beginPlaybackSession(track, state.queueIndex, startTime);
  const myAttemptId = session.playAttemptId;
  state.currentPlayAttemptId = myAttemptId;

  logPerfMark(track.id, "tap", t0);
  logPerfMark(track.id, "track_resolved", t0);

  // 前曲のバックグラウンドキャッシュが進行中の場合、不要な通信を即座に中断
  abortActiveBackgroundCache();

  setupAudioSession();
  resetSession(track?.id);

  const myToken = ++state.transitionToken;
  state.transitioning = true;
  state.userPausedExplicitly = false;
  state.isDirectStream = false;
  state.streamFallbackInProgress = false;

  appState.set({
    currentTrack: track,
    duration: track.duration || 0,
    currentTime: startTime || 0,
    isPlaying: false,
    loadingTrackId: track?.id || null,
    playbackStatus: "loading",
    scrobbleProgress: 0,
    nowPlayingSent: false,
    scrobbledForCurrent: false,
    scrobbleResult: "none",
    scrobbleReason: null,
  });

  updateMediaSessionMetadata(track);
  updateMediaPositionState({ position: startTime || 0, duration: track.duration });

  // ★ キーチェンジの反映: track から厳格に決定（未設定・null・NaNは必ず 0、前曲の値を流用しない）
  const trackKeyShift = session.requestedKeyShift;
  appState.set({ currentKeyShift: trackKeyShift });

  const pub = getPublic() || {};
  const isEffectsActive = !!pub.enableAudioEffects;
  const isKeyShiftActive = trackKeyShift !== 0;
  const needsWebAudio = isEffectsActive || isKeyShiftActive;

  // ★ Phase 0: 音源 URL / Blob の取得
  let targetUrl = null;
  let blobErr = null;
  let isDirectStream = false;
  let isUncachedDirectStream = false;
  const isDrive = session.isDrive;

  // 1. Prewarm キャッシュにあるか確認
  const prewarmed = prewarmCache.get(track.id);
  if (prewarmed) {
    prewarmCache.delete(track.id);
    if (prewarmed.objectUrl) {
      targetUrl = prewarmed.objectUrl;
    } else if (prewarmed.promise) {
      targetUrl = await prewarmed.promise;
    }
    if (prewarmed.isStream) {
      isDirectStream = true;
      isUncachedDirectStream = true;
      state.isDirectStream = true;
      if (needsWebAudio) notifyUncachedFastStreamOnce();
    }
    if (targetUrl) logPerfMark(track.id, "prewarm_hit", t0);
  }

  // 1.5. インメモリ LRU Blob キャッシュ確認 (キャッシュ済み FLAC/MP3 を 0ms で URL 化)
  if (!targetUrl) {
    const memBlob = getMemoryBlob(track.id);
    if (memBlob) {
      targetUrl = URL.createObjectURL(memBlob);
      logPerfMark(track.id, "memory_lru_hit", t0);
    }
  }

  // 2. 未キャッシュの Google Drive 曲:
  //    EQ または キーチェンジ が有効な場合でも、全量ダウンロード待機をバイパスし、
  //    ダイレクトストリーミング (HTTP Range) で最速で音出しを開始する。
  if (!targetUrl && (isDrive || isDriveTrack(track))) {
    logPerfMark(track.id, "cache_checked", t0);
    const cached = await hasCachedBlob(track.id).catch(() => false);
    session.isCached = cached;
    if (!cached) {
      logPerfMark(track.id, "auth_checked", t0);
      session.activeElement = streamAudioEl;
      setActiveAudioElement(streamAudioEl);
      try {
        let token = await getDriveToken();
        if (!token) {
          // 未連携またはトークンなし: 再生を保留し、pending state を記録
          setPendingPlayback(track, state.queue, state.queueIndex);
          // ユーザー操作による再連携待ちの間、無音ループを一時解除してモーダルを表示
          try { audioEl.pause(); } catch {}
          token = await promptDriveReconnectModal({ track });
          if (!token) {
            clearPendingPlayback();
            // ユーザーがキャンセルした場合は勝手に次曲へスキップせず停止状態で待機
            if (myToken === state.transitionToken) {
              state.transitioning = false;
              session.playbackStatus = "paused";
              appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "paused" });
              if (navigator.mediaSession) {
                try { navigator.mediaSession.playbackState = "none"; } catch {}
              }
            }
            return;
          }
          clearPendingPlayback();
          primeAudioElement(streamAudioEl);
        }
        // ダイレクトストリーミング URL を取得して即座に再生開始（FLAC 全量 DL を待たない）
        const streamUrl = await getDriveStreamUrl(track.id, token);
        if (streamUrl) {
          targetUrl = streamUrl;
          isDirectStream = true;
          isUncachedDirectStream = true;
          state.isDirectStream = true;
          session.sourceType = "drive_stream";
          logPerfMark(track.id, "stream_url_ready", t0);
          if (needsWebAudio) {
            notifyUncachedFastStreamOnce();
          }
        } else {
          throw new Error("ストリームURLの取得に失敗しました");
        }
      } catch (driveErr) {
        console.warn("[audio-engine] Drive ストリーム準備失敗:", driveErr);
        if (myToken === state.transitionToken) {
          state.transitioning = false;
          session.playbackStatus = "error";
          appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "error" });
          toast(driveErr.message || "Google Drive の曲を読み込めませんでした", "err", 4000);
        }
        return; // ★ 再生失敗時に全量 getBlob へフォールバックしない（通信量・負荷爆発防止）
      }
    }
  }

  // 3. 音源 Blob 取得 (ローカル曲、キャッシュ済み Drive 曲)
  if (!targetUrl && !isUncachedDirectStream) {
    logPerfMark(track.id, "getBlob_start", t0);
    let blob = await getBlob(track.id).catch((e) => {
      console.warn("[audio-engine] getBlob 失敗", track.id, e);
      blobErr = e;
      return null;
    });
    logPerfMark(track.id, "getBlob_done", t0);
    // Drive 曲で 401 / 未接続エラーだった場合は、スキップせずその場で再連携モーダルを出して再試行
    if (!blob && isDriveTrack && blobErr && /401|接続されていません|期限/.test(blobErr.message || "")) {
      try {
        try { audioEl.pause(); } catch {}
        const newToken = await promptDriveReconnectModal({ track, reason: blobErr.message });
        if (!newToken) {
          if (myToken === state.transitionToken) {
            state.transitioning = false;
            appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "paused" });
            if (navigator.mediaSession) {
              try { navigator.mediaSession.playbackState = "none"; } catch {}
            }
          }
          return;
        }
        primeAudioElement();
        blobErr = null;
        blob = await getBlob(track.id).catch((e) => {
          blobErr = e;
          return null;
        });
      } catch (_) {}
    }
    if (blob) {
      targetUrl = URL.createObjectURL(blob);
    }
  }

  // 待機中にユーザーが別の曲をタップしていた場合は、古い遷移を破棄して終了
  if (isSupersededTransition(myToken, targetUrl)) {
    return;
  }

  if (!targetUrl) {
    state.transitioning = false;
    appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "error" });
    if (navigator.mediaSession) {
      try { navigator.mediaSession.playbackState = "none"; } catch {}
    }
    try {
      audioEl.pause();
      audioEl.loop = false;
      audioEl.src = "";
    } catch {}
    console.warn("音源データ未発見", track.id);
    const reason = (blobErr && blobErr.message) ? blobErr.message : "ファイル本体が見つかりません";
    await skipToNextOnError(reason, track);
    return;
  }

  const clearTransitioning = () => {
    if (myToken === state.transitionToken) state.transitioning = false;
  };

  try {
    // === Phase 1〜2: URL 差替 & 即座に play() ===
    // ★ 注意: await getBlob の後に audioEl.pause() を呼んではいけない。
    //   primeAudioElement() が無音 WAV ループで維持している iOS の再生アクティブ状態を
    //   非同期コンテキストで pause() すると User Gesture 権限が失われ、直後の play() が
    //   NotAllowedError でブロックされて「2回タップしないと流れない」原因になる。
    // primeAudioElement の play() が実行中の場合、WebKit の AbortError (interrupted by load request) を
    // 防ぐため、play() の settle を待機してから src を差し替える。
    if (isUncachedDirectStream) {
      setActiveAudioElement(streamAudioEl);
    } else {
      setActiveAudioElement(mainAudioEl);
    }

    if (primePromise) {
      try {
        await primePromise;
      } catch (_) {}
      primePromise = null;
    }

    const oldUrl = state.currentObjectUrl;
    state.currentObjectUrl = targetUrl;
    audioEl.src = targetUrl;
    logPerfMark(track.id, "audio_src_set", t0);

    const onMeta = () => { logPerfMark(track.id, "loadedmetadata", t0); audioEl.removeEventListener("loadedmetadata", onMeta); };
    const onCanPlay = () => { logPerfMark(track.id, "canplay", t0); audioEl.removeEventListener("canplay", onCanPlay); };
    let bgCacheTriggered = false;
    const triggerBgCache = () => {
      if (bgCacheTriggered) return;
      bgCacheTriggered = true;
      if (isUncachedDirectStream && isDriveTrack && myToken === state.transitionToken) {
        startBackgroundDriveCache(track.id, t0);
      }
    };
    const onPlaying = () => {
      logPerfMark(track.id, "playing", t0);
      clearPlayingWatchdog();
      if (session) {
        session.playingAt = Date.now();
        session.playbackStatus = "playing";
      }
      if (isPerfDebugEnabled()) {
        console.log(`[AudioPerf] [${track.id}] tap → playing: +${(performance.now() - t0).toFixed(1)}ms`);
      }
      audioEl.removeEventListener("playing", onPlaying);
      if (myToken === state.transitionToken) {
        appState.set({ isPlaying: true, loadingTrackId: null, playbackStatus: "playing" });
        if (navigator.mediaSession) {
          navigator.mediaSession.playbackState = "playing";
        }
      }
      triggerBgCache();
      hydrateTrackMetadata(track.id);
      schedulePreload();
      updateTrack(track.id, {
        playCount: (track.playCount || 0) + 1,
        lastPlayedAt: Date.now(),
      }).catch(() => {});

      // ★ 無音検知と安全な自動復旧（Web Audio 接続時の無音化防止・1セッション最大1回）
      if (!session.isStale && session.activeElement === mainAudioEl && needsWebAudio && !session.hasRecoveredSilence) {
        session.silenceCheckTimer = setTimeout(() => {
          if (session.isStale || session !== activePlaybackSession) return;
          const curAudio = getAudioElement();
          if (!curAudio || curAudio !== mainAudioEl || curAudio.paused) return;
          if (curAudio.volume <= 0 || curAudio.muted) return;
          if (curAudio.currentTime < 2.0) return;
          if (curAudio.readyState < 2) return; // buffer underrun 除外

          const rms = getOutputRms();
          if (rms === 0) {
            console.warn(`[audio-engine] Web Audio 無音状態を検知。自動復旧を実行します (1/1):`, session.trackId);
            session.hasRecoveredSilence = true;
            try {
              recreateAudioContext(mainAudioEl);
              const curPos = curAudio.currentTime;
              applyKeyShift(session.appliedKeyShift, mainAudioEl);
              curAudio.currentTime = curPos;
              curAudio.play().catch((recErr) => {
                console.warn("[audio-engine] 無音復旧 play 失敗:", recErr);
                handlePlaybackFinalFailure(session.playAttemptId, session.track, recErr);
              });
            } catch (recErr) {
              console.warn("[audio-engine] 無音復旧例外:", recErr);
              handlePlaybackFinalFailure(session.playAttemptId, session.track, recErr);
            }
          }
        }, 5000);
      }
    };
    audioEl.addEventListener("loadedmetadata", onMeta);
    audioEl.addEventListener("canplay", onCanPlay);
    audioEl.addEventListener("playing", onPlaying);

    audioEl.loop = false;
    audioEl.playbackRate = getEffectivePlaybackRate();
    applyTrackVolume(audioEl, track);

    if (startTime > 0) {
      try { audioEl.currentTime = startTime; } catch {}
    }

    if (isUncachedDirectStream) {
      // ★ 未キャッシュGoogle Driveダイレクトストリーム時:
      // CORS制約による無音化を防ぐため、初回再生時はWeb Audio APIをバイパス
      session.appliedKeyShift = 0;
      applyKeyShift(0, streamAudioEl);
      appState.set({ currentKeyShift: 0 });
      if (needsWebAudio) {
        notifyUncachedFastStreamOnce();
      }
    } else {
      // キャッシュ済み曲またはローカル曲: 安全にWeb Audioを接続 (mainAudioEl)
      // ★ 新曲の Track.keyShift を必ず反映（0 の場合も Worklet リセット＆完全バイパス化）
      session.appliedKeyShift = trackKeyShift;
      applyKeyShift(trackKeyShift, mainAudioEl);
      appState.set({ currentKeyShift: trackKeyShift });
      if (pub.enableAudioEffects && mainAudioEl) {
        try { applyEffectsSetting(mainAudioEl, true); } catch (_) {}
      }
      resumeEqContext().catch(() => {});
    }

    // getBlob 中にバックグラウンドメタデータ補完が走った可能性があるため最新 track を取得
    const latestTrack = state.queue[state.queueIndex]?.id === track.id
      ? state.queue[state.queueIndex]
      : (appState.get().currentTrack?.id === track.id ? appState.get().currentTrack : track);

    appState.set({
      currentTrack: latestTrack,
      duration: latestTrack.duration || 0,
      currentTime: startTime || 0,
    });

    // === play() の前に MediaSession を即座に同期設定 ===
    updateMediaSessionMetadata(latestTrack);
    updateMediaPositionState({ position: startTime || 0, duration: latestTrack.duration });

    logPerfMark(track.id, "play_called", t0);
    logPlaybackEvent("play_called", { targetEl: audioEl, track, attemptId: myAttemptId });
    if (isPerfDebugEnabled()) {
      console.log(`[AudioPerf] [${track.id}] tap → play_called: +${(performance.now() - t0).toFixed(1)}ms`);
    }

    startPlayingWatchdog(myAttemptId, track, startTime, isDirectStream);

    state.userPausedExplicitly = false;
    try {
      const p = audioEl.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          logPerfMark(track.id, "play_resolved", t0);
          logPlaybackEvent("play_resolved", { targetEl: audioEl, track, attemptId: myAttemptId, playPromiseResult: "resolved" });
          clearTransitioning();
          state.consecutiveSkips = 0;
          if (startTime > 0) {
            try { audioEl.currentTime = startTime; } catch {}
          }
        }).catch(async (err) => {
          logPlaybackEvent("play_rejected", { targetEl: audioEl, track, attemptId: myAttemptId, error: err, playPromiseResult: `rejected: ${err?.name || err?.message || err}` });
          clearTransitioning();
          clearPlayingWatchdog();
          console.warn("[audio-engine] play 失敗", err);
          if (err?.name === "AbortError" && !state.userPausedExplicitly && appState.get().currentTrack?.id === track.id) {
            try {
              await new Promise((r) => setTimeout(r, 60));
              if (!state.userPausedExplicitly && appState.get().currentTrack?.id === track.id) {
                await audioEl.play();
                state.consecutiveSkips = 0;
              }
            } catch (retryErr) {
              if (myToken === state.transitionToken) {
                handlePlaybackFinalFailure(myAttemptId, track, retryErr);
              }
            }
          } else {
            handlePlaybackFinalFailure(myAttemptId, track, err);
          }
        });
      } else {
        clearTransitioning();
        state.consecutiveSkips = 0;
        if (startTime > 0) {
          try { audioEl.currentTime = startTime; } catch {}
        }
      }
    } catch (err) {
      clearTransitioning();
      clearPlayingWatchdog();
      console.warn("[audio-engine] play 例外", err);
      handlePlaybackFinalFailure(myAttemptId, track, err);
    }

    // 保険: promise が解決しない異常時でも 1.5 秒後に transitioning を解除
    setTimeout(clearTransitioning, 1500);

    // 旧 URL は再生が新 URL に確実に移ってから遅延 revoke
    if (oldUrl && oldUrl !== targetUrl && oldUrl.startsWith("blob:")) {
      setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch {} }, 2000);
    }
  } finally {
    // 状態更新は onPlaying または catch で確定済み
  }
}

/**
 * 「ファイル本体が見つからない (blob = null)」確定エラー時の次曲スキップ。
 *
 * 現在この関数を呼ぶのは loadAndPlay 内の `getBlob() → null` パスのみ。
 * audio.error / play() 失敗 では呼ばない (iOS バックグラウンド再生中に
 * 一過性で発火する誤検知で連鎖スキップする不具合を防ぐため。
 * GitHub の mp3player は audio.error/play 失敗時にスキップせず、
 * ログのみで再生継続する仕様)。
 *
 * シャッフル再生やプレイリスト再生中に 1 曲だけ blob が消失している等の
 * 確定的なエラー時、ended イベントが発火せず再生全体が止まる問題への対策。
 *
 * 無限ループ防止のため、連続スキップ回数が MAX_CONSECUTIVE_SKIPS を
 * 超えたら停止して toast で通知する。
 */
async function skipToNextOnError(reason, failedTrack) {
  state.consecutiveSkips++;
  if (state.consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
    console.warn(`連続 ${state.consecutiveSkips} 曲スキップで停止: ${reason}`);
    state.consecutiveSkips = 0;
    appState.set({ isPlaying: false });
    try { toast("複数曲の読み込みに失敗しました。再生を停止します。", "err"); } catch {}
    return;
  }
  console.warn(`スキップ (${state.consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}): ${reason}`, failedTrack?.id);
  try {
    const t = (failedTrack && failedTrack.title) || "(無題)";
    toast(`「${t}」を再生できずスキップしました（${reason}）`, "info");
  } catch {}
  // 自然遷移と同じ経路で次曲決定 / 停止判定を委ねる
  // (repeat="one" でも次曲に進むのが意図に合う。元の曲が読み込めないため)
  // → repeat="one" の場合は、advanceFromEnded がループしようとするので
  //   キュー末尾なら停止する分岐を直接ここで実装する。
  if (state.queue.length === 0) {
    appState.set({ isPlaying: false });
    return;
  }
  const repeat = appState.get().repeatMode;
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (repeat === "all") {
      next = 0;
    } else {
      // キュー末尾でスキップしようとした → 停止
      appState.set({ isPlaying: false, currentPlaylistId: null, currentPlaylistName: null });
      return;
    }
  }
  state.queueIndex = next;
  appState.set({ queueIndex: next });
  const t = state.queue[next];
  if (t) await loadAndPlay(t);
}

/**
 * 新しい audio.src に対する loadedmetadata イベントを待つ。
 *
 * ★ 重要: ここで `audioEl.readyState >= 1` の早期 return をしてはいけない。
 *
 *    audio.src を変えた直後の readyState は、ブラウザが内部状態を
 *    リセットする「前」は前トラックの値（例: HAVE_METADATA = 1）を
 *    引きずったままになるため、即座に resolve すると
 *    audio.duration がまだ前トラックの値（例: Bravo の 1秒）のまま
 *    setPositionState を呼んでしまう。
 *    その状態で新トラック（例: Alpha 2秒）を再生開始すると、iOS は
 *    「duration=1 の曲を再生中」と認識し、ロック画面進捗バーが
 *    100%（MAX）/ 50% / 40% などにずれる原因になっていた。
 *
 *  対策: 常に loadedmetadata / error イベントの発火を待つ。
 *        blob URL の場合 audio.load() を呼んだ後に必ず loadedmetadata が
 *        発火するため、フォアグラウンドでは待ち時間も最小限。
 *
 *  タイムアウト: 8 秒
 *        iOS Safari のロック画面再生中、loadedmetadata の発火が
 *        3 秒以上遅延するケースが実機で確認された。短すぎる timeout で
 *        中断して play() を呼ぶと audio 内部が未準備のまま「再生中だが
 *        無音」状態になり、ロック画面解除まで音が出なくなる不具合の
 *        原因になっていた。
 *        通常時は数十 ms で loadedmetadata が発火するので、8 秒に
 *        延長してもフォアグラウンド動作には影響しない (発火即時 resolve)。
 */
function waitForLoadedMetadata(timeoutMs = 3000) {
  // すでにメタデータ取得済み (HAVE_METADATA 以上) ならイベントを待たずに即時解決
  if (audioEl.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      audioEl.removeEventListener("loadedmetadata", finish);
      audioEl.removeEventListener("error", finish);
      resolve();
    };
    audioEl.addEventListener("loadedmetadata", finish, { once: true });
    audioEl.addEventListener("error", finish, { once: true });
    // 万一 loadedmetadata が発火しないケース（ファイル破損等）の保険
    setTimeout(finish, timeoutMs);
  });
}

function resetSession(trackId) {
  state.sessionStartedAt = Date.now();
  state.sessionPlayed = 0;
  state.lastTickAt = state.sessionStartedAt;
  state.hasScrobbledSession = false;
  state.playSessionId = `${trackId || "track"}_${state.sessionStartedAt}_${Math.random().toString(36).slice(2, 8)}`;
}

function onPlay() {
  const isLoading = !!appState.get().loadingTrackId;
  if (!isLoading) {
    appState.set({ isPlaying: true, playbackStatus: "playing" });
    if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
  }
  state.lastTickAt = Date.now();
  ensureMediaSessionActions();
  saveSessionState();
}

function onPlaying() {
  appState.set({
    isPlaying: true,
    loadingTrackId: null,
    playbackStatus: "playing",
  });
  state.lastTickAt = Date.now();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
  ensureMediaSessionActions();
  saveSessionState();
}

function onPause() {
  flushSessionPlayed();

  // ★ 遷移中 (loadAndPlay 内の src 切替に伴う audioEl.pause() 呼出) は
  //   外部に「pause された」と通知してはいけない。
  if (state.transitioning) return;

  appState.set({ isPlaying: false, loadingTrackId: null, playbackStatus: "paused" });

  // ユーザー明示pause(ロック画面/アプリ内)は playbackState="paused" を設定して、
  // ロック画面に一時停止状態(再生ボタン表示・進捗停止)を正しく反映させる。
  if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
  saveSessionState();
}

function flushSessionPlayed() {
  const now = Date.now();
  if (state.lastTickAt && !audioEl.paused) {
    // ★ 再生速度を乗じて「曲コンテンツの再生秒数」を積算する。
    state.sessionPlayed += ((now - state.lastTickAt) / 1000) * (audioEl.playbackRate || 1);
  }
  state.lastTickAt = now;
}

let lastTimeUpdateUiAt = 0;

function onTimeUpdate() {
  if (audioEl.src && audioEl.src.startsWith("data:audio/wav")) return;
  flushSessionPlayed();
  const track = appState.get().currentTrack;
  if (!track) return;

  const realAudioDur = (isFinite(audioEl.duration) && audioEl.duration > 0.5) ? audioEl.duration : 0;
  if (realAudioDur > 0 && (!track.duration || isSuspectPartialHeaderDuration(track) || Math.abs(track.duration - realAudioDur) > 1.5)) {
    track.duration = realAudioDur;
    appState.set({ duration: realAudioDur });
    updateTrack(track.id, { duration: realAudioDur }).catch(() => {});
  }
  const dur = realAudioDur > 0
    ? realAudioDur
    : (isSuspectPartialHeaderDuration(track)
      ? Math.round(track.duration * (track.fileSize / 1572864))
      : (track.duration || 0));
  const cur = audioEl.currentTime || 0;

  // ★ 終端フォールバック (End-of-track fallback)
  // Google Drive Range ストリーミングや一部ブラウザで ended イベントが
  // ドロップした場合（曲末尾 0.45 秒以内で再生が停滞）、確実に次曲へ進める
  const session = activePlaybackSession;
  if (session && !session.endedHandled && !session.nextTransitionStarted && !state.userPausedExplicitly && !state.transitioning && isFinite(dur) && dur > 1.0 && cur >= dur - 0.45 && !audioEl.paused) {
    session.endedHandled = true;
    session.nextTransitionStarted = true;
    onEnded();
    return;
  }

  // ★ UI更新のスロットリング (200ms間引き) で描画負荷を大幅軽減
  const now = Date.now();
  if (now - lastTimeUpdateUiAt >= 200 || cur === 0 || cur >= dur - 0.5) {
    lastTimeUpdateUiAt = now;
    appState.set({ currentTime: cur });
  }

  // 周期的に position state を更新（iOS のロック画面プログレスバーと
  // セッション維持のため）。timeupdate は ~250ms 間隔で発火するが、
  // ~1 秒間隔に間引く。
  // ★ 遷移中 (loadAndPlay 内で audio が一瞬動いている可能性) は更新しない。
  if (!state.transitioning && now - state.lastPositionUpdateAt > 1000) {
    updateMediaPositionState();
    state.lastPositionUpdateAt = now;
  }

  // 5秒ごとに再生位置を保存 (不意のタスクキルでも最新位置を復元可能にする)
  if (!state.lastSessionSaveAt || now - state.lastSessionSaveAt > 5000) {
    saveSessionState();
    state.lastSessionSaveAt = now;
  }

  // ★ 次曲プリロード監視 (Preload Watchdog)
  // アルバム等で 1曲目が終わる前に 100% 確実に次曲の Object URL を待機させ、
  // ended 発火時に同期高速パス（playPreloadedSync）でギャップレスに2曲目へ進ませる
  if (!state.preloadUrl && !state.preloadingId && computeNextIndex() >= 0) {
    schedulePreload();
  }

  if (!appState.get().nowPlayingSent && cur >= 1) {
    appState.set({ nowPlayingSent: true });
    if (state.onNowPlaying) state.onNowPlaying(track);
  }

  // Last.fm 公式仕様: スクロブル対象は「30秒を超える」曲のみ ("The track must be
  // longer than 30 seconds.")。30.0 秒ちょうどは対象外のため >= ではなく > で判定する。
  if (dur > 30) {
    const ratio50 = Math.min(1, state.sessionPlayed / (dur * 0.5));
    const ratio4m = Math.min(1, state.sessionPlayed / (4 * 60));
    const progress = Math.max(ratio50, ratio4m);
    if (now - lastTimeUpdateUiAt <= 50 || progress >= 1) {
      appState.set({ scrobbleProgress: progress });
    }

    if (!state.hasScrobbledSession && !appState.get().scrobbledForCurrent && progress >= 1) {
      // ★ 同期ロックフラグを即座にセット（非同期処理前の最初の1行目で多重発火を完全防止）
      state.hasScrobbledSession = true;
      appState.set({ scrobbledForCurrent: true, scrobbleResult: "sending" });

      if (state.onScrobble) {
        state.onScrobble(track, dur, state.sessionStartedAt, state.playSessionId);
      }
      recordHistory({
        trackId: track.id,
        startedAt: state.sessionStartedAt,
        durationListened: state.sessionPlayed,
        scrobbled: true,
      }).catch((e) => console.warn("[audio-engine] recordHistory 失敗", e));
    }
  }
}

function onEnded() {
  if (state.transitioning) return;
  if (audioEl.src && audioEl.src.startsWith("data:audio/wav")) return;

  const session = activePlaybackSession;
  if (session) {
    if (session.endedHandled && session.nextTransitionStarted) return;
    session.endedHandled = true;
    session.nextTransitionStarted = true;
  }

  if (!appState.get().scrobbledForCurrent) {
    const track = appState.get().currentTrack;
    if (track) {
      recordHistory({
        trackId: track.id,
        startedAt: state.sessionStartedAt,
        durationListened: state.sessionPlayed,
        scrobbled: false,
      }).catch((e) => console.warn("[audio-engine] recordHistory 失敗", e));
    }
  }
  // ユーザが明示的に pause していた場合は自動進行しない。
  // 「ロック画面 pause タップ」と「曲の自然終了 (ended)」が同時に発生した際に
  // 別の曲に切り替わる競合バグを防ぐ。
  if (state.userPausedExplicitly) return;

  // 自然終了は「ユーザが明示pause」ではない
  state.userPausedExplicitly = false;
  // 自然終了専用の遷移ロジック（repeat="one" ならループ）
  advanceFromEnded();
}

function shuffleCurrentQueue() {
  if (state.queue.length <= 1) return;
  const curId = state.queue[state.queueIndex]?.id;
  if (!state.origQueue) state.origQueue = state.queue.slice();
  const rest = state.queue.filter((t) => t.id !== curId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const cur = state.queue[state.queueIndex];
  state.queue = cur ? [cur, ...rest] : rest;
  state.queueIndex = 0;
  appState.set({ queue: state.queue.map((t) => t.id), queueIndex: 0 });
}

/* ============ メディアセッション ============ */

/**
 * Audio Session API でブラウザに「playback (音楽再生)」セッションを宣言する。
 *
 * MDN: https://developer.mozilla.org/en-US/docs/Web/API/AudioSession
 *
 * 各タイプの意味:
 *   - "playback":     音楽・動画再生。他のオーディオと混在しない (本アプリ)
 *   - "auto":         デフォルト。ブラウザが推測
 *   - "transient":    通知音など短い音
 *   - "ambient":      他のオーディオと混在可能
 *   - "play-and-record": ビデオ会議など
 *
 * iOS 16.4+ Safari でサポート。設定しても害はないので、対応していれば必ず設定する。
 * 未対応環境 (navigator.audioSession === undefined) では feature detection で skip。
 *
 * iOS Safari でこれを設定する効果:
 *   - audio session を「長時間再生される音楽」として扱う
 *   - バックグラウンド・ロック画面再生中に audio session が早期解放されにくくなる
 *   - 他のアプリの一時的な音 (通知音等) と区別される
 */
function setupAudioSession() {
  if (typeof navigator === "undefined") return;
  if (!navigator.audioSession) return;
  try {
    navigator.audioSession.type = "playback";
  } catch (e) {
    // type プロパティが setter として動かない実装でも害なく無視
    console.warn("[audio-engine] audioSession.type 設定失敗", e);
  }
}

/* ============ 再開ウォッチドッグ (iOS コールドスタート対策) ============ */

// 再開要求から進行確認までの待ち時間と、自動再試行の上限回数。
// iPhone 実機の観測では「1 回目の再開操作は失敗するが、2 回目の操作は成功する」
// ため、1 回の自動再試行でほぼ回復する。保険としてもう 1 回だけ試す(計 2 回)。
const RESUME_WATCHDOG_DELAY_MS = 1000;
const RESUME_WATCHDOG_MAX_RETRY = 2;

/**
 * 再開ウォッチドッグの解除。
 * ユーザの明示 pause / stop の際に呼び、保留中の自動再試行が
 * ユーザの意思(停止したい)を覆して再生してしまうのを防ぐ。
 */
function clearResumeWatchdog() {
  if (state.resumeWatchdogTimer) {
    clearTimeout(state.resumeWatchdogTimer);
    state.resumeWatchdogTimer = null;
  }
}

/**
 * play() 要求後に「実際に再生が進んだか」を監視し、進んでいなければ
 * ユーザが手動で行うと成功する「pause → play のやり直し」を自動で再現する。
 *
 * 背景 (iPhone 実機で確認された不具合):
 *   PWA の初回起動直後や長期間未使用後のコールドスタートでは、iOS の
 *   audio session 登録が冷えており、ロック画面・ワイヤレスイヤホン等の
 *   リモートコマンド(MediaSession)から最初に再開を要求したときの
 *   audioEl.play() が「reject される」か「resolve するのに無音のまま進行
 *   しない」状態になる (WebKit / AVAudioSession 再活性化の既知挙動)。
 *   失敗した 1 回目の試行自体がセッション再活性化を促すため 2 回目の操作は
 *   成功する。本ウォッチドッグはその「2 回目の操作」を自動化するもの。
 *
 * デグレ防止の設計:
 *   - 正常に再生が進んだ場合は読み取りチェックのみで何もしない (no-op)。
 *   - ユーザの明示 pause / 曲遷移中 / 自然終了 / 曲変更 / 位置の大幅な巻き
 *     戻り(単曲リピートのループバック等)を検知したら即座に身を引き、
 *     既存のロック画面・自動遷移ロジックには一切干渉しない。
 *   - MediaSession の metadata / playbackState / positionState には触れない
 *     (再試行中の pause()/play() が発火させる既存の onPause/onPlay に委ねる)。
 *
 * @param {number} retryCount これまでに実施した自動再試行の回数
 */
function armResumeWatchdog(retryCount = 0) {
  clearResumeWatchdog();
  const baseTime = audioEl.currentTime || 0;
  const baseTrackId = appState.get().currentTrack?.id || null;
  state.resumeWatchdogTimer = setTimeout(() => {
    state.resumeWatchdogTimer = null;
    // --- 身を引くべき状況(他のロジックの管轄・状況が変わった) ---
    if (state.userPausedExplicitly) return;  // その後ユーザが明示 pause した
    if (state.transitioning) return;          // 曲切替中 (loadAndPlay 等の管轄)
    if (audioEl.ended) return;                // 自然終了 (ended → 次曲ロジックの管轄)
    const curId = appState.get().currentTrack?.id || null;
    if (!curId || curId !== baseTrackId) return; // 監視開始時から曲が変わった
    const now = audioEl.currentTime || 0;
    if (now + 1 < baseTime) return;           // 大幅な巻き戻り = ループ/シーク等が介入
    // --- 進行確認: 再生中かつ currentTime が進んでいれば正常 ---
    const progressed = now > baseTime + 0.1;
    if (!audioEl.paused && progressed) return;
    if (retryCount >= RESUME_WATCHDOG_MAX_RETRY) {
      console.warn("[audio-engine] 再開リトライ上限に到達。自動回復を断念しました(もう一度操作してください)");
      return;
    }
    console.warn(`[audio-engine] 再開後に進行なし(paused=${audioEl.paused})。pause→play を自動再試行 ${retryCount + 1}/${RESUME_WATCHDOG_MAX_RETRY}`);
    // audio session の再アクティブ化を改めて要求してから、
    // ユーザの「2 回目の操作」(pause → play) を再現する。
    setupAudioSession();
    // セッションアクティベータも resume を試みる(タイマ文脈のため await しない。
    // 拒否されても resumeSessionActivator 内部で warn 処理され再試行は続行する)
    resumeSessionActivator();
    if (!audioEl.paused) {
      try { audioEl.pause(); } catch {}
    }
    // pause 直後の play を iOS が無視することがあるため、わずかに間を置く
    setTimeout(() => {
      if (state.userPausedExplicitly || state.transitioning) return;
      state.userPausedExplicitly = false;
      try {
        const p = audioEl.play();
        if (p && typeof p.catch === "function") {
          p.catch((e) => console.warn("[audio-engine] 再開リトライの play 失敗", e));
        }
      } catch (e) {
        console.warn("[audio-engine] 再開リトライの play 例外", e);
      }
      armResumeWatchdog(retryCount + 1);
    }, 60);
  }, RESUME_WATCHDOG_DELAY_MS);
}

/* ============ セッションアクティベータ (iOS「進捗は進むが無音」の根治) ============ */

// 何も接続していない素の AudioContext。
// resume() すると iOS の AVAudioSession が再アクティブ化される性質だけを利用する。
let sessionActivatorCtx = null;

/**
 * iOS の audio session を再アクティブ化する。
 *
 * 背景 (iPhone 実機で確認された不具合):
 *   コールドスタート(初回起動/長期未使用後)の最初のリモート再開(ロック画面/
 *   イヤホン)は、素の audioEl.play() だと「ロック画面の進捗バーは進む(=iOS の
 *   外挿表示)のに実際の currentTime は凍結し無音」になる。pause 時に iOS が
 *   audio session を抑制し、バックグラウンドの JS play() ではセッションが
 *   再活性化されないため。audioSession.type="playback" の再宣言、load() での
 *   パイプライン再確立、pause→play の自動再試行のいずれでも復活しないことを
 *   実機で確認済み (フォアグラウンドの play() なら復活する)。
 *
 * 根拠 (ベースアプリ mp3player の実証):
 *   本アプリの元になった mp3player では本不具合が発生しない。決定的な差分は、
 *   再生再開のたびに decode 用 AudioContext を `await ctx.resume()` している
 *   点で、これが AVAudioSession を再活性化していた。AudioContext は audio
 *   要素に一切接続しなくても、resume() がセッションを起こす効果を持つ。
 *
 * デグレ防止の設計:
 *   - この AudioContext には何も接続しない (createMediaElementSource を呼ばない)。
 *     音声経路は従来どおり「audio 要素 → 端末出力」のままで、要素の出力・
 *     ロック画面挙動には干渉しない (ベースアプリで長期実績のある構成)。
 *   - 生成はユーザー操作起点 (setQueueAndPlay / togglePlay / リモート play)。
 *   - resume() は suspended / interrupted のときだけ呼ぶ。失敗しても再生処理は
 *     続行する (warn のみ)。
 */
async function resumeSessionActivator() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!sessionActivatorCtx) {
      sessionActivatorCtx = new AC();
    }
    // iOS Safari は通話・Siri・セッション抑制などで "interrupted"(独自状態) になる
    const st = sessionActivatorCtx.state;
    if (st === "suspended" || st === "interrupted") {
      await sessionActivatorCtx.resume();
    }
  } catch (e) {
    console.warn("[audio-engine] session activator resume 失敗", e);
  }
}

export function ensureMediaSessionActions() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    // 1. seekbackward / seekforward の明示的無効化
    //    iOS WebKit はこれらが登録されているとポッドキャストと判定し、
    //    previoustrack / nexttrack ボタンを隠して10秒スキップボタンにしてしまう
    try {
      navigator.mediaSession.setActionHandler("seekbackward", null);
      navigator.mediaSession.setActionHandler("seekforward", null);
    } catch {}

    // 2. previoustrack / nexttrack の常時有効登録
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());

    // 3. seekto (シークバー操作用)
    try {
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (d && d.seekTime != null) seekTo(d.seekTime);
      });
    } catch {}

    // 4. play / pause は「discrete」: toggle しない、純粋に play / pause のみ
    navigator.mediaSession.setActionHandler("play", async () => {
      if (!appState.get().currentTrack) {
        await autoStartFirstTrack();
        return;
      }
      state.userPausedExplicitly = false;
      setupAudioSession();
      await resumeSessionActivator();
      armResumeWatchdog();
      try {
        await audioEl.play();
      } catch (e) {
        console.warn("[audio-engine] remote play 失敗(ウォッチドッグが再試行します)", e);
      }
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      state.userPausedExplicitly = true;
      clearResumeWatchdog();
      if (mainAudioEl) { try { mainAudioEl.pause(); } catch {} }
      if (streamAudioEl) { try { streamAudioEl.pause(); } catch {} }
    });

    try {
      navigator.mediaSession.setActionHandler("stop", () => {
        state.userPausedExplicitly = true;
        clearResumeWatchdog();
        if (mainAudioEl) { try { mainAudioEl.pause(); } catch {} }
        if (streamAudioEl) { try { streamAudioEl.pause(); } catch {} }
      });
    } catch {}
  } catch (e) {
    console.warn("[audio-engine] ensureMediaSessionActions 失敗", e);
  }
}

function setupMediaSession() {
  ensureMediaSessionActions();
}

/**
 * 終了系イベントのクリーンアップ
 *
 * === iOS ロック画面挙動を絶対に壊さない設計に転換 ===
 *
 * 以前は pagehide(persisted=false) で MediaSession.metadata=null 等を行い、
 * 「PWA終了後にロック画面に曲情報が残る」事象を防いでいた。
 * しかし iOS Safari は以下の条件下で **lock screen で一時停止しただけでも**
 * pagehide(persisted=false) を発火することがあり、その都度メタデータが
 * 巻き込まれて消える（曲名・アートワーク消失、"一時停止"のみ表示）バグが
 * 再現することが分かった。
 *
 *   - キューリピート (repeat="all") で audio.src の切替が発生したあと
 *   - 単曲リピートも条件次第で発生
 *
 * persisted フラグも iOS では非決定的で「true のときも false のときも」あり
 * 信頼できる切り分けに使えない。
 *
 * よって統合前 mp3player と同じく、pagehide 系の明示クリーンアップは
 * 廃止する。iOS は PWA が真に終了したときには JS context 破棄に伴い
 * MediaSession を自動的に片付ける。
 */
const SESSION_STORAGE_KEY = "music_player_session";

/**
 * 現在の再生セッション（現在曲、キュー、再生位置、プレイリスト情報）を localStorage に保存する
 */
export function saveSessionState() {
  try {
    const curTrack = appState.get().currentTrack;
    if (!curTrack || !state.queue.length) return;
    const session = {
      trackId: curTrack.id,
      queueIds: state.queue.map((t) => t.id),
      origQueueIds: state.origQueue ? state.origQueue.map((t) => t.id) : null,
      shuffleMode: appState.get().shuffleMode,
      repeatMode: appState.get().repeatMode,
      queueIndex: state.queueIndex,
      currentTime: Math.floor(audioEl?.currentTime || appState.get().currentTime || 0),
      currentPlaylistId: appState.get().currentPlaylistId || null,
      currentPlaylistName: appState.get().currentPlaylistName || null,
      updatedAt: Date.now(),
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {}
}

/**
 * 再生セッション保存を削除する（stopPlayback 時）
 */
export function clearSessionState() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {}
}

/**
 * アプリ起動時に前回の再生セッション（キューと曲）を復元する
 * - 画面をタスクキル・再読み込みした際にも直前の曲とキューを即座に再表示
 */
export async function restoreSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return false;
    const session = JSON.parse(raw);
    if (!session || !session.trackId || !Array.isArray(session.queueIds) || session.queueIds.length === 0) {
      return false;
    }
    // 既に再生中の曲がある場合は上書きしない
    if (appState.get().currentTrack) return false;

    const allTracks = await getAllTracks();
    const trackMap = new Map(allTracks.map((t) => [t.id, t]));
    const queueTracks = session.queueIds.map((id) => trackMap.get(id)).filter(Boolean);
    if (queueTracks.length === 0) return false;

    const curTrack = trackMap.get(session.trackId) || queueTracks[0];
    const idx = Math.max(0, queueTracks.findIndex((t) => t.id === curTrack.id));

    state.queue = queueTracks;
    state.queueIndex = idx;
    if (Array.isArray(session.origQueueIds)) {
      state.origQueue = session.origQueueIds.map((id) => trackMap.get(id)).filter(Boolean);
    } else {
      state.origQueue = null;
    }
    state.userPausedExplicitly = true; // 復元時は一時停止状態で待機

    appState.set({
      currentTrack: curTrack,
      queue: queueTracks.map((t) => t.id),
      queueIndex: idx,
      duration: curTrack.duration || 0,
      currentTime: session.currentTime || 0,
      isPlaying: false,
      shuffleMode: !!session.shuffleMode,
      repeatMode: session.repeatMode || "none",
      currentPlaylistId: session.currentPlaylistId || null,
      currentPlaylistName: session.currentPlaylistName || null,
    });

    updateMediaSessionMetadata(curTrack);
    updateMediaPositionState({ position: session.currentTime || 0, duration: curTrack.duration });
    return true;
  } catch (e) {
    console.warn("[audio-engine] restoreSessionState 失敗", e);
    return false;
  }
}

/**
 * 終了系イベントのクリーンアップ & 状態退避
 *
 * ★ モバイル (iOS/Android) ではタスク切り替えや画面ロック、アプリスイッチャー移行時に
 *   beforeunload が発火することがある。ここで audio.pause() や src 削除、MediaSession 解放を
 *   行うとバックグラウンド再生が強制終了してしまうため、破壊的クリーンアップは一切行わない。
 *   タブや PWA が真に終了した場合はブラウザが JS context と共に自動的に解放する。
 *   ここでは終了直前の最新再生状態の退避 (saveSessionState) のみに留める。
 */
function setupTerminationCleanup() {
  window.addEventListener("beforeunload", () => {
    saveSessionState();
  });
}

/**
 * 復帰時に iOS が勝手に audio を再開してしまうのを防ぐガード
 * - ユーザが明示的に pause していた場合、visible 復帰時に audio が再生中なら
 *   pause() を呼び直す
 */
function setupVisibilityGuard() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // 復帰直後は audio.paused 状態の反映に少し時間がかかる場合があるため
    // 数回チェック
    let attempts = 0;
    const check = () => {
      attempts++;
      if (state.userPausedExplicitly) {
        if (mainAudioEl && !mainAudioEl.paused) {
          try { mainAudioEl.pause(); } catch {}
        }
        if (streamAudioEl && !streamAudioEl.paused) {
          try { streamAudioEl.pause(); } catch {}
        }
        // pause を当てた後も念のため再確認
        if (attempts < 5) setTimeout(check, 150);
      }
    };
    setTimeout(check, 50);
  });

  // pagehide / pageshow も保険
  window.addEventListener("pageshow", () => {
    if (state.userPausedExplicitly) {
      if (mainAudioEl && !mainAudioEl.paused) {
        try { mainAudioEl.pause(); } catch {}
      }
      if (streamAudioEl && !streamAudioEl.paused) {
        try { streamAudioEl.pause(); } catch {}
      }
    }
  });
}

/**
 * mediaSession.setPositionState を呼ぶ。
 *
 * @param {object} [opts]
 *   - playbackRate: 0 を渡すと pause 中相当
 *   - position: 強制 position
 *   - duration: 強制 duration（track.duration を渡す用途）
 *
 * ★ 重要: duration は audio.duration ではなく **track.duration（パース済み）**
 *   を渡すこと。iOS Safari は src 変更直後の loadedmetadata 発火後でも
 *   audio.duration が前トラックの値を引きずる微小遅延があり、setPositionState
 *   に前曲の duration を渡してしまうと、新曲再生中のロック画面進捗バーが
 *   MAX や中途半端な位置から開始されるバグの直接原因になる。
 */
function updateMediaPositionState(opts = {}) {
  if (!("mediaSession" in navigator)) return;
  if (typeof navigator.mediaSession.setPositionState !== "function") return;

  // duration: 明示指定 > audio.duration > appState.duration の優先順位
  let dur = opts.duration;
  if (!isFinite(dur) || dur <= 0) dur = audioEl.duration;
  if (!isFinite(dur) || dur <= 0) dur = appState.get().duration;
  if (!isFinite(dur) || dur <= 0) return;

  const playbackRate = (opts.playbackRate !== undefined)
    ? opts.playbackRate
    : (audioEl.playbackRate || 1);
  const position = (opts.position !== undefined)
    ? Math.max(0, Math.min(opts.position, dur))
    : Math.min(audioEl.currentTime || 0, dur);
  try {
    navigator.mediaSession.setPositionState({ duration: dur, playbackRate, position });
  } catch (e) {
    // 範囲外などで投げることがある。無視
  }
}

/**
 * 曲自身にアートワークが無い場合、現在の再生キュー内の同一アルバム曲から
 * アートワーク URL をフォールバック解決する。
 */
export function resolveTrackArtworkFromQueue(track) {
  if (!track) return null;
  const direct = getArtworkUrl(track) || track.artworkUrl || null;
  if (direct) return direct;
  if (track.album && Array.isArray(state.queue)) {
    const albLower = track.album.trim().toLowerCase();
    for (const q of state.queue) {
      if (q && q.album && q.album.trim().toLowerCase() === albLower) {
        const fallbackUrl = getArtworkUrl(q) || q.artworkUrl || null;
        if (fallbackUrl) return fallbackUrl;
      }
    }
  }
  return null;
}

function updateMediaSessionMetadata(track) {
  if (!track || !("mediaSession" in navigator)) return;

  // ★ アートワーク URL は ID 単位でキャッシュした安定 URL を使う。
  //   曲自身にまだアートワークが無い場合でも、キュー内の同一アルバム曲にあれば即座に借用する。
  const artwork = [];
  const artUrl = resolveTrackArtworkFromQueue(track);
  if (artUrl) {
    const absArtUrl = toAbsoluteUrl(artUrl);
    const mime = (track.artworkBlob && track.artworkBlob.type)
      || (absArtUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg");
    artwork.push({ src: absArtUrl, sizes: "512x512", type: mime });

    // iOS Safari の MediaRemote (mediaserverd) は blob: URL を直接参照できない場合があるため、
    // artworkBlob を持っている曲で artworkDataUrl がまだ無ければ非同期で Base64 Data URL を生成して再反映
    if (absArtUrl.startsWith("blob:") && track.artworkBlob && !track.artworkDataUrl) {
      import("../metadata/util.js").then(({ blobToDataUrl }) => {
        return blobToDataUrl(track.artworkBlob, 500);
      }).then((dataUrl) => {
        if (dataUrl && appState.get().currentTrack?.id === track.id) {
          track.artworkDataUrl = dataUrl;
          updateMediaSessionMetadata(track);
        }
      }).catch(() => {});
    }
  }
  // フォールバック：アプリアイコン（artwork 無しの曲でもロック画面が空にならないよう絶対URLで指定）
  if (artwork.length === 0) {
    artwork.push({ src: toAbsoluteUrl("icons/icon-512.png"), sizes: "512x512", type: "image/png" });
    artwork.push({ src: toAbsoluteUrl("icons/icon-192.png"), sizes: "192x192", type: "image/png" });
  }

  const isPlaceholderArtist = !track.artist
    || track.artist === "(不明)"
    || track.artist === "(不明アーティスト)"
    || track.artist === "(Google Drive)";
  const displayArtist = (!isPlaceholderArtist ? track.artist : (track.albumArtist || track.artist || "不明"));

  const isPlaceholderAlbum = !track.album
    || track.album === "Google Drive"
    || track.album === "(不明アルバム)"
    || track.album === "(不明)";
  const displayAlbum = (!isPlaceholderAlbum ? track.album : "");

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "不明",
      artist: displayArtist,
      album: displayAlbum,
      artwork,
    });
  } catch (e) {
    console.warn("MediaMetadata 失敗", e);
  }

  // ★ position state を「新トラックの duration、position=0」で確定。
  //   audio.duration ではなく track.duration を渡すことで、
  //   iOS Safari の loadedmetadata 直後の audio.duration 微小遅延を回避する。
  updateMediaPositionState({ position: 0, duration: track.duration });

  // 曲メタデータ更新時にも確実にスキップボタンを維持
  ensureMediaSessionActions();
}
