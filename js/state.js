/**
 * 軽量な中央ステート（EventTargetベース）
 *
 * - 再生中のトラック、キュー、スクロブル状態、設定キャッシュなどを保持
 * - 画面間で共有する必要があるものだけここに置く
 * - 各ビューは subscribe して必要なフィールドを参照する
 */

class AppState extends EventTarget {
  constructor() {
    super();
    this._state = {
      // 再生関連
      currentTrack: null,    // { id, title, artist, album, ... }
      isPlaying: false,
      duration: 0,
      currentTime: 0,
      queue: [],             // 再生キュー（id列）
      queueIndex: -1,
      shuffleMode: false,
      repeatMode: "none",    // "none" | "one" | "all"

      // スクロブル進捗
      scrobbleProgress: 0,   // 0..1（条件達成で 1）
      nowPlayingSent: false,
      scrobbledForCurrent: false,
      // スクロブル送信結果（再生画面の表示メッセージ切替に使用）
      //   "none":    未送信 / 進捗 1 未満
      //   "sending": 送信中（onScrobble 呼出後、結果待ち）
      //   "sent":    Last.fm へ送信成功 (accepted)
      //   "ignored": リクエストは成功したが Last.fm が拒否 (タイムスタンプ古い等)
      //   "queued":  オフライン等で送信失敗 → キューに登録（後で flush）
      //   "failed":  送信もキュー保存も失敗
      //   "skipped": 未認証等で送信せず
      scrobbleResult: "none",
      // 未送信スクロブル（オフラインキュー）の件数。
      //   - scrobble.js の refreshBadge() がキュー操作後にこの値を更新する
      //   - 画面上部のステータスピル（app.js）と設定画面のキュー件数表示
      //     （view-settings.js）が共通でこれを購読し、常に一致するようにする
      scrobbleQueueCount: 0,

      // Last.fm
      authState: "anonymous", // "anonymous" | "key-only" | "authenticated"
      username: null,

      // 「現在再生中のキューがどのプレイリスト由来か」
      //   - null  : プレイリスト以外（ライブラリ/autoStart 等）から再生中
      //   - 文字列: そのIDのプレイリストから再生中
      currentPlaylistId: null,
      currentPlaylistName: null,

      // 表示状態
      theme: "system",        // "system" | "dark" | "light"
      enableAudioEffects: false, // EQ等。iOS バックグラウンド再生を壊すのでデフォルトOFF

      // オーディオエフェクト (enableAudioEffects=true のときのみ実音声に反映)
      eqGains: { 31: 0, 62: 0, 125: 0, 250: 0, 500: 0, 1000: 0, 2000: 0, 4000: 0, 8000: 0, 16000: 0 },
      eqPreset: "flat",
      preamp: 0,
      bassBoost: 0,
      compressor: "off",
      pan: 0,
      stereoWidth: 1,
      vocalRemove: 0,
      mono: false,
      noiseReduction: "off",
      audioOutputDeviceId: "",

      // audio 要素プロパティ (enableAudioEffects 関係なく動く)
      playbackRate: 1.0,
      preservesPitch: true,

      isIOS: detectIOS(),
    };
  }

  get() {
    return this._state;
  }

  /**
   * 状態を部分更新し、変更を通知
   * @param {Partial<typeof this._state>} patch
   */
  set(patch) {
    const prev = this._state;
    const next = { ...prev, ...patch };
    // 変更があったキーだけ通知
    const changedKeys = [];
    for (const k of Object.keys(patch)) {
      if (prev[k] !== patch[k]) changedKeys.push(k);
    }
    this._state = next;
    if (changedKeys.length === 0) return;
    this.dispatchEvent(new CustomEvent("change", {
      detail: { prev, next, changedKeys },
    }));
  }

  /**
   * 特定キーの変更を購読
   * @param {string|string[]} keys
   * @param {(state) => void} fn
   * @returns {() => void} 解除関数
   */
  subscribe(keys, fn) {
    const set = new Set(Array.isArray(keys) ? keys : [keys]);
    const listener = (e) => {
      const hit = e.detail.changedKeys.some((k) => set.has(k));
      if (hit) fn(this._state);
    };
    this.addEventListener("change", listener);
    // 初回も発火
    fn(this._state);
    return () => this.removeEventListener("change", listener);
  }
}

/**
 * iOS / iPadOS 判定
 * - iPadOS は MacIntel + touch で判定（Safari の偽装に対応）
 */
function detectIOS() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS Safari は MacIntel と名乗る
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}

export const appState = new AppState();
