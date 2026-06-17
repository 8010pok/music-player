/**
 * 統計データ取得バックグラウンドサービス（シングルトン）
 *
 * 設計目的:
 *   - 統計画面に必要なデータを「画面マウント・アンマウントから独立して」
 *     バックグラウンドで取得・集計する
 *   - 取得結果は IndexedDB に「表示用に整形した最小データ」だけ保存
 *   - JST 日付が変わるか手動更新ボタンで再取得
 *   - 画面遷移・タブ切替で Worker / fetch を停止しない
 *
 * 注意:
 *   - 音声経路 (<audio> 要素・MediaSession・AudioContext) には一切触らない。
 *     iOS のロック画面・バックグラウンド再生は完全に独立して動作する。
 *
 * 公開API:
 *   - getState()          : 現在の状態（読み取り専用扱い）
 *   - subscribe(cb)       : 状態変化購読、unsubscribe を返す
 *   - startIfNeeded(user) : 必要なら取得開始（同じ JST 日付の保存済みデータがあれば skip）
 *   - refresh()           : 強制再取得（キャッシュ破棄）
 *   - cancel()            : キャンセル
 */

import { toast } from "../ui/components.js";
import {
  iterateAllRecentTracks,
  getUserInfo,
  getRecentTracks,
  getRecentTracksCount,
  getTopTracks,
  getTopArtists,
  getTopAlbums,
  getLovedTracks,
  getSimilarTracks,
  getWeeklyChartList,
  getWeeklyArtistChart,
  getWeeklyTrackChart,
  getChartTopArtists,
  getGeoTopArtists,
  getArtistTopTags,
  getArtistInfo,
  getTrackInfo,
  getAlbumInfo,
  getTagTopArtists,
  getFriends,
  pickImage,
} from "./stats.js";
import { buildComparison, findNewDiscoveries, buildRewind, clearWeekInflight } from "./stats-compare.js";
import { cached, clearCache, pruneCache, ckey } from "./stats-cache.js";
import {
  getJSTDateString,
  loadCurrent,
  saveCurrent,
  clearCurrent,
  saveHistory,
  pruneHistory,
  loadHistory,
  listHistoryDates,
} from "./stats-storage.js";

/* ============ 定数 ============ */

const PERIODS = ["7day", "1month", "3month", "6month", "12month", "overall"];
const COMPARE_RANGES = ["week", "month", "year"];

// 取得タスク総数（progress 表示用）:
// dashboard / top / compare / rewind / time / loved / genre / world = 8
const TOTAL_TASKS = 8;

// 国別チャート照合の対象国と表示名。
// geo.getTopArtists は ISO 3166-1 国名を要求するが、通称の受理範囲が
// 明文化されていないため、candidates を先頭から順に試し最初に結果が
// 返った表記を採用する (例: "South Korea" が不可でも ISO 表記で再試行)。
const GEO_COUNTRIES = [
  { label: "日本",     candidates: ["Japan"] },
  { label: "アメリカ", candidates: ["United States"] },
  { label: "イギリス", candidates: ["United Kingdom"] },
  { label: "韓国",     candidates: ["South Korea", "Korea, Republic of"] },
];

// ジャンル DNA 集計から除外するノイズタグ (ユーザ投稿由来でジャンルでないもの)
const NOISE_TAGS = new Set([
  "seen live", "favorites", "favourites", "favorite", "favourite",
  "spotify", "check out", "albums i own", "vinyl", "my music", "owned",
  "under 2000 listeners", "all", "music", "good", "awesome", "beautiful",
  "love", "loved", "epic", "best", "favorite artists", "favourite artists",
]);

/* ============ モジュールスコープ状態（永続） ============ */

let state = makeInitialState();
let worker = null;
let abortFlag = false;
// ★ run 世代カウンタ。runFetch のたびにインクリメントされる。
//   abortFlag は runFetch 冒頭で false にリセットされるため、cancel→runFetch の
//   連続呼び出しでは「旧 run の await 中タスク」が再開時に abortFlag=false を
//   観測してしまい中断できない(旧 run が新 run と並走し、旧データの commit・
//   二重保存・進捗二重カウントを起こす)。各タスクは自分の runId を保持し、
//   isStaleRun(runId) で「自分が最新世代か」を判定して stale なら no-op 化する。
let runSeq = 0;

/**
 * このタスクの run が古い(=新しい runFetch が開始された)か、abort 中かを判定。
 * 各 fetchXxx は await 復帰後・updateSection 前にこれを確認する。
 */
function isStaleRun(runId) {
  return abortFlag || runId !== runSeq;
}
const subscribers = new Set();
// visibility 変化時の日付変更検知に使う
let visibilityWatcherRegistered = false;
// スタック検知による自動再起動の二重実行防止フラグ
let stuckRestartPending = false;

// === スタック検知用タイムスタンプ ===
// バックグラウンド中に fetch がハングした場合、フォアグラウンド復帰時に
// 「進捗が長時間止まっている」ことを検知して自動再起動するために使う。
let fetchStartedAt = 0;    // 現在の runFetch を開始した時刻 (ms)
let lastProgressAt = 0;    // 進捗らしい update があった最後の時刻 (ms)

// === ダッシュボードのライブポーリング（Now Playing 検知用） ===
//   ダッシュボード表示中のみ動き、30 秒おきに最近の曲を更新して Now Playing を追従する。
//   読取専用 (key-only) でも apiKey さえあれば動作する。
const LIVE_INTERVAL_MS = 30 * 1000;
// リスニング数 / 先週比 / プロフィールは scrobble 発生時(=数分に1回)しか値が変わらない。
//   毎 tick(30秒)で全部取りに行くと曲が変わらない大半の tick で 5/6 GET(userInfo 1+リスニング数 3+先週比 1。
//   recent 1 以外)が冗長になり、
//   前景で開きっぱなしのとき帯域/バッテリ/レート枠を無駄に消費する。そこで recent
//   (Now Playing 追従に必須)は毎 tick、counts 系は LIVE_COUNTS_EVERY tick に 1 回だけ
//   取得して GET を約 1/3 へ削減する。オンライン/フォアグラウンド復帰時は別途即取得する。
const LIVE_COUNTS_EVERY = 4; // 30秒 × 4 = 約2分ごとにリスニング数/先週比/プロフィールを更新
let liveTimer = null;
let liveActive = false;
let liveVisibilityRegistered = false;

function makeInitialState() {
  return {
    status: "idle",           // "idle" | "fetching" | "done" | "error"
    user: null,
    fetchDate: null,          // YYYY-MM-DD (JST)
    activity: "",             // "最近の取得中…" 等
    progress: { current: 0, total: TOTAL_TASKS },
    workerProgress: { page: 0, totalPages: 0 },
    error: null,
    sections: emptySections(),
    // 各タブの「表示可能」状態。すべて揃ってから画面に出すための判定に使う。
    // ダッシュボードは fetchDashboardBase と fetchTimeAndExtras の両方完了時に true。
    sectionReady: emptySectionReady(),
    lastCompletedAt: 0,       // 完了時刻 (msec)
  };
}

function emptySections() {
  return {
    dashboard: null,
    top: null,
    compare: null,
    rewind: null,
    time: null,
    loved: null,
    genre: null,
    world: null,
  };
}

function emptySectionReady() {
  return {
    dashboard: false,
    top: false,
    compare: false,
    rewind: false,
    time: false,
    loved: false,
    genre: false,
    world: false,
  };
}

function allSectionReady() {
  return {
    dashboard: true,
    top: true,
    compare: true,
    rewind: true,
    time: true,
    loved: true,
    genre: true,
    world: true,
  };
}

/**
 * sections オブジェクトを見て、実データが存在するセクションだけ true にした
 * sectionReady を返す。
 *
 * loadCurrent() で取得した保存済みデータが「全セクション完備」ではない場合
 * （前回 PWA を途中終了した場合など）に、画面側へ「このセクションは表示可能、
 * このセクションはまだロード中」を正確に伝えるために使う。
 * allSectionReady() は全 true を返すが、こちらは実態に即した値を返す。
 */
function computeSectionReady(sections) {
  return {
    dashboard: !!sections?.dashboard,
    top:       !!sections?.top,
    compare:   !!sections?.compare,
    rewind:    !!sections?.rewind,
    time:      !!sections?.time,
    loved:     !!sections?.loved,
    genre:     !!sections?.genre,
    world:     !!sections?.world,
  };
}

/**
 * 全セクションに実データが揃っているか判定する。
 *
 * startIfNeeded が「当日の保存済みデータをそのまま使う（再取得しない）」かどうかを
 * 判定するために使う。一部でも null があれば false を返し、再取得を促す。
 * これにより、前回 PWA を途中終了して保存が不完全だった場合に、古いデータを
 * バッファとして表示しながら欠損分を再取得する動作が実現する。
 */
function isAllSectionsPopulated(sections) {
  if (!sections) return false;
  return !!(
    sections.dashboard &&
    sections.top       &&
    sections.compare   &&
    // 振り返りが部分取得のまま(partial:true)保存された場合(逐次表示後に取得失敗等)は
    // 「未完備」とみなして再取得させる。さもないと同日再起動で「完備→再取得スキップ」と
    // 誤判定され、部分データ+「集計中…」ヘッダのまま固定されてしまう。
    (sections.rewind && !sections.rewind.partial) &&
    sections.time      &&
    sections.loved     &&
    sections.genre     &&
    sections.world
  );
}

/* ============ 公開 API ============ */

export function getState() {
  return state;
}

export function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * 必要なら取得開始
 *   - 既に取得中で同じユーザ → 何もしない
 *   - 永続化済みデータが「同じユーザ & 今日 (JST) & 全セクション完備」→ そのまま使う（再取得なし）
 *   - 永続化済みデータが「同じユーザ & 今日 & 一部欠損」（前回途中終了）→ バッファ表示 + 再取得
 *   - 永続化済みデータが「同じユーザ & 別日」→ 古いデータをバッファ表示 + 再取得
 *   - それ以外 → 通常取得（ローディング画面）
 */
export async function startIfNeeded(user) {
  ensureVisibilityWatcher();
  if (!user) return;

  // 既に取得中
  if (state.status === "fetching") {
    if (state.user === user) return;
    // ユーザ変更で取得中だった場合はキャンセルして再開
    await cancel();
  }

  // 永続化済みデータをロード
  const saved = await loadCurrent();
  const today = getJSTDateString();

  if (saved && saved.user === user && saved.fetchDate === today) {
    // saved.complete === false は「前回 run が未完了(セクション欠損/reject/部分)で保存された」
    // 印。当日でも未完備なら再取得して、古い/部分データが今日付けで固定されるのを防ぐ
    // (省略・true の旧レコードは完了扱い=後方互換)。
    if (isAllSectionsPopulated(saved.sections) && saved.complete !== false) {
      // 当日データがすべて揃っている → 再取得不要
      state = {
        ...makeInitialState(),
        status: "done",
        user,
        fetchDate: today,
        sections: saved.sections,
        sectionReady: allSectionReady(),
        lastCompletedAt: saved.timestamp || 0,
      };
      // 完備データを採用 = 未完了の retry 対象なし。
      lastRunComplete = true;
      notify();
      return;
    }

    // ★ 当日データだが一部欠損（前回 PWA を途中終了したためダッシュボード以外が
    //   未保存、など）。保存済みの分をバッファとして即表示し、欠損分を再取得する。
    //   computeSectionReady() で「実際に存在するセクションだけ ready=true」にする
    //   ことで、UI 側が「このタブは表示可能 / このタブはロード中」を正確に把握できる。
    state = {
      ...makeInitialState(),
      status: "done",
      user,
      fetchDate: today,
      sections: saved.sections || emptySections(),
      sectionReady: computeSectionReady(saved.sections),
      lastCompletedAt: saved.timestamp || 0,
    };
    notify();
    // ここでは return しない → runFetch でバッファモード更新を走らせる
  } else if (saved && saved.user === user) {
    // ★ 別日 (前日まで) の保存データ。それを「古い表示」としてバッファに乗せてから
    //   新データを取得する。computeSectionReady() で部分データにも対応する。
    state = {
      ...makeInitialState(),
      status: "done",
      user,
      fetchDate: saved.fetchDate,
      sections: saved.sections || emptySections(),
      sectionReady: computeSectionReady(saved.sections),
      lastCompletedAt: saved.timestamp || 0,
    };
    notify();
    // ここでは return しない → runFetch でバッファモード更新を走らせる
  }

  // 取得開始 (runFetch 内で state を見て bufferedMode を自動判定)
  await runFetch(user, { forceRefresh: false });
}

/**
 * 未完了(前回 run が complete:false で終わった)場合に、同セッション内でも再取得して完遂させる。
 *   - 統計画面の再マウント / フォアグラウンド復帰から呼ばれる。
 *   - 中断(ネット瞬断・バックグラウンド化での部分失敗等)で一部タブが欠けたまま done になった日、
 *     冷起動・JST日付跨ぎ・手動更新を待たずに、同一セッションのフォアグラウンド再訪で完遂させる。
 *   - bufferedMode(dashboard 既 ready)で走るためタブ単位の atomic swap で瞬時切替。
 *   - 完了済み / 取得中 / ユーザ無し のときは何もしない(無駄な再取得を撃たない)。
 *   - runFetch 冒頭の runSeq 世代ガードで二重起動は吸収される。silent でトーストは出さない。
 */
export function retryIfIncomplete() {
  if (!state.user) return;
  if (state.status === "fetching") return;
  if (lastRunComplete) return;
  console.warn("[stats-service] 未完了データを検知、再取得して完遂させます");
  runFetch(state.user, { forceRefresh: false, silent: true }).catch((e) =>
    console.warn("[stats-service] 未完了 run の再取得失敗", e)
  );
}

/**
 * 手動更新ボタン: キャッシュ破棄 + 強制再取得
 */
export async function refresh() {
  const user = state.user;
  if (!user) return;
  await cancel();
  // cancel が dashboardRebuilding=false にするが、refresh は直後に runFetch する。
  // clearCache/clearCurrent の await 中にライブ更新が旧 dashboard をいじらないよう、
  // ここで true に戻して手前の窓を塞ぐ(runFetch 冒頭でも true になる)。
  dashboardRebuilding = true;
  clearWeekInflight();  // 週次取得の in-flight も破棄(clearCache と対。refresh の鮮度競合防止)
  await clearCache();
  await clearCurrent();
  await runFetch(user, { forceRefresh: true });
}

/**
 * キャンセル（実行中の Worker / fetch を中断）
 */
export async function cancel() {
  abortFlag = true;
  // 進行中タスクを世代不一致で即無効化 (abortFlag のリセットに依存しない)
  runSeq++;
  if (worker) {
    try { worker.terminate(); } catch {}
    worker = null;
  }
  // status を idle に戻す。これにより後続の startIfNeeded が 'fetching' ガードで
  // 弾かれず、認証変更直後(同一ユーザ名)でも再取得/キャッシュ表示が走る(LIFE-2)。
  // ※ ライブポーリングはここでは止めない。refresh() も cancel() を経由するため、
  //   ここで止めるとダッシュボード表示中の手動更新でライブ更新(Now Playing)が
  //   止まってしまう(デグレ)。ライブ停止が必要な認証解除/全削除は reset() が担当する。
  if (state.status === "fetching") state = { ...state, status: "idle" };
  dashboardRebuilding = false; // 中断時はライブ更新を解禁(取得が止まるため)
  // 中断後は「完遂を待つ in-flight run は無い」状態にする。さもないと直前 run が done-incomplete
  //   (lastRunComplete=false)のまま cancel された場合、後続の startIfNeeded/refresh が runFetch を
  //   呼ぶまでの await 窓で visibilitychange ハンドラが旧 false を見て retryIfIncomplete を誤発火し、
  //   旧ユーザ(認証切替時)や refresh と競合する余分な runFetch を撃ちうる。次の runFetch が冒頭で
  //   必ず false に立て直すため副作用はない。
  lastRunComplete = true;
  // 短く待機して、各タスクが abort を検知できる猶予を与える
  await new Promise((r) => setTimeout(r, 50));
}

/**
 * 完全リセット (認証解除 / 全データ削除時に呼ぶ)。
 *   中断 + Worker 停止 + state を初期状態 (user=null) に戻す。
 *   これをしないと state.user が残り、JST 日付変更の visibilitychange で
 *   未認証ユーザの再取得が走ってエラートーストが出る(LIFE-1)。
 */
export function reset() {
  abortFlag = true;
  runSeq++;
  if (worker) {
    try { worker.terminate(); } catch {}
    worker = null;
  }
  stopDashboardLiveUpdates();
  dashboardRebuilding = false;
  // 完全リセット後は完遂を待つ run が無い。state.user=null で retryIfIncomplete の消費経路は既に
  //   ガードされるが、意味的整合のため(再ログイン直後の境界での旧 false 観測も含め)明示初期化する。
  lastRunComplete = true;
  state = makeInitialState();
  notify();
}

/* ============ ダッシュボード ライブ更新（Now Playing 検知） ============ */

/**
 * ダッシュボードのライブ更新を開始する。
 *   - 30 秒間隔で「最近の曲」と「ユーザ情報」を再取得する（キャッシュ非経由）
 *   - 取得結果から Now Playing (@attr.nowplaying) を検知して UI に流す
 *   - PWA がバックグラウンドの間はタイマーを止める（バッテリー節約）
 *   - 読取専用 (key-only) でも apiKey があれば動作する
 *
 * 呼び出し側 (view-stats.js):
 *   - ダッシュボードタブ表示中はこれを呼ぶ
 *   - 他タブに切替・画面遷移・アンマウント時に stopDashboardLiveUpdates() を呼ぶ
 */
export function startDashboardLiveUpdates() {
  ensureLiveVisibilityWatcher();
  liveActive = true;
  // 既存タイマーがあれば一旦止めて再開（idempotent）
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  // 即時 1 回 → 以降 30 秒おき。
  //   この開始は runFetch(fetchDashboardBase)とセットで起こり、counts 系は base が
  //   取得するため、起動直後の即時 tick では counts を取らない(liveCountTick=1)。
  //   これで base との二重取得を避ける(recent による Now Playing 追従は即時行う)。
  liveCountTick = 1;
  doDashboardLiveUpdate();
  liveTimer = setInterval(doDashboardLiveUpdate, LIVE_INTERVAL_MS);
}

export function stopDashboardLiveUpdates() {
  liveActive = false;
  // 停止前に走り出していた in-flight tick も世代不一致で無効化する
  liveTickGen++;
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

/**
 * ライブ更新を即時 1 回実行する (オンライン復帰時など)。
 *   liveActive 中のみ動作。view-stats の online イベントから呼ぶ(SVC-3live)。
 *   多重起動は doDashboardLiveUpdate 内の liveBusy ガードで吸収される。
 */
export function triggerLiveUpdateNow() {
  // オンライン復帰など明示トリガでは、リスニング数/先週比も含めてその場で最新化する
  //   (counts 系の間引きカウンタを 0 に戻し、この tick で counts も取得させる)。
  if (liveActive) {
    liveCountTick = 0;
    doDashboardLiveUpdate();
  }
}

function ensureLiveVisibilityWatcher() {
  if (liveVisibilityRegistered) return;
  liveVisibilityRegistered = true;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // バックグラウンドでは止める
      if (liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    } else if (liveActive) {
      // フォアグラウンドに戻ったら即時更新 + タイマー再開。
      //   バックグラウンド中に時間が経っているため、復帰時は counts 系も最新化する
      //   (間引きカウンタを 0 に戻してこの tick で counts も取得させる)。
      liveCountTick = 0;
      doDashboardLiveUpdate();
      if (!liveTimer) {
        liveTimer = setInterval(doDashboardLiveUpdate, LIVE_INTERVAL_MS);
      }
    }
  });
}

// ライブ更新の世代カウンタ。
//   setInterval は前回 tick の完了を待たずに発火するため、リトライ等で前回 tick が
//   30 秒を超えて滞留すると順序逆転(古いデータが新しい commit を上書き)が起きる。
//   tick 冒頭で世代を進め、await 復帰後に自分が最新世代でなければ破棄する。
//   stopDashboardLiveUpdates でもインクリメントし、停止前の in-flight を無効化する。
let liveTickGen = 0;
// 多重起動ドロップ用フラグ。setInterval は前 tick の完了を待たず発火するため、
// 低速回線で前 tick が滞留すると、次 tick が世代を進めて前 tick の取得結果を
// 捨てさせてしまう。busy 中は次 tick をスキップし進行中 tick の結果を活かす(SVC-1)。
let liveBusy = false;
// runFetch が fetchDashboardBase で dashboard を再構築中か(base 完了で false に戻す)。
// この間ライブ更新を見送り、base commit や旧データとの同時 commit によるちらつきを防ぐ。
// 初回ロード/bufferedMode 再取得の両方で「base 完了後にライブ解禁」を実現する(SVC-3)。
let dashboardRebuilding = false;

// ★ bufferedMode(前日データ表示中の更新)のダッシュボード atomic swap 用バリア。
//   base(fetchDashboardBase のコア+週サマリー)と extras(fetchTimeAndExtras の DNA/quickCards)は
//   別タスクで並行完了するため、各々が独立に updateSection すると「今日のコア + 前日 extras」または
//   その逆の混在状態が、最も遅い Worker 集計完了まで(長期ユーザで数分)ライブ表示されてしまう。
//   そこで bufferedMode では両タスクの結果をここに預け、両方「試行完了」したら一度だけ合成 commit する
//   (仕様2: 全揃ってからの瞬時切替を真に担保する)。各 done フラグは成否に関わらず finally で必ず立つため
//   commit は確実に起き、ダッシュボードが前日データのまま固定される(スタック)ことはない。
let _bufDashCore = null;       // base が用意した今日のコアオブジェクト(dna/quickCards は前日値プレースホルダ)
let _bufDashExtras = null;     // extras が用意した今日の {dna, quickCards}(失敗/未完了時は null)
let _bufDashCoreDone = false;
let _bufDashExtrasDone = false;
let _bufDashCommitted = false;

// 直近の runFetch が全セクションを新データで完遂できたか(runComplete と同値)。
//   false の間は「中断/部分失敗で未完了」を意味し、フォアグラウンド再訪/復帰の retryIfIncomplete が
//   同セッション内でも再取得して完遂させる。初期 true(まだ run しておらず再取得対象がない)。
let lastRunComplete = true;

// bufferedMode のダッシュボード atomic swap を試行する。base と extras の両タスクが試行完了したら、
//   今日のコア + 今日の extras(extras 失敗時は core が引き継ぐ前日 dna/quickCards)を一度だけ commit する。
function tryCommitBufferedDashboard(runId) {
  if (isStaleRun(runId)) return;          // 旧 run の commit で新 state を汚さない
  if (!_bufDashCoreDone || !_bufDashExtrasDone) return; // 両タスク揃うまで待つ(atomic)
  if (_bufDashCommitted) return;          // 二重 commit 防止
  _bufDashCommitted = true;
  // core が用意できていない異常時(base が stale/失敗)は現状(前日)を土台にしてスタックを防ぐ。
  const core = _bufDashCore || (state.sections.dashboard || {});
  // ★ _bufDashCore は base 完了時点の凍結スナップショット。base 完了(onCoreReady で dashboardRebuilding=false)
  //   から extras 完了までの Worker 窓(長期ユーザで数分)の間にライブ更新(doDashboardLiveUpdate)が
  //   recent / Now Playing / リスニング数を現在値へ patch しているため、凍結 core でそのまま全置換すると
  //   それらを巻き戻してしまう(Now Playing カードが一過性に消える等)。ライブ更新が管理する揮発フィールドは
  //   commit 直前の現在値を優先し、base 確定フィールド(userInfo/weekSummary/friends/trend 等)は core を採る。
  const live = state.sections.dashboard || {};
  // ★ 揮発フィールド(recent / Now Playing)を live 優先するのは「ライブ更新がこの run の窓中に実際に走って
  //   現在値へ patch した」ときだけにする。判定は dashboardRebuilding: これは runFetch 冒頭から true で、
  //   base 完了(onCoreReady)で false になりライブが解禁される。commit 時点でまだ true の場合はライブが一度も
  //   走っておらず live は前日データのまま(extras-before-base 経路: Worker 生成失敗等で extras が base より先に
  //   done になり、base 分岐の tryCommit が onCoreReady より前=rebuild 解除前に commit する)。その場合に
  //   live.recent を採ると前日 recent/Now Playing が今日コアに混入するため、今日値の core を採る。
  //   rebuild 解除後(extras 起点の commit)は live が窓中に patch 済みなので live を優先し巻き戻しを防ぐ。
  //   _bufDashCore が無い base 失敗フォールバックは core===live なので結果は同じ。
  const preferLive = !!_bufDashCore && !dashboardRebuilding;
  const merged = {
    ...core,
    // listeningCounts と weekSummary は両方 core(base=今日値)を採る: 両者は「今週(直近7日)」カード
    //   (listeningCounts.week)と「今週 scrobbles」カード(weekSummary.cur)が常に一致する不変条件(ユーザ主訴)で
    //   結合しており、core.weekSummary.cur===core.listeningCounts.week なので両方 core なら整合する。
    //   core.weekSummary は今日の topName も保持する(live は前日 topName を引き継ぐため不可)。
    recent: (preferLive && live.recent != null) ? live.recent : core.recent,
    nowPlayingKey: (preferLive && live.nowPlayingKey != null) ? live.nowPlayingKey : core.nowPlayingKey,
    nowPlayingInfo: (preferLive && live.nowPlayingInfo != null) ? live.nowPlayingInfo : core.nowPlayingInfo,
  };
  // extras 成功時は今日の dna/quickCards を上書き、失敗時は core が引き継ぐ前日値を維持(complete:false で再取得)。
  if (_bufDashExtras) {
    merged.dna = _bufDashExtras.dna;
    merged.quickCards = _bufDashExtras.quickCards;
  }
  updateSection("dashboard", merged);
}

// リスニング数/先週比/プロフィールの取得を間引くための tick カウンタ。
//   doDashboardLiveUpdate が tick ごとに進め、LIVE_COUNTS_EVERY の倍数 tick のときだけ
//   counts 系を取得する。初期値 1 にすることで startDashboardLiveUpdates 直後の
//   「即時 tick」では counts を取らず(初回は fetchDashboardBase が取得するため二重取得回避)、
//   オンライン/フォアグラウンド復帰時は 0 にリセットしてその場で counts も最新化する。
let liveCountTick = 1;

async function doDashboardLiveUpdate() {
  if (!liveActive) return;
  if (!state.user) return;
  if (typeof document !== "undefined" && document.hidden) return;
  // ★ オフライン時はライブ更新を行わない。
  //   fetch が失敗するだけでなく、その後 navigator.onLine=true 復帰までは
  //   古い Now Playing 状態がデータに残り続けるのを避ける。
  //   view-stats.js 側で online/offline イベントを購読しており、
  //   オンライン復帰時の即時更新は visibilitychange 等で別途トリガされる。
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  // 前 tick がまだ実行中ならスキップ (多重起動による取得破棄を防ぐ。SVC-1)
  if (liveBusy) return;
  // fetchDashboardBase が dashboard を再構築中はライブ更新を見送る。ライブと base の
  // 同時 commit による一過性の巻き戻し・ちらつきを防ぐ。bufferedMode(別日/部分欠損の
  // 再取得)では sectionReady.dashboard=true のまま再取得するため ready ガードだけでは
  // 防げないが、このフラグは base 完了で解除されるので初回・bufferedMode 両方で正しく
  // 機能する。base 完了後は extras と並行でもライブの差分パッチがマージで保護される(SVC-3)。
  if (dashboardRebuilding) return;
  liveBusy = true;
  // この tick の世代と対象ユーザを捕捉。await 復帰後に検査する。
  const myGen = ++liveTickGen;
  const liveUser = state.user;
  // await 復帰後に「ライブ停止 / 次 tick 開始(順序逆転) / ユーザ切替 / base 再構築中」を検査。
  //   dashboardRebuilding は refresh()/JST 日付変更の再取得と straddle した in-flight tick が
  //   中断で劣化した patch を commit するのを防ぐ(SVC-3)。base 完了(onCoreReady/finally)で必ず
  //   解除されるため恒久停止しない。
  //   ※ abortFlag は条件に含めない: abortFlag は runFetch でしか false に戻らず、cancel() 後に
  //     runFetch が続かない経路(startIfNeeded の当日完備データ早期 return 等)では sticky-true の
  //     まま残り、ライブ更新が恒久停止してしまうため。cancel() 中断 tick の劣化は、各 fetch が
  //     'aborted' で rejected → patch 不採用、かつ listeningCounts の null 据え置きマージで既に防がれる。
  const isLiveStale = () => !liveActive || myGen !== liveTickGen || state.user !== liveUser
    || dashboardRebuilding;
  try {
    // 取得を間引く: recent(Now Playing 追従に必須)は毎 tick、リスニング数/先週比/
    //   プロフィールは LIVE_COUNTS_EVERY tick に 1 回だけ取得して GET を削減する。
    //   いずれもキャッシュ非経由で直接取得(最新の Now Playing 状態と数値を反映)。
    const fetchCounts = (liveCountTick % LIVE_COUNTS_EVERY) === 0;
    liveCountTick++;
    const [recentRes, infoRes, countsRes, prevRes] = await Promise.allSettled([
      getRecentTracks(liveUser, { limit: 20 }),
      // counts を取らない tick は null を返し、下流の値ガードで自然にスキップさせる
      fetchCounts ? getUserInfo(liveUser) : Promise.resolve(null),
      fetchCounts ? fetchListeningCounts(liveUser) : Promise.resolve(null),
      // 先週(prev)も rolling で再取得し、表示しっぱなしでの先週比の陳腐化を防ぐ(SVC-2)
      fetchCounts ? fetchPrevWeekScrobbleCount(liveUser) : Promise.resolve(null),
    ]);
    // fetch 中の「ライブ停止 / 次 tick 開始(順序逆転防止) / ユーザ切替」は反映しない
    if (isLiveStale()) return;

    // ★ セクション全体のクローンではなく「変更フィールドのみのパッチ」を作り、
    //   commit 直前に最新 state とマージする。クローン方式だと await の間に
    //   並行 commit された dna/quickCards/trend 等を古い値で巻き戻してしまう。
    //   さらに各フィールドは「内容が前回と変化したときだけ」patch に載せ、無変化 tick で
    //   dashboard 参照が入れ替わり全 DOM が再構築されるのを防ぐ(無駄描画の抑制)。
    const patch = {};
    const cur = state.sections.dashboard || {};
    if (recentRes.status === "fulfilled" && recentRes.value) {
      const nextRecent = recentRes.value.map(simplifyRecent);
      // 曲順/アーティスト/相対時刻(when)/再生中フラグ/画像が前回と完全一致なら patch しない。
      //   when は同日曲で分単位に変わるため、その更新は正当な再描画として通す。
      const prevRecent = cur.recent || [];
      const recentChanged =
        nextRecent.length !== prevRecent.length ||
        nextRecent.some((t, i) => {
          const p = prevRecent[i];
          return !p || p.name !== t.name || p.artist !== t.artist ||
                 p.when !== t.when || p.nowPlaying !== t.nowPlaying || p.image !== t.image;
        });
      if (recentChanged) patch.recent = nextRecent;
      // Now Playing の世界統計を曲の変化時のみ追従させる(patch.recent の有無とは独立に判定)。
      // cached() 経由 (同日同曲は通信なし) なので 30 秒ポーリングに乗せても安全。
      const npRaw = recentRes.value.find((t) => t["@attr"] && t["@attr"].nowplaying === "true") || null;
      if (npRaw) {
        const npArtist = (npRaw.artist && (npRaw.artist["#text"] || npRaw.artist.name)) || "";
        const key = `${npArtist}::${npRaw.name || ""}`;
        if ((cur.nowPlayingKey || "") !== key) {
          patch.nowPlayingKey = key;
          patch.nowPlayingInfo = await fetchNowPlayingInfo(liveUser, npArtist, npRaw.name || "").catch(() => null);
          if (isLiveStale()) return; // info 取得中の停止/順序逆転/ユーザ切替を破棄
        }
      } else if (cur.nowPlayingKey) {
        // 再生が止まったらクリア
        patch.nowPlayingKey = "";
        patch.nowPlayingInfo = null;
      }
    }
    if (infoRes.status === "fulfilled" && infoRes.value) {
      const nextInfo = simplifyUserInfo(infoRes.value);
      // playcount 等が前回と変わらなければ再描画不要(無変化再描画の抑制)
      if (!cur.userInfo || JSON.stringify(cur.userInfo) !== JSON.stringify(nextInfo)) {
        patch.userInfo = nextInfo;
      }
    }
    if (countsRes.status === "fulfilled" && countsRes.value) {
      const nc = countsRes.value;
      const pc = cur.listeningCounts;
      // 一過性失敗で個別レンジが null のときは確定済みの良好値を据え置き、'—' への劣化を防ぐ
      //   (全 null=全失敗 tick は merged===pc になり patch されない)。特に week は、下の
      //   weekSummary 同期が wkCur=null 時に旧値を据え置くため、ここでも week=null では旧値を
      //   保ち「今週(直近7日)」カードと「今週 scrobbles」カードの乖離を防ぐ。
      const merged = pc ? {
        today: nc.today != null ? nc.today : pc.today,
        week:  nc.week  != null ? nc.week  : pc.week,
        month: nc.month != null ? nc.month : pc.month,
      } : nc;
      // today/week/month が前回と全一致なら listeningCounts は patch しない(無変化再描画の抑制)
      if (!pc || pc.today !== merged.today || pc.week !== merged.week || pc.month !== merged.month) {
        patch.listeningCounts = merged;
      }
      // 週サマリーの「今週 scrobbles」をリスニング数（直近7日）と同期させ、
      // ライブ更新中も 2 つのカードの「今週」が常に同じ値になるようにする。
      // cur が rolling 由来(curFromRolling)なら prev も rolling で最新化する。chart 由来の
      // weekSummary を rolling 値で上書きすると cur(rolling)と prev(chart)が混在して
      // 先週比が壊れるため、その混在は避ける。topName は週次集計由来のため据え置く(DC-2)。
      const ws = cur.weekSummary;
      const wkCur = nc.week;
      let nextWs = null;
      if (ws && wkCur != null && ws.curFromRolling) {
        // 既に cur が rolling 由来。prev も rolling で最新化(取得失敗時は据え置き)。
        const freshPrev = (prevRes.status === "fulfilled" && prevRes.value != null) ? prevRes.value : ws.prev;
        nextWs = { ...ws, ...buildWeekDelta(wkCur, freshPrev), topName: ws.topName, curFromRolling: true };
      } else if (ws && wkCur != null && !ws.curFromRolling &&
                 prevRes.status === "fulfilled" && prevRes.value != null) {
        // base が cur-week の一過性失敗で chart 合算へフォールバック(curFromRolling=false)して
        //   いても、ライブで cur(rolling)と prev(rolling)の両方が揃ったら両方とも rolling 定義へ
        //   昇格させる。cur だけ rolling / prev だけ chart の混在は起こさず、両方 rolling なら
        //   整合するので安全。「今週 scrobbles」と「今週(直近7日)」の 2 カードの乖離を解消する。
        nextWs = { ...ws, ...buildWeekDelta(wkCur, prevRes.value), topName: ws.topName, curFromRolling: true };
      }
      // cur/prev/diff/curFromRolling 等が変化したときだけ patch する(無変化再描画の抑制)
      if (nextWs && JSON.stringify(ws) !== JSON.stringify(nextWs)) {
        patch.weekSummary = nextWs;
      }
    }
    if (Object.keys(patch).length > 0) {
      // commit 直前に最新の dashboard をベースにマージ (並行 commit を巻き戻さない)
      updateSection("dashboard", { ...(state.sections.dashboard || {}), ...patch });
    }
  } catch (e) {
    // 一過性なので失敗は無視（次回再試行）
    console.warn("[stats-service] live update failed", e);
  } finally {
    liveBusy = false;
  }
}

/**
 * 「読取専用」でも live update を始められるよう、user を外部から指定して
 * 開始できる版（statsService.startIfNeeded() がまだ完了していない場合に使う）。
 */
export function setUserAndStartLive(user) {
  if (user && state.user !== user) {
    state = { ...state, user };
  }
  startDashboardLiveUpdates();
}

/* ============ 内部実装 ============ */

function notify() {
  for (const cb of subscribers) {
    try { cb(state); } catch (e) { console.warn("[stats-service] subscriber error", e); }
  }
}

/**
 * パッチに「進捗らしい変化」が含まれているか判定。
 *   - workerProgress / sectionReady / sections / progress.current の変化を
 *     進捗とみなす。ステータスや activity 文字列だけの変化は進捗としない
 *     (スタック中も activity だけは更新される可能性があるため)。
 */
function isProgressPatch(patch) {
  if (!patch) return false;
  if ("workerProgress" in patch) return true;
  if ("sectionReady" in patch) return true;
  if ("sections" in patch) return true;
  if ("progress" in patch) return true;
  return false;
}

function update(patch) {
  state = { ...state, ...patch };
  if (isProgressPatch(patch)) lastProgressAt = Date.now();
  notify();
}

function updateSection(key, value) {
  state = { ...state, sections: { ...state.sections, [key]: value } };
  lastProgressAt = Date.now();
  notify();
}

/**
 * visibility 変化を監視し、以下を実行:
 *   1. 進行中の取得が長時間進捗なし → 自動再起動
 *      iPhone でロック画面再生中等のバックグラウンドで fetch がハングし、
 *      フォアグラウンドに戻っても再開しないケースのリカバリ。
 *
 *      ※ visible になった「直後」に判定すると、バックグラウンド中の時間も
 *        含まれるので誤検出しやすい。一度 5 秒待って、それでも進捗が
 *        無ければスタックと判定する。
 *   2. 日付が変わっていれば自動再取得 (PWA を翌日に開いた場合の最新化)
 *
 * 起動時にも 1 度だけ登録
 */
function ensureVisibilityWatcher() {
  if (visibilityWatcherRegistered) return;
  visibilityWatcherRegistered = true;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.user) return;

    // 1. スタック中の取得を検知して再起動
    if (state.status === "fetching") {
      // stuckRestartPending が true のとき: 既に 5s タイマーが積まれているので
      // 重複してタイマーを追加しない。visibility が短期間に複数回 visible になった
      // 場合（ホーム/アプリ切替を素早く繰り返す等）に runFetch が二重起動する
      // バグを防ぐ。
      if (stuckRestartPending) return;
      stuckRestartPending = true;
      const beforeProgressAt = lastProgressAt;
      // 5秒待って、それでも lastProgressAt が更新されていない & まだ fetching
      // なら、バックグラウンドで fetch がハングしたまま戻ってこないと判断して
      // 強制再起動する。
      setTimeout(() => {
        stuckRestartPending = false;
        if (state.status !== "fetching") return;        // 既に done/error
        if (lastProgressAt > beforeProgressAt) return;  // 復帰後に進捗あり

        const elapsed = Date.now() - (lastProgressAt || fetchStartedAt || Date.now());
        console.warn(`[stats-service] 進捗停止を検知 (${Math.round(elapsed / 1000)}秒) → 自動再起動`);
        // 既存の in-flight task を放棄し、新しい runFetch を開始する。
        // runFetch 冒頭で runSeq がインクリメントされるため、旧 run のタスクは
        // isStaleRun(自分のrunId) により commit/保存/進捗更新がすべて no-op 化
        // されて静かに消滅する (abortFlag は即リセットされるので頼らない)。
        abortFlag = true;
        try { if (worker) { worker.terminate(); worker = null; } } catch {}
        runFetch(state.user, { forceRefresh: false, silent: true }).catch((e) =>
          console.warn("[stats-service] スタック復旧失敗", e)
        );
      }, 5000);
      return;
    }

    // 2. JST 日付変更検知 → 自動再取得
    const today = getJSTDateString();
    if (state.fetchDate && state.fetchDate < today) {
      // 自動再取得トリガを通知レベルのログとして残す (デバッグ目的のみ。
      // 本番でも問題のない情報なので warn 相当として扱う)
      console.warn("[stats-service] JST 日付変更を検知、自動再取得を開始");
      runFetch(state.user, { forceRefresh: true, silent: true }).catch((e) =>
        console.warn("[stats-service] 自動再取得失敗", e)
      );
    } else if (state.status === "done" && !lastRunComplete) {
      // 3. 同日で未完了(complete:false)のまま done になった run を、フォアグラウンド復帰時に再取得して
      //    完遂させる(中断→リトライ。日付跨ぎ(2)と異なり同日でも未完なら回復させる)。retryIfIncomplete が
      //    user/status/lastRunComplete を再チェックし、二重起動は runFetch 冒頭の runSeq 世代ガードで吸収。
      retryIfIncomplete();
    }
  });

  // ★ visibilitychange に依存しない日付ロールオーバ検知。
  //   アプリを前面に出したまま(背面化せず)JST 0:00 を跨ぐと visibilitychange が
  //   発火せず、上記(2)の日次再取得が起動しない(統計本体が前日値で固定される)。
  //   ライブ更新タイマーの生死・現在タブにも依存しないよう、独立した低頻度
  //   インターバルで毎分 fetchDate を再評価し、別日になっていれば再取得する。
  //   二重起動は status!=="fetching" ガードと runFetch 冒頭の runSeq 世代ガードで吸収。
  setInterval(() => {
    if (!state.user) return;
    if (state.status === "fetching") return;
    if (state.fetchDate && state.fetchDate < getJSTDateString()) {
      console.warn("[stats-service] JST 日付変更を検知(定期チェック)、自動再取得を開始");
      runFetch(state.user, { forceRefresh: true, silent: true }).catch((e) =>
        console.warn("[stats-service] 定期チェックの自動再取得失敗", e)
      );
    }
  }, 60000);
}

/**
 * メイン取得関数
 *   - 各セクションを並列に取得
 *   - 各セクション完了時に sectionReady[name] = true をセット
 *   - 各セクション完了時にも IndexedDB へ逐次保存（PWA 早期終了対策、仕様3）
 *   - 全完了時に IndexedDB へ最終保存（次回起動の高速表示用、仕様4）
 *
 * ダッシュボードの ready 判定はモードによって異なる:
 *   - 非 bufferedMode（初回ロード）: fetchDashboardBase 完了で即 ready
 *     （仕様1: ダッシュボード最優先。DNA/quickCards は後から差し込まれる）
 *   - bufferedMode（旧データ表示中）: fetchDashboardBase + fetchTimeAndExtras
 *     両方完了で ready（仕様2: 全揃ってからの瞬時切替）
 */
async function runFetch(user, { forceRefresh, silent = false }) {
  abortFlag = false;
  // ★ run 世代を進める。これ以前に走っていた旧 run のタスクは
  //   isStaleRun(自分のrunId) が true になり、以降の commit / 保存 / 進捗更新を
  //   すべて no-op 化して静かに消滅する (abortFlag リセットの抜け穴を塞ぐ)。
  const myRun = ++runSeq;
  // この run の dashboard 再構築開始を宣言(fetchDashboardBase 完了で false に戻す)。
  dashboardRebuilding = true;
  // この run は未完了として開始する(完遂時に runComplete で true 化)。フォアグラウンド再訪/復帰の
  //   自動リトライ(retryIfIncomplete)が「同セッション内でも未完了なら再取得」を判定するのに使う。
  lastRunComplete = false;
  // bufferedMode のダッシュボード atomic swap バリアを run ごとにリセット。
  _bufDashCore = null;
  _bufDashExtras = null;
  _bufDashCoreDone = false;
  _bufDashExtrasDone = false;
  _bufDashCommitted = false;
  const today = getJSTDateString();
  // スタック検知用タイムスタンプ初期化
  fetchStartedAt = Date.now();
  lastProgressAt = Date.now();
  // 「全期間トップ1000アーティスト」の共有 Promise をリセット
  // (genre / world の両タスクが同じデータを使うため、二重取得を防ぐ)
  _allArtistsPromise = null;
  // 期限切れキャッシュの刈り込み (fire-and-forget。コンテンツキー型の肥大防止)
  pruneCache().catch(() => {});

  // ★ ダブルバッファ判定:
  //   既に表示可能なデータが揃っている (前回ロード成功済み) なら、リフレッシュ中も
  //   古いデータを表示し続けて、新データが揃ったタブから「瞬時に切替」する。
  //   sections.dashboard が存在し sectionReady.dashboard が true なら判定 OK。
  const bufferedMode = !!state.sections.dashboard && state.sectionReady?.dashboard === true;
  // abort 時に元の表示状態を復元できるよう、入る前のスナップショットを保存
  const prevSections = bufferedMode ? state.sections : null;
  const prevSectionReady = bufferedMode ? state.sectionReady : null;

  if (bufferedMode) {
    // バッファモード: sections / sectionReady を維持。status・進捗だけ更新する。
    // UI 側は sectionReady=true なので古いデータを描画し続ける。
    // 各タスクが完了するとそのセクションだけ updateSection で原子的に新データに置換され、
    // UI が瞬時に切り替わる (タブ単位の atomic swap)。
    update({
      status: "fetching",
      user,
      fetchDate: today,
      activity: "更新中…",
      progress: { current: 0, total: TOTAL_TASKS },
      workerProgress: { page: 0, totalPages: 0 },
      error: null,
    });
  } else {
    // 初回ロード: 通常通りリセットして loading 画面を表示
    update({
      ...makeInitialState(),
      status: "fetching",
      user,
      fetchDate: today,
      activity: "統計データを取得中…",
      progress: { current: 0, total: TOTAL_TASKS },
      workerProgress: { page: 0, totalPages: 0 },
      error: null,
      sections: emptySections(),
      sectionReady: emptySectionReady(),
    });
  }

  let completed = 0;
  const advanceProgress = (label) => {
    if (myRun !== runSeq) return; // 旧 run の進捗は新 run の表示を汚さない
    completed++;
    update({
      progress: { current: completed, total: TOTAL_TASKS },
      activity: completed >= TOTAL_TASKS ? "完了処理中…" : (label || "集計中…"),
    });
  };

  // sectionReady を 1 項目だけ更新するヘルパ (バッファモード時の無駄通知を避ける)
  const markReady = (name) => {
    if (myRun !== runSeq) return; // 旧 run は no-op
    if (state.sectionReady?.[name]) return; // 既に ready ならスキップ
    update({ sectionReady: { ...state.sectionReady, [name]: true } });
  };

  // ★ セクション完了時のヘルパ（仕様3: PWA 早期終了対策）
  //   - markReady でタブを表示可能にし
  //   - 非 bufferedMode（初回ロード）時のみ saveCurrent で逐次永続化
  //
  //   bufferedMode 時に逐次保存しない理由:
  //     bufferedMode は「前日（旧）データが既に IDB に保存済み」の状態で開始する。
  //     途中保存すると「新しいセクション + 旧いセクション」が混在した状態で
  //     fetchDate=今日 として保存されてしまう。次回起動時に
  //     loadCurrent → 今日付・全セクション非 null → isAllSectionsPopulated=true
  //     と誤判定されて再取得がスキップされ、混在データが表示され続けるバグになる。
  //     bufferedMode の最終保存は全タスク完了後 (runFetch 末尾) で一括して行う。
  //     bufferedMode 中に PWA を終了した場合は、IDB の前日データがそのまま残るので
  //     仕様4（再起動時の瞬時表示）は満たされ、次回起動で「別日」判定 → 再取得 →
  //     仕様3（取得・集計中の PWA 終了に対する再取得）も満たされる。
  //
  //   並列タスクから個別に呼ばれるが、IndexedDB の transaction は逐次処理されるため
  //   競合なく安全に書き込める。state.sections は単一スレッドで読まれるので
  //   読み出し時点での最新状態が保存される。
  const finalizeSection = (name) => {
    if (myRun !== runSeq) return; // 旧 run の保存・ready 化を防ぐ (世代ガード)
    markReady(name);
    if (bufferedMode) return;  // 混在データ防止のため bufferedMode 中はスキップ
    if (!abortFlag && state.sections[name] != null) {
      // 途中保存は complete:false(まだ全セクション未完)。最終 saveCurrent が
      // 完了時に complete:runComplete で上書きする。途中で PWA 終了時は未完扱いで再取得。
      saveCurrent({ user, fetchDate: today, sections: state.sections, complete: false })
        .catch((e) => console.warn(`[stats-service] ${name} 完了後保存失敗`, e));
    }
  };

  // ダッシュボードは 2 つのタスクから構成される。モードに応じて ready 判定を切替。
  //   - 非 bufferedMode（初回ロード）: 基本完了で即 ready（仕様1: 最優先表示）
  //     DNA/quickCards は後から fetchTimeAndExtras が埋める。renderDashboard 側は
  //     loading=true 時に null をスケルトン表示するので段階表示として自然。
  //   - bufferedMode（旧データ表示中）: 両方完了で ready（仕様2: 瞬時切替）
  //     旧データが見えているので焦って部分切替する必要はない。
  let dashboardBaseDone = false;
  let dashboardExtrasDone = false;
  const markDashboardIfReady = () => {
    if (bufferedMode) {
      if (dashboardBaseDone && dashboardExtrasDone) markReady("dashboard");
    } else {
      if (dashboardBaseDone) markReady("dashboard");
    }
  };

  // 各セクションは並列実行（Promise.allSettled で個別失敗を許容）。
  // finally で sectionReady を更新するので、失敗時も「準備完了」扱いになり
  // UI は「データなし」ではなく取得結果（あれば部分データ）を表示する。
  //
  // ★ ダッシュボード優先表示:
  //   onCoreReady は fetchDashboardBase が「コア(プロフィール/最近/リスニング数)」を
  //   先行 publish した時点で呼ばれる。ここで dashboard を ready 化し、コア確定を待って
  //   から残りの重いセクションを起動する。これにより初回ロード時、ダッシュボードのコア
  //   取得が他セクションと callGet のレート制御(5 req/s トークンバケット)を奪い合わずに
  //   最速で完了し、ダッシュボードが真っ先に表示される。残りはコア表示後に進む。
  let resolveCore;
  const coreReady = new Promise((r) => { resolveCore = r; });
  const onCoreReady = () => {
    if (myRun !== runSeq) return;
    dashboardBaseDone = true;
    // コア確定 → ライブ更新を解禁。
    dashboardRebuilding = false;
    markDashboardIfReady();
    // ★ コア確定時点で早期保存（仕様3 + 仕様4）。後続の fetchTimeAndExtras（Worker
    //   全ページ集計、最も時間がかかる処理）が完了する前に PWA を終了しても、次回起動時に
    //   ダッシュボードをバッファとして即表示できる。bufferedMode 中は混在データ問題の
    //   ため保存をスキップする(finalizeSection の comment 参照)。
    if (!bufferedMode && !abortFlag && state.sections.dashboard != null) {
      saveCurrent({ user, fetchDate: today, sections: state.sections, complete: false })
        .catch((e) => console.warn("[stats-service] ダッシュボードコア保存失敗", e));
    }
    resolveCore();
  };

  const dashTask = fetchDashboardBase(user, { forceRefresh, runId: myRun, bufferedMode, onCoreReady })
    .finally(() => {
      // フォールバック: onCoreReady が呼ばれなかった異常時(Promise.all 後の stale return 等)
      //   でも ready 化・据え置き解禁・コア待ち解除を保証する。
      dashboardBaseDone = true;
      if (myRun === runSeq) dashboardRebuilding = false;
      markDashboardIfReady();
      resolveCore();
      advanceProgress("ダッシュボード基本完了");
      // bufferedMode atomic swap: base が(stale/異常で)コアを預けられなかった場合もバリアを前進させ、
      //   extras 側だけで commit できずダッシュボードが前日データのまま固定されるのを防ぐ(_bufDashCore は
      //   null のまま → tryCommit が現状=前日を土台に extras を合成。complete:false で同日再取得し回復)。
      if (bufferedMode && myRun === runSeq && !_bufDashCoreDone) {
        _bufDashCoreDone = true;
        tryCommitBufferedDashboard(myRun);
      }
    });

  // ★ 初回ロードのみ、コア確定(または dashboardBase 終了)まで待ってから残りを起動する。
  //   bufferedMode は旧データ表示中で待つ必要がないため、従来どおり全タスク並列で起動して
  //   全体のリフレッシュを最速にする。
  if (!bufferedMode) {
    await Promise.race([coreReady, dashTask]);
  }

  // この run で時間反復・比較・振り返りが完全更新できたか(保存レコードの complete 判定に使う)。
  // 失敗を握りつぶして resolve するセクション(time の反復中断 / compare の範囲失敗 /
  // rewind の bufferedMode 失敗)は Promise.allSettled の rejected に出ないため、戻り値で
  // 個別に完了可否を受け取る。
  let timeComplete = true;
  let compareComplete = true;
  let rewindComplete = true;
  let lovedComplete = true;
  let worldComplete = true;
  let genreComplete = true;
  let topComplete = true;
  // 最終 saveCurrent 済みフラグ。fetchTop の遅延バッジ保存(fire-and-forget)が最終保存より
  // 後に着地して complete:true を complete:false に降格させる競合を防ぐ(最終保存後は抑止)。
  let finalSaved = false;

  const restTasks = [
    fetchTimeAndExtras(user, { forceRefresh, bufferedMode, runId: myRun })
      // reject(Worker 生成失敗等)時も timeComplete=false に落とす。さもないと当日 quickCards が
      //   前日値のまま saveHistory に渡り 30日トレンドを汚染する。reject は re-throw して results に
      //   伝播させ、runComplete / error 判定を従来どおり保つ。
      .then((r) => { if (r && r.complete === false) timeComplete = false; return r; },
            (e) => { timeComplete = false; throw e; })
      .finally(() => {
        dashboardExtrasDone = true;
        markDashboardIfReady();
        // bufferedMode atomic swap: fetchTimeAndExtras が Worker 生成 throw 等で関数末尾の extras-done
        //   フォールバックに到達できず終了しても、ここ(.finally は throw/正常/早期 return の全経路で必ず実行)で
        //   MODULE バリアを前進させ、base 側だけで commit できずダッシュボードが前日データのまま固定するのを防ぐ
        //   (base 側 dashTask.finally の _bufDashCoreDone フォールバックと対称)。_bufDashExtras 未設定時は null の
        //   まま → tryCommit が core 引き継ぎの前日 dna/quickCards を使う(complete:false で同日再取得し回復)。
        //   関数末尾のフォールバックと二重だが _bufDashExtrasDone ガードで commit は一度きり。
        if (bufferedMode && myRun === runSeq && !_bufDashExtrasDone) {
          _bufDashExtrasDone = true;
          tryCommitBufferedDashboard(myRun);
        }
        // 時間タブの完了 (+ ダッシュボード DNA/quickCards 完了を含む sections を保存)
        finalizeSection("time");
        advanceProgress("時間集計完了");
      }),
    fetchTop(user, { forceRefresh, runId: myRun, bufferedMode, today, isFinalized: () => finalSaved, onReady: () => markReady("top") })
      .then((r) => { if (r && r.complete === false) topComplete = false; return r; })
      .finally(() => {
        finalizeSection("top");
        advanceProgress("トップチャート完了");
      }),
    fetchCompare(user, { forceRefresh, runId: myRun, bufferedMode, onReady: () => markReady("compare") })
      .then((r) => { if (r && r.complete === false) compareComplete = false; return r; })
      .finally(() => {
        finalizeSection("compare");
        advanceProgress("比較データ完了");
      }),
    fetchRewind(user, { forceRefresh, runId: myRun, bufferedMode, onReady: () => markReady("rewind") })
      .then((r) => { if (r && r.complete === false) rewindComplete = false; return r; })
      .finally(() => {
        finalizeSection("rewind");
        advanceProgress("振り返り完了");
      }),
    fetchLoved(user, { forceRefresh, runId: myRun, bufferedMode, onReady: () => markReady("loved") })
      .then((r) => { if (r && r.complete === false) lovedComplete = false; return r; })
      .finally(() => {
        finalizeSection("loved");
        advanceProgress("Loved 完了");
      }),
    fetchGenre(user, { forceRefresh, runId: myRun, bufferedMode, onReady: () => markReady("genre") })
      .then((r) => { if (r && r.complete === false) genreComplete = false; return r; })
      .finally(() => {
        finalizeSection("genre");
        advanceProgress("ジャンル分析完了");
      }),
    fetchWorld(user, { forceRefresh, runId: myRun, bufferedMode, onReady: () => markReady("world") })
      .then((r) => { if (r && r.complete === false) worldComplete = false; return r; })
      .finally(() => {
        finalizeSection("world");
        advanceProgress("世界チャート照合完了");
      }),
  ];

  // dashTask を含む全 8 タスクの完了を待つ(TOTAL_TASKS=8 と一致)。
  const results = await Promise.allSettled([dashTask, ...restTasks]);

  // ★ 新しい run が開始されていたら、この run の完了処理(done 化・保存・トースト)は
  //   一切行わない。state は新 run が管理している。
  if (myRun !== runSeq) return;

  if (abortFlag) {
    if (bufferedMode) {
      // バッファモード中の中断 → 元の表示状態 (古いデータ) を復元
      update({
        status: "done",
        activity: "",
        sections: prevSections,
        sectionReady: prevSectionReady,
      });
    } else {
      update({
        status: "idle",
        activity: "",
        sectionReady: emptySectionReady(),
      });
    }
    return;
  }

  // エラー件数判定
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);

  if (errors.length === results.length) {
    update({
      status: "error",
      activity: "",
      error: (errors[0] && (errors[0].message || String(errors[0]))) || "取得失敗",
    });
    // エラー内容に応じてユーザにより具体的に通知する。
    // 永続的エラーは「設定を直してね」、それ以外は「ネットワーク不調かも」とする。
    const code6 = errors.find((e) => e && e.code === 6);
    const code10 = errors.find((e) => e && e.code === 10);
    const code26 = errors.find((e) => e && e.code === 26);
    // ★ 永続エラー(ユーザ名/APIキー不正等)は再取得しても回復しないため retry 対象外にする
    //   (lastRunComplete=true)。さもないと retryIfIncomplete が再マウント/オンライン復帰のたびに
    //   全8タスクのフル再取得を繰り返す(設定を直すまで無駄打ちが続く)。一過性の全障害(ネット全断等)は
    //   false のままにし、オンライン復帰/再マウントでの再取得で回復させる。
    const permanent = errors.some((e) => e && PERMANENT_LASTFM_ERROR_CODES.has(e.code));
    lastRunComplete = permanent;
    // エラートーストは silent(自動再取得 = 日付変更/スタック復旧/未完了リトライ)では出さない。
    //   ユーザ操作なしのトーストノイズを防ぐ(成功トーストの silent ガードと対称。SVC-4)。
    //   特に retryIfIncomplete の silent 再取得が一過性の全障害で繰り返し失敗してもトースト連発しない。
    if (!silent) {
      if (code6) {
        toast(`Last.fm にユーザー「${user}」が見つかりません。設定画面でユーザー名を確認してください。`, "err");
      } else if (code10) {
        toast("API キーが無効です。設定画面で確認してください。", "err");
      } else if (code26) {
        toast("API キーが Last.fm により停止されています。新しいキーを取得してください。", "err");
      } else {
        toast("統計データの取得に失敗しました（ネットワークまたは Last.fm 一時障害の可能性）", "err");
      }
    }
    return;
  }

  // 部分失敗があっても done にする（取れた分は表示する）
  update({
    status: "done",
    activity: "",
    lastCompletedAt: Date.now(),
  });

  // ★ この run が「全セクションを新データで完全に更新できたか」を判定する。
  //   未完了(セクション欠損 / タスク reject / 時間反復中断 / 比較範囲失敗 / 振り返り部分)の
  //   場合は complete:false で保存し、同日再起動時に startIfNeeded が再取得する。
  //   これにより、更新できなかったセクションの古い(前日)データが today 付き「完備」として
  //   固定され、翌日まで更新されない不具合(genre/world reject・time 中断 等)を防ぐ。
  const anyRejected = results.some((r) => r.status === "rejected");
  const runComplete =
    !abortFlag && !anyRejected && timeComplete && compareComplete && rewindComplete && lovedComplete &&
    worldComplete && genreComplete && topComplete && isAllSectionsPopulated(state.sections);
  // フォアグラウンド再訪/復帰の自動リトライ判定用に in-memory へ反映(保存レコードの complete と同値)。
  //   未完了(false)なら retryIfIncomplete が同セッション内でも再取得して完遂させる。
  lastRunComplete = runComplete;

  // IndexedDB に保存（次回起動高速化）
  // ★ finalSaved を先に立てる: fetchTop の遅延バッジ保存(fire-and-forget)が、この最終
  //   保存より後に complete:false で着地して complete を降格させる競合を抑止する。
  finalSaved = true;
  try {
    await saveCurrent({ user, fetchDate: today, sections: state.sections, complete: runComplete });
    // 日付別履歴（軽量サマリーのみ）。時間集計が未完了の run では quickCards/timeOfDay が
    // 前日値のままなので、その日の履歴サマリーを汚染しないよう保存をスキップする
    // (30日トレンドの当日値が前日と同値=0 に潰れるのを防ぐ)。
    // timeComplete は time の complete:false / reject の両方で false になる(上の time タスクの
    //   reject ハンドラ参照)。time 由来の quickCards/timeOfDay が当日値で確定したときだけ当日サマリーを
    //   保存し前日値での 30日トレンド汚染を防ぐ。他セクションの失敗は summary 入力に影響しないため
    //   当日点の保存を妨げない(anyRejected で一括スキップする過剰防御を避ける)。
    if (timeComplete) {
      await saveHistory(today, {
        user,
        summary: buildHistorySummary(state.sections),
      });
      await pruneHistory(30);
    }
  } catch (e) {
    console.warn("[stats-service] 永続化失敗", e);
  }

  // 完了トースト（提案C）。silent(visibilitychange 由来の自動再取得 = 日付変更/
  // スタック復旧)では出さない。ユーザ操作なしのトーストノイズを防ぐ(SVC-4)。
  if (!silent) {
    if (errors.length > 0) {
      toast(`📊 統計データの更新が完了しました（一部失敗: ${errors.length}件）`, "info");
    } else {
      toast("📊 統計データの更新が完了しました", "ok");
    }
  }
}

/**
 * 履歴用サマリー（最小限のメトリクスのみ）
 *   - 将来のトレンド分析・比較に使える
 */
function buildHistorySummary(sections) {
  return {
    totalScrobbles: sections.dashboard?.quickCards?.totalScrobbles || 0,
    streak: sections.dashboard?.quickCards?.streak || "",
    timeOfDay: sections.time?.snapshot?.timeOfDay || null,
    weekdayWeekend: sections.time?.snapshot?.weekdayWeekend || null,
  };
}

/**
 * Last.fm の「リトライしても回復しない」永続的エラーコード。
 *   6  = User not found / Invalid parameters
 *   10 = Invalid API key
 *   26 = Suspended API key
 *   その他: 2,3,4,5,7,9,13,14,17,18 も基本的に永続的
 *
 * ★ 8(Operation failed = backend 一時失敗。公式 errorcodes は「Please try again」)・11・16・29 は一過性のため
 *    含めない（指数バックオフ/レート待機で再試行する）。9(Invalid session key)は公式上は再試行可だが要再認証で
 *    自動リトライでは復旧しないため便宜上ここに含める（scrobble.js / stats.js と同方針）。
 *
 * 一過性エラーは指数バックオフ(maxAttempts=3 → 待機は 4秒・12秒 の計2回。最終試行後は待たず終了)で
 * リトライするが、永続エラーをそれで待つと、ユーザの入力ミス（ユーザー名スペルミス等）を 6 タスクぶん
 * 各 16 秒ずつ待つことになりとても遅いので、即座に break して上位に投げる。
 */
const PERMANENT_LASTFM_ERROR_CODES = new Set([2, 3, 4, 5, 6, 7, 9, 10, 13, 14, 17, 18, 26]);

/**
 * 指数バックオフ付きリトライ（提案D）
 *   - 永続的 Last.fm エラーはリトライせず即座に break
 */
async function withRetry(fn, { maxAttempts = 3, baseDelay = 4000, label = "" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortFlag) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // ユーザー名スペルミスなど永続的エラーはリトライしても無駄
      if (err && PERMANENT_LASTFM_ERROR_CODES.has(err.code)) break;
      if (attempt >= maxAttempts || abortFlag) break;
      // レート制限（Last.fm code 29 / HTTP 429）は通常の一時エラーより十分長く待つ。
      // また全リトライにジッタを加え、同時起動した複数セクションの再試行が一斉に
      // 発火して二次バーストを起こす（レート超過を悪化させる）のを防ぐ。
      const isRateLimit = !!(err && (err.code === 29 || err.httpStatus === 429));
      const delay = isRateLimit
        ? 30000 + Math.floor(Math.random() * 2000)        // レート制限: ~30s 固定 + ジッタ
        : baseDelay * Math.pow(3, attempt - 1) + Math.floor(Math.random() * 500); // 通常: 4s→12s + 小ジッタ
      console.warn(`[stats-service] ${label} attempt ${attempt}/${maxAttempts} failed; retrying in ${delay}ms`, err);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 配列要素を「直列 + 一定間隔」で処理する。
 *   Last.fm のレート制限(過剰呼び出し禁止)への配慮として、アーティスト単位・
 *   アルバム単位の連続 API 呼び出しは並列バーストにせず、gapMs を空けて
 *   1 件ずつ実行する。
 *   - runId 指定時は isStaleRun で世代チェック(旧 run・abort を即中断)
 *   - fn が 50ms 未満で完了した場合はキャッシュヒットとみなし gap を省略する
 *     (同日再実行時に「ヒットなのに合計数秒待つ」純粋待機を避ける)
 *   個別の失敗は fn 側で catch して握りつぶす想定(全体は止めない)。
 */
async function mapSequential(items, fn, gapMs = 150, runId = null) {
  const stale = () => (runId != null ? isStaleRun(runId) : abortFlag);
  for (let i = 0; i < items.length; i++) {
    if (stale()) return;
    const t0 = Date.now();
    await fn(items[i], i);
    const elapsed = Date.now() - t0;
    if (gapMs > 0 && elapsed >= 50 && i < items.length - 1) await sleep(gapMs);
  }
}

/**
 * アーティスト名/曲名の突合用正規化 (小文字化 + 前後空白除去)
 *   世界チャート・タグ別チャートと自分の聴取履歴を突き合わせる際の
 *   表記ゆれ(大文字小文字)対策。
 */
function normName(s) {
  return String(s || "").toLowerCase().trim();
}

/**
 * 「全期間トップ1000アーティスト」を1回だけ取得して共有する。
 *   genre(踏破率) と world(メインストリーム度/国別照合) の両方が同じデータを
 *   使うため、モジュールスコープの Promise を共有して二重取得を防ぐ。
 *   runFetch 開始時に _allArtistsPromise = null でリセットされる。
 *
 *   ★ 失敗はここで握りつぶさず呼び出し元へ伝播させる。
 *     以前は .catch(() => []) で空配列に化けていたため、一時的なネットワーク
 *     障害でも fetchWorld が「メインストリーム度 0% = 完全に独自」という
 *     もっともらしい誤診断を当日データとして確定保存してしまった。
 *     失敗時は fetchGenre/fetchWorld ごと reject させ、セクションを null のまま
 *     残す(= 次回起動時に部分再取得される。loved/rewind と同じフロー)。
 */
let _allArtistsPromise = null;
function getAllArtistsOnce(user, forceRefresh) {
  if (!_allArtistsPromise) {
    _allArtistsPromise = withRetry(
      () => cached(`top-artists:${user}:overall:1000`, () => getTopArtists(user, "overall", 1000), { forceRefresh }),
      { label: "all-artists", maxAttempts: 2 }
    );
    // 共有 Promise の unhandled rejection 警告を抑止 (各呼び出し元が個別に await して処理する)
    _allArtistsPromise.catch(() => {});
  }
  return _allArtistsPromise;
}

/* ============ 各セクション取得（表示用に最小化） ============ */

/**
 * 直近 24時間 / 7日 / 30日 の scrobble 件数を並列に取得する。
 *   - キャッシュしない (時間に応じて変化するため毎回フレッシュに取得)
 *   - 個別失敗時は null を返す
 */
async function fetchListeningCounts(user) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const DAY = 24 * 60 * 60;
  const ranges = {
    today: { from: nowUnix - DAY,        to: nowUnix },
    week:  { from: nowUnix - 7 * DAY,    to: nowUnix },
    month: { from: nowUnix - 30 * DAY,   to: nowUnix },
  };
  const counts = { today: null, week: null, month: null };
  await Promise.all(Object.entries(ranges).map(async ([key, range]) => {
    try {
      counts[key] = await withRetry(
        () => getRecentTracksCount(user, range),
        { label: `listening-count-${key}`, maxAttempts: 2 }
      );
    } catch (e) {
      counts[key] = null;
    }
  }));
  return counts;
}

// 1 週間(秒)。週窓の定義をこの 1 か所に集約する(DRY)。
const WEEK_SEC = 7 * 24 * 60 * 60;

/**
 * 「その前の 7 日間」([now-14d, now-7d]) の scrobble 総数を取得する(失敗時 null)。
 *   - 週サマリー・比較タブ・fetchWeekScrobbleTotals で prev の定義を共有し、
 *     7 日窓を将来変えるときに 1 か所だけ直せばよいようにする。
 *   - 厳密に now から遡る区間なのでタイムゾーンに依存しない。
 */
async function fetchPrevWeekScrobbleCount(user) {
  const nowUnix = Math.floor(Date.now() / 1000);
  // fetchListeningCounts と同じ信頼性(withRetry maxAttempts:2)に揃える。
  // 一過性のネットワーク失敗で先週比が出ない頻度を下げる。
  return withRetry(
    () => getRecentTracksCount(user, { from: nowUnix - 2 * WEEK_SEC, to: nowUnix - WEEK_SEC }),
    { label: "prev-week-count", maxAttempts: 2 }
  ).catch(() => null);
}

/**
 * 「直近7日」と「その前の7日」の scrobble 総数を取得する。
 *   - 比較タブの「今週/先週」数値を、ダッシュボードのリスニング数「今週（直近7日）」
 *     と完全に同じ定義（getRecentTracksCount ベース）に揃えるために使う。
 *   - buildComparison（Last.fm 週次チャート合算）は rolling 7 日窓が固定週境界を
 *     またぐため最大 ~2 週間分に膨らみ、リスニング数と食い違う。これを避ける。
 *   - 個別失敗時は該当値を null で返す。
 * @returns {Promise<{cur:number|null, prev:number|null}>}
 */
async function fetchWeekScrobbleTotals(user) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const [cur, prev] = await Promise.all([
    // prev(fetchPrevWeekScrobbleCount)と同じ信頼性(withRetry maxAttempts:2)に揃える。
    // cur だけリトライ無しだと cur 失敗(→週次チャート合算へフォールバック)の確率が高く、
    // 「今週」がリスニング数カードと食い違う頻度が上がるため(cur/prev の片側失敗=定義混在)。
    withRetry(
      () => getRecentTracksCount(user, { from: nowUnix - WEEK_SEC, to: nowUnix }),
      { label: "cur-week-count", maxAttempts: 2 }
    ).catch(() => null),
    fetchPrevWeekScrobbleCount(user),
  ]);
  return { cur, prev };
}

/**
 * 今週 scrobble 数(cur)と先週(prev)から表示用の差分情報を組み立てる。
 *   - prev が null(取得失敗等)のときは先週比を出さない(diff=null, hasPrev=false)。
 *     cur(直近7日)はリスニング数カードと一致したまま表示し、比較だけ省く。
 *   - cur/prev とも数値のときのみ diff/pct/arrow を計算する(0 除算回避)。
 * @returns {{cur:number, prev:(number|null), diff:(number|null), sign:string, pct:(number|null), arrow:string, hasPrev:boolean}}
 */
function buildWeekDelta(cur, prev) {
  const hasPrev = prev != null;
  const diff = hasPrev ? cur - prev : null;
  const sign = hasPrev && diff > 0 ? "+" : "";
  const pct = hasPrev && prev > 0 ? Math.round((diff / prev) * 100) : null;
  const arrow = !hasPrev ? "—" : diff > 0 ? "📈" : diff < 0 ? "📉" : "➖";
  return { cur, prev, diff, sign, pct, arrow, hasPrev };
}

/**
 * ダッシュボードの基本データ：ユーザ情報・最近・週サマリー・リスニング数
 *   - DNA / クイックカードは Worker 集計（fetchTimeAndExtras）側で順次埋める
 */
async function fetchDashboardBase(user, { forceRefresh, runId, bufferedMode, onCoreReady }) {
  const [info, recent, listeningCounts, friends, trend, prevWeekCount] = await Promise.all([
    withRetry(
      () => cached(`user-info:${user}`, () => getUserInfo(user), { forceRefresh }),
      { label: "userInfo" }
    ).catch(() => null),
    withRetry(
      () => cached(`recent:${user}:20`, () => getRecentTracks(user, { limit: 20 }), { forceRefresh }),
      { label: "recent" }
    ).catch(() => []),
    fetchListeningCounts(user).catch(() => null),
    // フレンドフィード (フレンド 0 人やエラー時は null → カード非表示)
    withRetry(
      () => cached(`friends:${user}:20`, () => getFriends(user, { recenttracks: true, limit: 20 }), { forceRefresh }),
      { label: "friends", maxAttempts: 2 }
    ).then((list) => (list || []).map(simplifyFriend)).catch(() => null),
    // 30日トレンド (IndexedDB の日次履歴のみ。API 呼び出しなし)。
    // ユーザ切替で別ユーザの履歴が混ざらないよう user でフィルタする。
    buildTrendFromHistory(user).catch(() => null),
    // 週サマリーの「先週(その前7日)」。listeningCounts(=今週 cur)と同じ Promise.all で
    //   取得し、両者の現在時刻基準を揃える。別 await にすると buildComparison の所要時間ぶん
    //   cur/prev の窓基準がズレ、約7日前境界の scrobble が両窓から漏れて先週比が微妙に
    //   狂うため。fetchPrevWeekScrobbleCount は内部で失敗時 null を返す。
    fetchPrevWeekScrobbleCount(user),
  ]);
  if (isStaleRun(runId)) return;

  // ダッシュボードの表示用オブジェクトを組み立てるヘルパ。nowPlayingInfo/dna/quickCards は
  // ライブ更新や fetchTimeAndExtras が埋めるため、呼び出し時点の現在値を引き継ぐ。
  const buildDashboard = (ws) => {
    const prev = state.sections.dashboard || {};
    return {
      userInfo: info ? simplifyUserInfo(info) : null,
      recent: (recent || []).map(simplifyRecent),
      weekSummary: ws,
      listeningCounts,
      friends,
      trend,
      // Now Playing 世界統計はライブ更新が管理する。ここでは前回値を据え置く
      // (キャッシュ recent から古い「再生中」を復活させない)。
      nowPlayingInfo: prev.nowPlayingInfo || null,
      nowPlayingKey: prev.nowPlayingKey || "",
      // dna / quickCards は Worker 集計(fetchTimeAndExtras)が完了次第このセクションを再更新する
      dna: prev.dna || null,
      quickCards: prev.quickCards || null,
    };
  };

  // ★ 初回ロード(非 bufferedMode)では、プロフィール/最近/リスニング数などのコアを、
  //   重い週サマリー(weekSummary=buildComparison。週次チャートを複数取得)を待たずに
  //   先行 publish して即表示する(優先表示)。weekSummary/DNA/quickCards は status が
  //   "fetching" の間スケルトン表示され、揃い次第このセクションへ差し込まれる。
  //   onCoreReady で runFetch にコア確定を通知し、ダッシュボードの ready 化と
  //   残りセクションの起動トリガにする。
  //   bufferedMode(旧データ表示中)は仕様2の atomic swap を保つため先行表示せず、
  //   週サマリーも揃えてから末尾で一度に置換する。
  if (!bufferedMode) {
    updateSection("dashboard", buildDashboard((state.sections.dashboard || {}).weekSummary || null));
    if (onCoreReady) { try { onCoreReady(); } catch {} }
  }

  // ★ Now Playing の検知と世界統計 (nowPlayingInfo/nowPlayingKey) はここでは扱わない。
  //   recent は1日キャッシュされるため、同日の再実行(部分再取得・スタック復旧)で
  //   数時間前の「再生中」が復活してしまう。Now Playing はキャッシュ非経由の
  //   ライブ更新 (doDashboardLiveUpdate) に一本化し、ここでは前回値を引き継ぐだけにする。

  let weekSummary = null;
  // 週次チャート(topName 取得元)は単独で一過性失敗しうる。await を独立させ失敗時は c=null とし、
  //   rolling cur/prev が揃っていれば topName='—' で weekSummary を組む。chart 失敗に
  //   巻き込まれてカード全体を欠落(weekSummary=null)させない。ライブ更新は ws が truthy で
  //   ないと同期/昇格できないため、null commit は base 再構築まで自己治癒しないため。
  let c = null;
  try {
    c = await withRetry(
      () => buildComparison(user, "week", "artist", { limit: 5, forceRefresh }),
      { label: "weekSummary" }
    );
  } catch {}
  {
    // 「今週 scrobbles」はリスニング数カードの「今週（直近7日）」と必ず一致させる
    // (ユーザの主訴)。cur は取得済みの listeningCounts.week を再利用し同一値を保証する。
    // prev は冒頭 Promise.all で listeningCounts(cur)と同一基準で取得済み。ここで再取得すると
    //   buildComparison の所要時間ぶん cur/prev の時刻基準がズレるため、取得済みの値を使う。
    let cur = listeningCounts?.week ?? null;
    let prev = prevWeekCount;
    // cur が rolling 由来か(=リスニング数カードと一致する値か)を記録する。
    // ライブ更新側はこのフラグが true のときだけ cur を同期し、chart 由来の
    // weekSummary を rolling 値で上書きして cur/prev の定義が混在するのを防ぐ。
    let curFromRolling = cur != null;
    // cur(直近7日)が取れず、かつ週次チャートが取れたときだけ chart 合算へフォールバックする
    // (このとき cur/prev とも chart 由来になり内部整合する)。
    // ★ prev だけ失敗しても cur(rolling)は維持する(リスニング数カードとの一致を最優先)。
    //   prev が null のままなら buildWeekDelta が先週比を省略する。
    if (cur == null && c) {
      cur = c.current.total;
      prev = c.previous.total;
      curFromRolling = false;
    }
    // cur が取れたときだけ weekSummary を組む。rolling cur があれば chart 失敗でも組める
    //   (topName は週次チャート由来なので chart 失敗時は '—'。次の base 再構築で復活)。
    if (cur != null) {
      const topName = c?.current?.items?.[0]?.name || "—";
      weekSummary = { ...buildWeekDelta(cur, prev), topName, curFromRolling };
    }
  }

  if (isStaleRun(runId)) return;
  if (!bufferedMode) {
    // 初回ロード: 既に publish 済みのコアへ週サマリーだけを差し込む。コアや、並行する
    // fetchTimeAndExtras が埋めた dna/quickCards は現在値(state.sections.dashboard)を
    // spread して保持する(置換で巻き戻さない)。
    updateSection("dashboard", { ...(state.sections.dashboard || {}), weekSummary });
  } else {
    // bufferedMode: コアを即 commit せず atomic swap バリアに預ける。extras(DNA/quickCards)と揃ってから
    //   一度だけ反映することで、「今日のコア + 前日 extras」の混在表示(Worker 完了まで継続)を防ぐ(仕様2)。
    //   buildDashboard は dna/quickCards に前日値を入れるが、tryCommit が extras 成功時は今日値で上書きする。
    _bufDashCore = buildDashboard(weekSummary);
    _bufDashCoreDone = true;
    tryCommitBufferedDashboard(runId);
    if (onCoreReady) { try { onCoreReady(); } catch {} }
  }
}

/**
 * フレンド情報を表示用に最小化
 */
function simplifyFriend(f) {
  // recenttracks=1 のとき f.recenttrack に最後に聴いた(または再生中の)曲が入る
  const rt = f.recenttrack || null;
  return {
    name: f.name || "",
    realname: f.realname || "",
    image: pickImage(f.image),
    url: f.url || "",
    track: rt ? {
      name: rt.name || "",
      artist: (rt.artist && (rt.artist.name || rt.artist["#text"])) || "",
    } : null,
  };
}

/**
 * Now Playing 中の曲の世界統計 (track.getInfo) を取得して最小化。
 *   cached() 経由なので同日・同曲の再取得は通信なし。失敗時 null。
 */
async function fetchNowPlayingInfo(user, artist, track) {
  if (!artist || !track) return null;
  const info = await cached(
    ckey("trackinfo", artist, track, user),
    () => getTrackInfo(artist, track, user)
  ).catch(() => null);
  if (!info) return null;
  return {
    listeners: parseInt(info.listeners || "0", 10),
    playcount: parseInt(info.playcount || "0", 10),
    userplaycount: info.userplaycount != null ? parseInt(info.userplaycount, 10) : null,
    loved: info.userloved === "1",
    durationMs: parseInt(info.duration || "0", 10),
    tags: (() => {
      const t = info.toptags?.tag || [];
      const arr = Array.isArray(t) ? t : [t];
      return arr.slice(0, 3).map((x) => x.name || "").filter(Boolean);
    })(),
  };
}

/**
 * saveHistory が蓄積している日次サマリー(最大30日)から短期トレンドを構築する。
 *   API 呼び出しは一切なし (IndexedDB 読み出しのみ)。
 *   - daily: 日別 scrobble 数 (累計値の「連続した日」同士の差分のみ採用)
 *   - 信頼できる点が 3 日分未満なら { insufficient: true } (UI は蓄積中表示。
 *     差分1点だけではスパークラインの線が描けないため 3 日を下限とする)
 *
 *   データ品質ガード:
 *   - h.user !== user の履歴は除外 (ユーザ切替で別ユーザの累計が混ざると
 *     差分が巨大スパイク/0潰れになるため)
 *   - totalScrobbles <= 0 の日は除外 (Worker 集計失敗日の 0 が混ざると
 *     翌日の差分が累計全量のスパイクになるため)
 *   - 日付が連続していない区間の差分は採用しない (PWA を開かなかった日の
 *     累積増分が「1日分」として過大表示されるのを防ぐ)
 */
async function buildTrendFromHistory(user) {
  const dates = await listHistoryDates();
  const sorted = (dates || []).slice().sort();
  const points = [];
  for (const d of sorted) {
    const h = await loadHistory(d);
    if (!h?.summary) continue;
    if (h.user !== user) continue;                       // 別ユーザの履歴は除外
    const total = h.summary.totalScrobbles || 0;
    if (total <= 0) continue;                             // 集計失敗日(0)は除外
    points.push({ date: d, total, streak: h.summary.streak || "" });
  }
  if (points.length < 3) return { insufficient: true, days: points.length };
  // 累計 → 日次差分。"YYYY-MM-DD" を UTC として解釈した差がちょうど1日の
  // ペアだけを採用する (JST 日付文字列同士の比較なので TZ 影響なし)。
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daily = [];
  for (let i = 1; i < points.length; i++) {
    const gap = Date.parse(points[i].date + "T00:00:00Z") - Date.parse(points[i - 1].date + "T00:00:00Z");
    if (gap !== DAY_MS) continue;                         // 欠損日を跨ぐ差分は捨てる
    daily.push({
      date: points[i].date,
      count: Math.max(0, points[i].total - points[i - 1].total),
    });
  }
  if (daily.length < 2) return { insufficient: true, days: points.length };
  return {
    insufficient: false,
    days: points.length,
    daily,
    latestStreak: points[points.length - 1].streak,
  };
}

function simplifyUserInfo(info) {
  return {
    name: info.name || "",
    image: pickImage(info.image),
    playcount: parseInt(info.playcount || "0", 10),
    country: info.country || "",
    // 登録日も端末タイムゾーンに依存させず JST (Asia/Tokyo) 固定で表示する
    registered: info.registered?.unixtime
      ? new Date(parseInt(info.registered.unixtime, 10) * 1000)
          .toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "",
  };
}

function simplifyRecent(t) {
  const nowPlaying = t["@attr"] && t["@attr"].nowplaying === "true";
  return {
    name: t.name || "",
    artist: (t.artist && (t.artist["#text"] || t.artist.name)) || "",
    image: pickImage(t.image),
    // ★ Last.fm 公式アプリと同じ表示形式に揃える:
    //   - 60 分未満 → "N min(s) ago"
    //   - 24 時間未満 → "N hour(s) ago"
    //   - 24 時間以上 → "DD MMM HH:MM" (今年) / "DD MMM YYYY HH:MM" (別年)
    //   端末のタイムゾーンに依存せず常に JST (Asia/Tokyo) で表示する
    //   (formatRelativeTime が jstParts で変換)。日本のユーザに自然な時刻になる。
    when: nowPlaying ? "再生中" : formatRelativeTime(t.date),
    nowPlaying,
  };
}

// 月名（Last.fm 公式アプリは英語 3 文字略を使う）
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// うるう年判定 (Love 記念日の 2/29 救済に使う)
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * 指定の Unix ミリ秒を JST (Asia/Tokyo) の年月日時分に分解する。
 * 端末のタイムゾーン設定に関わらず常に日本時間で表示するために使う
 * （iOS 版 Last.fm 公式アプリと同様、日本のユーザに自然な時刻へ揃える）。
 * @returns {{year:number, month:number, day:number, hour:string, minute:string}}
 *   month は 1-12、hour/minute はゼロ詰め 2 桁文字列。
 */
let _jstFormatter = null;
function jstParts(ms) {
  // フォーマッタは設定不変のためモジュールスコープで一度だけ生成して使い回す。
  //   呼び出しごとに new Intl.DateTimeFormat すると Loved 等の最大1000件集計で千回規模の
  //   インスタンス化が走り無駄(formatToParts(date) は副作用なく同一インスタンスで再利用できる)。
  if (!_jstFormatter) {
    _jstFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  const parts = _jstFormatter.formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t)?.value ?? "");
  // hour12:false の一部実装は深夜 0 時を "24" と返すため "00" に正規化する。
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
    minute: get("minute"),
  };
}

/**
 * Last.fm の date オブジェクトを公式アプリ風の表示文字列に変換する。
 *
 *   {uts: "1716618000", #text: "25 May 2024, 06:00"} →
 *     "29 mins ago" / "1 hour ago" / "24 May 23:09" / "24 May 2024 23:09"
 *
 * 切替境界は「JST (Asia/Tokyo) 日付（年月日）が同じか」:
 *   - 同じ JST 日 → 相対時刻 ("N min(s)/hour(s) ago")
 *   - 別 JST 日 + 同年 → "DD MMM HH:MM"
 *   - 別年       → "DD MMM YYYY HH:MM"
 *
 * (Last.fm 公式アプリは「日付が変わったら絶対時刻」の挙動。例えば現在
 *  5/25 02:54 のとき、5/24 23:09 の曲は 3〜4 時間前だが「24 May 23:09」と
 *  日付付きで表示される)
 *
 * - uts (Unix 秒) を JST (Asia/Tokyo) に変換して判定・表示する
 * - Last.fm API の "#text" は UTC 表記なので、そのまま表示すると JST で
 *   9 時間ずれるため使わない
 * - uts が無い場合は "#text" にフォールバック
 */
function formatRelativeTime(date, nowMs = Date.now()) {
  if (!date) return "";
  const utsStr = date.uts;
  if (!utsStr) return date["#text"] || "";
  const uts = parseInt(utsStr, 10);
  if (!uts || isNaN(uts)) return date["#text"] || "";

  const thenMs = uts * 1000;
  // 端末のタイムゾーンに依存せず、常に JST (Asia/Tokyo) で日付・時刻を判定/表示する
  const thenP = jstParts(thenMs);
  const nowP = jstParts(nowMs);

  // JST で同じ日付かを判定
  const sameDay = thenP.year === nowP.year
               && thenP.month === nowP.month
               && thenP.day === nowP.day;

  if (sameDay) {
    // 同じ日: 相対時刻（差分はタイムゾーン非依存の絶対時間差で算出）
    const diffMs = Math.max(0, nowMs - thenMs);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin} ${diffMin === 1 ? "min" : "mins"} ago`;
    const diffHour = Math.floor(diffMs / 3600000);
    return `${diffHour} ${diffHour === 1 ? "hour" : "hours"} ago`;
  }

  // 別の日: JST で日付 + 時刻表示
  const day = thenP.day;
  const month = MONTHS_SHORT[thenP.month - 1];
  const hh = thenP.hour;
  const mm = thenP.minute;
  if (thenP.year === nowP.year) {
    return `${day} ${month} ${hh}:${mm}`;
  }
  return `${day} ${month} ${thenP.year} ${hh}:${mm}`;
}

/**
 * トップチャート（6 期間 × 3 種類）
 */
/**
 * 配列を「同時 concurrency 本まで」の並列で処理する(レート制限バーストの抑制。IAS-2)。
 *   - Promise.all による一括バーストを避けつつ、直列より速い中間。
 *   - runId 指定時は isStaleRun で世代/abort をチェックして中断。
 *   - 個別失敗は fn 側で処理する想定(全体は止めない)。
 */
async function mapPool(items, fn, concurrency = 3, runId = null) {
  const stale = () => (runId != null ? isStaleRun(runId) : abortFlag);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      if (stale()) return;
      const i = idx++;
      await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}

async function fetchTop(user, { forceRefresh, runId, bufferedMode = false, today, isFinalized, onReady }) {
  const byPeriod = {};
  // いずれかの期間/種別が withRetry 後も throw(取得層の失敗)したら true。空応答(成功)は区別する。
  // bufferedMode は前日維持、非bufferedMode は complete:false で同日再取得し自己回復させる。
  let degraded = false;
  let readyFired = false;
  // 既定表示 "overall"(view の currentPeriod 初期値)を最優先で取得し、最初に揃った時点で
  // タブを可視化+先行表示する(残り期間は後追い、未取得期間は topPending で skeleton 表示)。
  const fetchOrder = ["overall", ...PERIODS.filter((p) => p !== "overall")];
  // 期間を同時 3 本までに絞って取得(各期間内は3種並列 = 最大9本)。初回ロードで
  // 18 本同時のバースト → 9 本に抑え、再生中の帯域/CPU 圧迫とレート超過を避ける(IAS-2)。
  await mapPool(fetchOrder, async (period) => {
    if (isStaleRun(runId)) return;
    const [tracks, artists, albums] = await Promise.all([
      withRetry(
        () => cached(`top-tracks:${user}:${period}:20`, () => getTopTracks(user, period, 20), { forceRefresh }),
        { label: `top-tracks-${period}` }
      ).catch(() => { degraded = true; return []; }),
      withRetry(
        () => cached(`top-artists:${user}:${period}:20`, () => getTopArtists(user, period, 20), { forceRefresh }),
        { label: `top-artists-${period}` }
      ).catch(() => { degraded = true; return []; }),
      withRetry(
        () => cached(`top-albums:${user}:${period}:20`, () => getTopAlbums(user, period, 20), { forceRefresh }),
        { label: `top-albums-${period}` }
      ).catch(() => { degraded = true; return []; }),
    ]);
    byPeriod[period] = {
      tracks: (tracks || []).map(simplifyTopItem),
      artists: (artists || []).map(simplifyTopItem),
      albums: (albums || []).map(simplifyTopItem),
    };
    // 非bufferedMode: 期間が揃うたびに逐次反映し、最初の1期間で tab を可視化(早期表示)。
    //   topPending=true で未取得期間は renderTop が skeleton 表示する(空誤表示のフラッシュ回避)。
    if (!bufferedMode && !isStaleRun(runId)) {
      updateSection("top", { byPeriod, topPending: true });
      if (!readyFired && onReady) { readyFired = true; try { onReady(); } catch {} }
    }
  }, 3, runId);
  if (isStaleRun(runId)) return { complete: false };

  // ★ 全期間×全種別が空 = 一過性の空応答(HTTP200+空、throw を伴わない)で取得層が機能していない異常。
  //   履歴のあるユーザで全 top が同時に空になることは通常なく、degraded(throw 経由)には乗らないため
  //   別途検知する(world/genre の「一過性空で前日を誤上書きしない」維持ガードと同趣旨)。
  //   ※単一期間のみの空は genuine(該当期間に再生が無い)と区別できないため許容し、全滅のみ異常扱い。
  const allEmpty = PERIODS.every((p) => {
    const d = byPeriod[p];
    return !d || (d.tracks.length === 0 && d.artists.length === 0 && d.albums.length === 0);
  });

  // ★ bufferedMode で一過性失敗(throw=degraded / 全期間空応答=allEmpty)時は、前日の正常な top を
  //   部分/空データで上書きせず維持する(原子差替の趣旨)。complete:false で同日再取得させる。
  //   前日 top が無い場合は維持すべきデータが無いので commit する(genuine-empty 新規ユーザ表示・skeleton 固定回避)。
  if (bufferedMode && (degraded || allEmpty) && state.sections.top != null) {
    // ただし「前日 top も全期間空」= 恒久的なゼロ履歴ユーザの allEmpty は、再取得しても結果が変わらないため
    //   complete:true 扱いにし、retryIfIncomplete の過剰な全タブ再取得ループを止める(genre/world の
    //   priorNoData カーブアウトと対称)。throw 由来(degraded)や前日が実データの一過性 allEmpty は
    //   従来どおり前日を維持し complete:false で再取得させる。
    const priorAllEmpty = PERIODS.every((p) => {
      const d = state.sections.top?.byPeriod?.[p];
      return !d || (d.tracks.length === 0 && d.artists.length === 0 && d.albums.length === 0);
    });
    return { complete: !degraded && allEmpty && priorAllEmpty };
  }
  // 確定 commit (両モード共通、topPending 解除)。bufferedMode はここで原子的に差し替わる。
  updateSection("top", { byPeriod });

  // 全期間トップ10アーティストの詳細 (ontour/リスナー数) を直列で取得し、
  // 「🎤ツアー中」バッジと豆知識モーダルの即時表示に使う。
  // ★ fire-and-forget で実行し、トップタブの sectionReady を遅らせない
  //   (await すると初回はバッジ取得 ~5-10 秒ぶんローディングが伸びるため)。
  //   旧 run 化したら isStaleRun で commit しない。バッジは cached() 済みなので
  //   当日中の再実行ではすぐ揃う。失敗は無視 (バッジ無し表示のまま)。
  (async () => {
    const overallTop = (byPeriod.overall?.artists || []).slice(0, 10);
    const artistBadges = {};
    await mapSequential(overallTop, async (a) => {
      const info = await cached(
        ckey("artistinfo", a.name, user),
        () => getArtistInfo(a.name, user),
        { forceRefresh }
      ).catch(() => null);
      if (info) {
        artistBadges[normName(a.name)] = {
          ontour: info.ontour === "1" || info.ontour === 1,
          listeners: parseInt(info.stats?.listeners || "0", 10),
        };
      }
    }, 120, runId);
    if (isStaleRun(runId)) return;
    if (Object.keys(artistBadges).length > 0) {
      updateSection("top", { byPeriod, artistBadges });
      // 他セクションの finalizeSection と同規約で保存も再発行し、保存データと
      // state の不一致(バッジ欠落 top の保存)を閉じる(SVC-5)。
      // bufferedMode 中は混在防止のためスキップ(finalizeSection と同条件)。
      // isFinalized(): 既に runFetch が最終 saveCurrent(complete:runComplete) を発行した後なら、
      //   この遅延バッジ保存(complete:false)で complete を降格させないようスキップする。
      if (!isStaleRun(runId) && !bufferedMode && state.sections.top != null && !(isFinalized && isFinalized())) {
        // fetchDate は runFetch の today に揃える(getJSTDateString() を使うと、
        // バッジ取得が日付跨ぎに重なったとき他セクションと別日ラベルで保存され得る)。
        saveCurrent({ user, fetchDate: today, sections: state.sections, complete: false })
          .catch((e) => console.warn("[stats-service] top バッジ更新後保存失敗", e));
      }
    }
  })().catch(() => {});
  return { complete: !degraded };
}

function simplifyTopItem(t) {
  return {
    name: t.name || "",
    artist: (t.artist && (t.artist["#text"] || t.artist.name)) || "",
    image: pickImage(t.image),
    playcount: parseInt(t.playcount || "0", 10),
  };
}

/**
 * 比較タブ（3 範囲 × 3 種類 + 新しい発見）
 */
async function fetchCompare(user, { forceRefresh, runId, bufferedMode, onReady }) {
  const byRange = {};
  const discoveries = { artists: [], albums: [], tracks: [] };
  let firstPublished = false;
  // ★ 範囲(週/月/年)が1つ揃うたびに逐次反映する。既定表示の「今週」(最小データ)が
  //   先に揃えば比較タブの値が早く出る。最初の publish で早期 ready 化して「集計中…」を
  //   解除する(残りの範囲・新しい発見はバックグラウンドで埋まり、renderCompare 側は
  //   未取得範囲をスケルトン表示する)。
  const publishCompare = () => {
    if (isStaleRun(runId)) return;
    // bufferedMode(旧データ表示中の更新)は仕様2の atomic swap を保つため逐次反映せず、
    // 末尾の一括 updateSection でのみ差し替える(部分データで旧表示を巻き戻さない)。
    if (bufferedMode) return;
    // discoveriesReady=false: 新しい発見はまだ未取得（renderCompare はスケルトン表示）。
    updateSection("compare", { byRange: { ...byRange }, discoveries, discoveriesReady: false });
    if (!firstPublished) {
      firstPublished = true;
      if (onReady) { try { onReady(); } catch {} }
    }
  };

  // 「今週/先週」の scrobble 総数は、ダッシュボードのリスニング数（直近7日）と
  // 同じ定義に揃える（週次チャート合算による過大カウントを避ける）。
  // week 範囲の totals 上書きにのみ使用し、順位リストは週次チャート由来のまま残す。
  // ★ ここで await せず並行起動し、week 範囲の totals 構築時にのみ await する。
  //   上で await すると week 以外(月/年)の取得・比較タブの初回表示まで weekTotals 取得を
  //   待たされ不要に遅れるため(week 専用データなので mapPool をブロックしない)。
  const weekTotalsP = fetchWeekScrobbleTotals(user).catch(() => null);
  // 範囲を同時 2 本までに絞る(各 buildComparison は内部 netLimit で実 fetch を
  // 制限済みだが、同時呼び出し数も抑えてメモリ/CPU バーストを避ける。IAS-2)。
  await mapPool(COMPARE_RANGES, async (range) => {
    if (isStaleRun(runId)) return;
    try {
      const [aCmp, bCmp, tCmp] = await Promise.all([
        withRetry(
          () => buildComparison(user, range, "artist", { limit: 10, forceRefresh }),
          { label: `compare-${range}-artist`, maxAttempts: 2 }
        ),
        withRetry(
          () => buildComparison(user, range, "album", { limit: 10, forceRefresh }),
          { label: `compare-${range}-album`, maxAttempts: 2 }
        ),
        withRetry(
          () => buildComparison(user, range, "track", { limit: 10, forceRefresh }),
          { label: `compare-${range}-track`, maxAttempts: 2 }
        ),
      ]);
      byRange[range] = {
        totals: extractCompareTotals(aCmp, range === "week" ? await weekTotalsP : null),
        artists: extractCompareList(aCmp),
        albums: extractCompareList(bCmp),
        tracks: extractCompareList(tCmp),
      };
    } catch (e) {
      console.warn(`[stats-service] compare ${range} 失敗`, e);
      byRange[range] = null;
    }
    publishCompare(); // 範囲が1つ揃う(または失敗確定する)たびに逐次反映
  }, 2, runId);

  // 新しい発見 (range 非依存)
  // ★ 「取得失敗で空」と「正規に新発見ゼロ(既知のみ再生)」を区別する。両者とも空配列になり
  //   見分けがつかないので、kind 単位で【失敗した kind だけ】前回値を維持し、成功して空の kind は
  //   正規ゼロとして空を採用する(前日リストの誤った復活を防ぐ)。bufferedMode では
  //   prevDisc=前日の発見、非bufferedMode では prevDisc=この run の逐次結果(同一参照)なので実質no-op。
  const prevDisc = (state.sections.compare || {}).discoveries || null;
  let discFailed = false;
  // ★ artist/album/track の新しい発見は相互に独立で、各 findNewDiscoveries が全履歴週を集計する
  //   重処理。直列 await だと全履歴集計が3回順番待ちになり比較タブの確定(discoveriesReady:true)が
  //   約3倍遅れるため並列化する。実ネットワークは stats-compare の共有セマフォ(netLimit)が上限本数に
  //   絞るためバーストしない。書込先キー(discoveries[kind+"s"])は kind ごとに排他、discFailed は OR
  //   集約のみで単一スレッド上競合しない。stale 時は各 kind が return し、後続の isStaleRun で commit しない。
  await Promise.all(["artist", "album", "track"].map(async (kind) => {
    if (isStaleRun(runId)) return;
    try {
      const list = await withRetry(
        () => findNewDiscoveries(user, kind, { lookbackWeeks: 1, limit: 5, forceRefresh }),
        { label: `discovery-${kind}`, maxAttempts: 2 }
      );
      discoveries[kind + "s"] = (list || []).map((item) => ({
        name: item.name || "",
        artist: item.artist || "",
        image: pickImage(item.image),
        count: item.count,
      }));
    } catch {
      // この kind の取得失敗 → 表示中の前回値を維持(正規ゼロと違い空で潰さない)。
      discoveries[kind + "s"] = (prevDisc && prevDisc[kind + "s"]) || [];
      discFailed = true;
    }
  }));
  if (isStaleRun(runId)) return;
  // ★ 失敗した範囲(byRange[r]===null)は前回(表示中)の値を維持し、正しい旧データを
  //   「データがありません」へ巻き戻さない(rewind の bufferedMode 防御と同方針)。
  //   成功した範囲だけ新値で差し替える。bufferedMode では prevByRange=前日データ、
  //   非bufferedMode(初回)では未取得=null同士なので実質no-op。
  const prevByRange = (state.sections.compare || {}).byRange || {};
  // 比較タブを完全更新できたか: 全範囲成功 かつ 新しい発見も失敗なし。
  // discovery 失敗も未完了に含め、同日再起動で再取得させる。
  const compareComplete = COMPARE_RANGES.every((r) => byRange[r] != null) && !discFailed;
  const mergedByRange = { ...byRange };
  for (const r of COMPARE_RANGES) {
    if (mergedByRange[r] == null && prevByRange[r] != null) mergedByRange[r] = prevByRange[r];
  }
  // discoveries は kind 単位で失敗フォールバック済み(上記ループ)なのでそのまま使う。
  // discoveriesReady=true: 範囲・新しい発見とも取得完了。renderCompare が確定表示する。
  updateSection("compare", { byRange: mergedByRange, discoveries, discoveriesReady: true });
  // 範囲が1つも揃わなかった場合の保険で ready 化する。
  if (!firstPublished && onReady) { try { onReady(); } catch {} }
  // 全範囲+新しい発見が揃ったか(=この run で比較タブを完全更新できたか)を返す。
  return { complete: compareComplete };
}

function extractCompareTotals(cmp, override = null) {
  // 既定は週次チャート合算による合計。ただし override（直近7日 / その前7日の
  // 正確な scrobble 数）が与えられた場合はそちらを優先し、リスニング数カードと
  // 数値を一致させる（週範囲の過大カウント解消）。順位リスト側は週次チャート由来のまま。
  // ※ 既知のトレードオフ: week で override.cur 自体が取得失敗(null)した稀なケース
  //   (cur が withRetry 後も失敗 かつ prev は成功)は、cur が週次チャート合算
  //   (境界週を含み過大)にフォールバックし「今週(直近7日)」注記と一時的に食い違う。
  //   prev/diff は下の混在検出で抑止する。cur 自体の概算表示は許容(発生は cur の
  //   withRetry 失敗のみで稀。次回更新で正確値に回復)。
  let cur = cmp.current.total;
  let prev = cmp.previous.total;
  let curOv = false, prevOv = false;
  // ★ override(直近7日/その前7日の正確値)は cur/prev を【独立に】適用する。
  //   片方だけ失敗(例: prev の一過性ネットワーク失敗で null)しても、成功した側は正確値で
  //   上書きする。両方揃わないと適用しない旧実装だと、prev だけ失敗したとき cur まで
  //   週次チャート合算(境界週で最大~2週間に膨張)へ戻り「今週」がリスニング数カードと
  //   食い違っていた。
  if (override) {
    if (override.cur != null) { cur = override.cur; curOv = true; }
    if (override.prev != null) { prev = override.prev; prevOv = true; }
  }
  // ★ override 適用が cur/prev で片方だけ = 定義混在(直近7日 rolling vs 週次チャート合算の過大値)。
  //   その差分は無意味(誤方向・過小)なので diff/pct/arrow を出さず、信頼できない prev も null に
  //   して「—」表示にする(buildWeekDelta の hasPrev=false と同方針)。cur は手元の最善値を表示。
  //   両方 override 適用 or 両方未適用(chart 同士)なら定義が揃うので通常通り差分を出す。
  if (curOv !== prevOv) {
    return {
      cur, prev: null, diff: null, sign: "", pct: null, arrow: "—",
      curLabel: cmp.current.label, prevLabel: cmp.previous.label,
    };
  }
  const diff = cur - prev;
  const sign = diff > 0 ? "+" : "";
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : null;
  const arrow = diff > 0 ? "📈" : diff < 0 ? "📉" : "➖";
  return {
    cur, prev, diff, sign, pct, arrow,
    curLabel: cmp.current.label,
    prevLabel: cmp.previous.label,
  };
}

function extractCompareList(cmp) {
  const items = cmp.current.items.map((item) => {
    const prev = cmp.previous.items.find((p) => p.artist === item.artist && p.name === item.name);
    const prevAll = cmp.diff.up.concat(cmp.diff.down).find((d) => d.artist === item.artist && d.name === item.name);
    let badge, badgeClass, prevRank = null;
    if (cmp.diff.new.find((d) => d.artist === item.artist && d.name === item.name)) {
      badge = "★ NEW"; badgeClass = "is-new";
    } else if (prevAll && prevAll.prevRank != null) {
      const delta = prevAll.prevRank - prevAll.currentRank;
      prevRank = prevAll.prevRank;
      if (delta > 0) { badge = `↑${delta}`; badgeClass = "is-up"; }
      else if (delta < 0) { badge = `↓${-delta}`; badgeClass = "is-down"; }
      else { badge = "→"; badgeClass = "is-same"; }
    } else if (prev) {
      badge = "→"; badgeClass = "is-same"; prevRank = prev.rank;
    } else {
      badge = "★"; badgeClass = "is-new";
    }
    return {
      rank: item.rank,
      name: item.name || "",
      artist: item.artist || "",
      image: pickImage(item.image),
      count: item.count,
      badge, badgeClass, prevRank,
    };
  });
  const fallen = (cmp.diff.fallen || []).map((d) => ({
    rank: d.prevRank,
    name: d.name || "",
    artist: d.artist || "",
    image: pickImage(d.image),
    prevCount: d.prevCount,
  }));
  return { items, fallen };
}

/**
 * 振り返り（全期間の年別チャート）
 *
 * 注意:
 *   Last.fm の getWeeklyChartList はアカウント開設以降の全週を返すため、
 *   ユーザがアカウントを開設した年と初めて scrobble した年がズレている
 *   場合（例: 2007年開設・2010年から scrobble 開始）、間の年は total=0 の
 *   「空の年」になる。これらをグラフ・年カード・「あなたの始まり」から除外する。
 */
/**
 * buildRewind の生年配列（各年 {year,total,topArtists,topAlbums,topTracks}）から、
 * 表示用の { years, milestones, origin } を組み立てる。逐次表示と最終確定で共用する。
 */
function buildRewindView(dataYears) {
  // 最初に scrobble があった年（total > 0）以降のみを「アクティブ年」とする。
  // 途中に scrobble 0 の年があった場合は連続性のため残す（グラフが途切れない）。
  const firstActiveIdx = dataYears.findIndex((y) => (y.total || 0) > 0);
  const activeYears = firstActiveIdx >= 0 ? dataYears.slice(firstActiveIdx) : [];

  // マイルストン算出（アクティブ年のみで計算）
  const milestones = [];
  const targets = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
  let cum = 0;
  for (const y of activeYears) {
    const before = cum;
    cum += (y.total || 0);
    for (const t of targets) {
      if (before < t && cum >= t) milestones.push({ target: t, year: y.year });
    }
  }

  // 「あなたの始まり」: アクティブ年のうち、トップアーティスト[0] が存在する
  // 最初の年を採用。total>0 でも稀に topArtists が空のケース（Last.fm 集計
  // のエッジケース）に備えて find で先頭から走査する。
  const originYear = activeYears.find((y) => y.topArtists && y.topArtists[0]);
  const origin = originYear
    ? {
        year: originYear.year,
        top: {
          name: originYear.topArtists[0].name,
          image: pickImage(originYear.topArtists[0].image),
          count: originYear.topArtists[0].count,
        },
      }
    : null;

  // 表示用に最小化（画像 URL は不要、文字列だけ）。アクティブ年のみ。
  const years = activeYears.map((y) => ({
    year: y.year,
    total: y.total || 0,
    topArtists: (y.topArtists || []).map((it) => ({ name: it.name, count: it.count })),
    topAlbums:  (y.topAlbums  || []).map((it) => ({ name: it.name, count: it.count })),
    topTracks:  (y.topTracks  || []).map((it) => ({ name: it.name, count: it.count })),
  }));

  return { years, milestones, origin };
}

async function fetchRewind(user, { forceRefresh, runId, bufferedMode, onReady }) {
  // ★ 振り返りは「全年 × 3種 × 各年の全週」を取得するため最大規模のリクエストになり、
  //   レート制御(5 req/s)下では長期ユーザで数分かかる。これを「集計中…」のまま待たせると
  //   固まって見えるため、年が1つ集計できるたびに部分結果で updateSection し、最初の年で
  //   早期 ready 化する(以降は年が順次埋まる)。sections.rewind を常に非 null に保つことで、
  //   renderRewind が null→「集計中…」表示に戻る問題も防ぐ。
  const accMap = new Map(); // year -> 年集計（withRetry リトライ時は同一年を上書きして重複排除）
  let firstPublished = false;
  const publishPartial = (yr) => {
    if (yr) accMap.set(yr.year, yr);
    // bufferedMode(旧データ表示中の更新)は仕様2の atomic swap を保つため逐次反映せず、
    // 末尾の一括 updateSection でのみ差し替える(部分データで旧表示を巻き戻さない)。
    if (bufferedMode || isStaleRun(runId)) return;
    const arr = Array.from(accMap.values()).sort((a, b) => a.year - b.year);
    const view = buildRewindView(arr);
    // timeTravel は最終段で取得するため、ここでは現在値を引き継ぐ（無ければ null）。
    const prevTT = (state.sections.rewind || {}).timeTravel || null;
    updateSection("rewind", { ...view, timeTravel: prevTT, partial: true });
    if (!firstPublished) {
      firstPublished = true;
      if (onReady) { try { onReady(); } catch {} } // 「集計中…」スピナーを解除して部分表示へ
    }
  };

  let data;
  try {
    data = await withRetry(
      () => buildRewind(user, { topN: 3, forceRefresh, onYear: publishPartial }),
      { label: "rewind", maxAttempts: 2 }
    );
  } catch (e) {
    // 全リトライ失敗時の扱い:
    //   - 初回ロード(非bufferedMode): 部分が出ていれば ready 済み。出ていなければ空
    //     セクションで確定し ready 化する（null のままだと renderRewind が「集計中…」を
    //     出し続けるため）。
    //   - 更新(bufferedMode): 旧データを表示中なので空で上書きせず維持する。旧データは
    //     既に ready のため markReady は不要（finalizeSection が担うが no-op）。空で
    //     上書きすると「更新失敗で過去の振り返りが消える」回帰になるため publish しない。
    console.warn("[stats-service] 振り返り取得失敗", e);
    if (isStaleRun(runId)) return { complete: false };
    // genre/world/top と対称: 維持すべき前日 rewind が無い(null)なら bufferedMode でも空確定。
    //   さもないと finalizeSection で ready=true になる一方 sections.rewind=null のままになり、
    //   renderRewind が「集計中…」スケルトンを同日中ずっと固定表示してしまう。
    if (firstPublished) {
      // 部分公開後に失敗した場合: 最後に出た部分集計を partial:false + error で確定する。これをしないと
      //   進捗バナーが「集計中… N年分」のまま当該セッション中ずっと固定され虚偽表示になる(実際は停止済み)。
      //   complete:false 維持なので翌日/同日再起動で完備化する(publishPartial は非bufferedMode のみ発火する
      //   ため firstPublished=true は非bufferedMode を含意)。
      const arr = Array.from(accMap.values()).sort((a, b) => a.year - b.year);
      const view = buildRewindView(arr);
      const prevTT = (state.sections.rewind || {}).timeTravel || null;
      updateSection("rewind", { ...view, timeTravel: prevTT, partial: false, error: true });
    } else if (!bufferedMode || state.sections.rewind == null) {
      // 1年も出ないまま失敗: 空確定して ready 化(「集計中…」固定回避)。error フラグで「取得失敗」を明示し、
      //   「集計完了 (0 年分)」の虚偽完了表示を避ける(履歴ゼロの新規ユーザは最終 commit 経路を通り error 無し
      //   = 通常の完了表示になる)。
      updateSection("rewind", { years: [], milestones: [], origin: null, timeTravel: null, partial: false, error: true });
      if (onReady) { try { onReady(); } catch {} }
    }
    // 失敗(bufferedMode は前日データ維持 / 非bufferedMode は空確定)。complete:false を返し、
    // runFetch がこの run を未完了として保存→同日再起動で再取得させる(time/compare と同方針)。
    return { complete: false };
  }
  if (isStaleRun(runId)) return { complete: false };

  // 最終確定: 成功した最終結果 data.years から作り直す（リトライ中の重複の影響を受けない）。
  const view = buildRewindView(data.years || []);

  // タイムトラベル: 既定で「1年前の今週」を取得。何年前まで遡れるかも算出する。
  let timeTravel = null;
  let ttFailed = false;
  try {
    // weekly-list は直前の buildRewind 成功時に当日付で再キャッシュ済みのため、ここでは forceRefresh を
    //   渡さず当日キャッシュを再利用する(同一 weekly-list の二重/三重ネットワーク再取得を排除。day2/手動更新で
    //   同一エンドポイントを最大3回叩いていた無駄を解消)。yearsAgo=1 は常に過去週で fetchTimeTravelWeek 内の
    //   persistent 流用が効くため、元から forceRefresh 不要で取得値は不変。
    const maxYears = await computeTimeTravelMaxYears(user, false);
    const week = maxYears >= 1 ? await fetchTimeTravelWeek(user, 1, false) : null;
    timeTravel = { maxYears, week };
  } catch (e) {
    // ★ timeTravel サブ取得の一過性失敗(日付変更の forceRefresh:true 経路では weekly-list が
    //   キャッシュバイパスで再取得され失敗し得る)。null で確定すると view 側でカードが消え、
    //   complete:true だと同日再取得されず翌日まで凍結する。失敗を complete に反映して再取得を促す。
    console.warn("[stats-service] タイムトラベル取得失敗", e);
    ttFailed = true;
    // 表示中の前回 timeTravel を維持し、bufferedMode で有効なカードが消えるのを防ぐ。
    timeTravel = (state.sections.rewind || {}).timeTravel || null;
  }

  if (isStaleRun(runId)) return { complete: false };
  updateSection("rewind", { ...view, timeTravel, partial: false });
  // 年が1つも来なかった(全年 total=0 等)場合の保険で ready 化する。
  if (!firstPublished && onReady) { try { onReady(); } catch {} }
  // timeTravel サブ取得が失敗していれば未完了として同日再取得させる(本体集計は成功)。
  return { complete: !ttFailed };
}

/* ============ タイムトラベル (N年前の今週) ============ */

// 1年 = 365.25日 (うるう年平均) で過去の同時期を指す
const YEAR_SEC = Math.round(365.25 * 24 * 60 * 60);

/**
 * 週次チャートリストから「N年前の今日」を含む週を探す
 */
function findWeekContaining(weekList, unixSec) {
  return (weekList || []).find((w) => w.from <= unixSec && unixSec <= w.to) || null;
}

/**
 * 何年前まで遡れるか (週次チャートの最古週から算出)
 */
async function computeTimeTravelMaxYears(user, forceRefresh = false) {
  const weekList = await cached(`weekly-list:${user}`, () => getWeeklyChartList(user), { forceRefresh });
  if (!weekList || weekList.length === 0) return 0;
  const earliest = Math.min(...weekList.map((w) => w.from));
  const nowUnix = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.floor((nowUnix - earliest) / YEAR_SEC));
}

/**
 * 「N年前の今週」の週次チャート (アーティスト/トラック各トップ5) を取得する。
 *   キャッシュキーは stats-compare.js の aggregateRange と同形式
 *   (`weekly:${kind}:${user}:${from}:${to}`) を使い、比較/振り返りと共有する。
 *   確定済み過去週は persistent キャッシュ (日次失効なし) なので実質初回のみの取得。
 */
async function fetchTimeTravelWeek(user, yearsAgo, forceRefresh = false) {
  const weekList = await cached(`weekly-list:${user}`, () => getWeeklyChartList(user), { forceRefresh });
  const target = Math.floor(Date.now() / 1000) - yearsAgo * YEAR_SEC;
  const w = findWeekContaining(weekList, target);
  if (!w) return null;
  // 終了から1日以上経過した週は不変データとして persistent (stats-compare と同基準)
  const persistent = w.to < Math.floor(Date.now() / 1000) - 86400;
  // 不変な過去週(persistent)は day2 の forceRefresh でも永続キャッシュを流用し再取得しない
  //   (aggregateRange の immutable 過去週流用と同基準)。当週など可変週のみ forceRefresh を通す。
  const ff = persistent ? false : forceRefresh;
  const [artists, tracks] = await Promise.all([
    cached(`weekly:artist:${user}:${w.from}:${w.to}`, () => getWeeklyArtistChart(user, w.from, w.to), { forceRefresh: ff, persistent }).catch(() => []),
    cached(`weekly:track:${user}:${w.from}:${w.to}`, () => getWeeklyTrackChart(user, w.from, w.to), { forceRefresh: ff, persistent }).catch(() => []),
  ]);
  const total = (artists || []).reduce((s, a) => s + (parseInt(a.playcount || "0", 10) || 0), 0);
  const fp = jstParts(w.from * 1000);
  const tp = jstParts(w.to * 1000);
  return {
    yearsAgo,
    label: `${fp.year}/${fp.month}/${fp.day} 〜 ${tp.year}/${tp.month}/${tp.day}`,
    total,
    artists: (artists || []).slice(0, 5).map((a) => ({
      name: a.name || "",
      count: parseInt(a.playcount || "0", 10) || 0,
    })),
    tracks: (tracks || []).slice(0, 5).map((t) => ({
      name: t.name || "",
      artist: (t.artist && (t.artist["#text"] || t.artist.name)) || "",
      count: parseInt(t.playcount || "0", 10) || 0,
    })),
  };
}

/**
 * タイムトラベルの年指定取得 (view の週ピッカーから呼ばれる公開 API)。
 *   state.user 基準。abort 中でも単発取得として動作する (キャッシュ優先)。
 */
export async function fetchTimeTravel(yearsAgo) {
  const user = state.user;
  if (!user || !yearsAgo || yearsAgo < 1) return null;
  return fetchTimeTravelWeek(user, yearsAgo, false);
}

/**
 * Loved (大改修版)
 *   - 最大 1000 件 (200件 × 5ページ) をページング取得して集計する
 *   - 月別 Love 数タイムライン / Love 記念日 (N年前の今日) / 年別トップアーティスト
 *   - 「この曲が好きなら」(最新 Loved 3曲を種にした類似トラック提案)
 *   - 表示リストは先頭 50 件 (日時は JST 表示に統一)
 */
async function fetchLoved(user, { forceRefresh, runId, bufferedMode = false, onReady }) {
  const MAX_PAGES = 5; // 200 × 5 = 1000 件で打ち切り (超過分は truncated として明示)
  const EMPTY_LOVED = { list: [], total: 0, truncated: false, timeline: [], anniversaries: [], yearTop: [], similar: [] };
  // 段階表示ヘルパ。publish=確定反映(両モード)、publishProgressive=非bufferedMode のみ逐次反映。
  // bufferedMode は旧データ表示を保ち、末尾の確定 commit で原子的に差し替える(仕様2)。
  const publish = (data) => { if (!isStaleRun(runId)) updateSection("loved", data); };
  const publishProgressive = (data) => { if (!bufferedMode) publish(data); };
  // 直近50件リスト整形(JST。"#text" は UTC 表記なので使わない)。
  const buildList = (arr) => arr.slice(0, 50).map((t) => {
    const uts = parseInt(t.date?.uts || "0", 10);
    let when = "";
    if (uts) { const p = jstParts(uts * 1000); when = `${p.year}/${p.month}/${p.day}`; }
    return {
      name: t.name || "",
      artist: (t.artist && (t.artist["#text"] || t.artist.name)) || "",
      image: pickImage(t.image),
      when,
    };
  });

  // page1: 失敗時は初回ロードなら空表示(skeleton 固定回避)、bufferedMode は前日データ維持。
  // いずれも complete:false を返し、同日再起動で再取得させる。
  let first;
  try {
    first = await withRetry(
      () => cached(`loved:${user}:200:1`, () => getLovedTracks(user, { limit: 200, page: 1 }), { forceRefresh }),
      { label: "loved" }
    );
  } catch (e) {
    console.warn("[stats-service] Loved 取得失敗 (page1)", e);
    if (isStaleRun(runId)) return { complete: false };
    // genre/world/top/rewind と対称: 維持すべき前日 loved が無い(null)なら bufferedMode でも
    //   空確定する。さもないと ready=true + sections.loved=null で skeletonRows(8) が固定される。
    if (!bufferedMode || state.sections.loved == null) publish(EMPTY_LOVED);
    return { complete: false };
  }
  if (isStaleRun(runId)) return { complete: false };
  let all = first.list || [];
  const total = first.total || all.length;
  // truncated: 全 Love 数が取得上限(1000)超 = 履歴/年別/記念日の集計が直近1000件窓に限定される。
  const truncated = total > MAX_PAGES * 200;
  const totalPages = Math.min(first.totalPages || 1, MAX_PAGES);

  // ★ 直近50件リストは page1 で確定(以降のページは古い側)。非bufferedMode では集計/類似を
  //   待たず即表示し、体感の表示遅延と skeleton 継続をなくす。
  publishProgressive({ ...EMPTY_LOVED, list: buildList(all), total, truncated });
  // 直近50件リストを先行公開した時点でタブを表示可能にする(初回ロードの段階表示。top/world と同方式)。
  //   bufferedMode では publishProgressive が no-op で実データを commit しないため onReady も呼ばない。
  //   さもないと前日 loved が無い(null)場合に ready=true + sections.loved=null の素 skeleton 表示に
  //   なる(top/compare/rewind も progressive な onReady を bufferedMode で抑止)。bufferedMode の
  //   ready 化は finalizeSection が最終 commit 後に担う。
  if (!bufferedMode && onReady) { try { onReady(); } catch {} }

  // page2..N (失敗は握りつぶすが pagesComplete に記録)。
  let pagesComplete = true;
  for (let p = 2; p <= totalPages; p++) {
    if (isStaleRun(runId)) return { complete: false };
    try {
      const d = await withRetry(
        () => cached(`loved:${user}:200:${p}`, () => getLovedTracks(user, { limit: 200, page: p }), { forceRefresh }),
        { label: `loved-p${p}`, maxAttempts: 2 }
      );
      all = all.concat(d.list || []);
    } catch { pagesComplete = false; }
  }

  // ★ bufferedMode で一部ページ取得に失敗した場合、前日の完全な集計(最大1000件)を
  //   200件窓の劣化集計で上書きしない(前日データ維持)。complete:false で同日再取得させる。
  //   ただし維持すべき前日 loved が無い(null)場合は、buffer 維持すると finalizeSection が
  //   ready=true にする一方 sections.loved=null のままで Loved タブが skeleton 固定になるため、
  //   取れた分(page1 由来の劣化集計)を下流で commit する(page1 失敗パス・time・world と対称)。
  if (bufferedMode && !pagesComplete && state.sections.loved != null) {
    console.warn("[stats-service] Loved: 一部ページ失敗のためバッファ(前日の集計)を維持します");
    return { complete: false };
  }

  // 集計: 月別 Love 数 / 年別アーティスト / 記念日 (JST 基準)
  const byMonth = Object.create(null);
  const byYearArtist = Object.create(null);
  const anniversaries = [];
  const nowP = jstParts(Date.now());
  for (const t of all) {
    const uts = parseInt(t.date?.uts || "0", 10);
    if (!uts) continue;
    const p = jstParts(uts * 1000);
    const mk = `${p.year}-${String(p.month).padStart(2, "0")}`;
    byMonth[mk] = (byMonth[mk] || 0) + 1;
    const artist = (t.artist && (t.artist["#text"] || t.artist.name)) || "";
    if (artist) {
      const yk = String(p.year);
      if (!byYearArtist[yk]) byYearArtist[yk] = Object.create(null);
      byYearArtist[yk][artist] = (byYearArtist[yk][artist] || 0) + 1;
    }
    // Love 記念日: 過去年の「今日と同じ月日」に Love した曲。
    // 2/29 に Love した曲は今日が非うるう年だと 2/29 が存在せず毎年取りこぼすため、
    // 非うるう年の 2/28 (=2月最終日) に過去の 2/29 Love を繰り上げて拾う。
    const sameMonthDay = p.month === nowP.month && p.day === nowP.day;
    const leapFallback = nowP.month === 2 && nowP.day === 28 && !isLeapYear(nowP.year)
      && p.month === 2 && p.day === 29;
    if ((sameMonthDay || leapFallback) && p.year < nowP.year) {
      anniversaries.push({
        name: t.name || "",
        artist,
        year: p.year,
        yearsAgo: nowP.year - p.year,
      });
    }
  }
  // タイムラインは最初の月から最後の月まで 0 埋めで補完する。
  // Love が無い月を欠落させると棒グラフの時間軸が不均一に詰まり
  // (例: 2019-01 の隣に 2023-06)、「歴史」としての間隔が歪むため。
  const monthKeys = Object.keys(byMonth).sort();
  const timeline = [];
  if (monthKeys.length > 0) {
    let [y, m] = monthKeys[0].split("-").map((v) => parseInt(v, 10));
    const [endY, endM] = monthKeys[monthKeys.length - 1].split("-").map((v) => parseInt(v, 10));
    while (y < endY || (y === endY && m <= endM)) {
      const mk = `${y}-${String(m).padStart(2, "0")}`;
      timeline.push([mk, byMonth[mk] || 0]);
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }
  const yearTop = Object.entries(byYearArtist)
    .sort((a, b) => b[0].localeCompare(a[0])) // 新しい年から
    .map(([year, m]) => ({
      year,
      total: Object.values(m).reduce((s, v) => s + v, 0),
      artists: Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([name, count]) => ({ name, count })),
    }));

  // ★ コア(list + 集計)を先に確定。類似トラック(二次情報)の取得待ちで Loved タブ全体が
  //   出ない問題を回避する。bufferedMode は publishProgressive が抑止し末尾で原子差替。
  const core = { list: buildList(all), total, truncated, timeline, anniversaries, yearTop, similar: [] };
  publishProgressive(core);

  // 「この曲が好きなら」: 最新 Loved 3曲を種に類似トラックを提案。
  // Loved が無い場合は直近1週間のトップトラックを種にフォールバック。
  let seeds = all.slice(0, 3).map((t) => ({
    name: t.name || "",
    artist: (t.artist && (t.artist["#text"] || t.artist.name)) || "",
  })).filter((s) => s.name && s.artist);
  if (seeds.length === 0) {
    try {
      const tt = await cached(`top-tracks:${user}:7day:20`, () => getTopTracks(user, "7day", 20), { forceRefresh });
      seeds = (tt || []).slice(0, 3).map((t) => ({
        name: t.name || "",
        artist: (t.artist && (t.artist["#text"] || t.artist.name)) || "",
      })).filter((s) => s.name && s.artist);
    } catch {}
  }
  const similar = [];
  await mapSequential(seeds, async (seed) => {
    const list = await cached(
      ckey("similartracks", seed.artist, seed.name, 5),
      () => getSimilarTracks(seed.artist, seed.name, 5)
    ).catch(() => []);
    if (list && list.length) {
      similar.push({
        seed,
        items: list.map((t) => ({
          name: t.name || "",
          artist: (t.artist && (t.artist.name || t.artist["#text"])) || "",
          // match のスケールは 0〜1 と 0〜100 系が混在するため正規化する。
          // 丸めて 0 になる極小スコアは「0%」表示の矛盾を避けバッジ非表示(null)にする。
          matchPct: (() => {
            const m = parseFloat(t.match || "0");
            if (!isFinite(m) || m <= 0) return null;
            const pct = Math.min(100, Math.round(m <= 1 ? m * 100 : m));
            return pct > 0 ? pct : null;
          })(),
          url: t.url || "",
        })),
      });
    }
  }, 150, runId);
  if (isStaleRun(runId)) return { complete: pagesComplete };

  // 確定 commit (両モード共通)。core に類似を載せて反映する。bufferedMode はここで初めて
  // 前日→当日へ原子的に差し替わる。一部ページ失敗(pagesComplete=false)なら同日再取得させる。
  publish({ ...core, similar });
  return { complete: pagesComplete };
}

/**
 * ジャンルタブ: ジャンルDNA / ジャンル踏破率 / 年代分布
 *   - DNA: 全期間トップ15アーティストのタグ (artist.getTopTags) を再生数で
 *     重み付け集計したジャンル分布 (ユーザのタグ付けに依存しない客観分析)
 *   - 踏破率: 主要3ジャンルの代表50組のうち何組を聴いたことがあるか
 *     (判定は全期間トップ1000アーティストとの突合のため概算)
 *   - 年代分布: トップアルバム20枚のリリース年 (album.getInfo) のヒストグラム
 *   すべて直列+間隔つき取得 + 1日キャッシュでレート配慮
 *   (キャッシュは同一 JST 日内のみ有効。日付が変わると再取得される)
 */
async function fetchGenre(user, { forceRefresh, runId, bufferedMode = false, onReady }) {
  // 段階表示ヘルパ(world/loved と同方針)。publish=確定反映(両モード)、publishProgressive=非bufferedMode のみ。
  const publish = (data) => { if (!isStaleRun(runId)) updateSection("genre", data); };
  const publishProgressive = (data) => { if (!bufferedMode) publish(data); };
  // 主要結果の全件欠落 / 基盤取得の失敗で true(=同日再取得対象)。
  //   - DNA が1件も取れない(dna.length===0) / トップアルバム取得自体が throw のときに立てる。
  //   - 単一アーティストのタグ・単一タグの代表組・単一アルバムの情報の取得失敗は【許容】し、
  //     その項目を欠落させるだけで degraded にしない(world の per-item許容・集約全滅方針に合わせる。
  //     1件の一過性 throw で genre 全体を complete:false=同日全再取得 にするのは過敏なため)。
  //   bufferedMode は前日維持、非bufferedMode は complete:false で同日再取得し自己回復させる。
  let degraded = false;

  // 基盤データ。取得失敗時は誤表示を避けつつ skeleton 固定も防ぐ:
  //   非bufferedMode(または維持すべき前日 genre が無い)は失敗マーカ(空)を commit し、
  //   renderGenre の非loading 経路で「取得できませんでした」を出す。bufferedMode は前日 genre を維持。
  let allArtists;
  try {
    allArtists = await getAllArtistsOnce(user, forceRefresh);
  } catch (e) {
    console.warn("[stats-service] Genre 取得失敗 (allArtists)", e);
    if (isStaleRun(runId)) return { complete: false };
    if (!bufferedMode || state.sections.genre == null) {
      publish({ dna: [], conquest: [], decades: [], avgYear: null, decadeKnown: 0, decadeTotal: 0 });
    }
    return { complete: false };
  }
  if (isStaleRun(runId)) return { complete: false };
  // 正規の「履歴ゼロ」(新規ユーザ等) は noData として明示。bufferedMode は一過性の空応答で
  // 前日データを誤って noData 上書きしないよう維持し再取得させる(前日 genre が無ければ noData を明示)。
  if (!allArtists || allArtists.length === 0) {
    if (!bufferedMode || state.sections.genre == null) updateSection("genre", { noData: true });
    // bufferedMode で前日も noData(恒久的なゼロ履歴ユーザ)だった場合は complete:true 扱いにする。
    //   一過性の空応答(本来は履歴ありのユーザの一時的な 0 件)と異なり再取得しても結果は変わらないため、
    //   complete:false 固定が runComplete を永続的に false にし、ゼロ履歴ユーザが毎朝の冷起動で全タブを
    //   不要に再取得し続けるループを止める。前日が実データなら(=一過性の空)従来どおり complete:false で再取得。
    const priorNoData = !!(state.sections.genre && state.sections.genre.noData);
    return { complete: !bufferedMode || priorNoData };
  }
  const artistSet = new Set(allArtists.map((a) => normName(a.name)));

  // --- ジャンル DNA: トップ15アーティストのタグを再生数×タグ相対値で重み付け ---
  const top15 = allArtists.slice(0, 15);
  const tagWeights = Object.create(null);
  let tagsCaught = false; // artisttags 取得で例外(throw)が発生したか(=取得層の失敗。空応答とは区別)
  await mapSequential(top15, async (a) => {
    // 単一アーティストのタグ取得失敗は許容(そのアーティストを欠落)。全件 throw は後段 dna 空 + tagsCaught で degraded。
    const tags = await cached(ckey("artisttags", a.name), () => getArtistTopTags(a.name), { forceRefresh }).catch(() => { tagsCaught = true; return []; });
    const weight = parseInt(a.playcount || "1", 10) || 1;
    // 各アーティスト上位5タグのみ採用。count は 0-100 の相対値。
    for (const t of (tags || []).slice(0, 5)) {
      const name = normName(t.name);
      if (!name || NOISE_TAGS.has(name)) continue;
      // count 欠損(NaN)時のみ 50 とみなす。実値 0 (関連度ほぼゼロのタグ) を
      // `|| 50` で 50 に化けさせない (無関係タグの過大重み付け防止)。
      const parsedRel = parseInt(t.count, 10);
      const rel = Number.isFinite(parsedRel) ? Math.min(100, Math.max(0, parsedRel)) : 50;
      if (rel <= 0) continue;
      tagWeights[name] = (tagWeights[name] || 0) + weight * (rel / 100);
    }
  }, 150, runId);
  if (isStaleRun(runId)) return { complete: false };
  const dnaEntries = Object.entries(tagWeights).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const dnaTotal = dnaEntries.reduce((s, [, w]) => s + w, 0);
  const dna = dnaEntries.map(([tag, w]) => ({
    tag,
    pct: dnaTotal > 0 ? Math.round((w / dnaTotal) * 1000) / 10 : 0,
  }));
  // ★ タグが1件も集計できず、かつ artisttags 取得で例外が発生していた(tagsCaught)場合のみ degraded。
  //   履歴のあるユーザのトップアーティストは通常ジャンルタグを持つので dna 空=取得層の異常とみなし
  //   同日再取得で回復させる。例外ゼロで dna 空(全タグがノイズ/rel<=0 等=正規の空)は degraded にしない
  //   (再取得しても同結果のため同日マウント毎の再取得ループを回避)。
  if (dna.length === 0 && tagsCaught) degraded = true;

  // ★ phase1: DNA を先行表示しジャンルタブを可視化(踏破率/年代は取得中なので pending 印で skeleton)。
  //   これをしないと末尾の単一 commit まで(最大約38回の逐次取得が全完了するまで)タブ全体が
  //   ローディングのまま=DNA が出せるのに踏破率/年代の取得を待たされる(無駄な体感遅延)。
  publishProgressive({ dna, tagSource: top15.length, conquest: [], decades: [], avgYear: null, decadeKnown: 0, decadeTotal: 0, conquestPending: true, decadesPending: true });
  if (onReady && !bufferedMode) { try { onReady(); } catch {} }

  // ★ 踏破率(DNA先頭3タグ依存)と年代分布(top-albums依存)は相互に独立なため並列取得する。
  //   直列だと年代分布の表示完了が踏破率の所要分だけ遅れる(fetchWorld の geo+トップ曲を Promise.all で
  //   並列化しているのと同方針)。各タスクは完了次第 publishPartial で逐次反映し、揃った側を表示・
  //   未完側は pending を維持する(非bufferedMode のみ。bufferedMode は publishProgressive が抑止し
  //   末尾の確定 commit で原子差替)。degraded は両タスクとも false→true の単調書込のみで単一スレッド上
  //   競合しない。isStaleRun は各 mapSequential 内の反復でも見て中断し、Promise.all 後にまとめて確認する
  //   (stale 時は publish ヘルパの isStaleRun ガードで publishPartial も no-op)。
  const conquest = [];
  let tagartistsCaught = false; // tagartists 取得で例外(throw)が発生したか
  let decades = [];
  let avgYear = null;
  let decadeKnown = 0;
  let decadeTotal = 0;
  let conquestDone = false, decadesDone = false;
  const publishPartial = () => publishProgressive({
    dna, tagSource: top15.length, conquest, decades, avgYear, decadeKnown, decadeTotal,
    conquestPending: !conquestDone, decadesPending: !decadesDone,
  });

  await Promise.all([
    // --- ジャンル踏破率: 主要3タグの代表50組と自分の聴取履歴を突合 ---
    (async () => {
      await mapSequential(dna.slice(0, 3).map((d) => d.tag), async (tag) => {
        // 単一タグの代表組取得失敗は許容(その踏破率行を欠落)。全タグ throw は conquest 空 + tagartistsCaught で degraded。
        const list = await cached(`tagartists:${tag}:50`, () => getTagTopArtists(tag, 50), { forceRefresh }).catch(() => { tagartistsCaught = true; return []; });
        if (!list || list.length === 0) return;
        const heard = list.filter((a) => artistSet.has(normName(a.name)));
        const unheard = list.filter((a) => !artistSet.has(normName(a.name))).slice(0, 5)
          .map((a) => ({ name: a.name || "", url: a.url || "" }));
        conquest.push({
          tag,
          total: list.length,
          heard: heard.length,
          pct: Math.round((heard.length / list.length) * 100),
          unheard,
        });
      }, 150, runId);
      // ★ DNA はあるのに踏破率が1件も組めず、かつ tagartists で例外が発生していた場合のみ degraded
      //   (主要ジャンルタグの代表組は通常取得できるので全滅=取得層の異常)。例外ゼロの空は degraded にしない。
      if (dna.length > 0 && conquest.length === 0 && tagartistsCaught) degraded = true;
      conquestDone = true;
      publishPartial();
    })(),
    // --- 年代分布: トップアルバム20枚のリリース年 (判明分のみで集計) ---
    (async () => {
      // fetchTop と同じキャッシュキー (top-albums:user:overall:20) を共有。ただし共有による二重取得回避が
      //   効くのは forceRefresh:false(初回ロード)時のみ。forceRefresh:true(日次再取得/手動更新)では cached() が
      //   getCache をスキップし _inflight 合流のみで判定するため、fetchTop の overall 取得が先に完了して in-flight が
      //   空になった後だと、ここで再取得が走り得る(top-albums:overall を計2回取得。実害は数 GET のみ)。
      const albums = await cached(`top-albums:${user}:overall:20`, () => getTopAlbums(user, "overall", 20), { forceRefresh }).catch(() => { degraded = true; return []; });
      const decadeCounts = Object.create(null);
      const knownYears = [];
      let albumInfoAttempts = 0; // albuminfo を実際に問い合わせた枚数
      let albumInfoErrors = 0;   // そのうち例外(throw)で取得失敗した枚数
      await mapSequential((albums || []).slice(0, 20), async (al) => {
        const artistName = (al.artist && (al.artist.name || al.artist["#text"])) || "";
        if (!artistName || !al.name) return;
        albumInfoAttempts++;
        // 単一アルバムの情報取得失敗は許容(その1枚を年代不明扱いで欠落)。年代不明は正規ケース
        // (Last.fm に発売年記載が無いニッチ作品等)なので degraded にしない。判明枚数は「n/m 枚」で明示。
        const info = await cached(
          // レスポンスに userplaycount を含むユーザ依存データのため、
          // trackinfo/artistinfo と同じ規約でキーに user を含める
          ckey("albuminfo", artistName, al.name, user),
          () => getAlbumInfo(artistName, al.name, user),
          { forceRefresh }
        ).catch(() => { albumInfoErrors++; return null; });
        const year = extractAlbumYear(info);
        if (year) {
          knownYears.push(year);
          const dec = Math.floor(year / 10) * 10;
          decadeCounts[dec] = (decadeCounts[dec] || 0) + 1;
        }
      }, 150, runId);
      // ★ 問い合わせた albuminfo が全て例外(throw)で失敗 = 取得層の異常。年代記載なし(info 取得成功 & year 無し)
      //   とは区別し、全件 throw のときだけ degraded(年代記載なしの正規ケースでは再取得ループにしない)。
      //   ※ top-albums が「成功で空配列」(throw でなく album:[])のときは degraded にしない(意図的)。
      //     world の top-tracks(established ユーザは必ず保持)と異なり、top-albums は
      //     アルバムメタ無しのスクロブルのみのユーザでは正規に空になり得るため。transient な空と
      //     正規の空は両方 success-empty で区別不能で、空を degraded 化すると album 無しユーザで
      //     同日再取得ループを招く。稀な一過性空は翌日の再取得で自然回復させる(過少報告を受容)。
      if (albumInfoAttempts > 0 && albumInfoErrors === albumInfoAttempts) degraded = true;
      decades = Object.entries(decadeCounts)
        .map(([dec, count]) => ({ decade: parseInt(dec, 10), count }))
        .sort((a, b) => a.decade - b.decade);
      avgYear = knownYears.length
        ? Math.round(knownYears.reduce((s, y) => s + y, 0) / knownYears.length)
        : null;
      decadeKnown = knownYears.length;
      decadeTotal = Math.min(20, (albums || []).length);
      decadesDone = true;
      publishPartial();
    })(),
  ]);
  if (isStaleRun(runId)) return { complete: false };

  const payload = {
    dna,
    tagSource: top15.length,
    conquest,
    decades,
    avgYear,
    decadeKnown,
    decadeTotal,
  };
  // ★ bufferedMode で一部取得失敗(degraded)時は、前日の正常な genre を部分/空データで上書きせず
  //   維持する(原子差替の趣旨)。complete:false で同日再取得させる。前日 genre が無い場合は
  //   維持すべきデータが無いので部分データを commit する(skeleton 固定回避)。
  if (bufferedMode && degraded && state.sections.genre != null) {
    console.warn("[stats-service] Genre: 部分失敗のためバッファ(前日)を維持します");
    return { complete: false };
  }
  // 確定 commit (両モード共通)。bufferedMode はここで原子的に差し替わる。
  publish(payload);
  return { complete: !degraded };
}

/**
 * album.getInfo の結果からリリース年を推定する。確度の高い順に判定し、最初に
 * 確定したものを採用する(誤った年を出すより「年代不明」として除外する方針)。
 *   1) releasedate フィールド(現行 API では空が多いが、あれば最優先)
 *   2) wiki 本文中の「完全な日付」(例 "6 April 1999" / "April 6, 1999" / "1999-04-06")
 *      — アルバム wiki の日付はほぼリリース日なので確度が高い
 *   3) "released … 1999" などリリース記述の近傍年(release/released/releasing 等)
 *   4) "1999 (studio/debut …) album" の共起表現(リリース年の定番。最後の手段)
 *   ★ wiki.published は「wiki 記事の公開・編集日時」(2005年以降に偏る)であって
 *     リリース年ではないため使わない。
 *   ★ Last.fm にリリース年の記載が無いアルバム(日本語・ニッチ作品で wiki 自体が
 *     無い等)は原理的に判定不能。view は「判明 n/m 枚」を明示している。
 */
function extractAlbumYear(info) {
  if (!info) return null;
  const nowYear = new Date().getFullYear();
  const ok = (y) => (y >= 1900 && y <= nowYear) ? y : null;

  // 1) releasedate (例: "6 Apr 1999, 00:00")。現行 API ではほぼ空。
  const rd = String(info.releasedate || "").match(/\b(19|20)\d{2}\b/);
  if (rd) { const y = ok(parseInt(rd[0], 10)); if (y) return y; }

  const wiki = `${info.wiki?.summary || ""} ${info.wiki?.content || ""}`;
  if (!wiki.trim()) return null;

  // 2) 完全な日付表記(リリース日であることがほぼ確実)
  const date =
    wiki.match(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/i)   // 6 April 1999
    || wiki.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+((?:19|20)\d{2})\b/i) // April 6, 1999
    || wiki.match(/\b((?:19|20)\d{2})-\d{2}-\d{2}\b/);                                                                // 1999-04-06
  if (date) { const y = ok(parseInt(date[1], 10)); if (y) return y; }

  // 3) "release(d/s/ing) … YYYY"(同一文内・80字以内の近傍年)
  const rel = wiki.match(/releas\w*[^.]{0,80}?\b((?:19|20)\d{2})\b/i);
  if (rel) { const y = ok(parseInt(rel[1], 10)); if (y) return y; }

  // 4) "YYYY (studio/debut/live/compilation …) album" の共起(最後の手段)
  const albumY = wiki.match(/\b((?:19|20)\d{2})\s+(?:[a-z-]+\s+){0,2}album\b/i);
  if (albumY) { const y = ok(parseInt(albumY[1], 10)); if (y) return y; }

  return null;
}

/**
 * 世界と自分タブ: メインストリーム度 / 国別チャート照合 / トップ曲の世界統計
 *   - メインストリーム度: 世界チャート100組と全期間トップ1000の重なり %
 *   - 国別: 日本/アメリカ/イギリス/韓国チャートとの一致度 (チャートは共有キャッシュ)
 *   - トップ曲: 上位10曲の listeners/playcount と自分の userplaycount (占有率)
 */
async function fetchWorld(user, { forceRefresh, runId, bufferedMode = false, onReady }) {
  // 段階表示ヘルパ(Loved と同方針)。publish=確定反映(両モード)、publishProgressive=非bufferedMode のみ。
  const publish = (data) => { if (!isStaleRun(runId)) updateSection("world", data); };
  const publishProgressive = (data) => { if (!bufferedMode) publish(data); };
  let degraded = false; // chart 失敗 / geo・トップ曲が全滅 のとき true(=部分データ。bufferedMode は前日維持)

  let chartArtists, allArtists;
  try {
    [chartArtists, allArtists] = await Promise.all([
      // ユーザ非依存のグローバルデータなのでキーに user を含めない (共有キャッシュ)
      withRetry(
        () => cached(`chart:artists:100`, () => getChartTopArtists(100), { forceRefresh }),
        { label: "chart-artists", maxAttempts: 2 }
      ).catch(() => { degraded = true; return []; }),
      // allArtists(全期間トップ1000=基盤) は失敗時 reject を伝播させる。
      getAllArtistsOnce(user, forceRefresh),
    ]);
  } catch (e) {
    // 基盤の取得失敗。誤診断(0%)を避けつつ skeleton 固定も防ぐ:
    //   初回ロードは取得失敗マーカ(空オブジェクト)を commit し renderWorld の非loading 経路で
    //   「取得できませんでした」を出す。bufferedMode は前日 world を維持する。
    //   ただし維持すべき前日 world が無い(null)場合は、維持では skeleton 固定になるため失敗マーカを commit する。
    console.warn("[stats-service] World 取得失敗 (allArtists)", e);
    if (isStaleRun(runId)) return { complete: false };
    if (!bufferedMode || state.sections.world == null) publish({ mainstream: null, geo: [], bestGeo: null, trackStats: [] });
    return { complete: false };
  }
  if (isStaleRun(runId)) return { complete: false };
  // 正規の「履歴ゼロ」は noData として明示 (誤診断ではなく案内表示にする)。
  // bufferedMode は一過性の空応答で前日データを誤って noData 上書きしないよう維持し再取得させる。
  // ただし維持すべき前日 world が無い(null)場合は、維持では skeleton 固定になるため noData を明示する。
  if (!allArtists || allArtists.length === 0) {
    if (!bufferedMode || state.sections.world == null) updateSection("world", { noData: true });
    // genre と同様: bufferedMode で前日も noData(恒久ゼロ履歴)なら complete:true 扱いにし、
    //   complete:false 固定によるゼロ履歴ユーザの毎朝の不要な全タブ再取得ループを止める。
    //   前日が実データの一過性空は従来どおり complete:false で再取得させる。
    const priorNoData = !!(state.sections.world && state.sections.world.noData);
    return { complete: !bufferedMode || priorNoData };
  }
  const artistSet = new Set(allArtists.map((a) => normName(a.name)));

  // --- メインストリーム度 ---
  let mainstream = null;
  if (chartArtists && chartArtists.length > 0) {
    const overlap = chartArtists
      // listeners は renderWorld(overlap は rank/name のみ参照)で未使用のため算出・保存しない。
      .map((a, i) => ({ rank: i + 1, name: a.name || "" }))
      .filter((a) => artistSet.has(normName(a.name)));
    const score = Math.round((overlap.length / chartArtists.length) * 100);
    mainstream = {
      score,
      chartSize: chartArtists.length,
      overlap: overlap.slice(0, 10),
      diagnosis:
        score >= 60 ? "流行ど真ん中！世界のヒットチャートと足並みが揃っています" :
        score >= 40 ? "バランス型。流行も独自路線もどちらも楽しむタイプ" :
        score >= 20 ? "やや独自路線。流行に流されない耳をお持ちです" :
        score >= 5  ? "かなりのディガー。世界の流行とは別の道を歩んでいます" :
                      "完全に独自の音楽世界。あなたの耳は唯一無二です",
    };
  }

  // ★ phase1: メインストリーム度を先行表示。geo/トップ曲は取得中なので pending 印で
  //   renderWorld に skeleton を出させ、空表示「取得できませんでした」のフラッシュを避ける。
  publishProgressive({ mainstream, geo: [], bestGeo: null, trackStats: [], geoPending: true, tracksPending: true });
  // ★ ここで world タブを表示可能にする(compare/rewind と同パターン)。これをしないと
  //   sectionReady.world が finalizeSection(fetchWorld 完全 resolve 後)まで false のままで、
  //   非bufferedMode 初回は phase2(geo/トップ曲)の取得が終わるまで汎用ローディング画面が固定され、
  //   先行算出した mainstream と skeleton が画面に出ない。
  //   bufferedMode では publishProgressive を抑止しており sections.world を更新しないため、
  //   ここで ready 化すると前日 world が無いケースで null を skeleton 表示してしまう。
  //   bufferedMode の ready は computeSectionReady(前日値) と finalizeSection(.finally) が担うので呼ばない。
  if (onReady && !bufferedMode) { try { onReady(); } catch {} }

  // --- 国別チャート照合 と トップ曲の世界統計 を並列取得 (相互依存なし) ---
  const geo = [];
  const trackStats = [];
  await Promise.all([
    // 国別チャート照合
    mapSequential(GEO_COUNTRIES, async ({ label, candidates }) => {
      // 国名表記の候補を順に試し、最初に結果が返ったものを採用する
      // (例: 韓国は "South Korea" → "Korea, Republic of")
      // ★ 二次データ(国別カード)なので withRetry はかけず best-effort で取得する。
      //   直列(mapSequential)ループで withRetry すると、失敗時のバックオフ待機(通常~4s/レート制限~30s)が
      //   国数ぶん直列加算され、表示までの待機が最悪 数十秒〜分に達するため。
      let list = [];
      let caught = false; // この国でいずれかの候補が例外(取得失敗)で終わったか
      for (const country of candidates) {
        list = await cached(`geo:artists:${country}:50`, () => getGeoTopArtists(country, 50), { forceRefresh }).catch(() => { caught = true; return []; });
        if (list && list.length > 0) break;
      }
      if (!list || list.length === 0) {
        // ★ 全候補が例外で取得不能(caught)だった国は degraded 扱い(=次回マウント/再起動の再取得で回復)。
        //   主要4市場(日/米/英/韓)の1つが一過性 throw で翌日まで恒久脱落するのを防ぐ。
        //   - 後続候補が成功(list あり)→ 正常採用。先行候補の例外は無視(break 後はここに来ない)。
        //   - 全候補が例外ゼロの空応答(空200=該当データ無し)→ 障害でないため degraded にしない
        //     (過剰再取得を回避。全国同時の空200は後段 geo.length===0 で異常扱い)。
        if (caught) degraded = true;
        return;
      }
      const heard = list.filter((a) => artistSet.has(normName(a.name)));
      geo.push({
        label,
        total: list.length,
        heard: heard.length,
        pct: Math.round((heard.length / list.length) * 100),
      });
    }, 150, runId),
    // トップ曲の世界での立ち位置 (全期間トップ10曲)。fetchTop と同じキー (top-tracks:<user>:overall:20、ユーザ依存) を共有。
    //   共有による二重取得回避は forceRefresh:false(初回ロード)時のみ有効。forceRefresh:true(日次再取得/手動更新)では
    //   cached() が getCache をスキップし _inflight 合流のみで dedup するため、fetchTop の overall 取得完了後に
    //   ここへ到達すると再取得が走り得る(top-tracks:overall を計2回。二次データ best-effort で実害は数 GET のみ)。
    (async () => {
      // ★ 二次データなので withRetry なし(geo と同方針)。top-tracks が取れない(失敗/空)と
      //   trackStats は空になり、後段 trackStats.length===0 で degraded 化する(全滅のみ異常)。
      const topTracks = await cached(`top-tracks:${user}:overall:20`, () => getTopTracks(user, "overall", 20), { forceRefresh }).catch(() => []);
      await mapSequential((topTracks || []).slice(0, 10), async (t, i) => {
        const artistName = (t.artist && (t.artist.name || t.artist["#text"])) || "";
        if (!artistName || !t.name) return;
        // ★ 単一曲の trackinfo 失敗はその曲を欠落させるだけ(rank 保持で表示順位は崩れない)。
        //   1曲の一過性失敗で world 全体を degraded(=同日全8セクション再取得)にはしない。
        const info = await cached(
          ckey("trackinfo", artistName, t.name, user),
          () => getTrackInfo(artistName, t.name, user),
          { forceRefresh }
        ).catch(() => null);
        if (!info) return;
        const playcount = parseInt(info.playcount || "0", 10);
        const userplaycount = info.userplaycount != null ? parseInt(info.userplaycount, 10) : null;
        trackStats.push({
          // ★ 元の全期間順位を保持(曲が脱落しても表示順位が繰り上がらない)
          rank: i + 1,
          name: t.name || "",
          artist: artistName,
          listeners: parseInt(info.listeners || "0", 10),
          playcount,
          userplaycount,
          // 占有率(推し度)。0.01% 未満は "<0.01" 表示。再生 0 回は null(=非表示。"<0.01%" 誤表示回避)。
          //   0〜100% にクランプする: Last.fm の集計ラグで obscure 曲が userplaycount>playcount を返すと
          //   100% 超の論理破綻表示(例「占有率166.67%」)になるため。matchPct/match 表示の Math.min(100,…) と統一。
          sharePct: playcount > 0 && userplaycount != null && userplaycount > 0
            ? Math.min(100, Math.round((userplaycount / playcount) * 10000) / 100)
            : null,
        });
      }, 150, runId);
      // 並列ループ・脱落があっても表示順を全期間順位に一致させる
      trackStats.sort((a, b) => a.rank - b.rank);
    })(),
  ]);
  if (isStaleRun(runId)) return { complete: false };
  const bestGeo = geo.length ? geo.slice().sort((a, b) => b.pct - a.pct)[0] : null;

  // ★ 主要データの全滅は degraded 扱いにする:
  //   - geo.length===0      = 国別チャート4市場(日/米/英/韓)が全滅
  //   - trackStats.length===0 = トップ曲統計が全件欠落(top-tracks 空 or 全曲 trackinfo 失敗)
  //   いずれも履歴のあるユーザ(allArtists>0 を上で確認済)では恒久的に起こらず一過性異常とみなせる。
  //   これにより:
  //   - bufferedMode: 前日の正常データを空で原子破壊せず維持する(原子差替の趣旨)。
  //   - 非bufferedMode: complete:false を返し、次回 stats マウント/再起動時の startIfNeeded 再取得で
  //     回復させる(同タブ滞在中に自動再取得するタイマーは無い)。
  //   ※単一国/単一曲の欠落(length>=1)は許容する(過剰再取得を避けるため、全滅のみ異常扱い)。
  if (geo.length === 0 || trackStats.length === 0) degraded = true;

  // ★ bufferedMode で一部取得失敗(degraded)時は、前日の正常な world を部分/失敗データで
  //   上書きせず維持する(原子差替の趣旨)。complete:false で同日再取得させる。
  //   ただし維持すべき前日 world が無い(null)場合は、維持では ready=true + sections.world=null の
  //   skeleton 固定になるため、取れた分(部分データ)を commit して表示する。
  if (bufferedMode && degraded) {
    if (state.sections.world == null) {
      publish({ mainstream, geo, bestGeo, trackStats });
    } else {
      console.warn("[stats-service] World: 部分失敗のためバッファ(前日)を維持します");
    }
    return { complete: false };
  }

  // 確定 commit (両モード共通)。bufferedMode はここで原子的に差し替わる。
  publish({ mainstream, geo, bestGeo, trackStats });
  return { complete: !degraded };
}

/**
 * 時間タブ + ダッシュボードの DNA・クイックカード
 *   - 全 recent ページを Worker に流して集計（最も時間がかかる処理）
 *   - 通常モード: 部分結果を順次 UI に反映 (初回ロードのプログレッシブ表示)
 *   - バッファモード: 中間スナップショットは UI に流さず、確定値だけを最後に
 *     反映する。これにより古い表示が乱れず、最後に一気に切り替わる。
 */
async function fetchTimeAndExtras(user, { forceRefresh, bufferedMode = false, runId }) {
  // user_force_refresh は cached() で個別管理されるため、ここでは
  // クリア済みのキャッシュ + 強制取得は不要（iterate 自体はキャッシュ非対象）
  void forceRefresh;

  // ★ Worker は run ローカル (myWorker) に保持し、postMessage / terminate は
  //   すべて myWorker 経由で行う。モジュール変数 worker は cancel()/スタック
  //   復旧からの強制 terminate 用の参照に過ぎない。
  //   以前はモジュール変数を直接使っていたため、旧 run の fetchTimeAndExtras が
  //   (abortFlag リセット後に) 新 run の Worker へ旧データを addBatch したり、
  //   後始末で「現在の」Worker = 新 run の Worker を terminate して時間集計を
  //   破壊する経路があった。
  let myWorker = null;
  try {
    myWorker = new Worker(new URL("../workers/stats-worker.js", import.meta.url), { type: "module" });
  } catch (e) {
    console.warn("[stats-service] Worker 起動失敗", e);
    throw e;
  }
  worker = myWorker; // cancel() からの強制 terminate 用参照

  // 最後に受信したスナップショット (確定 commit に使う)
  let latestSnapshot = null;
  // 最終確定 snapshot(final:true)を実際に受信したか。タイムアウト/Worker無応答経路では false のまま。
  // iterateCompleted(全ページ取得完了)だけで complete を確定すると、最終 addBatch 以降の
  // 数バッチを欠く中間 snapshot を complete:true で固定してしまう(過小集計の確定)ため、
  // 「全ページ取得完了 かつ 最終 snapshot 受信」を complete の条件にする。
  let finalReceived = false;
  // 非バッファモードの中間 commit を間引くためのスロットル。
  // Worker は数バッチ(約600曲)ごとに中間 snapshot を返すため、大量 scrobble の
  // 初回ロード中は commitSnapshot が短時間に何度も走る。これは updateSection("dashboard")
  // / updateSection("time") を通じて以下の再描画を毎バッチ誘発し、ちらつき・
  // CPU 浪費になる:
  //   - ダッシュボードタブ(デフォルト): renderDashboard の全再構築
  //     (DNA・クイックカード等の innerHTML 再生成)
  //   - 時間タブ: sectionReady=false の間はローディング画面の再描画
  //     (確定後の renderTime はチャート 5 個 + ヒートマップ 168 セルを再生成)
  // 中間反映は最大 1 秒に 1 回へ間引き、最終結果は取得完了後に必ず commit する
  // (間引いた最後の差分を確実に反映 = 取りこぼし防止)。
  let lastCommitMs = 0;
  const COMMIT_THROTTLE_MS = 1000;

  // ダッシュボードの DNA・クイックカードと時間タブの snapshot を origin の payload から構築。
  // complete=true は「全ページ取得が完了した最終 snapshot」を意味する。
  // discoveryByMonth(月別の新規アーティスト発見)は降順ページングのため、取得途中
  // (中間 snapshot / 部分取得で中断)の値は初登場月が新しい側に偏った誤データになる。
  // complete のときだけ確定値を反映し、それ以外は空にする(simplifyTimeSnapshot 参照)。
  const commitSnapshot = (payload, complete = false) => {
    if (isStaleRun(runId)) return; // 旧 run のスナップショットで新 state を汚さない
    const timeSection = { snapshot: simplifyTimeSnapshot(payload, complete) };
    updateSection("time", timeSection);
    const dna = buildListeningDNA(payload);
    const quickCards = buildQuickCards(payload);
    if (bufferedMode) {
      // bufferedMode: ダッシュボードの dna/quickCards は base コアと揃えて atomic swap する
      //   (ここで即 updateSection すると base 未着時に「前日コア + 今日 extras」の混在になる)。
      //   bufferedMode の commitSnapshot は最終 commit で1回のみ呼ばれる(中間は onMessage で抑止)。
      _bufDashExtras = { dna, quickCards };
      _bufDashExtrasDone = true;
      tryCommitBufferedDashboard(runId);
    } else {
      const cur = state.sections.dashboard || {};
      updateSection("dashboard", { ...cur, dna, quickCards });
    }
  };

  // Worker からのスナップショット受信
  const onMessage = (e) => {
    const { type, payload } = e.data || {};
    if (type !== "snapshot") return;
    latestSnapshot = payload;
    // バッファモード時は中間スナップショットを UI に反映しない (最後にまとめて commit)。
    // 非バッファモードは中間反映するが、上記スロットルで間引く (最終結果は
    // 取得完了後の確定 commit で必ず反映されるため、間引いても表示は最終的に正確)。
    if (!bufferedMode) {
      const now = Date.now();
      if (now - lastCommitMs >= COMMIT_THROTTLE_MS) {
        lastCommitMs = now;
        commitSnapshot(payload);
      }
    }
  };
  myWorker.addEventListener("message", onMessage);
  // bufferedMode は中間 snapshot を UI 反映しないので Worker 側の中間計算・送信も抑止する。
  myWorker.postMessage({ type: "reset", suppressInterim: bufferedMode });

  let buf = [];
  // 全ページを取得し切ったか(中断/部分取得でないか)。discoveryByMonth の
  // 確定可否に使う(降順ページングのため部分取得では発見月が偏るため)。
  let iterateCompleted = false;
  try {
    for await (const tr of iterateAllRecentTracks(user, {
      // ★ 旧 run になったらページ反復を即打ち切り、無駄な API 呼び出し・リトライ待ちを止める。
      shouldAbort: () => isStaleRun(runId),
      onProgress: ({ page, totalPages }) => {
        if (isStaleRun(runId)) return; // 旧 run の進捗で表示を汚さない
        update({ workerProgress: { page, totalPages } });
      },
    })) {
      if (isStaleRun(runId)) break;
      buf.push(tr);
      if (buf.length >= 200) {
        myWorker.postMessage({ type: "addBatch", tracks: buf });
        buf = [];
        // メインスレッドに譲る（fetch のため）
        await sleep(0);
      }
    }
    if (!isStaleRun(runId) && buf.length) {
      myWorker.postMessage({ type: "addBatch", tracks: buf });
    }
    // 例外なく for await を抜けた = iterateAllRecentTracks が totalPages 到達で
    // 自然終了 = 全ページ取得完了。stale break の場合は完了扱いにしない。
    if (!isStaleRun(runId)) iterateCompleted = true;
  } catch (e) {
    // 部分集計でも残す。エラーは記録するが throw しない（取れた分は表示）
    console.warn("[stats-service] iterateAllRecentTracks 中断", e);
  }

  // Worker に最終スナップショット要求 + 終了待ち
  if (!isStaleRun(runId)) {
    // 中間 commit 経路(onMessage)を閉じてから最終 snapshot を待つ。最終応答が
    // onMessage と finalHandler の両方で処理され commit が二重に走る(再描画が
    // 一度余計に走る)のを防ぐ(SVC-4nit)。
    myWorker.removeEventListener("message", onMessage);
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finalHandler = (e) => {
        // ★ final:true の応答のみで確定する。間引きの中間 snapshot がメインスレッドの
        //   メッセージキューに残っていて先に届くことがあり、その payload は最後の数バッチを
        //   含まないため、`type==="snapshot"` だけで受理すると過小集計を確定 commit し得る。
        //   明示要求 (最終確定) は worker 側で final:true を立てて返すので、それを待つ。
        if (e.data?.type === "snapshot" && e.data.final) {
          finalReceived = true;
          // onMessage を解除済みのため、最終 snapshot はここで latestSnapshot に
          // 反映する。これをしないと、Worker 側の snapshot 間引き(WS-2)で最後の
          // 数バッチが中間 snapshot に含まれないまま、古い latestSnapshot で確定
          // commit してしまう(集計値が最終ページ分だけ過小になる)。
          latestSnapshot = e.data.payload;
          myWorker.removeEventListener("message", finalHandler);
          settled = true;
          if (timer) { clearTimeout(timer); timer = null; } // 冗長タイマーを解除
          resolve();
        }
      };
      myWorker.addEventListener("message", finalHandler);
      // 万一スナップショットが返らなくても 3 秒で前に進む（finalHandler も解除）。
      // ここに落ちるのは Worker が無応答(ハング/クラッシュ等)の異常時のみ。握り潰さず
      // 警告を残し、最後に受信済みの中間 snapshot(あれば)で確定 commit にフォールバックする。
      // ★ タイマーは postMessage より先に張る。こうしておくと postMessage が投げた場合に
      //   catch 側で確実に clearTimeout でき、不要なタイマーが 3 秒後に空打ちするのを防げる。
      timer = setTimeout(() => {
        try { myWorker.removeEventListener("message", finalHandler); } catch {}
        if (!settled) {
          console.warn("[stats-service] 最終 snapshot がタイムアウト(3s)。Worker 無応答の可能性。中間 snapshot で確定します");
        }
        resolve();
      }, 3000);
      try {
        myWorker.postMessage({ type: "snapshot" });
      } catch {
        // postMessage が投げる = Worker は既に終了済み。応答は来ないのでタイマーと
        // リスナーを即時片付け、待たずに先へ進む(冗長タイマーの空打ちを残さない)。
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { myWorker.removeEventListener("message", finalHandler); } catch {}
        resolve();
      }
    });
  }

  // 取得完了後は最終スナップショットを必ず確定 commit する。
  //   - バッファモード: 中間反映していないため、ここで一気に時間タブ + ダッシュボードを切替
  //   - 非バッファモード: 中間反映をスロットルで間引いた分、最後の差分を確実に反映する
  // どちらも「最新の完全な集計結果」を表示するために必要 (これが無いと
  // 非バッファ時に最後の数バッチ分が次回更新まで欠落し得る)。
  // (commitSnapshot 内部の世代ガードにより旧 run はここでも no-op)
  // latestSnapshot が null = 中間 snapshot も最終 snapshot も一度も届かなかった
  // (Worker が最初のメッセージ前にクラッシュ/無応答)異常時のみ。その場合は上の
  // タイムアウト経路で既に警告済みで、ここは commit せず既存表示を維持する。
  // ★ 「全ページ取得完了 かつ 最終 snapshot を実際に受信」したときだけ完了確定とする。
  //   タイムアウト/Worker無応答で final:true を受信できなかった場合は、latestSnapshot が
  //   最後の中間 snapshot(最終数バッチを欠く過小集計)なので complete:false 扱いにし、
  //   誤った過小集計・偏った発見履歴を complete:true で固定しない(同日再取得で自己回復)。
  const effectiveComplete = iterateCompleted && finalReceived;
  if (latestSnapshot) {
    // ★ bufferedMode（前回データを表示中のリフレッシュ）で未完了(部分 or 最終snapshot未確定)の
    //   場合は、部分スナップショットで確定 commit しない。さもないと表示中の正しい前回データを
    //   「集計完了(少件数) + 発見の歴史が集計中のまま(discoveryByMonth 空)」という誤った
    //   部分データで上書きしてしまう（翌日更新時に時間タブが壊れる不具合の安全網）。
    //   前回データを維持し、次回更新で再取得させる。
    //   初回ロード(非buffered)は表示すべき前回データが無いため、部分でも反映する。
    //   ★ ただし bufferedMode でも維持すべき前回 time が無い(null=前回 run が dashboard だけ保存し
    //     time 未確定だった等)場合は、維持すると ready=true + time=null で「データがありません」が
    //     固定されるため、未完了でも取れた分を commit する(world/genre/top の前日無し時 commit と同方針。
    //     discoveryByMonth は complete:false で空=集計中表示、complete:false で同日再取得し確定値に回復)。
    if (bufferedMode && !effectiveComplete && state.sections.time != null) {
      console.warn("[stats-service] 時間集計が未完了のため、バッファ(前回の時間データ)を維持します");
    } else {
      commitSnapshot(latestSnapshot, effectiveComplete);
    }
  }

  // bufferedMode: ダッシュボード extras を atomic swap バリアへ通知する。上の commitSnapshot を
  //   スキップした未完了経路(時間集計未完 + 前日 time 維持)や latestSnapshot=null(Worker 無応答)でも
  //   必ず extras-done を立て、base 側だけで commit できずダッシュボードが前日データのまま固定されるのを
  //   防ぐ。commitSnapshot 内で既に done 済みなら no-op。_bufDashExtras 未設定時は null のまま →
  //   tryCommit が core 引き継ぎの前日 dna/quickCards を使う(complete:false で同日再取得し回復)。
  if (bufferedMode && !isStaleRun(runId) && !_bufDashExtrasDone) {
    _bufDashExtrasDone = true;
    tryCommitBufferedDashboard(runId);
  }

  // 後始末は自分の Worker のみ terminate し、モジュール参照は
  // 「まだ自分を指している場合」だけ null に戻す (新 run の Worker を壊さない)。
  try { myWorker.terminate(); } catch {}
  if (worker === myWorker) worker = null;

  // この run で全期間履歴を完走し最終 snapshot まで確定できたか(=時間タブが新データで確定したか)を返す。
  // runFetch が保存レコードの complete 判定に使う(未完走/タイムアウトなら同日再取得を促す)。
  return { complete: effectiveComplete };
}

function simplifyTimeSnapshot(snap, complete = false) {
  // Worker からのスナップショットはほぼ整形済みなのでそのまま保持
  // （heatmap 7x24 = 168 numbers、byMonth = 月別エントリ等、合計 数十 KB 程度）
  return {
    total: snap.total || 0,
    firstAt: snap.firstAt,
    lastAt: snap.lastAt,
    byMonth: snap.byMonth || [],
    byYear: snap.byYear || [],
    heatmap: snap.heatmap || [],
    topArtists: snap.topArtists || {},
    uniqueArtists: snap.uniqueArtists || 0,
    timeOfDay: snap.timeOfDay || null,
    weekdayWeekend: snap.weekdayWeekend || null,
    // 月別の新規アーティスト発見数 ([["YYYY-MM", n], ...])。
    // ★ 全ページ取得が完了した最終 snapshot のみ確定値を入れる。
    //   recent は降順ページング(新→古)で流れるため、取得途中(中間 snapshot や
    //   部分取得で中断)の artistFirstSeen は「取得できた範囲で最も古い uts」=
    //   本来の初登場より新しい月に偏った誤データになる。未完了時は空配列にして
    //   view 側で「集計中」扱いにし、誤った発見履歴を表示・保存しない。
    discoveryByMonth: complete ? (snap.discoveryByMonth || []) : [],
  };
}

function buildQuickCards(snap) {
  const totalSeconds = (snap.total || 0) * 210;
  const totalHours = Math.round(totalSeconds / 3600);
  const totalDays = Math.round(totalHours / 24);
  return {
    totalHours,
    totalDays,
    avgPerDay: snap.avgPerDay ? snap.avgPerDay.toFixed(1) : "—",
    maxDay: snap.maxDay ? `${snap.maxDay.count} 曲` : "—",
    maxDayDate: snap.maxDay ? snap.maxDay.date : "",
    streak: snap.streak != null ? `${snap.streak} 日` : "—",
    uniqueTracks: snap.uniqueTracks || 0,
    uniqueArtists: snap.uniqueArtists || 0,
    totalScrobbles: snap.total || 0,
  };
}

function buildListeningDNA(snap) {
  const lines = [];
  if (snap.timeOfDay) {
    const t = snap.timeOfDay;
    const total = t.night + t.morning + t.day + t.evening;
    if (total > 0) {
      const evening = t.evening + t.night;
      const morning = t.morning + t.day;
      if (evening > morning * 1.5) lines.push("🌙 夜型のリスナー");
      else if (morning > evening * 1.5) lines.push("☀️ 朝型のリスナー");
      else lines.push("🌗 終日まんべんなく聴くタイプ");
    }
  }
  if (snap.weekdayWeekend) {
    const { weekday, weekend } = snap.weekdayWeekend;
    const weekendDays = (weekday + weekend) > 0 ? weekend / 2 : 0;
    const weekdayDays = (weekday + weekend) > 0 ? weekday / 5 : 0;
    if (weekendDays > weekdayDays * 1.3) lines.push("🏖 週末派");
    else if (weekdayDays > weekendDays * 1.3) lines.push("💼 平日派");
  }
  if (typeof snap.repeatRate === "number" && snap.repeatRate > 0) {
    const pct = Math.round(snap.repeatRate * 100);
    if (pct >= 70) lines.push(`📚 リピート派 (${pct}%)`);
    else if (pct >= 40) lines.push(`🔁 リピート併用 (${pct}%)`);
    else if (pct > 0) lines.push(`🆕 新規開拓型 (リピート ${pct}%)`);
  }
  if (snap.topArtists && snap.total > 0) {
    // ★ Object.entries は整数相当のキー(純数字アーティスト名 "311"/"10"/"1975" 等)を
    //   昇順で先頭に並べ替えるため、再生数降順を保証するよう明示ソートしてから上位5を取る。
    const entries = Object.entries(snap.topArtists).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const top5Sum = entries.reduce((s, [, v]) => s + v, 0);
    const pct = Math.round(top5Sum / snap.total * 100);
    if (pct >= 50) lines.push(`🎯 集中型 (Top 5 が ${pct}%)`);
    else if (pct < 25) lines.push(`🌈 幅広型 (Top 5 は ${pct}% のみ)`);
  }
  if (snap.streak >= 30) lines.push(`🔥 ${snap.streak} 日連続聴取中`);
  else if (snap.streak >= 7) lines.push(`✨ ${snap.streak} 日連続`);
  return lines;
}
