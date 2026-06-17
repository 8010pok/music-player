/**
 * 統計集計 Worker (js/workers/stats-worker.js) の集計演算 単体テスト
 *
 * 実行: node tests/test-stats-worker.mjs
 *
 * 既存の test-snapshot-protocol.mjs は「final フラグ判別 / in-flight ガード /
 * タイムアウト状態機械」というプロトコル面を検証するが、worker 本体の
 * 集計演算(JST 日付バケット・月別/年別・ヒートマップ・時間帯・平日週末・
 * リピート率・発見月・maxDay・キー衝突回避)の数値は未検証だった。本テストは
 * worker を `self` シム上で実ロードし、合成スクロブルを投入して snapshot の
 * 数値を直接アサートする(JST = UTC+9 固定の境界処理が肝)。
 *
 * worker は ESM ではなく self.addEventListener ベースなので、ソースを読み込んで
 * new Function('self', src) で実行し、メッセージプロトコル経由で集計させる。
 */

import { readFileSync } from "node:fs";

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
function assertApprox(actual, expected, eps, msg) {
  if (Math.abs(actual - expected) <= eps) { passCount++; console.log(`  ✓ ${msg}`); }
  else {
    failCount++;
    const m = `${msg}\n    expected≈${expected} (±${eps})\n    actual:  ${actual}`;
    failures.push(m); console.error(`  ✗ ${m}`);
  }
}
function describe(name, fn) { console.log(`\n=== ${name} ===`); fn(); }

/* ============ worker ローダ (self シム) ============ */
const workerSrc = readFileSync(new URL("../js/workers/stats-worker.js", import.meta.url), "utf8");

function makeWorker() {
  let messageHandler = null;
  const outbox = [];
  const selfShim = {
    addEventListener(type, fn) { if (type === "message") messageHandler = fn; },
    postMessage(msg) { outbox.push(msg); },
  };
  // worker ソースを self シム上で実行(addEventListener が登録される)
  // eslint-disable-next-line no-new-func
  new Function("self", workerSrc)(selfShim);
  return {
    send(msg) { if (messageHandler) messageHandler({ data: msg }); },
    outbox,
    // 明示要求への最終応答(final:true)の payload を返す
    finalSnapshot() {
      const fs = outbox.filter((m) => m.type === "snapshot" && m.final);
      return fs.length ? fs[fs.length - 1].payload : null;
    },
  };
}

// 合成スクロブル track-like を作る。utc は "YYYY,M(0-base),D,H,Mi" の Date.UTC 引数。
function scrobble(artist, name, utcArgs) {
  const uts = Math.floor(Date.UTC(...utcArgs) / 1000);
  return { date: { uts: String(uts) }, name, artist: { "#text": artist } };
}

function aggregate(tracks) {
  const w = makeWorker();
  w.send({ type: "reset" });
  w.send({ type: "addBatch", tracks });
  w.send({ type: "snapshot" });
  return w.finalSnapshot();
}

/* ============ 1. JST 日付バケット + コア集計 ============ */
//
// JST = UTC+9。境界をまたぐケースを意図的に含める:
//   A Alice/Song1 2024-01-15 03:00 UTC → JST 01-15(月=1) 12:00(昼)
//   B Bob/Song2   2024-01-15 15:30 UTC → JST 01-16(火=2) 00:30(深夜)   ← 日跨ぎ
//   C Alice/Song3 2023-12-31 16:00 UTC → JST 2024-01-01(月=1) 01:00(深夜) ← 年跨ぎ
//   D Alice/Song1 2024-01-15 05:00 UTC → JST 01-15(月=1) 14:00(昼)       ← 同曲リピート
//   E Carol/Song5 2024-01-13 11:00 UTC → JST 01-13(土=6) 20:00(夜)        ← 週末
//   F Dave/Song6  2024-01-14 22:30 UTC → JST 01-15(月=1) 07:30(朝)        ← 日跨ぎ(朝)
describe("JST バケット + コア集計 (年/月/日/ヒートマップ境界)", () => {
  const A = scrobble("Alice", "Song1", [2024, 0, 15, 3, 0]);
  const B = scrobble("Bob", "Song2", [2024, 0, 15, 15, 30]);
  const C = scrobble("Alice", "Song3", [2023, 11, 31, 16, 0]);
  const D = scrobble("Alice", "Song1", [2024, 0, 15, 5, 0]);
  const E = scrobble("Carol", "Song5", [2024, 0, 13, 11, 0]);
  const F = scrobble("Dave", "Song6", [2024, 0, 14, 22, 30]);
  const snap = aggregate([A, B, C, D, E, F]);

  assertEqual(snap.total, 6, "total = 6");
  assertEqual(snap.byYear, [["2024", 6]], "byYear: 全て JST 2024 (年跨ぎ C も 2024 に入る)");
  assertEqual(snap.byMonth, [["2024-01", 6]], "byMonth: 全て JST 2024-01");
  assertEqual(snap.maxDay, { date: "2024-01-15", count: 3 }, "maxDay = 2024-01-15 が 3 件 (A,D,F)");
  assertApprox(snap.avgPerDay, 6 / 4, 1e-9, "avgPerDay = 6/4 (聴いた日 4 日: 15,16,01,13)");
  assertEqual(snap.firstAt, C.date.uts ? parseInt(C.date.uts, 10) : 0, "firstAt = 最古(C 2023-12-31)");
  assertEqual(snap.lastAt, parseInt(B.date.uts, 10), "lastAt = 最新(B 2024-01-15 15:30)");

  // ヒートマップ(JST 曜日×時刻)
  assertEqual(snap.heatmap[1][12], 1, "heatmap[月][12] = A");
  assertEqual(snap.heatmap[2][0], 1, "heatmap[火][0]  = B (日跨ぎ)");
  assertEqual(snap.heatmap[1][1], 1, "heatmap[月][1]  = C (年跨ぎ→2024-01-01 月曜)");
  assertEqual(snap.heatmap[1][14], 1, "heatmap[月][14] = D");
  assertEqual(snap.heatmap[6][20], 1, "heatmap[土][20] = E (週末)");
  assertEqual(snap.heatmap[1][7], 1, "heatmap[月][7]  = F (日跨ぎ→朝)");

  // 時間帯 4 セグメント(深夜0-5 / 朝6-11 / 昼12-17 / 夜18-23)
  assertEqual(snap.timeOfDay, { night: 2, morning: 1, day: 2, evening: 1 },
    "timeOfDay: 深夜2(B,C) 朝1(F) 昼2(A,D) 夜1(E)");
  // 平日 vs 週末(日=0/土=6 が週末)
  assertEqual(snap.weekdayWeekend, { weekday: 5, weekend: 1 },
    "weekdayWeekend: 平日5 週末1(E=土)");

  // アーティスト
  assertEqual(snap.uniqueArtists, 4, "uniqueArtists = 4 (Alice/Bob/Carol/Dave)");
  assertEqual(snap.topArtists, { Alice: 3, Bob: 1, Carol: 1, Dave: 1 }, "topArtists 集計");

  // 発見月(アーティスト初登場月、JST)。Alice の初登場は C(2024-01-01 JST)
  assertEqual(snap.discoveryByMonth, [["2024-01", 4]], "discoveryByMonth: 4 アーティストとも 2024-01 に初登場");

  // リピート(Alice/Song1 が A,D で 2 回)
  assertEqual(snap.uniqueTracks, 5, "uniqueTracks = 5 (A/D は同一曲)");
  assertApprox(snap.repeatRate, 2 / 6, 1e-9, "repeatRate = 2/6 (2回以上聴いた曲の再生数合計/total)");
});

/* ============ 2. trackDist のキー衝突回避 (区切りは Unit Separator) ============ */
describe("trackDist キー衝突回避 ('|' を含む名前)", () => {
  // '|' 区切りなら ("X|Y","Z") と ("X","Y|Z") は "X|Y|Z" で衝突する。
  // Unit Separator() 区切りなら別キーとして区別される。
  const t1 = scrobble("X|Y", "Z", [2024, 2, 1, 3, 0]);
  const t2 = scrobble("X", "Y|Z", [2024, 2, 1, 4, 0]);
  const snap = aggregate([t1, t2]);
  assertEqual(snap.uniqueTracks, 2, "('X|Y','Z') と ('X','Y|Z') は別曲として区別される(衝突しない)");
  assertEqual(snap.total, 2, "total = 2");
});

/* ============ 3. topArtists は上位 20 に制限 ============ */
describe("topArtists 上位 20 制限", () => {
  const tracks = [];
  // 25 アーティスト、再生数に差をつける(i 回再生)
  for (let i = 1; i <= 25; i++) {
    for (let j = 0; j < i; j++) {
      tracks.push(scrobble(`Artist${String(i).padStart(2, "0")}`, `T${j}`, [2024, 3, 1, 0, 0]));
    }
  }
  const snap = aggregate(tracks);
  assertEqual(Object.keys(snap.topArtists).length, 20, "topArtists は 20 件に制限");
  assertEqual(snap.uniqueArtists, 25, "uniqueArtists は全 25 を保持");
  // 最多(Artist25=25回)は含まれ、最少(Artist01=1回)は含まれない
  assert(snap.topArtists["Artist25"] === 25, "最多アーティストは topArtists に含まれる");
  assert(!("Artist01" in snap.topArtists), "最少アーティストは上位20から漏れる");
});

/* ============ 4. now-playing (date 無し) はスキップ ============ */
describe("date 無しトラック(再生中)は集計しない", () => {
  const withDate = scrobble("Alice", "Song1", [2024, 4, 1, 3, 0]);
  const nowPlaying = { name: "Playing", artist: { "#text": "Alice" } }; // date なし
  const uts0 = { date: { uts: "0" }, name: "Zero", artist: { "#text": "Bob" } }; // uts=0 もスキップ
  const snap = aggregate([withDate, nowPlaying, uts0]);
  assertEqual(snap.total, 1, "date 無し / uts=0 はスキップされ total=1");
  assertEqual(snap.uniqueArtists, 1, "再生中の Alice 重複・Bob(uts0) は集計されない");
});

/* ============ 5. reset で状態がクリアされる ============ */
describe("reset で全状態クリア", () => {
  const w = makeWorker();
  w.send({ type: "addBatch", tracks: [scrobble("Alice", "S", [2024, 0, 1, 3, 0])] });
  w.send({ type: "reset" });
  w.send({ type: "snapshot" });
  const snap = w.finalSnapshot();
  assertEqual(snap.total, 0, "reset 後 total=0");
  assertEqual(snap.byMonth, [], "reset 後 byMonth 空");
  assertEqual(snap.firstAt, null, "reset 後 firstAt=null");
  // ready メッセージが reset で送られる
  assert(w.outbox.some((m) => m.type === "ready"), "reset 応答に ready が含まれる");
});

/* ============ 6. 連続スクロブル日数(streak) ============ */
//
// streak は worker 内部の Date.now() に依存するため、実行時の「今日 JST」を基準に
// 今日・昨日・一昨日の 3 日連続スクロブルを与えて streak=3 を期待する。
// (24h ずつ遡れば JST 暦日も必ず 1 日ずつズレる)
describe("streak (今日から遡る連続日数)", () => {
  const now = Date.now();
  const day = 86400 * 1000;
  const tracks = [0, 1, 2].map((k) =>
    ({ date: { uts: String(Math.floor((now - k * day) / 1000)) }, name: `S${k}`, artist: { "#text": "Alice" } })
  );
  const snap = aggregate(tracks);
  assertEqual(snap.streak, 3, "今日・昨日・一昨日に scrobble → streak=3");

  // 連続が途切れるケース: 今日と3日前のみ(間が空く) → streak=1
  const tracks2 = [0, 3].map((k) =>
    ({ date: { uts: String(Math.floor((now - k * day) / 1000)) }, name: `S${k}`, artist: { "#text": "Bob" } })
  );
  const snap2 = aggregate(tracks2);
  assertEqual(snap2.streak, 1, "今日と3日前のみ(間が空く) → streak=1");
});

/* ============ 7. 中間 snapshot 間引き + final 応答 ============ */
describe("中間 snapshot 間引き(3バッチ毎) と final 応答", () => {
  const w = makeWorker();
  w.send({ type: "reset" });
  const t = (i) => scrobble("Alice", `S${i}`, [2024, 0, 1, 3, 0]);
  // 2 バッチでは中間 snapshot は出ない(SNAPSHOT_EVERY_N_BATCHES=3)
  w.send({ type: "addBatch", tracks: [t(1)] });
  w.send({ type: "addBatch", tracks: [t(2)] });
  const intermediateAfter2 = w.outbox.filter((m) => m.type === "snapshot" && !m.final).length;
  assertEqual(intermediateAfter2, 0, "2 バッチでは中間 snapshot は送られない");
  // 3 バッチ目で中間 snapshot が 1 回出る
  w.send({ type: "addBatch", tracks: [t(3)] });
  const intermediateAfter3 = w.outbox.filter((m) => m.type === "snapshot" && !m.final).length;
  assertEqual(intermediateAfter3, 1, "3 バッチ目で中間 snapshot が 1 回送られる");
  // 明示 snapshot 要求は final:true
  w.send({ type: "snapshot" });
  const snap = w.finalSnapshot();
  assertEqual(snap.total, 3, "final snapshot は全 3 バッチを反映");
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
