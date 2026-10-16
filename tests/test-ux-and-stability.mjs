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

test("10. アーティスト画面のキュー操作・スピナー展開 ＆ フルプレイヤーからの詳細遷移の検証", () => {
  const viewArtistCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-artist.js"), "utf-8");
  const viewPlayerCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf-8");

  // アーティスト詳細画面の「次に再生」「キュー追加」「スピナー」
  assert.match(viewArtistCode, /data-action="play-next"/, "view-artist に次に再生ボタン配置");
  assert.match(viewArtistCode, /data-action="add-queue"/, "view-artist にキュー追加ボタン配置");
  assert.match(viewArtistCode, /loadingTrackId/, "view-artist が loadingTrackId を購読");
  assert.match(viewArtistCode, /track-spinner/, "view-artist にローディングスピナー表示が存在");

  // フルプレイヤーからのアーティスト・アルバム詳細画面への遷移
  assert.match(viewPlayerCode, /go\(["']artist["'],\s*\{\s*name\s*\}\)/, "view-player からアーティスト詳細へ遷移");
  assert.match(viewPlayerCode, /go\(["']album["'],\s*\{\s*key\s*\}\)/, "view-player からアルバム詳細へ遷移");
  assert.match(viewPlayerCode, /is-clickable/, "view-player でクリック可能クラスを付与");
});

test("11. 全JSモジュールのimport/export整合性 ＆ コメント外定義の検証", () => {
  const rootDir = path.join(__dirname, "..");
  const audioEngineCode = fs.readFileSync(path.join(rootDir, "js/player/audio-engine.js"), "utf-8");
  const strippedAudioEngine = audioEngineCode.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  assert.match(
    strippedAudioEngine,
    /const\s+SESSION_STORAGE_KEY\s*=\s*["']music_player_session["']/,
    "SESSION_STORAGE_KEY がコメント外で有効に定義されている"
  );

  function walkJs(dir) {
    let list = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) list.push(...walkJs(p));
      else if (entry.name.endsWith(".js")) list.push(p);
    }
    return list;
  }

  const jsFiles = walkJs(path.join(rootDir, "js"));
  for (const file of jsFiles) {
    const code = fs.readFileSync(file, "utf-8");
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
    let m;
    while ((m = importRegex.exec(code)) !== null) {
      const names = m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      const rel = m[2];
      const target = path.resolve(path.dirname(file), rel);
      assert.ok(fs.existsSync(target), `${path.relative(rootDir, file)} の import 先 ${rel} が存在する`);
      const targetCode = fs.readFileSync(target, "utf-8");
      for (const name of names) {
        const expRegex = new RegExp(
          `export\\s+(?:async\\s+)?(?:function(?:\\s*\\*)?|const|let|var|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`
        );
        assert.match(
          targetCode,
          expRegex,
          `${path.relative(rootDir, file)} が import している "${name}" が ${rel} から export されている`
        );
      }
    }
  }
});

test("12. ワンクリック再生 (primeAudioElement / SILENT_AUDIO_URI) の検証", () => {
  const rootDir = path.join(__dirname, "..");
  const audioEngineCode = fs.readFileSync(path.join(rootDir, "js/player/audio-engine.js"), "utf-8");

  assert.match(
    audioEngineCode,
    /const\s+SILENT_AUDIO_URI\s*=/,
    "SILENT_AUDIO_URI が定義されている"
  );
  assert.match(
    audioEngineCode,
    /data:audio\/wav;base64,/,
    "data:audio/wav;base64 の無音WAVストリームが使用されている"
  );
  assert.match(
    audioEngineCode,
    /function\s+primeAudioElement\s*\(\)\s*\{/,
    "primeAudioElement 関数が定義されている"
  );
  assert.match(
    audioEngineCode,
    /setQueueAndPlay[\s\S]*?primeAudioElement\(\)/,
    "setQueueAndPlay 内で primeAudioElement() が呼ばれている"
  );
  assert.match(
    audioEngineCode,
    /jumpToQueueIndex[\s\S]*?primeAudioElement\(\)/,
    "jumpToQueueIndex 内で primeAudioElement() が呼ばれている"
  );
  assert.match(
    audioEngineCode,
    /function\s+onEnded\s*\(\)\s*\{[\s\S]*?data:audio\/wav/,
    "onEnded 内で silent audio の終了イベントがガードされている"
  );
});

test("13. 鮮明な歌詞スタイル ＆ スマホライブラリ追加ボタンのはみ出し防止の検証", () => {
  const rootDir = path.join(__dirname, "..");
  const viewsCss = fs.readFileSync(path.join(rootDir, "css/views.css"), "utf-8");
  const playerJs = fs.readFileSync(path.join(rootDir, "js/ui/view-player.js"), "utf-8");
  const libraryJs = fs.readFileSync(path.join(rootDir, "js/ui/view-library.js"), "utf-8");

  // 歌詞のブラー除去と鮮明化
  assert.doesNotMatch(
    viewsCss,
    /\.lyrics-line\s*\{[^}]*filter:\s*blur\(/,
    "lyrics-line から blur フィルタが完全に除去されている"
  );
  assert.match(
    viewsCss,
    /\.btn-lyrics-dismiss\b/,
    "歌詞画面にジャケットに戻る dismiss ボタンのスタイルが定義されている"
  );
  assert.match(
    playerJs,
    /id=["']btn-lyrics-dismiss["']/,
    "view-player.js の HTML 内に btn-lyrics-dismiss ボタンが配置されている"
  );

  // ライブラリ追加ボタンのレスポンシブ配置（はみ出し防止）
  assert.match(
    viewsCss,
    /\.library-add-buttons\s*\{[\s\S]*?grid-template-columns:/,
    "library-add-buttons がグリッドレイアウトで定義されている"
  );
  assert.match(
    viewsCss,
    /@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?#btn-add-gdrive[\s\S]*?grid-column:\s*1\s*\/\s*-1/,
    "480px 以下のスマホ画面で Google Drive ボタンが全幅、他2ボタンが2列に収まるレスポンシブ定義がある"
  );
  assert.doesNotMatch(
    libraryJs,
    /id=["']btn-add-combined["'][^>]*min-width:\s*120px/,
    "view-library.js 内の 端末から追加ボタンのハードコード min-width が除去されている"
  );
});

test("14. iOS ワンタップ即時再生保証 ＆ ミニプレイヤーへのメタデータ即時反映の検証", () => {
  const rootDir = path.join(__dirname, "..");
  const audioEngineCode = fs.readFileSync(path.join(rootDir, "js/player/audio-engine.js"), "utf-8");
  const miniPlayerCode = fs.readFileSync(path.join(rootDir, "js/ui/mini-player.js"), "utf-8");
  const libraryDbCode = fs.readFileSync(path.join(rootDir, "js/store/library-db.js"), "utf-8");
  const viewLibraryCode = fs.readFileSync(path.join(rootDir, "js/ui/view-library.js"), "utf-8");

  // 1) loadAndPlay で await getBlob の前に同期的に currentTrack / MediaSession が設定されること
  const lapMatch = audioEngineCode.match(/async function loadAndPlay\([\s\S]*?\n\}/);
  assert.ok(lapMatch, "loadAndPlay が存在する");
  const lapBody = lapMatch[0];
  const setTrackIdx = lapBody.indexOf("currentTrack: track");
  const awaitGetBlobIdx = lapBody.indexOf("await getBlob(");
  assert.ok(setTrackIdx > 0 && setTrackIdx < awaitGetBlobIdx, "await getBlob の前に currentTrack が同期設定される");

  // 2) ミニプレイヤーがアルバムアートワークのキューフォールバックと track-updated イベントを購読していること
  assert.match(miniPlayerCode, /resolveTrackArtworkFromQueue/, "mini-player が resolveTrackArtworkFromQueue を使用している");
  assert.match(miniPlayerCode, /music-player:track-updated/, "mini-player が music-player:track-updated を購読している");

  // 3) library-db がバックグラウンドで未解析メタデータ・アートワークを自動補完しイベント通知すること
  assert.match(libraryDbCode, /ensureTrackMetadataInBackground/, "library-db に ensureTrackMetadataInBackground が実装されている");
  assert.match(libraryDbCode, /music-player:track-updated/, "library-db が music-player:track-updated を発火する");

  // 4) view-library が currentTrack 変化時に innerHTML 全再構築ではなく updatePlayingHighlight を使うこと
  assert.match(viewLibraryCode, /function updatePlayingHighlight\(refs\)/, "view-library に軽量な updatePlayingHighlight が実装されている");
});

test("15. アルバムページの曲タイトル視認性向上 ＆ 3点リーダーメニュー（次に再生、プレイリストに追加、メタデータ編集）の検証", () => {
  const rootDir = path.join(__dirname, "..");
  const viewAlbumCode = fs.readFileSync(path.join(rootDir, "js/ui/view-album.js"), "utf-8");
  const viewsCssCode = fs.readFileSync(path.join(rootDir, "css/views.css"), "utf-8");

  // 1) アルバムトラック行に 3点リーダーボタン (data-act="more") が配置され、不要な横並びボタンが撤廃されていること
  assert.match(viewAlbumCode, /<button class="icon-btn album-track-more-btn" data-act="more"/, "album-track-more-btn が存在する");
  assert.ok(!viewAlbumCode.includes('class="icon-btn track-action-btn" data-act="play-next"'), "直接配置されていた次に再生ボタンが撤廃されている");

  // 2) 3点リーダーから次に再生、キュー末尾追加、プレイリスト追加、メタデータ編集、削除を選べること
  assert.match(viewAlbumCode, /function openTrackActionsModal/, "openTrackActionsModal が実装されている");
  assert.match(viewAlbumCode, /label:\s*["']⏭ 次に再生["']/, "メニューに「次に再生」が含まれる");
  assert.match(viewAlbumCode, /label:\s*["']📑 プレイリストに追加["']/, "メニューに「プレイリストに追加」が含まれる");
  assert.match(viewAlbumCode, /label:\s*["']✏️ メタデータ（曲情報）を編集["']/, "メニューに「メタデータ（曲情報）を編集」が含まれる");

  // 3) プレイリスト追加モーダル (openAddToPlaylistModal) で新規作成＆既存選択ができること
  assert.match(viewAlbumCode, /async function openAddToPlaylistModal/, "openAddToPlaylistModal が実装されている");
  assert.match(viewAlbumCode, /addTracksToPlaylist/, "addTracksToPlaylist が呼ばれる");

  // 4) CSS でアルバム曲タイトルのフォントサイズが 15px かつ太字で視認性向上されていること
  assert.match(viewsCssCode, /\.album-track-row \.track-title\s*\{[\s\S]*?font-size:\s*15px;[\s\S]*?font-weight:\s*600;/, "アルバム曲タイトルの視認性が向上している");
});

test("16. 再生待ちキュー（Up Next）の小型化・コンパクトスタイルの検証", () => {
  const rootDir = path.join(__dirname, "..");
  const viewsCssCode = fs.readFileSync(path.join(rootDir, "css/views.css"), "utf-8");

  // 1) player-queue-drawer の高さが 48% / max-height 330px 程度に小型化されていること (以前は 70% / 480px)
  assert.match(viewsCssCode, /\.player-queue-drawer\s*\{[\s\S]*?height:\s*48%;[\s\S]*?max-height:\s*330px;/, "再生待ちキューが小型化されている");
  // 2) アイテムとヘッダーのパディング・フォントがスリム化されていること
  assert.match(viewsCssCode, /\.player-queue-item\s*\{[\s\S]*?padding:\s*5px 8px;/, "player-queue-item がスリム化されている");
});

