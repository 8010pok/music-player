/**
 * formatRelativeTime 単体テスト
 *
 * Last.fm 公式アプリと同じ表示形式に揃える:
 *   - 1 分未満           → "just now"
 *   - 1 〜 59 分          → "N min(s) ago"
 *   - 1 〜 23 時間         → "N hour(s) ago"
 *   - 24 時間以上 (今年)   → "DD MMM HH:MM"  (JST 固定)
 *   - 24 時間以上 (別年)   → "DD MMM YYYY HH:MM"
 *
 * 実行: node tests/test-relative-time.mjs
 *
 * Note: 本番の formatRelativeTime は jstParts(Intl timeZone:"Asia/Tokyo") で常に JST 表示する。
 *       端末タイムゾーンに依存しないことを実証するため、あえて process.env.TZ を
 *       非 JST (America/New_York) に設定して実行する。旧ローカル時刻実装ならこの設定で
 *       期待値が崩れて失敗するが、JST 固定の新実装は同じ JST 期待値で合格する。
 */

// ★ あえて非 JST の TZ に固定し、JST 変換が端末 TZ に依存しないことを実証する
process.env.TZ = "America/New_York";

let passCount = 0, failCount = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passCount++; console.log(`  ✓ ${msg}`); }
  else { failCount++; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { passCount++; console.log(`  ✓ ${msg}`); }
  else {
    failCount++;
    const m = `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(m);
    console.error(`  ✗ ${m}`);
  }
}
function describe(name, fn) { console.log(`\n=== ${name} ===`); return fn(); }

/* ============ stats-service.js から formatRelativeTime をコピー ============ */

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 本番 stats-service.js の jstParts と同一実装(Intl で常に Asia/Tokyo に変換)。
function jstParts(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t)?.value ?? "");
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

function formatRelativeTime(date, nowMs = Date.now()) {
  if (!date) return "";
  const utsStr = date.uts;
  if (!utsStr) return date["#text"] || "";
  const uts = parseInt(utsStr, 10);
  if (!uts || isNaN(uts)) return date["#text"] || "";

  const thenMs = uts * 1000;
  const thenP = jstParts(thenMs);
  const nowP = jstParts(nowMs);

  const sameDay = thenP.year === nowP.year
               && thenP.month === nowP.month
               && thenP.day === nowP.day;

  if (sameDay) {
    const diffMs = Math.max(0, nowMs - thenMs);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin} ${diffMin === 1 ? "min" : "mins"} ago`;
    const diffHour = Math.floor(diffMs / 3600000);
    return `${diffHour} ${diffHour === 1 ? "hour" : "hours"} ago`;
  }

  const day = thenP.day;
  const month = MONTHS_SHORT[thenP.month - 1];
  const hh = thenP.hour;
  const mm = thenP.minute;
  if (thenP.year === nowP.year) {
    return `${day} ${month} ${hh}:${mm}`;
  }
  return `${day} ${month} ${thenP.year} ${hh}:${mm}`;
}

/* ============ TZ 非依存 / 深夜境界の実証 ============ */

describe("jstParts: 端末TZ非依存・深夜0時正規化", () => {
  assertEqual(process.env.TZ, "America/New_York", "テストは非JST(America/New_York)で実行されている");
  // UTC 2026-05-24 06:00 = JST 2026-05-24 15:00 (同日昼)
  const a = jstParts(Date.UTC(2026, 4, 24, 6, 0, 0));
  assertEqual([a.year, a.month, a.day, a.hour, a.minute], [2026, 5, 24, "15", "00"],
    "UTC06:00 → JST15:00 (端末NYでもJST)");
  // UTC 2026-05-24 15:00 = JST 2026-05-25 00:00 (深夜0時 → "00", 日付繰上げ)
  const b = jstParts(Date.UTC(2026, 4, 24, 15, 0, 0));
  assertEqual([b.year, b.month, b.day, b.hour, b.minute], [2026, 5, 25, "00", "00"],
    "深夜0時は \"24\" でなく \"00\"、日付は翌日へ繰上げ");
  // UTC 2026-12-31 15:30 = JST 2027-01-01 00:30 (年跨ぎ深夜)
  const c = jstParts(Date.UTC(2026, 11, 31, 15, 30, 0));
  assertEqual([c.year, c.month, c.day, c.hour, c.minute], [2027, 1, 1, "00", "30"],
    "年跨ぎ深夜 → 2027-01-01 00:30");
});

/* ============ Now: 2026-05-25 02:54 JST = 2026-05-24 17:54 UTC ============ */

// ベースとなる現在時刻 (JST 02:54)
// JST 2026-05-25 02:54 = UTC 2026-05-24 17:54
const NOW_JST_MAY_25_02_54 = Date.UTC(2026, 4, 24, 17, 54);

describe("同じ日の境界: just now / mins ago / hour(s) ago", () => {
  // テスト基準: 2026-05-25 12:00 JST (= UTC 2026-05-25 03:00)
  // この時刻なら「同じ日」の範囲が広く、相対時刻のテストがやりやすい
  const now = Date.UTC(2026, 4, 25, 3, 0);  // = JST 2026-05-25 12:00

  // 0 秒前 → "just now"
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor(now / 1000)) }, now),
    "just now",
    "0 秒前 → just now"
  );
  // 30 秒前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 30 * 1000) / 1000)) }, now),
    "just now",
    "30 秒前 → just now (1 分未満)"
  );
  // 59 秒前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 59 * 1000) / 1000)) }, now),
    "just now",
    "59 秒前 → just now"
  );
  // ちょうど 60 秒前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 60 * 1000) / 1000)) }, now),
    "1 min ago",
    "60 秒前 → 1 min ago (単数形)"
  );
  // 2 分前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 2 * 60 * 1000) / 1000)) }, now),
    "2 mins ago",
    "2 分前 → 2 mins ago (複数形)"
  );
  // 29 分前 (ユーザ報告例 1)
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 29 * 60 * 1000) / 1000)) }, now),
    "29 mins ago",
    "29 分前 → 29 mins ago (ユーザ報告例 1 と同パターン)"
  );
  // 59 分前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 59 * 60 * 1000) / 1000)) }, now),
    "59 mins ago",
    "59 分前 → 59 mins ago"
  );
  // 60 分前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 60 * 60 * 1000) / 1000)) }, now),
    "1 hour ago",
    "60 分前 → 1 hour ago (単数形)"
  );
  // 69 分前 → "1 hour ago" (ユーザ報告例 2 と同パターン)
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 69 * 60 * 1000) / 1000)) }, now),
    "1 hour ago",
    "69 分前 → 1 hour ago"
  );
  // 2 時間前
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 2 * 60 * 60 * 1000) / 1000)) }, now),
    "2 hours ago",
    "2 時間前 → 2 hours ago (複数形)"
  );
  // 11 時間前 (同じ日の範囲内に収まる: 12:00 → 01:00)
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor((now - 11 * 60 * 60 * 1000) / 1000)) }, now),
    "11 hours ago",
    "11 時間前 (同じ日内) → 11 hours ago"
  );
});

/* ============ 24 時間以上: ローカル時刻で日付付き表示 ============ */

describe("別の日: ローカル時刻 (JST) で日付表示", () => {
  // ユーザ報告例 3:
  //   PWA 旧: "24 May 2026, 14:09" (UTC をそのまま表示)
  //   公式:   "24 May 23:09"      (JST = UTC+9 のローカル時刻)
  //   現在:   2026-05-25 02:54 JST (= UTC 2026-05-24 17:54)
  //   対象:   2026-05-24 14:09 UTC = 2026-05-24 23:09 JST (前日 JST)
  //   差は 約 3 時間 45 分だが、JST で日付が違うため絶対時刻表示
  const utcEvent = Date.UTC(2026, 4, 24, 14, 9, 0);
  const uts = Math.floor(utcEvent / 1000);
  const now = NOW_JST_MAY_25_02_54;

  assertEqual(
    formatRelativeTime({ uts: String(uts) }, now),
    "24 May 23:09",
    "ユーザ報告例 3: 別ローカル日 → 24 May 23:09 (24時間以内でも日付違いで絶対時刻)"
  );

  // 数日前
  const fiveDaysAgo = NOW_JST_MAY_25_02_54 - 5 * 24 * 60 * 60 * 1000;
  // JST で 2026-05-20 02:54 = UTC 2026-05-19 17:54
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor(fiveDaysAgo / 1000)) }, NOW_JST_MAY_25_02_54),
    "20 May 02:54",
    "5 日前 (同年) → 月日+時刻、年なし"
  );
});

describe("年が異なる場合: 年付き表示", () => {
  // UTC 2025-12-31 23:09 → JST 2026-01-01 08:09 (同年扱い)
  // 現在: 2026-05-25 02:54 JST、対象: 2026-01-01 08:09 JST
  // JST で日付違い (1/1 vs 5/25)、同年なので年省略
  const utcSameYear = Date.UTC(2025, 11, 31, 23, 9, 0);
  const utsSame = Math.floor(utcSameYear / 1000);
  const now = NOW_JST_MAY_25_02_54;
  assertEqual(
    formatRelativeTime({ uts: String(utsSame) }, now),
    "1 Jan 08:09",
    "UTC 2025-12-31 23:09 → JST 2026-01-01 08:09 (今年内なので年省略)"
  );

  // 別年: 2025-05-25 02:00 UTC → JST 2025-05-25 11:00 (前年)
  const utcOldYear = Date.UTC(2025, 4, 25, 2, 0, 0);
  const utsOldYear = Math.floor(utcOldYear / 1000);
  assertEqual(
    formatRelativeTime({ uts: String(utsOldYear) }, now),
    "25 May 2025 11:00",
    "前年 → 年付きで表示"
  );
});

describe("フォールバック: uts が無い場合", () => {
  assertEqual(formatRelativeTime(null), "", "date null → 空文字");
  assertEqual(formatRelativeTime(undefined), "", "date undefined → 空文字");
  assertEqual(
    formatRelativeTime({ "#text": "fallback text" }),
    "fallback text",
    "uts 無し → #text にフォールバック"
  );
  assertEqual(
    formatRelativeTime({ uts: "invalid" }),
    "",
    "uts が不正で #text 無し → 空文字"
  );
  assertEqual(
    formatRelativeTime({ uts: "invalid", "#text": "fb" }),
    "fb",
    "uts が不正でも #text あり → #text"
  );
});

describe("未来時刻 (時刻ズレ) の堅牢性", () => {
  // サーバ時計が進んでいる等で thenMs > nowMs になった場合
  const now = NOW_JST_MAY_25_02_54;
  const future = now + 5 * 60 * 1000;  // 5 分未来
  assertEqual(
    formatRelativeTime({ uts: String(Math.floor(future / 1000)) }, now),
    "just now",
    "未来時刻 → diff を 0 にクランプ → just now (負の数表示なし)"
  );
});

/* ============ ユーザ報告シナリオ全体の再現 ============ */

describe("ユーザ報告: PWA 3 件の表示と公式アプリの対応", () => {
  // 現在時刻: 2026-05-25 02:54 JST (= UTC 2026-05-24 17:54)
  const now = NOW_JST_MAY_25_02_54;

  // 1. PWA 旧表示: "25 May 2026, 02:25"
  //    JST 02:25 = UTC 17:25 (前日 UTC)
  //    現在から 29 分前、同じ JST 日 (5/25)
  //    公式: "29 mins ago"
  const t1uts = Math.floor(Date.UTC(2026, 4, 24, 17, 25) / 1000);
  assertEqual(
    formatRelativeTime({ uts: String(t1uts) }, now),
    "29 mins ago",
    "1: 25 May 02:25 JST (29 分前) → 29 mins ago ✓"
  );

  // 2. PWA 旧表示: "25 May 2026, 01:45"
  //    現在から 69 分前、同じ JST 日 (5/25)
  //    公式: "1 hour ago"
  const t2uts = Math.floor(Date.UTC(2026, 4, 24, 16, 45) / 1000);
  assertEqual(
    formatRelativeTime({ uts: String(t2uts) }, now),
    "1 hour ago",
    "2: 25 May 01:45 JST (1 時間 9 分前) → 1 hour ago ✓"
  );

  // 3. PWA 旧表示: "24 May 2026, 14:09" (UTC のまま表示していた)
  //    JST 換算: 24 May 23:09 (前日 JST)
  //    現在から 3 時間 45 分前だが、JST で日付違い (5/24 ≠ 5/25)
  //    公式: "24 May 23:09" (絶対時刻表示)
  const t3uts = Math.floor(Date.UTC(2026, 4, 24, 14, 9) / 1000);
  assertEqual(
    formatRelativeTime({ uts: String(t3uts) }, now),
    "24 May 23:09",
    "3: 前日 JST → 24 May 23:09 (絶対時刻、3時間45分前でも日付違いで絶対表示) ✓"
  );
});

/* ============ 統合シナリオ: 再生中 / 履歴混在 ============ */

describe("simplifyRecent 相当のシナリオ", () => {
  function simplifyRecent(t, nowMs) {
    const nowPlaying = t["@attr"] && t["@attr"].nowplaying === "true";
    return {
      name: t.name || "",
      when: nowPlaying ? "再生中" : formatRelativeTime(t.date, nowMs),
      nowPlaying,
    };
  }
  const now = NOW_JST_MAY_25_02_54;

  // 再生中の曲は "再生中" 維持
  const r1 = simplifyRecent({ name: "A", "@attr": { nowplaying: "true" } }, now);
  assertEqual(r1.when, "再生中", "nowPlaying → 「再生中」維持");

  // 履歴
  const r2 = simplifyRecent({
    name: "B",
    date: { uts: String(Math.floor(now / 1000) - 60 * 5) },  // 5 分前
  }, now);
  assertEqual(r2.when, "5 mins ago", "5 分前 → 「5 mins ago」");
});

/* ============ 結果 ============ */

console.log("\n" + "=".repeat(60));
console.log(`合計: ${passCount + failCount} / 成功: ${passCount} / 失敗: ${failCount}`);
if (failCount > 0) {
  console.log("\n失敗一覧:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log("全テスト成功 ✓");
}
