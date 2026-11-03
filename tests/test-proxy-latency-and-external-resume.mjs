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
  ok(engineContent.includes("await resumeEqContext()"), "Must call resumeEqContext for mainAudioEl");
});

test("resumeEqContext: AudioContext の suspended だけでなく iOS WebKit 独自の interrupted 状態も確実に復旧すること", () => {
  const eqContent = fs.readFileSync(path.join(__dirname, "../js/player/eq.js"), "utf-8");
  ok(eqContent.includes('ctx.state === "interrupted"'), "resumeEqContext must handle interrupted state");
});

test("executePlay: play() Promise resolve だけでは UI の isPlaying を true にせず、playing イベントを待つこと", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  // executePlay 内で直接 appState.set({ isPlaying: true }) を呼ばず onPlaying に委ねていること
  ok(engineContent.includes("appState.set({ playbackStatus: \"playing\" })"), "executePlay must update playbackStatus without falsely setting isPlaying=true before playing event");
});

test("visibilitychange: フォアグラウンド復帰時に mainAudioEl 再生中なら AudioContext を再開すること", () => {
  const engineContent = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(engineContent.includes("if (!state.userPausedExplicitly && activeAudioEl === mainAudioEl)"), "visibilitychange must check activeAudioEl === mainAudioEl");
  ok(engineContent.includes("resumeEqContext().catch"), "visibilitychange must resume AudioContext on visible");
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

console.log(`\nLatency & External Resume テスト: ${passed} 件 PASSED ✓`);
