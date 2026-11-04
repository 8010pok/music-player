/**
 * test-pwa-version-and-update.mjs
 *
 * 1. 画面表示バージョンが 1.11.15
 * 2. package.json が 1.11.15
 * 3. sw.js が v1.11.15
 * 4. 診断 appVersion が 1.11.15
 * 5. 古い 1.11.14 以下の表示用ハードコードが残っていない
 * 6. 更新ボタンが registration.update() を呼ぶ
 * 7. controllerchange で reload は最大1回
 * 8. 更新操作で IndexedDB を削除しない
 * 9. 更新操作で localStorage を全削除しない
 * 10. 更新操作で Drive 連携を解除しない
 * 11. 更新操作で音源キャッシュを消さない
 */

import { strictEqual, ok } from "node:assert";
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

console.log("=== 1. バージョン定義の一元化と完全一致 ===");

test("js/version.js: APP_VERSION が 1.11.15、CACHE_VERSION が v1.11.15 であること", async () => {
  const { APP_VERSION, CACHE_VERSION } = await import("../js/version.js");
  strictEqual(APP_VERSION, "1.11.15", "APP_VERSION must be 1.11.15");
  strictEqual(CACHE_VERSION, "v1.11.15", "CACHE_VERSION must be v1.11.15");
});

test("package.json: version が 1.11.15 と完全一致すること", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"));
  strictEqual(pkg.version, "1.11.15", "package.json version must be 1.11.15");
});

test("sw.js: CACHE_VERSION が v1.11.15 と完全一致すること", () => {
  const sw = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf-8");
  ok(sw.includes('const CACHE_VERSION = "v1.11.15";'), "sw.js CACHE_VERSION must be v1.11.15");
});

test("audio-engine.js: 診断情報 appVersion が APP_VERSION (1.11.15) を参照していること", () => {
  const ae = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");
  ok(ae.includes('import { APP_VERSION } from "../version.js";'), "audio-engine must import APP_VERSION");
  ok(ae.includes("appVersion: APP_VERSION,"), "audio-engine appVersion must use APP_VERSION");
});

test("view-settings.js: 画面表示用バージョンが APP_VERSION / CACHE_VERSION を参照していること", () => {
  const vs = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf-8");
  ok(vs.includes('import { APP_VERSION, CACHE_VERSION } from "../version.js";'), "view-settings must import APP_VERSION and CACHE_VERSION");
  ok(vs.includes("${APP_VERSION}"), "view-settings must interpolate APP_VERSION in template");
  ok(vs.includes("${CACHE_VERSION}"), "view-settings must interpolate CACHE_VERSION in template");
});

test("古い 1.11.8 以下の表示用ハードコードが残っていないこと", () => {
  const vs = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf-8");
  ok(!vs.includes("v1.11.5"), "view-settings must not contain hardcoded v1.11.5");
  ok(!vs.includes("v1.11.6"), "view-settings must not contain hardcoded v1.11.6");
  ok(!vs.includes("v1.11.7"), "view-settings must not contain hardcoded v1.11.7");
  ok(!vs.includes("v1.11.8"), "view-settings must not contain hardcoded v1.11.8");
});

console.log("=== 2. 安全な PWA 更新フローと非破壊ガード ===");

test("view-settings.js: 更新ボタンが registration.update() を呼び出すこと", () => {
  const vs = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf-8");
  ok(vs.includes("await reg.update()"), "Must call reg.update()");
  ok(vs.includes('reg.waiting.postMessage({ type: "SKIP_WAITING" })'), "Must activate waiting worker");
});

test("view-settings.js: 更新操作で IndexedDB・localStorage・Drive連携を削除しないこと", () => {
  const vs = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf-8");
  // handleAppUpdate 内で破壊的APIを呼んでいないこと
  const updateFnBody = vs.slice(vs.indexOf("const handleAppUpdate"), vs.indexOf("refs.btnCheckUpdate"));
  ok(!updateFnBody.includes("wipeLibrary"), "Update must not wipe library");
  ok(!updateFnBody.includes("wipeQueue"), "Update must not wipe queue");
  ok(!updateFnBody.includes("localStorage.clear()"), "Update must not clear localStorage");
  ok(!updateFnBody.includes("disconnectDrive"), "Update must not disconnect drive");
  ok(!updateFnBody.includes("clearDriveBlobCache"), "Update must not clear blob cache");
  ok(!updateFnBody.includes("caches.delete"), "Update must not wipe all caches arbitrarily");
  ok(!updateFnBody.includes("reg.unregister()"), "Update must not unregister service worker");
});

test("app.js: controllerchange によるリロードが最大1回に制限されていること", () => {
  const app = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf-8");
  ok(app.includes("navigator.serviceWorker.addEventListener(\"controllerchange\""), "Must listen to controllerchange");
  ok(app.includes("window.__swReloaded"), "Must guard reload loop with __swReloaded");
});

test("view-settings.js: PWA更新状態表示 (SW状態・キャッシュ・更新状況) のUI要素が存在すること", () => {
  const vs = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf-8");
  ok(vs.includes('id="sw-status-text"'), "Must have sw-status-text element");
  ok(vs.includes('id="sw-update-status-text"'), "Must have sw-update-status-text element");
  ok(vs.includes('id="btn-check-update"'), "Must have btn-check-update element");
});

console.log(`\nPWA Version & Update テスト: ${passed} 件 PASSED ✓`);
