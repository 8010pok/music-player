/**
 * 統計画面の純粋ロジック単体テスト
 *
 * 実行: node tests/test-pure-logic.mjs
 *
 * 対象ロジックは src ファイルからコピーして閉じた形でテストする
 * (元コードに変更があったらここも追従させる必要あり)
 *
 * Note: JST 系ロジック(getJSTDateString / monthsAgoUnix / yearsAgoUnix /
 *       getDateKeyJST 等)は端末タイムゾーンに依存しない実装である。それを実証する
 *       ため、あえて process.env.TZ を非 JST (America/New_York) に固定して実行する。
 *       旧ローカル時刻実装ならこの設定で期待値が崩れるが、JST 固定実装は合格する。
 */

// ★ あえて非 JST の TZ に固定し、JST 計算が端末 TZ に依存しないことを実証する
process.env.TZ = "America/New_York";

/* ============ ミニマルテストフレームワーク ============ */

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    const m = `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(m);
    console.error(`  ✗ ${m}`);
  }
}

function describe(name, fn) {
  console.log(`\n=== ${name} ===`);
  fn();
}

/* ============ stats-storage.js: getJSTDateString ============ */

function getJSTDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

describe("getJSTDateString", () => {
  // UTC 2026-01-15 12:00:00 → JST 2026-01-15 21:00 → "2026-01-15"
  assertEqual(
    getJSTDateString(new Date(Date.UTC(2026, 0, 15, 12, 0, 0))),
    "2026-01-15",
    "UTC 12:00 → 同日 JST"
  );
  // UTC 2026-01-15 15:00:00 → JST 2026-01-16 00:00 → "2026-01-16"
  assertEqual(
    getJSTDateString(new Date(Date.UTC(2026, 0, 15, 15, 0, 0))),
    "2026-01-16",
    "UTC 15:00 → 翌日 JST"
  );
  // UTC 2026-01-15 14:59:59 → JST 2026-01-15 23:59 → "2026-01-15"
  assertEqual(
    getJSTDateString(new Date(Date.UTC(2026, 0, 15, 14, 59, 59))),
    "2026-01-15",
    "UTC 14:59 → 同日 JST (境界の直前)"
  );
  // UTC 2025-12-31 16:00:00 → JST 2026-01-01 01:00 → "2026-01-01"
  assertEqual(
    getJSTDateString(new Date(Date.UTC(2025, 11, 31, 16, 0, 0))),
    "2026-01-01",
    "年越え: UTC 12/31 16:00 → 翌年 JST"
  );
  // UTC 2026-12-31 14:59:59 → JST 2026-12-31 23:59 → "2026-12-31"
  assertEqual(
    getJSTDateString(new Date(Date.UTC(2026, 11, 31, 14, 59, 59))),
    "2026-12-31",
    "年越え直前: UTC 12/31 14:59 → 同日 JST"
  );
});

/* ============ stats-compare.js: computeRange ============ */

// 本番 stats-compare.js と同一実装 (JST=UTC+9 固定・月末/うるう日クランプ付き)。
const JST_OFFSET_MS = 9 * 3600 * 1000;
function monthsAgoUnix(months, baseTs = Date.now()) {
  const d = new Date(baseTs + JST_OFFSET_MS);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return Math.floor((d.getTime() - JST_OFFSET_MS) / 1000);
}
function yearsAgoUnix(years, baseTs = Date.now()) {
  const d = new Date(baseTs + JST_OFFSET_MS);
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return Math.floor((d.getTime() - JST_OFFSET_MS) / 1000);
}
// unix 秒を JST の [年, 月(1-12), 日] に分解する検証用ヘルパー
function jstYMD(unixSec) {
  const d = new Date(unixSec * 1000 + JST_OFFSET_MS);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

function computeRange(range, now = Date.now()) {
  if (range === "week") {
    const nowUnix = Math.floor(now / 1000);
    const oneWeek = 7 * 24 * 60 * 60;
    return {
      current:  { from: nowUnix - oneWeek, to: nowUnix, label: "今週" },
      previous: { from: nowUnix - 2 * oneWeek, to: nowUnix - oneWeek, label: "先週" },
    };
  }
  if (range === "month") {
    const nowUnix = Math.floor(now / 1000);
    return {
      current:  { from: monthsAgoUnix(1, now), to: nowUnix, label: "今月(直近1ヶ月)" },
      previous: { from: monthsAgoUnix(2, now), to: monthsAgoUnix(1, now), label: "先月(その前1ヶ月)" },
    };
  }
  if (range === "year") {
    const nowUnix = Math.floor(now / 1000);
    return {
      current:  { from: yearsAgoUnix(1, now), to: nowUnix, label: "今年(直近12ヶ月)" },
      previous: { from: yearsAgoUnix(2, now), to: yearsAgoUnix(1, now), label: "去年" },
    };
  }
  throw new Error(`unknown range: ${range}`);
}

describe("computeRange", () => {
  const now = Date.UTC(2026, 4, 25, 0, 0, 0); // 2026-05-25 UTC
  const nowUnix = Math.floor(now / 1000);
  const ONE_WEEK = 7 * 24 * 60 * 60;

  const w = computeRange("week", now);
  assertEqual(w.current.from, nowUnix - ONE_WEEK, "week current.from = now - 1week");
  assertEqual(w.current.to, nowUnix, "week current.to = now");
  assertEqual(w.previous.from, nowUnix - 2 * ONE_WEEK, "week previous.from = now - 2week");
  assertEqual(w.previous.to, nowUnix - ONE_WEEK, "week previous.to = now - 1week");

  const m = computeRange("month", now);
  assert(m.current.to === nowUnix, "month current.to = now");
  assert(m.current.from < nowUnix, "month current.from < now");
  assert(m.previous.from < m.current.from, "month previous.from < current.from");
  assert(m.previous.to === m.current.from, "month境界連続: previous.to === current.from");

  const y = computeRange("year", now);
  assert(y.current.to === nowUnix, "year current.to = now");
  assert(y.previous.to === y.current.from, "year境界連続: previous.to === current.from");

  let threw = false;
  try { computeRange("invalid", now); } catch { threw = true; }
  assert(threw, "computeRange('invalid') が throw する");
});

/* ============ monthsAgoUnix/yearsAgoUnix: 月末・うるう日クランプ (JST1修正) ============ */

describe("monthsAgoUnix/yearsAgoUnix: 月末・うるう日クランプ", () => {
  // 基準 JST 2026-03-31 12:00 (= UTC 2026-03-31 03:00)。Feb に 31 日は無い。
  const mar31 = Date.UTC(2026, 2, 31, 3, 0, 0);
  assertEqual(jstYMD(monthsAgoUnix(1, mar31)), [2026, 2, 28],
    "3/31 の1ヶ月前 → 2/28 (旧実装の 3/3 あふれを修正)");
  assertEqual(jstYMD(monthsAgoUnix(2, mar31)), [2026, 1, 31],
    "3/31 の2ヶ月前 → 1/31");

  // 5/31 → 4/30 (4月は30日まで)
  const may31 = Date.UTC(2026, 4, 31, 3, 0, 0);
  assertEqual(jstYMD(monthsAgoUnix(1, may31)), [2026, 4, 30],
    "5/31 の1ヶ月前 → 4/30");

  // 通常日は同日を保持
  const jun15 = Date.UTC(2026, 5, 15, 3, 0, 0);
  assertEqual(jstYMD(monthsAgoUnix(1, jun15)), [2026, 5, 15], "6/15 の1ヶ月前 → 5/15 (同日保持)");
  assertEqual(jstYMD(yearsAgoUnix(1, jun15)), [2025, 6, 15], "6/15 の1年前 → 2025-6-15 (同日保持)");

  // うるう日 2024-02-29 の1年前 → 2023-02-28 (3/1 にあふれない)
  const feb29 = Date.UTC(2024, 1, 29, 3, 0, 0);
  assertEqual(jstYMD(yearsAgoUnix(1, feb29)), [2023, 2, 28],
    "2/29 の1年前 → 2023-2-28 (うるう日クランプ)");

  // 月境界連続性は維持されている (previous.to === current.from)
  const m = computeRange("month", mar31);
  assert(m.previous.to === m.current.from, "クランプ後も月境界は連続 (previous.to === current.from)");
});

/* ============ stats-service.js: buildWeekDelta (折衷案の差分組み立て) ============ */

function buildWeekDelta(cur, prev) {
  const hasPrev = prev != null;
  const diff = hasPrev ? cur - prev : null;
  const sign = hasPrev && diff > 0 ? "+" : "";
  const pct = hasPrev && prev > 0 ? Math.round((diff / prev) * 100) : null;
  const arrow = !hasPrev ? "—" : diff > 0 ? "📈" : diff < 0 ? "📉" : "➖";
  return { cur, prev, diff, sign, pct, arrow, hasPrev };
}

describe("buildWeekDelta", () => {
  assertEqual(buildWeekDelta(120, 80),
    { cur: 120, prev: 80, diff: 40, sign: "+", pct: 50, arrow: "📈", hasPrev: true }, "増加");
  assertEqual(buildWeekDelta(60, 80),
    { cur: 60, prev: 80, diff: -20, sign: "", pct: -25, arrow: "📉", hasPrev: true }, "減少");
  assertEqual(buildWeekDelta(80, 80),
    { cur: 80, prev: 80, diff: 0, sign: "", pct: 0, arrow: "➖", hasPrev: true }, "同値");
  assertEqual(buildWeekDelta(50, 0),
    { cur: 50, prev: 0, diff: 50, sign: "+", pct: null, arrow: "📈", hasPrev: true }, "prev=0 は0除算回避でpct=null");
  assertEqual(buildWeekDelta(50, null),
    { cur: 50, prev: null, diff: null, sign: "", pct: null, arrow: "—", hasPrev: false }, "prev=null は先週比を省略");
});

/* ============ stats-service.js: ライブ更新の週サマリー同期 (WK1修正) ============ */

describe("ライブ更新の週サマリー同期 (rolling由来時のみ)", () => {
  // 本番 doDashboardLiveUpdate の同期判定と同一ロジック。
  //   freshPrev: ライブで取得した rolling prev(prevRes.value、取得失敗時は null)。
  //   分岐1: 既に rolling 由来(curFromRolling) → cur を rolling 同期、prev も rolling で最新化
  //          (freshPrev が null なら ws.prev を据え置き)。
  //   分岐2: chart 由来でも cur(wkCur)と prev(freshPrev)の両方が rolling で揃えば rolling 定義へ昇格。
  //   いずれも cur だけ rolling / prev だけ chart の定義混在は作らない。
  function syncWeekSummary(ws, wkCur, freshPrev) {
    const prevOk = freshPrev != null;
    if (ws && wkCur != null && ws.curFromRolling) {
      const p = prevOk ? freshPrev : ws.prev;
      return { ...ws, ...buildWeekDelta(wkCur, p), topName: ws.topName, curFromRolling: true };
    }
    if (ws && wkCur != null && !ws.curFromRolling && prevOk) {
      return { ...ws, ...buildWeekDelta(wkCur, freshPrev), topName: ws.topName, curFromRolling: true };
    }
    return ws; // 据え置き
  }
  // rolling 由来 → cur 同期 & diff 再計算 (freshPrev 無しなら prev/topName は据え置き)
  const wsRolling = { cur: 100, prev: 80, diff: 20, sign: "+", pct: 25, arrow: "📈", hasPrev: true, topName: "A", curFromRolling: true };
  const s1 = syncWeekSummary(wsRolling, 120);
  assertEqual([s1.cur, s1.prev, s1.diff, s1.pct], [120, 80, 40, 50], "rolling由来: cur同期しdiff再計算");
  assertEqual(s1.topName, "A", "topName は据え置き");
  // rolling 由来 + freshPrev 成功 → prev も rolling で最新化
  const s1b = syncWeekSummary(wsRolling, 120, 70);
  assertEqual([s1b.cur, s1b.prev, s1b.diff], [120, 70, 50], "rolling由来+freshPrev: prevもrolling最新化");
  // chart 由来 + prev 取得失敗 → 据え置き (rolling cur で汚さない = 混在防止)
  const wsChart = { cur: 200, prev: 180, diff: 20, sign: "+", pct: 11, arrow: "📈", hasPrev: true, topName: "B", curFromRolling: false };
  assertEqual(syncWeekSummary(wsChart, 120).cur, 200, "chart由来+prev失敗: 同期せず据え置き (混在防止)");
  assertEqual(syncWeekSummary(wsChart, 120, null).cur, 200, "chart由来+prev=null: 昇格せず据え置き");
  // chart 由来 + cur/prev とも rolling が揃う → rolling 定義へ昇格
  const promoted = syncWeekSummary(wsChart, 120, 90);
  assertEqual([promoted.cur, promoted.prev, promoted.diff, promoted.curFromRolling], [120, 90, 30, true], "chart由来+rolling両揃い: rolling定義へ昇格");
  // prev 無し rolling → cur 更新, 先週比は省略継続
  const wsNoPrev = { cur: 100, prev: null, diff: null, sign: "", pct: null, arrow: "—", hasPrev: false, topName: "C", curFromRolling: true };
  const s3 = syncWeekSummary(wsNoPrev, 130);
  assertEqual([s3.cur, s3.hasPrev, s3.diff], [130, false, null], "prev無しrolling: cur更新, 先週比は省略継続");
});

/* ============ stats-compare.js: filterWeeks ============ */

function filterWeeks(weekList, fromUnix, toUnix) {
  return weekList.filter((w) => w.to >= fromUnix && w.from <= toUnix);
}

describe("filterWeeks", () => {
  const weeks = [
    { from: 100, to: 199 },  // 完全に範囲前
    { from: 200, to: 299 },  // 範囲開始と一致
    { from: 250, to: 349 },  // 部分重なり (左)
    { from: 350, to: 449 },  // 完全に含まれる
    { from: 450, to: 549 },  // 部分重なり (右)
    { from: 600, to: 699 },  // 完全に範囲後
  ];

  // 範囲 [300, 500]
  const result = filterWeeks(weeks, 300, 500);
  assertEqual(result.length, 3, "範囲 [300,500] で 3 週ヒット (左部分・完全・右部分)");
  assertEqual(result[0].from, 250, "1番目: 左部分重なり");
  assertEqual(result[1].from, 350, "2番目: 完全含まれ");
  assertEqual(result[2].from, 450, "3番目: 右部分重なり");

  // 範囲端のテスト
  const r2 = filterWeeks(weeks, 199, 200);
  assertEqual(r2.length, 2, "範囲 [199,200] で 2 週ヒット (境界跨ぎ)");
});

/* ============ stats-compare.js: chartToMap ============ */

function chartToMap(rows, kind) {
  const m = new Map();
  for (const r of rows) {
    const name = r.name || "";
    const artist = (kind === "artist")
      ? name
      : (r.artist?.["#text"] || r.artist?.name || r.artist || "");
    const key = `${artist} ${name}`;
    const count = parseInt(r.playcount || "0", 10);
    if (!count) continue;
    const prev = m.get(key);
    if (prev) {
      prev.count += count;
    } else {
      m.set(key, { artist, name, count, image: r.image, kind });
    }
  }
  return m;
}

describe("chartToMap", () => {
  // artist の場合
  const aRows = [
    { name: "Beatles", playcount: "10" },
    { name: "Queen", playcount: "5" },
    { name: "Beatles", playcount: "3" },  // 重複加算
    { name: "Ignored", playcount: "0" },  // 0 は除外
  ];
  const aMap = chartToMap(aRows, "artist");
  assertEqual(aMap.size, 2, "artist: ユニーク 2 件 (0 は除外、重複は加算)");
  assertEqual(aMap.get("Beatles Beatles").count, 13, "artist: Beatles 加算 = 13");
  assertEqual(aMap.get("Queen Queen").count, 5, "artist: Queen = 5");

  // album/track の場合 (artist フィールドあり)
  const tRows = [
    { name: "Yesterday", artist: { "#text": "Beatles" }, playcount: "7" },
    { name: "Yesterday", artist: { "#text": "Beatles" }, playcount: "2" },
    { name: "Bohemian", artist: { "#text": "Queen" }, playcount: "4" },
  ];
  const tMap = chartToMap(tRows, "track");
  assertEqual(tMap.size, 2, "track: ユニーク 2 件");
  assertEqual(tMap.get("Beatles Yesterday").count, 9, "track: Beatles Yesterday = 9");
  assertEqual(tMap.get("Queen Bohemian").count, 4, "track: Queen Bohemian = 4");

  // artist が string 形式 (Last.fm レスポンスのバリエーション)
  const tRows2 = [
    { name: "Track", artist: { name: "Artist" }, playcount: "1" },
    { name: "Track2", artist: "PlainArtist", playcount: "2" },
  ];
  const tMap2 = chartToMap(tRows2, "track");
  assertEqual(tMap2.get("Artist Track").count, 1, "artist.name 形式");
  assertEqual(tMap2.get("PlainArtist Track2").count, 2, "artist string 形式");
});

/* ============ stats-service.js: emptySections / emptySectionReady / allSectionReady ============ */

function emptySections() {
  return {
    dashboard: null, top: null, compare: null,
    rewind: null, time: null, loved: null,
  };
}
function emptySectionReady() {
  return {
    dashboard: false, top: false, compare: false,
    rewind: false, time: false, loved: false,
  };
}
function allSectionReady() {
  return {
    dashboard: true, top: true, compare: true,
    rewind: true, time: true, loved: true,
  };
}

describe("emptySections / emptySectionReady / allSectionReady", () => {
  const es = emptySections();
  assertEqual(Object.keys(es).length, 6, "emptySections: 6 セクション");
  assertEqual(Object.values(es).every((v) => v === null), true, "emptySections: 全 null");

  const er = emptySectionReady();
  assertEqual(Object.keys(er).length, 6, "emptySectionReady: 6 セクション");
  assertEqual(Object.values(er).every((v) => v === false), true, "emptySectionReady: 全 false");

  const ar = allSectionReady();
  assertEqual(Object.values(ar).every((v) => v === true), true, "allSectionReady: 全 true");
});

/* ============ stats-service.js: computeSectionReady / isAllSectionsPopulated ============ */

function computeSectionReady(sections) {
  return {
    dashboard: !!sections?.dashboard,
    top:       !!sections?.top,
    compare:   !!sections?.compare,
    rewind:    !!sections?.rewind,
    time:      !!sections?.time,
    loved:     !!sections?.loved,
  };
}

function isAllSectionsPopulated(sections) {
  if (!sections) return false;
  return !!(
    sections.dashboard &&
    sections.top       &&
    sections.compare   &&
    sections.rewind    &&
    sections.time      &&
    sections.loved
  );
}

describe("computeSectionReady", () => {
  // 全部 null
  assertEqual(
    computeSectionReady(emptySections()),
    emptySectionReady(),
    "全 null sections → 全 false sectionReady"
  );
  // dashboard のみ
  assertEqual(
    computeSectionReady({ ...emptySections(), dashboard: { a: 1 } }),
    { dashboard: true, top: false, compare: false, rewind: false, time: false, loved: false },
    "dashboard のみ非 null → dashboard だけ true"
  );
  // 全部埋め
  const full = {
    dashboard: {}, top: {}, compare: {}, rewind: {}, time: {}, loved: {}
  };
  assertEqual(
    computeSectionReady(full),
    allSectionReady(),
    "全 sections 埋め → 全 true sectionReady"
  );
  // sections = null / undefined
  assertEqual(
    computeSectionReady(null),
    emptySectionReady(),
    "sections = null → 全 false (NPE しない)"
  );
  assertEqual(
    computeSectionReady(undefined),
    emptySectionReady(),
    "sections = undefined → 全 false (NPE しない)"
  );
});

describe("isAllSectionsPopulated", () => {
  assert(!isAllSectionsPopulated(null), "null → false");
  assert(!isAllSectionsPopulated(undefined), "undefined → false");
  assert(!isAllSectionsPopulated(emptySections()), "全 null → false");
  assert(!isAllSectionsPopulated({
    dashboard: {}, top: {}, compare: {}, rewind: {}, time: {}, loved: null
  }), "1つ欠損 → false");
  assert(isAllSectionsPopulated({
    dashboard: {}, top: {}, compare: {}, rewind: {}, time: {}, loved: {}
  }), "全揃い → true");
  // 空オブジェクトは truthy なので埋まっている扱いになる (期待動作)
  assert(isAllSectionsPopulated({
    dashboard: { byPeriod: {} }, top: { byPeriod: {} },
    compare: { byRange: {} }, rewind: { years: [] },
    time: { snapshot: {} }, loved: { list: [] }
  }), "実データ形式の全揃い → true");
});

/* ============ stats-worker.js: getDateKeyJST / toJSTComponents ============ */

function getDateKeyJST(utcMs) {
  const d = new Date(utcMs + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toJSTComponents(uts) {
  const d = new Date(uts * 1000 + 9 * 3600 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
  };
}

describe("Worker: getDateKeyJST / toJSTComponents", () => {
  // UTC 2026-05-24 15:00 = JST 2026-05-25 00:00
  assertEqual(
    getDateKeyJST(Date.UTC(2026, 4, 24, 15, 0, 0)),
    "2026-05-25",
    "UTC 5/24 15:00 → JST 5/25 (Worker)"
  );
  assertEqual(
    getDateKeyJST(Date.UTC(2026, 4, 24, 14, 59, 59)),
    "2026-05-24",
    "UTC 5/24 14:59 → JST 5/24 (Worker 境界直前)"
  );
  // 月境界
  assertEqual(
    getDateKeyJST(Date.UTC(2026, 4, 31, 15, 0, 0)),
    "2026-06-01",
    "月跨ぎ: UTC 5/31 15:00 → JST 6/1"
  );

  // toJSTComponents (uts = unix 秒)
  const c = toJSTComponents(Math.floor(Date.UTC(2026, 4, 25, 3, 30, 0) / 1000));
  // UTC 2026-05-25 03:30 → JST 2026-05-25 12:30
  assertEqual(c.year, 2026, "toJSTComponents: year");
  assertEqual(c.month, 5, "toJSTComponents: month");
  assertEqual(c.day, 25, "toJSTComponents: day");
  assertEqual(c.hour, 12, "toJSTComponents: hour");
  assertEqual(c.weekday, 1, "toJSTComponents: weekday (2026-05-25 は月曜 = 1)");

  // 週末/平日判定の境界
  // 2026-05-24 (日曜) JST = 2026-05-23 15:00 UTC
  const sun = toJSTComponents(Math.floor(Date.UTC(2026, 4, 23, 15, 0, 0) / 1000));
  assertEqual(sun.weekday, 0, "JST 日曜 → weekday = 0");
});

/* ============ stats-cache.js: getCache の日付判定相当 ============ */

describe("stats-cache.js キャッシュ有効判定相当", () => {
  // 今日 = JST 日付。同じ JST 日付なら有効
  const today = getJSTDateString();
  assert(today === getJSTDateString(), "today === today");
  assertEqual(today.length, 10, "形式 YYYY-MM-DD (長さ 10)");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(today), "形式 YYYY-MM-DD 正規表現");
});

/* ============ ダブルバッファ判定ロジックの確認 ============ */

describe("bufferedMode 判定相当", () => {
  // bufferedMode = !!state.sections.dashboard && state.sectionReady?.dashboard === true
  function isBuffered(state) {
    return !!state.sections.dashboard && state.sectionReady?.dashboard === true;
  }
  assert(!isBuffered({ sections: emptySections(), sectionReady: emptySectionReady() }),
    "初回 (sections.dashboard=null) → bufferedMode=false");
  assert(isBuffered({
    sections: { ...emptySections(), dashboard: {} },
    sectionReady: { ...emptySectionReady(), dashboard: true }
  }), "ダッシュボードのみ復元 → bufferedMode=true");
  assert(!isBuffered({
    sections: { ...emptySections(), dashboard: {} },
    sectionReady: emptySectionReady()  // ready=false
  }), "sections あるが ready=false → bufferedMode=false");
});

/* ============ markDashboardIfReady のロジック検証 ============ */

describe("markDashboardIfReady ロジック (新仕様)", () => {
  // 非 bufferedMode: base 完了で即 ready
  function shouldBeReady(bufferedMode, baseDone, extrasDone) {
    if (bufferedMode) return baseDone && extrasDone;
    return baseDone;
  }
  assert(!shouldBeReady(false, false, false), "初回:none → not ready");
  assert(shouldBeReady(false, true, false), "初回:baseのみ → ready (即時表示)");
  assert(shouldBeReady(false, true, true), "初回:両方 → ready");
  assert(!shouldBeReady(true, false, false), "buffered:none → not ready (旧データのまま)");
  assert(!shouldBeReady(true, true, false), "buffered:baseのみ → not ready (両方待つ)");
  assert(shouldBeReady(true, true, true), "buffered:両方 → ready (瞬時切替)");
});

/* ============ saveCurrent 呼び出し条件 (finalizeSection) ============ */

describe("finalizeSection の保存条件", () => {
  // sections[name] が non-null かつ abortFlag=false のときのみ保存
  function shouldSave(sectionsValue, abortFlag) {
    return !abortFlag && sectionsValue != null;
  }
  assert(shouldSave({}, false), "正常完了 + 値あり → 保存");
  assert(!shouldSave(null, false), "値 null → 保存しない (タスク失敗時)");
  assert(!shouldSave({}, true), "abort 中 → 保存しない");
});

/* ============ rewind の年集計 (JST境界) ============ */

describe("buildRewind: 年集計の JST 境界", () => {
  // 各週の to が UTC で年末 → JST で翌年に入る場合がある
  function yearOfWeek(toUnix) {
    return new Date(toUnix * 1000 + 9 * 3600 * 1000).getUTCFullYear();
  }
  // UTC 2026-12-31 23:00 = JST 2027-01-01 08:00 → 2027 年扱い
  const w1 = Math.floor(Date.UTC(2026, 11, 31, 23, 0, 0) / 1000);
  assertEqual(yearOfWeek(w1), 2027, "UTC 12/31 23:00 → JST 2027 扱い");
  // UTC 2026-12-31 14:00 = JST 2026-12-31 23:00 → 2026 年扱い
  const w2 = Math.floor(Date.UTC(2026, 11, 31, 14, 0, 0) / 1000);
  assertEqual(yearOfWeek(w2), 2026, "UTC 12/31 14:00 → JST 2026 扱い");
});

/* ============ 結果サマリ ============ */

console.log("\n" + "=".repeat(60));
console.log(`合計: ${passCount + failCount} / 成功: ${passCount} / 失敗: ${failCount}`);
if (failCount > 0) {
  console.log("\n失敗一覧:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log("全テスト成功 ✓");
}
