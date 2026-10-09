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
import { getBlob, recordHistory, updateTrack, getAllTracks } from "../store/library-db.js";
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
import { getArtworkUrl } from "../ui/artwork-cache.js";
// 再生エラー時のスキップ通知。components.js は UI レイヤだが、
// ユーザに「読み込めない曲をスキップした」ことを知らせるために最小依存で使う。
import { toast } from "../ui/components.js";

const audioEl = document.getElementById("audio-el");
if (!audioEl) {
  // index.html の <audio id="audio-el"> は iOS バックグラウンド再生の生命線で
  // あり、これが無い場合は他の全機能が動かない。警告ではなく throw して
  // 起動シーケンス全体を中断し、ユーザに明示的に異常を伝える。
  // (app.js の main().catch() で起動失敗トーストが表示される)
  throw new Error("audio-el 要素が DOM に存在しません。index.html を確認してください。");
}

// 内部状態
const state = {
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
};

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

  audioEl.addEventListener("play", onPlay);
  audioEl.addEventListener("pause", onPause);
  audioEl.addEventListener("ended", onEnded);
  audioEl.addEventListener("timeupdate", onTimeUpdate);
  audioEl.addEventListener("durationchange", () => {
    appState.set({ duration: audioEl.duration || 0 });
    // ★ ここで updateMediaPositionState を呼ばない。
    //   durationchange のタイミングでは audio.currentTime が前曲の
    //   stale 値を引きずっていることがあり、それが iOS に流れると
    //   ロック画面の進捗バーが MAX 等にずれる原因になる。
    //   position state は loadAndPlay 内で track.duration を使って
    //   明示的に更新する。
  });
  audioEl.addEventListener("error", (e) => {
    // ★ ここでは自動的に次曲スキップしない（mp3player の挙動に合わせる）。
    //
    //   理由: iOS Safari の PWA バックグラウンド再生中、audio.error は
    //   「再生継続中の一過性イベント」としても発火する（audio session の
    //   一時取り上げ・src 切替時の空src経由・ネットワーク bufer 境界等）。
    //   ここで自動的に次曲へ進めてしまうと、ユーザ報告にあるように
    //   「1 曲目の途中で停止 → 次曲に切替 → そこも停止」のような連鎖が
    //   発生する。ended イベントは別途正常に発火するので、自然遷移は
    //   そちらに任せ、ここではログのみ残す。
    console.warn("[audio-engine] audio error", e, audioEl.error);
  });

  // === 再生安定化ウォッチドッグ (iOS / モバイル ストール・バッファ待ちからの自動復旧) ===
  let stallRecoveryTimer = null;
  const onStallOrWaiting = () => {
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
  audioEl.addEventListener("waiting", onStallOrWaiting);
  audioEl.addEventListener("stalled", onStallOrWaiting);
  audioEl.addEventListener("playing", () => {
    if (stallRecoveryTimer) {
      clearTimeout(stallRecoveryTimer);
      stallRecoveryTimer = null;
    }
  });

  audioEl.volume = clampVolume(audioEl.volume);

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

/* ============ 外部API ============ */

export async function playTrackImmediate(track) {
  if (!track) return;
  await loadAndPlay(track);
}

export async function setQueueAndPlay(tracks, startIndex = 0) {
  // ユーザー操作(曲タップ等)起点でセッションアクティベータを生成しておく。
  // フォアグラウンドのジェスチャ中に AudioContext を作っておくことで、後の
  // ロック画面再開時は resume() だけで済む(バックグラウンドでの new を避ける)。
  // await しない: 生成が目的で、再生開始を遅らせない(失敗は内部で warn 処理)。
  resumeSessionActivator();
  // 新しいキューを開始するので、旧キュー由来のプリロードは確実に stale。
  // 即座に破棄して object URL リークと誤 fast-path を防ぐ
  // (loadAndPlay 末尾の schedulePreload でも取り直されるが、ここで明示する)。
  clearPreload();
  // ユーザ起点の新規再生コンテキスト開始 → 連続スキップ計数を初期化する。
  //   さもないと前回キューで途中まで進んだスキップ数(blob 欠損等)が持ち越され、
  //   新キューで数曲失敗しただけで「複数曲の読み込みに失敗」停止に達してしまう。
  state.consecutiveSkips = 0;
  state.queue = tracks.slice();
  state.queueIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
  state.origQueue = null;
  appState.set({ queue: state.queue.map((t) => t.id), queueIndex: state.queueIndex });
  if (appState.get().shuffleMode) {
    shuffleCurrentQueue();
  }
  const cur = state.queue[state.queueIndex];
  if (cur) await loadAndPlay(cur);
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
    if (repeat === "all") {
      next = 0;
    } else {
      // 手動「次へ」でキュー末尾を超えた（リピートなし）。
      // advanceFromEnded と同じくプレイリストコンテキストをクリアする。
      appState.set({ isPlaying: false, currentPlaylistId: null, currentPlaylistName: null });
      return;
    }
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

  resetSession();
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
    scrobbleProgress: 0,
    nowPlayingSent: false,
    scrobbledForCurrent: false,
    scrobbleResult: "none",
  });

  state.userPausedExplicitly = false;
  // --- ここから play() まで同期 ---
  audioEl.src = url;
  try { audioEl.load(); } catch {}

  // ★ MediaSession の metadata は play() の「前」に確定する。
  //   play() の「後」に new MediaMetadata() を生成すると、iOS Safari が
  //   それを「新しい audio session の開始」とみなして音声出力を切り、
  //   ロック画面の進捗バーは進むのに音が出ない不具合になる
  //   (v1.0.88 で loadAndPlay の Phase4 metadata 再生成を除去した時と同じ原因)。
  //   loadAndPlay の Phase3 と同様、必ず play() 前に metadata を置く。
  //   duration はパース済み track.duration を使うため loadedmetadata 待ち不要。
  updateMediaSessionMetadata(track);

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
    resetSession();
    appState.set({
      currentTime: 0,
      scrobbleProgress: 0,
      nowPlayingSent: false,
      scrobbledForCurrent: false,
      scrobbleResult: "none",
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
  // 再生位置が 3 秒を超えていたら曲頭に戻すだけ（前曲には行かない）。
  // 一般的な音楽プレイヤーと同じ挙動。
  if (audioEl.currentTime > 3) {
    try { audioEl.currentTime = 0; } catch {}
    return;
  }
  let prev = state.queueIndex - 1;
  if (prev < 0) {
    // キュー先頭での「前へ」: キューリピート時のみ末尾へ、それ以外は曲頭へ
    if (appState.get().repeatMode === "all") {
      prev = state.queue.length - 1;
    } else {
      try { audioEl.currentTime = 0; } catch {}
      return;
    }
  }
  state.queueIndex = prev;
  appState.set({ queueIndex: prev });
  const t = state.queue[prev];
  if (t) await loadAndPlay(t);
}

/**
 * 再生ボタン or 「play」アクションハンドラ用のトグル。
 * - currentTrack が無い場合はライブラリ先頭曲を自動再生（mp3player 互換）
 * - 既に paused なら play、playing なら pause
 */
export async function togglePlay() {
  if (!appState.get().currentTrack) {
    await autoStartFirstTrack();
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

export function setVolume(v) { audioEl.volume = clampVolume(v); }

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
    // 再生コンテキスト（どのプレイリストから再生していたか）もクリア
    currentPlaylistId: null,
    currentPlaylistName: null,
  });
  if (navigator.mediaSession) {
    try { navigator.mediaSession.metadata = null; } catch {}
    try { navigator.mediaSession.playbackState = "none"; } catch {}
  }
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

async function loadAndPlay(track) {
  // ★ iOS: 再生開始のたびに(ユーザー操作起点で)audioSession.type="playback" を
  //   再宣言する。init 時の一度きり設定だけだと、コールド起動でメディアプレイヤー
  //   認識がリセットされた状態(特にマナーモード ON 時)では、ロック画面の音声が
  //   ミュートされる(進捗だけ進んで無音)。最初の再生ジェスチャ内で type を
  //   設定し直し、ロックする前に「メディア再生(マナーモード/画面ロック無視)」と
  //   iOS に認識させる。feature-detection + try/catch 済みで、非iOS/非対応では
  //   no-op、音声フロー(src/play/MediaSession)には一切干渉しない。
  setupAudioSession();

  resetSession();

  // ★ Phase 0: blob を先に取得する（transitioning 開始前）
  //
  //   iOS バックグラウンド再生での無音問題の主因対策。
  //   旧実装は「pause → 旧 URL revoke → await getBlob() → 新 URL 設定」
  //   の順だったため、`await getBlob()` の数百 ms 〜 数秒 (iOS バック
  //   グラウンドの IndexedDB アクセスは遅延しやすい) の間、audio.src が
  //   revoke 済みの無効参照状態になっていた。
  //   iOS Safari はこの状態を「audio session 終了」とみなして解放し、
  //   後続の play() で進捗バーは進むが音だけ出ない不具合の根本原因に
  //   なっていた。
  //
  //   GitHub の mp3player は `_playTrackAtIndex` 内で先に
  //   `await this.store.getTrackData(track.id)` を実行してから
  //   loadAudio に渡しており、loadAudio 内部の pause→revoke→新src は
  //   すべて同期処理で完結している。Player でも同じ順序にする。
  let blobErr = null;
  const blob = await getBlob(track.id).catch((e) => {
    console.warn("[audio-engine] getBlob 失敗", track.id, e);
    blobErr = e;
    return null;
  });
  if (!blob) {
    console.warn("blob 未発見", track.id);
    // 確定エラー: ファイル本体が見つからない、または Google Drive 等の取得エラー → スキップ処理に進む
    const reason = (blobErr && blobErr.message) ? blobErr.message : "ファイル本体が見つかりません";
    await skipToNextOnError(reason, track);
    return;
  }

  // ★ 遷移中フラグを立てて、pause/timeupdate 経由の setPositionState が
  //   stale 値で iOS を汚染するのを抑止する。
  //   getBlob 完了後にフラグ ON することで、IDB アクセス遅延中も通常の
  //   timeupdate/pause 処理 (旧曲の) が正常動作する。
  //   世代トークンを採番し、finally では「自分が最新遷移のとき」だけ解除する
  //   (並行 loadAndPlay / playPreloadedSync で古い処理が新しい遷移のフラグを
  //   倒さないようにする)。
  const myToken = ++state.transitionToken;
  state.transitioning = true;

  try {
    // === Phase 1〜2: 旧トラック停止 + URL 差替 (すべて同期処理) ===
    //   ここから audioEl.play() までを「同期処理のかたまり」にすることで
    //   audio.src が無効参照になる時間を最短化する (mp3player 流)。
    try { audioEl.pause(); } catch {}
    if (audioEl.src) {
      try { audioEl.currentTime = 0; } catch {}
    }
    if (state.currentObjectUrl) {
      try { URL.revokeObjectURL(state.currentObjectUrl); } catch {}
      state.currentObjectUrl = null;
    }
    {
      const url = URL.createObjectURL(blob);
      state.currentObjectUrl = url;
      audioEl.src = url;
      try { audioEl.load(); } catch {}

      appState.set({
        currentTrack: track,
        duration: track.duration || 0,
        currentTime: 0,
        scrobbleProgress: 0,
        nowPlayingSent: false,
        scrobbledForCurrent: false,
        scrobbleResult: "none",
      });

      // loadedmetadata を待つことで audio.duration を確定させる
      await waitForLoadedMetadata();

      // ★ await 中に別の遷移が始まっていたら自分は stale。play せず中断する。
      if (isSupersededTransition(myToken, url)) return;

      // 念のため新 src でも currentTime=0 を再度明示
      try { audioEl.currentTime = 0; } catch {}

      // === Phase 3: play() の「前」に MediaSession を更新 ===
      //   waitForLoadedMetadata 済みなので duration は新トラックの値が入る。
      //   先に position=0 / 新 duration / rate=1 を iOS に伝えておくことで、
      //   play 直後に iOS のロック画面が「新セッションの 0 から開始」と
      //   認識する。play 後の更新だけだと iOS が前曲の position state を
      //   引きずって 40〜50% 地点から始まったように見えるケースがある。
      updateMediaSessionMetadata(track);

      await resumeEqContext();

      // resumeEqContext の await 後も再度 stale チェック (上記と同じ理由)
      if (isSupersededTransition(myToken, url)) return;

      state.userPausedExplicitly = false;
      try {
        await audioEl.play();
        // 再生開始に成功 → 連続スキップカウンタをリセット
        state.consecutiveSkips = 0;
      } catch (err) {
        // ★ ここで自動スキップしない（mp3player の挙動に合わせる）。
        //   iOS のロック画面再生で play() が一時的に失敗するケース
        //   （audio session 取り合い、自動再生制約、AbortError 等）が
        //   あり、自動次曲スキップすると「ロック画面 pause タップで曲が
        //   消える」「次曲が再生されない」等の連鎖不具合になる。
        //   ログのみ残し、isPlaying:false で UI を pause 表示にする。
        //   ユーザが再生ボタンをタップすれば復旧可能。
        console.warn("[audio-engine] play 失敗", err);
        appState.set({ isPlaying: false });
      }

      // === Phase 4: play() の「後」は position state のみ再確定 ===
      //   過去に updateMediaSessionMetadata(track) を再度呼んでいたが、
      //   iOS バックグラウンド再生中の自然遷移 (ended → 次曲) では、
      //   play 直後の new MediaMetadata({...}) を生成すると iOS の
      //   audio session が「新セッション開始」とみなされ、ロック画面で
      //   進捗バーは進むが音だけ出ない状態になる不具合が確認された。
      //   mp3player (GitHub utausnskareshi/mp3player) も play 後の metadata
      //   再設定は行っていない。
      //   metadata は Phase 3 (play 前) で確定済みなので、Phase 4 では
      //   position state だけを最終確定する。
      updateMediaPositionState({ position: 0, duration: track.duration });

      try {
        await updateTrack(track.id, {
          playCount: (track.playCount || 0) + 1,
          lastPlayedAt: Date.now(),
        });
      } catch {}

      // ★ 現在の曲が再生開始した → 次曲を先読みしておく。
      //   これにより次の ended で同期的に (await なしで) 次曲へ移れる。
      //   iOS バックグラウンドでの自動遷移を確実にする生命線。
      schedulePreload();
    }
  } finally {
    // 遷移完了。ただし自分が最新遷移のときだけ transitioning を解除する。
    // (並行する別の loadAndPlay / playPreloadedSync が後から始まっていたら、
    //  そちらが解除を担当する。古い処理が新しい遷移のフラグを倒さない。)
    if (myToken === state.transitionToken) state.transitioning = false;
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
function waitForLoadedMetadata(timeoutMs = 8000) {
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

function resetSession() {
  state.sessionStartedAt = Date.now();
  state.sessionPlayed = 0;
  state.lastTickAt = state.sessionStartedAt;
}

function onPlay() {
  appState.set({ isPlaying: true });
  state.lastTickAt = Date.now();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
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
  //   ※ 一時は「ユーザーpauseでも paused を送らない(候補A)」を試したが、ロック画面
  //     pause→resume の無音バグは直らず(iOS 18.7.9 実機で確認)、かつ一時停止表示が
  //     崩れるリスクがあったため復元。無音の真因はビジュアライザの AudioContext 生成
  //     によるオーディオセッション干渉と判断し、visualizer.js 側で対処する。
  //   ※ 旧 updateMediaPositionState({playbackRate:0}) は W3C 仕様上 setPositionState が
  //     rate=0 で TypeError を投げる死にコードだったため復元しない(pause 位置は次の
  //     再生再開時の更新で反映される)。
  if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
}

function flushSessionPlayed() {
  const now = Date.now();
  if (state.lastTickAt && !audioEl.paused) {
    // ★ 再生速度を乗じて「曲コンテンツの再生秒数」を積算する。
    //   Last.fm のスクロブル条件「曲長の半分 or 4分(早い方)」は曲の再生位置基準のため、
    //   playbackRate≠1(本アプリは 0.25〜4x 対応)では壁時計秒のままだと 2x で取りこぼし・0.5x で早発火する。
    //   壁時計差分に playbackRate を乗じれば曲位置換算になり仕様の発火位置と一致する(1x では従来と等価)。
    //   pause 区間は !audioEl.paused で除外、シーク(currentTime ジャンプ)は差分加算なので影響しない点は不変。
    state.sessionPlayed += ((now - state.lastTickAt) / 1000) * (audioEl.playbackRate || 1);
  }
  state.lastTickAt = now;
}

function onTimeUpdate() {
  flushSessionPlayed();
  const track = appState.get().currentTrack;
  if (!track) return;

  const dur = audioEl.duration || track.duration || 0;
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

    if (!appState.get().scrobbledForCurrent && progress >= 1) {
      // onScrobble は非同期で送信を開始する。完了結果（sent/queued/failed/
      // skipped）は app.js 側で appState.scrobbleResult にセットされる。
      // ここでは「送信中」状態を即座に反映して、UI が「送信済」と早合点しない
      // ようにする。
      //
      // 第3引数 sessionStartedAt（曲の再生開始時刻 ms）を渡す:
      //   Last.fm の timestamp 仕様は「スクロブル対象の曲が再生開始した
      //   UNIX 時刻」が推奨。これにより Last.fm 上のスクロブル時刻が
      //   ユーザの体感（曲を聴き始めた時刻）と一致する。
      appState.set({ scrobbledForCurrent: true, scrobbleResult: "sending" });
      if (state.onScrobble) state.onScrobble(track, dur, state.sessionStartedAt);
      // recordHistory は Promise を返す(IDB 書込)。同期 try/catch では reject を捕捉できず
      //   未処理 rejection になるため .catch でログ握り(updateTrack と同パターン)。
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

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    // === ここが iOS ロック画面挙動の要 ===
    // play / pause は「discrete」: toggle しない、純粋に play / pause のみ
    // これにより、何らかの理由で iOS が play action と pause action を続けて
    // 投げてもトグル誤動作を起こさない。
    navigator.mediaSession.setActionHandler("play", async () => {
      // currentTrack が無ければ自動で先頭曲を開始
      if (!appState.get().currentTrack) {
        await autoStartFirstTrack();
        return;
      }
      state.userPausedExplicitly = false;
      // ★ ロック画面 pause→resume で iOS の audio session が抑制状態のまま
      //   play() しても「進捗だけ進んで無音」になる問題への保険。
      //   ユーザー操作(play action)起点で audioSession.type="playback" を
      //   再宣言し、抑制状態の session 再アクティブ化を iOS に促す。
      //   feature-detection + try/catch 済みで非対応環境・非iOSでは no-op。
      //   この経路はロック画面の play ボタン押下時のみで、ended→次曲の自動
      //   遷移(loadAndPlay/playPreloadedSync は本ハンドラを経由しない)には
      //   一切干渉しない。playbackState/metadata にも触れないため一時停止
      //   表示・visibility resume 抑止も不変。
      setupAudioSession();
      // ★ セッションアクティベータ: 何も接続していない AudioContext を resume して
      //   iOS の audio session を再活性化してから play() する。コールドスタート後の
      //   最初のリモート再開が「進捗は進むが無音」になる実機不具合の根治策
      //   (ベースの mp3player と同じ方式。resumeSessionActivator のコメント参照)。
      await resumeSessionActivator();
      // ★ 再開ウォッチドッグ: play() が「失敗」または「無進行ストール」した場合に
      //   pause→play を自動再試行する保険。正常時は no-op。
      armResumeWatchdog();
      try {
        await audioEl.play();
      } catch (e) {
        // 失敗してもウォッチドッグが自動再試行するため、ここではログのみ残す
        console.warn("[audio-engine] remote play 失敗(ウォッチドッグが再試行します)", e);
      }
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      // 明示pause を記録（visibility 復帰時の自動resume 抑止に使う）
      state.userPausedExplicitly = true;
      // 保留中の自動再試行がこの明示 pause を覆さないように解除
      clearResumeWatchdog();
      try { audioEl.pause(); } catch {}
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());
    try {
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (d.seekTime != null) seekTo(d.seekTime);
      });
    } catch {}
    try {
      navigator.mediaSession.setActionHandler("stop", () => {
        state.userPausedExplicitly = true;
        clearResumeWatchdog(); // 保留中の自動再試行が stop を覆さないように解除
        try { audioEl.pause(); } catch {}
      });
    } catch {}
  } catch (e) {
    console.warn("mediaSession setActionHandler 失敗", e);
  }
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
 *
 * デスクトップでタブ/PWAを閉じた場合の保険として beforeunload だけ残す。
 * （モバイルではほぼ発火しない）
 */
function setupTerminationCleanup() {
  const fullCleanup = () => {
    try { audioEl.pause(); } catch {}
    try { audioEl.removeAttribute("src"); audioEl.load(); } catch {}
    if (state.currentObjectUrl) {
      try { URL.revokeObjectURL(state.currentObjectUrl); } catch {}
      state.currentObjectUrl = null;
    }
    if (navigator.mediaSession) {
      try { navigator.mediaSession.metadata = null; } catch {}
      try { navigator.mediaSession.playbackState = "none"; } catch {}
    }
  };
  // ★ pagehide / pageshow は登録しない（上述の理由）
  // デスクトップでタブを閉じる程度の操作にだけ反応
  window.addEventListener("beforeunload", fullCleanup);
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

function updateMediaSessionMetadata(track) {
  if (!("mediaSession" in navigator)) return;

  // ★ アートワーク URL は ID 単位でキャッシュした安定 URL を使う。
  //   キューリピートで「1曲目 → 2曲目 → また1曲目」のような遷移をしたとき、
  //   毎回 createObjectURL/revokeObjectURL を繰り返すと iOS の
  //   ロック画面側の非同期フェッチと噛み合わずアートワークが空白になる。
  //   同じ track.id では同じ URL を返すことで、iOS の画像キャッシュも効く。
  const artwork = [];
  const artUrl = getArtworkUrl(track);
  if (artUrl) {
    const mime = (track.artworkBlob && track.artworkBlob.type) || "image/jpeg";
    artwork.push({ src: artUrl, sizes: "512x512", type: mime });
  }
  // フォールバック：アプリアイコン（artwork 無しの曲でもロック画面が空にならないように）
  if (artwork.length === 0) {
    artwork.push({ src: "./icons/icon-512.png", sizes: "512x512", type: "image/png" });
    artwork.push({ src: "./icons/icon-192.png", sizes: "192x192", type: "image/png" });
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "不明",
      artist: track.artist || "不明",
      album: track.album || "",
      artwork,
    });
  } catch (e) {
    console.warn("MediaMetadata 失敗", e);
  }

  // ★ position state を「新トラックの duration、position=0」で確定。
  //   audio.duration ではなく track.duration を渡すことで、
  //   iOS Safari の loadedmetadata 直後の audio.duration 微小遅延を回避する。
  updateMediaPositionState({ position: 0, duration: track.duration });
}
