/**
 * 統計「比較」期間計算 (js/lastfm/stats-compare.js computeRange) の単体テスト
 *
 * 実行: node tests/test-stats-ranges.mjs
 *
 * computeRange は export 済みかつ now を引数で受けられる純粋関数なので、実コードを
 * そのまま import して検証する(ミラーではないのでドリフトしない)。
 *
 * 重点: 月/年境界の JST クランプ。内部の monthsAgoUnix/yearsAgoUnix は
 *   「目標月/年に元の日が無い場合は月末へクランプ」する(3/31→2/29、うるう 2/29→2/28)。
 *   ここがズレると比較期間の窓長が狂い total が過大/過小になるため回帰ガードする。
 */

import { computeRange } from "../js/lastfm/stats-compare.js";

/* ============ ミニマルテストフレームワーク ============ */
let passCount = 0;
let failCount = 0;
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
    failures.push(m); console.error(`  ✗ ${m}`);
  }
}
function describe(name, fn) { console.log(`\n=== ${name} ===`); fn(); }

// unix 秒 → JST の {y,m,d,h}
function jstYMD(unixSec) {
  const d = new Date(unixSec * 1000 + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}
const WEEK = 7 * 24 * 60 * 60;

/* ============ 1. week は厳密 7 日単位 ============ */
describe("computeRange('week') は厳密 7 日窓", () => {
  const now = Date.UTC(2024, 5, 15, 0, 0, 0); // 任意
  const nowUnix = Math.floor(now / 1000);
  const r = computeRange("week", now);
  assertEqual(r.current.to, nowUnix, "current.to = now");
  assertEqual(r.current.from, nowUnix - WEEK, "current.from = now - 7日");
  assertEqual(r.previous.to, nowUnix - WEEK, "previous.to = now - 7日 (current.from と連続)");
  assertEqual(r.previous.from, nowUnix - 2 * WEEK, "previous.from = now - 14日");
  assert(r.current.to - r.current.from === WEEK, "current 窓 = 正確に 7 日");
  assert(r.previous.to - r.previous.from === WEEK, "previous 窓 = 正確に 7 日");
  assert(r.current.from === r.previous.to, "current と previous は連続(隙間/重なり無し)");
});

/* ============ 2. month 境界クランプ (3/31 → 前月末 2/29 うるう) ============ */
describe("computeRange('month') の月末クランプ (JST)", () => {
  // now = 2024-03-31 12:00 JST (= 2024-03-31 03:00 UTC)
  const now = Date.UTC(2024, 2, 31, 3, 0, 0);
  const nowUnix = Math.floor(now / 1000);
  const r = computeRange("month", now);
  // 1ヶ月前: 3/31 は 2月に無いので 2024-02-29(うるう)へクランプ (3/2 等へあふれない)
  assertEqual({ y: jstYMD(r.current.from).y, m: jstYMD(r.current.from).m, d: jstYMD(r.current.from).d },
    { y: 2024, m: 2, d: 29 }, "current.from = 2024-02-29 (3/31 の1ヶ月前、うるう月末クランプ)");
  assertEqual(jstYMD(r.current.from).h, 12, "クランプしても時刻(12時 JST)は保持");
  assertEqual(r.current.to, nowUnix, "current.to = now");
  // 2ヶ月前: 1月は31日あるので 2024-01-31
  assertEqual({ y: jstYMD(r.previous.from).y, m: jstYMD(r.previous.from).m, d: jstYMD(r.previous.from).d },
    { y: 2024, m: 1, d: 31 }, "previous.from = 2024-01-31 (1月は31日まで在る)");
  assert(r.previous.to === r.current.from, "previous.to = current.from (連続)");
});

/* ============ 3. year 境界クランプ (うるう 2/29 → 前年 2/28) ============ */
describe("computeRange('year') のうるう日クランプ (JST)", () => {
  // now = 2024-02-29 12:00 JST (= 2024-02-29 03:00 UTC)。2024 はうるう年
  const now = Date.UTC(2024, 1, 29, 3, 0, 0);
  const r = computeRange("year", now);
  // 1年前: 2023 は非うるう → 2/29 が無いので 2023-02-28 へクランプ
  assertEqual({ y: jstYMD(r.current.from).y, m: jstYMD(r.current.from).m, d: jstYMD(r.current.from).d },
    { y: 2023, m: 2, d: 28 }, "current.from = 2023-02-28 (2/29 の1年前、非うるうクランプ)");
  // 2年前: 2022 も非うるう → 2022-02-28
  assertEqual({ y: jstYMD(r.previous.from).y, m: jstYMD(r.previous.from).m, d: jstYMD(r.previous.from).d },
    { y: 2022, m: 2, d: 28 }, "previous.from = 2022-02-28");
  assert(r.previous.to === r.current.from, "previous.to = current.from (連続)");
});

/* ============ 4. month の通常ケース(あふれ無し) ============ */
describe("computeRange('month') 通常ケース", () => {
  // now = 2024-05-15 → 1ヶ月前 4/15 (4月は15日が在る、クランプ不要)
  const now = Date.UTC(2024, 4, 15, 3, 0, 0);
  const r = computeRange("month", now);
  assertEqual({ y: jstYMD(r.current.from).y, m: jstYMD(r.current.from).m, d: jstYMD(r.current.from).d },
    { y: 2024, m: 4, d: 15 }, "current.from = 2024-04-15 (クランプ不要)");
  assertEqual({ y: jstYMD(r.previous.from).y, m: jstYMD(r.previous.from).m, d: jstYMD(r.previous.from).d },
    { y: 2024, m: 3, d: 15 }, "previous.from = 2024-03-15");
});

/* ============ 5. ラベルと未知 range ============ */
describe("ラベルと未知 range の例外", () => {
  assertEqual(computeRange("week", Date.now()).current.label, "今週", "week の current ラベル");
  assertEqual(computeRange("month", Date.now()).previous.label, "先月(その前1ヶ月)", "month の previous ラベル");
  assertEqual(computeRange("year", Date.now()).current.label, "今年(直近12ヶ月)", "year の current ラベル");
  let threw = false;
  try { computeRange("decade", Date.now()); } catch { threw = true; }
  assert(threw, "未知の range は例外を投げる");
});

/* ============ 結果出力 ============ */
console.log(`\n${"=".repeat(60)}`);
console.log(`合計: ${passCount} / 成功: ${passCount - failCount} / 失敗: ${failCount}`);
if (failCount > 0) {
  console.error("\n失敗:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("全テスト成功 ✓");
