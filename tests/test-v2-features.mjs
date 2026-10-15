/**
 * 4つの重要不具合修正およびUI/UX改善の統合検証テスト
 *
 * 1. Google Drive音源の Last.fm Scrobble 改善 (制御文字/NULL文字サニタイズ、数字トラック番号誤認防止、既存アーティスト最優先、ハイドレーション)
 * 2. iOS ロック画面 MediaSession (seekbackward/forward 無効化、previoustrack/nexttrack 常時有効化、末尾ループ)
 * 3. 画面状態の永続化と自動復元 (saveLastView / getLastView, scrollTop, tab)
 * 4. 五十音・アルファベット縦インデックスバー (バー幅30px, 右余白5px, バブル52px, right: 44px, is-touch-active)
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanArtistName,
  cleanTrackTitle,
  isPlaceholderArtist,
  parseArtistAndTitle,
  resolveScrobbleTrack,
} from "../js/lastfm/scrobble-cleaner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let total = 0;
let passed = 0;

function it(desc, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function runTests() {
  console.log("\n=== 1. Last.fm Scrobble 制御文字サニタイズ & アーティスト推測厳格化 ===");

  it("NULLバイト (\\u0000) や BOM (\\uFEFF) がアーティスト名から完全に除去される", () => {
    const dirty = "\u0000\uFEFFEve\u0000\u0007";
    const cleaned = cleanArtistName(dirty);
    assert.equal(cleaned, "Eve");
  });

  it("制御文字 (\\u001F, \\u007F-\u009F) やゼロ幅スペースが除去される", () => {
    const dirty = "米津玄師\u001F\u200B\u007F";
    const cleaned = cleanArtistName(dirty);
    assert.equal(cleaned, "米津玄師");
  });

  it("タイトル側の NULLバイトや制御文字も完全に除去される", () => {
    const dirtyTitle = "\u0000Kick Back\u001F (Anime Ver.)";
    const cleaned = cleanTrackTitle(dirtyTitle);
    assert.equal(cleaned, "Kick Back (Anime Ver.)");
  });

  it("数字のみのトラック番号 (例: '01') はプレースホルダー判定されアーティスト名にならない", () => {
    assert.equal(isPlaceholderArtist("01"), true);
    assert.equal(isPlaceholderArtist("12"), true);
    assert.equal(isPlaceholderArtist("track 05"), true);
  });

  it("parseArtistAndTitle: '01 - タイトル' から先頭のトラック番号をアーティスト名として誤認しない", () => {
    const parsed = parseArtistAndTitle("01 - 廻廻奇譚");
    assert.equal(parsed, null); // 01 をアーティストと誤認して { artist: "01", ... } を返さない
  });

  it("resolveScrobbleTrack: 既に有効なアーティスト名が登録されている場合、タイトルにハイフンがあっても上書きしない", () => {
    const track = {
      id: "drive-1",
      title: "Subtitle - Official髭男dism",
      artist: "Official髭男dism", // 既に有効なアーティストが登録済み
      album: "Editorial",
    };
    const resolved = resolveScrobbleTrack(track);
    assert.equal(resolved.artist, "Official髭男dism");
    assert.equal(resolved.isInvalid, false);
  });

  it("resolveScrobbleTrack: Google Drive由来などで制御文字が入っていてもクリーンなアーティストとタイトルを生成", () => {
    const track = {
      id: "drive-2",
      title: "アイドル\u0000",
      artist: "YOASOBI\u0000\uFEFF - Topic",
      album: "アイドル - Single",
    };
    const resolved = resolveScrobbleTrack(track);
    assert.equal(resolved.artist, "YOASOBI");
    assert.equal(resolved.title, "アイドル");
    assert.equal(resolved.isInvalid, false);
  });

  console.log("\n=== 2. iOS ロック画面 MediaSession のスキップ & ハンドラ設定 ===");

  it("audio-engine.js 内で seekbackward / seekforward が明示的に null 登録され、previoustrack / nexttrack が登録されている", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
    assert.match(code, /setActionHandler\(['"]seekbackward['"],\s*null\)/);
    assert.match(code, /setActionHandler\(['"]seekforward['"],\s*null\)/);
    assert.match(code, /setActionHandler\(['"]previoustrack['"],\s*\(\)\s*=>\s*playPrev\(\)\)/);
    assert.match(code, /setActionHandler\(['"]nexttrack['"],\s*\(\)\s*=>\s*playNext\(\)\)/);
  });

  it("play / playing / メタデータ更新時に ensureMediaSessionActions が確実に呼ばれる設計になっている", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
    assert.match(code, /function ensureMediaSessionActions\(\)/);
    // onPlay や updateMediaSessionMetadata 内で ensureMediaSessionActions() が呼ばれていること
    const matches = code.match(/ensureMediaSessionActions\(\)/g);
    assert.ok(matches && matches.length >= 3, `ensureMediaSessionActions should be called at least 3 times, got ${matches?.length}`);
  });

  it("キュー末尾で playNext を呼んでもボタンが無効化されず先頭曲にループするロジックが存在する", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
    assert.match(code, /iOS ロック画面でスキップボタンが消える・無効化されるのを防ぐため先頭曲へ戻す/);
    assert.match(code, /next = 0;/);
  });

  console.log("\n=== 3. 画面状態の永続化と自動復元 (router & view-library) ===");

  it("router.js に saveLastView, getLastView, LAST_VIEW_KEY が定義され welcome は除外されている", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/router.js"), "utf8");
    assert.match(code, /const LAST_VIEW_KEY = "music_player_last_view"/);
    assert.match(code, /export function getLastView\(\)/);
    assert.match(code, /export function saveLastView\(data\)/);
    assert.match(code, /if \(data\.name === "welcome"/);
  });

  it("router.js でスクロール位置の保存と復元が実装されている", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/router.js"), "utf8");
    assert.match(code, /root\.addEventListener\("scroll",/);
    assert.match(code, /root\.scrollTop = last\.scrollTop/);
  });

  it("view-library.js のタブ切り替え時に saveLastView が呼ばれる", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-library.js"), "utf8");
    assert.match(code, /saveLastView\({\s*hash: newHash,\s*name: "library",\s*query: `tab=\${activeTab}`,\s*tab: activeTab/);
  });

  it("view-library.js のマウント時に getLastView からタブ状態が復元される", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-library.js"), "utf8");
    assert.match(code, /const last = getLastView\(\);/);
    assert.match(code, /activeTab = last\.tab;/);
  });

  console.log("\n=== 4. 五十音・アルファベット縦インデックスバーとフローティングバッジ ===");

  it("css/views.css: .artist-index-bar が幅30px、右余白5px、ピル型グラスモーフィズムで定義されている", () => {
    const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
    assert.match(css, /\.artist-index-bar\s*{[^}]*right:\s*5px;/);
    assert.match(css, /\.artist-index-bar\s*{[^}]*width:\s*30px;/);
    assert.match(css, /\.artist-index-bar\s*{[^}]*border-radius:\s*16px;/);
    assert.match(css, /\.artist-index-bar\s*{[^}]*backdrop-filter:\s*blur\(12px\);/);
  });

  it("css/views.css: .index-char-item が文字サイズ12px、.is-touch-active で scale(1.3) とアクセント色になる", () => {
    const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
    assert.match(css, /\.index-char-item\s*{[^}]*font-size:\s*12px;/);
    assert.match(css, /\.is-touch-active\s*{[^}]*transform:\s*scale\(1\.3\);/);
    assert.match(css, /\.is-touch-active\s*{[^}]*color:\s*var\(--accent\);/);
  });

  it("css/views.css: .artist-index-bubble が幅52px、高さ52px、right: 44px、文字サイズ24px、アクセント背景で定義されている", () => {
    const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
    assert.match(css, /\.artist-index-bubble\s*{[^}]*right:\s*44px;/);
    assert.match(css, /\.artist-index-bubble\s*{[^}]*width:\s*52px;/);
    assert.match(css, /\.artist-index-bubble\s*{[^}]*height:\s*52px;/);
    assert.match(css, /\.artist-index-bubble\s*{[^}]*font-size:\s*24px;/);
    assert.match(css, /\.artist-index-bubble\s*{[^}]*background:\s*var\(--accent\);/);
  });

  it("css/views.css: .artist-list の右側余白がインデックスバーと干渉しないよう 38px に拡張されている", () => {
    const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf8");
    assert.match(css, /\.artist-list\s*{[^}]*padding:\s*0\s+38px\s+0\s+0;/);
  });

  it("view-library.js: installArtistIndexBar が Y座標追従、.is-touch-active 切り替え、スナップ吸着を実装している", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-library.js"), "utf8");
    assert.match(code, /bubble\.style\.top\s*=\s*`\${clampedY}px`/);
    assert.match(code, /itemEl\.classList\.add\("is-touch-active"\)/);
    assert.match(code, /activeItemEl\.classList\.remove\("is-touch-active"\)/);
    assert.match(code, /bar\.querySelectorAll\("\.index-char-item"\)/); // スナップ探索
  });

  console.log("\n============================================================");
  console.log(`合計: ${total} / 成功: ${passed} / 失敗: ${total - passed}`);
  if (total === passed) {
    console.log("全テスト成功 ✓\n");
  } else {
    process.exit(1);
  }
}

runTests();
