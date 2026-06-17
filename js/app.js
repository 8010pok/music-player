/**
 * アプリケーションエントリポイント
 *
 * - 設定読込・テーマ適用
 * - 認証状態の復元
 * - 音声エンジン / ミニプレイヤー 初期化
 * - ルーター起動
 * - Service Worker 登録
 * - オンライン復帰 → スクロブルキューフラッシュ
 * - ヘッダーステータス更新
 */

import { getPublic } from "./store/settings.js";
import { appState } from "./state.js";
import { register, start, go } from "./router.js";
import { initAudioEngine } from "./player/audio-engine.js";
import { initMiniPlayer } from "./ui/mini-player.js";
import { sendNowPlaying, sendScrobble, refreshBadge, installOnlineListener, flushQueue } from "./lastfm/scrobble.js";
import { bootstrapAuth, getAuth } from "./lastfm/auth.js";
import { countTracks } from "./store/library-db.js";
// 統計サブシステム(stats-service.js とその依存ツリー)は初回描画に不要なので静的 import せず、
//   起動後に動的 import する(起動時の JS パースを初回描画後へ回し、黒画面の時間を短縮する)。

// ★ 定数定義（マジックナンバー回避）
// 起動時に scrobble キューを flush するまでの遅延。
// 端末の OS ネットワーク状態確定を待つため少しだけ遅らせる。
const STARTUP_FLUSH_DELAY_MS = 1500;

// beforeinstallprompt は早期に発火する可能性があるためルート登録前に拾う
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__deferredInstallPrompt = e;
});

// 各ビューは動的 import（初期表示の体感を速くする）
async function loadView(name) {
  switch (name) {
    case "welcome":      return import("./ui/view-welcome.js");
    case "player":       return import("./ui/view-player.js");
    case "library":      return import("./ui/view-library.js");
    case "playlists":    return import("./ui/view-playlists.js");
    case "playlist":     return import("./ui/view-playlist.js");
    case "playlist-add": return import("./ui/view-playlist-add.js");
    case "stats":        return import("./ui/view-stats.js");
    case "settings":     return import("./ui/view-settings.js");
  }
}

/**
 * 表示モードとライブラリ状態から最初のビューを決める
 *
 * - ブラウザ (非 standalone) → welcome
 * - standalone & 曲なし     → library （追加導線へ）
 * - standalone & 曲あり     → player
 *
 * ※ URL に既に #/xxx がついていればルータがそちらを優先するので、
 *   ここでは「未指定時のフォールバック」だけを返す。
 */
async function chooseInitialRoute() {
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
                       || window.navigator.standalone === true;
  if (!isStandalone) return "welcome";
  try {
    // 件数だけ要るので count() を使う。getAllTracks() だと全曲レコード(artworkBlob 込み)を
    //   読み出して初回描画を遅らせる(取り込み後ほど黒画面が長引く)ため避ける。
    const n = await countTracks();
    return n > 0 ? "player" : "library";
  } catch {
    return "library";
  }
}

async function main() {
  // 1. テーマ適用
  const pub = getPublic();
  document.documentElement.dataset.theme = pub.theme || "system";

  // 2. appState の初期同期
  appState.set({
    theme: pub.theme || "system",
    enableAudioEffects: !!pub.enableAudioEffects,
    shuffleMode: !!pub.shuffleMode,
    repeatMode: pub.repeatMode || "none",
    username: pub.username || null,
    // オーディオエフェクト関連 (永続化値を復元)
    eqGains: pub.eqGains || {},
    eqPreset: pub.eqPreset || "flat",
    preamp: Number(pub.preamp) || 0,
    bassBoost: Number(pub.bassBoost) || 0,
    compressor: pub.compressor || "off",
    pan: Number(pub.pan) || 0,
    stereoWidth: Number(pub.stereoWidth ?? 1),
    vocalRemove: Number(pub.vocalRemove) || 0,
    mono: !!pub.mono,
    noiseReduction: pub.noiseReduction || "off",
    audioOutputDeviceId: pub.audioOutputDeviceId || "",
    // audio 要素プロパティ
    playbackRate: Number(pub.playbackRate ?? 1),
    preservesPitch: pub.preservesPitch !== false,
  });

  // 3. 認証復元（初回描画をブロックしないよう、ここでは起動だけして後で待つ）。
  //    再生画面の表示に認証は不要。認証の復元(ストレージ読込/復号)は初回描画と並行して進め、
  //    auth 依存処理(バッジ/統計起動)に入る前に start() 後で authReady を await する。
  const authReady = bootstrapAuth().catch((e) => {
    console.warn("bootstrapAuth 失敗", e);
  });

  // 4. 音声エンジン（Last.fm コールバック注入）
  //    設定の scrobbleEnabled / nowPlayingEnabled で送信を抑止できる。
  //    どちらもデフォルト true。フル認証時のみ実際の API 送信が走る。
  initAudioEngine({
    onNowPlaying: (track) => {
      const p = getPublic();
      if (p.nowPlayingEnabled === false) return;
      // Now Playing 送信は一過性なので失敗してもキューに積まない。
      // 診断のため warn ログだけは残す。
      sendNowPlaying(track).catch((e) => {
        console.warn("[app] sendNowPlaying 失敗", e);
      });
    },
    onScrobble: (track, dur, startedAtMs) => {
      const p = getPublic();
      if (p.scrobbleEnabled === false) {
        // 設定でスクロブル無効化されている場合は送信せず、UI 表示も無効を示す
        appState.set({ scrobbleResult: "skipped" });
        return;
      }
      // sendScrobble は "sent" | "ignored" | "queued" | "failed" | "skipped" を返す。
      // 結果を appState に反映することで、再生画面の表示メッセージが
      //   - 送信成功 → 「スクロブル送信済」
      //   - オフライン等でキュー登録 → 「スクロブルをキューに登録」
      // のように正確に切り替わる。
      //
      // startedAtMs は audio-engine から渡される曲の再生開始時刻 (ms)。
      // sendScrobble の timestamp に使われて Last.fm 上の時刻がユーザの
      // 体感に一致する。
      sendScrobble(track, dur, startedAtMs)
        .then((result) => {
          appState.set({ scrobbleResult: result || "failed" });
        })
        .catch((e) => {
          console.warn("sendScrobble 例外", e);
          appState.set({ scrobbleResult: "failed" });
        });
    },
  });

  // 5. ミニプレイヤー
  initMiniPlayer();

  // 6. ルート登録（動的読込）
  register("welcome", async (root) => {
    const m = await loadView("welcome");
    return m.mount(root);
  });
  register("player", async (root) => {
    const m = await loadView("player");
    return m.mount(root);
  });
  register("library", async (root) => {
    const m = await loadView("library");
    return m.mount(root);
  });
  register("playlists", async (root) => {
    const m = await loadView("playlists");
    return m.mount(root);
  });
  register("playlist", async (root) => {
    const m = await loadView("playlist");
    return m.mount(root);
  });
  register("playlist-add", async (root) => {
    const m = await loadView("playlist-add");
    return m.mount(root);
  });
  register("stats", async (root) => {
    const m = await loadView("stats");
    return m.mount(root);
  });
  register("settings", async (root) => {
    const m = await loadView("settings");
    return m.mount(root);
  });

  // 起動時の初期ビューを「ブラウザ / standalone × 曲の有無」で切替
  const initial = await chooseInitialRoute();
  start(document.getElementById("view-root"), initial);

  // ★ ここで再生画面の初回描画が完了(黒画面の終了)。以降の auth 依存処理(バッジ/統計起動)に
  //   入る前に、並行起動した認証復元の完了を待つ(従来の「認証復元後に後続処理」順序を保つ)。
  await authReady;

  // 7. オンライン復帰イベントでキューを流す
  installOnlineListener();
  await refreshBadge();
  // 起動時にもキュー試行 (1.5 秒遅延でネットワーク確定を待つ)
  if (navigator.onLine) {
    setTimeout(() => {
      flushQueue().catch((e) => {
        // 起動時 flushQueue 失敗は致命的ではない (オンライン復帰イベントで再試行)
        // が、原因把握のため警告ログとして残す
        console.warn("[app] 起動時 flushQueue 失敗", e);
      });
    }, STARTUP_FLUSH_DELAY_MS);
  }

  // 8. Service Worker 登録
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.warn("SW 登録失敗", e);
    }
  }

  // 9. ヘッダ状態の購読
  //
  // ステータスピルの表示優先度（高 → 低）:
  //   1. 未送信スクロブル件数がある → 「未送信スクロブル N 件」(err 表示)
  //      これは認証状態より優先する（オフライン中に送信されていないことを
  //      ユーザに気付かせるため）
  //   2. フル認証中 → 「Last.fm: ユーザ名」(ok 表示)
  //   3. 読取専用認証 → 「読取専用: ユーザ名」
  //   4. 未認証 → 空文字
  //
  // scrobbleQueueCount は scrobble.js の refreshBadge() がキュー操作後に
  // 更新するので、enqueue/送信/破棄のいずれの操作でも自動的にここで反映される。
  const updateStatusPill = (s) => {
    const pill = document.getElementById("status-pill");
    if (!pill) return;
    pill.classList.remove("is-ok", "is-err");
    if ((s.scrobbleQueueCount || 0) > 0) {
      pill.textContent = `未送信スクロブル ${s.scrobbleQueueCount} 件`;
      pill.classList.add("is-err");
    } else if (s.authState === "authenticated") {
      pill.textContent = `Last.fm: ${s.username || ""}`;
      pill.classList.add("is-ok");
    } else if (s.authState === "key-only") {
      pill.textContent = `読取専用: ${s.username || ""}`;
    } else {
      pill.textContent = "";
    }
  };
  // appState.subscribe は登録時に必ず初回発火する（state.js subscribe）ため、
  // ここで updateStatusPill を別途呼ばなくても起動直後のステータスピルは描画される。
  appState.subscribe(["authState", "username", "scrobbleQueueCount"], updateStatusPill);

  // 10. 統計バックグラウンドサービス起動 + ヘッダー進捗インジケータ購読（提案A）
  //
  // 起動時に「今日（JST）のデータが既に IndexedDB にあれば取得しない」
  // 「無ければバックグラウンドで取得開始」する。
  // 統計画面に居ない間も Worker / fetch を継続する。
  //
  // ※ 音声経路 (<audio>/MediaSession/AudioContext) には一切触らない。
  //   iOS のロック画面・バックグラウンド再生は完全に独立。
  // 統計サブシステムは初回描画に不要なため動的 import で遅延読込する(起動時の JS パースを
  //   初回描画後へ回す)。以降の subscribe / startIfNeeded はこのモジュールを使う。
  //   ★ 読込失敗(オフライン+未キャッシュ等)は致命的でない(統計は背景機能)。失敗を main の
  //     catch へ伝播させると描画済みの再生画面が「起動失敗」で上書きされてしまうため、ここで
  //     握りつぶし統計だけ無効化する(以降の使用は statsService の null ガードで保護)。
  let statsService = null;
  try {
    statsService = await import("./lastfm/stats-service.js");
  } catch (e) {
    console.warn("[app] 統計サービス読込失敗(統計は無効化)", e);
  }
  const statsPill = document.getElementById("stats-progress-pill");
  if (statsService && statsPill) {
    statsService.subscribe((s) => {
      if (s.status === "fetching") {
        let label = "📊 " + (s.activity || "集計中");
        if (s.workerProgress && s.workerProgress.totalPages > 0) {
          label += ` (${s.workerProgress.page}/${s.workerProgress.totalPages})`;
        } else if (s.progress && s.progress.total > 0) {
          label += ` (${s.progress.current}/${s.progress.total})`;
        }
        statsPill.textContent = label;
        statsPill.hidden = false;
      } else {
        statsPill.hidden = true;
        statsPill.textContent = "";
      }
    });
  }
  // ユーザ名があれば起動時に取得開始（await しない＝ブロックしない）。
  // ただし apiKey が無い(secret 復号失敗・iOS のストレージ自動削除で username だけ
  // 残った)不整合状態では取得しない。さもないと全タスクが apiKey 無しで失敗し、
  // 起動直後に誤エラートーストが出る(LIFE-4)。
  const pubAfterBoot = getPublic();
  if (statsService && pubAfterBoot.username) {
    getAuth().then((auth) => {
      if (auth && auth.apiKey) {
        statsService.startIfNeeded(pubAfterBoot.username).catch((e) => {
          console.warn("[app] statsService.startIfNeeded 失敗", e);
        });
      }
    }).catch(() => {});
  }
}

main().catch((e) => {
  console.error("起動失敗", e);
  const root = document.getElementById("view-root");
  if (root) root.innerHTML = `<div class="empty-state">起動失敗: ${e.message || e}</div>`;
});
