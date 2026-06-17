/**
 * 統計集計 Worker
 *
 * メインスレッドをブロックしないため、大量データの集計はここで行う。
 *
 * メッセージプロトコル:
 *   IN:
 *     { type: "reset" }
 *     { type: "addBatch", tracks: [...] }   // track-like の配列
 *     { type: "snapshot" }                  最新の集計結果を返す(最終確定要求)
 *   OUT:
 *     { type: "snapshot", payload: {...} }              中間スナップショット(間引き送信)
 *     { type: "snapshot", payload: {...}, final: true } 明示要求への応答(最終確定)
 *     { type: "ready" }
 *
 *   ※ 中間と最終を final フラグで区別する。service 側は final:true のみで確定 commit
 *      し、キューに残った中間 snapshot を取りこぼさない。
 *
 * track-like:
 *   { date?: { uts: "<unix>" }, name, artist?: { "#text" }, album?: { "#text" } }
 *
 * 集計対象:
 *   - byMonth: { "YYYY-MM": count }
 *   - byYear:  { "YYYY":    count }
 *   - heatmap: 7x24 (week x hour) のカウント
 *   - artistDist: { artistName: count }
 *   - total, firstAt, lastAt
 *
 * タイムゾーン:
 *   すべての日付計算は JST (Asia/Tokyo = UTC+9、サマータイムなし) で行う。
 *   UTC ms に +9h した値を UTC メソッドで読むことでローカルタイムゾーン依存を排除する。
 */

/* ============ JST ユーティリティ ============ */

/**
 * UTC ミリ秒 → JST の "YYYY-MM-DD" 文字列
 */
function getDateKeyJST(utcMs) {
  // JST = UTC+9（固定、サマータイムなし）
  const d = new Date(utcMs + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Unix 秒 → JST での日時コンポーネント
 * @returns {{ year, month, day, weekday, hour }}
 */
function toJSTComponents(uts) {
  const d = new Date(uts * 1000 + 9 * 3600 * 1000);
  return {
    year:    d.getUTCFullYear(),
    month:   d.getUTCMonth() + 1,
    day:     d.getUTCDate(),
    weekday: d.getUTCDay(),    // 0=日, 1=月, ..., 6=土
    hour:    d.getUTCHours(),
  };
}

// trackDist のキー区切り(通常データに出ない制御文字 Unit Separator。'|' 衝突回避)
const TRACK_KEY_SEP = String.fromCharCode(31);

const state = {
  byMonth: Object.create(null),
  byYear: Object.create(null),
  byDay: Object.create(null),       // "YYYY-MM-DD": count (連続日数・最大日算出用)
  heatmap: Array.from({ length: 7 }, () => new Array(24).fill(0)),
  artistDist: Object.create(null),
  // 注: trackDist/artistFirstSeen/artistDist は全ユニーク曲・アーティストを保持する。
  // 数十万 scrobble のヘビーユーザでは数万エントリ(数十MB)に達しうるが、
  // 集計に全件必要なため reset まで解放しない意図的なトレードオフ。
  trackDist: Object.create(null),   // "artist|track": count (リピート率算出用)
  artistFirstSeen: Object.create(null), // アーティスト名: 初登場 unix (Discovery rate 用)
  total: 0,
  firstAt: null,
  lastAt: null,
};

// 中間 snapshot 送信の間引き用カウンタ。
// snapshot() は byDay/trackDist/artistFirstSeen 全走査 + heatmap/streak 計算を
// 毎回行うため、addBatch (200曲) ごとに全再計算 + postMessage すると大量 scrobble で
// 無駄が大きい。中間反映は数バッチに1回に間引く (UI 側にも 1 秒スロットルがある)。
// 最終確定は service が明示 snapshot 要求するため取りこぼさない。
let batchesSinceSnapshot = 0;
const SNAPSHOT_EVERY_N_BATCHES = 3; // 約600曲ごとに中間スナップショット
// bufferedMode(翌日更新で前日データ表示中)は中間 snapshot を UI に反映しないため、
// Worker 側でも中間 snapshot の計算・送信を抑止する(無駄な再集計とメインスレッドの
// structured-clone デシリアライズを省く)。最終確定は明示 snapshot 要求(final:true)で必ず送る。
let suppressInterim = false;

self.addEventListener("message", (e) => {
  const msg = e.data || {};
  if (msg.type === "reset") {
    resetState();
    batchesSinceSnapshot = 0;
    suppressInterim = !!msg.suppressInterim;
    self.postMessage({ type: "ready" });
  } else if (msg.type === "addBatch") {
    addBatch(msg.tracks || []);
    // 進捗表示用の中間スナップショットは数バッチに1回だけ送る(bufferedMode は抑止)
    batchesSinceSnapshot++;
    if (!suppressInterim && batchesSinceSnapshot >= SNAPSHOT_EVERY_N_BATCHES) {
      batchesSinceSnapshot = 0;
      self.postMessage({ type: "snapshot", payload: snapshot() });
    }
  } else if (msg.type === "snapshot") {
    // 明示要求 (最終確定) 時は必ず計算して送る。
    // ★ final:true を付与し、間引きで送る「中間 snapshot」と区別できるようにする。
    //   service 側 finalHandler はこのフラグが立った応答のみで確定する。
    //   こうしないと、直前にキュー投入済みの中間 snapshot(最後の数バッチを含まない)が
    //   先に届いた場合に finalHandler がそれを掴んでしまい、過小集計を確定 commit し得る
    //   (WS-2 の間引きで最終ページ分を取りこぼす不具合の根本修正)。
    batchesSinceSnapshot = 0;
    self.postMessage({ type: "snapshot", payload: snapshot(true), final: true });
  }
});

function resetState() {
  state.byMonth = Object.create(null);
  state.byYear = Object.create(null);
  state.byDay = Object.create(null);
  state.heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  state.artistDist = Object.create(null);
  state.trackDist = Object.create(null);
  state.artistFirstSeen = Object.create(null);
  state.total = 0;
  state.firstAt = null;
  state.lastAt = null;
}

function addBatch(tracks) {
  for (const t of tracks) {
    // 今再生中のトラックは date が無いのでスキップ
    const uts = t && t.date && t.date.uts ? parseInt(t.date.uts, 10) : 0;
    if (!uts) continue;
    state.total++;
    if (!state.firstAt || uts < state.firstAt) state.firstAt = uts;
    if (!state.lastAt || uts > state.lastAt) state.lastAt = uts;
    // 日付計算は JST で行う（ローカルタイムゾーン依存を排除）
    const jst = toJSTComponents(uts);
    const monthKey = `${jst.year}-${String(jst.month).padStart(2, "0")}`;
    const dayKey = `${monthKey}-${String(jst.day).padStart(2, "0")}`;
    state.byMonth[monthKey] = (state.byMonth[monthKey] || 0) + 1;
    state.byYear[jst.year] = (state.byYear[jst.year] || 0) + 1;
    state.byDay[dayKey] = (state.byDay[dayKey] || 0) + 1;
    // heatmap（曜日・時刻も JST）
    state.heatmap[jst.weekday][jst.hour]++;
    // artist (Discovery 用に初登場時刻を覚える)
    const artist = (t.artist && (t.artist["#text"] || t.artist.name)) || "(不明)";
    state.artistDist[artist] = (state.artistDist[artist] || 0) + 1;
    if (!state.artistFirstSeen[artist] || uts < state.artistFirstSeen[artist]) {
      state.artistFirstSeen[artist] = uts;
    }
    // track (リピート率用)。区切りは通常データに出ない制御文字(Unit Separator)で、
    // 曲名/アーティスト名に '|' を含む場合のキー衝突を防ぐ。
    const trackName = t.name || "(不明)";
    const tk = artist + TRACK_KEY_SEP + trackName;
    state.trackDist[tk] = (state.trackDist[tk] || 0) + 1;
  }
}

function snapshot(final = false) {
  // artistDist を上位 N に絞る
  const topArtistEntries = Object.entries(state.artistDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  const topArtists = Object.fromEntries(topArtistEntries);
  // ユニークアーティスト数 (重複なしの異なるアーティスト数)
  const uniqueArtists = Object.keys(state.artistDist).length;

  // byMonth / byYear をキー昇順の配列に (byDay は maxDay 算出に使うだけでソート不要)
  const monthEntries = Object.entries(state.byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const yearEntries = Object.entries(state.byYear).sort((a, b) => +a[0] - +b[0]);

  // 最大1日 scrobble (byDay を直接走査。ソート不要 = O(n))
  let maxDay = null;
  for (const k in state.byDay) {
    const v = state.byDay[k];
    if (!maxDay || v > maxDay.count) maxDay = { date: k, count: v };
  }

  // 平均 scrobble / 日。分母は「実際に聴いた日数」(byDay のユニーク日数)。
  // 旧実装は (lastAt-firstAt) の暦日数で割っていたが、最後の再生までの期間で
  // 割ると直近に聴いていない日が分母から漏れて過大評価になり、逆に「今日まで」で
  // 割ると長期休眠ユーザで過小評価になる。聴いた日だけの平均が最も誤解が少ない
  // (表示ラベルも「聴いた日あたり」とする)。
  let avgPerDay = 0;
  const activeDays = Object.keys(state.byDay).length;
  if (activeDays > 0 && state.total > 0) {
    avgPerDay = state.total / activeDays;
  }

  // 連続スクロブル日数（今日から遡って何日連続か）
  // 日付判定は JST で行う（UTC ms を getDateKeyJST に渡す）
  let streak = 0;
  let checkUtcMs = Date.now();
  // 上限は 366。「今日まだ未scrobble」分岐(i===0)で1日消費しても、昨日から
  // 365 日分を正しく遡れるようにする(off-by-one 回避)。
  for (let i = 0; i < 366; i++) {
    const k = getDateKeyJST(checkUtcMs);
    if ((state.byDay[k] || 0) > 0) {
      streak++;
      checkUtcMs -= 86400 * 1000;
    } else if (i === 0) {
      // 今日まだ scrobble していない場合は昨日からカウント開始
      checkUtcMs -= 86400 * 1000;
    } else {
      break;
    }
  }

  // リピート率: 「2回以上聴いたトラックの聴取回数合計 / 全体」
  let repeatedSum = 0;
  let uniqueTracks = 0;
  for (const v of Object.values(state.trackDist)) {
    uniqueTracks++;
    if (v >= 2) repeatedSum += v;
  }
  const repeatRate = state.total ? repeatedSum / state.total : 0;

  // Discovery rate: 月別新規アーティスト発見数（JST 基準）。
  //   ★ 全期間取得完了(final)時のみ計算する。中間 snapshot では service 側が complete:false として
  //     破棄する(降順ページングで途中は発見月が偏るため。DC-1)ので、全 artistFirstSeen の全走査 +
  //     structured-clone を中間でも毎回行うのは無駄。final のみ算出し、中間は空配列を返す。
  let discoveryEntries = [];
  if (final) {
    const discoveryByMonth = Object.create(null);
    for (const [, firstUts] of Object.entries(state.artistFirstSeen)) {
      const dateKey = getDateKeyJST(firstUts * 1000); // "YYYY-MM-DD"
      const k = dateKey.substring(0, 7);              // "YYYY-MM"
      discoveryByMonth[k] = (discoveryByMonth[k] || 0) + 1;
    }
    discoveryEntries = Object.entries(discoveryByMonth).sort((a, b) => a[0].localeCompare(b[0]));
  }

  // 時間帯 4 セグメント (深夜 0-5 / 朝 6-11 / 昼 12-17 / 夜 18-23)
  const timeOfDay = { night: 0, morning: 0, day: 0, evening: 0 };
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      const v = state.heatmap[dow][h];
      if (h < 6) timeOfDay.night += v;
      else if (h < 12) timeOfDay.morning += v;
      else if (h < 18) timeOfDay.day += v;
      else timeOfDay.evening += v;
    }
  }
  // 平日 vs 週末
  const weekdayWeekend = { weekday: 0, weekend: 0 };
  for (let dow = 0; dow < 7; dow++) {
    const sum = state.heatmap[dow].reduce((s, v) => s + v, 0);
    if (dow === 0 || dow === 6) weekdayWeekend.weekend += sum;
    else weekdayWeekend.weekday += sum;
  }

  return {
    total: state.total,
    firstAt: state.firstAt,
    lastAt: state.lastAt,
    byMonth: monthEntries,
    byYear: yearEntries,
    heatmap: state.heatmap,
    topArtists,
    uniqueArtists,
    // Phase 1 で追加
    avgPerDay,
    maxDay,
    streak,
    uniqueTracks,
    repeatRate,
    // Phase 2 / 3 用に集計しておく
    discoveryByMonth: discoveryEntries,
    timeOfDay,
    weekdayWeekend,
    // dayEntries は重いので必要時のみ
  };
}
