/**
 * v1.1.49 で導入した「snapshot final フラグ判別」と「in-flight 同一性ガード」の
 * 純粋ロジック単体テスト (回帰ガード)
 *
 * 実行: node tests/test-snapshot-protocol.mjs
 *
 * 対象ロジックは src ファイル(stats-worker.js / stats-service.js / stats-cache.js /
 * stats-compare.js)からコピーして閉じた形でテストする。元コードを変更したら
 * ここも追従させること。
 *
 * 検証対象:
 *  1. finalHandler が「final:true の応答のみ」で確定し、間引きの中間 snapshot が
 *     先に届いても取りこぼさない (WS-2 の根本修正)。
 *  2. in-flight Map の delete が同一性ガード付きで、clear() 後に旧 Promise が
 *     settle しても新 run のエントリを誤削除しない (stats-cache / stats-compare 共通)。
 */

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

/* ============ 1. worker snapshot プロトコルの final 判別 ============ */
//
// stats-worker.js: 中間 snapshot は {type:"snapshot", payload} を送り、
//                  明示要求(最終確定)には {type:"snapshot", payload, final:true} を送る。
// stats-service.js finalHandler: `e.data?.type === "snapshot" && e.data.final` のみで確定。
//
// ここでは worker のメッセージ生成と service の受理条件を閉じた形で再現し、
// 「中間→中間→最終」の順でキューに積まれたメッセージを処理して、
// finalHandler が最終(完全)payload のみを採用することを検証する。

// worker 側: 間引き中間 snapshot
function makeIntermediateMsg(payload) {
  return { data: { type: "snapshot", payload } };
}
// worker 側: 明示要求への最終応答 (final:true)
function makeFinalMsg(payload) {
  return { data: { type: "snapshot", payload, final: true } };
}

// service 側 finalHandler の受理条件 (実装と逐語一致させる)
function finalHandlerAccepts(e) {
  return !!(e.data?.type === "snapshot" && e.data.final);
}

describe("worker snapshot プロトコル: final フラグ判別", () => {
  // 中間 snapshot は受理しない
  assert(
    finalHandlerAccepts(makeIntermediateMsg({ total: 400 })) === false,
    "中間 snapshot (final なし) は finalHandler に受理されない"
  );
  // 最終 snapshot は受理する
  assert(
    finalHandlerAccepts(makeFinalMsg({ total: 600 })) === true,
    "最終 snapshot (final:true) は finalHandler に受理される"
  );
  // type 違いは受理しない (ready 等)
  assert(
    finalHandlerAccepts({ data: { type: "ready" } }) === false,
    "type:ready は受理されない"
  );
  // data 欠落でも例外を投げず false
  assert(finalHandlerAccepts({}) === false, "data 欠落でも例外を投げず false");

  // キュー順序シナリオ: [中間(過小), 中間(過小), 最終(完全)] を順に処理。
  // finalHandler は最終のみ採用し、latestSnapshot は完全 payload になる。
  const queue = [
    makeIntermediateMsg({ total: 200 }), // 1バッチ目相当(過小)
    makeIntermediateMsg({ total: 400 }), // 2バッチ目相当(過小)
    makeFinalMsg({ total: 600 }),        // 全バッチ反映後の確定(完全)
  ];
  let latestSnapshot = null;
  let resolved = false;
  for (const e of queue) {
    if (resolved) break; // 確定後はリスナー解除済み相当
    if (finalHandlerAccepts(e)) {
      latestSnapshot = e.data.payload;
      resolved = true;
    }
  }
  assert(resolved === true, "キュー処理で最終 snapshot に到達して確定する");
  assertEqual(
    latestSnapshot,
    { total: 600 },
    "確定した latestSnapshot は最後のバッチを含む完全 payload (過小な中間値ではない)"
  );

  // 退行確認: もし旧仕様(type==="snapshot" だけで受理)なら、先頭の中間(過小)で
  // 確定してしまうことを示す (この値を採用しないのが今回の修正の眼目)。
  const legacyAccepts = (e) => e.data?.type === "snapshot";
  let legacyLatest = null;
  for (const e of queue) {
    if (legacyAccepts(e)) { legacyLatest = e.data.payload; break; }
  }
  assertEqual(
    legacyLatest,
    { total: 200 },
    "旧仕様だと先頭の中間(過小=200)で確定してしまう (= 修正前の取りこぼしバグ)"
  );
});

/* ============ 2. in-flight Map の同一性ガード ============ */
//
// stats-cache.js cached() / stats-compare.js aggregateRange() 共通:
//   p.finally(() => { if (map.get(key) === p) map.delete(key); })
// clear() 後に旧 p が settle しても、新 run の p_new を誤削除しないことを検証する。

// 同一性ガード付き delete (現行実装)
function guardedDelete(map, key, p) {
  if (map.get(key) === p) map.delete(key);
}
// 無条件 delete (修正前の挙動。対比用)
function unconditionalDelete(map, key) {
  map.delete(key);
}

describe("in-flight Map: 同一性ガード付き delete", () => {
  const KEY = "weekly-list:alice";

  // シナリオ:
  //   1) 旧 run が p_old を登録
  //   2) clear() で Map を空に
  //   3) 新 run が同一キーで p_new を登録
  //   4) 旧 p_old が遅れて settle → finally が delete を試みる
  // 期待: 同一性ガードなら p_new は残る / 無条件 delete なら p_new が消える

  // --- 現行(ガードあり): p_new が残る ---
  {
    const map = new Map();
    const pOld = Symbol("p_old");
    const pNew = Symbol("p_new");
    map.set(KEY, pOld);          // 1) 旧 run
    map.clear();                 // 2) clearWeekInflight / clearCache 相当
    map.set(KEY, pNew);          // 3) 新 run
    guardedDelete(map, KEY, pOld); // 4) 旧 p_old の finally が発火
    assert(map.get(KEY) === pNew, "ガードあり: 旧 p_old の finally は新 p_new を消さない");
    assert(map.has(KEY) === true, "ガードあり: 新 run の in-flight エントリが生存する");
  }

  // --- 修正前(無条件): p_new が誤って消える (退行の証拠) ---
  {
    const map = new Map();
    const pOld = Symbol("p_old");
    const pNew = Symbol("p_new");
    map.set(KEY, pOld);
    map.clear();
    map.set(KEY, pNew);
    unconditionalDelete(map, KEY); // 旧 finally が無条件 delete
    assert(map.has(KEY) === false, "無条件 delete: 新 p_new まで誤削除される (= 修正前のバグ)");
  }

  // --- 通常完了(同一性一致): 自分のエントリは正しく解放される ---
  {
    const map = new Map();
    const p = Symbol("p");
    map.set(KEY, p);
    guardedDelete(map, KEY, p); // 自分が settle → 自分を解放
    assert(map.has(KEY) === false, "ガードあり: 自分(p)の settle では正しく解放される");
  }
});

/* ============ 3. 最終 snapshot 待ちのタイムアウト/settled 状態機械 ============ */
//
// stats-service.js の最終 snapshot 待ち Promise を、実タイマー無しで決定論的に再現する。
// 実装の分岐(v1.1.50):
//   finalHandler(final:true) → settled=true, clearTimeout, removeListener, resolve  (warn しない)
//   postMessage throw        → settled=true, clearTimeout, removeListener, resolve  (warn しない)
//   timer fire (3s)          → removeListener; if(!settled) console.warn; resolve
// 検証点: (1)正常系/例外系で warn せず無応答時のみ warn、(2)正常系/例外系では冗長タイマーが
//         発火しない(clearTimeout 済み)、(3)resolve は必ず 1 回(二重解決しない)。
// 注: ここで再現する latestSnapshot は finalHandler が設定する分のみ(中間 snapshot は
//     ループ内の onMessage が設定し本 Promise の対象外)。

function simulateFinalWait({ messages = [], postMessageThrows = false }) {
  let settled = false;
  let resolveCount = 0;
  let warned = false;
  let timerActive = false;   // setTimeout が生きているか(false=clearTimeout 済み)
  let listenerActive = true; // finalHandler が登録中か
  let latestSnapshot = null;

  const resolve = () => { resolveCount++; };

  // 実装順を再現: addEventListener → setTimeout(先張り) → postMessage(try/catch)
  timerActive = true;

  const finalHandler = (e) => {
    if (!listenerActive) return; // removeEventListener 済みなら発火しない
    if (e.data?.type === "snapshot" && e.data.final) {
      latestSnapshot = e.data.payload;
      listenerActive = false;
      settled = true;
      timerActive = false; // clearTimeout
      resolve();
    }
  };

  if (postMessageThrows) {
    // catch: settled=true, clearTimeout, removeListener, resolve
    settled = true;
    timerActive = false;
    listenerActive = false;
    resolve();
  } else {
    for (const e of messages) {
      if (!listenerActive) break;
      finalHandler(e);
    }
  }

  // タイマーがまだ生きていれば 3 秒後に発火(無応答シナリオ)
  let timerFired = false;
  if (timerActive) {
    timerFired = true;
    listenerActive = false;
    if (!settled) warned = true;
    resolve();
  }

  return { settled, resolveCount, warned, timerFired, latestSnapshot };
}

describe("最終 snapshot 待ち: タイムアウト/settled 状態機械", () => {
  // (1) 正常系: final:true が届く → warn なし、タイマー空打ちなし、resolve 1 回
  {
    const r = simulateFinalWait({ messages: [{ data: { type: "snapshot", payload: { total: 600 }, final: true } }] });
    assert(r.settled === true, "正常系: settled=true");
    assert(r.warned === false, "正常系: warn しない");
    assert(r.timerFired === false, "正常系: 冗長タイマーは発火しない(clearTimeout 済み)");
    assertEqual(r.resolveCount, 1, "正常系: resolve は 1 回のみ(二重解決しない)");
    assertEqual(r.latestSnapshot, { total: 600 }, "正常系: 最終 payload を確定");
  }

  // (2) 無応答: final が来ず中間のみ → タイマー発火、warn する、resolve 1 回
  {
    const r = simulateFinalWait({ messages: [
      { data: { type: "snapshot", payload: { total: 200 } } }, // 中間(final なし=無視)
      { data: { type: "ready" } },
    ] });
    assert(r.settled === false, "無応答: settled は false のまま");
    assert(r.timerFired === true, "無応答: 3 秒タイマーが発火する");
    assert(r.warned === true, "無応答: Worker 無応答として warn する");
    assertEqual(r.resolveCount, 1, "無応答: resolve は 1 回のみ");
    assert(r.latestSnapshot === null, "無応答: finalHandler は中間を採用しない(null)");
  }

  // (3) postMessage 例外: 即 settle → warn なし、タイマー空打ちなし、resolve 1 回
  {
    const r = simulateFinalWait({ postMessageThrows: true });
    assert(r.settled === true, "例外: settled=true");
    assert(r.warned === false, "例外: warn しない(無応答ではなく送信不能)");
    assert(r.timerFired === false, "例外: 冗長タイマーは発火しない(catch で clearTimeout)");
    assertEqual(r.resolveCount, 1, "例外: resolve は 1 回のみ(二重解決しない)");
  }
});

/* ============ 結果出力 ============ */
console.log(`\n${"=".repeat(40)}`);
console.log(`PASS: ${passCount}  FAIL: ${failCount}`);
if (failCount > 0) {
  console.error("\n失敗:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("すべて成功 ✓");
