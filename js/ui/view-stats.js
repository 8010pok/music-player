/**
 * 統計ビュー（Last.fm 自分の情報）
 *
 * === 新しい設計（バックグラウンドサービス購読型） ===
 *
 *   - データ取得・集計は statsService（シングルトン）がバックグラウンドで実行
 *   - 本ビューはサービスを購読し、保持された「表示用に整形済みのデータ」を
 *     画面に流すだけ。fetch / Worker は一切触らない。
 *   - タブ切替 = サービス保持データから該当タブを再描画するだけ（再 fetch しない）
 *   - 画面遷移してもサービスは継続動作。戻ったときに進捗を引き継ぐ。
 *   - 更新は「JST 日付が変わったとき」または「🔄 更新」ボタン押下時のみ
 *
 * タブ:
 *   - ダッシュボード: プロフィール + クイックカード + 今週サマリー + Listening DNA + 最近
 *   - トップ:        期間切替 + アーティスト/アルバム/トラック
 *   - 比較:          範囲切替 + アーティスト/アルバム/トラック + 新しい発見
 *   - ジャンル:      ジャンル DNA + ジャンル踏破率 + 年代分布
 *   - 世界と自分:    メインストリーム度 + 国別チャート照合 + トップ曲の世界順位
 *   - 振り返り:      年別グラフ + 各年トップ3 + マイルストン
 *   - 時間:          リスニングクロック + 時間帯 + 平日/週末 + ヒートマップ + 月別
 *   - Loved:         Loved トラック
 */

import * as statsService from "../lastfm/stats-service.js";
import { getSimilarArtists, getArtistInfo, getAlbumInfo, getTopTracks } from "../lastfm/stats.js";
import { cached, ckey } from "../lastfm/stats-cache.js";
import { getPublic } from "../store/settings.js";
import { toast, escapeHtml, escapeAttr } from "./components.js";

// escapeHtml=テキストノード用、escapeAttr=属性値用（どちらも components.js で null-safe）

// メインタブ定義（render で動的にアクティブクラスを当てるため配列化）
const MAIN_TABS = [
  { value: "dashboard", label: "ダッシュボード" },
  { value: "top",       label: "トップ" },
  { value: "compare",   label: "比較" },
  { value: "genre",     label: "ジャンル" },
  { value: "world",     label: "世界と自分" },
  { value: "rewind",    label: "振り返り" },
  { value: "time",      label: "時間" },
  { value: "loved",     label: "Loved" },
];

const PERIODS = [
  { value: "7day",    label: "1週間" },
  { value: "1month",  label: "1ヶ月" },
  { value: "3month",  label: "3ヶ月" },
  { value: "6month",  label: "6ヶ月" },
  { value: "12month", label: "12ヶ月" },
  { value: "overall", label: "全期間" },
];

const COMPARE_RANGES = [
  { value: "week",  label: "今週 vs 先週" },
  { value: "month", label: "今月 vs 先月" },
  { value: "year",  label: "今年 vs 去年" },
];

// ビュー内のローカル状態
let currentTab = "dashboard";
let currentPeriod = "overall";        // top タブ内の期間選択
let currentCompareRange = "week";     // compare タブ内の範囲選択
let refs = null;
let unsubService = null;

// 再描画最適化: 前回描画したセクションデータの参照を保持。
// ライブポーリング（30 秒おき）や status 変化など、データ自体が変わらない
// notify ではタブ内容を再描画する必要がない (同一参照ならスキップ)。
// ダブルバッファリングで古いデータを表示中も、新データが commit された
// 瞬間に参照が切替わるので即座に新描画されて「瞬時切替」が実現する。
//
// NEVER_RENDERED は「一度も描画していない」状態を表すセンチネル。
// sections.{tab} が null（取得失敗時）でも _lastRenderedSectionRef === null と
// 誤一致して loading 画面のまま固まるバグを防ぐ。
const _NEVER_RENDERED = Symbol("never_rendered");
let _lastRenderedSectionRef = _NEVER_RENDERED;
// 時間タブの進捗バナーは state.status に依存するため、status 変化(fetching→done)時にも
// 再描画が必要(セクション参照は不変なので参照短絡だけだと「集計中…」のまま固定される)。
let _lastRenderedStatus = null;
// 比較タブは top セクションから画像を補完するため、top の到着でも再描画が要る。
// その判定用に compare 描画時の top 参照を別途保持する(UI-3)。
let _lastTopRefForCompare = _NEVER_RENDERED;
// 統計画面のモーダル(アルバム詳細/類似アーティスト)の backdrop ハンドラ。
// close を経ずに別モーダルへ上書きされた場合に前回分を解除するため保持する(UI-4)。
let _statsModalBackdrop = null;

// Chart.js インスタンス（再描画で再利用）
let chartMonth = null, chartArtist = null;
let chartClock = null, chartTimeOfDay = null, chartWeekdayWeekend = null;
let chartRewindYear = null;
let chartDiscovery = null;                       // 時間タブ: 発見の歴史
let chartGenre = null, chartDecade = null;       // ジャンルタブ: DNA ドーナツ / 年代分布
let chartLovedTimeline = null;                   // Loved タブ: 月別 Love 数

export async function mount(root) {
  root.innerHTML = render();
  refs = collectRefs(root);

  // 認証チェック
  const pub = getPublic();
  if (!pub.username) {
    refs.tabContent.innerHTML = `
      <div class="empty-state">
        Last.fm のユーザ名と API キーが必要です。<br/>
        設定画面から登録してください。
      </div>
    `;
    return () => {};
  }

  // タブクリック
  refs.tabs.forEach((tb) => {
    tb.addEventListener("click", () => {
      // 離脱後(cleanup で refs=null 化)にハンドラが発火しても安全に無視する。
      // 他のハンドラ・描画関数(refs?.tabContent 等)と同じガード方針に揃える。
      if (!refs) return;
      refs.tabs.forEach((x) => x.classList.toggle("is-active", x === tb));
      currentTab = tb.dataset.tab;
      // 前回 run が中断/部分失敗で未完了(complete:false)のまま、前面・オンライン・非ダッシュボードタブに
      //   滞在し続けると visibilitychange/online/再マウントのいずれも発火せず回復契機を逃すため、タブ切替
      //   という明示操作を回復契機に加える。retryIfIncomplete は完了済み/取得中/ユーザ無し/永続エラーでは
      //   no-op、二重起動は runFetch 冒頭の runSeq 世代ガードで吸収されるためタイトループにならない。
      statsService.retryIfIncomplete();
      // タブ切替時は必ず再描画するため参照キャッシュをリセット
      _lastRenderedSectionRef = _NEVER_RENDERED;
      destroyAllCharts();
      // ダッシュボードに入った時のみライブポーリング ON、他タブでは OFF
      if (currentTab === "dashboard") {
        statsService.startDashboardLiveUpdates();
      } else {
        statsService.stopDashboardLiveUpdates();
      }
      renderCurrentTab(statsService.getState());
    });
  });

  // 手動更新ボタン
  refs.refreshBtn.addEventListener("click", async () => {
    // オフライン時は即座にフィードバックを返す。
    // オンラインチェックをしないと withRetry が 4s→12s(maxAttempts=3=計2回の待機)×6タスク分
    // リトライし続け、エラーまでに長時間かかる。
    if (!navigator.onLine) {
      toast("オフラインです。オンライン時に更新できます", "info");
      return;
    }
    refs.refreshBtn.disabled = true;
    refs.refreshBtn.textContent = "更新中…";
    try {
      await statsService.refresh();
    } catch (e) {
      toast("更新失敗: " + (e.message || e), "err");
    } finally {
      // refresh() は内部で done/error を通知するので状態購読側で UI 復帰。
      // await 中に画面離脱 → cleanup() で refs=null 化されると、ここで参照すると
      // TypeError を投げ未処理例外になる。離脱後はそもそも復帰不要なので null ガードする。
      if (refs?.refreshBtn) {
        refs.refreshBtn.disabled = false;
        refs.refreshBtn.textContent = "🔄 更新";
      }
    }
  });

  // サービス購読 → 状態変化を受信して該当タブを再描画
  unsubService = statsService.subscribe((state) => {
    updateRefreshLabel(state);
    renderCurrentTab(state);
  });

  // 初期描画：既に保持しているデータを表示
  const initialState = statsService.getState();
  updateRefreshLabel(initialState);
  renderCurrentTab(initialState);

  // まだ取得が走っていなければ開始（app.js でも呼ばれるが念のため）
  if (pub.username && initialState.status === "idle") {
    statsService.startIfNeeded(pub.username).catch((e) => {
      console.warn("[view-stats] startIfNeeded 失敗", e);
    });
  } else if (pub.username) {
    // 既に取得済み(done)でも、前回 run が中断/部分失敗で未完了(一部タブ欠損のまま complete:false)なら、
    //   統計画面の再マウント時に再取得して完遂させる(同セッション内のリトライ)。完了済み/取得中は no-op。
    statsService.retryIfIncomplete();
  }

  // 初期タブがダッシュボードならライブポーリング開始
  // (Now Playing を即座に検知して表示するため。読取専用でも apiKey があれば動作)
  if (currentTab === "dashboard" && pub.username) {
    // ユーザを stats-service に渡してから start（statsService.startIfNeeded が
    // まだ完了していない場合に備える）
    statsService.setUserAndStartLive(pub.username);
  }

  // online/offline 状態の変化に対応：
  //   - オンライン → オフライン: Now Playing カードを即座に消す
  //   - オフライン → オンライン: 次の live update で最新状態が反映される
  // renderCurrentTab は _lastRenderedSectionRef で差分判定するので、参照を
  // リセットして強制再描画する。
  const onConnectivityChange = () => {
    _lastRenderedSectionRef = _NEVER_RENDERED;
    renderCurrentTab(statsService.getState());
    if (navigator.onLine) {
      // オンライン復帰=中断要因が解消した瞬間。前回 run が瞬断等で一部セクション欠損のまま
      //   done(complete:false)になっていれば、ここで再取得して完遂させる(前面滞在・画面に留まったまま
      //   オンライン復帰した場合は visibilitychange も再マウントも起きず回復契機を逃すため)。
      //   retryIfIncomplete は完了済み/取得中/ユーザ無しでは no-op、二重起動は runSeq 世代ガードで吸収。
      statsService.retryIfIncomplete();
      // ダッシュボードのライブ更新も即時実行する(次の 30 秒 tick を待たず Now Playing/リスニング数を
      //   最新化。SVC-3live)。
      if (currentTab === "dashboard") statsService.triggerLiveUpdateNow();
    }
  };
  window.addEventListener("online", onConnectivityChange);
  window.addEventListener("offline", onConnectivityChange);

  return () => {
    if (unsubService) unsubService();
    unsubService = null;
    // 統計画面を離れたらライブポーリングを停止
    statsService.stopDashboardLiveUpdates();
    destroyAllCharts();
    // 開いたままの統計モーダルを閉じ、backdrop ハンドラを解除する。
    // #modal-root は他画面の confirm/promptForm(openModal)と共有するため、残存
    // ハンドラが他画面ダイアログの backdrop クリックを誤消費し、ダイアログを
    // Promise 未解決のまま消去する事故(await ハング)を防ぐ。
    if (_statsModalBackdrop) {
      const mr = document.getElementById("modal-root");
      if (mr) {
        try { mr.removeEventListener("click", _statsModalBackdrop); } catch {}
        // 統計モーダルが開いたまま離脱した場合のみ閉じる(他画面の openModal は消さない)
        if (mr.querySelector("#album-close") || mr.querySelector("#similar-close")) {
          mr.hidden = true;
          mr.innerHTML = "";
        }
      }
      _statsModalBackdrop = null;
    }
    window.removeEventListener("online", onConnectivityChange);
    window.removeEventListener("offline", onConnectivityChange);
    // 参照キャッシュをリセット（次回マウント時に確実に再描画）
    _lastRenderedSectionRef = _NEVER_RENDERED;
    refs = null;
  };
}

/* ============ レイアウト ============ */

function render() {
  // currentTab はモジュールスコープで保持されるため、画面遷移を跨いで戻った
  // ときも前回のタブが active として復元される。
  // ※ 以前は `is-active` がダッシュボードにハードコードされており、戻った
  //   ときに「コンテンツは時間タブ、ハイライトはダッシュボード」という
  //   食い違いが発生していた。
  return `
    <section class="stats-view">
      <div class="stats-header">
        <div class="stats-tabs">
          ${MAIN_TABS.map((t) => `<button class="stats-tab ${t.value === currentTab ? "is-active" : ""}" data-tab="${t.value}">${escapeHtml(t.label)}</button>`).join("")}
        </div>
        <div class="stats-refresh">
          <span class="stats-last-fetched" id="stats-last-fetched"></span>
          <button class="btn-mini" id="stats-refresh-btn" title="キャッシュを破棄して最新データを取得">🔄 更新</button>
        </div>
      </div>
      <div id="stats-tab-content"></div>
    </section>
  `;
}

function collectRefs(root) {
  return {
    tabs: Array.from(root.querySelectorAll(".stats-tab")),
    tabContent: root.querySelector("#stats-tab-content"),
    refreshBtn: root.querySelector("#stats-refresh-btn"),
    lastFetchedEl: root.querySelector("#stats-last-fetched"),
  };
}

function updateRefreshLabel(state) {
  if (!refs || !refs.lastFetchedEl) return;
  if (state.status === "fetching") {
    const wp = state.workerProgress;
    let label = state.activity || "取得中…";
    if (wp.totalPages > 0) label += ` (${wp.page}/${wp.totalPages})`;
    refs.lastFetchedEl.textContent = label;
  } else if (state.fetchDate) {
    // 「2026-05-24 取得」のような表示
    refs.lastFetchedEl.textContent = `${state.fetchDate} 取得`;
  } else {
    refs.lastFetchedEl.textContent = "";
  }
}

/* ============ 現在タブ描画ディスパッチ ============ */

/**
 * 各タブのロード中メッセージ（データが揃うまで表示する）。
 *   - msg: 主タイトル
 *   - sub: 補足説明（時間タブ／ダッシュボードは Worker 進捗を動的に差し込む）
 */
const SECTION_LOADING_MESSAGES = {
  dashboard: {
    msg: "ダッシュボードを取得・集計中…",
    sub: "プロフィール／最近の曲／週次サマリー／リスニング分析を準備しています",
  },
  top: {
    msg: "トップチャートを取得中…",
    sub: "6 期間 (1週間〜全期間) × トラック・アーティスト・アルバム",
  },
  compare: {
    msg: "期間比較データを集計中…",
    sub: "今週／今月／今年 と前期間の順位変動を集計しています",
  },
  rewind: {
    msg: "振り返りデータを集計中…",
    sub: "Last.fm の全週次チャートを反復取得しています（初回は時間がかかります）",
  },
  time: {
    msg: "全期間履歴を集計中…",
    sub: "全 scrobble ページを取得して集計しています（最も時間がかかる処理です）",
  },
  loved: {
    msg: "Loved データを取得中…",
    sub: "Loved 全件を取得して月別タイムライン・記念日を集計しています",
  },
  genre: {
    msg: "ジャンル分析を集計中…",
    sub: "トップアーティストのタグ・代表アーティスト・アルバム年代を取得しています",
  },
  world: {
    msg: "世界チャートと照合中…",
    sub: "世界/国別チャートとの一致度・トップ曲の世界統計を取得しています",
  },
};

function renderSectionLoading(sectionName, state) {
  const info = SECTION_LOADING_MESSAGES[sectionName] || { msg: "取得中…", sub: "" };
  let sub = info.sub;
  // 時間タブとダッシュボード（Worker 反復が動いている間）は進捗を表示
  const wp = state.workerProgress;
  if ((sectionName === "time" || sectionName === "dashboard") && wp && wp.totalPages > 0) {
    sub = `全 ${wp.totalPages.toLocaleString()} ページ中 ${wp.page.toLocaleString()} を処理中`;
  }
  // 取得が長時間続いている場合、上部の「🔄 更新」ボタンへ誘導する案内を表示する。
  // (バックグラウンドで fetch がハングするケースの手動リカバリ手段)
  return `
    <div class="stats-loading">
      <div class="stats-loading-icon">📊</div>
      <div class="stats-loading-msg">${escapeHtml(info.msg)}</div>
      <div class="stats-loading-sub">${escapeHtml(sub)}</div>
      <div class="stats-loading-sub" style="margin-top:10px;color:var(--fg-muted);font-size:11px;">
        長時間進まない場合は画面上部の「🔄 更新」をタップしてください
      </div>
    </div>
  `;
}

function renderCurrentTab(state) {
  if (!refs || !refs.tabContent) return;
  const sec = state.sections || {};
  const ready = state.sectionReady || {};

  // 該当タブの sectionReady=false の間はロード文言のみを表示する。
  // データが揃った瞬間に notify されて自然に該当タブが本表示に切り替わる。
  if (!ready[currentTab]) {
    refs.tabContent.innerHTML = renderSectionLoading(currentTab, state);
    // ローディング中はセンチネルにリセット（ready=true になった時に必ず再描画）
    // null にすると sections[tab]=null（取得失敗時）と誤一致するため Symbol を使う
    _lastRenderedSectionRef = _NEVER_RENDERED;
    return;
  }

  // セクションデータ参照が前回と同じなら再描画しない (ダブルバッファ切替や
  // ライブポーリングで「データ未変化」の notify が来た時の無駄描画を抑止)。
  // 新データが原子的に commit された瞬間に参照が変わるため、自然と「瞬時切替」になる。
  //
  // ダッシュボードは Now Playing 等のライブ更新で頻繁に dashboard 参照が
  // 切替わるため、参照比較だけで十分機能する (常時 re-render は不要)。
  const sectionData = sec[currentTab];
  // 時間タブの進捗バナーは state.status 依存(集計中…/集計完了)。確定 commit 後 status→done に
  // 変わっても sec.time 参照は不変のため、参照短絡だけだとバナーが「集計中…」のまま固定される。
  // ダッシュボードも、Worker 失敗等で dna/quickCards が null のまま done になると参照短絡で
  // skeleton が残り続けるため、status 変化(fetching→done)で確実に空状態へ再描画する。
  // time/dashboard タブかつ status が前回描画時から変わったときは短絡せず再描画する。
  const statusChanged = (currentTab === "time" || currentTab === "dashboard") && state.status !== _lastRenderedStatus;
  _lastRenderedStatus = state.status;
  // 比較タブは top セクションの画像を補完するため、top 参照の変化でも再描画する。
  // (compare 先着 → top 後着 のとき compare 参照は不変だが画像補完が必要。UI-3)
  if (currentTab === "compare") {
    const topRef = sec.top;
    if (sectionData === _lastRenderedSectionRef && topRef === _lastTopRefForCompare) return;
    _lastRenderedSectionRef = sectionData;
    _lastTopRefForCompare = topRef;
  } else {
    if (sectionData === _lastRenderedSectionRef && !statusChanged) return;
    _lastRenderedSectionRef = sectionData;
  }

  if (currentTab === "dashboard") renderDashboard(sec.dashboard, state);
  else if (currentTab === "top") renderTop(sec.top);
  else if (currentTab === "compare") renderCompare(sec.compare);
  else if (currentTab === "genre") renderGenre(sec.genre);
  else if (currentTab === "world") renderWorld(sec.world);
  else if (currentTab === "rewind") renderRewind(sec.rewind);
  else if (currentTab === "time") renderTime(sec.time, state);
  else if (currentTab === "loved") renderLoved(sec.loved);
}

/* ============ ダッシュボード ============ */

function renderDashboard(d, state) {
  if (!refs?.tabContent) return;
  const loading = state.status === "fetching";

  // Now Playing 検知: recent[0] に @attr.nowplaying がある場合。
  // ただしオフライン時はライブ更新で最新状態を取れず、前回オンライン時の
  // 「再生中」状態が残ったまま表示され続けるため、表示しない。
  // (Last.fm の Now Playing 情報はオンライン通信を経由して初めて意味を持つ)
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  // Now Playing カードはライブ更新が確認した再生中状態(nowPlayingKey)に紐づける。
  //   recent は当日キャッシュから復元され、停止後も古い recent[0].nowPlaying が残るため、
  //   それ単独で判定すると「停止済みの曲」が一過性に再生中カードとして復活してしまう。
  //   ライブ更新が nowPlayingKey を立てている(=現在も再生中と確認済み)ときだけ表示する。
  const nowPlaying = online && d?.recent && d.recent[0] && d.recent[0].nowPlaying && d.nowPlayingKey
    ? d.recent[0]
    : null;

  refs.tabContent.innerHTML = `
    ${nowPlaying ? renderNowPlayingCard(nowPlaying, d?.nowPlayingInfo) : ""}

    <div class="stats-card">
      ${d?.userInfo ? renderProfile(d.userInfo) : (loading ? renderProfileSkeleton() : `<div class="empty-state">プロフィールデータがありません</div>`)}
    </div>

    <div class="quick-grid" id="quick-grid">
      ${renderQuickCards(d?.quickCards, loading)}
    </div>

    ${renderTrendCard(d?.trend)}

    <div class="stats-card">
      <h3>リスニング数</h3>
      ${renderListeningCounts(d?.listeningCounts, loading)}
    </div>

    <div class="stats-card">
      <h3>今週のサマリー（現在から遡って 7 日間）</h3>
      ${renderWeekSummary(d?.weekSummary, loading)}
    </div>

    <div class="stats-card">
      <h3>🧬 リスニング DNA</h3>
      ${renderDNA(d?.dna, loading)}
    </div>

    <div class="stats-card">
      <h3>最近聴いた曲</h3>
      <ul class="stats-list" id="recent-list">
        ${d?.recent && d.recent.length
          ? d.recent.map((t, i) => renderRecentRow(t, i + 1)).join("")
          : (loading ? skeletonRows(8) : `<li class="empty-state">データがありません</li>`)}
      </ul>
    </div>

    ${renderFriendsCard(d?.friends)}
  `;
}

/**
 * 30日トレンドカード (saveHistory の日次サマリーから日別 scrobble をスパークライン表示)
 *   - API 呼び出しなしの遊休データ活用。trend が null (読み出し失敗) のときは非表示
 *   - 蓄積が 2 日未満のときは「データ蓄積中」の案内
 */
function renderTrendCard(trend) {
  if (!trend) return "";
  if (trend.insufficient) {
    return `
      <div class="stats-card">
        <h3>📈 30日トレンド</h3>
        <div class="empty-state" style="padding:8px;">データ蓄積中 (${trend.days}/30日) — 毎日の利用で日別推移が見られるようになります</div>
      </div>
    `;
  }
  const daily = trend.daily || [];
  const counts = daily.map((d) => d.count);
  const maxV = Math.max(1, ...counts);
  const total = counts.reduce((s, v) => s + v, 0);
  const avg = counts.length ? Math.round(total / counts.length) : 0;
  // インライン SVG スパークライン (Chart.js を使わないのでライブ更新の再描画にも軽い)
  const W = 300, H = 60, PAD = 4;
  const stepX = counts.length > 1 ? (W - PAD * 2) / (counts.length - 1) : 0;
  const pts = counts.map((v, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (v / maxV) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const polyline = pts.join(" ");
  const areaPath = `M${PAD},${H - PAD} L${pts.join(" L")} L${(PAD + (counts.length - 1) * stepX).toFixed(1)},${H - PAD} Z`;
  const firstDate = daily[0]?.date || "";
  const lastDate = daily[daily.length - 1]?.date || "";
  return `
    <div class="stats-card">
      <h3>📈 30日トレンド (日別 scrobble)</h3>
      <svg class="trend-sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path d="${areaPath}" fill="rgba(255,94,126,0.18)"></path>
        <polyline points="${polyline}" fill="none" stroke="#ff5e7e" stroke-width="2"></polyline>
      </svg>
      <div class="trend-meta">
        <span>${escapeHtml(firstDate)} 〜 ${escapeHtml(lastDate)}</span>
        <span>平均 ${avg} 曲/日 ・ 最大 ${maxV} 曲</span>
      </div>
    </div>
  `;
}

/**
 * フレンドフィードカード。friends が null (未取得/エラー) または 0 人なら非表示。
 */
function renderFriendsCard(friends) {
  if (!friends || friends.length === 0) return "";
  return `
    <div class="stats-card">
      <h3>👥 フレンドの最近の曲</h3>
      <ul class="stats-list">
        ${friends.map((f) => {
          const art = f.image
            ? `<img src="${escapeAttr(f.image)}" alt="" referrerpolicy="no-referrer" />`
            : renderArt("", f.name);
          const trackHtml = f.track
            ? `${escapeHtml(f.track.name)} <small style="color:var(--fg-muted);">— ${escapeHtml(f.track.artist)}</small>`
            : `<small style="color:var(--fg-dim);">最近の再生情報なし</small>`;
          return `
            <li class="stats-item">
              ${art}
              <div class="name">
                <div>${escapeHtml(f.realname || f.name)}</div>
                <small style="color:var(--fg-muted);">${trackHtml}</small>
              </div>
              ${safeUrl(f.url) ? `<div class="count"><a href="${escapeAttr(safeUrl(f.url))}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:11px;">Last.fm</a></div>` : ""}
            </li>
          `;
        }).join("")}
      </ul>
    </div>
  `;
}

function renderNowPlayingCard(np, info) {
  // アートワークが空の場合は壊れた <img> を避け、頭文字フォールバックを使う
  const artHtml = np.image
    ? `<img class="now-playing-art" src="${escapeAttr(np.image)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="now-playing-art stats-art-fallback" style="background:hsl(${nameToHue(np.name)},50%,35%);">${escapeHtml((np.name || "?").charAt(0).toUpperCase())}</div>`;
  // 世界統計 (track.getInfo)。取得失敗時や情報なしの曲では行ごと省略する。
  let extraHtml = "";
  if (info && (info.listeners > 0 || info.playcount > 0)) {
    const parts = [];
    if (info.listeners > 0) parts.push(`🌍 世界のリスナー ${info.listeners.toLocaleString()} 人`);
    if (info.playcount > 0) parts.push(`▶ 総再生 ${info.playcount.toLocaleString()} 回`);
    if (info.userplaycount != null) parts.push(`あなたは ${info.userplaycount.toLocaleString()} 回${info.loved ? " ♥" : ""}`);
    const tags = (info.tags || []).map((t) => `<span class="np-tag">${escapeHtml(t)}</span>`).join("");
    extraHtml = `
      <div class="np-extra">${parts.map((p) => `<span>${escapeHtml(p)}</span>`).join("<span class='np-sep'>・</span>")}</div>
      ${tags ? `<div class="np-tags">${tags}</div>` : ""}
    `;
  }
  return `
    <div class="stats-card now-playing-card">
      <div class="now-playing-label">
        <span class="now-playing-dot"></span>
        <span>Last.fm Now Playing</span>
      </div>
      <div class="now-playing-content">
        ${artHtml}
        <div class="now-playing-text">
          <div class="now-playing-title">${escapeHtml(np.name)}</div>
          <div class="now-playing-artist">${escapeHtml(np.artist)}</div>
        </div>
      </div>
      ${extraHtml}
    </div>
  `;
}

function renderProfileSkeleton() {
  return `
    <div class="stats-profile">
      <div class="skeleton" style="width:64px;height:64px;border-radius:50%;"></div>
      <div>
        <div class="skeleton skeleton-line" style="width:140px;height:16px;"></div>
        <div class="skeleton skeleton-line" style="width:80px;"></div>
        <div class="skeleton skeleton-line" style="width:120px;"></div>
      </div>
    </div>
  `;
}

function renderProfile(info) {
  // プロフィール写真が未設定のユーザは空 URL になるため、<img src=""> の壊れた表示を避ける
  const avatarHtml = info.image
    ? `<img src="${escapeAttr(info.image)}" alt="" referrerpolicy="no-referrer" />`
    : renderArt("", info.name);
  return `
    <div class="stats-profile">
      ${avatarHtml}
      <div>
        <div style="font-weight:700;font-size:16px;">${escapeHtml(info.name)}</div>
        <div class="scrobble-count">${info.playcount.toLocaleString()} <small>scrobbles</small></div>
        <div style="font-size:11px;color:var(--fg-muted);">${escapeHtml(info.country)} ・ ${escapeHtml(info.registered)}</div>
      </div>
    </div>
  `;
}

function renderQuickCards(q, loading) {
  if (!q) {
    // Worker 集計失敗など、取得完了 (done) でも null になるケースでは空状態を表示。
    // loading=true のときはスケルトンで「取得中」を示す。
    if (!loading) {
      return `<div class="quick-card" style="grid-column:1/-1;"><div class="empty-state">データがありません</div></div>`;
    }
    return `
      ${quickCardSkeleton("累計時間")}
      ${quickCardSkeleton("平均 / 日")}
      ${quickCardSkeleton("最大 1 日")}
      ${quickCardSkeleton("連続日数")}
      ${quickCardSkeleton("ユニーク曲数")}
      ${quickCardSkeleton("ユニークアーティスト数")}
    `;
  }
  return `
    <div class="quick-card">
      <div class="quick-label">累計リスニング時間</div>
      <div class="quick-value">約 ${q.totalHours.toLocaleString()} <small>時間</small></div>
      <div class="quick-sub">${q.totalDays > 0 ? `約 ${q.totalDays} 日分 (1曲≈3.5分換算)` : "1曲≈3.5分で概算"}</div>
    </div>
    <div class="quick-card">
      <div class="quick-label">平均 / 聴いた日</div>
      <div class="quick-value">${q.avgPerDay} <small>曲</small></div>
      <div class="quick-sub">${q.totalScrobbles.toLocaleString()} scrobbles 累計</div>
    </div>
    <div class="quick-card">
      <div class="quick-label">最大の1日</div>
      <div class="quick-value">${q.maxDay}</div>
      <div class="quick-sub">${escapeHtml(q.maxDayDate)}</div>
    </div>
    <div class="quick-card">
      <div class="quick-label">連続日数</div>
      <div class="quick-value">${q.streak}</div>
      <div class="quick-sub"></div>
    </div>
    <div class="quick-card">
      <div class="quick-label">ユニーク曲数</div>
      <div class="quick-value">${q.uniqueTracks ? q.uniqueTracks.toLocaleString() : 0} <small>曲</small></div>
      <div class="quick-sub">スクロブルされた異なる曲の総数</div>
    </div>
    <div class="quick-card">
      <div class="quick-label">ユニークアーティスト数</div>
      <div class="quick-value">${q.uniqueArtists ? q.uniqueArtists.toLocaleString() : 0} <small>組</small></div>
      <div class="quick-sub">スクロブルされた異なるアーティスト数</div>
    </div>
  `;
}

function quickCardSkeleton(label) {
  return `<div class="quick-card"><div class="quick-label">${escapeHtml(label)}</div><div class="quick-value skeleton skeleton-line" style="width:60%;height:24px;"></div></div>`;
}

/**
 * 直近 24時間 / 7日 / 30日 の scrobble 件数を表示するカード。
 * 既存の週サマリーと同じ .week-summary / .week-row / .week-stat 構造を使い、
 * カードサイズを揃える。
 */
function renderListeningCounts(c, loading) {
  if (!c) {
    return loading
      ? `<div class="week-summary"><div class="skeleton skeleton-line" style="width:80%;"></div></div>`
      : `<div class="empty-state">データがありません</div>`;
  }
  const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString());
  return `
    <div class="week-summary">
      <div class="week-row">
        <div class="week-stat">
          <div class="week-stat-num">${fmt(c.today)}</div>
          <div class="week-stat-label">今日（直近24時間）</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-num">${fmt(c.week)}</div>
          <div class="week-stat-label">今週（直近7日）</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-num">${fmt(c.month)}</div>
          <div class="week-stat-label">今月（直近30日）</div>
        </div>
      </div>
    </div>
  `;
}

function renderWeekSummary(w, loading) {
  if (!w) {
    return loading
      ? `<div class="week-summary"><div class="skeleton skeleton-line" style="width:80%;"></div></div>`
      : `<div class="empty-state">データがありません</div>`;
  }
  return `
    <div class="week-summary">
      <div class="week-row">
        <div class="week-stat">
          <div class="week-stat-num">${w.cur.toLocaleString()}</div>
          <div class="week-stat-label">今週 scrobbles</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-num">${w.diff != null ? `${w.sign}${w.diff.toLocaleString()}${w.pct != null ? ` <small>(${w.sign}${w.pct}%)</small>` : ""}` : "—"}</div>
          <div class="week-stat-label">先週比 ${w.arrow}</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-num week-top">${escapeHtml(w.topName)}</div>
          <div class="week-stat-label">今週のトップ（週次集計）</div>
        </div>
      </div>
    </div>
  `;
}

function renderDNA(dna, loading) {
  if (!dna) {
    return loading
      ? `<div class="listening-dna"><div class="skeleton skeleton-line" style="width:80%;"></div></div>`
      : `<div class="empty-state">データがありません</div>`;
  }
  if (dna.length === 0) {
    return `<div class="empty-state" style="padding:8px;">特徴が見つかりませんでした</div>`;
  }
  return `<div class="listening-dna">${dna.map((t) => `<span class="dna-tag">${escapeHtml(t)}</span>`).join("")}</div>`;
}

function renderRecentRow(t, rank) {
  return `
    <li class="stats-item">
      <div class="rank">${rank}</div>
      ${renderArt(t.image, t.name)}
      <div class="name">
        <div>${escapeHtml(t.name)}</div>
        <small style="color:var(--fg-muted);">${escapeHtml(t.artist)}</small>
      </div>
      <div class="count">${escapeHtml(t.when)}</div>
    </li>
  `;
}

/* ============ トップチャート ============ */

function renderTop(topData) {
  if (!refs?.tabContent) return;
  const periodData = topData?.byPeriod?.[currentPeriod];
  const loading = !topData;
  // 段階取得中(未取得期間あり)。未取得の期間に切替えたとき空ではなく skeleton を出す。
  const pending = !!topData?.topPending;

  const badges = topData?.artistBadges || null;

  refs.tabContent.innerHTML = `
    <div class="stats-card">
      <h3>期間</h3>
      <div class="stats-tabs" id="period-tabs">
        ${PERIODS.map((p) => `<button class="stats-tab ${p.value === currentPeriod ? "is-active" : ""}" data-period="${p.value}">${p.label}</button>`).join("")}
      </div>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-top:8px;">
        アーティストをタップすると豆知識と似たアーティスト、アルバムをタップすると聴破率が見られます
      </div>
    </div>
    <div class="stats-card"><h3>トップトラック</h3><ul class="stats-list" id="top-tracks">${renderTopList(periodData?.tracks, "track", loading, badges, pending)}</ul></div>
    <div class="stats-card"><h3>トップアーティスト</h3><ul class="stats-list" id="top-artists">${renderTopList(periodData?.artists, "artist", loading, badges, pending)}</ul></div>
    <div class="stats-card"><h3>トップアルバム</h3><ul class="stats-list" id="top-albums">${renderTopList(periodData?.albums, "album", loading, badges, pending)}</ul></div>
  `;

  // 期間タブクリック（再 fetch なし、保持データから再描画）
  refs.tabContent.querySelectorAll("#period-tabs .stats-tab").forEach((tb) => {
    tb.addEventListener("click", () => {
      currentPeriod = tb.dataset.period;
      renderTop(statsService.getState().sections.top);
    });
  });

  // アーティスト行クリック → 豆知識 + 似たアーティストモーダル
  refs.tabContent.querySelectorAll(".stats-item[data-artist]").forEach((el) => {
    el.addEventListener("click", () => showSimilarArtists(el.dataset.artist));
  });

  // アルバム行クリック → アルバム聴破率モーダル
  refs.tabContent.querySelectorAll(".stats-item[data-album]").forEach((el) => {
    el.addEventListener("click", () => showAlbumDetail(el.dataset.albumArtist, el.dataset.album));
  });
}

function renderTopList(items, kind, loading, badges, pending) {
  if (!items) return (loading || pending) ? skeletonRows(8) : emptyRow();
  if (items.length === 0) return emptyRow();
  return items.map((it, i) => renderTopRow(it, i + 1, kind, badges)).join("");
}

function renderTopRow(t, rank, kind, badges) {
  let dataAttr = "";
  let cls = "stats-item";
  if (kind === "artist") {
    dataAttr = ` data-artist="${escapeAttr(t.name)}"`;
    cls = "stats-item is-clickable";
  } else if (kind === "album") {
    dataAttr = ` data-album="${escapeAttr(t.name)}" data-album-artist="${escapeAttr(t.artist)}"`;
    cls = "stats-item is-clickable";
  }
  const sub = t.artist ? `<small style="color:var(--fg-muted);">${escapeHtml(t.artist)}</small>` : "";
  // 全期間トップ10アーティストにツアー中バッジ (artist.getInfo の ontour)
  const badge = (kind === "artist" && badges && badges[String(t.name || "").toLowerCase().trim()]?.ontour)
    ? `<span class="badge-ontour" title="Last.fm でツアー中と表示されています">🎤 ツアー中</span>`
    : "";
  return `
    <li class="${cls}"${dataAttr}>
      <div class="rank">${rank}</div>
      ${renderArt(t.image, t.name)}
      <div class="name">
        <div>${escapeHtml(t.name)} ${badge}</div>
        ${sub}
      </div>
      <div class="count">${t.playcount.toLocaleString()}</div>
    </li>
  `;
}

/**
 * アルバム聴破率モーダル (album.getInfo のトラックリスト × 自分の再生履歴)
 *   - 突合は「全期間トップ1000曲」との照合のため概算 (注記を表示)
 *   - 曲名は括弧書き(Remaster 等)を除去した小文字で比較し表記ゆれを軽減
 */
async function showAlbumDetail(artistName, albumName) {
  const root = document.getElementById("modal-root");
  if (!root || !artistName || !albumName) return;
  const user = getPublic().username || "";
  root.hidden = false;
  root.innerHTML = `
    <div class="modal">
      <h2>💿 ${escapeHtml(albumName)}</h2>
      <div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px;">${escapeHtml(artistName)}</div>
      <div id="album-detail-body"><ul class="stats-list">${skeletonRows(6)}</ul></div>
      <div class="modal-actions">
        <button class="btn" id="album-close">閉じる</button>
      </div>
    </div>
  `;
  // backdrop 閉鎖は named handler + close() での解除 (once:true は内部クリックで
  // 誤消費されるため使わない)。書き込み先ノードは同期捕捉し isConnected で検査する。
  const onBackdrop = (e) => { if (e.target === root) close(); };
  const close = () => {
    root.hidden = true;
    root.innerHTML = "";
    root.removeEventListener("click", onBackdrop);
    if (_statsModalBackdrop === onBackdrop) _statsModalBackdrop = null;
  };
  root.querySelector("#album-close").addEventListener("click", close);
  // close を経ずに別モーダルへ上書きされた場合に備え、前回の backdrop ハンドラを解除(UI-4)
  if (_statsModalBackdrop) { try { root.removeEventListener("click", _statsModalBackdrop); } catch {} }
  _statsModalBackdrop = onBackdrop;
  root.addEventListener("click", onBackdrop);
  const bodyEl = root.querySelector("#album-detail-body");

  try {
    const [info, myTracks] = await Promise.all([
      // trackinfo/artistinfo と同じ規約でキーに user を含める
      // (レスポンスに userplaycount が含まれるユーザ依存データのため)
      cached(ckey("albuminfo", artistName, albumName, user), () => getAlbumInfo(artistName, albumName, user)).catch(() => null),
      // 聴破判定用: 全期間トップ1000曲 (1日キャッシュ。アルバムを開いた時のみ取得)
      cached(`top-tracks:${user}:overall:1000`, () => getTopTracks(user, "overall", 1000)).catch(() => []),
    ]);
    const body = bodyEl;
    if (!body || !body.isConnected) return; // 閉じられた/別モーダルに置換された
    if (!info) {
      body.innerHTML = `<div class="empty-state">アルバム情報が見つかりませんでした</div>`;
      return;
    }
    const rawTracks = info.tracks?.track || [];
    const albumTracks = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
    const userAlbumPlays = info.userplaycount != null ? parseInt(info.userplaycount, 10) : null;

    // 自分の聴取済み曲セット (アーティスト+曲名の正規化キー)
    const heardSet = new Set((myTracks || []).map((t) => {
      const a = (t.artist && (t.artist.name || t.artist["#text"])) || "";
      return `${normKey(a)}::${normKey(t.name)}`;
    }));
    const akey = normKey(artistName);

    if (albumTracks.length === 0 || !albumTracks[0]?.name) {
      // トラックリストが無いアルバム → userplaycount のみ表示にフォールバック
      body.innerHTML = `
        <div class="empty-state" style="padding:8px;">トラックリスト情報がありません</div>
        ${userAlbumPlays != null ? `<div style="font-size:12px;color:var(--fg-muted);text-align:center;">あなたのこのアルバムの再生数: ${userAlbumPlays.toLocaleString()} 回</div>` : ""}
      `;
      return;
    }

    const rows = albumTracks.map((t, i) => {
      // 完聴判定: アルバム名義(akey)に加え、album.getInfo の各曲が持つ実アーティストでも突合する。
      //   コンピレーション/サウンドトラック/クラシック等、収録曲のアーティストがアルバム名義と
      //   異なる場合、再生履歴はトラック実アーティストで記録されるため akey 固定だと過小判定(多くは
      //   0%)になる。実アーティストキーを併用して緩和する(artist+曲名の完全一致のため偽陽性なし)。
      const tArtist = (t.artist && (t.artist.name || t.artist["#text"])) || "";
      const tkey = tArtist ? normKey(tArtist) : "";
      const heard = heardSet.has(`${akey}::${normKey(t.name)}`) ||
        (!!tkey && tkey !== akey && heardSet.has(`${tkey}::${normKey(t.name)}`));
      const dur = parseInt(t.duration || "0", 10);
      const durStr = dur > 0 ? `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}` : "";
      return { i: i + 1, name: t.name || "", heard, durStr };
    });
    const heardCount = rows.filter((r) => r.heard).length;
    const pct = rows.length > 0 ? Math.round((heardCount / rows.length) * 100) : 0;

    body.innerHTML = `
      <div class="album-completion">
        <div class="mini-bar"><div class="mini-bar-fill" style="width:${pct}%;"></div></div>
        <div class="album-completion-label">${rows.length} 曲中 ${heardCount} 曲を聴取 (聴破率 ${pct}%)</div>
        ${userAlbumPlays != null ? `<div class="album-completion-sub">アルバム累計再生: ${userAlbumPlays.toLocaleString()} 回</div>` : ""}
      </div>
      <ul class="stats-list">
        ${rows.map((r) => `
          <li class="stats-item">
            <div class="rank">${r.i}</div>
            <div class="name"><div class="${r.heard ? "" : "album-track-unheard"}">${escapeHtml(r.name)}</div></div>
            <div class="count">${r.heard ? `<span style="color:var(--success);">✓</span>` : "—"} <small style="color:var(--fg-dim);">${r.durStr}</small></div>
          </li>
        `).join("")}
      </ul>
      <div style="font-size:10px;color:var(--fg-dim);margin-top:8px;">
        ※ 聴取判定は再生履歴の上位1000曲との突合のため概算です
      </div>
    `;
  } catch (e) {
    if (bodyEl && bodyEl.isConnected) {
      bodyEl.innerHTML = `<div class="empty-state">取得失敗: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }
}

/**
 * 曲名/アーティスト名の突合用正規化:
 *   小文字化 + 括弧書き((Remastered) / [Live] 等)除去 + 空白圧縮
 */
function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 外部リンク href 用の多層防御。Last.fm 由来の url を href に出す前に http(s) スキームのみ
 * 許可し、javascript:/data: 等の危険スキームは空文字に倒す(該当時は呼出側でリンク自体を出さない)。
 * 通常 Last.fm は正規の https URL のみ返すため実害は無いが、属性エスケープ(escapeAttr)では
 * スキームを無害化できないため、念のための標準的なガードを置く。
 */
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u == null ? "" : u)) ? u : "";
}

async function showSimilarArtists(artistName) {
  const root = document.getElementById("modal-root");
  if (!root) return;
  const user = getPublic().username || "";
  root.hidden = false;
  root.innerHTML = `
    <div class="modal">
      <h2>🎵 ${escapeHtml(artistName)}</h2>
      <div id="artist-bio-body"><div class="skeleton skeleton-line" style="width:90%;height:12px;margin:6px 0;"></div></div>
      <h3 style="font-size:13px;margin:12px 0 6px;color:var(--accent);">似たアーティスト</h3>
      <ul class="stats-list" id="similar-list">${skeletonRows(8)}</ul>
      <div class="modal-actions">
        <button class="btn" id="similar-close">閉じる</button>
      </div>
    </div>
  `;
  // バックドロップクリックで閉じる。
  // ★ { once: true } は「最初のクリックがモーダル内部でも」リスナーを消費して
  //   しまい、以降 backdrop で閉じられなくなる。named handler を登録し、
  //   close() で明示的に解除する (リスナー蓄積も防げる)。
  const onBackdrop = (e) => { if (e.target === root) close(); };
  const close = () => {
    root.hidden = true;
    root.innerHTML = "";
    root.removeEventListener("click", onBackdrop);
    if (_statsModalBackdrop === onBackdrop) _statsModalBackdrop = null;
  };
  root.querySelector("#similar-close").addEventListener("click", close);
  // close を経ずに別モーダルへ上書きされた場合に備え、前回の backdrop ハンドラを解除(UI-4)
  if (_statsModalBackdrop) { try { root.removeEventListener("click", _statsModalBackdrop); } catch {} }
  _statsModalBackdrop = onBackdrop;
  root.addEventListener("click", onBackdrop);

  // ★ 非同期描画の書き込み先は「いま開いたモーダルの要素ノード」を同期的に捕捉する。
  //   await 後に id で再取得すると、閉じた後に別のモーダルが開かれた場合に
  //   「同じ id の新モーダルの要素」へ旧データを書き込んでしまう。
  //   ノード参照 + isConnected 判定なら closed/replaced の両方を検知できる。
  const bioEl = root.querySelector("#artist-bio-body");
  const listEl = root.querySelector("#similar-list");

  // 豆知識 (artist.getInfo): bio(lang=ja)・世界リスナー数・自分の再生数・ツアー中
  cached(ckey("artistinfo", artistName, user), () => getArtistInfo(artistName, user))
    .then((info) => {
      if (!bioEl || !bioEl.isConnected) return; // モーダルが閉じられた/別モーダルに置換された
      if (!info) { bioEl.innerHTML = ""; return; }
      const listeners = parseInt(info.stats?.listeners || "0", 10);
      const plays = parseInt(info.stats?.playcount || "0", 10);
      const userplays = info.stats?.userplaycount != null ? parseInt(info.stats.userplaycount, 10) : null;
      const ontour = info.ontour === "1" || info.ontour === 1;
      // bio はリンク等の HTML を含むためタグを除去してテキストのみ表示 (XSS 対策)
      const bioText = String(info.bio?.summary || "").replace(/<[^>]*>/g, "").trim();
      const shortBio = bioText.length > 200 ? bioText.slice(0, 200) + "…" : bioText;
      const stats = [];
      if (listeners > 0) stats.push(`🌍 リスナー ${listeners.toLocaleString()} 人`);
      if (plays > 0) stats.push(`▶ 総再生 ${plays.toLocaleString()}`);
      if (userplays != null) stats.push(`あなたは ${userplays.toLocaleString()} 回`);
      bioEl.innerHTML = `
        ${ontour ? `<div style="margin-bottom:6px;"><span class="badge-ontour">🎤 ツアー中</span></div>` : ""}
        ${stats.length ? `<div style="font-size:11px;color:var(--fg-muted);margin-bottom:6px;">${stats.map(escapeHtml).join(" ・ ")}</div>` : ""}
        ${shortBio ? `<div style="font-size:12px;line-height:1.6;color:var(--fg);">${escapeHtml(shortBio)}</div>` : ""}
        ${safeUrl(info.url) ? `<div style="margin-top:4px;"><a href="${escapeAttr(safeUrl(info.url))}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:11px;">Last.fm で見る</a></div>` : ""}
      `;
    })
    .catch(() => {
      if (bioEl && bioEl.isConnected) bioEl.innerHTML = "";
    });

  try {
    const list = await cached(ckey("similar", artistName, 10), () => getSimilarArtists(artistName, 10)).catch(() => []);
    const ul = listEl;
    if (!ul || !ul.isConnected) return; // 閉じられた/別モーダルに置換された
    if (list.length === 0) {
      ul.innerHTML = `<li class="empty-state">類似アーティストが見つかりませんでした</li>`;
      return;
    }
    ul.innerHTML = list.map((a, i) => {
      // match は Last.fm で 0〜1 系と 0〜100 系が混在するため正規化+上限クランプする
      //   (stats-service の類似トラック matchPct と同じ扱い。10000% 等の桁外れ表示を防ぐ)。
      const mv = parseFloat(a.match);
      const match = (isFinite(mv) && mv > 0) ? Math.min(100, Math.round(mv <= 1 ? mv * 100 : mv)) + "%" : "";
      // 似たアーティスト API も Last.fm が 2020 年に画像 API を廃止したため、
      // 多くの場合プレースホルダ URL（または空）が返ってくる。pickImage と同じ
      // ロジックでフィルタしてから renderArt にかける。
      const rawImg = (a.image && (Array.isArray(a.image) ? a.image[a.image.length - 1]?.["#text"] : "")) || "";
      const img = rawImg && !rawImg.includes("2a96cbd8b46e442fc41c2b86b821562f") ? rawImg : "";
      return `
        <li class="stats-item">
          <div class="rank">${i + 1}</div>
          ${renderArt(img, a.name)}
          <div class="name">
            <div>${escapeHtml(a.name || "")}</div>
            ${safeUrl(a.url) ? `<small><a href="${escapeAttr(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">Last.fm で見る</a></small>` : ""}
          </div>
          <div class="count">${match}</div>
        </li>
      `;
    }).join("");
  } catch (e) {
    if (listEl && listEl.isConnected) {
      listEl.innerHTML = `<li class="empty-state">取得失敗: ${escapeHtml(e.message || String(e))}</li>`;
    }
  }
}

/* ============ 比較 ============ */

function renderCompare(compareData) {
  if (!refs?.tabContent) return;
  // 比較は範囲(週/月/年)ごとに逐次到着する。判定は「比較自身の取得進捗」で行う
  // (ラン全体の status ではなく)。現在の範囲が byRange にキー未登録の間＝未取得は
  // スケルトン、処理済み(成功=データ / 失敗=null)になったら確定表示する。これで
  // 「枠だけ・値なし」も、範囲切替時の誤「データなし」も、新しい発見が他セクション
  // 完了まで過剰にスケルトン表示される問題も避ける。
  const byR = compareData?.byRange || {};
  const rangeData = byR[currentCompareRange];
  const loading = !compareData || !(currentCompareRange in byR);
  // 新しい発見(range 非依存)は fetchCompare の最後に埋まる。取得中(discoveriesReady===false)
  // の間だけスケルトン表示し、確定(true)や旧バージョン保存データ(フィールド無し=undefined)は
  // そのまま表示する(復元データで永久スケルトンにならないよう === false で判定)。
  const discoveryLoading = !compareData || compareData.discoveriesReady === false;

  // Last.fm の Weekly Chart API は画像を返さないため、Top タブで取得済みの
  // データから画像をルックアップして補完する。
  const topData = statsService.getState().sections?.top;
  const lookup = getImageLookup(topData);

  refs.tabContent.innerHTML = `
    <div class="stats-card">
      <h3>期間</h3>
      <div class="stats-tabs" id="compare-range-tabs">
        ${COMPARE_RANGES.map((r) => `<button class="stats-tab ${r.value === currentCompareRange ? "is-active" : ""}" data-range="${r.value}">${r.label}</button>`).join("")}
      </div>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-top:8px;">
        Last.fm の週次チャートを使って前後期間の順位変動を比較します（更新は1日 1 回・更新ボタンで強制再取得可）。
      </div>
    </div>

    <div class="stats-card">
      <h3>合計 scrobble の比較</h3>
      ${renderCompareTotals(rangeData?.totals, loading)}
      ${currentCompareRange === "week" ? `
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-top:8px;">
        ※「今週 / 先週」の scrobble 数は「現在から遡って 7 日間」で集計しています（ダッシュボードのリスニング数と同じ定義）。下の順位リストは Last.fm の固定週次チャート単位で集計するため、直近7日ちょうどより広い範囲（最大で約2週間分）を含むことがあります。
      </div>` : `
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-top:8px;">
        ※ 合計・順位は Last.fm の固定週次チャート単位で集計するため、期間境界の週を丸ごと含み、表示の再生数が実際の${currentCompareRange === "month" ? "1ヶ月" : "12ヶ月"}（直近の${currentCompareRange === "month" ? "1ヶ月" : "12ヶ月"}）より多めになることがあります。
      </div>`}
    </div>

    <div class="stats-card">
      <h3>アーティスト</h3>
      <div class="compare-content">${renderCompareList(rangeData?.artists, "artist", loading, lookup)}</div>
    </div>
    <div class="stats-card">
      <h3>アルバム</h3>
      <div class="compare-content">${renderCompareList(rangeData?.albums, "album", loading, lookup)}</div>
    </div>
    <div class="stats-card">
      <h3>トラック</h3>
      <div class="compare-content">${renderCompareList(rangeData?.tracks, "track", loading, lookup)}</div>
    </div>

    <div class="stats-card">
      <h3>🆕 新しい発見 (直近1週間で初登場)</h3>
      <div>
        <div class="compare-discoveries-section">
          <h4>アーティスト</h4>
          <ul class="stats-list">${renderDiscoveryList(compareData?.discoveries?.artists, "artist", discoveryLoading, lookup)}</ul>
        </div>
        <div class="compare-discoveries-section">
          <h4>アルバム</h4>
          <ul class="stats-list">${renderDiscoveryList(compareData?.discoveries?.albums, "album", discoveryLoading, lookup)}</ul>
        </div>
        <div class="compare-discoveries-section">
          <h4>トラック</h4>
          <ul class="stats-list">${renderDiscoveryList(compareData?.discoveries?.tracks, "track", discoveryLoading, lookup)}</ul>
        </div>
      </div>
    </div>
  `;

  // 範囲タブ
  refs.tabContent.querySelectorAll("#compare-range-tabs .stats-tab").forEach((tb) => {
    tb.addEventListener("click", () => {
      currentCompareRange = tb.dataset.range;
      renderCompare(statsService.getState().sections.compare);
    });
  });
}

function renderCompareTotals(t, loading) {
  if (!t) {
    return loading
      ? `<div class="week-summary"><div class="skeleton skeleton-line" style="width:60%;"></div></div>`
      : `<div class="empty-state">データがありません</div>`;
  }
  return `
    <div class="week-summary">
      <div class="week-row">
        <div class="week-stat">
          <div class="week-stat-num">${t.cur.toLocaleString()}</div>
          <div class="week-stat-label">${escapeHtml(t.curLabel)}</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-num">${t.prev != null ? t.prev.toLocaleString() : "—"}</div>
          <div class="week-stat-label">${escapeHtml(t.prevLabel)}</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-num">${t.diff != null ? `${t.sign}${t.diff.toLocaleString()}${t.pct != null ? ` <small>(${t.sign}${t.pct}%)</small>` : ""}` : "—"}</div>
          <div class="week-stat-label">差分 ${t.arrow}</div>
        </div>
      </div>
    </div>
  `;
}

function renderCompareList(data, kind, loading, lookup) {
  if (!data) return loading ? `<ul class="stats-list">${skeletonRows(5)}</ul>` : `<div class="empty-state">データがありません</div>`;
  if (data.items.length === 0) return `<div class="empty-state">データがありません</div>`;
  const rows = data.items.map((item) => {
    const sub = (kind === "artist") ? "" : `<small style="color:var(--fg-muted);">${escapeHtml(item.artist)}</small>`;
    // Weekly Chart API は画像を返さないため、トップタブのキャッシュからルックアップ補完
    const img = item.image || lookupImage(item, kind, lookup);
    return `
      <li class="stats-item">
        <div class="rank">${item.rank}</div>
        ${renderArt(img, item.name)}
        <div class="name">
          <div>${escapeHtml(item.name)}</div>
          ${sub}
        </div>
        <div class="compare-badge ${item.badgeClass}" title="${item.prevRank ? "前期間: " + item.prevRank + "位" : "新規"}">${item.badge}</div>
        <div class="count">${item.count.toLocaleString()}</div>
      </li>
    `;
  }).join("");
  const fallenHtml = data.fallen && data.fallen.length > 0
    ? `<div class="compare-fallen-title">📉 前期間トップから落下したもの</div>
       <ul class="stats-list">${data.fallen.map((d) => {
         const img = d.image || lookupImage(d, kind, lookup);
         return `
         <li class="stats-item">
           <div class="rank">${d.rank}</div>
           ${renderArt(img, d.name)}
           <div class="name">
             <div>${escapeHtml(d.name)}</div>
             ${kind === "artist" ? "" : `<small style="color:var(--fg-muted);">${escapeHtml(d.artist)}</small>`}
           </div>
           <div class="compare-badge is-down">↓</div>
           <div class="count">${d.prevCount.toLocaleString()}</div>
         </li>
       `;
       }).join("")}</ul>`
    : "";
  return `<ul class="stats-list">${rows}</ul>${fallenHtml}`;
}

function renderDiscoveryList(list, kind, loading, lookup) {
  // 取得中(discoveriesReady:false)は必ずスケルトンを出す。discoveries は空配列[]で初期化されるため、
  //   loading を最優先しないと下の list.length===0 が先に成立し「初登場はありません」を誤表示する
  //   (取得完了後/復元データは loading=false で従来どおり空表示。renderCompareList の loading 優先と統一)。
  if (loading) return skeletonRows(5);
  if (!list || list.length === 0) return emptyRow("初登場はありません");
  return list.map((item, i) => {
    // Weekly Chart API は画像を返さないため、トップタブのキャッシュからルックアップ補完
    const img = item.image || lookupImage(item, kind, lookup);
    return `
    <li class="stats-item">
      <div class="rank">${i + 1}</div>
      ${renderArt(img, item.name)}
      <div class="name">
        <div>${escapeHtml(item.name)}</div>
        ${kind === "artist" ? "" : `<small style="color:var(--fg-muted);">${escapeHtml(item.artist)}</small>`}
      </div>
      <div class="count">${item.count.toLocaleString()}</div>
    </li>
  `;
  }).join("");
}

/* ============ ジャンル ============ */

function renderGenre(genreData) {
  if (!refs?.tabContent) return;
  // 正規の「再生履歴ゼロ」(新規ユーザ等)。取得失敗(null=取得できませんでした)とは区別する
  if (genreData?.noData) {
    refs.tabContent.innerHTML = `
      <div class="stats-card">
        <h3>🧬 ジャンル分析</h3>
        <div class="empty-state">再生履歴がまだありません。曲を聴いて scrobble が貯まると、ジャンル DNA・踏破率・年代分布が表示されます</div>
      </div>
    `;
    return;
  }
  const loading = !genreData;
  const dna = genreData?.dna || [];
  const conquest = genreData?.conquest || [];
  const decades = genreData?.decades || [];

  refs.tabContent.innerHTML = `
    <div class="stats-card">
      <h3>🧬 ジャンル DNA</h3>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">
        全期間トップ${genreData?.tagSource || 15}アーティストの Last.fm タグを再生数で重み付け集計した、あなたのジャンル分布です
      </div>
      ${dna.length
        ? `<div class="chart-wrap" style="height:220px;"><canvas id="chart-genre"></canvas></div>
           <div class="tag-cloud" id="genre-cloud">${renderTagCloud(dna)}</div>`
        : (loading ? `<div class="skeleton skeleton-line" style="width:80%;"></div>` : `<div class="empty-state">タグデータが取得できませんでした</div>`)}
    </div>

    <div class="stats-card">
      <h3>🏔 ジャンル踏破率</h3>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">
        主要ジャンルの代表50組のうち、聴いたことのあるアーティストの割合（再生履歴上位1000組との突合による概算）
      </div>
      ${conquest.length
        ? conquest.map(renderConquestRow).join("")
        : ((loading || genreData?.conquestPending) ? `<div class="skeleton skeleton-line" style="width:80%;"></div>` : `<div class="empty-state">データがありません</div>`)}
    </div>

    <div class="stats-card">
      <h3>📅 聴いている音楽の年代分布</h3>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">
        全期間トップアルバムのリリース年から集計${genreData?.decadesPending ? "（集計中…）" : `（年代判明 ${genreData?.decadeKnown || 0}/${genreData?.decadeTotal || 0} 枚）`}
      </div>
      ${decades.length
        ? `<div class="chart-wrap" style="height:200px;"><canvas id="chart-decade"></canvas></div>
           ${genreData?.avgYear ? `<div style="text-align:center;font-size:13px;margin-top:8px;">あなたの耳は平均 <strong style="color:var(--accent);">${genreData.avgYear}年</strong> 生まれ</div>` : ""}`
        : ((loading || genreData?.decadesPending) ? `<div class="skeleton skeleton-line" style="width:80%;"></div>` : `<div class="empty-state">リリース年を判定できるアルバムがありませんでした。<br/>（Last.fm にリリース日や発売年の記載があるアルバムのみ集計対象です。日本語タイトルやマイナーな作品は登録が無いことが多く、その場合は表示されません）</div>`)}
    </div>
  `;

  // 条件付きチャートはデータが「あり→なし」に変わる再描画で生成 if がスキップされ
  // destroy 漏れ(デタッチ canvas を掴んだ Chart が残留)するため、生成判定の前に
  // 無条件で破棄しておく(UI-2)。
  try { chartGenre && chartGenre.destroy(); } catch {} chartGenre = null;
  try { chartDecade && chartDecade.destroy(); } catch {} chartDecade = null;
  if (window.Chart && dna.length) {
    const canvas = document.getElementById("chart-genre");
    if (canvas) {
      const top8 = dna.slice(0, 8);
      // ドーナツの扇形角度を表示%(全12タグ基準の pct)と一致させる。Chart.js は渡した値の総和で
      //   角度を正規化するため、top8 のみを渡すと9件目以降の % が欠け、各扇形が過大に描かれて
      //   ツールチップの%値と幾何が乖離する。残り(その他)を1スライス補い合計を約100%にする。
      const labels = top8.map((d) => d.tag);
      const data = top8.map((d) => d.pct);
      const restPct = Math.round((100 - data.reduce((s, v) => s + v, 0)) * 10) / 10;
      if (dna.length > top8.length && restPct > 0) {
        labels.push("その他");
        data.push(restPct);
      }
      const colors = rainbowColors(data.length);
      try { chartGenre && chartGenre.destroy(); } catch {}
      chartGenre = new Chart(canvas, {
        type: "doughnut",
        data: {
          labels,
          datasets: [{ data, backgroundColor: colors }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: getCssVar("--fg-muted"), font: { size: 10 } } } } },
      });
    }
  }
  if (window.Chart && decades.length) {
    const canvas = document.getElementById("chart-decade");
    if (canvas) {
      try { chartDecade && chartDecade.destroy(); } catch {}
      // アルバム数は整数なので Y 軸を整数目盛りに強制する(既定だと少数枚で 0.5 刻みの目盛りが出る)。
      //   chartOpts() は他チャート共有のため変更せず、ここで y.ticks に precision:0 を浅くマージする。
      const baseOpts = chartOpts();
      const decadeOpts = {
        ...baseOpts,
        scales: {
          ...baseOpts.scales,
          y: { ...baseOpts.scales.y, ticks: { ...baseOpts.scales.y.ticks, precision: 0 } },
        },
      };
      chartDecade = new Chart(canvas, {
        type: "bar",
        data: {
          labels: decades.map((d) => `${d.decade}s`),
          datasets: [{ label: "アルバム数", data: decades.map((d) => d.count), backgroundColor: "rgba(255,184,107,0.6)", borderColor: "#ffb86b", borderWidth: 1 }],
        },
        options: decadeOpts,
      });
    }
  }
}

function renderTagCloud(dna) {
  // pct に応じてフォントサイズを 11〜22px で段階付け
  const maxPct = Math.max(...dna.map((d) => d.pct), 1);
  return dna.map((d) => {
    const size = Math.round(11 + (d.pct / maxPct) * 11);
    return `<span class="tag-cloud-item" style="font-size:${size}px;" title="${d.pct}%">${escapeHtml(d.tag)} <small>${d.pct}%</small></span>`;
  }).join("");
}

function renderConquestRow(c) {
  const unheard = (c.unheard || []).map((a) =>
    safeUrl(a.url)
      ? `<a class="conquest-chip" href="${escapeAttr(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.name)}</a>`
      : `<span class="conquest-chip">${escapeHtml(a.name)}</span>`
  ).join("");
  return `
    <div class="conquest-row">
      <div class="conquest-head">
        <span class="conquest-tag">${escapeHtml(c.tag)}</span>
        <span class="conquest-num">${c.heard}/${c.total} 組 (${c.pct}%)</span>
      </div>
      <div class="mini-bar"><div class="mini-bar-fill" style="width:${c.pct}%;"></div></div>
      ${unheard ? `<div class="conquest-unheard"><span style="color:var(--fg-muted);font-size:11px;">未聴の定番:</span> ${unheard}</div>` : ""}
    </div>
  `;
}

/* ============ 世界と自分 ============ */

function renderWorld(worldData) {
  if (!refs?.tabContent) return;
  // 正規の「再生履歴ゼロ」(新規ユーザ等)。取得失敗(null)とは区別して案内する
  if (worldData?.noData) {
    refs.tabContent.innerHTML = `
      <div class="stats-card">
        <h3>🌍 世界と自分</h3>
        <div class="empty-state">再生履歴がまだありません。曲を聴いて scrobble が貯まると、世界チャートとの照合が表示されます</div>
      </div>
    `;
    return;
  }
  const loading = !worldData;
  const m = worldData?.mainstream || null;
  const geo = worldData?.geo || [];
  const trackStats = worldData?.trackStats || [];

  refs.tabContent.innerHTML = `
    <div class="stats-card">
      <h3>🌍 メインストリーム度</h3>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">
        世界チャートのトップ${m?.chartSize || 100}アーティストと、あなたの全期間聴取履歴の一致度です
      </div>
      ${m
        ? `
          <div class="mainstream-score">${m.score}<small>%</small></div>
          <div class="mini-bar" style="margin:6px 0;"><div class="mini-bar-fill" style="width:${m.score}%;"></div></div>
          <div class="mainstream-diag">${escapeHtml(m.diagnosis)}</div>
          ${m.overlap.length ? `
            <h4 style="font-size:12px;margin:12px 0 6px;color:var(--fg-muted);">世界チャートの中であなたが聴いているアーティスト</h4>
            <ul class="stats-list">
              ${m.overlap.map((a) => `
                <li class="stats-item">
                  <div class="rank">${a.rank}</div>
                  ${renderArt("", a.name)}
                  <div class="name"><div>${escapeHtml(a.name)}</div></div>
                  <div class="count"><small style="color:var(--fg-muted);">世界${a.rank}位</small></div>
                </li>
              `).join("")}
            </ul>` : ""}
        `
        : (loading ? `<div class="skeleton skeleton-line" style="width:80%;"></div>` : `<div class="empty-state">世界チャートが取得できませんでした</div>`)}
    </div>

    <div class="stats-card">
      <h3>🗺 国別チャート照合</h3>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">
        各国で聴かれているトップ50アーティストとの一致度。あなたの耳はどの国寄り？
      </div>
      ${geo.length
        ? `
          ${worldData.bestGeo ? `<div style="font-size:13px;margin-bottom:10px;">あなたの耳は <strong style="color:var(--accent);">${escapeHtml(worldData.bestGeo.label)}</strong> のチャートに最も近い (${worldData.bestGeo.pct}%)</div>` : ""}
          ${geo.map((g) => `
            <div class="conquest-row">
              <div class="conquest-head">
                <span class="conquest-tag">${escapeHtml(g.label)}</span>
                <span class="conquest-num">${g.heard}/${g.total} 組 (${g.pct}%)</span>
              </div>
              <div class="mini-bar"><div class="mini-bar-fill" style="width:${g.pct}%;"></div></div>
            </div>
          `).join("")}
          <div style="font-size:10px;color:var(--fg-dim);margin-top:6px;">※「その国で聴かれている」チャートであり、その国出身のアーティストとは限りません</div>
        `
        : ((loading || worldData?.geoPending) ? `<div class="skeleton skeleton-line" style="width:80%;"></div>` : `<div class="empty-state">国別チャートが取得できませんでした</div>`)}
    </div>

    <div class="stats-card">
      <h3>🏅 トップ曲の世界での立ち位置</h3>
      <div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">
        あなたの全期間トップ10曲が世界でどれだけ聴かれているか。占有率 = 世界の総再生のうちあなたの再生が占める割合
      </div>
      ${trackStats.length
        ? `<ul class="stats-list">${trackStats.map(renderTrackWorldRow).join("")}</ul>`
        : ((loading || worldData?.tracksPending) ? skeletonRows(6) : `<div class="empty-state">トラック情報が取得できませんでした</div>`)}
    </div>
  `;
}

function renderTrackWorldRow(t, i) {
  const shareStr = t.sharePct == null ? ""
    : t.sharePct < 0.01 ? "占有率 <0.01%"
    : `占有率 ${t.sharePct}%`;
  const rare = t.listeners > 0 && t.listeners < 5000;
  return `
    <li class="stats-item">
      <div class="rank">${t.rank ?? (i + 1)}</div>
      ${renderArt("", t.name)}
      <div class="name">
        <div>${escapeHtml(t.name)} ${rare ? `<span class="badge-rare" title="世界のリスナーが5,000人未満のレア曲">💎レア</span>` : ""}</div>
        <small style="color:var(--fg-muted);">${escapeHtml(t.artist)} ・ 🌍 ${t.listeners.toLocaleString()}人 / ${t.playcount.toLocaleString()}回</small>
      </div>
      <div class="count">
        ${t.userplaycount != null ? `${t.userplaycount.toLocaleString()}回` : ""}
        ${shareStr ? `<small style="display:block;color:var(--accent);">${escapeHtml(shareStr)}</small>` : ""}
      </div>
    </li>
  `;
}

/* ============ 振り返り ============ */

function renderRewind(rewindData) {
  if (!refs?.tabContent) return;
  const loading = !rewindData;
  // origin(最初のアクティブ年)とマイルストン(累積到達年)は全年が揃わないと正しく計算できない
  //   (年は並列解決で到着順が不定。partial 中は未到着年を飛ばした不完全集計で誤った年/到達順になる)。
  //   partial 中は skeleton にして、確定後(partial:false)に正しい値を出す。年別グラフ・年カードは
  //   到着年ぶんずつ正しいので従来どおり逐次表示する。
  const derivedLoading = loading || !!rewindData?.partial;
  refs.tabContent.innerHTML = `
    <div class="warn-box" id="rewind-progress">
      ${loading
        ? "年別データを集計中…（バックグラウンド処理、画面操作可能）"
        : (rewindData.error
            ? (rewindData.years.length === 0
                // 1年も取得できなかった全失敗(空確定)。「N年分のみ表示」だと空ページなのに
                //   部分表示しているかのような自己矛盾文言になるため、純粋な失敗文言にする。
                //   (公開済み全年 total=0 で buildRewindView が years=[] を返す部分失敗経路も含む)
                ? "振り返りデータの取得に失敗しました（時間をおいて自動再取得されます）"
                : `振り返りデータの取得に一部失敗しました（${rewindData.years.length} 年分のみ表示・時間をおいて自動再取得されます）`)
            : (rewindData.partial
                ? `集計中… ${rewindData.years.length} 年分取得済み（残りはバックグラウンドで取得中）`
                : `集計完了 (${rewindData.years.length} 年分)`))}
    </div>
    <div class="stats-card">
      <h3>年別 scrobble 推移</h3>
      <div class="chart-wrap"><canvas id="chart-rewind-year"></canvas></div>
    </div>
    <div class="stats-card">
      <h3>あなたの始まり</h3>
      <div id="rewind-origin">
        ${renderRewindOrigin(rewindData?.origin, derivedLoading)}
      </div>
    </div>
    ${renderTimeTravelCard(rewindData?.timeTravel)}
    <div class="stats-card">
      <h3>マイルストン</h3>
      <ul class="stats-list" id="rewind-milestones">
        ${renderMilestones(rewindData?.milestones, derivedLoading)}
      </ul>
    </div>
    <div id="rewind-years">
      ${renderYearCards(rewindData?.years)}
    </div>
  `;

  // 年別グラフ
  if (rewindData?.years && window.Chart) {
    const canvas = document.getElementById("chart-rewind-year");
    if (canvas) {
      const data = {
        labels: rewindData.years.map((y) => String(y.year)),
        datasets: [{
          label: "scrobbles",
          data: rewindData.years.map((y) => y.total),
          backgroundColor: "rgba(255,94,126,0.6)",
          borderColor: "#ff5e7e",
          borderWidth: 2,
        }],
      };
      try { chartRewindYear && chartRewindYear.destroy(); } catch {}
      chartRewindYear = new Chart(canvas, { type: "bar", data, options: chartOpts() });
    }
  }

  // タイムトラベルの年ピッカー (選択時にその年の週チャートをオンデマンド取得)
  const ttSelect = refs.tabContent.querySelector("#tt-years");
  if (ttSelect) {
    // ★ 書き込み先ノードは同期捕捉する。await 後に querySelector で再取得すると
    //   「再描画後の同 id 別世代 DOM」へ古い結果を書き込んでしまう。
    //   さらに連続変更(後勝ちレース)対策として、await 後にセレクトの現在値と
    //   自分のリクエスト年が一致するかも検査する。
    const ttBody = refs.tabContent.querySelector("#tt-body");
    ttSelect.addEventListener("change", async () => {
      const years = parseInt(ttSelect.value, 10);
      if (!ttBody || !years) return;
      ttBody.innerHTML = `<ul class="stats-list">${skeletonRows(4)}</ul>`;
      try {
        const week = await statsService.fetchTimeTravel(years);
        if (!ttBody.isConnected) return;                         // タブ離脱/再描画で破棄
        if (parseInt(ttSelect.value, 10) !== years) return;      // 後勝ちレースの破棄
        ttBody.innerHTML = renderTimeTravelBody(week, years);
      } catch (e) {
        if (!ttBody.isConnected) return;
        if (parseInt(ttSelect.value, 10) !== years) return;
        ttBody.innerHTML = `<div class="empty-state">取得失敗: ${escapeHtml(e.message || String(e))}</div>`;
      }
    });
  }
}

/**
 * タイムトラベルカード (N年前の今週のあなた)
 *   timeTravel が無い (履歴1年未満/取得失敗) ときはカード自体を出さない
 */
function renderTimeTravelCard(tt) {
  if (!tt || !tt.maxYears || tt.maxYears < 1) return "";
  const options = [];
  for (let n = 1; n <= tt.maxYears; n++) {
    options.push(`<option value="${n}" ${n === (tt.week?.yearsAgo || 1) ? "selected" : ""}>${n}年前</option>`);
  }
  return `
    <div class="stats-card">
      <h3>🕰 タイムトラベル — あの頃のあなた</h3>
      <div style="margin-bottom:8px;">
        <select id="tt-years" class="tt-select">${options.join("")}</select>
        <span style="font-size:11px;color:var(--fg-muted);margin-left:6px;">の今週を振り返る</span>
      </div>
      <div id="tt-body">${renderTimeTravelBody(tt.week, tt.week?.yearsAgo || 1)}</div>
    </div>
  `;
}

function renderTimeTravelBody(week, yearsAgo) {
  if (!week) {
    return `<div class="empty-state">${yearsAgo}年前のこの週は scrobble がありません</div>`;
  }
  const artistRows = (week.artists || []).map((a, i) => `
    <li class="stats-item">
      <div class="rank">${i + 1}</div>
      ${renderArt("", a.name)}
      <div class="name"><div>${escapeHtml(a.name)}</div></div>
      <div class="count">${a.count.toLocaleString()}</div>
    </li>
  `).join("");
  const trackRows = (week.tracks || []).map((t, i) => `
    <li class="stats-item">
      <div class="rank">${i + 1}</div>
      ${renderArt("", t.name)}
      <div class="name"><div>${escapeHtml(t.name)}</div><small style="color:var(--fg-muted);">${escapeHtml(t.artist)}</small></div>
      <div class="count">${t.count.toLocaleString()}</div>
    </li>
  `).join("");
  const topArtist = week.artists?.[0]?.name;
  return `
    <div style="font-size:12px;color:var(--fg-muted);margin-bottom:6px;">${escapeHtml(week.label)} ・ ${week.total.toLocaleString()} scrobbles</div>
    ${topArtist ? `<div style="font-size:13px;margin-bottom:8px;">${week.yearsAgo}年前のこの週、あなたは <strong style="color:var(--accent);">${escapeHtml(topArtist)}</strong> をよく聴いていました</div>` : ""}
    <div class="tt-grid">
      <div>
        <h4>アーティスト</h4>
        <ul class="stats-list">${artistRows || emptyRow()}</ul>
      </div>
      <div>
        <h4>トラック</h4>
        <ul class="stats-list">${trackRows || emptyRow()}</ul>
      </div>
    </div>
  `;
}

function renderRewindOrigin(origin, loading) {
  if (!origin) {
    return loading
      ? `<div class="skeleton skeleton-line" style="width:80%;"></div>`
      : `<div class="empty-state">データがありません</div>`;
  }
  return `
    <div class="rewind-origin-block">
      ${renderArt(origin.top.image, origin.top.name)}
      <div>
        <div class="rewind-origin-year">${origin.year}年</div>
        <div class="rewind-origin-text">最もよく聴いたアーティスト</div>
        <div class="rewind-origin-name">${escapeHtml(origin.top.name)}</div>
        <div class="rewind-origin-count">${origin.top.count.toLocaleString()} scrobbles</div>
      </div>
    </div>
  `;
}

function renderMilestones(stones, loading) {
  if (!stones) return loading ? skeletonRows(3) : `<li class="empty-state">データがありません</li>`;
  if (stones.length === 0) return `<li class="empty-state">マイルストン到達なし</li>`;
  return stones.map((s) => `
    <li class="stats-item">
      <div class="rank">🏆</div>
      <div class="name">
        <div>${s.target.toLocaleString()} scrobbles 達成</div>
        <small style="color:var(--fg-muted);">${s.year}年</small>
      </div>
    </li>
  `).join("");
}

function renderYearCards(years) {
  if (!years || years.length === 0) return "";
  return years.slice().reverse().map((y) => `
    <div class="stats-card">
      <h3>${y.year}年のトップ3</h3>
      <div class="rewind-year-grid">
        <div>
          <h4>アーティスト</h4>
          <ol class="rewind-list">${y.topArtists.map(rewindMini).join("") || "<li>—</li>"}</ol>
        </div>
        <div>
          <h4>アルバム</h4>
          <ol class="rewind-list">${y.topAlbums.map(rewindMini).join("") || "<li>—</li>"}</ol>
        </div>
        <div>
          <h4>トラック</h4>
          <ol class="rewind-list">${y.topTracks.map(rewindMini).join("") || "<li>—</li>"}</ol>
        </div>
      </div>
      <div class="rewind-year-total">${y.total.toLocaleString()} scrobbles</div>
    </div>
  `).join("");
}

function rewindMini(item) {
  return `<li title="${escapeAttr(item.name)}"><span class="r-name">${escapeHtml(item.name)}</span> <span class="r-cnt">${item.count}</span></li>`;
}

/* ============ 時間 ============ */

function renderTime(timeData, state) {
  if (!refs?.tabContent) return;
  const loading = !timeData;
  refs.tabContent.innerHTML = `
    <div class="warn-box" id="time-progress">
      ${state.status === "fetching"
        ? (state.workerProgress.totalPages > 0
            ? `集計中… (${state.workerProgress.page}/${state.workerProgress.totalPages} ページ)`
            : "全期間データを集計中…")
        : (timeData?.snapshot ? `集計完了 (${timeData.snapshot.total.toLocaleString()} scrobbles)` : "データがありません")}
    </div>

    <div class="stats-card">
      <h3>リスニングクロック (24時間別)</h3>
      <div class="chart-wrap"><canvas id="chart-clock"></canvas></div>
    </div>

    <div class="time-grid">
      <div class="stats-card">
        <h3>時間帯</h3>
        <div class="chart-wrap" style="height:180px;"><canvas id="chart-tod"></canvas></div>
      </div>
      <div class="stats-card">
        <h3>平日 vs 週末</h3>
        <div class="chart-wrap" style="height:180px;"><canvas id="chart-wkwe"></canvas></div>
      </div>
    </div>

    <div class="stats-card">
      <h3>聴取時間帯 (曜日 × 時刻 ヒートマップ)</h3>
      <div id="heatmap" class="heatmap"></div>
    </div>

    <div class="stats-card">
      <h3>月別 scrobble</h3>
      <div class="chart-wrap"><canvas id="chart-month"></canvas></div>
    </div>

    <div class="stats-card">
      <h3>🧭 発見の歴史 (月別 新規アーティスト数)</h3>
      <div class="chart-wrap"><canvas id="chart-discovery"></canvas></div>
      <div id="discovery-note" style="font-size:11px;color:var(--fg-muted);margin-top:6px;"></div>
    </div>

    <div class="stats-card">
      <h3>アーティスト分布 (上位20)</h3>
      <div class="chart-wrap"><canvas id="chart-artist"></canvas></div>
      <ul class="stats-list" id="artist-rank-list" style="margin-top:12px;"></ul>
    </div>
  `;
  if (timeData?.snapshot) {
    updateTimeCharts(timeData.snapshot);
  }
  // renderTime は引数 loading を受け取るが現状の time タブはローディング演出
  // を Chart.js 側 (Worker からの段階的描画) で表現するため、本関数では
  // 直接使わない。将来のローディング状態切替で参照する余地を残すため引数は
  // 保持し、未使用警告を抑止するために void で参照だけしておく。
  void loading;
}

// 疎な月別配列 [["YYYY-MM", n], ...](昇順)を最小月〜最大月の連続月で 0 埋めする。
// 折れ線チャートで欠損月を詰めると時間軸が不均一になり長期休止が消えるため(Loved
// タイムライン stats-service.js の 0 埋めと同方針)。2点未満はそのまま返す。
function fillMonthGaps(byMonth) {
  if (!Array.isArray(byMonth) || byMonth.length < 2) return byMonth || [];
  const idx = (k) => { const [y, m] = String(k).split("-").map(Number); return y * 12 + (m - 1); };
  const fmt = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
  const map = new Map(byMonth.map(([k, v]) => [k, v]));
  const start = idx(byMonth[0][0]);
  const end = idx(byMonth[byMonth.length - 1][0]);
  if (!(end >= start)) return byMonth; // 不正キー時は素通し
  const out = [];
  for (let i = start; i <= end; i++) { const k = fmt(i); out.push([k, map.get(k) || 0]); }
  return out;
}

function updateTimeCharts(snap) {
  if (!window.Chart) return;

  // リスニングクロック (radar)
  const clockCanvas = document.getElementById("chart-clock");
  // heatmap が 7×24 でない不正形状(空配列等)のときは clock 集計をスキップして他チャートの
  // 描画を継続する(renderHeatmap の !matrix.length ガードと方針を揃える。多重添字での例外で
  // updateTimeCharts 全体が中断し以降のチャートが全滅するのを防ぐ)。
  if (clockCanvas && Array.isArray(snap.heatmap) && snap.heatmap.length === 7) {
    const hours = new Array(24).fill(0);
    for (let dow = 0; dow < 7; dow++) {
      for (let h = 0; h < 24; h++) hours[h] += snap.heatmap[dow][h];
    }
    const data = {
      labels: hours.map((_, h) => `${h}時`),
      datasets: [{
        label: "scrobbles",
        data: hours,
        backgroundColor: "rgba(255,94,126,0.35)",
        borderColor: "#ff5e7e",
        borderWidth: 2,
      }],
    };
    try { chartClock && chartClock.destroy(); } catch {}
    chartClock = new Chart(clockCanvas, {
      type: "radar", data,
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: { r: { beginAtZero: true, ticks: { color: getCssVar("--fg-muted"), backdropColor: "transparent" }, grid: { color: getCssVar("--border") }, angleLines: { color: getCssVar("--border") }, pointLabels: { color: getCssVar("--fg-muted"), font: { size: 10 } } } },
        plugins: { legend: { display: false } },
      },
    });
  }

  // 時間帯
  const todCanvas = document.getElementById("chart-tod");
  if (todCanvas) {
    const t = snap.timeOfDay || { night: 0, morning: 0, day: 0, evening: 0 };
    const data = {
      labels: ["深夜 (0-5)", "朝 (6-11)", "昼 (12-17)", "夜 (18-23)"],
      datasets: [{ data: [t.night, t.morning, t.day, t.evening], backgroundColor: ["#444", "#ffb86b", "#57d18a", "#ff5e7e"] }],
    };
    try { chartTimeOfDay && chartTimeOfDay.destroy(); } catch {}
    chartTimeOfDay = new Chart(todCanvas, {
      type: "doughnut", data,
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: getCssVar("--fg-muted"), font: { size: 10 } } } } },
    });
  }

  // 平日 vs 週末
  const wkweCanvas = document.getElementById("chart-wkwe");
  if (wkweCanvas) {
    const w = snap.weekdayWeekend || { weekday: 0, weekend: 0 };
    const data = {
      labels: ["平日 (月-金)", "週末 (土日)"],
      datasets: [{ data: [w.weekday, w.weekend], backgroundColor: ["#57d18a", "#ff5e7e"] }],
    };
    try { chartWeekdayWeekend && chartWeekdayWeekend.destroy(); } catch {}
    chartWeekdayWeekend = new Chart(wkweCanvas, {
      type: "doughnut", data,
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: getCssVar("--fg-muted"), font: { size: 10 } } } } },
    });
  }

  // ヒートマップ
  renderHeatmap(snap.heatmap);

  // 月別
  const monthCanvas = document.getElementById("chart-month");
  if (monthCanvas) {
    // 欠損月(scrobble 0件の月)を 0 埋めして連続月にする。折れ線は連続時間軸を暗示するため、
    // 詰めると長期休止(例 2022-12→2024-01)が1ステップに圧縮されトレンドが誤読される。
    const months = fillMonthGaps(snap.byMonth);
    const data = {
      labels: months.map((e) => e[0]),
      datasets: [{
        label: "scrobbles",
        data: months.map((e) => e[1]),
        borderColor: "#ff5e7e",
        backgroundColor: "rgba(255,94,126,0.25)",
        tension: 0.2,
        pointRadius: 0,
      }],
    };
    // renderTime は呼ばれるたびに innerHTML で canvas を作り直すため、既存の
    // Chart インスタンスは DOM から外れた古い canvas にバインドされたままになる。
    // update() では新しい canvas が空白のまま残るので、他チャート（clock/tod/
    // wkwe）と同様に必ず destroy してから現在の canvas で作り直す。
    try { chartMonth && chartMonth.destroy(); } catch {}
    chartMonth = new Chart(monthCanvas, { type: "line", data, options: chartOpts() });
  }

  // 発見の歴史 (月別の新規アーティスト発見数。Worker 集計済みの遊休データ)
  // データ消失時の destroy 漏れ防止のため生成前に無条件破棄(UI-2)
  try { chartDiscovery && chartDiscovery.destroy(); } catch {} chartDiscovery = null;
  const discoveryCanvas = document.getElementById("chart-discovery");
  // discoveryByMonth は全ページ取得が完了するまで空(降順ページングのため部分取得では
  // 発見月が偏るので service が確定まで空にしている。DC-1)。空のときはグラフを描かず
  // 「集計中」を明示し、誤った発見履歴を見せない。
  if (!(snap.discoveryByMonth && snap.discoveryByMonth.length > 0)) {
    const dNote = document.getElementById("discovery-note");
    if (dNote) dNote.textContent = "発見の歴史は全期間の集計完了後に表示されます（集計中…）";
  }
  if (discoveryCanvas && snap.discoveryByMonth && snap.discoveryByMonth.length > 0) {
    const data = {
      labels: snap.discoveryByMonth.map((e) => e[0]),
      datasets: [{
        label: "新規アーティスト",
        data: snap.discoveryByMonth.map((e) => e[1]),
        backgroundColor: "rgba(87,209,138,0.5)",
        borderColor: "#57d18a",
        borderWidth: 1,
      }],
    };
    try { chartDiscovery && chartDiscovery.destroy(); } catch {}
    chartDiscovery = new Chart(discoveryCanvas, { type: "bar", data, options: chartOpts() });
    // 最多発見月の一言
    const noteEl = document.getElementById("discovery-note");
    if (noteEl) {
      const best = snap.discoveryByMonth.slice().sort((a, b) => b[1] - a[1])[0];
      if (best) {
        const [ym, n] = best;
        const [y, m] = ym.split("-");
        noteEl.textContent = `最も発見が多かったのは ${y}年${parseInt(m, 10)}月 — ${n} 組の新しいアーティストに出会いました`;
      }
    }
  }

  // アーティスト分布
  const artistCanvas = document.getElementById("chart-artist");
  if (artistCanvas) {
    // ★ Object.entries は整数相当のキー(純数字アーティスト名 "311"/"10"/"1975" 等)を昇順で
    //   先頭にホイストするため、再生数降順を保証するよう明示ソート(順位/円グラフ/色の整合)。
    const entries = Object.entries(snap.topArtists).sort((a, b) => b[1] - a[1]);
    const colors = rainbowColors(entries.length);
    const data = {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => e[1]), backgroundColor: colors }],
    };
    // chartMonth と同じ理由（canvas が毎回再生成される）で、破棄してから作り直す。
    try { chartArtist && chartArtist.destroy(); } catch {}
    chartArtist = new Chart(artistCanvas, { type: "doughnut", data, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });

    // 円グラフ下にランキングリストを表示（1〜20位・色連動）
    const artistListEl = document.getElementById("artist-rank-list");
    if (artistListEl) {
      // 割合は全 scrobble(snap.total)に対する比率にする。上位20の合計を分母にすると、
      //   「全リスニングに占める割合」と読まれたとき過大表示になる(円グラフは上位20内の相対比を
      //   示す別表現)。snap.total 不在時のみ上位20合計にフォールバック。
      const grandTotal = snap.total || entries.reduce((s, [, v]) => s + v, 0);
      artistListEl.innerHTML = entries.length > 0
        ? entries.map(([name, count], i) => {
            const pct = grandTotal > 0 ? ((count / grandTotal) * 100).toFixed(1) : "0.0";
            return `
              <li class="stats-item">
                <div class="rank">${i + 1}</div>
                <div style="width:12px;height:12px;min-width:12px;border-radius:50%;background:${colors[i]};"></div>
                <div class="name"><div>${escapeHtml(name)}</div></div>
                <div class="count">${Number(count).toLocaleString()} <small style="color:var(--fg-muted);">(${pct}%)</small></div>
              </li>
            `;
          }).join("")
        : `<li class="empty-state">データがありません</li>`;
    }
  }
}

function renderHeatmap(matrix) {
  const root = document.getElementById("heatmap");
  if (!root || !matrix || !matrix.length) return;
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  let max = 1;
  for (const row of matrix) for (const v of row) if (v > max) max = v;
  let html = `<div></div>`;
  for (let h = 0; h < 24; h++) html += `<div style="text-align:center;">${h % 6 === 0 ? h : ""}</div>`;
  for (let d = 0; d < 7; d++) {
    html += `<div>${days[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = matrix[d][h];
      const alpha = v / max;
      html += `<div class="heatmap-cell" style="background:rgba(255,94,126,${(alpha * 0.9 + 0.05).toFixed(2)});" title="${days[d]} ${h}:00 — ${v}件"></div>`;
    }
  }
  root.innerHTML = html;
}

/* ============ Loved ============ */

function renderLoved(lovedData) {
  if (!refs?.tabContent) return;
  const loading = !lovedData;
  const list = lovedData?.list || [];
  const timeline = lovedData?.timeline || [];
  const anniversaries = lovedData?.anniversaries || [];
  const yearTop = lovedData?.yearTop || [];
  const similar = lovedData?.similar || [];

  refs.tabContent.innerHTML = `
    ${lovedData?.truncated ? `<div class="help" style="font-size:11px;color:var(--fg-muted);margin-bottom:8px;">※ Love が 1000 件を超えるため、履歴グラフ・年別・記念日の集計は直近 1000 件の Love を対象にしています（古い年は含まれない場合があります）。</div>` : ""}
    ${anniversaries.length ? `
      <div class="stats-card anniversary-card">
        <h3>🎉 Love 記念日</h3>
        ${anniversaries.slice(0, 5).map((a) => `
          <div class="anniversary-row">
            <strong>${a.yearsAgo}年前の今日</strong>、「${escapeHtml(a.name)}」(${escapeHtml(a.artist)}) を Love しました
          </div>
        `).join("")}
      </div>` : ""}

    ${timeline.length > 1 ? `
      <div class="stats-card">
        <h3>📈 Love の歴史 (月別)</h3>
        <div class="chart-wrap" style="height:180px;"><canvas id="chart-loved-timeline"></canvas></div>
      </div>` : ""}

    ${yearTop.length ? `
      <div class="stats-card">
        <h3>年別 よく Love したアーティスト</h3>
        ${yearTop.slice(0, 6).map((y) => `
          <div class="loved-year-row">
            <span class="loved-year">${escapeHtml(y.year)}</span>
            <span class="loved-year-artists">${y.artists.map((a) => `${escapeHtml(a.name)} (${a.count})`).join(" ・ ")}</span>
            <span class="loved-year-total">${y.total} 曲</span>
          </div>
        `).join("")}
      </div>` : ""}

    ${similar.length ? `
      <div class="stats-card">
        <h3>🎁 この曲が好きなら</h3>
        ${similar.map((s) => `
          <div class="similar-seed">
            <div class="similar-seed-head">「${escapeHtml(s.seed.name)}」(${escapeHtml(s.seed.artist)}) が好きなら…</div>
            <ul class="stats-list">
              ${s.items.map((t, i) => `
                <li class="stats-item">
                  <div class="rank">${i + 1}</div>
                  ${renderArt("", t.name)}
                  <div class="name">
                    <div>${escapeHtml(t.name)}</div>
                    <small style="color:var(--fg-muted);">${escapeHtml(t.artist)}${safeUrl(t.url) ? ` ・ <a href="${escapeAttr(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">Last.fm</a>` : ""}</small>
                  </div>
                  <div class="count">${t.matchPct != null ? `${t.matchPct}%` : ""}</div>
                </li>
              `).join("")}
            </ul>
          </div>
        `).join("")}
      </div>` : ""}

    <div class="stats-card">
      <h3>Loved トラック${lovedData?.total ? ` (全 ${lovedData.total.toLocaleString()} 曲)` : ""}</h3>
      <ul class="stats-list" id="loved-list">
        ${list.length
          ? list.map((t, i) => `
              <li class="stats-item">
                <div class="rank">${i + 1}</div>
                ${renderArt(t.image, t.name)}
                <div class="name"><div>${escapeHtml(t.name)}</div><small style="color:var(--fg-muted);">${escapeHtml(t.artist)}</small></div>
                <div class="count">${escapeHtml(t.when)}</div>
              </li>
            `).join("")
          : (loading ? skeletonRows(8) : `<li class="empty-state">データがありません</li>`)}
      </ul>
      ${list.length && lovedData?.total > list.length ? `<div style="font-size:11px;color:var(--fg-dim);margin-top:6px;">最新 ${list.length} 件を表示しています</div>` : ""}
    </div>
  `;

  // 月別 Love 数チャート(データ消失時の destroy 漏れ防止のため生成前に無条件破棄。UI-2)
  try { chartLovedTimeline && chartLovedTimeline.destroy(); } catch {} chartLovedTimeline = null;
  if (window.Chart && timeline.length > 1) {
    const canvas = document.getElementById("chart-loved-timeline");
    if (canvas) {
      try { chartLovedTimeline && chartLovedTimeline.destroy(); } catch {}
      chartLovedTimeline = new Chart(canvas, {
        type: "bar",
        data: {
          labels: timeline.map((e) => e[0]),
          datasets: [{ label: "Love", data: timeline.map((e) => e[1]), backgroundColor: "rgba(255,94,126,0.6)", borderColor: "#ff5e7e", borderWidth: 1 }],
        },
        options: chartOpts(),
      });
    }
  }
}

/* ============ チャート破棄 ============ */

function destroyAllCharts() {
  [chartMonth, chartArtist, chartClock, chartTimeOfDay, chartWeekdayWeekend, chartRewindYear,
   chartDiscovery, chartGenre, chartDecade, chartLovedTimeline]
    .forEach((c) => { try { c && c.destroy(); } catch {} });
  chartMonth = chartArtist = null;
  chartClock = chartTimeOfDay = chartWeekdayWeekend = null;
  chartRewindYear = null;
  chartDiscovery = chartGenre = chartDecade = chartLovedTimeline = null;
}

/* ============ 共通ユーティリティ ============ */

function skeletonRows(n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `<li class="stats-item"><div class="skeleton skeleton-line" style="width:100%;"></div></li>`;
  }
  return out;
}

function emptyRow(msg = "データがありません") {
  return `<li class="empty-state">${escapeHtml(msg)}</li>`;
}

function chartOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: { ticks: { color: getCssVar("--fg-muted") }, grid: { color: getCssVar("--border") } },
      y: { beginAtZero: true, ticks: { color: getCssVar("--fg-muted") }, grid: { color: getCssVar("--border") } },
    },
    plugins: { legend: { display: false } },
  };
}

function rainbowColors(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`hsl(${(i * 360 / n).toFixed(0)}, 60%, 55%)`);
  return out;
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

/* ============ 画像表示ヘルパ ============ */

/**
 * 画像がない場合のフォールバック表示を含めて img/div を返す。
 *
 * Last.fm API の仕様により、以下のケースで画像が空になることが多い:
 *   - トップアーティスト: Last.fm が 2020年に画像 API を廃止
 *   - トップトラック: Last.fm 側のメタデータ不一致
 *   - 比較タブ全項目: Weekly Chart API が画像を返さない（→ buildImageLookup で補完）
 *
 * 空のときは `<img src="">` の壊れた表示を避けるため、頭文字を表示する div を返す。
 *
 * @param {string} image - 画像 URL（空文字の場合フォールバック）
 * @param {string} name  - フォールバックに使う名前（最初の1文字を表示）
 */
function renderArt(image, name) {
  if (image) {
    // 画像URLが失効(404等)していても壊れた画像アイコンを出さない。読み込み失敗時は枠だけ残して隠す。
    //   (no-image 経路のイニシャル表示まで再現するには全タブ共通の本関数のマークアップ変更が要るため、
    //    ここでは成功時の挙動を変えない最小・無リスクの onerror 非表示に留める。静的文字列でエスケープ不要)
    return `<img src="${escapeAttr(image)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />`;
  }
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  // hash → 色相 で安定した色を付与（同じ名前 = 同じ色）
  const hue = nameToHue(name);
  return `<div class="stats-art-fallback" style="background:hsl(${hue}, 50%, 35%);">${escapeHtml(letter)}</div>`;
}

function nameToHue(name) {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * 比較タブ用の画像ルックアップマップを構築。
 *
 * Last.fm の Weekly Chart API は画像を返さないため、比較タブの項目はすべて
 * image が空になる。トップタブのデータ（user.getTopXxx）は画像を含むので、
 * そこから artist / album / track の画像をルックアップして補完する。
 */
// buildImageLookup の結果を topData 参照で memo 化する。renderCompare は範囲タブ切替や
//   逐次 publish のたびに呼ばれるが、top データ参照が不変なら最大360件の再走査は不要。
//   参照が変われば(top 後着で新データ)再構築するため UI-3 の画像補完は維持される。
let _imgLookupCache = { ref: null, map: null };
function getImageLookup(topData) {
  if (_imgLookupCache.ref === topData && _imgLookupCache.map) return _imgLookupCache.map;
  const map = buildImageLookup(topData);
  _imgLookupCache = { ref: topData, map };
  return map;
}

function buildImageLookup(topData) {
  const map = {
    artist: new Map(),  // name → image
    album:  new Map(),  // "artist::name" → image
    track:  new Map(),  // "artist::name" → image
  };
  if (!topData?.byPeriod) return map;
  for (const period of Object.keys(topData.byPeriod)) {
    const data = topData.byPeriod[period];
    if (!data) continue;
    for (const it of (data.artists || [])) {
      if (it.image && !map.artist.has(it.name)) map.artist.set(it.name, it.image);
    }
    for (const it of (data.albums || [])) {
      if (it.image) {
        const key = `${it.artist}::${it.name}`;
        if (!map.album.has(key)) map.album.set(key, it.image);
      }
    }
    for (const it of (data.tracks || [])) {
      if (it.image) {
        const key = `${it.artist}::${it.name}`;
        if (!map.track.has(key)) map.track.set(key, it.image);
      }
    }
  }
  return map;
}

function lookupImage(item, kind, lookup) {
  if (!lookup) return "";
  if (kind === "artist") return lookup.artist.get(item.name) || "";
  if (kind === "album")  return lookup.album.get(`${item.artist}::${item.name}`) || "";
  if (kind === "track")  return lookup.track.get(`${item.artist}::${item.name}`) || "";
  return "";
}
