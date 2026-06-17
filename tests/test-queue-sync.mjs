/**
 * スクロブルキュー件数の同期ロジック単体テスト
 *
 * 検証対象:
 *   - app.js の updateStatusPill ロジック (ピル表示の優先順位)
 *   - view-settings.js の updateQueueUI (件数 DOM 更新)
 *   - 購読同期 (appState.scrobbleQueueCount 変化時の伝播)
 *
 * 実行: node tests/test-queue-sync.mjs
 */

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
function describe(name, fn) { console.log(`\n=== ${name} ===`); fn(); }

/* ============ app.js updateStatusPill ロジック ============ */

/**
 * app.js のステータスピル更新ロジックを抽出
 *   - scrobbleQueueCount > 0 → 「未送信スクロブル N 件」(err)  ★最優先
 *   - authenticated → 「Last.fm: user」(ok)
 *   - key-only → 「読取専用: user」
 *   - その他 → 空
 */
function computePill(s) {
  if ((s.scrobbleQueueCount || 0) > 0) {
    return { text: `未送信スクロブル ${s.scrobbleQueueCount} 件`, cls: "is-err" };
  } else if (s.authState === "authenticated") {
    return { text: `Last.fm: ${s.username || ""}`, cls: "is-ok" };
  } else if (s.authState === "key-only") {
    return { text: `読取専用: ${s.username || ""}`, cls: "" };
  } else {
    return { text: "", cls: "" };
  }
}

describe("ステータスピル表示ロジック (app.js)", () => {
  // フル認証 + キューなし
  assertEqual(
    computePill({ scrobbleQueueCount: 0, authState: "authenticated", username: "alice" }),
    { text: "Last.fm: alice", cls: "is-ok" },
    "フル認証 + キュー 0 → 「Last.fm: user」(ok)"
  );

  // フル認証 + キューあり → キュー件数を優先表示（ユーザー報告対応）
  assertEqual(
    computePill({ scrobbleQueueCount: 3, authState: "authenticated", username: "alice" }),
    { text: "未送信スクロブル 3 件", cls: "is-err" },
    "フル認証 + キュー 3 件 → 「未送信スクロブル 3 件」(err) (認証より優先)"
  );

  // 読取専用
  assertEqual(
    computePill({ scrobbleQueueCount: 0, authState: "key-only", username: "bob" }),
    { text: "読取専用: bob", cls: "" },
    "読取専用 + キュー 0 → 「読取専用: user」"
  );

  // 未認証 + キューあり (例外的状況だが備える)
  assertEqual(
    computePill({ scrobbleQueueCount: 5, authState: "anonymous" }),
    { text: "未送信スクロブル 5 件", cls: "is-err" },
    "未認証 + キューあり → キュー件数表示"
  );

  // 未認証 + キューなし
  assertEqual(
    computePill({ scrobbleQueueCount: 0, authState: "anonymous" }),
    { text: "", cls: "" },
    "未認証 + キュー 0 → 空"
  );

  // username なし
  assertEqual(
    computePill({ scrobbleQueueCount: 0, authState: "authenticated" }),
    { text: "Last.fm: ", cls: "is-ok" },
    "username 未定義 → 空文字で結合"
  );
});

/* ============ view-settings.js updateQueueUI ロジック ============ */

/**
 * view-settings.js の updateQueueUI を抽出 (DOM 更新内容を返す形)
 */
function computeQueueUI(count) {
  return {
    countText: String(count),
    btnFlushDisabled: count === 0,
    btnWipeDisabled: count === 0,
  };
}

describe("設定画面 キュー UI 更新ロジック", () => {
  assertEqual(
    computeQueueUI(0),
    { countText: "0", btnFlushDisabled: true, btnWipeDisabled: true },
    "件数 0 → 0 件表示、ボタン disabled"
  );
  assertEqual(
    computeQueueUI(1),
    { countText: "1", btnFlushDisabled: false, btnWipeDisabled: false },
    "件数 1 → 1 件表示、ボタン enabled"
  );
  assertEqual(
    computeQueueUI(42),
    { countText: "42", btnFlushDisabled: false, btnWipeDisabled: false },
    "件数 42 → 42 件表示、ボタン enabled"
  );
});

/* ============ 購読同期シミュレーション ============ */

/**
 * appState 風の最小モック (EventTarget ベース)
 */
class MockAppState {
  constructor(initial) {
    this.state = { ...initial };
    this.subscribers = [];
  }
  get() { return this.state; }
  set(patch) {
    const prev = this.state;
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (prev[k] !== patch[k]) changed = true;
    }
    this.state = { ...prev, ...patch };
    if (changed) {
      this.subscribers.forEach((sub) => {
        const interested = sub.keys.some((k) => k in patch);
        if (interested) sub.cb(this.state);
      });
    }
  }
  subscribe(keys, cb) {
    const sub = { keys, cb };
    this.subscribers.push(sub);
    return () => {
      const i = this.subscribers.indexOf(sub);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }
}

describe("キュー件数変化の同期シミュレーション", () => {
  const appState = new MockAppState({
    scrobbleQueueCount: 0,
    authState: "authenticated",
    username: "alice",
  });

  // ピル購読 (app.js 相当)
  let lastPill = null;
  appState.subscribe(["authState", "username", "scrobbleQueueCount"], (s) => {
    lastPill = computePill(s);
  });
  // 初期描画 (subscribe は変更通知のみなので手動で呼ぶ)
  lastPill = computePill(appState.get());

  // 設定画面のキュー UI 購読 (view-settings.js 相当)
  let lastQueueUI = null;
  const unsubSettings = appState.subscribe(["scrobbleQueueCount"], (s) => {
    lastQueueUI = computeQueueUI(s.scrobbleQueueCount);
  });
  lastQueueUI = computeQueueUI(appState.get().scrobbleQueueCount);

  // 初期状態
  assertEqual(lastPill.text, "Last.fm: alice", "初期: フル認証ピル");
  assertEqual(lastQueueUI.countText, "0", "初期: キュー 0 件");

  // 再生中にオフライン → スクロブル発生 → enqueue → refreshBadge → set scrobbleQueueCount=1
  appState.set({ scrobbleQueueCount: 1 });
  assertEqual(lastPill.text, "未送信スクロブル 1 件",
    "新スクロブルがキューに → ピルが「未送信スクロブル 1 件」に変化");
  assertEqual(lastQueueUI,
    { countText: "1", btnFlushDisabled: false, btnWipeDisabled: false },
    "設定画面のキュー件数も即座に 1 件に更新（リアルタイム反映、ユーザー報告対応）");

  // さらに 2 件目
  appState.set({ scrobbleQueueCount: 2 });
  assertEqual(lastPill.text, "未送信スクロブル 2 件", "2 件目 → ピル更新");
  assertEqual(lastQueueUI.countText, "2", "設定画面 2 件");

  // 「破棄」操作: wipeQueue → refreshBadge → set scrobbleQueueCount=0
  appState.set({ scrobbleQueueCount: 0 });
  assertEqual(lastPill.text, "Last.fm: alice",
    "破棄後: ピルが「Last.fm: user」に戻る (修正前は残ったままだった)");
  assertEqual(lastQueueUI,
    { countText: "0", btnFlushDisabled: true, btnWipeDisabled: true },
    "破棄後: 設定画面のキュー件数 0、ボタン disabled");

  // 設定画面を離れて購読解除 (画面遷移シミュレーション)
  unsubSettings();
  // unsub 後にキューが追加されても設定画面の UI は更新されない (画面を見ていないから)
  appState.set({ scrobbleQueueCount: 5 });
  assertEqual(lastQueueUI.countText, "0", "unsub 後: 設定画面の UI は更新されない");
  // しかしピルは引き続き更新される
  assertEqual(lastPill.text, "未送信スクロブル 5 件",
    "unsub 後もピルは別購読で更新される");
});

/* ============ 「破棄」前後の状態シーケンス ============ */

describe("ユーザー報告シナリオ: フル認証 + オフライン再生 → 破棄", () => {
  const appState = new MockAppState({
    scrobbleQueueCount: 0,
    authState: "authenticated",
    username: "alice",
  });
  const events = [];

  // 画面上部ピル購読
  appState.subscribe(["authState", "username", "scrobbleQueueCount"], (s) => {
    events.push({ type: "pill", text: computePill(s).text });
  });
  // 設定画面の購読
  appState.subscribe(["scrobbleQueueCount"], (s) => {
    events.push({ type: "queue-ui", count: s.scrobbleQueueCount });
  });

  // シナリオ実行
  // 1. オフライン再生 → スクロブル発生 → enqueue → refreshBadge
  appState.set({ scrobbleQueueCount: 1 });
  // 2. もう一曲再生 → さらに enqueue
  appState.set({ scrobbleQueueCount: 2 });
  // 3. 設定画面で「破棄」タップ → wipeQueue → refreshBadge → 0
  appState.set({ scrobbleQueueCount: 0 });

  // 期待されるイベント順序
  const pillEvents = events.filter((e) => e.type === "pill").map((e) => e.text);
  const queueEvents = events.filter((e) => e.type === "queue-ui").map((e) => e.count);

  assertEqual(pillEvents, [
    "未送信スクロブル 1 件",
    "未送信スクロブル 2 件",
    "Last.fm: alice",
  ], "ピル: 1 件 → 2 件 → Last.fm: alice (破棄で正しく戻る)");

  assertEqual(queueEvents, [1, 2, 0],
    "設定画面: 1 → 2 → 0 (リアルタイム更新)");
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
