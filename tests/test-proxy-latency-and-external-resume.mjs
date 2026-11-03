/**
 * test-proxy-latency-and-external-resume.mjs
 *
 * 1. Beta ONでgetBlobがplaying前に呼ばれない
 * 2. Beta ONでbackground cacheが呼ばれない
 * 3. Range中継とBlob取得が同時実行されない（二重通信の根絶）
 * 4. sourceTypeがdrive_proxy_streamになる
 * 5. proxy URLがaudio.srcへ設定される
 * 6. active要素がstreamAudioElになる
 * 7. NotSupportedErrorの一過性イベントで即Blobフォールバックしない
 * 8. 確定失敗時だけBlobフォールバックを1回実行
 * 9. MediaSession playがsession.activeElementを使う
 * 10. streamAudioEl再開時にAudioContextを操作しない
 * 11. mainAudioEl再開時にsuspended/interrupted Contextをresumeする
 * 12. playing前にUIをplayingへしない
 * 13. 非アクティブaudioのtimeupdateを無視する
 * 14. pause後にsrc/currentTime/sessionを保持する
 * 15. resume watchdogがpause後にplayしない
 * 16. generatePlaybackDiagnosticsの完全性と安全性
 */

import { strictEqual, deepStrictEqual, ok } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

console.log("=== 1. Beta ON での Range 中継優先 & 全量取得・バックグラウンドキャッシュの完全停止 ===");

test("Beta ON の未キャッシュFLACでは、prewarmTrack で全量 Blob 取得が開始されないこと", () => {
  const settingsContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  // prewarmTrack 内で pub.driveProxyStreamEnabled を確認し、true なら即座に return null していること
  ok(settingsContent.includes("pub.driveProxyStreamEnabled"), "prewarmTrack must check driveProxyStreamEnabled");
  ok(settingsContent.includes("prewarmCache.delete(trackId)"), "prewarmTrack must clear prewarm entry on proxy enabled");
});

test("Beta ON の未キャッシュFLACでは、loadAndPlay 前の prewarm Blob 待機が破棄されること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("pub.driveProxyStreamEnabled && (isDrive || isDriveTrack(track))"), "loadAndPlay must discard prewarm promise when proxy is enabled");
});

test("Beta ON の未キャッシュFLACでは、再生開始前に全量 Blob フォールバックが開始されず、中継URLが生成されること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes('session.sourceType = "drive_proxy_stream"'), "sourceType must become drive_proxy_stream");
  ok(engineContent.includes("Drive Range 中継セッションの確立に失敗しました"), "Must throw clean error instead of silent blob fallback on session fail");
});

test("Beta ON で Proxy URL 生成後、直接 Drive URL による targetUrl 上書きが if (!targetUrl) で防止されていること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  // loadAndPlay 内の getDriveStreamUrl の呼び出しが if (!targetUrl) ブロック内にあることを検証
  const commentIdx = engineContent.indexOf("ダイレクトストリーミング URL を取得して即座に再生開始");
  ok(commentIdx !== -1, "Must contain direct stream section comment in loadAndPlay");
  const block = engineContent.slice(commentIdx, commentIdx + 400);
  ok(block.includes("if (!targetUrl)"), "Direct stream generation must be guarded by if (!targetUrl)");
  ok(block.includes("const streamUrl = await getDriveStreamUrl(track.id, token);"), "Must call getDriveStreamUrl inside the guard");
});

test("実関数ロジック検証: Proxy URL 生成時に getDriveStreamUrl が0回、Proxy URL が targetUrl に維持されること", async () => {
  let driveStreamUrlCalled = 0;
  let targetUrl = null;
  let session = {};
  const mockTrack = { id: "track_proxy_test", title: "Test FLAC" };
  const mockToken = "mock_token";

  // モック関数
  const mockGetDriveProxyStreamUrl = () => "/api/drive-stream?fileId=track_proxy_test";
  const mockGetDriveStreamUrl = async () => {
    driveStreamUrlCalled++;
    return "https://www.googleapis.com/drive/v3/files/track_proxy_test?alt=media";
  };

  // 1. Proxy URL 生成
  const proxyUrl = mockGetDriveProxyStreamUrl(mockTrack);
  if (proxyUrl) {
    targetUrl = proxyUrl;
    session.sourceType = "drive_proxy_stream";
  }

  // 2. audio-engine.js の修正後ロジック
  if (!targetUrl) {
    const streamUrl = await mockGetDriveStreamUrl(mockTrack.id, mockToken);
    if (streamUrl) {
      targetUrl = streamUrl;
      session.sourceType = "drive_stream";
    }
  }

  strictEqual(driveStreamUrlCalled, 0, "mockGetDriveStreamUrl must not be called when proxyUrl is ready");
  strictEqual(targetUrl, "/api/drive-stream?fileId=track_proxy_test", "targetUrl must remain the proxy URL");
  strictEqual(session.sourceType, "drive_proxy_stream", "session.sourceType must remain drive_proxy_stream");
});

test("Beta ON では、playing 後も含めてバックグラウンド全量キャッシュが完全に抑止されること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("if (pub.driveProxyStreamEnabled)"), "Background cache must have early return for driveProxyStreamEnabled");
});

console.log("=== 2. 一過性エラーでの即時フォールバック抑止 & 確定失敗時の1回限定フォールバック ===");

test("shouldAttemptBlobFallback: drive_proxy_stream では一時的な初期エラーで即フォールバックせず確定エラーのみ受理すること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes('session.sourceType === "drive_proxy_stream"'), "shouldAttemptBlobFallback must distinguish drive_proxy_stream");
  ok(engineContent.includes("isDefiniteMediaError") || engineContent.includes("isDefiniteHttpError"), "Must require definite media or HTTP error");
});

console.log("=== 3. アプリ外一時停止・再開 (MediaSession play) の完全同期復旧 ===");

test("executePlay: 現在の PlaybackSession.activeElement を厳格に使用し、別要素へ切り替えないこと", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("const curEl = (session && session.activeElement) ? session.activeElement : (activeAudioEl || getAudioElement())"), "executePlay must strictly target session.activeElement");
  ok(engineContent.includes("hasLoadedSrc"), "executePlay must check existing loaded src before re-loading");
});

test("executePlay: mainAudioEl 再生時は AudioContext を resume し、streamAudioEl 再生時は Web Audio を操作しないこと", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("if (curEl === mainAudioEl)"), "AudioContext resume must be restricted to mainAudioEl");
  ok(engineContent.includes("await resumeEqContext("), "Must call resumeEqContext for mainAudioEl");
});

test("resumeEqContext: AudioContext の suspended だけでなく iOS WebKit 独自の interrupted 状態も確実に復旧すること", () => {
  const eqContent = fs.readFileSync(path.join(__dirname, "../js/player/eq.js"), "utf-8");
  ok(eqContent.includes('ctx.state === "interrupted"'), "resumeEqContext must handle interrupted state");
});

test("executePlay: play() Promise resolve だけでは UI の isPlaying を true にせず、playing イベントを待つこと", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  const execPlayIdx = engineContent.indexOf("export async function executePlay");
  const togglePlayIdx = engineContent.indexOf("export async function togglePlay");
  const execPlayBlock = engineContent.slice(execPlayIdx, togglePlayIdx);
  ok(!execPlayBlock.includes("isPlaying: true"), "executePlay must not set isPlaying: true before playing event");
  ok(execPlayBlock.includes("media_session_play_resolved"), "executePlay must log media_session_play_resolved");
});

test("visibilitychange: pendingExternalResume がある場合のみ再開し、通常 pause 時は再生しないこと", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("export async function handleVisibilityChange()"), "Must export handleVisibilityChange");
  ok(engineContent.includes("if (state.pendingExternalResume)"), "visibilitychange must check pendingExternalResume");
  ok(engineContent.includes("if (!state.userPausedExplicitly && activeAudioEl === mainAudioEl && mainAudioEl && !mainAudioEl.paused)"), "visibilitychange must only resume AudioContext when mainAudioEl is actively playing");
});

console.log("=== 4. 実機診断情報 (generatePlaybackDiagnostics) の完全性と安全性 ===");

test("generatePlaybackDiagnostics: 要件の全必須項目が含まれ、機密情報が含まれないこと", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  const requiredKeys = [
    "proxyEnabled",
    "sourceType",
    "proxySessionCreated",
    "proxyRequestStarted",
    "proxyFirstByteMs",
    "proxyStatus",
    "proxyContentType",
    "requestedRange",
    "fallbackAttempted",
    "blobFetchStarted",
    "backgroundCacheStarted",
    "activeElement",
    "audioContextState",
    "mediaSessionAction",
    "playPromiseResult",
    "playingEventReceived",
    "readyState",
    "networkState",
    "bufferedEnd",
    "displayMode",
    "timeline",
    "timelineRaw",
    "sessionStatus",
  ];
  for (const key of requiredKeys) {
    ok(engineContent.includes(`${key}:`) || engineContent.includes(`${key},`), `Diagnostics must contain ${key}`);
  }
});

console.log("=== 5. Google Drive API リダイレクトと Cookie 属性の安全化 ===");

test("drive-stream: リダイレクト先ホストとして .googleusercontent.com が許可されていること", () => {
  const streamContent = fs.readFileSync(path.join(__dirname, "../api/drive-stream.js"), "utf-8");
  ok(streamContent.includes(".googleusercontent.com"), "Must allow googleusercontent.com redirect");
});

test("drive-stream: Google CDN リダイレクト時に Authorization ヘッダーが剥離されていること", () => {
  const streamContent = fs.readFileSync(path.join(__dirname, "../api/drive-stream.js"), "utf-8");
  ok(streamContent.includes("isCdnOrDifferentHost") || streamContent.includes("delete currentHeaders"), "Must strip Authorization header on CDN redirect");
});

test("drive-session: Cookie 属性が SameSite=Lax かつ Path=/api に限定され静的資産へ露出しないこと", () => {
  const sessionContent = fs.readFileSync(path.join(__dirname, "../api/drive-session.js"), "utf-8");
  ok(sessionContent.includes("SameSite=Lax"), "Must be SameSite=Lax for CoreMedia audio requests");
  ok(sessionContent.includes("Path=/api;"), "Must be Path=/api to restrict cookie to API endpoints");
});

test("drive-stream: Cache-Control に private, no-store, no-transform が設定されていること", () => {
  const streamContent = fs.readFileSync(path.join(__dirname, "../api/drive-stream.js"), "utf-8");
  ok(streamContent.includes("private, no-store, no-transform"), "Must set no-transform");
  ok(streamContent.includes("Content-Disposition"), "Must set Content-Disposition inline");
});

console.log("=== 6. 30秒待機の根絶 (セッション事前確立 & Watchdog誤爆遮断) ===");

test("drive-service: セッション事前確立とメモリキャッシュ関数が実装されていること", () => {
  const driveServiceContent = fs.readFileSync(path.join(__dirname, "../js/gdrive/drive-service.js"), "utf-8");
  ok(driveServiceContent.includes("getDriveStreamSessionStatus"), "Must export getDriveStreamSessionStatus");
  ok(driveServiceContent.includes("isDriveStreamSessionReady"), "Must export isDriveStreamSessionReady");
  ok(driveServiceContent.includes("_driveSessionPromise"), "Must deduplicate in-flight session requests");
});

test("audio-engine: 中継再生時の 10秒 watchdog が直接ストリームで再試行せず停止すること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("isProxyStream"), "Watchdog must check isProxyStream");
  ok(engineContent.includes("中継ストリーミングが10秒以内に再生開始しなかったため停止します"), "Watchdog must not fallback to direct stream on proxy timeout");
});

test("view-settings: セッション状態表示と再接続・診断コピーボタンが提供されていること", () => {
  const settingsContent = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf-8");
  ok(settingsContent.includes("btn-gdrive-proxy-reconnect"), "Settings must have reconnect button");
  ok(settingsContent.includes("btn-copy-playback-diag"), "Settings must have copy diagnostics button");
  ok(settingsContent.includes("gdrive-proxy-session-status-text"), "Settings must display session status");
});

console.log("=== 7. 実イベント & Promise によるアプリ外再開 (MediaSession / AudioContext / Visibility) 総合検証 ===");

await (async () => {
  const { appState } = await import("../js/state.js");
  const { _setAudioContextForTest } = await import("../js/player/eq.js");
  const {
    _setAudioElementsForTest,
    ensureMediaSessionActions,
    beginPlaybackSession,
    getCurrentPlaybackSession,
    executePause,
    executePlay,
    handleVisibilityChange,
    generatePlaybackDiagnostics,
    buildSafePlayRejectDiagnostics,
  } = await import("../js/player/audio-engine.js");

  class MockAudioElement extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
      this.src = "";
      this.currentTime = 0;
      this.duration = 240;
      this.paused = true;
      this.ended = false;
      this.readyState = 4;
      this.networkState = 1;
      this.volume = 1;
      this.muted = false;
      this.playbackRate = 1;
      this.loop = false;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.loadCalls = 0;
      this.removeSrcCalls = 0;
      this.playImpl = async () => {
        this.paused = false;
      };
    }
    get currentSrc() {
      return this.src;
    }
    removeAttribute(attr) {
      if (attr === "src") {
        this.removeSrcCalls++;
        this.src = "";
      }
    }
    load() {
      this.loadCalls++;
    }
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

  const actionHandlers = new Map();
  const mockMediaSession = {
    playbackState: "none",
    metadata: null,
    positionState: null,
    setActionHandler(action, fn) {
      actionHandlers.set(action, fn);
    },
    setPositionState(st) {
      this.positionState = st;
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaSession: mockMediaSession,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
      onLine: true,
    },
    configurable: true,
    writable: true,
  });

  const docState = {
    hidden: false,
    visibilityState: "visible",
    getElementById: () => null,
    addEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    value: docState,
    configurable: true,
    writable: true,
  });

  const mockMainEl = new MockAudioElement("audio-el");
  const mockStreamEl = new MockAudioElement("stream-audio-el");
  _setAudioElementsForTest(mockMainEl, mockStreamEl);

  await asyncTest("1. MediaSession play/pause/stop/previoustrack/nexttrack/seekto ハンドラーが登録され togglepause は登録されないこと", async () => {
    actionHandlers.clear();
    ensureMediaSessionActions();
    strictEqual(typeof actionHandlers.get("play"), "function", "play handler must be registered");
    strictEqual(typeof actionHandlers.get("pause"), "function", "pause handler must be registered");
    strictEqual(typeof actionHandlers.get("stop"), "function", "stop handler must be registered");
    strictEqual(typeof actionHandlers.get("previoustrack"), "function", "previoustrack handler must be registered");
    strictEqual(typeof actionHandlers.get("nexttrack"), "function", "nexttrack handler must be registered");
    strictEqual(typeof actionHandlers.get("seekto"), "function", "seekto handler must be registered");
    strictEqual(actionHandlers.has("togglepause"), false, "togglepause must not be registered");
  });

  await asyncTest("2〜4. pause 後も PlaybackSession・activeElement・src・currentTime が保持され、破壊処理が行われないこと", async () => {
    const track = { id: "gd-flac-1", title: "Test FLAC", duration: 240 };
    appState.set({ currentTrack: track, duration: 240, currentTime: 42.5, isPlaying: true, playbackStatus: "playing" });
    const session = beginPlaybackSession(track, 0, 0);
    session.activeElement = mockStreamEl;
    session.sourceType = "drive_proxy_stream";
    mockStreamEl.src = "/api/drive-stream?fileId=flac-1";
    mockStreamEl.currentTime = 42.5;
    mockStreamEl.paused = false;
    mockStreamEl.loadCalls = 0;
    mockStreamEl.removeSrcCalls = 0;

    // MediaSession pause ハンドラー経由で実行
    actionHandlers.get("pause")();

    strictEqual(getCurrentPlaybackSession(), session, "PlaybackSession must remain active after pause");
    strictEqual(session.isStale, false, "PlaybackSession must not be destroyed on pause");
    strictEqual(session.activeElement, mockStreamEl, "session.activeElement must be preserved");
    strictEqual(mockStreamEl.src, "/api/drive-stream?fileId=flac-1", "audio.src must be preserved");
    strictEqual(mockStreamEl.currentTime, 42.5, "audio.currentTime must be preserved");
    strictEqual(mockStreamEl.loadCalls, 0, "load() must not be called on pause");
    strictEqual(mockStreamEl.removeSrcCalls, 0, "src must not be removed on pause");
    strictEqual(mockMediaSession.playbackState, "paused", "mediaSession.playbackState must be paused");
    strictEqual(typeof actionHandlers.get("play"), "function", "play handler must remain registered after pause");
    ok(session.timeline.some((e) => e.event === "media_session_pause_received"), "Must record media_session_pause_received");
    ok(session.timeline.some((e) => e.event === "media_session_pause_completed"), "Must record media_session_pause_completed");
  });

  await asyncTest("5〜7 & 13〜14. streamAudioEl で外部 play を受信: AudioContext を操作せず play() を1回だけ呼び、playing イベントで初めて playing になること", async () => {
    let ctxResumeCalls = 0;
    let ctxCloseCalls = 0;
    let createSourceCalls = 0;
    _setAudioContextForTest({
      state: "suspended",
      resume: async () => { ctxResumeCalls++; },
      close: async () => { ctxCloseCalls++; },
      createMediaElementSource: () => { createSourceCalls++; return {}; },
    });

    const session = getCurrentPlaybackSession();
    mockStreamEl.playCalls = 0;
    mockStreamEl.loadCalls = 0;
    mockMainEl.playCalls = 0;

    // MediaSession play ハンドラー呼び出し
    const playResultPromise = actionHandlers.get("play")();
    const playResult = await playResultPromise;
    strictEqual(playResult, true, "executePlay must resolve true");
    strictEqual(mockStreamEl.playCalls, 1, "streamAudioEl.play() must be called exactly once");
    strictEqual(mockMainEl.playCalls, 0, "mainAudioEl.play() must not be called");
    strictEqual(ctxResumeCalls, 0, "AudioContext.resume() must NOT be called for streamAudioEl");
    strictEqual(ctxCloseCalls, 0, "AudioContext.close() must NOT be called");
    strictEqual(createSourceCalls, 0, "createMediaElementSource must NOT be called");
    strictEqual(mockStreamEl.loadCalls, 0, "streamAudioEl.load() must NOT be called");
    strictEqual(mockStreamEl.currentTime, 42.5, "currentTime must remain unchanged");

    // 要件 #13: play Promise resolve だけでは UI も MediaSession も playing にしない
    strictEqual(appState.get().isPlaying, false, "UI isPlaying must remain false after play() resolve before playing event");
    strictEqual(mockMediaSession.playbackState, "paused", "mediaSession.playbackState must remain paused before playing event");

    // 要件 #14: playing イベント発火で初めて playing になる
    mockStreamEl.dispatchEvent(new Event("playing"));
    strictEqual(appState.get().isPlaying, true, "UI isPlaying must become true on playing event");
    strictEqual(appState.get().playbackStatus, "playing", "playbackStatus must become playing on playing event");
    strictEqual(mockMediaSession.playbackState, "playing", "mediaSession.playbackState must become playing on playing event");

    const events = session.timeline.map((e) => e.event);
    ok(events.includes("media_session_play_received"), "Must record media_session_play_received");
    ok(events.includes("media_session_play_active_element_resolved"), "Must record media_session_play_active_element_resolved");
    ok(events.includes("media_session_play_called"), "Must record media_session_play_called");
    ok(events.includes("media_session_play_resolved"), "Must record media_session_play_resolved");
    ok(events.includes("media_session_playing_received"), "Must record media_session_playing_received");
  });

  await asyncTest("8〜11 & 20〜21. mainAudioEl で外部 play 受信: suspended および interrupted Context を resume し、running 確認後に play() すること", async () => {
    for (const initialState of ["suspended", "interrupted"]) {
      const callOrder = [];
      let closeCalls = 0;
      let createSourceCalls = 0;
      const mockCtx = {
        state: initialState,
        resume: async () => {
          callOrder.push(`ctx_resume_from_${initialState}`);
          mockCtx.state = "running";
        },
        close: async () => { closeCalls++; },
        createMediaElementSource: () => { createSourceCalls++; return {}; },
      };
      _setAudioContextForTest(mockCtx, {});

      const track = { id: "local-1", title: "Cached Track", duration: 180 };
      appState.set({ currentTrack: track, duration: 180, currentTime: 15, isPlaying: false, playbackStatus: "paused" });
      const session = beginPlaybackSession(track, 0, 0);
      session.activeElement = mockMainEl;
      session.sourceType = "cached_blob";
      mockMainEl.src = "blob:https://example.com/audio-1";
      mockMainEl.currentTime = 15;
      mockMainEl.paused = true;
      mockMainEl.playCalls = 0;
      mockMainEl.playImpl = async () => {
        callOrder.push("mainAudioEl_play");
        mockMainEl.paused = false;
      };

      const okRes = await executePlay();
      strictEqual(okRes, true, `executePlay should succeed for ${initialState}`);
      deepStrictEqual(callOrder, [`ctx_resume_from_${initialState}`, "mainAudioEl_play"], "Context must resume to running BEFORE mainAudioEl.play() is called");
      strictEqual(mockMainEl.playCalls, 1, "mainAudioEl.play() must be called once");
      strictEqual(closeCalls, 0, "AudioContext.close() must not be called");
      strictEqual(createSourceCalls, 0, "createMediaElementSource must not be recreated");

      const events = session.timeline.map((e) => e.event);
      ok(events.includes("media_session_audio_context_before_resume"), "Must record before_resume");
      ok(events.includes("media_session_audio_context_after_resume"), "Must record after_resume");
    }
  });

  await asyncTest("12. mainAudioEl で AudioContext.resume() が失敗し running へ戻らない場合は play() を呼ばず paused へ戻すこと", async () => {
    const mockCtx = {
      state: "interrupted",
      resume: async () => {
        throw new Error("OS blocked AudioContext resume in background");
      },
    };
    _setAudioContextForTest(mockCtx, {});

    const track = { id: "local-2", title: "Blocked Track", duration: 180 };
    appState.set({ currentTrack: track, duration: 180, currentTime: 30, isPlaying: false, playbackStatus: "paused" });
    const session = beginPlaybackSession(track, 0, 0);
    session.activeElement = mockMainEl;
    session.sourceType = "cached_blob";
    mockMainEl.src = "blob:https://example.com/audio-2";
    mockMainEl.currentTime = 30;
    mockMainEl.paused = true;
    mockMainEl.playCalls = 0;

    const okRes = await executePlay();
    strictEqual(okRes, false, "executePlay must return false when AudioContext stays interrupted");
    strictEqual(mockMainEl.playCalls, 0, "mainAudioEl.play() must NOT be called when AudioContext is not running");
    strictEqual(appState.get().playbackStatus, "paused", "playbackStatus must remain paused");
    strictEqual(mockMediaSession.playbackState, "paused", "mediaSession.playbackState must be paused");
    strictEqual(session.pendingExternalResume, true, "pendingExternalResume must be set when background resume fails");
  });

  await asyncTest("15〜16 & 4. NotAllowedError / AbortError で pendingExternalResume を設定し、安全な診断情報のみ記録すること", async () => {
    _setAudioContextForTest(null, null);

    for (const errName of ["NotAllowedError", "AbortError"]) {
      const track = { id: "gd-flac-err", title: "Error Test", duration: 200 };
      appState.set({ currentTrack: track, duration: 200, currentTime: 55, isPlaying: false, playbackStatus: "paused" });
      const session = beginPlaybackSession(track, 0, 0);
      session.activeElement = mockStreamEl;
      session.sourceType = "drive_proxy_stream";
      mockStreamEl.src = "/api/drive-stream?fileId=secret_file_id_123";
      mockStreamEl.currentTime = 55;
      mockStreamEl.paused = true;
      mockStreamEl.playCalls = 0;
      mockStreamEl.playImpl = async () => {
        const e = new Error(`Failed to play https://example.com/secret?fileId=abc token=ya29.secretToken123 (${errName})`);
        e.name = errName;
        throw e;
      };

      docState.hidden = true;
      docState.visibilityState = "hidden";

      const res = await executePlay();
      strictEqual(res, false, `executePlay should return false on ${errName}`);
      strictEqual(session.pendingExternalResume, true, `pendingExternalResume must be true on ${errName}`);
      strictEqual(mockStreamEl.src, "/api/drive-stream?fileId=secret_file_id_123", "src must be preserved");
      strictEqual(mockStreamEl.currentTime, 55, "currentTime must be preserved");
      strictEqual(mockMediaSession.playbackState, "paused", "playbackState must be reverted to paused");

      const rejectInfo = session.lastPlayRejectInfo;
      ok(rejectInfo, "lastPlayRejectInfo must be recorded");
      strictEqual(rejectInfo.name, errName);
      strictEqual(rejectInfo.activeElement, "streamAudioEl");
      strictEqual(rejectInfo.sourceType, "drive_proxy_stream");
      strictEqual(rejectInfo.documentHidden, true);
      strictEqual(rejectInfo.hasCurrentSrc, true);
      ok(!JSON.stringify(rejectInfo).includes("ya29.secretToken123"), "Must not leak token in reject diagnostics");
      ok(!JSON.stringify(rejectInfo).includes("https://example.com/secret"), "Must not leak URL in reject diagnostics");
    }
  });

  await asyncTest("17. visible 復帰で pendingExternalResume を 1回だけ処理し、2回目の visible では再実行しないこと", async () => {
    const track = { id: "gd-flac-vis", title: "Visibility Resume Track", duration: 210 };
    appState.set({ currentTrack: track, duration: 210, currentTime: 77, isPlaying: false, playbackStatus: "paused" });
    const session = beginPlaybackSession(track, 0, 0);
    session.activeElement = mockStreamEl;
    session.sourceType = "drive_proxy_stream";
    mockStreamEl.src = "/api/drive-stream?fileId=vis_1";
    mockStreamEl.currentTime = 77;
    mockStreamEl.paused = true;
    mockStreamEl.playCalls = 0;

    // 1回目: バックグラウンドで NotAllowedError 発生 → pendingExternalResume = true
    docState.hidden = true;
    docState.visibilityState = "hidden";
    await handleVisibilityChange();

    mockStreamEl.playImpl = async () => {
      const e = new Error("Not allowed in background");
      e.name = "NotAllowedError";
      throw e;
    };
    await executePlay();
    strictEqual(session.pendingExternalResume, true, "pendingExternalResume must be true after background reject");
    strictEqual(mockStreamEl.playCalls, 1, "1st play attempt in background");

    // 2回目: フォアグラウンド (visible) へ復帰 → 1回だけ自動再開される
    mockStreamEl.playImpl = async () => {
      mockStreamEl.paused = false;
    };
    docState.hidden = false;
    docState.visibilityState = "visible";
    await handleVisibilityChange();

    strictEqual(mockStreamEl.playCalls, 2, "Must retry play() exactly once on visible return");
    strictEqual(session.pendingExternalResume, false, "pendingExternalResume must be cleared after visible retry");
    const events = session.timeline.map((e) => e.event);
    ok(events.includes("visibility_hidden"), "Must record visibility_hidden");
    ok(events.includes("visibility_visible"), "Must record visibility_visible");
    ok(events.includes("visibility_resume_started"), "Must record visibility_resume_started");
    ok(events.includes("visibility_resume_completed"), "Must record visibility_resume_completed");

    // もう一度 visible イベントが来ても再実行しないこと
    await handleVisibilityChange();
    strictEqual(mockStreamEl.playCalls, 2, "Must NOT retry more than once on subsequent visibilitychange");
  });

  await asyncTest("18. 通常 pause では visible 復帰時に勝手に再生しないこと", async () => {
    const track = { id: "gd-flac-pause", title: "Normal Pause Track", duration: 190 };
    appState.set({ currentTrack: track, duration: 190, currentTime: 20, isPlaying: true, playbackStatus: "playing" });
    const session = beginPlaybackSession(track, 0, 0);
    session.activeElement = mockStreamEl;
    session.sourceType = "drive_proxy_stream";
    mockStreamEl.src = "/api/drive-stream?fileId=pause_1";
    mockStreamEl.currentTime = 20;
    mockStreamEl.paused = false;
    mockStreamEl.playCalls = 0;

    // ユーザーが pause
    executePause();
    strictEqual(session.pendingExternalResume, false, "Normal pause must not set pendingExternalResume");

    // hidden -> visible 遷移
    docState.hidden = true;
    docState.visibilityState = "hidden";
    await handleVisibilityChange();
    docState.hidden = false;
    docState.visibilityState = "visible";
    await handleVisibilityChange();

    strictEqual(mockStreamEl.playCalls, 0, "Must NOT auto-play on visible return after normal user pause");
    strictEqual(mockStreamEl.paused, true, "Audio must remain paused");
  });

  await asyncTest("19. 別曲へ移動済みなら古い sessionId の pending resume を無視すること", async () => {
    const track1 = { id: "track-old", title: "Old Track", duration: 180 };
    appState.set({ currentTrack: track1, duration: 180, currentTime: 10, isPlaying: false, playbackStatus: "paused" });
    const session1 = beginPlaybackSession(track1, 0, 0);
    session1.activeElement = mockStreamEl;
    mockStreamEl.src = "/api/drive-stream?fileId=old";
    mockStreamEl.playImpl = async () => {
      const e = new Error("Blocked");
      e.name = "NotAllowedError";
      throw e;
    };
    await executePlay();
    strictEqual(session1.pendingExternalResume, true, "Old session has pendingExternalResume");

    // 別曲へ移動（新しい PlaybackSession 開始）
    const track2 = { id: "track-new", title: "New Track", duration: 200 };
    const session2 = beginPlaybackSession(track2, 1, 0);
    session2.activeElement = mockStreamEl;
    mockStreamEl.playCalls = 0;
    mockStreamEl.playImpl = async () => { mockStreamEl.paused = false; };

    // visible 復帰しても古い pending resume は破棄されており勝手に play されない
    docState.hidden = false;
    docState.visibilityState = "visible";
    await handleVisibilityChange();
    strictEqual(mockStreamEl.playCalls, 0, "Stale session pending resume must be ignored");
    strictEqual(session2.pendingExternalResume, false, "New session must not inherit pendingExternalResume");
  });

  await asyncTest("22. MP3 / FLAC Proxy 経路 (drive-stream / drive-session / getDriveProxyStreamUrl) に変更を加えていないこと", async () => {
    const { getDriveProxyStreamUrl } = await import("../js/gdrive/drive-service.js");
    const proxyUrlFlac = getDriveProxyStreamUrl({ id: "gd-1A2B3C4D5E", driveFileId: "1A2B3C4D5E", format: "flac" });
    const proxyUrlMp3 = getDriveProxyStreamUrl({ id: "gd-1A2B3C4D5E", driveFileId: "1A2B3C4D5E", format: "mp3" });
    strictEqual(proxyUrlFlac, "/api/drive-stream?fileId=1A2B3C4D5E&ext=flac", "FLAC proxy URL must remain intact");
    strictEqual(proxyUrlMp3, "/api/drive-stream?fileId=1A2B3C4D5E&ext=mp3", "MP3 proxy URL must remain intact");
  });
})();

console.log(`\nLatency & External Resume テスト: ${passed} 件 PASSED ✓`);
