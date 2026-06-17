/**
 * Service Worker の PRECACHE_URLS が js/ 配下の全モジュールを網羅しているかを検証する。
 *
 * 背景: lyrics.js が parse-* から静的 import されているのに PRECACHE_URLS から漏れており、
 * オフライン初回起動で metadata/index.js の解決が失敗し、再生/ライブラリ画面ごと起動
 * 不能になる high 重大度バグがあった。ビルド工程(バンドラ)が無く precache リストは手書き
 * のため、ここで「全 js モジュールが precache 済」を自動検証して同種の漏れの再発を防ぐ。
 *
 * 実行はプロジェクトルートから: node tests/test-precache.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// PRECACHE_URLS から ./js/....js の相対パスを抽出
const sw = readFileSync("sw.js", "utf8");
const precached = new Set();
for (const m of sw.matchAll(/"(\.\/js\/[^"]+\.js)"/g)) {
  precached.add(m[1].replace(/^\.\//, ""));
}

// js/ 配下の全 .js を再帰列挙(パス区切りは / に正規化)
function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const allJs = walk("js");
const missing = allJs.filter((f) => !precached.has(f));

let ok = true;
console.log("=== SW PRECACHE_URLS の網羅性 ===");
console.log(`  js モジュール ${allJs.length} 件 / PRECACHE 済(js) ${precached.size} 件`);
if (missing.length > 0) {
  ok = false;
  console.log(`  ✗ precache から漏れている js: ${missing.join(", ")}`);
  console.log("    → sw.js の PRECACHE_URLS に追加し CACHE_VERSION を上げてください");
} else {
  console.log("  ✓ js/ 配下の全モジュールが PRECACHE_URLS に含まれている");
}

console.log("============================================================");
console.log(ok ? "全テスト成功 ✓" : "テスト失敗 ✗");
process.exit(ok ? 0 : 1);
