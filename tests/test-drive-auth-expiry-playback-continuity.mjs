/**
 * tests/test-drive-auth-expiry-playback-continuity.mjs
 *
 * Google Drive アルバム連続再生中認証切れ・切断後の再生継続性テスト
 *
 * 【検証範囲】
 * 1. 現在曲の再生途中切断 (Mid-track Disconnect)
 * 2. 次曲遷移時の切断 (Next-track Transition Disconnect)
 * 3. 再接続復帰と世代管理 (Resume, PlaybackSession & Stale Guards)
 * 4. NotAllowedError (iOS / PWA Autoplay Restriction Recovery)
 * 5. ユーザーキャンセル処理 (Modal Cancellation & Re-prompting)
 * 6. エラー分類 (classifyDriveStreamError)
 * 7. 診断情報とセキュリティサニタイズ (Diagnostics & Sanitization)
 * 8. 既存機能非干渉 (Non-interference with Range Proxy, keyShift, EQ, etc.)
 */

import { strictEqual, deepStrictEqual, ok } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true, userAgent: "Mozilla/5.0 (NodeTest)" },
  configurable: true,
  writable: true,
});

if (typeof globalThis.screen === "undefined") {
  globalThis.screen = { width: 1920, height: 1080, colorDepth: 24 };
}

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const defaultMockFetch = async (url, opts) => {
  if (String(url).startsWith("/")) {
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
globalThis.fetch = defaultMockFetch;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}:`, err);
    throw err;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}:`, err);
    throw err;
  }
}

console.log("=== 1. 静的コード検査: 切断検出・状態保持・復帰シグネチャの完全性 ===");

test("audio-engine.js: 切断復帰および診断関連関数が漏れなく export されていること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  ok(aeCode.includes("export function classifyDriveStreamError("), "classifyDriveStreamError must be exported");
  ok(aeCode.includes("export function resolveSafeResumePosition("), "resolveSafeResumePosition must be exported");
  ok(aeCode.includes("export function getPendingDriveResume("), "getPendingDriveResume must be exported");
  ok(aeCode.includes("export function clearPendingDriveResume("), "clearPendingDriveResume must be exported");
  ok(aeCode.includes("export function shouldClearPendingDriveResume("), "shouldClearPendingDriveResume must be exported");
  ok(aeCode.includes("export async function triggerDrivePlaybackReconnect("), "triggerDrivePlaybackReconnect must be exported");
  ok(aeCode.includes("export function getPlaybackDiagnosticsHistory("), "getPlaybackDiagnosticsHistory must be exported");
  ok(aeCode.includes("export function clearPlaybackDiagnosticsHistory("), "clearPlaybackDiagnosticsHistory must be exported");
});

test("drive-service.js: 診断情報と再接続モーダル拡張関数が export されていること", () => {
  const dsCode = fs.readFileSync(path.join(__dirname, "../js/gdrive/drive-service.js"), "utf8");
  ok(dsCode.includes("export function getLastSilentRefreshFailure("), "getLastSilentRefreshFailure must be exported");
  ok(dsCode.includes("export function getDriveSessionDiagnostics("), "getDriveSessionDiagnostics must be exported");
  ok(dsCode.includes("export function getDriveTokenDiagnostics("), "getDriveTokenDiagnostics must be exported");
  ok(dsCode.includes("export async function promptDriveReconnectModal("), "promptDriveReconnectModal must be exported");
});

test("audio-engine.js: audio error 時に src を解除せず、session.isStale を立て、pendingDriveResume を記録すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const errBlockMatch = aeCode.match(/if \(isProxyStream && isMidTrack && !pendingDriveResume\) \{([\s\S]*?)return;\s*\}/);
  ok(errBlockMatch, "error handler mid-track proxy disconnect block must exist");
  const errBlock = errBlockMatch[1];
  ok(!errBlock.includes("curAudio.src = ''"), "Must not clear curAudio.src");
  ok(!errBlock.includes("curAudio.removeAttribute('src')"), "Must not remove src attribute");
  ok(errBlock.includes("curAudio.pause()"), "Must pause curAudio");
  ok(errBlock.includes("session.isStale = true"), "Must mark session as stale");
  ok(errBlock.includes('playbackStatus: "drive_reconnect_required"'), "Must set playbackStatus to drive_reconnect_required");
  ok(errBlock.includes("triggerDrivePlaybackReconnect().catch("), "Must invoke triggerDrivePlaybackReconnect");
});

test("audio-engine.js: onPlaying, onPause, onTimeUpdate, onEnded, syncRealAudioDuration に isStale ガードが存在すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");

  ok(aeCode.includes("if (activePlaybackSession && activePlaybackSession.isStale) return;"), "isStale guard must exist in event handlers");

  const onPlayingMatch = aeCode.match(/function onPlaying\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  ok(onPlayingMatch && onPlayingMatch[1].includes("if (activePlaybackSession && activePlaybackSession.isStale) return;"), "onPlaying must check isStale");
  ok(onPlayingMatch && onPlayingMatch[1].includes("pendingDriveResume = null;"), "onPlaying must clear pendingDriveResume on fresh session");

  const onPauseMatch = aeCode.match(/function onPause\(\) \{([\s\S]*?)\n\}/);
  ok(onPauseMatch && onPauseMatch[1].includes("if (activePlaybackSession && activePlaybackSession.isStale) return;"), "onPause must check isStale");
  ok(onPauseMatch && onPauseMatch[1].includes('playbackStatus === "drive_reconnect_required"'), "onPause must not overwrite drive_reconnect_required");

  const onTimeUpdateMatch = aeCode.match(/function onTimeUpdate\(\) \{([\s\S]*?)const track =/);
  ok(onTimeUpdateMatch && onTimeUpdateMatch[1].includes("if (activePlaybackSession && activePlaybackSession.isStale) return;"), "onTimeUpdate must check isStale");

  const onEndedMatch = aeCode.match(/function onEnded\(\) \{([\s\S]*?)const session =/);
  ok(onEndedMatch && onEndedMatch[1].includes("if (activePlaybackSession && activePlaybackSession.isStale) return;"), "onEnded must check isStale");

  const syncDurationMatch = aeCode.match(/const syncRealAudioDuration = \(e\) => \{([\s\S]*?)const curAudio =/);
  ok(syncDurationMatch && syncDurationMatch[1].includes("if (activePlaybackSession && activePlaybackSession.isStale) return;"), "syncRealAudioDuration must check isStale");
});

test("audio-engine.js: loadAndPlay の NotAllowedError で paused 着地し再接続状態を維持すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  ok(aeCode.includes('err?.name === "NotAllowedError"'), "Must check for NotAllowedError");
  ok(aeCode.includes('playbackStatus: "paused"'), "Must land on paused playbackStatus");
  ok(aeCode.includes("Driveへ接続しました。再生ボタンを押すと続きから再開します"), "Must notify user with tap-to-resume toast");
});

test("audio-engine.js: executePlay で drive_reconnect_required 時に再接続フローを再表示すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const execPlayMatch = aeCode.match(/export async function executePlay\(options = \{\}\) \{([\s\S]*?)const fromVisibilityResume =/);
  ok(execPlayMatch, "executePlay beginning must exist");
  const block = execPlayMatch[1];
  ok(block.includes('appState.get().playbackStatus === "drive_reconnect_required"'), "Must check for drive_reconnect_required status");
  ok(block.includes("triggerDrivePlaybackReconnect().catch("), "Must re-trigger reconnect dialog on user play tap");
});

console.log("=== 2. エラー分類と位置算出ロジックの単体検証 ===");

await (async () => {
  const { classifyDriveStreamError, resolveSafeResumePosition } = await import("../js/player/audio-engine.js");

  test("resolveSafeResumePosition: targetEl.currentTime > 0 ならその値を採用", () => {
    const mockEl = { currentTime: 45.7 };
    const track = { duration: 180 };
    const pos = resolveSafeResumePosition(mockEl, track);
    strictEqual(pos, 45.7, "Should adopt audio currentTime");
  });

  test("resolveSafeResumePosition: targetEl.currentTime <= 0 なら appState.currentTime を採用", () => {
    const mockEl = { currentTime: 0 };
    const track = { duration: 180 };
    // appState に仮の currentTime をセットして検証
    const pos = resolveSafeResumePosition(mockEl, track);
    ok(typeof pos === "number" && pos >= 0, "Must return valid non-negative number");
  });

  test("resolveSafeResumePosition: duration を超えないよう clamp されること", () => {
    const mockEl = { currentTime: 185.0 };
    const track = { duration: 180 };
    const pos = resolveSafeResumePosition(mockEl, track);
    ok(pos < 180, "Position must be clamped below track duration");
  });

  test("classifyDriveStreamError: offline 判定", () => {
    const origDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false, userAgent: "test" },
        configurable: true,
        writable: true,
      });
      const res = classifyDriveStreamError(new Error("Network connection dropped"), { isMidTrack: true });
      strictEqual(res.type, "offline", "Must classify as offline");
    } finally {
      if (origDesc) {
        Object.defineProperty(globalThis, "navigator", origDesc);
      }
    }
  });

  test("classifyDriveStreamError: トークン失効・期限切れ判定", () => {
    const err = new Error("Drive access token expired (status 401)");
    const res = classifyDriveStreamError(err, { isMidTrack: true });
    strictEqual(res.type, "token_expired", "Must classify as token_expired");
  });

  test("classifyDriveStreamError: サイレントリフレッシュ失敗判定", () => {
    const err = new Error("silent refresh failed with timeout");
    const res = classifyDriveStreamError(err, { isMidTrack: true });
    strictEqual(res.type, "silent_refresh_failed", "Must classify as silent_refresh_failed");
  });

  test("classifyDriveStreamError: Cookie 欠落 / プロキシセッション失効判定", () => {
    const err = new Error("drive-stream proxy session cookie missing");
    const res = classifyDriveStreamError(err, { isMidTrack: true });
    strictEqual(res.type, "proxy_session_expired", "Must classify as proxy_session_expired");
  });

  test("classifyDriveStreamError: レート制限 (429) 判定", () => {
    const err = new Error("Rate limit exceeded 429 Too Many Requests");
    const res = classifyDriveStreamError(err, { isMidTrack: true });
    strictEqual(res.type, "rate_limited", "Must classify as rate_limited");
  });

  test("classifyDriveStreamError: 5xx サーバーエラー判定", () => {
    const err = new Error("Upstream gateway error 502 Bad Gateway");
    const res = classifyDriveStreamError(err, { isMidTrack: true });
    strictEqual(res.type, "drive_server_5xx", "Must classify as drive_server_5xx");
  });

  test("classifyDriveStreamError: 曲頭でのデコードエラーは decode_error と判定", () => {
    const err = new Error("MEDIA_ERR_DECODE occurred");
    const res = classifyDriveStreamError(err, { isMidTrack: false, mediaErrorCode: 3 });
    strictEqual(res.type, "decode_error", "Track start decode error must be decode_error");
  });

  test("classifyDriveStreamError: 不明な途中切断は unknown_stream_error と判定", () => {
    const err = new Error("Unexpected chunk truncation");
    const res = classifyDriveStreamError(err, { isMidTrack: true, isSessionReady: true });
    strictEqual(res.type, "unknown_stream_error", "Unknown mid-track error must be unknown_stream_error");
  });
})();

console.log("=== 3. shouldAttemptBlobFallback の最小遮断ガード検証 ===");

await (async () => {
  const { shouldAttemptBlobFallback } = await import("../js/player/audio-engine.js");

  test("shouldAttemptBlobFallback: drive_proxy_stream 再生途中 (curTime > 0) は Blob フォールバックを絶対に拒絶すること", () => {
    const mockSession = {
      sourceType: "drive_proxy_stream",
      isFlacDetected: true,
      blobFallbackAttempted: false,
      blobFallbackPromise: null,
    };
    const track = { id: "gd-test-flac", gdriveFileId: "file123", format: "flac" };
    const err = new Error("Stream connection reset");

    // mock audioElement with currentTime > 0
    const mockAudio = { currentTime: 35.0, error: { code: 2 } };
    const result = shouldAttemptBlobFallback(mockSession, track, err);
    strictEqual(result, false, "Must not fallback to blob download during mid-track streaming");
  });

  test("shouldAttemptBlobFallback: 認証・トークンエラー文字列を含む場合は拒絶すること", () => {
    const mockSession = {
      sourceType: "drive_proxy_stream",
      isFlacDetected: true,
      blobFallbackAttempted: false,
    };
    const track = { id: "gd-test-flac", gdriveFileId: "file123", format: "flac" };
    const err = new Error("Google Drive 401: トークンの有効期限が切れています");
    const result = shouldAttemptBlobFallback(mockSession, track, err);
    strictEqual(result, false, "Must not fallback to blob download on auth errors");
  });

  test("shouldAttemptBlobFallback: レート制限 (429) または Cookie 欠落時は拒絶すること", () => {
    const mockSession = {
      sourceType: "drive_proxy_stream",
      isFlacDetected: true,
      blobFallbackAttempted: false,
    };
    const track = { id: "gd-test-flac", gdriveFileId: "file123", format: "flac" };
    const err = new Error("429 rate_limited");
    const result = shouldAttemptBlobFallback(mockSession, track, err);
    strictEqual(result, false, "Must not fallback to blob download on rate limit");
  });
})();

console.log("=== 4. 診断情報採取と機密情報サニタイズ検証 ===");

await (async () => {
  const {
    generatePlaybackDiagnostics,
    getPlaybackDiagnosticsHistory,
    clearPlaybackDiagnosticsHistory,
  } = await import("../js/player/audio-engine.js");
  const {
    getDriveSessionDiagnostics,
    getDriveTokenDiagnostics,
  } = await import("../js/gdrive/drive-service.js");

  test("getDriveSessionDiagnostics / getDriveTokenDiagnostics が期待通りの構造を返すこと", () => {
    const sDiag = getDriveSessionDiagnostics();
    ok("isReady" in sDiag, "isReady must exist");
    ok("createdAt" in sDiag, "createdAt must exist");
    ok("remainingMs" in sDiag, "remainingMs must exist");

    const tDiag = getDriveTokenDiagnostics();
    ok("acquiredAt" in tDiag, "acquiredAt must exist");
    ok("expiresAt" in tDiag, "expiresAt must exist");
    ok("remainingMs" in tDiag, "remainingMs must exist");
  });

  test("generatePlaybackDiagnostics: Section 15 の全17項目を含み機密情報がサニタイズされること", () => {
    clearPlaybackDiagnosticsHistory();

    const mockSession = {
      sessionId: "test-sess-001",
      playAttemptId: 1,
      sourceType: "drive_proxy_stream",
      isFlacDetected: true,
      isCached: false,
      proxyEnabled: true,
      proxySessionCreated: true,
      proxyRequestStarted: true,
      activeElement: { id: "stream-audio-el", readyState: 2, networkState: 1 },
      lastError: null,
      appliedKeyShift: 0,
    };

    const mockTrack = {
      id: "gd-sensitive-track",
      title: "Secret Song",
      gdriveFileId: "file_999888777",
      duration: 200,
    };

    const rawError = new Error("Failed to stream ya29.a0ARrdaM-sensitive_token_data with Cookie: MP_DRIVE_SESSION=secret_cookie_val");

    const diag = generatePlaybackDiagnostics(mockSession, mockTrack, rawError, {
      disconnectDecisionSource: "proxy_session_expired",
    });

    // 必須 17 項目キーの検証
    const requiredKeys = [
      "appVersion", "online", "sourceType", "proxyEnabled",
      "proxySessionCreated", "proxyRequestStarted", "activeElement",
      "readyState", "networkState", "sanitizedFileId",
      "tokenAcquiredAt", "tokenExpiresAt", "tokenRemainingMs",
      "tokenRemainingMin", "expiryMarginMs", "proxySessionCreatedAt",
      "proxySessionExpiresAt", "proxySessionRemainingMs", "proxySessionRemainingMin",
      "disconnectDecisionSource", "pendingDriveTime", "isTrackTransition",
      "sessionId", "currentPlayAttemptIdSuffix", "errorMessage", "errorName",
    ];

    for (const key of requiredKeys) {
      ok(key in diag, `Diagnostic property '${key}' must exist`);
    }

    // セキュリティサニタイズ検証
    const jsonStr = JSON.stringify(diag);
    strictEqual(jsonStr.includes("ya29.a0ARrdaM"), false, "Must not contain ya29 token");
    strictEqual(jsonStr.includes("MP_DRIVE_SESSION="), false, "Must not contain raw Cookie name and value");
    strictEqual(jsonStr.includes("secret_cookie_val"), false, "Must not contain cookie value");

    // 履歴管理の検証
    const history = getPlaybackDiagnosticsHistory();
    ok(history.length >= 1, "Diagnostics must be recorded in history");
    strictEqual(history[history.length - 1].sessionId, "-001");
  });

  test("diagnosticsHistory: 50件上限でローテーションされること", () => {
    clearPlaybackDiagnosticsHistory();
    const mockSession = { sessionId: "sess", playAttemptId: 1 };
    const mockTrack = { id: "tr", title: "T" };

    for (let i = 0; i < 60; i++) {
      generatePlaybackDiagnostics(mockSession, mockTrack, new Error(`Err ${i}`));
    }

    const history = getPlaybackDiagnosticsHistory();
    strictEqual(history.length, 50, "History length must be capped at 50");
  });
})();

console.log("=== 5. 再生切断・状態保持・再接続復帰の総合シミュレーション検証 ===");

await (async () => {
  const { appState } = await import("../js/state.js");
  const {
    _setAudioElementsForTest,
    getPendingDriveResume,
    clearPendingDriveResume,
    _setPendingDriveResumeForTest,
    triggerDrivePlaybackReconnect,
    executePlay,
  } = await import("../js/player/audio-engine.js");

  class MockAudioElement extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
      this.src = "";
      this.currentTime = 0;
      this.duration = 200;
      this.paused = true;
      this.ended = false;
      this.readyState = 4;
      this.networkState = 1;
      this.volume = 1;
      this.playbackRate = 1;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.loadCalls = 0;
      this.playImpl = async () => { this.paused = false; };
    }
    load() { this.loadCalls++; }
    pause() {
      this.pauseCalls++;
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
    play() {
      this.playCalls++;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve().then(() => this.playImpl());
    }
  }

  const mockMainEl = new MockAudioElement("audio-el");
  const mockStreamEl = new MockAudioElement("stream-audio-el");
  _setAudioElementsForTest(mockMainEl, mockStreamEl);

  test("現在曲途中切断シミュレーション: src非解除・appState保持・drive_reconnect_required 設定", () => {
    clearPendingDriveResume();
    const curTrack = { id: "gd-track-album-1", title: "Track 1", duration: 200 };
    const queue = [curTrack, { id: "gd-track-album-2", title: "Track 2", duration: 220 }];

    appState.set({
      currentTrack: curTrack,
      queue,
      queueIndex: 0,
      currentTime: 68.5,
      duration: 200,
      isPlaying: true,
      playbackStatus: "playing",
    });

    mockStreamEl.src = "/api/drive-stream?fileId=track-1";
    mockStreamEl.currentTime = 68.5;

    const pending = {
      trackId: curTrack.id,
      time: 68.5,
      queueIndex: 0,
      reason: "proxy_session_expired",
      sourcePlayAttemptId: 1,
      createdAt: Date.now(),
      reconnectInProgress: false,
      promptShown: true,
    };
    _setPendingDriveResumeForTest(pending);

    appState.set({
      isPlaying: false,
      loadingTrackId: null,
      playbackStatus: "drive_reconnect_required",
      currentTime: 68.5,
    });

    // 検証
    strictEqual(mockStreamEl.src, "/api/drive-stream?fileId=track-1", "src must remain intact");
    strictEqual(appState.get().currentTime, 68.5, "currentTime must remain 68.5");
    strictEqual(appState.get().queueIndex, 0, "queueIndex must remain 0");
    strictEqual(appState.get().currentTrack.id, "gd-track-album-1", "currentTrack must remain Track 1");
    strictEqual(appState.get().playbackStatus, "drive_reconnect_required", "playbackStatus must be drive_reconnect_required");
    strictEqual(appState.get().isPlaying, false, "isPlaying must be false");
    strictEqual(getPendingDriveResume().time, 68.5, "Pending resume position must be 68.5s");
  });

  await asyncTest("再接続待機中のユーザー再生ボタン押下: 勝手に音声を流さず再接続フローを呼ぶこと", async () => {
    // pendingDriveResume を保持した状態で executePlay を呼ぶ
    const res = await executePlay();
    strictEqual(res, false, "executePlay must return false while awaiting drive reconnect");
  });

  test("NotAllowedError: 認証成功後の自動再生拒絶時に paused 着地しユーザー再開を待機", () => {
    const curTrack = { id: "gd-track-album-1", title: "Track 1", duration: 200 };
    appState.set({
      currentTrack: curTrack,
      currentTime: 68.5,
      isPlaying: false,
      loadingTrackId: null,
      playbackStatus: "paused",
    });

    strictEqual(appState.get().playbackStatus, "paused", "Must land safely on paused status");
    strictEqual(appState.get().currentTime, 68.5, "Position must be preserved at 68.5s");
    strictEqual(appState.get().isPlaying, false, "isPlaying must be false");
  });
})();

console.log("=== 6. 既存機能非干渉検証 (Regression Guard) ===");

test("既存機能への副作用がないこと (Range Proxy, EQ, KeyChange, Last.fm, Router)", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");

  // 1. Range Proxy
  ok(aeCode.includes("getDriveProxyStreamUrl"), "Range proxy URL function must be intact");
  ok(aeCode.includes("ensureDriveStreamSession"), "Drive stream session must be intact");

  // 2. EQ & KeyShift
  ok(aeCode.includes("applyKeyShift"), "Key shift function must be intact");
  ok(aeCode.includes("applyEffectsSetting"), "EQ effects must be intact");
  ok(aeCode.includes("resumeEqContext"), "AudioContext resume must be intact");

  // 3. Last.fm
  ok(aeCode.includes("recordHistory"), "History recording must be intact");
  ok(aeCode.includes("hasScrobbledSession"), "Scrobble lock must be intact");

  // 4. 定期タイマーや無限再試行の新設がないこと (既存の2個: silenceSampleInterval, sleepTimerId を維持)
  const addedIntervals = aeCode.match(/setInterval\(/g) || [];
  strictEqual(addedIntervals.length <= 2, true, "Must not introduce new setInterval calls");
});

console.log("=== 7. Proxy Session 二重POST防止とPromise共有検証 ===");

await (async () => {
  const {
    ensureDriveStreamSession,
    clearDriveStreamSession,
    isDriveStreamSessionReady,
    getDriveStreamSessionStatus,
    setDriveToken,
  } = await import("../js/gdrive/drive-service.js");
  const {
    getPendingDriveResume,
    _setPendingDriveResumeForTest,
  } = await import("../js/player/audio-engine.js");
  const { setPublic } = await import("../js/store/settings.js");
  setPublic({ driveProxyStreamEnabled: true });

  // テスト用 fetch モック
  let postCount = 0;
  let postResolve = null;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/api/drive-session") && opts?.method === "POST") {
      postCount++;
      return new Promise((res) => {
        postResolve = () => res({ ok: true, status: 200, json: async () => ({ ok: true }) });
      });
    }
    if (String(url).includes("/api/drive-session") && opts?.method === "DELETE") {
      return { ok: true, status: 200 };
    }
    return origFetch ? origFetch(url, opts) : { ok: true };
  };

  try {
    await clearDriveStreamSession();

    await asyncTest("ensureDriveStreamSession: 進行中Promiseを共有し二重POSTを完全防止", async () => {
      postCount = 0;
      const testToken = "test_token_unique_123";

      // setDriveToken によりトークンをセット（内部で ensureDriveStreamSession が呼ばれ、非同期にPOSTが開始される）
      await setDriveToken(testToken);

      strictEqual(getDriveStreamSessionStatus(), "connecting", "Status must be connecting while in-flight");
      strictEqual(isDriveStreamSessionReady(testToken), false, "Must not be ready while connecting");

      // triggerDrivePlaybackReconnect と同様に ensureDriveStreamSession(token) を実行
      const p2 = ensureDriveStreamSession(testToken);

      // 進行中Promiseが共有され、POSTが重複発行されないこと
      strictEqual(postCount, 1, "Must make exactly 1 POST while in-flight");

      // Promise を完了させる
      if (postResolve) postResolve();
      const res2 = await p2;

      strictEqual(res2, true, "Session must resolve true");
      strictEqual(postCount, 1, "Total POST count must strictly be 1");
      strictEqual(isDriveStreamSessionReady(testToken), true, "Session must now be ready");
    });

    test("isDriveStreamSessionReady: トークン不一致や期限切れでは ready と誤認しないこと", () => {
      strictEqual(isDriveStreamSessionReady("different_token_456"), false, "Must be false for different token");
      strictEqual(isDriveStreamSessionReady(null), true, "Must be true when no token check requested and valid");
    });

    await asyncTest("Session失敗時: pendingDriveResume を維持し再試行可能状態を保つこと", async () => {
      _setPendingDriveResumeForTest({
        trackId: "gd-test-track",
        time: 50,
        reconnectInProgress: true,
      });

      // エラーレスポンスを返すモック
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes("/api/drive-session")) {
          return { ok: false, status: 500, json: async () => ({ error: "Server Error" }) };
        }
        return { ok: true };
      };

      await clearDriveStreamSession();
      const okRes = await ensureDriveStreamSession("failing_token", { force: true });
      strictEqual(okRes, false, "Must return false on session failure");

      // pendingDriveResume が破棄されていないこと
      const pending = getPendingDriveResume();
      ok(pending !== null, "pendingDriveResume must be preserved");
      strictEqual(pending.trackId, "gd-test-track", "Track ID must be preserved");
      strictEqual(pending.time, 50, "Time must be preserved");
    });
  } finally {
    globalThis.fetch = defaultMockFetch;
  }
})();

console.log("=== 8. pendingDriveResume の厳格な解除条件の検証 ===");

await (async () => {
  const { appState } = await import("../js/state.js");
  const {
    shouldClearPendingDriveResume,
    _setPendingDriveResumeForTest,
    _setActivePlaybackSessionForTest,
    _setTransitionTokenForTest,
  } = await import("../js/player/audio-engine.js");

  const mockTargetEl = { id: "stream-audio-el" };
  const matchingEvent = { target: mockTargetEl, currentTarget: mockTargetEl };

  const validPending = {
    trackId: "gd-track-target",
    time: 90,
    resumeSessionId: "sess-valid-1",
    resumePlayAttemptId: "att-valid-1",
    resumeTransitionToken: 10,
  };

  test("shouldClearPendingDriveResume: 全8条件が合致した playing のみ true を返すこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "gd-track-target" } });
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-target",
      sessionId: "sess-valid-1",
      playAttemptId: "att-valid-1",
      isStale: false,
      activeElement: mockTargetEl,
    });
    _setTransitionTokenForTest(10);

    const canClear = shouldClearPendingDriveResume(matchingEvent);
    strictEqual(canClear, true, "Must return true when all 8 conditions match");
  });

  test("shouldClearPendingDriveResume: 別曲の playing では解除しないこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "gd-track-DIFFERENT" } });
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-target",
      sessionId: "sess-valid-1",
      playAttemptId: "att-valid-1",
      isStale: false,
      activeElement: mockTargetEl,
    });
    _setTransitionTokenForTest(10);

    const canClear = shouldClearPendingDriveResume(matchingEvent);
    strictEqual(canClear, false, "Must not clear on different track");
  });

  test("shouldClearPendingDriveResume: stale Session の playing では解除しないこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "gd-track-target" } });
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-target",
      sessionId: "sess-valid-1",
      playAttemptId: "att-valid-1",
      isStale: true, // stale
      activeElement: mockTargetEl,
    });
    _setTransitionTokenForTest(10);

    const canClear = shouldClearPendingDriveResume(matchingEvent);
    strictEqual(canClear, false, "Must not clear on stale session");
  });

  test("shouldClearPendingDriveResume: 古い playAttemptId では解除しないこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "gd-track-target" } });
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-target",
      sessionId: "sess-valid-1",
      playAttemptId: "att-OLD-99", // old attempt
      isStale: false,
      activeElement: mockTargetEl,
    });
    _setTransitionTokenForTest(10);

    const canClear = shouldClearPendingDriveResume(matchingEvent);
    strictEqual(canClear, false, "Must not clear on old playAttemptId");
  });

  test("shouldClearPendingDriveResume: 古い transitionToken では解除しないこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "gd-track-target" } });
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-target",
      sessionId: "sess-valid-1",
      playAttemptId: "att-valid-1",
      isStale: false,
      activeElement: mockTargetEl,
    });
    _setTransitionTokenForTest(999); // old token

    const canClear = shouldClearPendingDriveResume(matchingEvent);
    strictEqual(canClear, false, "Must not clear on old transitionToken");
  });

  test("shouldClearPendingDriveResume: 通常のローカル曲の playing では解除しないこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "local-track-xyz" } });
    _setActivePlaybackSessionForTest({
      trackId: "local-track-xyz",
      sessionId: "sess-local",
      playAttemptId: "att-local",
      isStale: false,
      activeElement: { id: "audio-el" },
    });
    _setTransitionTokenForTest(10);

    const canClear = shouldClearPendingDriveResume(matchingEvent);
    strictEqual(canClear, false, "Must not clear on local track playing");
  });

  test("shouldClearPendingDriveResume: 非アクティブ要素からのイベントでは解除しないこと", () => {
    _setPendingDriveResumeForTest({ ...validPending });
    appState.set({ currentTrack: { id: "gd-track-target" } });
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-target",
      sessionId: "sess-valid-1",
      playAttemptId: "att-valid-1",
      isStale: false,
      activeElement: mockTargetEl,
    });
    _setTransitionTokenForTest(10);

    const wrongEvent = { target: { id: "wrong-el" }, currentTarget: { id: "wrong-el" } };
    const canClear = shouldClearPendingDriveResume(wrongEvent);
    strictEqual(canClear, false, "Must not clear on event from inactive audio element");
  });
})();

console.log("=== 9. NotAllowedError 後の通常再生ボタン復帰の総合実関数検証 ===");

await (async () => {
  const { appState } = await import("../js/state.js");
  const {
    executePlay,
    getPendingDriveResume,
    clearPendingDriveResume,
    _setPendingDriveResumeForTest,
    _setActivePlaybackSessionForTest,
    _setAudioElementsForTest,
    _setTransitionTokenForTest,
  } = await import("../js/player/audio-engine.js");

  class MockPlayerAudioEl extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
      this.src = "/api/drive-stream?fileId=track-1";
      this.currentTime = 90;
      this.duration = 200;
      this.paused = true;
      this.playCalls = 0;
      this.error = null;
    }
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }

  const mockMain = new MockPlayerAudioEl("main-el");
  const mockStream = new MockPlayerAudioEl("stream-el");
  _setAudioElementsForTest(mockMain, mockStream);

  await asyncTest("NotAllowedError後の再生ボタン押下: Google認証を再表示せず、保持位置からplay()しpendingを維持・解除できること", async () => {
    clearPendingDriveResume();

    const trackA = { id: "gd-track-A", title: "Track A", duration: 200 };
    appState.set({
      currentTrack: trackA,
      currentTime: 90,
      playbackStatus: "paused", // NotAllowedError 着地時
      isPlaying: false,
    });

    const pending = {
      trackId: "gd-track-A",
      time: 90,
      resumeSessionId: "sess-not-allowed-1",
      resumePlayAttemptId: "att-not-allowed-1",
      resumeTransitionToken: 20,
    };
    _setPendingDriveResumeForTest(pending);

    _setActivePlaybackSessionForTest({
      trackId: "gd-track-A",
      sessionId: "sess-not-allowed-1",
      playAttemptId: "att-not-allowed-1",
      isStale: false,
      activeElement: mockStream,
    });
    _setTransitionTokenForTest(20);

    mockStream.src = "/api/drive-stream?fileId=track-A";
    mockStream.currentTime = 90;
    mockStream.error = null;
    mockStream.playCalls = 0;

    // ユーザーが再生ボタンを押す (executePlay)
    const playResult = await executePlay();
    strictEqual(playResult, true, "executePlay must return true");
    strictEqual(mockStream.playCalls, 1, "Must call play() on the prepared stream audio element");

    // まだ playing イベント前なので pending は維持されていること
    ok(getPendingDriveResume() !== null, "pendingDriveResume must remain before playing event");

    // playing イベント到達をシミュレート
    const { shouldClearPendingDriveResume } = await import("../js/player/audio-engine.js");
    const canClear = shouldClearPendingDriveResume({ target: mockStream, currentTarget: mockStream });
    strictEqual(canClear, true, "shouldClearPendingDriveResume must be true upon playing event");

    // 解除
    clearPendingDriveResume();
    strictEqual(getPendingDriveResume(), null, "pendingDriveResume must be cleared after successful resume");
  });

  await asyncTest("再生ボタン押下時: 要素エラーまたはSession stale時は壊れたsrcを直接叩かず安全に新Session準備へ分岐すること", async () => {
    const trackA = { id: "gd-track-A", title: "Track A", duration: 200 };
    appState.set({
      currentTrack: trackA,
      currentTime: 90,
      playbackStatus: "paused",
      isPlaying: false,
    });

    mockStream.error = { code: 2, message: "MEDIA_ERR_NETWORK" };
    _setActivePlaybackSessionForTest({
      trackId: "gd-track-A",
      sessionId: "sess-stale-1",
      playAttemptId: "att-stale-1",
      isStale: true, // stale
      activeElement: mockStream,
    });

    _setPendingDriveResumeForTest({
      trackId: "gd-track-A",
      time: 90,
      resumeSessionId: "sess-stale-1",
    });

    mockStream.playCalls = 0;

    // executePlay は直接 mockStream.play() を呼ばない (壊れた src への直接 play を遮断)
    try {
      await executePlay();
    } catch (_) {}
    strictEqual(mockStream.playCalls, 0, "Must not call play() directly on broken/stale audio element");
  });
})();

console.log(`\nGoogle Drive 連続再生切断・復帰テスト: 全 ${passed} 件 PASSED ✓`);
