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
import { getBlob, getTrack, hasCachedBlob, cacheDriveTrackInBackground, isSuspectPartialHeaderDuration, recordHistory, updateTrack, getAllTracks } from "../store/library-db.js";
import {
  applyEffectsSetting,
  applyEqGains,
  applyPreamp,
  applyBassBoost,
  applyCompressor,
  applyPan,
  applyMidSide,
  applyNoiseReduction,
  setAudioOutputDevice,
  resumeEqContext,
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

let audioEl = typeof document !== "undefined" ? document.getElementById("audio-el") : null;
if (!audioEl && typeof document !== "undefined") {
  // index.html の <audio id="audio-el"> は iOS バックグラウンド再生の生命線で
  // あり、これが無い場合は他の全機能が動かない。警告ではなく throw して
  // 起動シーケンス全体を中断し、ユーザに明示的に異常を伝える。
  // (app.js の main().catch() で起動失敗トーストが表示される)
  throw new Error("audio-el 要素が DOM に存在しません。index.html を確認してください。");
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

// primeAudioElement の play() プロミス追跡用（AbortError 防止）
let primePromise = null;

// 内部状態
const state = {
  userVolume: 1.0,        // ユーザー設定音量 (0.0〜1.0)
  currentObjectUrl: null,
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
      if (onlyIfCached && typeof trackId === "string" && trackId.startsWith("gd-")) {
        const cached = await hasCachedBlob(trackId);
        if (!cached) {
          prewarmCache.delete(trackId);
          return null;
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

/**
 * 初期化（一度だけ呼ぶ）
 */
export function initAudioEngine({ onNowPlaying, onScrobble } = {}) {
  state.onNowPlaying = onNowPlaying || null;
  state.onScrobble = onScrobble || null;

  // ★ Audio Session API (https://developer.mozilla.org/en-US/docs/Web/API/AudioSession)
  //   ブラウザに「これは長時間再生される音楽プレイヤー (playback)」と明示する。
  //   iOS 16.4+ Safari (PWA 含む) で対応。設定すると iOS は以下のように扱う:
  //   - 他のネイティブアプリのオーディオと混在しない (音楽再生としての最優先)
  //   - audio session を維持しやすくなる (短時間で解放しない)
  //   - ロック画面再生・バックグラウンド再生での音切れを抑制
  //
  //   未対応ブラウザ (旧 iOS、Android、デスクトップ等) では navigator.audioSession
  //   が undefined なので feature detection で安全にスキップする。
  setupAudioSession();

  setupMediaSession();
  setupVisibilityGuard();
  setupTerminationCleanup();

  // === 再生安定化ウォッチドッグ (iOS / モバイル ストール・バッファ待ちからの自動復旧) ===
  let stallRecoveryTimer = null;
  const onStallOrWaiting = (target) => {
    if (target !== audioEl) return;
    if (state.userPausedExplicitly || !appState.get().isPlaying || state.transitioning) return;
    if (stallRecoveryTimer) clearTimeout(stallRecoveryTimer);
    stallRecoveryTimer = setTimeout(() => {
      if (state.userPausedExplicitly || !appState.get().isPlaying || state.transitioning) return;
      if (audioEl.paused && audioEl.readyState >= 2) {
        console.warn("[audio-engine] ストール状態から再生を自動復帰します");
        audioEl.play().catch((err) => console.warn("[audio-engine] ストール復帰失敗", err));
      }
    }, 2500);
  };

  // デュアル <audio> 用イベントリスナー登録
  // スタンバイ要素のイベントがアクティブ要素の再生状態を汚染しないよう e.target === audioEl でガード
  function attachElementListeners(el) {
    if (!el) return;
    el.addEventListener("play", (e) => { if (e.target === audioEl) onPlay(e); });
    el.addEventListener("pause", (e) => { if (e.target === audioEl) onPause(e); });
    el.addEventListener("ended", (e) => { if (e.target === audioEl) onEnded(e); });
    el.addEventListener("timeupdate", (e) => { if (e.target === audioEl) onTimeUpdate(e); });
    const syncRealAudioDuration = (e) => {
      if (e.target !== audioEl) return;
      if (state.transitioning || (audioEl.src && audioEl.src.startsWith("data:audio/wav"))) return;
      const d = audioEl.duration;
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
    el.addEventListener("loadedmetadata", syncRealAudioDuration);
    el.addEventListener("durationchange", syncRealAudioDuration);
    el.addEventListener("error", (e) => {
      if (e.target === audioEl) {
        console.warn("[audio-engine] audio error", e, audioEl.error);
      }
    });
    el.addEventListener("waiting", (e) => onStallOrWaiting(e.target));
    el.addEventListener("stalled", (e) => onStallOrWaiting(e.target));
    el.addEventListener("playing", (e) => {
      if (e.target === audioEl && stallRecoveryTimer) {
        clearTimeout(stallRecoveryTimer);
        stallRecoveryTimer = null;
      }
    });
  }

  attachElementListeners(audioEl);

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

  state.userVolume = clampVolume(audioEl.volume ?? 1.0);
  applyTrackVolume(audioEl);

  // 起動時に EQ 設定（有効化時のみ初期化）と保存済みエフェクトを全て反映
  const pub = getPublic();
  if (pub.enableAudioEffects) {
    applyEffectsSetting(audioEl, true);
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
    setAudioOutputDevice(audioEl, pub.audioOutputDeviceId).catch((e) => {
      // 失敗時は端末既定の出力に fallback。診断のためログのみ残す
      console.warn("[audio-engine] 出力デバイス設定失敗", e);
    });
  }

  // 再生速度・ピッチ維持 (audio要素プロパティのみ、AudioContext 不要)
  // ← これは iPhone ロック画面・バックグラウンド再生に影響しない安全な機能
  try {
    audioEl.playbackRate = Number(pub.playbackRate) || 1.0;
    setPreservesPitch(audioEl, pub.preservesPitch !== false);
  } catch (e) {
    // 一部の古いブラウザで playbackRate / preservesPitch が未サポート。
    // 機能が動かないだけで再生継続には影響しないので warn のみ
    console.warn("[audio-engine] playbackRate/preservesPitch 設定失敗", e);
  }

  // audio.loop は使わない（iOS のロック画面挙動に影響するため）。
  // 単曲リピートは onEnded → advanceFromEnded の JS 制御で実装する。
  audioEl.loop = false;
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
  if (!audioEl) return;
  try {
    audioEl.playbackRate = Math.max(0.25, Math.min(4, Number(rate) || 1));
    setPreservesPitch(audioEl, !!preservePitch);
  } catch (e) {
    console.warn("playbackRate 適用失敗", e);
  }
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

/**
 * ユーザー操作 (click / tap) の同期コールスタック内で audio 要素を即座に起動する。
 *
 * モバイルブラウザ (iOS Safari / WebKit / Android Chrome 等) は、ユーザー操作起点で
 * 直ちに play() を呼ばないと、直後の await (IndexedDB や Drive 通信) で User Gesture
 * トークンが失効し、その後の play() が Autoplay 制限でブロックされて一時停止状態のままになる。
 * 同期スタック内で 100ms 無音 WAV ループを再生開始しておくことで、非同期ロード完了後に
 * 本体の音源を即座にワンタップで鳴らすことができる。
 */
function primeAudioElement() {
  try {
    setupAudioSession();
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
  primeAudioElement();
  await loadAndPlay(track);
}

export async function setQueueAndPlay(tracks, startIndex = 0) {
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
  // 1. もし prewarmCache に既に Object URL があれば完全同期で即座に再生 (User Gesture 100% 保持・ラグ 0ms)
  const prewarmed = prewarmCache.get(cur.id);
  if (prewarmed && prewarmed.objectUrl) {
    prewarmCache.delete(cur.id);
    playPreloadedSync(state.queueIndex, cur, prewarmed.objectUrl);
    return;
  }

  // 2. まだメモリにない場合: ユーザー操作コンテキスト内で同期プライミングを行い
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
function playPreloadedSync(index, track, url) {
  // 防御: url が無い場合は同期再生できないので通常パスへフォールバック。
  // (呼び出し側は state.preloadUrl を真偽判定済みだが、念のため)
  if (!url) {
    state.queueIndex = index;
    appState.set({ queueIndex: index });
    loadAndPlay(track).catch((e) => console.warn("[audio-engine] loadAndPlay 失敗", e));
    return;
  }

  resetSession(track?.id);
  // この遷移の世代トークンを採番。clearTransitioning はこの世代が最新の
  // ときだけ transitioning を解除する (連打時に古い遷移が新しい遷移の
  // フラグを倒さないようにするため)。
  const myToken = ++state.transitionToken;
  state.transitioning = true;

  const oldUrl = state.currentObjectUrl;
  state.queueIndex = index;
  state.currentObjectUrl = url;
  // プリロード枠を消費 (URL は currentObjectUrl に移譲したので revoke しない)
  state.preloadUrl = null;
  state.preloadTrackId = null;
  state.preloadingId = null;
  state.preloadToken++;

  // ★ UI 状態 (currentTrack 等) は play() の前に同期で確定する。
  //   loadAndPlay と順序を揃え、play 直後の各ハンドラが前曲 track を参照する
  //   窓を作らない (この関数は同期実行なのでイベント発火前に確定する)。
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
  // --- ここから play() まで完全同期 (バックグラウンド再生権限を持つ単一の audioEl を操作) ---
  audioEl.src = url;
  audioEl.loop = false;
  audioEl.playbackRate = getEffectivePlaybackRate();
  applyTrackVolume(audioEl, track);

  const pub = getPublic();
  if (pub.enableAudioEffects) {
    try { applyEffectsSetting(audioEl, true); } catch (_) {}
  }

  updateMediaSessionMetadata(track);
  hydrateTrackMetadata(track?.id);
  const playPromise = audioEl.play();
  // --- play() 発火完了。以降は同期でなくてもよい ---

  // play() の「後」は position state のみ再確定する (新 MediaMetadata は作らない)。
  // loadAndPlay の Phase4 と同じ扱い。
  updateMediaPositionState({ position: 0, duration: track.duration });

  // ★ transitioning は「ここで同期的に false にしない」。
  //   再生中に playNext から呼ばれた場合、audioEl.src 差替で pause イベントが
  //   非同期 (タスク) で遅れて発火する。同期で false にすると、その pause が
  //   onPause に届いたとき transitioning=false となり playbackState="paused" を
  //   iOS に誤通知してしまう (音切れの原因)。
  //   play 成功/失敗が確定してから false にし、保険として 1.5 秒後にも必ず
  //   解除する (promise が解決しない異常時に transitioning が立ちっぱなしで
  //   setPositionState が止まるのを防ぐ)。
  //   ただし「自分が最新世代のとき」だけ解除する (連打対策)。
  const clearTransitioning = () => {
    if (myToken === state.transitionToken) state.transitioning = false;
  };

  // 旧 URL は再生が新 URL に確実に移ってから遅延 revoke
  if (oldUrl && oldUrl !== url) {
    setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch {} }, 2000);
  }

  if (playPromise && typeof playPromise.then === "function") {
    playPromise
      .then(() => {
        clearTransitioning();
        state.consecutiveSkips = 0;
        // 再生回数 / 最終再生日時を更新 (await 不要、失敗は無視)
        updateTrack(track.id, {
          playCount: (track.playCount || 0) + 1,
          lastPlayedAt: Date.now(),
        }).catch(() => {});
      })
      .catch((e) => {
        clearTransitioning();
        // play 確定後の terminal 処理として再生状態を実態(停止)に揃える。さもないと遷移前の
        //   isPlaying=true が残り、音は出ていないのに UI/MediaSession 上「再生中」になる
        //   (loadAndPlay の play 失敗時と対称)。遷移中の playbackState 誤通知=iOS無音化とは別タイミングで
        //   mediaSession.playbackState には触れないため iOS 音声経路には干渉しない。
        appState.set({ isPlaying: false });
        // ここで自動スキップしない (iOS 一過性失敗での連鎖を防ぐ)
        console.warn("[audio-engine] プリロード再生 play 失敗", e);
      });
  } else {
    // play() が promise を返さない古い実装 → 即クリア
    clearTransitioning();
  }
  // 保険: promise が解決しない異常時でも transitioning を必ず解除
  setTimeout(clearTransitioning, 1500);

  // さらに次の曲をプリロード (チェーンを継続)
  schedulePreload();
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
    try { audioEl.pause(); } catch {}
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
    // ★ 同一曲のループ再生も「新しい再生セッション」として扱い、スクロブル/履歴/
    //   セッション集計をリセットする。これをしないと scrobbledForCurrent が true の
    //   まま残り、2周目以降は何周完聴しても onTimeUpdate の再スクロブル判定
    //   (!scrobbledForCurrent && progress>=1) が永久に偽になり、Last.fm 再生回数も
    //   ローカル履歴(recordHistory)も増えない。loadAndPlay / playPreloadedSync が必ず
    //   行っている resetSession + フラグリセットと同じ扱いに揃える。
    //   音声経路(src/play/MediaSession)には触れず、集計用 state と UI ミラーのみ初期化する。
    const curTrack = state.queue[state.queueIndex];
    resetSession(curTrack?.id);
    appState.set({
      currentTime: 0,
      scrobbleProgress: 0,
      nowPlayingSent: false,
      scrobbledForCurrent: false,
      scrobbleResult: "none",
      scrobbleReason: null,
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

  // フォールバック: プリロード未完了 (プリロードが間に合わなかった / blob 無し等)。
  // フォアグラウンドなら問題なく動作する。バックグラウンドで間に合わなかった
  // 場合は従来同様のリスクが残るが、通常は曲の長さに対し十分先読みが間に合う。
  state.queueIndex = next;
  appState.set({ queueIndex: next });
  loadAndPlay(track).catch((e) => console.warn("[audio-engine] loadAndPlay 失敗", e));
}

export async function playPrev() {
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
  // EQ chain が存在し suspended なら resume（ユーザ操作起点）
  await resumeEqContext();
  if (audioEl.paused) {
    state.userPausedExplicitly = false;
    // アプリ内ボタンからの再開でも、コールドスタート時の無進行ストールに備えて
    // 進行監視を仕掛ける(正常に進行すれば何もしない)。
    armResumeWatchdog();
    try { await audioEl.play(); } catch (err) { console.warn("play 失敗", err); }
  } else {
    state.userPausedExplicitly = true;
    // 保留中の自動再試行がこの明示 pause を覆さないように解除
    clearResumeWatchdog();
    audioEl.pause();
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
  if (index < 0 || index >= state.queue.length) return;
  state.queueIndex = index;
  appState.set({ queueIndex: index });
  const track = state.queue[index];
  if (track) {
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
        try { audioEl.pause(); } catch {}
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
  applyTrackVolume(audioEl);
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
  // ★ 進行中の loadAndPlay (await getBlob/loadedmetadata 中) を無効化する。
  //   transitionToken を進めることで、再開時の stale チェックで中断される
  //   (削除した曲が一瞬再生されたり、currentObjectUrl が再投入されるのを防ぐ)。
  //   transitioning も明示的に false に戻す (in-flight の finally は token 不一致で
  //   解除しないため、ここで確実にリセットしないと立ちっぱなしになる)。
  state.transitionToken++;
  state.transitioning = false;
  // 停止で再生コンテキストが終わるため連続スキップ計数も初期化(次回再生へ持ち越さない)。
  state.consecutiveSkips = 0;

  try { audioEl.pause(); } catch {}
  try { audioEl.removeAttribute("src"); audioEl.load(); } catch {}
  if (state.currentObjectUrl) {
    try { URL.revokeObjectURL(state.currentObjectUrl); } catch {}
    state.currentObjectUrl = null;
  }
  // プリロード済み URL も破棄（リーク防止）
  clearPreload();
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

export function getAudioElement() { return audioEl; }
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
  if (state.currentObjectUrl !== ownUrl) {
    try { URL.revokeObjectURL(ownUrl); } catch {}
  }
  return true;
}

async function loadAndPlay(track, { startTime = 0 } = {}) {
  if (!track) return;

  // ★ iOS: 再生開始のたびに(ユーザー操作起点で)audioSession.type="playback" を
  //   再宣言する。init 時の一度きり設定だけだと、コールド起動でメディアプレイヤー
  //   認識がリセットされた状態(特にマナーモード ON 時)では、ロック画面の音声が
  //   ミュートされる(進捗だけ進んで無音)。最初の再生ジェスチャ内で type を
  //   設定し直し、ロックする前に「メディア再生(マナーモード/画面ロック無視)」と
  //   iOS に認識させる。feature-detection + try/catch 済みで、非iOS/非対応では
  //   no-op、音声フロー(src/play/MediaSession)には一切干渉しない。
  setupAudioSession();

  resetSession(track?.id);

  // ★ タップした瞬間（同期フレーム 0ms）に世代トークン・遷移フラグ・UI状態・MediaSession を
  //   即時確定させる。これにより IndexedDB / Google Drive 取得完了を待たずに
  //   ミニプレイヤー・リストの再生ハイライト・ロック画面メタデータが即座に切り替わる。
  const myToken = ++state.transitionToken;
  state.transitioning = true;
  state.userPausedExplicitly = false;

  appState.set({
    currentTrack: track,
    duration: track.duration || 0,
    currentTime: startTime || 0,
    isPlaying: true,
    loadingTrackId: track?.id || null,
    scrobbleProgress: 0,
    nowPlayingSent: false,
    scrobbledForCurrent: false,
    scrobbleResult: "none",
    scrobbleReason: null,
  });

  updateMediaSessionMetadata(track);
  updateMediaPositionState({ position: startTime || 0, duration: track.duration });
  hydrateTrackMetadata(track.id);

  // ★ Phase 0: 音源 URL / Blob の取得
  let targetUrl = null;
  let blobErr = null;
  let isDirectStream = false;
  const isDriveTrack = typeof track.id === "string" && track.id.startsWith("gd-");

  // 1. Prewarm キャッシュにあるか確認
  const prewarmed = prewarmCache.get(track.id);
  if (prewarmed) {
    prewarmCache.delete(track.id);
    if (prewarmed.objectUrl) {
      targetUrl = prewarmed.objectUrl;
    } else if (prewarmed.promise) {
      targetUrl = await prewarmed.promise;
    }
  }

  // 2. 未キャッシュの Google Drive 曲:
  //    - 未連携/期限切れならスキップせず「その場で再連携モーダル」を出して再連携後にそのまま再生
  //    - 外出時（モバイル回線）でも待ち時間なく即再生できるよう、ダイレクトストリーミングURLを使用しつつ裏でキャッシュ
  if (!targetUrl && isDriveTrack) {
    const cached = await hasCachedBlob(track.id).catch(() => false);
    if (!cached) {
      try {
        const { getDriveToken, getDriveStreamUrl, promptDriveReconnectModal } = await import("../gdrive/drive-service.js");
        let token = await getDriveToken();
        if (!token) {
          // ユーザー操作による再連携待ちの間、無音ループを一時解除してモーダルを表示
          try { audioEl.pause(); } catch {}
          token = await promptDriveReconnectModal({ track });
          if (!token) {
            // ユーザーがキャンセルした場合は勝手に次曲へスキップせず停止状態で待機
            if (myToken === state.transitionToken) {
              state.transitioning = false;
              appState.set({ isPlaying: false, loadingTrackId: null });
            }
            return;
          }
          primeAudioElement();
        }
        // WebAudio EQ エフェクト無効時は HTTP Range ダイレクトストリーミングで即座に再生開始（外出時でも約1秒で再生）
        if (!getPublic().enableAudioEffects) {
          const streamUrl = await getDriveStreamUrl(track.id, token);
          if (streamUrl) {
            targetUrl = streamUrl;
            isDirectStream = true;
            // 再生開始と並行してバックグラウンドで IndexedDB キャッシュと完全メタデータ・再生時間補完を行う
            setTimeout(() => {
              cacheDriveTrackInBackground(track.id);
            }, 1200);
          }
        }
      } catch (driveErr) {
        console.warn("[audio-engine] Drive ストリーム準備警告、通常取得へフォールバック:", driveErr);
      }
    }
  }

  // 3. 音源 Blob 取得 (ローカル曲、キャッシュ済み Drive 曲、または EQ 有効時 / ストリームフォールバック)
  if (!targetUrl) {
    let blob = await getBlob(track.id).catch((e) => {
      console.warn("[audio-engine] getBlob 失敗", track.id, e);
      blobErr = e;
      return null;
    });
    // Drive 曲で 401 / 未接続エラーだった場合は、スキップせずその場で再連携モーダルを出して再試行
    if (!blob && isDriveTrack && blobErr && /401|接続されていません|期限/.test(blobErr.message || "")) {
      try {
        const { promptDriveReconnectModal } = await import("../gdrive/drive-service.js");
        try { audioEl.pause(); } catch {}
        const newToken = await promptDriveReconnectModal({ track, reason: blobErr.message });
        if (!newToken) {
          if (myToken === state.transitionToken) {
            state.transitioning = false;
            appState.set({ isPlaying: false, loadingTrackId: null });
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

  // 音源取得完了または失敗のためローディング解除
  if (appState.get().loadingTrackId === track.id) {
    appState.set({ loadingTrackId: null });
  }

  if (!targetUrl) {
    state.transitioning = false;
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
    if (primePromise) {
      try {
        await primePromise;
      } catch (_) {}
      primePromise = null;
    }

    const oldUrl = state.currentObjectUrl;
    state.currentObjectUrl = targetUrl;
    audioEl.src = targetUrl;
    audioEl.loop = false;
    audioEl.playbackRate = getEffectivePlaybackRate();
    applyTrackVolume(audioEl, track);

    if (startTime > 0) {
      try { audioEl.currentTime = startTime; } catch {}
    }

    // getBlob 中にバックグラウンドメタデータ補完が走った可能性があるため最新 track を取得
    const latestTrack = state.queue[state.queueIndex]?.id === track.id
      ? state.queue[state.queueIndex]
      : (appState.get().currentTrack?.id === track.id ? appState.get().currentTrack : track);

    appState.set({
      currentTrack: latestTrack,
      duration: latestTrack.duration || 0,
      currentTime: startTime || 0,
      isPlaying: true,
    });

    // === play() の前に MediaSession を即座に同期設定 ===
    updateMediaSessionMetadata(latestTrack);
    updateMediaPositionState({ position: startTime || 0, duration: latestTrack.duration });

    // EQ context はバックグラウンドで resume (play() の開始を待たせない)
    resumeEqContext().catch(() => {});

    state.userPausedExplicitly = false;
    try {
      const p = audioEl.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          clearTransitioning();
          state.consecutiveSkips = 0;
          if (startTime > 0) {
            try { audioEl.currentTime = startTime; } catch {}
          }
        }).catch(async (err) => {
          clearTransitioning();
          console.warn("[audio-engine] play 失敗", err);
          if (err?.name === "AbortError" && !state.userPausedExplicitly && appState.get().currentTrack?.id === track.id) {
            try {
              await new Promise((r) => setTimeout(r, 60));
              if (!state.userPausedExplicitly && appState.get().currentTrack?.id === track.id) {
                await audioEl.play();
                state.consecutiveSkips = 0;
              }
            } catch (_) {}
          } else if (isDirectStream && !state.userPausedExplicitly && appState.get().currentTrack?.id === track.id) {
            // ダイレクトストリーム URL がブラウザ制限やトークン期限切れ等で再生失敗した場合、Blob 取得へ自動フォールバック
            console.info("[audio-engine] ダイレクトストリーム失敗のため Blob ダウンロードへフォールバックします:", track.id);
            try {
              const fbBlob = await getBlob(track.id);
              if (fbBlob && !state.userPausedExplicitly && appState.get().currentTrack?.id === track.id) {
                const fbUrl = URL.createObjectURL(fbBlob);
                state.currentObjectUrl = fbUrl;
                audioEl.src = fbUrl;
                if (startTime > 0) {
                  try { audioEl.currentTime = startTime; } catch {}
                }
                await audioEl.play();
                state.consecutiveSkips = 0;
              }
            } catch (fbErr) {
              console.warn("[audio-engine] Blob フォールバック再生も失敗:", fbErr);
              appState.set({ isPlaying: false });
            }
          } else if (err?.name === "NotAllowedError") {
            appState.set({ isPlaying: false });
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
      console.warn("[audio-engine] play 失敗", err);
      appState.set({ isPlaying: false });
    }

    // 保険: promise が解決しない異常時でも 1.5 秒後に transitioning を解除
    setTimeout(clearTransitioning, 1500);

    // 旧 URL は再生が新 URL に確実に移ってから遅延 revoke
    if (oldUrl && oldUrl !== targetUrl) {
      setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch {} }, 2000);
    }

    // ★ 再生が開始されたら、直ちに次曲のプリロードを開始 (次の ended で即時同期再生)
    schedulePreload();

    // バックグラウンドで非同期記録 (再生の進行を一切待たせない)
    updateTrack(track.id, {
      playCount: (track.playCount || 0) + 1,
      lastPlayedAt: Date.now(),
    }).catch(() => {});
  } finally {
    if (appState.get().loadingTrackId === track.id) {
      appState.set({ loadingTrackId: null });
    }
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
  appState.set({ isPlaying: true });
  state.lastTickAt = Date.now();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
  ensureMediaSessionActions();
  saveSessionState();
  // ★ ここでは updateMediaPositionState を呼ばない。
  //   呼ぶと audio.currentTime（前曲の終端値が一瞬残る場合がある）が
  //   iOS に流れ、ロック画面の進捗バーが新曲の 40〜50% から始まる現象を
  //   引き起こすため。
  //   - 曲切替時は loadAndPlay 内で position=0 を明示
  //   - 一時停止からの再開時は onTimeUpdate が約 1 秒以内に正しい値を送る
}

function onPause() {
  flushSessionPlayed();

  // ★ 遷移中 (loadAndPlay 内の src 切替に伴う audioEl.pause() 呼出) は
  //   外部に「pause された」と通知してはいけない。
  //
  //   iOS Safari は playbackState = "paused" を伝えると audio session を
  //   抑制状態にして、後続の play() で「進捗バーは進むが音が出ない」
  //   不具合の原因になる。ロック画面で 1 曲目 ended → 2 曲目に遷移するとき、
  //   この pause 通知のせいで 2 曲目が無音再生になっていた。
  //
  //   transitioning 中は早期 return することで:
  //   - appState.set({ isPlaying: false }) を呼ばない → UI ちらつき防止
  //   - navigator.mediaSession.playbackState = "paused" を呼ばない →
  //     iOS audio session の維持
  //   - setPositionState を呼ばない → 前トラックの stale 値による汚染防止
  if (state.transitioning) return;

  appState.set({ isPlaying: false });

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
  appState.set({ currentTime: cur });

  // 周期的に position state を更新（iOS のロック画面プログレスバーと
  // セッション維持のため）。timeupdate は ~250ms 間隔で発火するが、
  // ~1 秒間隔に間引く。
  // ★ 遷移中 (loadAndPlay 内で audio が一瞬動いている可能性) は更新しない。
  const now = Date.now();
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
    appState.set({ scrobbleProgress: progress });

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
      try { audioEl.pause(); } catch {}
    });

    try {
      navigator.mediaSession.setActionHandler("stop", () => {
        state.userPausedExplicitly = true;
        clearResumeWatchdog();
        try { audioEl.pause(); } catch {}
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
      if (state.userPausedExplicitly && !audioEl.paused) {
        try { audioEl.pause(); } catch {}
        // pause を当てた後も念のため再確認
        if (attempts < 5) setTimeout(check, 150);
      }
    };
    setTimeout(check, 50);
  });

  // pagehide / pageshow も保険
  window.addEventListener("pageshow", () => {
    if (state.userPausedExplicitly && !audioEl.paused) {
      try { audioEl.pause(); } catch {}
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
