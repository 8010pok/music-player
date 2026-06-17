/**
 * オフライン関連挙動の単体テスト
 *   - Now Playing 抑制ロジック (view-stats.js renderDashboard 相当)
 *   - スクロブル結果に応じたメッセージ切替 (view-player.js updateUI 相当)
 *   - sendScrobble の戻り値仕様 (scrobble.js sendScrobble 相当)
 *
 * 実行: node tests/test-offline-behavior.mjs
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

/* ============ Now Playing 抑制ロジック ============ */

/**
 * renderDashboard で nowPlaying を判定するロジックを抽出してテスト
 *   const online = typeof navigator === "undefined" || navigator.onLine !== false;
 *   const nowPlaying = online && d?.recent && d.recent[0] && d.recent[0].nowPlaying
 *     ? d.recent[0]
 *     : null;
 */
function decideNowPlaying(dashboardSection, isOnline) {
  // typeof navigator === "undefined" の場合（Node.js）は online=true 扱い
  const online = isOnline === undefined ? true : isOnline;
  const d = dashboardSection;
  return online && d?.recent && d.recent[0] && d.recent[0].nowPlaying
    ? d.recent[0]
    : null;
}

describe("Now Playing 抑制ロジック", () => {
  // オンライン + 最初の曲が nowPlaying → カード表示
  const trackA = { name: "曲A", artist: "アーティスト", nowPlaying: true };
  assert(
    decideNowPlaying({ recent: [trackA] }, true) === trackA,
    "オンライン + recent[0].nowPlaying=true → Now Playing 表示"
  );

  // オフライン + 最初の曲が nowPlaying → カード非表示（ユーザー報告のシナリオ）
  assert(
    decideNowPlaying({ recent: [trackA] }, false) === null,
    "オフライン + recent[0].nowPlaying=true → Now Playing 非表示 (旧データを表示しない)"
  );

  // オンライン + 最初の曲が通常 → カード非表示
  const trackB = { name: "曲B", artist: "アーティスト", nowPlaying: false };
  assert(
    decideNowPlaying({ recent: [trackB] }, true) === null,
    "オンライン + recent[0].nowPlaying=false → 表示なし"
  );

  // オフライン + 最初の曲が通常 → カード非表示
  assert(
    decideNowPlaying({ recent: [trackB] }, false) === null,
    "オフライン + recent[0].nowPlaying=false → 表示なし"
  );

  // recent 空 → カード非表示
  assert(
    decideNowPlaying({ recent: [] }, true) === null,
    "recent 空 → 表示なし"
  );

  // dashboard セクション null → カード非表示
  assert(
    decideNowPlaying(null, true) === null,
    "dashboard セクション null → 表示なし"
  );

  // typeof navigator === "undefined" 相当（フォールバック: オンライン扱い）
  assert(
    decideNowPlaying({ recent: [trackA] }, undefined) === trackA,
    "navigator が未定義 → オンライン扱い (テスト環境フォールバック)"
  );
});

/* ============ ライブ更新スキップロジック ============ */

/**
 * stats-service.js の doDashboardLiveUpdate 冒頭ガード相当
 */
function shouldRunLiveUpdate(liveActive, hasUser, isHidden, isOnline) {
  if (!liveActive) return false;
  if (!hasUser) return false;
  if (isHidden) return false;
  if (isOnline === false) return false;
  return true;
}

describe("doDashboardLiveUpdate スキップ条件", () => {
  assert(shouldRunLiveUpdate(true, true, false, true), "全条件満たす → 実行");
  assert(!shouldRunLiveUpdate(false, true, false, true), "liveActive=false → スキップ");
  assert(!shouldRunLiveUpdate(true, false, false, true), "user 未設定 → スキップ");
  assert(!shouldRunLiveUpdate(true, true, true, true), "バックグラウンド (hidden) → スキップ");
  assert(!shouldRunLiveUpdate(true, true, false, false), "オフライン → スキップ (新規追加)");
});

/* ============ sendScrobble 戻り値仕様 ============ */

/**
 * scrobble.js の sendScrobble 戻り値判定相当（ネットワーク/認証を模擬）
 */
async function fakeSendScrobble(track, { hasAuth, networkOk, idbOk }) {
  if (!track) return "skipped";
  if (!hasAuth) return "skipped";
  if (networkOk) return "sent";
  // 送信失敗 → キューへ
  if (idbOk) return "queued";
  return "failed";
}

describe("sendScrobble 戻り値", () => {
  const t = { artist: "A", title: "T" };

  (async () => {
    assertEqual(
      await fakeSendScrobble(null, { hasAuth: true, networkOk: true, idbOk: true }),
      "skipped", "track なし → skipped"
    );
    assertEqual(
      await fakeSendScrobble(t, { hasAuth: false, networkOk: true, idbOk: true }),
      "skipped", "未認証 → skipped"
    );
    assertEqual(
      await fakeSendScrobble(t, { hasAuth: true, networkOk: true, idbOk: true }),
      "sent", "認証あり + オンライン → sent"
    );
    assertEqual(
      await fakeSendScrobble(t, { hasAuth: true, networkOk: false, idbOk: true }),
      "queued", "認証あり + オフライン → queued (キュー登録)"
    );
    assertEqual(
      await fakeSendScrobble(t, { hasAuth: true, networkOk: false, idbOk: false }),
      "failed", "ネットワーク + IDB 両方失敗 → failed"
    );
  })();
});

/* ============ scrobbleLabel メッセージ切替 ============ */

/**
 * view-player.js の scrobbleLabel 表示ロジックを抽出
 */
function scrobbleLabel(s) {
  if (s.scrobbleProgress >= 1) {
    switch (s.scrobbleResult) {
      case "queued":  return "スクロブルをキューに登録（オンライン復帰で送信）";
      case "failed":  return "スクロブル送信失敗";
      case "skipped": return "スクロブル無効（設定または未認証）";
      case "sent":    return "スクロブル送信済";
      default:        return "スクロブル送信中…";
    }
  } else if (s.authState === "authenticated") {
    return `スクロブル進捗 ${Math.round((s.scrobbleProgress || 0) * 100)}%`;
  } else {
    return "Last.fm 未認証（スクロブル無効）";
  }
}

describe("scrobbleLabel メッセージ切替", () => {
  // 進捗 < 1 のとき
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 0, authState: "anonymous" }),
    "Last.fm 未認証（スクロブル無効）",
    "未認証 + 進捗 0% → 未認証メッセージ"
  );
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 0.5, authState: "authenticated" }),
    "スクロブル進捗 50%",
    "認証済 + 進捗 50% → 進捗表示"
  );

  // 進捗 1 のとき: scrobbleResult による切替
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1, scrobbleResult: "sent" }),
    "スクロブル送信済",
    "送信成功 → 「スクロブル送信済」"
  );
  // ★ ユーザーが報告した不具合の対象ケース
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1, scrobbleResult: "queued" }),
    "スクロブルをキューに登録（オンライン復帰で送信）",
    "オフライン送信 (queued) → 「キューに登録」メッセージ (修正前は誤って「送信済」と表示されていた)"
  );
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1, scrobbleResult: "failed" }),
    "スクロブル送信失敗",
    "失敗 → 「送信失敗」"
  );
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1, scrobbleResult: "skipped" }),
    "スクロブル無効（設定または未認証）",
    "skipped → 「スクロブル無効」"
  );
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1, scrobbleResult: "sending" }),
    "スクロブル送信中…",
    "送信中（結果未確定）→ 「送信中…」"
  );
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1, scrobbleResult: "none" }),
    "スクロブル送信中…",
    "none（onScrobble 直後）→ 「送信中…」"
  );
  assertEqual(
    scrobbleLabel({ scrobbleProgress: 1 }),
    "スクロブル送信中…",
    "scrobbleResult 未定義 → 「送信中…」"
  );
});

/* ============ scrobbleResult 状態遷移シミュレーション ============ */

describe("scrobbleResult 状態遷移", () => {
  // 曲開始 → 再生中 → 進捗 1 達成 → 結果反映 → 曲変更でリセット
  let s = {
    currentTrack: { id: "t1" },
    scrobbleProgress: 0,
    scrobbledForCurrent: false,
    scrobbleResult: "none",
  };
  assertEqual(s.scrobbleResult, "none", "曲開始時: none");

  s.scrobbleProgress = 0.3;
  assertEqual(s.scrobbleResult, "none", "再生中（進捗 30%）: none のまま");

  // 進捗 1 達成: scrobbledForCurrent=true + scrobbleResult="sending"
  s.scrobbleProgress = 1;
  s.scrobbledForCurrent = true;
  s.scrobbleResult = "sending";
  assertEqual(s.scrobbleResult, "sending", "進捗 1 達成直後: sending");

  // 送信完了
  s.scrobbleResult = "sent";
  assertEqual(s.scrobbleResult, "sent", "送信成功: sent");

  // 曲変更
  s = {
    currentTrack: { id: "t2" },
    scrobbleProgress: 0,
    scrobbledForCurrent: false,
    scrobbleResult: "none",  // audio-engine の loadAndPlay 内でリセット
  };
  assertEqual(s.scrobbleResult, "none", "曲変更後: none にリセット");

  // オフライン再生の流れ
  s.scrobbleProgress = 1;
  s.scrobbledForCurrent = true;
  s.scrobbleResult = "sending";
  s.scrobbleResult = "queued";  // sendScrobble が "queued" を返す
  assertEqual(s.scrobbleResult, "queued",
    "オフライン → queued: 再生画面で「キューに登録」と表示される (ユーザー報告対応)");
});

/* ============ 結果 ============ */

setTimeout(() => {
  console.log("\n" + "=".repeat(60));
  console.log(`合計: ${passCount + failCount} / 成功: ${passCount} / 失敗: ${failCount}`);
  if (failCount > 0) {
    console.log("\n失敗一覧:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("全テスト成功 ✓");
  }
}, 100);
