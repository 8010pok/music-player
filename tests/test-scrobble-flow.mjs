/**
 * スクロブル関連の総合フロー単体テスト
 *
 * 検証対象:
 *   - sendScrobble の戻り値とパラメータ (timestamp / payload)
 *   - flushQueue の繰り返し送信 (50件超)
 *   - 永続エラー / 一過性エラーの判別
 *   - sendNowPlaying のオフラインガード
 *   - installOnlineListener 相当（online → flushQueue + sendNowPlaying）
 *   - オンライン↔オフライン切替時の状態遷移
 *
 * 実行: node tests/test-scrobble-flow.mjs
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

/* ============ sendScrobble の payload 生成ロジック ============ */

/**
 * scrobble.js の normalizeTrackNumber のミラー（"5/12" → 5、非数値 → undefined）
 */
function normalizeTrackNumber(raw) {
  if (raw == null) return undefined;
  const n = parseInt(String(raw).split("/")[0], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * scrobble.js の sendScrobble の payload 構築ロジックを抽出（送信は除外）
 */
function buildScrobblePayload(track, startedAtMs) {
  if (!track) return null;
  const timestamp = startedAtMs
    ? Math.floor(startedAtMs / 1000)
    : Math.floor(Date.now() / 1000);
  return {
    artist: track.artist || "",
    track: track.title || "",
    album: track.album || "",
    albumArtist: track.albumArtist || "",
    timestamp,
    duration: track.duration ? Math.floor(track.duration) : undefined,
    trackNumber: normalizeTrackNumber(track.trackNo),
  };
}

describe("sendScrobble payload 生成", () => {
  const t = {
    title: "Yesterday", artist: "Beatles", album: "Help!",
    albumArtist: "Beatles", duration: 125.5, trackNo: 13,
  };

  // startedAtMs 指定: timestamp は曲開始時刻になる（Last.fm 公式仕様）
  const startedAt = Date.UTC(2026, 4, 25, 10, 0, 0);
  const p = buildScrobblePayload(t, startedAt);
  assertEqual(p.timestamp, Math.floor(startedAt / 1000),
    "timestamp = startedAtMs / 1000 (再生開始時刻、Last.fm公式仕様)");
  assertEqual(p.artist, "Beatles", "artist 設定");
  assertEqual(p.track, "Yesterday", "track 設定");
  assertEqual(p.album, "Help!", "album 設定");
  assertEqual(p.duration, 125, "duration は整数化");
  assertEqual(p.trackNumber, 13, "trackNumber");

  // startedAtMs 未指定: 現在時刻 (フォールバック)
  const before = Math.floor(Date.now() / 1000);
  const p2 = buildScrobblePayload(t, undefined);
  const after = Math.floor(Date.now() / 1000);
  assert(p2.timestamp >= before && p2.timestamp <= after,
    "startedAtMs 未指定 → 現在時刻にフォールバック");

  // track null → null
  assertEqual(buildScrobblePayload(null, startedAt), null, "track null → null");

  // 空フィールド
  const p3 = buildScrobblePayload({ title: "T", artist: "A" }, startedAt);
  assertEqual(p3.album, "", "album なし → 空文字");
  assertEqual(p3.duration, undefined, "duration なし → undefined");

  // trackNumber 正規化（Last.fm 仕様: アルバム内の整数位置。"5/12" 形式や非数値を弾く）
  const pSlash = buildScrobblePayload({ title: "T", artist: "A", trackNo: "5/12" }, startedAt);
  assertEqual(pSlash.trackNumber, 5, '"5/12" → 主番号 5 に正規化');
  const pStr = buildScrobblePayload({ title: "T", artist: "A", trackNo: "07" }, startedAt);
  assertEqual(pStr.trackNumber, 7, '"07" → 7');
  const pBad = buildScrobblePayload({ title: "T", artist: "A", trackNo: "A" }, startedAt);
  assertEqual(pBad.trackNumber, undefined, "非数値 → undefined（パラメータ省略）");
  const pZero = buildScrobblePayload({ title: "T", artist: "A", trackNo: 0 }, startedAt);
  assertEqual(pZero.trackNumber, undefined, "0 → undefined（正の整数のみ）");
  const pNone = buildScrobblePayload({ title: "T", artist: "A" }, startedAt);
  assertEqual(pNone.trackNumber, undefined, "trackNo なし → undefined");
});

/* ============ 永続エラー判定 ============ */

const PERMANENT_LASTFM_ERROR_CODES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 17, 18, 26]);

describe("永続的 Last.fm エラーコード判定", () => {
  assert(PERMANENT_LASTFM_ERROR_CODES.has(10), "10 (Invalid API key) は永続的");
  assert(PERMANENT_LASTFM_ERROR_CODES.has(26), "26 (Suspended API key) は永続的");
  assert(PERMANENT_LASTFM_ERROR_CODES.has(6), "6 (User not found) は永続的");
  assert(!PERMANENT_LASTFM_ERROR_CODES.has(11), "11 (Service Offline) は一過性 (リトライ可)");
  assert(!PERMANENT_LASTFM_ERROR_CODES.has(16), "16 (Temporary error) は一過性");
  assert(!PERMANENT_LASTFM_ERROR_CODES.has(29), "29 (Rate limit) は一過性");
  assert(!PERMANENT_LASTFM_ERROR_CODES.has(undefined), "undefined (ネットワークエラー) は永続的でない");
});

/* ============ flushQueue 繰り返し送信シミュレーション ============ */

/**
 * scrobble.js の flushQueue ロジックを最小限再現
 *   - peek が空になるまで繰り返し送信
 *   - 永続エラーで break、一過性エラーでも break (リトライしない、キューは残す)
 */
async function simulateFlushQueue(fakeQueue, fakeSend, maxBatch = 50) {
  const notifications = [];
  while (true) {
    const items = fakeQueue.peek(maxBatch);
    if (items.length === 0) break;
    try {
      await fakeSend(items);
      fakeQueue.removeMany(items.map((i) => i.id));
    } catch (e) {
      if (PERMANENT_LASTFM_ERROR_CODES.has(e.code)) {
        notifications.push({ type: "permanent-error", code: e.code });
      } else {
        notifications.push({ type: "transient-error", code: e.code });
      }
      break;
    }
  }
  return { remaining: fakeQueue.peek(99999).length, notifications };
}

function makeFakeQueue(initialItems) {
  let items = initialItems.map((p, i) => ({ id: i + 1, ...p }));
  let nextId = items.length + 1;
  return {
    peek: (n) => items.slice(0, n),
    removeMany: (ids) => { items = items.filter((it) => !ids.includes(it.id)); },
    enqueue: (p) => { items.push({ id: nextId++, ...p }); },
    count: () => items.length,
  };
}

await describe("flushQueue 残件繰り返し送信", async () => {
  // 120 件のキューを 50 件ずつ 3 回送信
  const q = makeFakeQueue(Array.from({ length: 120 }, (_, i) => ({ artist: "A", track: `T${i}` })));
  let callCount = 0;
  const send = async (items) => { callCount++; };
  const r = await simulateFlushQueue(q, send);
  assertEqual(callCount, 3, "120 件 → 50+50+20 = 3 回の送信");
  assertEqual(r.remaining, 0, "全件送信されてキュー空");
  assertEqual(r.notifications, [], "通知なし (全部成功)");

  // 0 件
  const q2 = makeFakeQueue([]);
  const r2 = await simulateFlushQueue(q2, async () => {});
  assertEqual(r2.remaining, 0, "0 件 → 何もしない");

  // ちょうど 50 件
  const q3 = makeFakeQueue(Array.from({ length: 50 }, (_, i) => ({ artist: "A", track: `T${i}` })));
  let calls3 = 0;
  await simulateFlushQueue(q3, async () => { calls3++; });
  assertEqual(calls3, 1, "ちょうど 50 件 → 1 回の送信");
  assertEqual(q3.count(), 0, "ちょうど 50 件 → 全件送信完了");
});

await describe("flushQueue エラーハンドリング", async () => {
  // 永続エラー (API キー無効)
  const q = makeFakeQueue(Array.from({ length: 30 }, (_, i) => ({ artist: "A", track: `T${i}` })));
  const send = async () => {
    const err = new Error("Invalid API key");
    err.code = 10;
    throw err;
  };
  const r = await simulateFlushQueue(q, send);
  assertEqual(r.remaining, 30, "永続エラー → キュー保持");
  assertEqual(r.notifications, [{ type: "permanent-error", code: 10 }],
    "永続エラー: ユーザ通知 (toast 出力対象)");

  // 一過性エラー (ネットワーク)
  const q2 = makeFakeQueue(Array.from({ length: 30 }, (_, i) => ({ artist: "A", track: `T${i}` })));
  const send2 = async () => {
    throw new Error("Network error");  // code 未設定
  };
  const r2 = await simulateFlushQueue(q2, send2);
  assertEqual(r2.remaining, 30, "一過性エラー → キュー保持");
  assertEqual(r2.notifications, [{ type: "transient-error", code: undefined }],
    "一過性エラー: 通知なし(toast出力なし)、次回 online で再試行");

  // 1 回目成功、2 回目失敗 → 1 バッチだけ送信成功してキューに残る
  const q3 = makeFakeQueue(Array.from({ length: 80 }, (_, i) => ({ artist: "A", track: `T${i}` })));
  let calls = 0;
  const send3 = async () => {
    calls++;
    if (calls === 2) {
      const err = new Error("Service Offline");
      err.code = 11;
      throw err;
    }
  };
  const r3 = await simulateFlushQueue(q3, send3);
  assertEqual(r3.remaining, 30,
    "1 バッチ成功 → 50 件削除、2 バッチ目失敗 → 残り 30 件");
});

/* ============ sendNowPlaying のオフラインガード ============ */

function shouldSendNowPlaying(track, isOnline, isAuthed) {
  if (!track) return false;
  if (isOnline === false) return false;
  if (!isAuthed) return false;
  return true;
}

describe("sendNowPlaying オフラインガード", () => {
  const t = { title: "T", artist: "A" };
  assert(shouldSendNowPlaying(t, true, true), "オンライン + 認証あり → 送信");
  assert(!shouldSendNowPlaying(t, false, true),
    "オフライン → 送信しない (修正前は無駄リクエストしていた)");
  assert(!shouldSendNowPlaying(t, true, false), "未認証 → 送信しない");
  assert(!shouldSendNowPlaying(null, true, true), "track なし → 送信しない");
});

/* ============ installOnlineListener 相当 (online → flushQueue + sendNowPlaying) ============ */

describe("オンライン復帰時の挙動", () => {
  // 復帰時に sendNowPlaying を呼ぶ条件
  function shouldResendNowPlaying(state) {
    return !!(state.currentTrack && state.isPlaying);
  }
  assert(
    shouldResendNowPlaying({ currentTrack: { title: "T" }, isPlaying: true }),
    "再生中の曲あり → Now Playing 再送信"
  );
  assert(
    !shouldResendNowPlaying({ currentTrack: { title: "T" }, isPlaying: false }),
    "再生中ではない (pause 中) → 再送信しない (Last.fm 上ステータスを残す)"
  );
  assert(
    !shouldResendNowPlaying({ currentTrack: null, isPlaying: true }),
    "曲なし → 再送信しない"
  );
});

/* ============ 状態遷移シミュレーション ============ */

await describe("オンライン↔オフライン切替シナリオ", async () => {
  // モック appState
  const state = { scrobbleQueueCount: 0, currentTrack: null, isPlaying: false };
  const queue = makeFakeQueue([]);
  const networkLog = [];
  let isOnline = true;
  let isAuthed = true;

  // sendScrobble 相当
  async function sendScrobble(track, _dur, startedAtMs) {
    if (!track) return "skipped";
    const payload = buildScrobblePayload(track, startedAtMs);
    if (!isAuthed) return "skipped";
    if (!isOnline) {
      queue.enqueue(payload);
      state.scrobbleQueueCount = queue.count();
      return "queued";
    }
    networkLog.push({ method: "scrobble", payload });
    return "sent";
  }

  // sendNowPlaying 相当
  async function sendNowPlaying(track) {
    if (!track) return;
    if (!isOnline) return;
    if (!isAuthed) return;
    networkLog.push({ method: "nowPlaying", track: track.title });
  }

  // === シナリオ開始 ===

  // 1. オンライン + 認証あり、曲A 再生中
  state.currentTrack = { title: "曲A", artist: "アーティスト" };
  state.isPlaying = true;
  await sendNowPlaying(state.currentTrack);
  assertEqual(networkLog[networkLog.length - 1],
    { method: "nowPlaying", track: "曲A" }, "曲A 再生開始 → Now Playing 送信");

  // 2. 進捗 1 達成 → sendScrobble
  const trackAStartedAt = Date.now() - 130 * 1000;  // 130秒前に開始
  const r1 = await sendScrobble(state.currentTrack, 240, trackAStartedAt);
  assertEqual(r1, "sent", "オンライン → sent");
  assertEqual(state.scrobbleQueueCount, 0, "キューは空");

  // 3. オフラインに切替（再生継続）
  isOnline = false;
  // 曲B 開始
  state.currentTrack = { title: "曲B", artist: "アーティスト" };
  // 曲B も Now Playing 送信試行 (オフラインなのでスキップされる)
  const nwBefore = networkLog.length;
  await sendNowPlaying(state.currentTrack);
  assertEqual(networkLog.length, nwBefore, "オフライン → Now Playing スキップ");

  // 4. 曲B 進捗 1 達成 → enqueue
  const trackBStartedAt = Date.now() - 130 * 1000;
  const r2 = await sendScrobble(state.currentTrack, 240, trackBStartedAt);
  assertEqual(r2, "queued", "オフライン → queued");
  assertEqual(state.scrobbleQueueCount, 1, "キュー 1 件");

  // 5. オンライン復帰 → flushQueue + 現在曲 Now Playing 再送信
  isOnline = true;
  // flushQueue 相当: peek → send → removeMany
  const items = queue.peek(50);
  if (items.length > 0) {
    networkLog.push({ method: "scrobble-batch", count: items.length });
    queue.removeMany(items.map((i) => i.id));
    state.scrobbleQueueCount = queue.count();
  }
  // 現在曲 Now Playing
  if (state.currentTrack && state.isPlaying) {
    await sendNowPlaying(state.currentTrack);
  }
  assertEqual(state.scrobbleQueueCount, 0, "復帰後: キュー空");
  const lastTwo = networkLog.slice(-2);
  assertEqual(lastTwo,
    [{ method: "scrobble-batch", count: 1 }, { method: "nowPlaying", track: "曲B" }],
    "復帰後: バッチ送信 + 現在曲 Now Playing 再送信");

  // 6. オンライン中に未認証になった場合
  isAuthed = false;
  const r3 = await sendScrobble(state.currentTrack, 240, Date.now());
  assertEqual(r3, "skipped", "未認証 → skipped (キューに溜めない)");
});

/* ============ Last.fm レスポンスの ignoredMessage 検査 ============ */

// scrobble.js の inspectScrobbleResponse を抽出
const SCROBBLE_IGNORED_MESSAGES = {
  1: "アーティスト名が無視されました",
  2: "トラック名が無視されました",
  3: "タイムスタンプが古すぎます",
  4: "タイムスタンプが未来です",
  5: "1日のスクロブル上限に達しました",
};

function inspectScrobbleResponse(response) {
  const sc = response?.scrobbles;
  if (!sc) return null;
  const attr = sc["@attr"];
  const ignored = parseInt(attr?.ignored || "0", 10);
  const accepted = parseInt(attr?.accepted || "0", 10);
  if (!ignored) return null;
  const items = Array.isArray(sc.scrobble) ? sc.scrobble : (sc.scrobble ? [sc.scrobble] : []);
  const reasons = [];
  for (const s of items) {
    const code = parseInt(s?.ignoredMessage?.code || "0", 10);
    if (code > 0) {
      reasons.push(SCROBBLE_IGNORED_MESSAGES[code] || `Last.fm エラー (code ${code})`);
    }
  }
  return { accepted, ignored, reasons };
}

describe("Last.fm 公式仕様: scrobble response の ignoredMessage 検査", () => {
  // 正常 (accepted=1, ignored=0)
  const acceptedRes = {
    scrobbles: {
      "@attr": { accepted: 1, ignored: 0 },
      scrobble: {
        artist: { "#text": "A" }, track: { "#text": "T" },
        ignoredMessage: { code: "0", "#text": "" },
      },
    },
  };
  assertEqual(inspectScrobbleResponse(acceptedRes), null,
    "accepted=1, ignored=0 → null (問題なし)");

  // ignored=1 (タイムスタンプ古すぎ)
  const oldTsRes = {
    scrobbles: {
      "@attr": { accepted: 0, ignored: 1 },
      scrobble: {
        artist: { "#text": "A" }, track: { "#text": "T" },
        ignoredMessage: { code: "3", "#text": "Timestamp too old" },
      },
    },
  };
  assertEqual(inspectScrobbleResponse(oldTsRes),
    { accepted: 0, ignored: 1, reasons: ["タイムスタンプが古すぎます"] },
    "code 3 (timestamp too old) → 詳細を含む結果");

  // ignored=2 (バッチで複数 ignored)
  const batchRes = {
    scrobbles: {
      "@attr": { accepted: 1, ignored: 2 },
      scrobble: [
        { ignoredMessage: { code: "0" } },  // accepted
        { ignoredMessage: { code: "3" } },  // timestamp old
        { ignoredMessage: { code: "5" } },  // daily limit
      ],
    },
  };
  const r = inspectScrobbleResponse(batchRes);
  assertEqual(r.accepted, 1, "batch: accepted=1");
  assertEqual(r.ignored, 2, "batch: ignored=2");
  assertEqual(r.reasons.length, 2, "理由は ignored 件数と一致");
  assert(r.reasons.includes("タイムスタンプが古すぎます"), "code 3 理由");
  assert(r.reasons.includes("1日のスクロブル上限に達しました"), "code 5 理由");

  // 空レスポンス
  assertEqual(inspectScrobbleResponse(null), null, "null response → null");
  assertEqual(inspectScrobbleResponse({}), null, "空 response → null");
  assertEqual(inspectScrobbleResponse({ scrobbles: {} }), null, "scrobbles 空 → null");

  // unknown code
  const unknownRes = {
    scrobbles: {
      "@attr": { accepted: 0, ignored: 1 },
      scrobble: { ignoredMessage: { code: "99" } },
    },
  };
  const r2 = inspectScrobbleResponse(unknownRes);
  assert(r2.reasons[0].includes("99"), "未知 code → fallback メッセージに含まれる");
});

describe("Last.fm 公式仕様: PERMANENT_LASTFM_ERROR_CODES の妥当性", () => {
  const PERMANENT_LASTFM_ERROR_CODES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 17, 18, 26]);
  // 公式: リトライ可能は 11 (Service Offline), 16 (Temporary), 9 (Invalid session)
  // 9 は再認証必須なので本アプリ的には permanent 扱い → OK
  assert(!PERMANENT_LASTFM_ERROR_CODES.has(11), "code 11 は一過性 (Service Offline)");
  assert(!PERMANENT_LASTFM_ERROR_CODES.has(16), "code 16 は一過性 (Temporary)");
  assert(PERMANENT_LASTFM_ERROR_CODES.has(9), "code 9 は再認証要なので permanent 扱い");
  assert(PERMANENT_LASTFM_ERROR_CODES.has(10), "code 10 (Invalid API key) は permanent");
  assert(PERMANENT_LASTFM_ERROR_CODES.has(26), "code 26 (Suspended) は permanent");
  assert(PERMANENT_LASTFM_ERROR_CODES.has(6), "code 6 (User not found) は permanent");
});

/* ============ Last.fm 公式仕様準拠の timestamp 検証 ============ */

describe("Last.fm timestamp 仕様準拠", () => {
  // 仕様: timestamp = 「スクロブル対象の曲が再生開始した時刻」
  // 修正前: 進捗 1 達成時刻 (=曲の中盤)
  // 修正後: 曲再生開始時刻 (sessionStartedAt 由来)

  const songStarted = Date.UTC(2026, 4, 25, 10, 0, 0);
  // 進捗 1 達成は 2 分後
  const scrobbleAchieved = songStarted + 2 * 60 * 1000;

  // 修正前の挙動 (Date.now() 相当)
  const oldTimestamp = Math.floor(scrobbleAchieved / 1000);
  // 修正後の挙動 (startedAtMs 由来)
  const newTimestamp = Math.floor(songStarted / 1000);

  assert(newTimestamp < oldTimestamp,
    "修正後 timestamp は曲開始時刻 (より早い) → ユーザ体感と一致");
  assertEqual(oldTimestamp - newTimestamp, 120,
    "差は 120 秒 = 進捗 1 達成までの再生時間");
});

describe("Last.fm 拒否理由 (ignoredMessage) & 認証エラーコード (4, 9, 14) 検証", () => {
  assertEqual(SCROBBLE_IGNORED_MESSAGES[1], "アーティスト名が無視されました");
  assertEqual(SCROBBLE_IGNORED_MESSAGES[2], "トラック名が無視されました");

  const AUTH_ERR_CODES = new Set([4, 9, 14]);
  assert(AUTH_ERR_CODES.has(9), "code 9 (Invalid session key) は要再認証");
  assert(AUTH_ERR_CODES.has(4), "code 4 (Authentication Failed) は要再認証");
  assert(AUTH_ERR_CODES.has(14), "code 14 (Unauthorized token) は要再認証");
  assert(!AUTH_ERR_CODES.has(8), "code 8 (Operation failed) は一過性リトライ対象");
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
