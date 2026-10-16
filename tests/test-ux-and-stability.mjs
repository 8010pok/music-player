/**
 * tests/test-ux-and-stability.mjs
 *
 * 4つの安定性修正 ＆ 5つのUX機能改善（＋アーティストアルバム古い順ソート）の検証テスト
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareAlbumTracks, groupTracksIntoAlbums, sortAlbums } from "../js/metadata/album-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("1. アルバム内トラック並び順のディスク番号 (Disc Number) & トラック番号対応", () => {
  const tracks = [
    { id: "t1", title: "Disc 2 Track 1", discNo: 2, trackNo: 1 },
    { id: "t2", title: "Disc 1 Track 2", discNumber: 1, trackNumber: 2 },
    { id: "t3", title: "Disc 1 Track 1", discNumber: 1, trackNumber: 1 },
    { id: "t4", title: "Disc 2 Track 2", discNo: 2, trackNo: 2 },
    { id: "t5", title: "Bonus Track", discNo: null, trackNo: null },
  ];

  const sorted = [...tracks].sort(compareAlbumTracks);

  assert.equal(sorted[0].id, "t3", "Disc 1 Track 1 が先頭");
  assert.equal(sorted[1].id, "t2", "Disc 1 Track 2 が2番目");
  assert.equal(sorted[2].id, "t5", "Disc 1 のトラック番号なし（未指定disc=1）が3番目");
  assert.equal(sorted[3].id, "t1", "Disc 2 Track 1 が4番目");
  assert.equal(sorted[4].id, "t4", "Disc 2 Track 2 が5番目");
});

test("2. groupTracksIntoAlbums での複数ディスク枚数 (discCount) 集計", () => {
  const tracks = [
    { id: "1", album: "The Wall", artist: "Pink Floyd", discNumber: 1, trackNumber: 1 },
    { id: "2", album: "The Wall", artist: "Pink Floyd", discNumber: 2, trackNumber: 1 },
  ];

  const albums = groupTracksIntoAlbums(tracks);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].discCount, 2, "2枚組アルバムの discCount が 2 になる");
});

test("3. アーティスト詳細画面のアルバムデフォルト表示が「古い順 (year-asc)」であることの検証", () => {
  const viewArtistCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-artist.js"), "utf-8");

  // デフォルトの select option に year-asc selected があること
  assert.match(viewArtistCode, /<option value="year-asc"\s+selected>\s*リリース順\s*\(古い順\)\s*<\/option>/, "select の selected が year-asc");
  // 初期ソート関数呼び出しで year-asc が指定されていること
  assert.match(viewArtistCode, /sortAlbums\(art\.albums,\s*["']year-asc["']\)/, "sortAlbums 初期呼び出しが year-asc");

  // sortAlbums 自体のソート結果確認
  const albums = [
    { title: "Album 2020", year: 2020 },
    { title: "Album 1995", year: 1995 },
    { title: "Album 2005", year: 2005 },
  ];
  const sorted = sortAlbums(albums, "year-asc");
  assert.equal(sorted[0].year, 1995);
  assert.equal(sorted[1].year, 2005);
  assert.equal(sorted[2].year, 2020);
});

test("4. prewarmTracks のキャッシュ済み制限 & 未キャッシュDrive曲のバックグラウンド通信スキップの検証", () => {
  const audioEngineCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");

  // prewarmTrack に onlyIfCached オプション対応があること
  assert.match(audioEngineCode, /function prewarmTrack\(trackId,\s*\{[^}]*onlyIfCached/, "prewarmTrack に onlyIfCached パラメータが存在");
  // hasCachedBlob チェックによる未キャッシュスキップが存在すること
  assert.match(audioEngineCode, /hasCachedBlob\(trackId\)/, "hasCachedBlob で未キャッシュ判定");
  // prewarmTracks で上限5曲 & onlyIfCached: true が渡されていること
  assert.match(audioEngineCode, /trackIds\.slice\(0,\s*max\)/, "prewarmTracks が最大5曲に制限");
  assert.match(audioEngineCode, /onlyIfCached:\s*true/, "prewarmTracks が onlyIfCached: true を指定");
});

test("5. アプリ再起動時のセッション復元 (saveSessionState / restoreSessionState) の検証", () => {
  const audioEngineCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");

  // saveSessionState の実装確認
  assert.match(audioEngineCode, /function saveSessionState\(\)/, "saveSessionState 関数が存在");
  assert.match(audioEngineCode, /currentTime:\s*Math\.floor\(audioEl\?\.currentTime/, "再生秒数を保存");
  assert.match(audioEngineCode, /origQueueIds:/, "オリジナルキューIDを保存");
  assert.match(audioEngineCode, /SESSION_STORAGE_KEY\s*=\s*["']music_player_session["']/, "永続化キー music_player_session が定義");

  // restoreSessionState の実装確認
  assert.match(audioEngineCode, /export async function restoreSessionState\(\)/, "restoreSessionState がエクスポートされている");
  assert.match(audioEngineCode, /loadAndPlay\(curTrack,\s*\{[^}]*startTime:/, "togglePlay 時に復元された currentTime から再開可能");
});

test("6. 前の曲へ (playPrev) の 3秒ルールの統一の検証", () => {
  const audioEngineCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");

  // 3秒以上の場合は先頭シーク
  assert.match(audioEngineCode, /curTime\s*>=\s*3/, "3秒以上の判定が存在");
  assert.match(audioEngineCode, /audioEl\.currentTime\s*=\s*0/, "3秒以上の場合は曲頭シーク");
});

test("7. キュー操作 (playNextTrack, addToQueueEnd, removeFromQueue) の検証", () => {
  const audioEngineCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");

  assert.match(audioEngineCode, /export\s+(?:async\s+)?function playNextTrack\(track\)/, "playNextTrack (割り込み) がエクスポートされている");
  assert.match(audioEngineCode, /export\s+(?:async\s+)?function addToQueueEnd\(track\)/, "addToQueueEnd (末尾追加) がエクスポートされている");
  assert.match(audioEngineCode, /export\s+(?:async\s+)?function removeFromQueue\(index\)/, "removeFromQueue がエクスポートされている");
  assert.match(audioEngineCode, /export\s+(?:async\s+)?function jumpToQueueIndex\(index\)/, "jumpToQueueIndex がエクスポートされている");
});

test("8. スリープタイマー (setSleepTimer, getSleepTimerState, end-of-track 停止) の検証", () => {
  const audioEngineCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf-8");

  assert.match(audioEngineCode, /export function setSleepTimer\(mode\)/, "setSleepTimer がエクスポートされている");
  assert.match(audioEngineCode, /export function getSleepTimerState\(\)/, "getSleepTimerState がエクスポートされている");
  assert.match(audioEngineCode, /sleepTimerMode\s*===\s*["']end-of-track["']/, "advanceFromEnded で曲終わり停止判定が存在");
});

test("9. UIコンポーネント (Up Nextドロワー, スリープタイマーボタン, 一括保存, 一括編集) の配置検証", () => {
  const viewPlayerCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf-8");
  const viewAlbumCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-album.js"), "utf-8");
  const viewsCssCode = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf-8");

  // フルプレイヤー: スリープタイマー・キューボタン・ドロワー
  assert.match(viewPlayerCode, /id="btn-sleep-timer"/, "view-player にスリープタイマーボタン配置");
  assert.match(viewPlayerCode, /id="btn-queue-toggle"/, "view-player にキュー切り替えボタン配置");
  assert.match(viewPlayerCode, /id="player-queue-drawer"/, "view-player に再生待ちキュードロワー配置");
  assert.match(viewPlayerCode, /sleepTimerBtn:/, "collectRefs に sleepTimerBtn が存在");
  assert.match(viewPlayerCode, /queueDrawer:/, "collectRefs に queueDrawer が存在");

  // アルバム画面: 一括オフライン保存ボタン・一括編集ボタン
  assert.match(viewAlbumCode, /id="btn-album-cache-all"/, "view-album に一括保存ボタン配置");
  assert.match(viewAlbumCode, /id="btn-album-edit"/, "view-album に一括編集ボタン配置");

  // CSS: ドロワー、スピナー、タイマーバッジ
  assert.match(viewsCssCode, /\.player-queue-drawer/, "CSSに .player-queue-drawer が存在");
  assert.match(viewsCssCode, /\.track-spinner/, "CSSに .track-spinner が存在");
  assert.match(viewsCssCode, /\.sleep-timer-badge/, "CSSに .sleep-timer-badge が存在");
});
