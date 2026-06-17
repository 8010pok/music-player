/**
 * 再生ビュー（Now Playing）
 *
 * 表示:
 *   - アートワーク / 曲情報
 *   - シークバー + 経過/残り
 *   - 再生・前後・シャッフル・リピート・Love
 *   - スクロブル進捗バー
 *   - スペクトラム + RMS/Peak メーター
 */

import { appState } from "../state.js";
import { getAudioElement, togglePlay, playNext, playPrev, seekTo, setShuffleMode, setRepeatMode, setPlaybackRate } from "../player/audio-engine.js";
import { getPublic, setPublic } from "../store/settings.js";
import { extractMetadata } from "../metadata/index.js";
import { initVisualizer, startVisualizer, stopVisualizer, decodePcmForVisualization } from "../player/visualizer.js";
import { setLoved } from "../lastfm/scrobble.js";
import { formatTime, toast, escapeHtml } from "./components.js";
import { getBlob, updateTrack } from "../store/library-db.js";
import { getArtworkUrl } from "./artwork-cache.js";

/**
 * 独自コントロール用の inline SVG アイコン群。
 * - すべて fill:currentColor で描画し、is-active 等の状態色(アクセント)を継承する。
 * - 絵文字依存をやめることで色変化(ON/OFF)が確実に視認でき、サイズも CSS で統一できる。
 * - play/pause と repeat/repeat-one は両方を内包し、CSS クラス(is-playing / is-one)で出し分ける。
 */
const ICONS = {
  shuffle: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>',
  prev: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z"/></svg>',
  play: '<svg class="ic ic-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg class="ic ic-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  repeat: '<svg class="ic ic-repeat" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  repeatOne: '<svg class="ic ic-repeat-one" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2zm-3-2v-6h-1l-2 1v1h1.5v4z"/></svg>',
  heart: '<svg class="ic ic-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>',
  back15: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle">15</text></svg>',
  fwd15: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle">15</text></svg>',
};

// シークバーのドラッグ中フラグ。range はタッチ操作中に activeElement にならない
// ことがあり、その間 onTimeUpdate 由来の値更新で seekBar 値が巻き戻る(UI ちらつき)。
// updateUI は mount 外の関数のため module スコープに置く。pointerdown〜pointerup/change で制御。
let isSeeking = false;

export async function mount(root) {
  root.innerHTML = render();
  const refs = collectRefs(root);

  // 再マウント時にドラッグ中フラグをリセット(module スコープ変数)。
  isSeeking = false;

  // ビジュアライザ初期化
  initVisualizer({
    canvas: refs.canvas,
    rmsBar: refs.rmsBar,
    peakBar: refs.peakBar,
    audioEl: getAudioElement(),
  });
  startVisualizer();

  // 状態購読
  // scrobbleResult を含めることで、送信成功/キュー登録/失敗のメッセージを
  // 即座に反映できる。
  const unsub = appState.subscribe(
    ["currentTrack", "isPlaying", "duration", "currentTime", "scrobbleProgress", "scrobbleResult", "shuffleMode", "repeatMode", "authState"],
    (s) => updateUI(refs, s)
  );

  // ===== 歌詞(同期/非同期)表示 (P3) =====
  // 状態は mount スコープのクロージャで保持する。
  let currentLyrics = null;   // { synced:[{timeMs,text}]|null, unsynced:string|null } | null
  let lyricsVisible = false;  // オーバーレイ表示中か(ユーザの切替。曲を跨いで維持)
  let syncedLines = [];       // [{ timeMs, el }] 同期歌詞の行要素
  let lastActiveIdx = -1;
  let lyricsRaf = 0;

  // 歌詞行を描画。innerHTML を使わず textContent ベースで XSS を防ぐ。
  function renderLyricsLines(lyrics) {
    refs.lyricsLines.innerHTML = "";
    syncedLines = [];
    if (lyrics?.synced?.length) {
      for (const ln of lyrics.synced) {
        const div = document.createElement("div");
        div.className = "lyrics-line is-synced";
        div.textContent = ln.text || " "; // 空行も高さを確保
        // 行タップで頭出し(同期歌詞のみ)。seekTo のみ使用で iOS 再生経路に副作用なし。
        div.addEventListener("click", () => seekTo((ln.timeMs || 0) / 1000));
        refs.lyricsLines.appendChild(div);
        syncedLines.push({ timeMs: ln.timeMs, el: div });
      }
    } else if (lyrics?.unsynced) {
      for (const raw of lyrics.unsynced.split(/\r?\n/)) {
        const div = document.createElement("div");
        div.className = "lyrics-line";
        div.textContent = raw || " ";
        refs.lyricsLines.appendChild(div);
      }
    }
  }

  // 同期ハイライトの rAF ループ。
  //   - getAudioElement().currentTime を read-only 参照するだけで、audio 要素・
  //     MediaSession・AudioContext には一切触れない(iOS ロック画面/BG再生に無影響)。
  //   - オーバーレイ表示中かつ document が visible のときだけ回す
  //     (ロック中/バックグラウンドでは確実に停止)。
  function lyricsTick() {
    lyricsRaf = 0;
    if (!lyricsVisible || !syncedLines.length || document.hidden) return;
    const audioEl = getAudioElement();
    const curMs = (audioEl?.currentTime || 0) * 1000;
    // curMs 以下で最大の timeMs を持つ行を二分探索
    let lo = 0, hi = syncedLines.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (syncedLines[mid].timeMs <= curMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    // 行が変わったときだけ DOM 更新(低速端末のジャンク回避)
    if (idx !== lastActiveIdx) {
      if (lastActiveIdx >= 0 && syncedLines[lastActiveIdx]) {
        syncedLines[lastActiveIdx].el.classList.remove("is-active");
      }
      if (idx >= 0 && syncedLines[idx]) {
        const el = syncedLines[idx].el;
        el.classList.add("is-active");
        // オーバーレイ内に限定してセンタースクロール(ページ全体はスクロールさせない)
        const ov = refs.lyricsOverlay;
        const target = el.offsetTop - ov.clientHeight / 2 + el.offsetHeight / 2;
        // 動き低減設定(prefers-reduced-motion)を尊重。動きに敏感なユーザには即時スクロール。
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        ov.scrollTo({ top: Math.max(0, target), behavior: reduce ? "auto" : "smooth" });
      }
      lastActiveIdx = idx;
    }
    scheduleLyricsTick();
  }
  function scheduleLyricsTick() { if (!lyricsRaf) lyricsRaf = requestAnimationFrame(lyricsTick); }
  function stopLyricsTick() { if (lyricsRaf) { cancelAnimationFrame(lyricsRaf); lyricsRaf = 0; } }

  // オーバーレイの表示/非表示(歌詞⇄ジャケット)
  function showLyrics(show) {
    if (!currentLyrics) show = false;
    lyricsVisible = show;
    refs.lyricsOverlay.hidden = !show;
    refs.lyricsOverlay.setAttribute("aria-hidden", show ? "false" : "true");
    refs.lyricsToggle.classList.toggle("is-active", show);
    refs.lyricsToggle.textContent = show ? "ジャケット" : "歌詞";
    refs.lyricsToggle.setAttribute("aria-label", show ? "ジャケットを表示" : "歌詞を表示");
    if (show) { lastActiveIdx = -1; scheduleLyricsTick(); }
    else {
      stopLyricsTick();
      // 非表示にする際、現在ハイライト中の行から is-active を除去しておく。
      // これを怠ると再表示時(lastActiveIdx=-1 リセット)に旧行の is-active が残り、
      // 新しい行と二重ハイライトになる(トグル再表示パス固有の不具合)。
      if (lastActiveIdx >= 0 && syncedLines[lastActiveIdx]) {
        syncedLines[lastActiveIdx].el.classList.remove("is-active");
      }
      lastActiveIdx = -1;
    }
  }

  // 曲のロード結果に応じて歌詞を適用。
  //   synced あり → カラオケ表示 / unsynced のみ → 静的表示 / 無し → UI 自体を隠す。
  function applyLyrics(lyrics) {
    stopLyricsTick();
    lastActiveIdx = -1;
    const has = !!(lyrics && (lyrics.synced?.length || (lyrics.unsynced && lyrics.unsynced.trim())));
    currentLyrics = has ? lyrics : null;
    if (!currentLyrics) {
      // 歌詞なし: トグルもオーバーレイも出さない(仕様: タグが無ければ表示不可)
      refs.lyricsToggle.hidden = true;
      refs.lyricsOverlay.hidden = true;
      refs.lyricsOverlay.setAttribute("aria-hidden", "true");
      refs.lyricsLines.innerHTML = "";
      syncedLines = [];
      return;
    }
    refs.lyricsToggle.hidden = false;
    renderLyricsLines(currentLyrics);
    showLyrics(lyricsVisible); // ユーザの表示設定を曲を跨いで維持
  }

  refs.lyricsToggle.addEventListener("click", () => showLyrics(!lyricsVisible));
  // ジャケットタップで歌詞を表示(歌詞があり、かつ非表示のときのみ)
  refs.art.addEventListener("click", () => { if (currentLyrics && !lyricsVisible) showLyrics(true); });

  // バックグラウンド/ロック中は rAF を停止し、復帰時に表示中なら再開する。
  const onLyricsVisibility = () => {
    if (document.hidden) stopLyricsTick();
    else if (lyricsVisible) scheduleLyricsTick();
  };
  document.addEventListener("visibilitychange", onLyricsVisibility);

  // 現在曲の Blob を1回だけ取得し、ビジュアライザ用 PCM デコードと歌詞抽出に共用する
  // (getBlob の二重取得を避ける)。
  // ★ alive: この async コールバックが await(getBlob / extractMetadata)中にビューが
  //   unmount された場合、購読解除では既に走っている本体は止まらない。await 復帰後に
  //   alive を確認し、unmount 後は detached DOM への applyLyrics や rAF 再起動を行わない
  //   (自己永続 rAF リーク・detached DOM 保持の防止)。
  let alive = true;
  let lastBlobId = null;
  const decodeUnsub = appState.subscribe(["currentTrack"], async (s) => {
    const tid = s.currentTrack?.id || null;
    if (tid === lastBlobId) return;
    lastBlobId = tid;
    applyLyrics(null); // 前曲の歌詞をクリア(誤表示防止)
    if (!tid) return;
    let blob = null;
    try { blob = await getBlob(tid); } catch {}
    // await 中の曲変更・ビュー離脱は破棄
    if (!alive || appState.get().currentTrack?.id !== tid) return;
    if (!blob) return;
    // ビジュアライザ用 PCM デコード(OfflineAudioContext 使用で iOS でもオーディオ
    // セッション非干渉)。失敗は無視。
    decodePcmForVisualization(blob).catch(() => {});
    // 歌詞抽出(同じ blob を再利用)。extractMetadata は AudioContext を使わない。
    try {
      const name = s.currentTrack.originalName || ((s.currentTrack.title || "audio") + "." + (s.currentTrack.format || ""));
      const meta = await extractMetadata(new File([blob], name, { type: s.currentTrack.mime || blob.type || "" }));
      if (!alive || appState.get().currentTrack?.id !== tid) return;
      applyLyrics(meta?.lyrics || null);
    } catch {}
  });

  // イベント結線
  refs.playBtn.addEventListener("click", () => togglePlay());
  refs.prevBtn.addEventListener("click", () => playPrev());
  refs.nextBtn.addEventListener("click", () => playNext());
  refs.shuffleBtn.addEventListener("click", () => setShuffleMode(!appState.get().shuffleMode));
  refs.repeatBtn.addEventListener("click", () => {
    const cur = appState.get().repeatMode;
    const next = cur === "none" ? "all" : cur === "all" ? "one" : "none";
    setRepeatMode(next);
  });
  refs.seekBar.addEventListener("input", () => {
    const dur = appState.get().duration || 0;
    // duration 未確定(0)のときは比率計算が常に 0 になり、どこへドラッグしても曲頭へ
    //   飛んでしまうため、シーク自体を抑止する(duration 確定後は通常どおり動作)。
    if (dur <= 0) return;
    seekTo((+refs.seekBar.value) * dur / 1000);
  });
  // ドラッグ中は updateUI の seekBar 値上書きを抑止(タッチで activeElement に
  // ならないケースの巻き戻り防止)。これらは root 再生成で破棄されるため明示解除不要。
  refs.seekBar.addEventListener("pointerdown", () => { isSeeking = true; });
  refs.seekBar.addEventListener("pointerup", () => { isSeeking = false; });
  refs.seekBar.addEventListener("pointercancel", () => { isSeeking = false; });
  refs.seekBar.addEventListener("change", () => { isSeeking = false; });
  // ±15 秒スキップ(早送り/巻き戻し相当)。seekTo のみ使用し audio 経路に副作用なし。
  refs.back15Btn.addEventListener("click", () => {
    const cur = appState.get().currentTime || 0;
    seekTo(Math.max(0, cur - 15));
  });
  refs.fwd15Btn.addEventListener("click", () => {
    const s = appState.get();
    const dur = s.duration || 0;
    const target = (s.currentTime || 0) + 15;
    seekTo(dur > 0 ? Math.min(dur, target) : target);
  });
  // 再生速度 / ピッチ維持 (audio要素プロパティのみ、iPhoneロック画面に影響しない)
  const pubInit = getPublic();
  const initialRate = Number(pubInit.playbackRate ?? 1);
  const initialPitchPreserve = pubInit.preservesPitch !== false;
  if (refs.rateSlider) {
    refs.rateSlider.value = String(Math.round(initialRate * 100));
    refs.rateValue.textContent = initialRate.toFixed(2) + "x";
    refs.rateSlider.addEventListener("input", () => {
      const rate = (parseFloat(refs.rateSlider.value) || 100) / 100;
      refs.rateValue.textContent = rate.toFixed(2) + "x";
      setPlaybackRate(rate, getPublic().preservesPitch !== false);
      setPublic({ playbackRate: rate });
      appState.set({ playbackRate: rate });
    });
  }
  if (refs.rateQuickBtns) {
    for (const btn of refs.rateQuickBtns) {
      btn.addEventListener("click", () => {
        const rate = (parseFloat(btn.dataset.rate) || 100) / 100;
        if (refs.rateSlider) refs.rateSlider.value = String(Math.round(rate * 100));
        refs.rateValue.textContent = rate.toFixed(2) + "x";
        setPlaybackRate(rate, getPublic().preservesPitch !== false);
        setPublic({ playbackRate: rate });
        appState.set({ playbackRate: rate });
      });
    }
  }
  if (refs.pitchChk) {
    refs.pitchChk.checked = initialPitchPreserve;
    refs.pitchChk.addEventListener("change", () => {
      const v = refs.pitchChk.checked;
      setPlaybackRate(getPublic().playbackRate ?? 1, v);
      setPublic({ preservesPitch: v });
      appState.set({ preservesPitch: v });
    });
  }

  // 「曲の情報」 トグル: 開く時に Blob を動的にパースして表示 (永続化なし)
  let infoOpen = false;
  let infoLastTrackId = null;
  // ★ 曲変更時の自動再表示 subscribe の unsubscribe を保持する。
  //   これを捕捉せずに放置すると、再生画面に出入りするたびに購読が累積し、
  //   破棄済みの古い refs (detached DOM) を掴んだコールバックが曲変更のたびに
  //   走り続けるリーク (メモリ + DOM + 無駄処理) になる。
  let infoUnsub = null;
  if (refs.infoToggle && refs.infoBody) {
    refs.infoToggle.addEventListener("click", async () => {
      infoOpen = !infoOpen;
      if (!infoOpen) {
        refs.infoBody.hidden = true;
        refs.infoToggle.textContent = "ℹ 曲の情報 ▼";
        return;
      }
      refs.infoBody.hidden = false;
      refs.infoToggle.textContent = "ℹ 曲の情報 ▲";
      await loadTrackInfo(refs, () => alive);
    });
    // 曲が変わった時、開いていれば自動的に再表示
    infoUnsub = appState.subscribe(["currentTrack"], async (s) => {
      const id = s.currentTrack?.id || null;
      if (id !== infoLastTrackId) {
        infoLastTrackId = id;
        if (infoOpen) await loadTrackInfo(refs, () => alive);
      }
    });
  }

  // Love 操作の多重実行防止フラグ。setLoved(API)/updateTrack(IDB) 完了まで
  // 連打を無視する(同じ古い t.loved から二重に同方向トグルするのを防ぐ)。
  let loveInFlight = false;
  refs.loveBtn.addEventListener("click", async () => {
    const t = appState.get().currentTrack;
    if (!t) return;
    if (loveInFlight) return; // 進行中は無視(連打ガード)
    loveInFlight = true;
    const loved = !t.loved;
    const tTitle = t.title || "この曲"; // toast 用に操作対象を明示(曲変更で表示と食い違っても誤認しない)
    try {
      // Last.fm フル認証済みの場合は API にも反映する。
      // ただしオフライン時は API 呼び出しをスキップしてローカルのみ更新する。
      // （以前は API 失敗で catch に落ち、ローカル updateTrack まで到達しなかった）
      if (appState.get().authState === "authenticated") {
        if (!navigator.onLine) {
          // オフライン: ローカルのみ更新し、Last.fm には反映されない旨を通知
          await updateTrack(t.id, { loved });
          // await 中に曲が変わっていたら currentTrack を上書きしない。
          // 旧 t で巻き戻すと表示/ロック画面/onTimeUpdate が旧曲を掴む(SVC レース)。
          if (appState.get().currentTrack?.id === t.id) {
            appState.set({ currentTrack: { ...appState.get().currentTrack, loved } });
          }
          toast("「" + tTitle + "」を" + (loved ? "Love しました" : "Love 解除しました") + "（オフライン中のため Last.fm には未反映）", "info");
          return;
        }
        await setLoved(t, loved);
      }
      await updateTrack(t.id, { loved });
      // await(setLoved/updateTrack)中に曲が変わっていたら currentTrack を上書きしない。
      // 旧 t で巻き戻すと表示/ロック画面/onTimeUpdate が旧曲を掴む(SVC レース)。
      if (appState.get().currentTrack?.id === t.id) {
        appState.set({ currentTrack: { ...appState.get().currentTrack, loved } });
      }
      // toast はガード外で発火するため、操作対象を曲名で明示する。曲を切り替えた直後でも
      // 「どの曲を Love したか」が一目で分かり、表示中の曲との取り違えを防ぐ。
      // フル認証していない(key-only/anonymous)場合は Last.fm へ送信されずローカルのみ
      // 更新されるため、その旨を明示して「Last.fm に反映された」と誤認させない。
      const authed = appState.get().authState === "authenticated";
      toast(
        "「" + tTitle + "」を" + (loved ? "Love しました" : "Love 解除しました") +
          (authed ? "" : "（ローカルのみ・Last.fm 連携には認証が必要）"),
        authed ? "ok" : "info"
      );
    } catch (e) {
      toast(String(e.message || e), "err");
    } finally {
      loveInFlight = false;
    }
  });

  // クリーンアップ
  return () => {
    alive = false; // in-flight な decodeUnsub コールバックの await 復帰後処理を無効化
    unsub();
    decodeUnsub();
    if (infoUnsub) infoUnsub();
    stopVisualizer();
    // 歌詞の rAF と visibilitychange 購読を確実に解除(detached DOM を掴み続けない)
    stopLyricsTick();
    document.removeEventListener("visibilitychange", onLyricsVisibility);
  };
}

function render() {
  return `
    <section class="player-view">
      <div class="player-art-wrap" id="player-art-wrap">
        <img class="player-art" id="player-art" alt="" />
        <!-- 歌詞オーバーレイ(初期 hidden。表示制御・同期ハイライトは P3 で配線) -->
        <div class="player-lyrics-overlay" id="player-lyrics-overlay" hidden aria-hidden="true">
          <div class="lyrics-lines" id="lyrics-lines"></div>
        </div>
        <!-- 歌詞⇄ジャケット切替ボタン(歌詞がある曲でのみ P3 で表示) -->
        <button class="lyrics-toggle" id="btn-lyrics-toggle" hidden aria-label="歌詞を表示">歌詞</button>
      </div>
      <div class="player-meta">
        <h2 class="player-title" id="player-title">—</h2>
        <p class="player-artist" id="player-artist">—</p>
        <p class="player-album" id="player-album"></p>
      </div>

      <div class="player-seek">
        <input class="seek-bar" id="seek-bar" type="range" min="0" max="1000" value="0" />
        <div class="seek-time"><span id="t-cur">0:00</span><span id="t-dur">0:00</span></div>
      </div>

      <!-- メインコントロール: 1行バー(シャッフル・前・再生(中央FAB)・次・リピート) -->
      <div class="player-controls">
        <button class="icon-btn" id="btn-shuffle" aria-label="シャッフル" title="シャッフル">${ICONS.shuffle}</button>
        <button class="icon-btn" id="btn-prev" aria-label="前の曲" title="前の曲">${ICONS.prev}</button>
        <button class="icon-btn big" id="btn-play" aria-label="再生">${ICONS.play}${ICONS.pause}</button>
        <button class="icon-btn" id="btn-next" aria-label="次の曲" title="次の曲">${ICONS.next}</button>
        <button class="icon-btn" id="btn-repeat" aria-label="リピート" title="リピート">${ICONS.repeat}${ICONS.repeatOne}</button>
      </div>

      <!-- 補助コントロール: 15秒戻る・Love・15秒進む -->
      <div class="player-secondary">
        <button class="icon-btn" id="btn-back15" aria-label="15秒戻る" title="15秒戻る">${ICONS.back15}</button>
        <button class="icon-btn" id="btn-love" aria-label="Love" title="Love">${ICONS.heart}</button>
        <button class="icon-btn" id="btn-fwd15" aria-label="15秒進む" title="15秒進む">${ICONS.fwd15}</button>
      </div>

      <!-- 再生モード表示（5 パターンを文言で明示） -->
      <div class="playback-mode" id="playback-mode" aria-live="polite">再生モード: なし</div>

      <div class="scrobble-progress">
        <div class="scrobble-progress-bar">
          <div class="scrobble-progress-fill" id="scrobble-fill"></div>
        </div>
        <div class="scrobble-progress-label" id="scrobble-label">スクロブル待機</div>
      </div>

      <div class="visualizer-wrap">
        <div class="visualizer-meters" aria-hidden="true">
          <div class="meter"><div class="meter-fill" id="rms-bar"></div></div>
          <div class="meter"><div class="meter-fill" id="peak-bar"></div></div>
        </div>
        <canvas id="visualizer-canvas"></canvas>
      </div>

      <!--
        再生速度・ピッチ維持
        - audio.playbackRate / audio.preservesPitch のみ操作するため、
          AudioContext (createMediaElementSource) を使わない。
        - これは enableAudioEffects=OFF でも動作し、iPhone のロック画面・
          バックグラウンド再生にも影響しない安全な機能。
      -->
      <div class="playback-rate-wrap" id="rate-wrap">
        <div class="rate-row">
          <div class="rate-label">再生速度</div>
          <input class="rate-slider" id="rate-slider" type="range" min="50" max="200" step="5" value="100" />
          <div class="rate-value" id="rate-value">1.00x</div>
        </div>
        <div class="rate-quick">
          <button class="btn-mini" data-rate="50">0.5x</button>
          <button class="btn-mini" data-rate="75">0.75x</button>
          <button class="btn-mini" data-rate="100">1x</button>
          <button class="btn-mini" data-rate="125">1.25x</button>
          <button class="btn-mini" data-rate="150">1.5x</button>
          <button class="btn-mini" data-rate="200">2x</button>
          <label class="pitch-preserve">
            <input type="checkbox" id="pitch-chk" />
            <span>ピッチ維持</span>
          </label>
        </div>
      </div>

      <!--
        曲の情報 (トグル開閉)
        - ボタンタップで「ファイル情報」「音声プロパティ」「メタデータ」を表示
        - 再度タップで非表示
        - 表示時は再生中ファイルの Blob を取り出して動的にパース (永続化なし)
      -->
      <div class="track-info-wrap" id="track-info-wrap">
        <button class="btn-info-toggle" id="btn-info-toggle">ℹ 曲の情報 ▼</button>
        <div class="track-info-body" id="track-info-body" hidden></div>
      </div>
    </section>
  `;
}

function collectRefs(root) {
  return {
    art: root.querySelector("#player-art"),
    title: root.querySelector("#player-title"),
    artist: root.querySelector("#player-artist"),
    album: root.querySelector("#player-album"),
    seekBar: root.querySelector("#seek-bar"),
    tCur: root.querySelector("#t-cur"),
    tDur: root.querySelector("#t-dur"),
    playBtn: root.querySelector("#btn-play"),
    prevBtn: root.querySelector("#btn-prev"),
    nextBtn: root.querySelector("#btn-next"),
    shuffleBtn: root.querySelector("#btn-shuffle"),
    repeatBtn: root.querySelector("#btn-repeat"),
    loveBtn: root.querySelector("#btn-love"),
    back15Btn: root.querySelector("#btn-back15"),
    fwd15Btn: root.querySelector("#btn-fwd15"),
    artWrap: root.querySelector("#player-art-wrap"),
    lyricsOverlay: root.querySelector("#player-lyrics-overlay"),
    lyricsLines: root.querySelector("#lyrics-lines"),
    lyricsToggle: root.querySelector("#btn-lyrics-toggle"),
    scrobbleFill: root.querySelector("#scrobble-fill"),
    scrobbleLabel: root.querySelector("#scrobble-label"),
    modeLabel: root.querySelector("#playback-mode"),
    canvas: root.querySelector("#visualizer-canvas"),
    rmsBar: root.querySelector("#rms-bar"),
    peakBar: root.querySelector("#peak-bar"),
    rateSlider: root.querySelector("#rate-slider"),
    rateValue: root.querySelector("#rate-value"),
    rateQuickBtns: Array.from(root.querySelectorAll(".rate-quick .btn-mini")),
    pitchChk: root.querySelector("#pitch-chk"),
    infoToggle: root.querySelector("#btn-info-toggle"),
    infoBody: root.querySelector("#track-info-body"),
  };
}

function updateUI(refs, s) {
  const t = s.currentTrack;
  if (!t) {
    refs.title.textContent = "再生中の曲はありません";
    refs.artist.textContent = "ライブラリから曲を選んでください";
    refs.album.textContent = "";
    refs.art.removeAttribute("src");
    refs.playBtn.classList.remove("is-playing");
    refs.playBtn.setAttribute("aria-label", "再生");
    refs.seekBar.value = 0;
    refs.tCur.textContent = "0:00";
    refs.tDur.textContent = "0:00";
    refs.scrobbleFill.style.width = "0%";
    refs.scrobbleLabel.textContent = "—";
    refs.loveBtn.classList.remove("is-active");
    // 曲が無くてもシャッフル/リピートの設定状態をアイコンに反映する
    // (下の再生モードラベルと整合させる。曲未選択で再生画面を開いた際の食い違い防止)
    refs.shuffleBtn.classList.toggle("is-active", !!s.shuffleMode);
    refs.repeatBtn.classList.toggle("is-active", s.repeatMode !== "none");
    refs.repeatBtn.classList.toggle("is-one", s.repeatMode === "one");
    // 曲が無くてもモード状態は反映しておく（ユーザの設定状態を見せる）
    if (refs.modeLabel) {
      const isModeActive = !!s.shuffleMode || s.repeatMode !== "none";
      refs.modeLabel.textContent = "再生モード: " + describePlaybackMode(s);
      refs.modeLabel.classList.toggle("is-active", isModeActive);
    }
    return;
  }

  refs.title.textContent = t.title || "(無題)";
  refs.artist.textContent = t.artist || "(不明)";
  refs.album.textContent = t.album || "";

  // アートワーク URL は ID キャッシュ経由で取得（URL再生成しないため
  // 更新ごとの一瞬の画像消えやリーク・読込失敗を避けられる）
  const artUrl = getArtworkUrl(t) || t.artworkUrl || null;
  if (artUrl) {
    if (refs.art.getAttribute("src") !== artUrl) {
      refs.art.src = artUrl;
    }
  } else {
    refs.art.removeAttribute("src");
  }

  // is-playing クラスで再生/一時停止アイコン(SVG)を CSS 側で出し分ける
  refs.playBtn.classList.toggle("is-playing", !!s.isPlaying);
  // aria-label も状態に追従させる (アイコンだけだとスクリーンリーダーに伝わらない)
  refs.playBtn.setAttribute("aria-label", s.isPlaying ? "一時停止" : "再生");

  const dur = s.duration || 0;
  const cur = s.currentTime || 0;
  refs.tCur.textContent = formatTime(cur);
  refs.tDur.textContent = formatTime(dur);
  if (!isSeeking && document.activeElement !== refs.seekBar) {
    // duration 未確定(0)の曲では前曲のスライダ位置が視覚的に残らないよう 0 にリセットする
    //   (duration 確定後は通常どおり経過比率を反映)。
    refs.seekBar.value = dur > 0 ? Math.floor((cur / dur) * 1000) : 0;
  }

  refs.scrobbleFill.style.width = `${Math.round((s.scrobbleProgress || 0) * 100)}%`;
  if (s.scrobbleProgress >= 1) {
    // 進捗 1 達成。実際の送信結果（scrobbleResult）に応じて表示を切り替える。
    //   "sent"    : Last.fm へ送信成功 (accepted)
    //   "ignored" : リクエストは成功したが Last.fm が拒否 (古い timestamp 等)
    //   "queued"  : オフライン等で送信失敗 → キューに登録（オンライン復帰で自動送信）
    //   "failed"  : 送信もキュー保存も失敗（IDB エラー等）
    //   "skipped" : 未認証 or 設定で無効化
    //   "sending" / "none": 結果未確定（送信中）
    switch (s.scrobbleResult) {
      case "queued":
        refs.scrobbleLabel.textContent = "スクロブルをキューに登録（オンライン復帰で送信）";
        break;
      case "failed":
        refs.scrobbleLabel.textContent = "スクロブル送信失敗";
        break;
      case "skipped":
        refs.scrobbleLabel.textContent = "スクロブル無効（設定または未認証）";
        break;
      case "sent":
        refs.scrobbleLabel.textContent = "スクロブル送信済";
        break;
      case "ignored":
        refs.scrobbleLabel.textContent = "Last.fm に拒否されました";
        break;
      default:
        // "sending" もしくは未確定: 送信処理は走ったが結果がまだ届いていない
        refs.scrobbleLabel.textContent = "スクロブル送信中…";
        break;
    }
  } else if (s.authState === "authenticated") {
    refs.scrobbleLabel.textContent = `スクロブル進捗 ${Math.round((s.scrobbleProgress || 0) * 100)}%`;
  } else {
    refs.scrobbleLabel.textContent = "Last.fm 未認証（スクロブル無効）";
  }

  refs.shuffleBtn.classList.toggle("is-active", !!s.shuffleMode);
  refs.repeatBtn.classList.toggle("is-active", s.repeatMode !== "none");
  // is-one クラスで repeat / repeat-one アイコン(SVG)を CSS 側で出し分ける
  refs.repeatBtn.classList.toggle("is-one", s.repeatMode === "one");
  // Love は is-active でハート塗り(塗り/輪郭)を CSS 側で切り替える
  refs.loveBtn.classList.toggle("is-active", !!t.loved);
  refs.loveBtn.setAttribute("aria-label", t.loved ? "Love 解除" : "Love");

  // 再生モード表示の更新（5 パターン）
  if (refs.modeLabel) {
    const isModeActive = !!s.shuffleMode || s.repeatMode !== "none";
    refs.modeLabel.textContent = "再生モード: " + describePlaybackMode(s);
    refs.modeLabel.classList.toggle("is-active", isModeActive);
  }
}

/**
 * 現在の shuffleMode / repeatMode の組から、ユーザ表示用の日本語文言を返す。
 *
 *   shuffle=false, repeat=none → "なし"
 *   shuffle=true,  repeat=none → "シャッフル"
 *   shuffle=false, repeat=all  → "キューリピート"
 *   shuffle=false, repeat=one  → "単曲リピート"
 *   shuffle=true,  repeat=all  → "シャッフル＋キューリピート"
 *
 * （shuffle=true + repeat=one は audio-engine 側で排他化済みなので発生しない）
 */
function describePlaybackMode(s) {
  const sh = !!s.shuffleMode;
  const r = s.repeatMode;
  if (sh && r === "all") return "シャッフル＋キューリピート";
  if (sh) return "シャッフル";
  if (r === "all") return "キューリピート";
  if (r === "one") return "単曲リピート";
  return "なし";
}

/* ============ 「曲の情報」 動的パース & 描画 ============ */

/**
 * 現在再生中の曲の Blob を取り出してパースし、 ファイル情報・音声プロパティ・メタを表示。
 *   - 永続化はしない (track にも DB にも書き戻さない)
 *   - 取得できない項目は「—」表示
 *   - await 中に曲が変わったら描画を中断 (stale な情報を表示しない)
 */
async function loadTrackInfo(refs, isAlive = () => true) {
  if (!refs.infoBody) return;
  const t = appState.get().currentTrack;
  if (!t) {
    refs.infoBody.innerHTML = `<div class="empty-state" style="padding:8px;">再生中の曲がありません</div>`;
    return;
  }
  refs.infoBody.innerHTML = `<div class="skeleton skeleton-line" style="width:80%;height:14px;margin:6px 0;"></div>`;
  try {
    const blob = await getBlob(t.id);
    // await 中にビューが unmount されていたら detached DOM への書き込みを避ける
    // (decodeUnsub と同じ alive ガード。GC 遅延・無駄描画の防止)。
    if (!isAlive()) return;
    // getBlob の await 中に曲が変わっていたら、この描画は破棄 (新しい曲の
    // loadTrackInfo が別途走る)。stale な情報を一瞬表示するのを防ぐ。
    if (appState.get().currentTrack?.id !== t.id) return;
    if (!blob) {
      refs.infoBody.innerHTML = `<div class="empty-state" style="padding:8px;">ファイルが見つかりませんでした</div>`;
      return;
    }
    // 一時 File 風オブジェクトを作って extractMetadata へ
    const fileLike = new File([blob], t.originalName || (t.title || "audio") + "." + (t.format || ""), { type: t.mime || blob.type || "" });
    const meta = await extractMetadata(fileLike);
    // unmount 後は detached DOM へ書かない / 曲変更時も破棄
    if (!isAlive()) return;
    // extractMetadata の await 中の曲変更も同様にチェック
    if (appState.get().currentTrack?.id !== t.id) return;
    if (!refs.infoBody) return;
    refs.infoBody.innerHTML = renderTrackInfo(t, meta);
  } catch (e) {
    if (!isAlive()) return;
    // await 中に曲が変わっていたら、この(旧曲の)エラー描画で新曲の情報を上書きしない
    //   (成功パス 680/691 と対称)。
    if (appState.get().currentTrack?.id !== t.id) return;
    if (!refs.infoBody) return;
    refs.infoBody.innerHTML = `<div class="empty-state" style="padding:8px;">情報の取得に失敗: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function renderTrackInfo(track, meta) {
  const dash = "—";
  const fmt = (v) => (v === null || v === undefined || v === "") ? dash : String(v);
  const fmtKHz = (hz) => hz ? (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) + " kHz" : dash;
  const fmtBitrate = (kbps) => kbps ? kbps + " kbps" : dash;
  const fmtChannels = (n) => n === 1 ? "モノラル (1ch)" : n === 2 ? "ステレオ (2ch)" : n ? `${n} ch` : dash;
  const fmtBitDepth = (bd) => bd ? bd + " bit" : dash;
  const fmtBytes = (n) => {
    if (!n) return dash;
    const units = ["B", "KB", "MB", "GB"];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  };
  const ap = meta.audioProps || {};
  const fmtVbr = ap.vbr === true ? "VBR" : ap.vbr === false ? "CBR" : dash;

  const rowsFile = [
    ["ファイル名", fmt(track.originalName)],
    ["形式", fmt((meta.format || track.format || "").toUpperCase())],
    ["MIMEタイプ", fmt(meta.mime || track.mime)],
    ["ファイルサイズ", fmtBytes(track.fileSize)],
  ];
  const rowsAudio = [
    ["コーデック", fmt(ap.codec)],
    ["サンプリングレート", fmtKHz(ap.sampleRate)],
    ["ビットレート", fmtBitrate(ap.bitrate)],
    ["チャンネル", fmtChannels(ap.channels)],
    ["ビット深度", fmtBitDepth(ap.bitDepth)],
    ["VBR / CBR", fmtVbr],
    ["再生時間", meta.duration ? formatDuration(meta.duration) : dash],
  ];
  const rowsMeta = [
    ["タイトル", fmt(meta.title)],
    ["アーティスト", fmt(meta.artist)],
    ["アルバム", fmt(meta.album)],
    ["アルバムアーティスト", fmt(meta.albumArtist)],
    ["作曲者", fmt(meta.composer)],
    ["年", fmt(meta.year)],
    ["ジャンル", fmt(meta.genre)],
    ["トラック番号", fmt(meta.trackNo)],
    ["ディスク番号", fmt(meta.discNo)],
    ["BPM", fmt(meta.bpm)],
  ];

  const renderSection = (title, rows) => `
    <div class="info-section">
      <h4>${escapeHtml(title)}</h4>
      <table class="info-table">
        ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}
      </table>
    </div>
  `;
  return renderSection("ファイル情報", rowsFile)
       + renderSection("音声プロパティ", rowsAudio)
       + renderSection("メタデータ", rowsMeta);
}

// escapeHtml は components.escapeHtml と完全に同じ実装だったので統一
// (escapeAttr も同様。export は components.js に集約済み)

function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  return `${m}:${String(ss).padStart(2,"0")}`;
}
