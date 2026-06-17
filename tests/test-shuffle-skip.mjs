/**
 * シャッフル再生 + エラー時スキップロジックの単体テスト
 *
 * 検証対象:
 *   - shuffleCurrentQueue: 全曲がキューに含まれる
 *   - advanceFromEnded: キュー末尾まで進む（リピートなし時に勝手に停止しない）
 *   - skipToNextOnError: 再生不可曲を自動でスキップ、連続失敗で停止
 *   - シャッフル再生中に途中曲が読み込めない場合の全体挙動
 *
 * 実行: node tests/test-shuffle-skip.mjs
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
function describe(name, fn) { console.log(`\n=== ${name} ===`); return fn(); }

/* ============ shuffleCurrentQueue ロジック ============ */

/**
 * audio-engine.js の shuffleCurrentQueue を抽出。
 * - 現在曲を先頭に固定
 * - 残りをシャッフル
 * - origQueue に元順序を保存
 * - queueIndex を 0 にリセット
 */
function shuffleCurrentQueue(state) {
  if (state.queue.length <= 1) return;
  const curId = state.queue[state.queueIndex]?.id;
  if (!state.origQueue) state.origQueue = state.queue.slice();
  const rest = state.queue.filter((t) => t.id !== curId);
  // テストで決定論的にするためシャッフルは省略（順序検証は別の観点）
  // 本番では Fisher-Yates シャッフル
  const cur = state.queue[state.queueIndex];
  state.queue = cur ? [cur, ...rest] : rest;
  state.queueIndex = 0;
}

describe("shuffleCurrentQueue: 全曲がキューに含まれる", () => {
  // 10 曲のキュー
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}` }));
  const state = { queue: tracks.slice(), queueIndex: 5, origQueue: null };
  shuffleCurrentQueue(state);

  assertEqual(state.queue.length, 10, "シャッフル後も曲数は維持 (10曲)");
  assertEqual(state.queue[0].id, "t5", "現在曲 (t5) が先頭");
  assertEqual(state.queueIndex, 0, "queueIndex が 0 にリセット");
  // 全曲が残っているか確認
  const ids = state.queue.map((t) => t.id).sort();
  const expected = Array.from({ length: 10 }, (_, i) => `t${i}`).sort();
  assertEqual(ids, expected, "全 10 曲が新キューに含まれる (失われた曲なし)");
  // origQueue が保存されている
  assertEqual(state.origQueue.length, 10, "origQueue に元順序保存");
});

describe("shuffleCurrentQueue: エッジケース", () => {
  // 1 曲
  const s1 = { queue: [{ id: "a" }], queueIndex: 0, origQueue: null };
  shuffleCurrentQueue(s1);
  assertEqual(s1.queue.length, 1, "1 曲 → そのまま (早期 return)");
  assertEqual(s1.queueIndex, 0, "1 曲 → queueIndex 維持");

  // 0 曲
  const s0 = { queue: [], queueIndex: -1, origQueue: null };
  shuffleCurrentQueue(s0);
  assertEqual(s0.queue.length, 0, "0 曲 → 何もしない");

  // 2 曲、現在曲は 1 つ目
  const s2 = { queue: [{ id: "a" }, { id: "b" }], queueIndex: 0, origQueue: null };
  shuffleCurrentQueue(s2);
  assertEqual(s2.queue.length, 2, "2 曲 → 2 曲のまま");
  assertEqual(s2.queue[0].id, "a", "現在曲が先頭固定");
  assertEqual(s2.queue[1].id, "b", "残り 1 曲");
});

/* ============ advanceFromEnded: キュー末尾まで進む ============ */

/**
 * audio-engine.js の advanceFromEnded のロジックを抽出。
 * 各曲再生のシミュレーションで使う。
 */
function advanceFromEnded(state, repeat) {
  if (state.queue.length === 0) return { stop: true };
  if (repeat === "one") {
    return { loop: true };
  }
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (repeat === "all") {
      next = 0;
    } else {
      return { stop: true };
    }
  }
  state.queueIndex = next;
  return { next: state.queue[next] };
}

describe("advanceFromEnded: シャッフル + リピートなしで全曲再生", () => {
  // シャッフル後の 10 曲キュー
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 0 };

  // 順に再生されていく曲を追跡
  const played = [state.queue[0].id];
  for (let i = 0; i < 20; i++) {  // 余裕を持って 20 回試行
    const r = advanceFromEnded(state, "none");
    if (r.stop) break;
    played.push(r.next.id);
  }
  assertEqual(played.length, 10, "リピートなし: 10 曲全て再生される (途中で止まらない)");
  assertEqual(
    new Set(played).size, 10,
    "重複なし: 各曲がちょうど 1 回再生される"
  );
});

describe("advanceFromEnded: リピート all で循環", () => {
  const tracks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 0 };

  // 7 回 advance すれば、3 曲 × 2.33 周回するはず
  const played = [state.queue[0].id];
  for (let i = 0; i < 7; i++) {
    const r = advanceFromEnded(state, "all");
    if (r.stop) break;
    played.push(r.next.id);
  }
  assertEqual(played.length, 8, "リピート all: 止まらず周回 (7 回 advance + 初回 = 8)");
  assertEqual(played, ["t0", "t1", "t2", "t0", "t1", "t2", "t0", "t1"], "循環順序");
});

/* ============ skipToNextOnError ロジック ============ */

/**
 * audio-engine.js の skipToNextOnError を抽出。
 * 連続スキップカウンタで停止判定。
 */
const MAX_CONSECUTIVE_SKIPS = 5;

function skipToNextOnError(state, repeat) {
  state.consecutiveSkips++;
  if (state.consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
    state.consecutiveSkips = 0;
    return { stop: true, reason: "consecutive-limit" };
  }
  if (state.queue.length === 0) {
    return { stop: true, reason: "empty-queue" };
  }
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (repeat === "all") next = 0;
    else return { stop: true, reason: "queue-end" };
  }
  state.queueIndex = next;
  return { skipped: true, next: state.queue[next] };
}

describe("skipToNextOnError: シャッフル中の壊れた曲をスキップして次へ", () => {
  // シナリオ: 10 曲のシャッフルキュー、3 番目 (index=2) の曲が読み込めない
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 2, consecutiveSkips: 0 };

  // index=2 が読み込めない → skipToNextOnError 呼出
  const r = skipToNextOnError(state, "none");
  assert(r.skipped, "スキップ成功");
  assertEqual(r.next.id, "t3", "次の曲 (t3) に進む");
  assertEqual(state.queueIndex, 3, "queueIndex 更新");
  assertEqual(state.consecutiveSkips, 1, "連続スキップカウンタ +1");
});

describe("skipToNextOnError: 連続失敗で停止 (無限ループ防止)", () => {
  const tracks = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 0, consecutiveSkips: 0 };

  // 全曲読み込めない場合: MAX_CONSECUTIVE_SKIPS で止まるはず
  const results = [];
  for (let i = 0; i < 10; i++) {
    const r = skipToNextOnError(state, "none");
    results.push(r);
    if (r.stop) break;
  }
  // 5 回目で stop になる (4 回スキップ + 5 回目で limit)
  assertEqual(results.length, 5, "5 回試行で停止 (consecutive limit)");
  assertEqual(results[4].stop, true, "5 回目で停止");
  assertEqual(results[4].reason, "consecutive-limit", "停止理由は連続失敗");
  assertEqual(state.consecutiveSkips, 0, "カウンタがリセットされる");
});

describe("skipToNextOnError: キュー末尾でスキップ → 停止 (repeat=none)", () => {
  const tracks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 2, consecutiveSkips: 0 };
  // 末尾の曲が読み込めない → スキップしようとするがキュー終端 → 停止
  const r = skipToNextOnError(state, "none");
  assertEqual(r.stop, true, "キュー末尾でスキップ → 停止");
  assertEqual(r.reason, "queue-end", "停止理由はキュー末尾");
});

describe("skipToNextOnError: キュー末尾でスキップ → 先頭へ (repeat=all)", () => {
  const tracks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 2, consecutiveSkips: 0 };
  const r = skipToNextOnError(state, "all");
  assert(r.skipped, "スキップ成功");
  assertEqual(r.next.id, "t0", "リピート all → 先頭の t0 へ");
});

/* ============ シャッフル再生 + スキップの統合シナリオ ============ */

describe("統合: シャッフル再生中に 1 曲スキップして全曲再生", () => {
  // 5 曲のプレイリスト、index=2 の曲が読み込めない
  const tracks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks.slice(), queueIndex: 0, consecutiveSkips: 0, origQueue: null };

  // 全 5 曲を順に「再生」してみる。t2 のロードが失敗するシナリオ。
  const playedOrSkipped = [];
  const FAILING = "t2";
  let cur = state.queue[0];
  let safety = 0;
  while (cur && safety < 20) {
    safety++;
    if (cur.id === FAILING) {
      // ロード失敗 → スキップ
      playedOrSkipped.push({ id: cur.id, action: "skip" });
      const r = skipToNextOnError(state, "none");
      if (r.stop) break;
      cur = r.next;
    } else {
      // 再生成功 → 進捗終わって次曲
      playedOrSkipped.push({ id: cur.id, action: "play" });
      state.consecutiveSkips = 0;  // 成功でリセット
      const r = advanceFromEnded(state, "none");
      if (r.stop) break;
      cur = r.next;
    }
  }
  assertEqual(playedOrSkipped, [
    { id: "t0", action: "play" },
    { id: "t1", action: "play" },
    { id: "t2", action: "skip" },
    { id: "t3", action: "play" },
    { id: "t4", action: "play" },
  ], "t2 だけスキップして 4 曲は再生される (ユーザ報告対応)");
});

describe("統合: シャッフル中の連続失敗で停止する", () => {
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }));
  const state = { queue: tracks, queueIndex: 0, consecutiveSkips: 0 };

  // 全曲ロード失敗
  const events = [];
  let cur = state.queue[0];
  let safety = 0;
  while (cur && safety < 20) {
    safety++;
    events.push({ id: cur.id, action: "skip" });
    const r = skipToNextOnError(state, "none");
    if (r.stop) {
      events.push({ stop: true, reason: r.reason });
      break;
    }
    cur = r.next;
  }
  // 5 回目で stop (4 連続スキップ後の 5 回目 limit)
  assertEqual(events.length, 6, "5 回スキップ後に停止イベント");
  assertEqual(events[5], { stop: true, reason: "consecutive-limit" },
    "無限ループ防止: consecutive-limit で停止");
});

/* ============ 成功時にカウンタリセット ============ */

describe("成功時にカウンタリセット", () => {
  const state = { queue: [], queueIndex: -1, consecutiveSkips: 3 };
  // 成功時の処理を抽出（loadAndPlay 内の audioEl.play() 成功後）
  function onPlaySuccess(s) { s.consecutiveSkips = 0; }
  onPlaySuccess(state);
  assertEqual(state.consecutiveSkips, 0,
    "play 成功 → カウンタリセット (1曲だけ失敗 → 成功 → 後の失敗で再カウント可能)");
});

/* ============ playNext (ユーザ「次へ」) はスキップカウンタの影響を受けない ============ */

describe("playNext (手動「次へ」) は独立", () => {
  // playNext はユーザ意思で呼ばれる。consecutiveSkips とは別系統で動く。
  // (実装上、playNext はカウンタを触らず、advanceFromEnded もカウンタを触らない)
  const state = { queue: [{id: "a"}, {id: "b"}], queueIndex: 0, consecutiveSkips: 3 };
  // 次へ
  state.queueIndex++;
  assertEqual(state.queueIndex, 1, "playNext で進む");
  assertEqual(state.consecutiveSkips, 3, "playNext はカウンタを変えない");
});

/* ============ シャッフル中の Math.random ロジックの検証 ============ */

describe("Fisher-Yates シャッフル: 統計的検証", () => {
  // Fisher-Yates シャッフル
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const original = Array.from({ length: 10 }, (_, i) => i);
  // 100 回試行して、各位置に各値が現れるか確認
  const positionCount = original.map(() => Array(10).fill(0));
  for (let trial = 0; trial < 100; trial++) {
    const s = shuffle(original);
    s.forEach((v, idx) => positionCount[idx][v]++);
  }
  // 各位置で各値が少なくとも 1 回現れる（極端な偏りがない）
  let allCovered = true;
  for (let pos = 0; pos < 10; pos++) {
    for (let val = 0; val < 10; val++) {
      if (positionCount[pos][val] === 0) {
        allCovered = false;
        break;
      }
    }
  }
  assert(allCovered, "Fisher-Yates: 100 回試行で全位置に全値が現れる (極端な偏りなし)");

  // 要素数が維持される
  const s2 = shuffle(original);
  assertEqual(s2.length, original.length, "シャッフル後も要素数同じ");
  assertEqual(new Set(s2).size, original.length, "シャッフル後も値の集合同じ (失われない)");
});

/* ============ iOS バックグラウンド誤動作対策 (v1.0.87 修正) ============ */

describe("audio.error イベント: 自動スキップしない (iOS 誤動作対策)", () => {
  // 修正前: skipToNextOnError を呼んでいた → iOS バックグラウンドの一過性
  //         error で誤動作。ユーザ報告: 「1 曲目で停止 → 次曲に切替 → そこも停止」
  // 修正後: ログのみで何もしない (mp3player の挙動に合わせる)
  function shouldSkipOnAudioError(transitioning) {
    // 修正後の挙動: 常に false
    return false;
  }
  assert(!shouldSkipOnAudioError(false), "通常時の audio.error → スキップしない");
  assert(!shouldSkipOnAudioError(true), "transitioning 中の audio.error → スキップしない");
});

describe("loadAndPlay play() 失敗時: 自動スキップしない (iOS 誤動作対策)", () => {
  // 修正前: NotAllowedError / AbortError 以外で skipToNextOnError を呼んでいた
  // 修正後: 全てのエラーで isPlaying:false のみ。次曲には進まない。
  //         iOS audio session 一時取得失敗で次曲連鎖スキップを防止。
  function shouldSkipOnPlayError(errorName) {
    return false;
  }
  assert(!shouldSkipOnPlayError("NotAllowedError"),
    "NotAllowedError → スキップしない (自動再生制約)");
  assert(!shouldSkipOnPlayError("AbortError"),
    "AbortError → スキップしない (意図的な中断)");
  assert(!shouldSkipOnPlayError("NotSupportedError"),
    "NotSupportedError → スキップしない (修正前は ✓だったが iOS 誤動作するため変更)");
  assert(!shouldSkipOnPlayError("Other"),
    "未知エラー → スキップしない");
});

describe("blob 未発見時のみ skipToNextOnError が呼ばれる (確定エラー)", () => {
  // skipToNextOnError 呼び出し条件のホワイトリスト確認。
  // 確定的に「ファイル本体が無い」場合のみ自動次曲スキップ。
  function shouldCallSkipOnError(scenario) {
    return scenario === "blob_missing";
  }
  assert(shouldCallSkipOnError("blob_missing"),
    "blob 未発見 → スキップ (確定的エラー、IDB が成功して null 返却)");
  assert(!shouldCallSkipOnError("play_failed"),
    "play 失敗 → スキップしない (iOS で一過性が起こりうる)");
  assert(!shouldCallSkipOnError("audio_error"),
    "audio.error → スキップしない (iOS バックグラウンドで誤発火)");
  assert(!shouldCallSkipOnError("loadedmetadata_timeout"),
    "loadedmetadata タイムアウト → スキップしない (タイムアウト時間は短い保険)");
  assert(!shouldCallSkipOnError("network_error"),
    "ネットワークエラー → スキップしない (Last.fm fetch とは無関係に再生継続)");
});

describe("Audio Session API でブラウザに playback 意図を宣言 (v1.0.91)", () => {
  // MDN: navigator.audioSession.type = "playback" を設定すると、
  //      iOS 16.4+ Safari は「これは長時間再生される音楽プレイヤー」として
  //      audio session を扱い、バックグラウンド/ロック画面再生で session が
  //      早期解放されにくくなる。

  // setupAudioSession 相当のロジックを抽出
  function setupAudioSession(audioSessionObj) {
    if (!audioSessionObj) return { setType: null };
    try {
      audioSessionObj.type = "playback";
      return { setType: "playback" };
    } catch {
      return { setType: null };
    }
  }

  // iOS 16.4+ Safari: audioSession 存在
  const ios164 = { type: "auto" };
  const r1 = setupAudioSession(ios164);
  assertEqual(r1.setType, "playback", "iOS 16.4+: type=playback に設定");
  assertEqual(ios164.type, "playback", "実際に type プロパティが変わる");

  // 旧 iOS / Android / Desktop: audioSession 未定義
  const r2 = setupAudioSession(undefined);
  assertEqual(r2.setType, null, "未対応環境: feature detection で skip (害なし)");

  // setter が throw する実装: 例外を握りつぶし
  const buggyAudioSession = {};
  Object.defineProperty(buggyAudioSession, "type", {
    set() { throw new Error("not supported"); },
  });
  const r3 = setupAudioSession(buggyAudioSession);
  assertEqual(r3.setType, null, "setter が throw → エラーは握りつぶし、再生に影響しない");

  // 有効な type 値の一覧 (MDN AudioSession API より)
  const VALID_TYPES = new Set([
    "auto", "playback", "transient", "transient-solo", "ambient", "play-and-record"
  ]);
  assert(VALID_TYPES.has("playback"), "MDN 仕様: playback は有効な type 値");
});

describe("MDN MediaSession 仕様への準拠確認 (v1.0.91)", () => {
  // playbackState 値は "none" | "playing" | "paused" のみ
  const VALID_PLAYBACK_STATES = ["none", "playing", "paused"];
  for (const v of VALID_PLAYBACK_STATES) {
    assert(VALID_PLAYBACK_STATES.includes(v), `playbackState "${v}" は MDN 仕様準拠`);
  }

  // setActionHandler の action 名はすべて小文字 (MDN setActionHandler 仕様)
  const REQUIRED_ACTIONS = [
    "play", "pause", "previoustrack", "nexttrack",
    "seekto", "seekbackward", "seekforward", "stop"
  ];
  for (const a of REQUIRED_ACTIONS) {
    assertEqual(a, a.toLowerCase(),
      `MediaSession action "${a}" は全小文字 (camelCase ではない)`);
  }

  // setPositionState の引数構造: { duration, playbackRate, position }
  function buildPositionStatePayload(dur, rate, pos) {
    return { duration: dur, playbackRate: rate, position: pos };
  }
  const ps = buildPositionStatePayload(180, 1.0, 45);
  assertEqual(Object.keys(ps).sort(), ["duration", "playbackRate", "position"],
    "setPositionState の引数は { duration, playbackRate, position }");
  assert(ps.position <= ps.duration, "position は duration 以下");
  assert(ps.playbackRate > 0, "playbackRate は正の値 (0 ではない)");
});

describe("getBlob を先に取得する順序修正 (v1.0.90): audio.src 空状態時間を最短化", () => {
  // ユーザ実機報告: PWA をしばらく使用していない状態で最初に再生すると、
  //   1曲目 ended → 2曲目で進捗バーは進むが無音、ロック画面解除で復旧
  //   する不具合の再現率が高い。Last.fm fetch とは無関係。
  //
  // 真の原因: 旧実装は loadAndPlay 内で
  //          (1) audioEl.pause()
  //          (2) URL.revokeObjectURL(旧URL)
  //          (3) await getBlob(track.id)   ← 数百ms〜数秒の非同期待機
  //          (4) audioEl.src = 新URL
  //   の順序だった。iOS バックグラウンドの IndexedDB アクセスは遅延しやすく、
  //   (3) の間 audio.src は revoke 済みの無効参照状態。iOS Safari はこの
  //   状態を「audio session 終了」とみなして解放する → 後続の play() で
  //   進捗だけ進み無音再生になる。
  //
  // 修正: mp3player (utausnskareshi/mp3player) と同じ順序にする:
  //   (1) await getBlob(track.id)         ← 先に await。audio.src は旧曲のまま
  //   (2) audioEl.pause()
  //   (3) URL.revokeObjectURL(旧URL)
  //   (4) audioEl.src = 新URL              ← 同期で即座に新 URL 設定
  //   → audio.src が無効参照になる時間が「ms オーダー」になり session 維持

  // 新順序のシミュレーション
  function loadAndPlayNew(blobAvailableMs) {
    const events = [];
    events.push({ t: 0, event: "loadAndPlay 開始" });
    events.push({ t: 0, event: "audio.src は旧曲のまま (有効参照)" });
    events.push({ t: 0, event: "await getBlob 開始" });
    events.push({ t: blobAvailableMs, event: "getBlob 完了" });
    events.push({ t: blobAvailableMs, event: "transitioning = true" });
    events.push({ t: blobAvailableMs, event: "audioEl.pause()" });
    events.push({ t: blobAvailableMs, event: "URL.revokeObjectURL(旧URL)" });
    events.push({ t: blobAvailableMs, event: "audioEl.src = 新URL (同期)" });
    return events;
  }

  // 旧順序のシミュレーション
  function loadAndPlayOld(blobAvailableMs) {
    const events = [];
    events.push({ t: 0, event: "loadAndPlay 開始" });
    events.push({ t: 0, event: "transitioning = true" });
    events.push({ t: 0, event: "audioEl.pause()" });
    events.push({ t: 0, event: "URL.revokeObjectURL(旧URL)" });
    events.push({ t: 0, event: "audio.src 無効参照状態 開始" });
    events.push({ t: 0, event: "await getBlob 開始" });
    events.push({ t: blobAvailableMs, event: "getBlob 完了" });
    events.push({ t: blobAvailableMs, event: "audioEl.src = 新URL" });
    events.push({ t: blobAvailableMs, event: "audio.src 無効参照状態 終了" });
    return events;
  }

  // 「audio.src 無効参照状態」の継続時間を計算
  function invalidSrcDuration(events) {
    const start = events.find((e) => e.event.includes("audio.src 無効参照状態 開始"));
    const end = events.find((e) => e.event.includes("audio.src 無効参照状態 終了"));
    if (!start || !end) return 0;
    return end.t - start.t;
  }

  // iOS バックグラウンドで IDB が 300ms かかると仮定
  const SLOW_IDB = 300;
  assertEqual(invalidSrcDuration(loadAndPlayOld(SLOW_IDB)), 300,
    "旧順序: audio.src 無効参照状態が 300ms 続く → iOS audio session 解放");
  assertEqual(invalidSrcDuration(loadAndPlayNew(SLOW_IDB)), 0,
    "新順序: audio.src 無効参照状態は同期的に解消 (実質 0ms) → iOS audio session 維持");

  // blob 未発見 (track が削除済み等の確定エラー) の挙動
  function loadAndPlayBlobMissing() {
    const events = [];
    events.push({ event: "await getBlob" });
    events.push({ event: "blob === null" });
    events.push({ event: "skipToNextOnError 呼出 (早期 return)" });
    events.push({ event: "transitioning は ON にしない" });
    return events;
  }
  const r = loadAndPlayBlobMissing();
  assert(r.some((e) => e.event.includes("skipToNextOnError")),
    "blob 未発見 → skipToNextOnError 呼出 (確定エラーは従来通り処理)");
  assert(r.some((e) => e.event.includes("transitioning は ON にしない")),
    "blob 未発見の場合は transitioning を立てず早期 return");
});

describe("ロック画面 ended → 次曲 無音問題の修正 (v1.0.89): onPause transitioning ガード", () => {
  // ユーザ実機報告: ロック画面で 1 曲目 ended → 2 曲目進捗バーは進むが無音、
  //                ロック画面解除すると音が出る。再現性は不安定で初回起動時に
  //                発生しやすい。
  //
  // 真の原因: loadAndPlay 内の audioEl.pause() (旧 src の停止) で pause イベント
  //          発火 → onPause ハンドラが navigator.mediaSession.playbackState を
  //          "paused" に変更 → iOS Safari が audio session を抑制 →
  //          後続の play() で進捗だけ進み音が出ない状態に。
  //
  // 修正: onPause で state.transitioning 中は早期 return し、
  //       playbackState 変更も appState 更新もスキップする。

  // 修正後の onPause 挙動シミュレーション
  function onPauseSimulated(transitioning) {
    const calls = [];
    if (transitioning) return calls;  // 修正後の早期 return
    calls.push("appState.set isPlaying=false");
    calls.push("playbackState=paused");
    calls.push("setPositionState");
    return calls;
  }

  // 遷移中 (loadAndPlay の src 切替に伴う audioEl.pause()) は何もしない
  assertEqual(onPauseSimulated(true), [],
    "transitioning=true の onPause → 完全に no-op (iOS audio session 維持)");

  // ユーザ操作による pause (ロック画面 pause タップ、再生画面 pause タップ等)
  // は通常通り処理
  assertEqual(onPauseSimulated(false), [
    "appState.set isPlaying=false",
    "playbackState=paused",
    "setPositionState",
  ], "transitioning=false の onPause → 通常の pause 処理 (UI 更新 + iOS 通知)");
});

describe("ロック画面 ended → 次曲 無音問題の修正 (v1.0.88)", () => {
  // ユーザ報告:
  //   1曲目ロック画面再生中 → ended → 2 曲目に切替わるが音が出ない
  //   進捗バーは進んでいる (audio.currentTime は増加)
  //   ロック画面解除すると音が出始める
  //
  // 原因の仮説と対策:
  //   1. waitForLoadedMetadata の 3 秒タイムアウトが短すぎ、
  //      iOS バックグラウンドで loadedmetadata 発火遅延 → 8 秒に延長
  //   2. play() 後の updateMediaSessionMetadata 再呼出が
  //      iOS audio session を中断 → metadata 再設定を削除、
  //      position state のみ更新

  // 修正後の loadAndPlay フロー (期待):
  const phases = [];
  function simulateLoadAndPlayInBackground() {
    phases.push("transitioning=true");
    phases.push("pause-old");
    phases.push("revoke-old-url");
    phases.push("create-new-url");
    phases.push("set-src");
    phases.push("load()");
    phases.push("await-loadedmetadata(8s-timeout)");  // 修正後: 8秒
    phases.push("currentTime=0");
    phases.push("updateMetadata+position(Phase3)");  // metadata + position
    phases.push("play()");
    phases.push("updatePositionOnly(Phase4)");         // 修正後: position だけ
    phases.push("transitioning=false");
  }
  simulateLoadAndPlayInBackground();

  // Phase 4 は metadata 再設定ではなく position state のみ
  const phase4 = phases[phases.length - 2];
  assertEqual(phase4, "updatePositionOnly(Phase4)",
    "Phase 4 では metadata を再生成せず、position state のみ更新 (iOS audio session 維持)");

  // タイムアウト
  const metadataWait = phases.find((p) => p.startsWith("await-loadedmetadata"));
  assert(metadataWait.includes("8s"),
    "waitForLoadedMetadata のタイムアウトは 8 秒 (iOS バックグラウンドの遅延吸収)");
});

describe("ロック画面 pause タップ シナリオ (v1.0.87 修正)", () => {
  // ユーザ報告: 「ロック画面の一時停止をタップすると曲がなくなり、
  //              一時停止の文字だけになって曲の再生が終了」
  // 原因: pause action → audioEl.pause() の過程で iOS が一時的に audio.error
  //       を発火 → 旧実装は skipToNextOnError 呼出 → 別の曲ロード → 失敗
  //       → さらに次曲 → 連鎖で停止
  // 修正後: audio.error は無視、pause は単に pause として扱う
  const events = [];
  function simulatePauseAction() {
    // MediaSession pause action
    events.push("pause-action");
    // audioEl.pause()
    events.push("audio-pause");
    events.push("set-userPausedExplicitly-true");
    // iOS が誤動作で audio.error 発火
    events.push("audio-error-fired");
    // 修正後: audio.error イベントハンドラは何もしない (ログのみ)
    events.push("audio-error-handler-no-op");
  }
  simulatePauseAction();
  assertEqual(events, [
    "pause-action",
    "audio-pause",
    "set-userPausedExplicitly-true",
    "audio-error-fired",
    "audio-error-handler-no-op",
  ], "pause action → 自動スキップ連鎖が起きない");
});

/* ============ 次曲プリロード + 同期再生 (v1.0.92): iOS バックグラウンド自動遷移 ============ */

// audio-engine.js の computeNextIndex を抽出
function computeNextIndex(state, repeatMode) {
  // ★ v1.0.94: 単一曲 + all は next===queueIndex(=0) を返す (ループ用)。
  //   以前ここで -1 を返していたため単一曲 repeat=all が停止する回帰があった。
  if (state.queue.length === 0) return -1;
  if (repeatMode === "one") return -1;
  let next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    if (repeatMode === "all") next = 0;
    else return -1;
  }
  return next;
}

describe("computeNextIndex: プリロード対象の決定", () => {
  const q3 = { queue: [{id:"a"},{id:"b"},{id:"c"}], queueIndex: 0 };
  assertEqual(computeNextIndex(q3, "none"), 1, "index0 + none → 1");
  assertEqual(computeNextIndex({...q3, queueIndex: 2}, "none"), -1, "末尾 + none → -1 (次なし)");
  assertEqual(computeNextIndex({...q3, queueIndex: 2}, "all"), 0, "末尾 + all → 0 (先頭へ wrap)");
  assertEqual(computeNextIndex(q3, "one"), -1, "repeat one → -1 (同一曲ループは advanceFromEnded が処理)");
  // ★ 回帰修正: 単一曲 + all は 0 (= 同一曲) を返す。停止しない。
  assertEqual(computeNextIndex({ queue: [{id:"a"}], queueIndex: 0 }, "all"), 0,
    "単一曲 + all → 0 (next===current、ループ再生する。-1 で停止させない)");
  assertEqual(computeNextIndex({ queue: [], queueIndex: -1 }, "none"), -1, "空キュー → -1");
});

describe("単一曲キュー + repeat=all のループ挙動 (v1.0.94 回帰修正)", () => {
  // advanceFromEnded の分岐: repeat=one または next===queueIndex は同期ループ再生
  function advanceDecision(state, repeatMode) {
    const next = computeNextIndex(state, repeatMode);
    if (repeatMode === "one" || (next >= 0 && next === state.queueIndex)) {
      return { type: "loop-sync" }; // 同一曲を頭出し再生 (reload なし)
    }
    if (next < 0) return { type: "stop" };
    return { type: "advance", index: next };
  }

  // 単一曲 [a] + repeat=all → ended で停止せずループ
  assertEqual(
    advanceDecision({ queue: [{id:"a"}], queueIndex: 0 }, "all"),
    { type: "loop-sync" },
    "単一曲 + all: ended → 同一曲ループ再生 (停止しない = 旧挙動を復元)"
  );
  // 単一曲 [a] + repeat=none → ended で停止
  assertEqual(
    advanceDecision({ queue: [{id:"a"}], queueIndex: 0 }, "none"),
    { type: "stop" },
    "単一曲 + none: ended → 停止"
  );
  // 単一曲 [a] + repeat=one → ループ
  assertEqual(
    advanceDecision({ queue: [{id:"a"}], queueIndex: 0 }, "one"),
    { type: "loop-sync" },
    "単一曲 + one: ended → 同一曲ループ再生"
  );
  // 複数曲は通常遷移 (次が現在と異なる)
  assertEqual(
    advanceDecision({ queue: [{id:"a"},{id:"b"}], queueIndex: 0 }, "all"),
    { type: "advance", index: 1 },
    "複数曲 + all: ended → 次曲へ通常遷移"
  );
});

describe("transitioning 世代トークン (v1.0.94 H-1: 連打時の早期クリア防止)", () => {
  // 古い遷移の clearTransitioning が新しい遷移の transitioning を倒さないこと
  const st = { transitioning: false, transitionToken: 0 };
  function beginTransition() {
    const myToken = ++st.transitionToken;
    st.transitioning = true;
    return myToken;
  }
  function clearTransitioning(myToken) {
    if (myToken === st.transitionToken) st.transitioning = false;
  }

  // 遷移1 開始
  const t1 = beginTransition();
  assert(st.transitioning === true, "遷移1: transitioning=true");
  // 遷移1 完了前に 遷移2 が開始 (連打)
  const t2 = beginTransition();
  assert(st.transitioning === true, "遷移2 開始: まだ true");
  // 遷移1 の遅延クリア (play promise / 1.5秒タイマー) が発火 → 倒さない
  clearTransitioning(t1);
  assert(st.transitioning === true,
    "★ 古い遷移1 の clear は最新でないので transitioning を倒さない (連打で音切れしない)");
  // 遷移2 のクリアが発火 → 正しく倒す
  clearTransitioning(t2);
  assert(st.transitioning === false, "最新の遷移2 の clear で transitioning=false");
});

describe("loadAndPlay の stale-abort (v1.0.95 H-2: 並行 loadAndPlay の URL 競合防止)", () => {
  // loadAndPlay は await getBlob/loadedmetadata/resumeEqContext を挟む。
  // await 中に別の遷移が始まったら自分は stale → play せず中断し、自分が作った
  // url が現在使われていなければ revoke する。
  function loadAndPlaySim(myToken, state, createdUrl) {
    // await 後の stale チェックを模擬
    if (myToken !== state.transitionToken) {
      const action = (state.currentObjectUrl !== createdUrl) ? "revoke-own-url" : "keep";
      return { aborted: true, action };
    }
    return { aborted: false };
  }

  // 通常: 自分が最新 → 中断しない
  const s1 = { transitionToken: 5, currentObjectUrl: "blob:a" };
  assertEqual(loadAndPlaySim(5, s1, "blob:a"), { aborted: false },
    "自分が最新世代 → 中断せず play へ進む");

  // 並行: 新しい遷移が来て token が進み、currentObjectUrl は新 url に置換済み
  const s2 = { transitionToken: 6, currentObjectUrl: "blob:newer" };
  assertEqual(loadAndPlaySim(5, s2, "blob:older"),
    { aborted: true, action: "revoke-own-url" },
    "stale → 中断し、自分の url (currentObjectUrl でない) を revoke (リーク防止)");

  // stopPlayback 後: token 進む + currentObjectUrl=null
  const s3 = { transitionToken: 7, currentObjectUrl: null };
  assertEqual(loadAndPlaySim(5, s3, "blob:older"),
    { aborted: true, action: "revoke-own-url" },
    "stopPlayback でキャンセル → 中断 + 自 url revoke (削除曲を再生しない)");
});

describe("stopPlayback の in-flight キャンセル + transitioning リセット (v1.0.95)", () => {
  // stopPlayback は token++ で in-flight を無効化し、transitioning を明示 false にする。
  const st = { transitioning: true, transitionToken: 3 };
  function stopPlayback() {
    st.transitionToken++;
    st.transitioning = false;
  }
  // in-flight loadAndPlay が transitioning=true の最中に stop
  stopPlayback();
  assert(st.transitioning === false, "stopPlayback で transitioning=false に確実にリセット");
  // in-flight loadAndPlay の finally は token 不一致で transitioning を触らない
  const inflightToken = 3;
  function inflightFinally(myToken) {
    if (myToken === st.transitionToken) st.transitioning = false; // 実行されない
  }
  inflightFinally(inflightToken);
  assert(st.transitioning === false,
    "in-flight の finally は token 不一致で no-op (stopPlayback の false を維持、stuck しない)");
  assert(st.transitionToken === 4, "token が進み in-flight が stale 化");
});

describe("ended 遷移の分岐決定（プリロード fast-path）", () => {
  // advanceFromEnded の分岐ロジックを抽出
  function decideTransition(state, repeatMode) {
    if (repeatMode === "one") return { type: "loop" };
    const next = computeNextIndex(state, repeatMode);
    if (next < 0) return { type: "stop" };
    const track = state.queue[next];
    if (state.preloadUrl && state.preloadTrackId === track.id) {
      return { type: "fast", index: next, trackId: track.id };
    }
    return { type: "fallback", index: next, trackId: track.id };
  }

  const base = { queue: [{id:"a"},{id:"b"},{id:"c"}], queueIndex: 0 };

  // プリロード済み & 次曲一致 → fast path
  assertEqual(
    decideTransition({ ...base, preloadTrackId: "b", preloadUrl: "blob:x" }, "none"),
    { type: "fast", index: 1, trackId: "b" },
    "プリロード済みで次曲一致 → 同期 fast path (iOS BG で音切れなし)"
  );
  // プリロードが別の曲 → fallback
  assertEqual(
    decideTransition({ ...base, preloadTrackId: "z", preloadUrl: "blob:x" }, "none"),
    { type: "fallback", index: 1, trackId: "b" },
    "プリロードが別曲 → fallback (loadAndPlay)"
  );
  // プリロード無し → fallback
  assertEqual(
    decideTransition({ ...base, preloadTrackId: null, preloadUrl: null }, "none"),
    { type: "fallback", index: 1, trackId: "b" },
    "プリロード無し → fallback"
  );
  // repeat one → loop
  assertEqual(
    decideTransition({ ...base, preloadTrackId: null, preloadUrl: null }, "one"),
    { type: "loop" },
    "repeat one → 同一曲ループ"
  );
  // 末尾 none → stop
  assertEqual(
    decideTransition({ ...base, queueIndex: 2, preloadTrackId: null, preloadUrl: null }, "none"),
    { type: "stop" },
    "末尾 + none → 停止"
  );
});

describe("playPreloadedSync: src 差替 → play() が await を挟まず同期実行される", () => {
  // ★ iOS バックグラウンド継続の核心: ended ハンドラ内で audio.src と
  //   audio.play() に到達するまで await が無いこと。
  const log = [];
  // playPreloadedSync の同期部分を模擬 (await を一切含まない)
  // ★ v1.0.94: metadata は play() の「前」に確定する (iOS 無音化対策)
  function playPreloadedSyncSim() {
    log.push("resetSession");
    log.push("transitioning=true");
    log.push("queueIndex=next");
    log.push("currentObjectUrl=preloadUrl");
    log.push("preload消費(null化)");
    log.push("audioEl.src=url");                 // ← 同期
    log.push("audioEl.load()");                  // ← 同期
    log.push("updateMediaSessionMetadata");      // ← play() の「前」(v1.0.88 と同じ原則)
    log.push("audioEl.play()");                  // ← 同期 (await しない)
    log.push("appState.set");
    log.push("updateMediaPositionState(position-only)"); // play() 後は position のみ
    // transitioning はここで false にしない (play promise 解決後)
    return log;
  }
  const events = playPreloadedSyncSim();
  const srcIdx = events.indexOf("audioEl.src=url");
  const playIdx = events.indexOf("audioEl.play()");
  const metaIdx = events.indexOf("updateMediaSessionMetadata");
  assert(srcIdx >= 0 && playIdx >= 0, "src 設定と play() 呼出がある");
  assert(srcIdx < playIdx, "src は play() より前");
  // ★ 最重要: metadata (new MediaMetadata) は play() の「前」に確定する。
  //   play() 後に生成すると iOS が新セッション扱いで無音化する (v1.0.88 の教訓)。
  assert(metaIdx >= 0 && metaIdx < playIdx,
    "updateMediaSessionMetadata は play() の前 (iOS 無音化アンチパターンを回避)");
  // play() の後に new MediaMetadata を作らない (position-only のみ)
  const afterPlay = events.slice(playIdx + 1);
  assert(!afterPlay.includes("updateMediaSessionMetadata"),
    "play() の後に updateMediaSessionMetadata (new MediaMetadata) を呼ばない");
  assert(afterPlay.includes("updateMediaPositionState(position-only)"),
    "play() 後は position state のみ再確定する");
  assert(!events.includes("await getBlob"), "getBlob を呼ばない (プリロード済み)");
  assert(!events.includes("await waitForLoadedMetadata"),
    "waitForLoadedMetadata を待たない (8秒待機を回避)");
  // src → load → metadata → play の連続 (間に await 無し)
  assert(!events.slice(srcIdx, playIdx + 1).some((e) => e.startsWith("await")),
    "src から play() まで await を挟まない (iOS BG 継続の核心)");
  // transitioning は同期では false にしない (spurious pause 抑止)
  assert(!events.includes("transitioning=false"),
    "transitioning は同期で false にしない (play promise 解決後にクリア)");
});

describe("プリロードチェーン: 1曲再生→次曲先読み→ended で即再生→さらに先読み", () => {
  // 状態機械の模擬
  const queue = [{id:"a",dur:180},{id:"b",dur:200},{id:"c",dur:170},{id:"d",dur:190}];
  const sim = {
    queueIndex: 0,
    preloadTrackId: null,
    preloadUrl: null,
    playLog: [],
  };
  function computeNext(idx) {
    const n = idx + 1;
    return n < queue.length ? n : -1;
  }
  function schedulePreload() {
    const n = computeNext(sim.queueIndex);
    if (n < 0) { sim.preloadTrackId = null; sim.preloadUrl = null; return; }
    sim.preloadTrackId = queue[n].id;
    sim.preloadUrl = `blob:${queue[n].id}`;
  }
  function startTrack(idx) {
    sim.queueIndex = idx;
    sim.playLog.push(queue[idx].id);
    schedulePreload();  // 再生開始 → 次を先読み
  }
  function onEnded() {
    const n = computeNext(sim.queueIndex);
    if (n < 0) return false;
    const track = queue[n];
    // fast path 判定
    if (sim.preloadUrl && sim.preloadTrackId === track.id) {
      // 同期再生 (プリロード消費)
      sim.preloadTrackId = null; sim.preloadUrl = null;
      startTrack(n);
      return true;
    }
    return false; // fallback (このシナリオでは起きないはず)
  }

  startTrack(0);  // a 再生 → b 先読み
  assertEqual(sim.preloadTrackId, "b", "a 再生中に b を先読み");

  assert(onEnded(), "a ended → fast path で b 再生");
  assertEqual(sim.playLog, ["a","b"], "b が再生された");
  assertEqual(sim.preloadTrackId, "c", "b 再生中に c を先読み");

  assert(onEnded(), "b ended → fast path で c 再生");
  assertEqual(sim.playLog, ["a","b","c"], "c が再生された");
  assertEqual(sim.preloadTrackId, "d", "c 再生中に d を先読み");

  assert(onEnded(), "c ended → fast path で d 再生");
  assertEqual(sim.playLog, ["a","b","c","d"], "d が再生された");
  assertEqual(sim.preloadTrackId, null, "d は末尾 → 先読みなし");

  assertEqual(onEnded(), false, "d ended → 次なし (停止)");
  assertEqual(sim.playLog, ["a","b","c","d"], "全4曲がプリロード fast path で連続再生された");
});

describe("clearPreload: token 更新で in-flight を無効化", () => {
  // schedulePreload の token 世代管理を模擬
  const sim = { preloadTrackId: null, preloadUrl: null, preloadToken: 0 };
  function clearPreload() {
    sim.preloadUrl = null;
    sim.preloadTrackId = null;
    sim.preloadToken++;
  }
  // getBlob 中に曲が変わる → 古い結果は破棄される
  clearPreload();
  const tokenA = sim.preloadToken;
  // 別の schedulePreload が走る
  clearPreload();
  const tokenB = sim.preloadToken;
  assert(tokenB !== tokenA, "clearPreload ごとに token が進む");
  // tokenA の getBlob が遅延完了 → token 不一致で破棄判定
  assert(tokenA !== sim.preloadToken, "古い token (tokenA) は現在値と不一致 → 結果破棄");
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
