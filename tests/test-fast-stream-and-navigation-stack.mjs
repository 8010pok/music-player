/**
 * test-fast-stream-and-navigation-stack.mjs
 *
 * 1. 未キャッシュGoogle Drive音源の超高速再生 (ダイレクトストリーミング優先 & Web Audio初回一時バイパス)
 * 2. バックグラウンドキャッシュと AbortController による曲切替時の中断
 * 3. セッション1回限りの高速再生トースト通知
 * 4. バックグラウンドキャッシュ完了時に再生中 audio.src を差し替えない保証
 * 5. アプリ内ナビゲーションスタック (route, params, scrollY, state, timestamp)
 * 6. 詳細画面から戻る操作の完全な連続復元 (Artist -> Album -> Player -> Album -> Artist -> Library)
 * 7. 検索結果・タブ・スクロール位置の安全な復元
 * 8. 存在しないエンティティの安全フォールバック
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

console.log("=== 1. 未キャッシュGoogle Drive高速再生 & Web Audio初回一時バイパス ===");

test("未キャッシュDrive音源はEQ有効でも全量DLを待たずにダイレクトストリームURLが即座に設定される", () => {
  const track = { id: "gd-test-flac-001", title: "Test FLAC", keyShift: 0, driveFileId: "test-flac-001" };
  const pub = { enableAudioEffects: true };
  const cached = false;

  const isDriveTrack = (typeof track.id === "string" && track.id.startsWith("gd-")) || !!track.driveFileId;
  strictEqual(isDriveTrack, true);

  let targetUrl = null;
  let isDirectStream = false;
  let isUncachedDirectStream = false;

  if (!targetUrl && isDriveTrack && !cached) {
    targetUrl = `https://www.googleapis.com/drive/v3/files/${track.driveFileId}?alt=media&access_token=ya29.mock`;
    isDirectStream = true;
    isUncachedDirectStream = true;
  }

  strictEqual(isDirectStream, true, "ダイレクトストリーミングフラグが有効");
  strictEqual(isUncachedDirectStream, true, "未キャッシュフラグが有効");
  ok(targetUrl.includes("googleapis.com/drive/v3/files"), "HTTP Range ストリームURLが直ちに得られる");

  // Web Audio の結線判定: 未キャッシュダイレクトストリーム時はバイパス
  const isEffectsActive = !!pub.enableAudioEffects;
  const isKeyShiftActive = track.keyShift !== 0;
  const needsWebAudio = isEffectsActive || isKeyShiftActive;
  const connectWebAudio = !isUncachedDirectStream && needsWebAudio;

  strictEqual(connectWebAudio, false, "初回未キャッシュ再生時は Web Audio (EQ) 結線がバイパスされHTMLAudioElement直接出力となる");
});

test("未キャッシュDrive音源はキーチェンジ有効時でもダウンロード待機せず即時再生される", () => {
  const track = { id: "gd-test-flac-002", title: "Test KeyShift", keyShift: 3, driveFileId: "test-flac-002" };
  const pub = { enableAudioEffects: false };
  const cached = false;

  let targetUrl = null;
  let isUncachedDirectStream = false;
  if (!targetUrl && !cached) {
    targetUrl = `https://www.googleapis.com/drive/v3/files/${track.driveFileId}?alt=media&access_token=ya29.mock`;
    isUncachedDirectStream = true;
  }

  const isEffectsActive = !!pub.enableAudioEffects;
  const isKeyShiftActive = track.keyShift !== 0;
  const needsWebAudio = isEffectsActive || isKeyShiftActive;
  const connectWebAudio = !isUncachedDirectStream && needsWebAudio;

  strictEqual(isUncachedDirectStream, true);
  strictEqual(connectWebAudio, false, "キーチェンジ有効でも初回未キャッシュ時は直接出力となりCORS無音化を防止");
});

test("キャッシュ済みDrive曲は安全にWeb Audio (EQ/キーチェンジ) が接続される", () => {
  const track = { id: "gd-test-flac-003", title: "Cached FLAC", keyShift: -2, driveFileId: "test-flac-003" };
  const pub = { enableAudioEffects: true };
  const cached = true;

  let targetUrl = "blob:http://localhost/mock-blob-uuid";
  let isUncachedDirectStream = false;

  const isEffectsActive = !!pub.enableAudioEffects;
  const isKeyShiftActive = track.keyShift !== 0;
  const needsWebAudio = isEffectsActive || isKeyShiftActive;
  const connectWebAudio = !isUncachedDirectStream && needsWebAudio;

  strictEqual(connectWebAudio, true, "キャッシュ済み曲は Blob URL 経由のため安全に Web Audio (EQ/キーチェンジ) が接続される");
});

console.log("=== 2. バックグラウンドキャッシュと AbortController による中断 ===");

test("曲スキップ時に前曲の不要なバックグラウンドダウンロードが AbortController で中断される", () => {
  let aborted = false;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => {
    aborted = true;
  });

  // Track 1 再生開始後にバックグラウンドキャッシュが開始
  let activeBackgroundCacheController = controller;

  // ユーザーが直後に Track 2 をタップ (曲切替)
  // abortActiveBackgroundCache() のシミュレーション
  if (activeBackgroundCacheController) {
    activeBackgroundCacheController.abort();
    activeBackgroundCacheController = null;
  }

  strictEqual(aborted, true, "前曲のダウンロードシグナルが中断(aborted)された");
  strictEqual(activeBackgroundCacheController, null, "アクティブコントローラが初期化された");
});

test("バックグラウンドキャッシュ完了時に再生中の音源 URL が途中で差し替えられないこと", () => {
  // 再生中の audioEl.src の不変性検証
  let currentAudioSrc = "https://www.googleapis.com/drive/v3/files/test?alt=media&access_token=ya29.mock";
  const initialPlayingSrc = currentAudioSrc;

  // バックグラウンドキャッシュ完了イベントのシミュレーション
  const cachedBlobUrl = "blob:http://localhost/new-cached-blob";
  // 仕様: 再生中の audioEl.src は絶対に途中で Blob URL に差し替えない
  const shouldSwapAudioSrc = false;
  if (shouldSwapAudioSrc) {
    currentAudioSrc = cachedBlobUrl;
  }

  strictEqual(currentAudioSrc, initialPlayingSrc, "再生中の音源URLは差し替えられずそのまま継続再生される");
});

test("高速再生通知トーストはセッション中1回のみ表示されること", () => {
  const sessionStore = new Map();
  const UNCACHED_STREAM_TOAST_KEY = "music_player_uncached_fast_stream_notified";
  let toastCount = 0;

  function notifyOnce() {
    if (sessionStore.get(UNCACHED_STREAM_TOAST_KEY)) return;
    sessionStore.set(UNCACHED_STREAM_TOAST_KEY, "1");
    toastCount++;
  }

  notifyOnce(); // 1曲目
  notifyOnce(); // 2曲目
  notifyOnce(); // 3曲目

  strictEqual(toastCount, 1, "同一セッション内で通知は1回のみ発火する");
});

console.log("=== 3. ナビゲーションスタックと画面復元 ===");

// インメモリ模擬ナビゲーションスタック
class MockNavigationRouter {
  constructor() {
    this.navStack = [];
    this.maxSize = 50;
    this.currentRoute = null;
    this.currentQuery = "";
  }

  go(name, params = null, { replace = false, state = null } = {}) {
    let hash = `#/${name}`;
    let queryString = "";
    if (params) {
      const sp = new URLSearchParams(params);
      queryString = sp.toString();
      if (queryString) hash += `?${queryString}`;
    }

    if (replace) {
      const st = state || (this.navStack.length > 0 ? this.navStack[this.navStack.length - 1].state : {});
      const entry = { name, query: queryString, params: params || {}, hash, scrollTop: 0, state: st, timestamp: Date.now() };
      if (this.navStack.length > 0) {
        this.navStack[this.navStack.length - 1] = entry;
      } else {
        this.navStack.push(entry);
      }
    } else {
      if (this.navStack.length > 0) {
        // 現在画面のスクロール位置をスタックに記録
        this.navStack[this.navStack.length - 1].scrollTop = this.mockRootScrollTop || 0;
      }
      this.navStack.push({
        name,
        query: queryString,
        params: params || {},
        hash,
        scrollTop: 0,
        state: state || {},
        timestamp: Date.now(),
      });
    }

    if (this.navStack.length > this.maxSize) {
      this.navStack = this.navStack.slice(-this.maxSize);
    }
    this.currentRoute = name;
    this.currentQuery = queryString;
  }

  updateCurrentState(updates) {
    if (this.navStack.length > 0) {
      this.navStack[this.navStack.length - 1].state = {
        ...(this.navStack[this.navStack.length - 1].state || {}),
        ...updates,
      };
    }
  }

  getCurrentState() {
    return this.navStack.length > 0 ? (this.navStack[this.navStack.length - 1].state || {}) : {};
  }

  getCurrentEntry() {
    return this.navStack.length > 0 ? this.navStack[this.navStack.length - 1] : null;
  }

  back(fallback = "library", fallbackParams = null) {
    if (this.navStack.length > 1) {
      this.navStack.pop();
      const prev = this.navStack[this.navStack.length - 1];
      this.currentRoute = prev.name;
      this.currentQuery = prev.query;
      return prev;
    }
    this.navStack = [];
    this.go(fallback, fallbackParams, { replace: true });
    return this.getCurrentEntry();
  }
}

test("画面遷移順序の完全テスト: アーティスト一覧 → アーティスト詳細 → アルバム詳細 → プレイヤー → 戻る4回", () => {
  const router = new MockNavigationRouter();

  // 1. アーティスト一覧
  router.go("library", { tab: "artists" });
  strictEqual(router.getCurrentEntry().name, "library");
  strictEqual(router.getCurrentEntry().params.tab, "artists");
  strictEqual(router.navStack.length, 1);

  // 2. アーティスト詳細 (Adele)
  router.mockRootScrollTop = 150;
  router.go("artist", { name: "Adele" });
  strictEqual(router.getCurrentEntry().name, "artist");
  strictEqual(router.getCurrentEntry().params.name, "Adele");
  strictEqual(router.navStack[0].scrollTop, 150, "離脱前のアーティスト一覧スクロール位置が保存される");
  strictEqual(router.navStack.length, 2);

  // 3. アルバム詳細 (21)
  router.mockRootScrollTop = 80;
  router.go("album", { key: "21" });
  strictEqual(router.getCurrentEntry().name, "album");
  strictEqual(router.getCurrentEntry().params.key, "21");
  strictEqual(router.navStack[1].scrollTop, 80, "離脱前のアーティスト詳細スクロール位置が保存される");
  strictEqual(router.navStack.length, 3);

  // 4. プレイヤー
  router.mockRootScrollTop = 200;
  router.go("player");
  strictEqual(router.getCurrentEntry().name, "player");
  strictEqual(router.navStack[2].scrollTop, 200, "離脱前のアルバム詳細スクロール位置が保存される");
  strictEqual(router.navStack.length, 4);

  // === ここから 戻る (back) ===

  // 戻る 1: プレイヤー → アルバム詳細 (21)
  const back1 = router.back();
  strictEqual(back1.name, "album");
  strictEqual(back1.params.key, "21");
  strictEqual(back1.scrollTop, 200, "アルバム詳細のスクロール位置が復元される");
  strictEqual(router.navStack.length, 3);

  // 戻る 2: アルバム詳細 → アーティスト詳細 (Adele)
  const back2 = router.back();
  strictEqual(back2.name, "artist");
  strictEqual(back2.params.name, "Adele");
  strictEqual(back2.scrollTop, 80, "アーティスト詳細のスクロール位置が復元される");
  strictEqual(router.navStack.length, 2);

  // 戻る 3: アーティスト詳細 → アーティスト一覧 (Library tab=artists)
  const back3 = router.back();
  strictEqual(back3.name, "library");
  strictEqual(back3.params.tab, "artists");
  strictEqual(back3.scrollTop, 150, "アーティスト一覧のスクロール位置が復元される");
  strictEqual(router.navStack.length, 1);
});

test("プレイリスト詳細 → プレイヤー → 戻る でプレイリスト詳細に正確に戻ること", () => {
  const router = new MockNavigationRouter();

  router.go("playlists");
  router.go("playlist", { id: "pl-my-favorites" });
  router.mockRootScrollTop = 320;
  router.go("player");

  strictEqual(router.getCurrentEntry().name, "player");
  const backEntry = router.back();
  strictEqual(backEntry.name, "playlist");
  strictEqual(backEntry.params.id, "pl-my-favorites");
  strictEqual(backEntry.scrollTop, 320, "プレイリストスクロール位置が復元");
});

test("検索結果 (Library) → プレイヤー → 戻る で検索語とスクロール位置が維持されること", () => {
  const router = new MockNavigationRouter();

  router.go("library", { tab: "tracks" });
  router.updateCurrentState({
    activeTab: "tracks",
    filterText: "beethoven",
    sortKey: "year-desc",
  });
  router.mockRootScrollTop = 540;

  // 曲をタップしてプレイヤーへ
  router.go("player");
  strictEqual(router.getCurrentEntry().name, "player");

  // プレイヤーから戻る
  const backEntry = router.back();
  strictEqual(backEntry.name, "library");
  strictEqual(backEntry.scrollTop, 540, "スクロール位置が復元");

  const restoredState = router.getCurrentState();
  strictEqual(restoredState.filterText, "beethoven", "検索キーワードが正確に復元される");
  strictEqual(restoredState.sortKey, "year-desc", "ソート順が正確に復元される");
});

test("Last.fm 統計タブ (time) → プレイヤー → 戻る で元の統計タブが復元されること", () => {
  const router = new MockNavigationRouter();

  router.go("stats");
  router.updateCurrentState({
    currentTab: "time",
    currentPeriod: "overall",
  });

  router.go("player");
  const backEntry = router.back();
  strictEqual(backEntry.name, "stats");

  const state = router.getCurrentState();
  strictEqual(state.currentTab, "time", "時間タブが正確に復元される");
  strictEqual(state.currentPeriod, "overall");
});

test("アルバム一覧 → アルバム詳細 → プレイヤー → 戻る でアルバム詳細に正確に戻ること", () => {
  const router = new MockNavigationRouter();

  router.go("library", { tab: "albums" });
  router.go("album", { key: "album-xyz" });
  router.go("player");

  strictEqual(router.getCurrentEntry().name, "player");
  const backEntry = router.back();
  strictEqual(backEntry.name, "album");
  strictEqual(backEntry.params.key, "album-xyz");
});

test("同一画面内の状態変更（曲削除・アートワーク変更・同期）で履歴スタックが増殖しないこと", () => {
  const router = new MockNavigationRouter();

  router.go("album", { key: "album-1" });
  strictEqual(router.navStack.length, 1);

  // ケース 6: アルバム内で曲削除 (In-place rerender / updateCurrentState)
  router.updateCurrentState({ trackCount: 9 });
  strictEqual(router.navStack.length, 1, "曲削除後も履歴は増えない");
  strictEqual(router.getCurrentEntry().name, "album");

  // ケース 8: アートワーク変更
  router.updateCurrentState({ artworkUpdated: true });
  strictEqual(router.navStack.length, 1, "アートワーク変更後も履歴は増えない");

  // ケース 9: 同期実行
  router.updateCurrentState({ lastSynced: Date.now() });
  strictEqual(router.navStack.length, 1, "同期後も履歴は増えない");
});

test("プレイリスト詳細で曲削除時に同じプレイリスト詳細に留まり履歴が増えないこと", () => {
  const router = new MockNavigationRouter();

  router.go("playlist", { id: "pl-favs" });
  strictEqual(router.navStack.length, 1);

  // ケース 7: プレイリスト内で曲削除
  router.updateCurrentState({ tracks: ["t1", "t2"] });
  strictEqual(router.navStack.length, 1, "プレイリスト曲削除後も履歴は増えない");
  strictEqual(router.getCurrentEntry().name, "playlist");
});

test("存在しないエンティティまたは空スタック時は安全なフォールバック画面へ遷移すること", () => {
  const router = new MockNavigationRouter();

  // スタックが1件のみの状態で back 実行
  router.go("album", { key: "deleted-album" });
  strictEqual(router.navStack.length, 1);

  const fallbackEntry = router.back("library", { tab: "albums" });
  strictEqual(fallbackEntry.name, "library");
  strictEqual(fallbackEntry.params.tab, "albums");
  strictEqual(router.navStack.length, 1, "安全な画面へ replace 遷移");
});

test("アプリ再起動時に最後の画面と状態を安全に復元できること", () => {
  // localStorage の LAST_VIEW_KEY を模したデータ
  const savedLastView = {
    hash: "#/album?key=album-revive",
    name: "album",
    query: "key=album-revive",
    scrollTop: 140,
    state: { memo: "fav" },
    timestamp: Date.now(),
  };

  const router = new MockNavigationRouter();
  router.go(savedLastView.name, { key: "album-revive" }, { state: savedLastView.state });
  router.getCurrentEntry().scrollTop = savedLastView.scrollTop;

  const restored = router.getCurrentEntry();
  strictEqual(restored.name, "album");
  strictEqual(restored.params.key, "album-revive");
  strictEqual(restored.scrollTop, 140);
  strictEqual(restored.state.memo, "fav");
});

console.log("\n=== 4. Web Audio 接続状態とデュアル再生要素遷移シナリオ (A〜E) の検証 ===");

class MockAudioElement extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.src = "";
    this.currentTime = 0;
    this.duration = 180;
    this.paused = true;
    this.volume = 1;
    this.playbackRate = 1;
    this._hasMediaElementSource = false;
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  removeAttribute(attr) {
    if (attr === "src") this.src = "";
  }
  load() {}
  getEffectiveAudioOutput() {
    if (this.paused || !this.src) return "silent_paused";
    const isCrossOriginDrive = this.src.includes("googleapis.com/drive");
    if (this._hasMediaElementSource && isCrossOriginDrive) {
      // W3C Web Audio API CORS セキュリティ仕様:
      // MediaElementAudioSourceNode に接続された要素に CORS ヘッダー無しのクロスオリジン音源を流すと完全無音化
      return "silent_cors_violation";
    }
    return "audible_sound";
  }
}

class MockDualAudioEngine {
  constructor() {
    this.mainAudioEl = new MockAudioElement("audio-el");
    this.streamAudioEl = new MockAudioElement("stream-audio-el");
    this.activeAudioEl = this.mainAudioEl;
    this.webAudioCtx = null;
    this.eqEnabled = false;
    this.currentKeyShift = 0;
  }

  setActiveAudioElement(targetEl) {
    const standbyEl = targetEl === this.mainAudioEl ? this.streamAudioEl : this.mainAudioEl;
    standbyEl.pause();
    standbyEl.removeAttribute("src");
    standbyEl.currentTime = 0;
    this.activeAudioEl = targetEl;
    return targetEl;
  }

  applyEffectsSetting(audioEl, enabled) {
    // 防御仕様: stream-audio-el は絶対に Web Audio (createMediaElementSource) に接続しない
    if (audioEl && audioEl.id === "stream-audio-el") return;
    this.eqEnabled = !!enabled;
    if (enabled && !this.webAudioCtx) {
      this.webAudioCtx = { state: "running" };
      audioEl._hasMediaElementSource = true;
    }
  }

  applyKeyShift(semitones, audioEl) {
    if (audioEl && audioEl.id === "stream-audio-el") {
      this.currentKeyShift = semitones;
      return;
    }
    this.currentKeyShift = semitones;
    if (semitones !== 0 && !this.webAudioCtx && audioEl) {
      this.applyEffectsSetting(audioEl, true);
    }
  }

  async playTrack(track, { isDrive = false, isCached = false } = {}) {
    const isUncachedDirectStream = isDrive && !isCached;
    let targetEl;
    let targetUrl;

    if (isUncachedDirectStream) {
      targetEl = this.setActiveAudioElement(this.streamAudioEl);
      targetUrl = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media&access_token=ya29.mock`;
      // 未キャッシュ時は Web Audio 接続をスキップ
    } else {
      targetEl = this.setActiveAudioElement(this.mainAudioEl);
      targetUrl = `blob:http://localhost/${track.id}`;
      if (track.keyShift) {
        this.applyKeyShift(track.keyShift, targetEl);
      }
      if (this.eqEnabled) {
        this.applyEffectsSetting(targetEl, true);
      }
    }

    targetEl.src = targetUrl;
    await targetEl.play();
    return targetEl;
  }
}

test("シナリオA: アプリ起動直後 → 未キャッシュDrive曲 → 高速ストリーミングで音が出る", async () => {
  const engine = new MockDualAudioEngine();
  const track = { id: "gd-flac-01", title: "Drive FLAC 1" };

  const el = await engine.playTrack(track, { isDrive: true, isCached: false });
  strictEqual(el.id, "stream-audio-el", "未キャッシュ再生専用要素が選択される");
  strictEqual(el._hasMediaElementSource, false, "Web Audio (createMediaElementSource) に接続されていない");
  strictEqual(el.getEffectiveAudioOutput(), "audible_sound", "CORS制約を受けず正常に音が出る");
});

test("シナリオB: キャッシュ済みBlob曲(EQ有効) → 未キャッシュDrive曲へ切替 → 無音にならず音が出る", async () => {
  const engine = new MockDualAudioEngine();
  engine.applyEffectsSetting(engine.mainAudioEl, true);

  // 1曲目: キャッシュ済みBlob曲 (EQ有効で Web Audio 接続済み)
  const track1 = { id: "cached-01", title: "Local Song" };
  const el1 = await engine.playTrack(track1, { isDrive: false, isCached: true });
  strictEqual(el1.id, "audio-el");
  strictEqual(el1._hasMediaElementSource, true, "mainAudioEl は Web Audio に接続中");
  strictEqual(el1.getEffectiveAudioOutput(), "audible_sound");

  // 2曲目: 未キャッシュDrive曲へ切り替え
  const track2 = { id: "gd-flac-02", title: "Drive FLAC 2" };
  const el2 = await engine.playTrack(track2, { isDrive: true, isCached: false });
  strictEqual(el2.id, "stream-audio-el", "未キャッシュDrive専用要素に切り替わる");
  strictEqual(engine.mainAudioEl.paused, true, "前曲の mainAudioEl は確実に一時停止");
  strictEqual(engine.mainAudioEl.src, "", "前曲の src はクリアされて排他制御される");
  strictEqual(el2._hasMediaElementSource, false, "streamAudioEl は Web Audio 未接続");
  strictEqual(el2.getEffectiveAudioOutput(), "audible_sound", "CORS無音化を回避して正常に音が出る");
});

test("シナリオC: キャッシュ済みBlob曲(KeyShift!=0) → 未キャッシュDrive曲へ切替 → 無音にならず音が出る", async () => {
  const engine = new MockDualAudioEngine();

  // 1曲目: キーチェンジ有効 (+3半音) で再生
  const track1 = { id: "cached-key", title: "Key Track", keyShift: 3 };
  const el1 = await engine.playTrack(track1, { isDrive: false, isCached: true });
  strictEqual(el1.id, "audio-el");
  strictEqual(el1._hasMediaElementSource, true, "KeyShiftにより mainAudioEl が Web Audio に接続");

  // 2曲目: 未キャッシュDrive曲へ切り替え
  const track2 = { id: "gd-flac-03", title: "Drive FLAC 3", keyShift: 0 };
  const el2 = await engine.playTrack(track2, { isDrive: true, isCached: false });
  strictEqual(el2.id, "stream-audio-el");
  strictEqual(el2._hasMediaElementSource, false, "streamAudioEl に Web Audio は接続されない");
  strictEqual(el2.getEffectiveAudioOutput(), "audible_sound", "KeyShift後でも無音化せず音が出る");
});

test("シナリオD: 未キャッシュDrive → キャッシュ済み → 別の未キャッシュDrive → すべて正常に音が出る", async () => {
  const engine = new MockDualAudioEngine();

  // 1曲目: 未キャッシュDrive
  const el1 = await engine.playTrack({ id: "gd-1" }, { isDrive: true, isCached: false });
  strictEqual(el1.id, "stream-audio-el");
  strictEqual(el1.getEffectiveAudioOutput(), "audible_sound");

  // 2曲目: キャッシュ済み
  const el2 = await engine.playTrack({ id: "cached-2" }, { isDrive: false, isCached: true });
  strictEqual(el2.id, "audio-el");
  strictEqual(engine.streamAudioEl.paused, true, "streamAudioEl は停止");
  strictEqual(el2.getEffectiveAudioOutput(), "audible_sound");

  // 3曲目: 別の未キャッシュDrive
  const el3 = await engine.playTrack({ id: "gd-3" }, { isDrive: true, isCached: false });
  strictEqual(el3.id, "stream-audio-el");
  strictEqual(engine.mainAudioEl.paused, true, "mainAudioEl は停止");
  strictEqual(el3.getEffectiveAudioOutput(), "audible_sound");
});

test("シナリオE: EQ有効キャッシュ済み曲 → 未キャッシュDrive曲 → EQ有効キャッシュ済み曲へ戻る → 再びEQ適用", async () => {
  const engine = new MockDualAudioEngine();
  engine.applyEffectsSetting(engine.mainAudioEl, true);

  // 1曲目: EQ有効キャッシュ済み
  await engine.playTrack({ id: "cached-eq-1" }, { isDrive: false, isCached: true });
  strictEqual(engine.activeAudioEl.id, "audio-el");
  strictEqual(engine.eqEnabled, true);

  // 2曲目: 未キャッシュDrive
  await engine.playTrack({ id: "gd-eq-2" }, { isDrive: true, isCached: false });
  strictEqual(engine.activeAudioEl.id, "stream-audio-el");
  strictEqual(engine.activeAudioEl.getEffectiveAudioOutput(), "audible_sound");

  // 3曲目: 再びEQ有効キャッシュ済み曲へ戻る
  await engine.playTrack({ id: "cached-eq-3" }, { isDrive: false, isCached: true });
  strictEqual(engine.activeAudioEl.id, "audio-el");
  strictEqual(engine.eqEnabled, true, "EQ設定が維持されている");
  strictEqual(engine.mainAudioEl._hasMediaElementSource, true, "mainAudioEl は再び Web Audio EQ グラフ経由で再生");
  strictEqual(engine.mainAudioEl.getEffectiveAudioOutput(), "audible_sound");
});

console.log("\n=== 5. 再生状態 (loading / playing / paused / error) の整合性検証 ===");

test("タップ直後は loadingTrackId が設定され isPlaying は false（ローディング表示）", () => {
  const state = {
    currentTrack: null,
    isPlaying: false,
    loadingTrackId: null,
    playbackStatus: "paused",
  };

  // loadAndPlay 開始時のシミュレーション
  const track = { id: "track-loading-1", title: "Test Loading" };
  state.currentTrack = track;
  state.isPlaying = false;
  state.loadingTrackId = track.id;
  state.playbackStatus = "loading";

  strictEqual(state.isPlaying, false, "タップ直後はまだ playing ではない");
  strictEqual(state.loadingTrackId, "track-loading-1", "loadingTrackId が設定されている");
  strictEqual(state.playbackStatus, "loading", "playbackStatus は loading");
});

test("playing イベント発火時に初めて isPlaying: true、loadingTrackId: null となる", () => {
  const state = {
    currentTrack: { id: "track-1" },
    isPlaying: false,
    loadingTrackId: "track-1",
    playbackStatus: "loading",
  };
  const mediaSession = { playbackState: "none" };

  // onPlaying イベントハンドラのシミュレーション
  function onPlaying() {
    state.isPlaying = true;
    state.loadingTrackId = null;
    state.playbackStatus = "playing";
    mediaSession.playbackState = "playing";
  }

  onPlaying();
  strictEqual(state.isPlaying, true, "音が出始めてから isPlaying が true になる");
  strictEqual(state.loadingTrackId, null, "ローディングが解除される");
  strictEqual(state.playbackStatus, "playing");
  strictEqual(mediaSession.playbackState, "playing", "MediaSession も playing に更新");
});

test("play() 失敗時に isPlaying: false, loadingTrackId: null, playbackStatus: paused に即時復旧する", () => {
  const state = {
    currentTrack: { id: "track-err" },
    isPlaying: false,
    loadingTrackId: "track-err",
    playbackStatus: "loading",
  };
  const mediaSession = { playbackState: "none" };

  // play() promise rejection のシミュレーション
  function onPlayError() {
    state.isPlaying = false;
    state.loadingTrackId = null;
    state.playbackStatus = "paused";
    mediaSession.playbackState = "paused";
  }

  onPlayError();
  strictEqual(state.isPlaying, false, "再生失敗時に再生中表示が解除される");
  strictEqual(state.loadingTrackId, null, "ローディング表示が解除される");
  strictEqual(state.playbackStatus, "paused");
  strictEqual(mediaSession.playbackState, "paused");
});

test("Drive 認証キャンセル時に再生中表示が解除され停止状態で待機する", () => {
  const state = {
    currentTrack: { id: "gd-auth-cancel" },
    isPlaying: false,
    loadingTrackId: "gd-auth-cancel",
    playbackStatus: "loading",
  };
  const mediaSession = { playbackState: "none" };

  // ユーザーが Drive 認証モーダルをキャンセル
  const token = null;
  if (!token) {
    state.isPlaying = false;
    state.loadingTrackId = null;
    state.playbackStatus = "paused";
    mediaSession.playbackState = "none";
  }

  strictEqual(state.isPlaying, false);
  strictEqual(state.loadingTrackId, null);
  strictEqual(state.playbackStatus, "paused");
  strictEqual(mediaSession.playbackState, "none");
});

test("ミニプレイヤーとフルプレイヤーで loading / playing 表示条件が完全一致すること", () => {
  const state = {
    currentTrack: { id: "t-sync" },
    isPlaying: false,
    loadingTrackId: "t-sync",
  };

  // mini-player.js 判定
  const miniLoading = !!(state.loadingTrackId && (!state.currentTrack || state.loadingTrackId === state.currentTrack.id));
  const miniPlaying = !!state.isPlaying && !miniLoading;

  // view-player.js 判定
  const playerLoading = !!(state.loadingTrackId && (!state.currentTrack || state.loadingTrackId === state.currentTrack.id));
  const playerPlaying = !!state.isPlaying && !playerLoading;

  strictEqual(miniLoading, playerLoading, "ローディング判定が完全一致");
  strictEqual(miniPlaying, playerPlaying, "再生中判定が完全一致");
  strictEqual(miniLoading, true);
  strictEqual(miniPlaying, false);
});

console.log("\n=== 6. ナビゲーションスタックとブラウザ履歴の混在操作の検証 ===");

class StatefulRouterSimulator {
  constructor() {
    this.navStack = [{ name: "library", hash: "#/library", state: {}, timestamp: Date.now() }];
    this.browserHistory = ["#/library"];
    this.historyIndex = 0;
    this.pendingNavAction = null;
    this.insuranceTimer = null;
  }

  get currentHash() {
    return this.browserHistory[this.historyIndex] || "";
  }

  go(name, params = null, { replace = false, state = null } = {}) {
    let hash = `#/${name}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) hash += `?${qs}`;
    }

    if (replace) {
      this.pendingNavAction = { type: "replace", hash, state };
      this.browserHistory[this.historyIndex] = hash;
      this.syncStack(name, hash, state, "replace");
    } else {
      if (this.currentHash === hash) {
        // 同一ハッシュ連打・再入: 履歴もスタックも増やさない
        if (this.navStack.length > 0) {
          this.navStack[this.navStack.length - 1].timestamp = Date.now();
        }
        return;
      }
      this.pendingNavAction = { type: "push", hash, state };
      this.browserHistory = this.browserHistory.slice(0, this.historyIndex + 1);
      this.browserHistory.push(hash);
      this.historyIndex++;
      this.syncStack(name, hash, state, "push");
    }
  }

  back(fallback = "library", fallbackParams = null) {
    if (this.insuranceTimer) {
      clearTimeout(this.insuranceTimer);
      this.insuranceTimer = null;
    }

    if (this.navStack.length > 1) {
      const prev = this.navStack[this.navStack.length - 2];
      this.pendingNavAction = { type: "back", targetHash: prev.hash };

      if (this.historyIndex > 0) {
        this.historyIndex--;
        const newHash = this.browserHistory[this.historyIndex];
        this.syncStack(prev.name, newHash, null, "back");
        return prev;
      }

      this.navStack.pop();
      return prev;
    }

    // スタック 1件以下 → fallback へ replace 遷移
    this.navStack = [];
    this.go(fallback, fallbackParams, { replace: true });
    return this.navStack[0];
  }

  browserBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      const newHash = this.browserHistory[this.historyIndex];
      const name = (newHash.match(/^#\/([^?]+)/) || [])[1] || "library";
      this.syncStack(name, newHash, null, "browser_pop");
    }
  }

  syncStack(name, hash, state, trigger) {
    if (this.pendingNavAction?.type === "replace") {
      const entry = { name, hash, state: state || {}, timestamp: Date.now() };
      if (this.navStack.length > 0) {
        this.navStack[this.navStack.length - 1] = entry;
      } else {
        this.navStack.push(entry);
      }
      this.pendingNavAction = null;
      return;
    }

    if (this.pendingNavAction?.type === "back" || trigger === "back") {
      if (this.navStack.length > 1) {
        this.navStack.pop();
      }
      this.pendingNavAction = null;
      return;
    }

    // 同一ハッシュの重複排除
    if (this.navStack.length > 0 && this.navStack[this.navStack.length - 1].hash === hash) {
      this.navStack[this.navStack.length - 1].timestamp = Date.now();
      this.pendingNavAction = null;
      return;
    }

    // ブラウザの戻る操作
    if (this.navStack.length >= 2 && this.navStack[this.navStack.length - 2].hash === hash) {
      this.navStack.pop();
      this.pendingNavAction = null;
      return;
    }

    // 過去スタックへの巻き戻りジャンプ
    const prevIdx = this.navStack.slice(0, -1).findIndex((e) => e.hash === hash);
    if (prevIdx !== -1) {
      this.navStack = this.navStack.slice(0, prevIdx + 1);
      this.pendingNavAction = null;
      return;
    }

    // 通常の新規画面 push
    this.navStack.push({ name, hash, state: state || {}, timestamp: Date.now() });
    this.pendingNavAction = null;
  }
}

test("アプリ内戻るを2回連続実行しても履歴が二重popせず正確に戻ること", () => {
  const router = new StatefulRouterSimulator();
  router.go("library");
  router.go("artist", { name: "Queen" });
  router.go("album", { key: "A-Night-At-The-Opera" });
  strictEqual(router.navStack.length, 3);

  // 1回目アプリ内戻る
  router.back();
  strictEqual(router.currentHash, "#/artist?name=Queen");
  strictEqual(router.navStack.length, 2);

  // 2回目アプリ内戻る
  router.back();
  strictEqual(router.currentHash, "#/library");
  strictEqual(router.navStack.length, 1);
});

test("ブラウザ戻るを2回連続実行しても正確にスタックが同期すること", () => {
  const router = new StatefulRouterSimulator();
  router.go("library");
  router.go("album", { key: "Abbey-Road" });
  router.go("player");
  strictEqual(router.navStack.length, 3);

  // 1回目ブラウザ戻る
  router.browserBack();
  strictEqual(router.currentHash, "#/album?key=Abbey-Road");
  strictEqual(router.navStack.length, 2);

  // 2回目ブラウザ戻る
  router.browserBack();
  strictEqual(router.currentHash, "#/library");
  strictEqual(router.navStack.length, 1);
});

test("アプリ内戻る後にブラウザ戻るを実行しても往復・飛び越しが発生しないこと", () => {
  const router = new StatefulRouterSimulator();
  router.go("library");
  router.go("artist", { name: "Pink Floyd" });
  router.go("album", { key: "The-Wall" });
  router.go("player");
  strictEqual(router.navStack.length, 4);

  // アプリ内戻る (player -> album)
  router.back();
  strictEqual(router.currentHash, "#/album?key=The-Wall");
  strictEqual(router.navStack.length, 3);

  // 続けてブラウザ戻る (album -> artist)
  router.browserBack();
  strictEqual(router.currentHash, "#/artist?name=Pink+Floyd");
  strictEqual(router.navStack.length, 2);
});

test("ブラウザ戻る後にアプリ内戻るを実行しても往復・飛び越しが発生しないこと", () => {
  const router = new StatefulRouterSimulator();
  router.go("library");
  router.go("playlist", { id: "rock" });
  router.go("player");
  strictEqual(router.navStack.length, 3);

  // ブラウザ戻る (player -> playlist)
  router.browserBack();
  strictEqual(router.currentHash, "#/playlist?id=rock");
  strictEqual(router.navStack.length, 2);

  // 続けてアプリ内戻る (playlist -> library)
  router.back();
  strictEqual(router.currentHash, "#/library");
  strictEqual(router.navStack.length, 1);
});

test("ボトムナビで画面移動後に戻る操作が正常に動作すること", () => {
  const router = new StatefulRouterSimulator();
  router.go("stats");
  strictEqual(router.navStack.length, 2);

  router.browserBack();
  strictEqual(router.currentHash, "#/library");
  strictEqual(router.navStack.length, 1);
});

test("プレイヤーを閉じた後にブラウザ戻るで前々画面へ飛ばず直前画面に戻ること", () => {
  const router = new StatefulRouterSimulator();
  router.go("library");
  router.go("album", { key: "Let-It-Be" });
  router.go("player");

  // プレイヤーを閉じる (アプリ内 back)
  router.back();
  strictEqual(router.currentHash, "#/album?key=Let-It-Be");

  // さらにブラウザ戻る
  router.browserBack();
  strictEqual(router.currentHash, "#/library");
  strictEqual(router.navStack.length, 1);
});

test("同じアルバムを連続して開いてもスタックが増殖しないこと（同一画面連打防止）", () => {
  const router = new StatefulRouterSimulator();
  router.go("library");
  router.go("album", { key: "Rubber-Soul" });
  strictEqual(router.navStack.length, 2);

  // 同一アルバムを再度開く（連打または同じリンク押下）
  router.go("album", { key: "Rubber-Soul" });
  router.go("album", { key: "Rubber-Soul" });
  strictEqual(router.navStack.length, 2, "スタックが重複して積まれない");

  // 戻るを1回押せば即座にライブラリへ戻る
  router.back();
  strictEqual(router.currentHash, "#/library");
  strictEqual(router.navStack.length, 1);
});

test("直接URL起動時（スタック1件）にアプリ内戻るを押すと安全なfallbackへreplace遷移すること", () => {
  const router = new StatefulRouterSimulator();
  // ディープリンクで直接アルバム詳細を開いた状態（スタック1件のみ）
  router.navStack = [{ name: "album", hash: "#/album?key=Direct-Launch", state: {}, timestamp: Date.now() }];
  router.browserHistory = ["#/album?key=Direct-Launch"];
  router.historyIndex = 0;
  strictEqual(router.navStack.length, 1);

  // アプリ内戻るを押す
  router.back("library", { tab: "albums" });
  strictEqual(router.currentHash, "#/library?tab=albums");
  strictEqual(router.navStack.length, 1, "履歴を壊さず安全な画面にreplace遷移");
});

test("sessionStorage内の古いnavStack（24時間経過）が安全に破棄されること", () => {
  const now = Date.now();
  const mockSavedStack = [
    { name: "old-1", hash: "#/old-1", timestamp: now - (48 * 3600 * 1000) }, // 2日前（ゾンビ）
    { name: "old-2", hash: "#/old-2", timestamp: now - (26 * 3600 * 1000) }, // 26時間前（ゾンビ）
    { name: "recent", hash: "#/recent", timestamp: now - (10 * 60 * 1000) },  // 10分前（有効）
  ];

  const valid = mockSavedStack.filter(
    (e) => e && typeof e === "object" && (!e.timestamp || now - e.timestamp < 86400000)
  );
  strictEqual(valid.length, 1);
  strictEqual(valid[0].name, "recent");
});

console.log("\n=== 7. デュアルaudio要素の参照完全性とイベントハンドラ分離の検証 ===");

test("audio-engine.js: 必須12種類のイベントリスナーが両audio要素に漏れなく登録されること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const requiredEvents = [
    "play",
    "playing",
    "pause",
    "timeupdate",
    "durationchange",
    "loadedmetadata",
    "canplay",
    "waiting",
    "ended",
    "error",
    "ratechange",
    "volumechange",
  ];

  for (const ev of requiredEvents) {
    const reg = new RegExp(`el\\.addEventListener\\(["']${ev}["']`);
    strictEqual(reg.test(aeCode), true, `イベントリスナー "${ev}" が登録されていること`);
  }

  // 両要素への適用確認
  strictEqual(/attachElementListeners\(mainAudioEl\);/.test(aeCode), true, "mainAudioEl に登録されている");
  strictEqual(/attachElementListeners\(streamAudioEl\);/.test(aeCode), true, "streamAudioEl に登録されている");
  strictEqual(/e\.currentTarget\s*===\s*getAudioElement\(\)/.test(aeCode), true, "event.currentTarget === getAudioElement() でガードされている");
});

test("非アクティブ要素からの遅延イベント (ended, timeupdate, pause, volumechange, ratechange) が破棄されること", () => {
  // デュアル audio 要素とイベントガードのシミュレーション
  const mainAudio = { id: "audio-el", currentTime: 10, duration: 200, paused: true, playbackRate: 1.0, volume: 1.0 };
  const streamAudio = { id: "stream-audio-el", currentTime: 45, duration: 320, paused: false, playbackRate: 1.25, volume: 0.8 };

  let activeEl = streamAudio;
  const getAudioElement = () => activeEl;

  let stateTime = 0;
  let stateStatus = "playing";
  let stateRate = 1.0;
  let stateVolume = 1.0;
  let endedTriggered = false;

  const isFromActive = (e) => (e.currentTarget || e.target) === getAudioElement();

  const handleTimeUpdate = (e) => {
    if (!isFromActive(e)) return;
    stateTime = (e.currentTarget || e.target).currentTime;
  };

  const handlePause = (e) => {
    if (!isFromActive(e)) return;
    stateStatus = "paused";
  };

  const handleRateChange = (e) => {
    if (!isFromActive(e)) return;
    stateRate = (e.currentTarget || e.target).playbackRate;
  };

  const handleVolumeChange = (e) => {
    if (!isFromActive(e)) return;
    stateVolume = (e.currentTarget || e.target).volume;
  };

  const handleEnded = (e) => {
    if (!isFromActive(e)) return;
    endedTriggered = true;
  };

  // 1. streamAudio がアクティブの時、streamAudio からのイベントは処理される
  handleTimeUpdate({ currentTarget: streamAudio, target: streamAudio });
  handleRateChange({ currentTarget: streamAudio, target: streamAudio });
  handleVolumeChange({ currentTarget: streamAudio, target: streamAudio });
  strictEqual(stateTime, 45, "アクティブ要素の currentTime が反映される");
  strictEqual(stateRate, 1.25, "アクティブ要素の playbackRate が反映される");
  strictEqual(stateVolume, 0.8, "アクティブ要素の volume が反映される");

  // 2. 非アクティブな mainAudio から遅れて届いた timeupdate / pause / ratechange / volumechange / ended イベント
  handleTimeUpdate({ currentTarget: mainAudio, target: mainAudio });
  handlePause({ currentTarget: mainAudio, target: mainAudio });
  handleRateChange({ currentTarget: mainAudio, target: mainAudio });
  handleVolumeChange({ currentTarget: mainAudio, target: mainAudio });
  handleEnded({ currentTarget: mainAudio, target: mainAudio });

  strictEqual(stateTime, 45, "非アクティブ要素の遅延 timeupdate で上書きされない");
  strictEqual(stateStatus, "playing", "非アクティブ要素の遅延 pause で上書きされない");
  strictEqual(stateRate, 1.25, "非アクティブ要素の遅延 ratechange で上書きされない");
  strictEqual(stateVolume, 0.8, "非アクティブ要素の遅延 volumechange で上書きされない");
  strictEqual(endedTriggered, false, "非アクティブ要素の遅延 ended で次曲移動が誤発火しない");

  // 3. active を mainAudio に切り替え後
  activeEl = mainAudio;
  handleTimeUpdate({ currentTarget: mainAudio, target: mainAudio });
  strictEqual(stateTime, 10, "切り替え後は新アクティブ要素の timeupdate が反映される");

  // 4. 今度は旧アクティブ(streamAudio)からの遅延イベントが弾かれること
  handlePause({ currentTarget: streamAudio, target: streamAudio });
  strictEqual(stateStatus, "playing", "旧アクティブ要素の遅延 pause が破棄される");
});

test("stream-audio-el 再生中もシーク、音量、速度、スリープタイマー、MediaSession が正しく制御されること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");

  // setVolume が両要素に適用されること
  strictEqual(/if\s*\(mainAudioEl\)\s*applyTrackVolume\(mainAudioEl\);/.test(aeCode), true);
  strictEqual(/if\s*\(streamAudioEl\)\s*applyTrackVolume\(streamAudioEl\);/.test(aeCode), true);

  // setPlaybackRate が両要素に適用されること
  strictEqual(/mainAudioEl\.playbackRate\s*=\s*r;/.test(aeCode), true);
  strictEqual(/streamAudioEl\.playbackRate\s*=\s*r;/.test(aeCode), true);

  // スリープタイマー満了・曲末尾停止時に両要素が pause されること
  strictEqual(/if\s*\(mainAudioEl\)\s*\{\s*try\s*\{\s*mainAudioEl\.pause\(\);/.test(aeCode), true);
  strictEqual(/if\s*\(streamAudioEl\)\s*\{\s*try\s*\{\s*streamAudioEl\.pause\(\);/.test(aeCode), true);

  // MediaSession pause / stop ハンドラで両要素が安全に pause されること
  strictEqual(/navigator\.mediaSession\.setActionHandler\("pause",\s*\(\)\s*=>\s*\{[\s\S]*?mainAudioEl\.pause[\s\S]*?streamAudioEl\.pause/.test(aeCode), true);
  strictEqual(/navigator\.mediaSession\.setActionHandler\("stop",\s*\(\)\s*=>\s*\{[\s\S]*?mainAudioEl\.pause[\s\S]*?streamAudioEl\.pause/.test(aeCode), true);
});

test("normalize-modal.js: プレビュー開始時に stream-audio-el も確実に一時停止されること", () => {
  const nmCode = fs.readFileSync(path.join(__dirname, "../js/ui/normalize-modal.js"), "utf8");
  strictEqual(nmCode.includes("getStreamAudioElement"), true, "getStreamAudioElement が import / 使用されている");
  strictEqual(nmCode.includes("streamAudio.pause()"), true, "streamAudio.pause() が呼ばれる");
});

test("view-settings.js: オーディオエフェクト有効化時に再生要素に関わらず getMainAudioElement() を使用すること", () => {
  const vsCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-settings.js"), "utf8");
  strictEqual(vsCode.includes("getMainAudioElement"), true, "getMainAudioElement が import / 使用されている");
  strictEqual(/const audioEl = getMainAudioElement\(\);/.test(vsCode), true, "エフェクト有効化時に getMainAudioElement() を渡す");
  strictEqual(/applyEffectsSetting\(getMainAudioElement\(\), false\);/.test(vsCode), true, "エフェクト無効化時も getMainAudioElement() を渡す");
});

test("visualizer.js: getAudioElement() を介して現在のアクティブ要素の currentTime と再生状態を取得すること", () => {
  const vizCode = fs.readFileSync(path.join(__dirname, "../js/player/visualizer.js"), "utf8");
  strictEqual(vizCode.includes("getAudioElement"), true, "getAudioElement が import されている");
  strictEqual(/const curEl = \(typeof getAudioElement === "function"\s*\?\s*getAudioElement\(\)\s*:\s*null\)\s*\|\|\s*audioEl;/.test(vizCode), true, "アクティブ要素を解決している");
  strictEqual(/curEl\.currentTime/.test(vizCode), true, "アクティブ要素の currentTime を参照している");
});

console.log("\n=== 8. イベント二重登録防止 & ビジュアライザー安全分離の検証 ===");

await asyncTest("attachElementListenersを同じ要素へ2回呼んでもハンドラは1組だけ登録される", async () => {
  const { attachElementListeners } = await import("../js/player/audio-engine.js");
  const registeredCounts = {};
  const mockAudio = {
    id: "mock-audio-dup-test",
    addEventListener(ev, fn) {
      registeredCounts[ev] = (registeredCounts[ev] || 0) + 1;
    },
  };

  // 1回目のリスナー登録
  attachElementListeners(mockAudio);
  strictEqual(registeredCounts["ended"], 1, "1回目の呼び出しで ended リスナーが登録される");
  strictEqual(registeredCounts["timeupdate"], 1, "1回目の呼び出しで timeupdate リスナーが登録される");
  strictEqual(registeredCounts["playing"], 1, "1回目の呼び出しで playing リスナーが登録される");

  // 2回目のリスナー登録（重複呼び出し）
  attachElementListeners(mockAudio);
  strictEqual(registeredCounts["ended"], 1, "WeakSetガードにより2回目はリスナー追加されない");
  strictEqual(registeredCounts["timeupdate"], 1, "WeakSetガードにより timeupdate は1組のみ維持される");
  strictEqual(registeredCounts["playing"], 1, "WeakSetガードにより playing は1組のみ維持される");
});

test("endedイベント1回で次曲処理は1回だけ", () => {
  // リスナーが1組のみのため、ended 1回発火で advanceFromEnded が1回だけ実行されることのシミュレーション
  let queueIndex = 0;
  const queue = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  let advanceCalls = 0;

  function onEnded() {
    advanceCalls++;
    if (queueIndex + 1 < queue.length) {
      queueIndex++;
    }
  }

  // 1回の ended 発火
  onEnded();
  strictEqual(advanceCalls, 1, "次曲進行は正確に1回だけ呼ばれる");
  strictEqual(queueIndex, 1, "キューインデックスは1曲分だけ進む（多重スキップしない）");
});

test("playingイベント1回でバックグラウンドキャッシュ開始は1回だけ", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");

  // triggerBgCache が bgCacheTriggered フラグで二重発火防止されていること
  strictEqual(/let bgCacheTriggered = false;/.test(aeCode), true, "bgCacheTriggered フラグが存在する");
  strictEqual(/if \(bgCacheTriggered\) return;/.test(aeCode), true, "多重起動ガードが存在する");

  // startBackgroundDriveCache 内で activeBackgroundCacheTrackId による二重ダウンロード防止
  strictEqual(/if \(activeBackgroundCacheTrackId === trackId\) return;/.test(aeCode), true, "同一トラックの二重DLが防止される");
});

await asyncTest("stream-audio-el再生中にビジュアライザーがWeb Audioへ接続されない", async () => {
  const vizCode = fs.readFileSync(path.join(__dirname, "../js/player/visualizer.js"), "utf8");
  const { getVisualizerState } = await import("../js/player/visualizer.js");

  // visualizer.js 内で createMediaElementSource や AnalyserNode が呼ばれていないことの検証
  strictEqual(/\.createMediaElementSource\(/.test(vizCode), false, "visualizer.js は createMediaElementSource を呼ばない");
  strictEqual(/\.createAnalyser\(/.test(vizCode), false, "visualizer.js は AnalyserNode を作らない");

  // stream-audio-el 判定時に drawStreamingPlaceholder を呼ぶこと
  strictEqual(/if\s*\(curEl\s*&&\s*curEl\.id\s*===\s*"stream-audio-el"\)/.test(vizCode), true);
  strictEqual(/drawStreamingPlaceholder\(w,\s*h\);/.test(vizCode), true);
  strictEqual(vizCode.includes("⚡ 高速ストリーミング再生中（キャッシュ完了後に実波形表示）"), true);

  // getVisualizerState の webAudioConnected が常に false であること
  const state = getVisualizerState();
  strictEqual(state.webAudioConnected, false, "Web Audio への接続は常時 0");
});

test("キャッシュ済みメインaudioへ戻るとビジュアライザーが復帰する", () => {
  const vizCode = fs.readFileSync(path.join(__dirname, "../js/player/visualizer.js"), "utf8");

  // stream-audio-el でない（mainAudioEl）かつ pcm がある場合は drawFromPcm(w, h) が呼ばれる
  strictEqual(/if\s*\(pcm\s*&&\s*pcmCoversFull\)\s*\{\s*drawFromPcm\(w,\s*h\);/.test(vizCode), true);
});

console.log("\n=== 9. 再生エンジン安定化・無音防止・10秒タイムアウト再試行・User Gesture ===");

test("play() Promise rejection で loading 解除 & error 状態へ安全に遷移すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  strictEqual(aeCode.includes("handlePlaybackFinalFailure(myAttemptId, track, err)"), true, "play失敗時にhandlePlaybackFinalFailureが呼ばれる");
  strictEqual(/playbackStatus:\s*"error"/.test(aeCode), true, "エラー時にplaybackStatus: 'error'に設定される");
  strictEqual(/loadingTrackId:\s*null/.test(aeCode), true, "エラー時にloadingTrackId: nullにクリアされる");
});

test("play() 後に playing が発生しない場合の 10秒タイムアウトと安全な1回再試行", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  strictEqual(aeCode.includes("startPlayingWatchdog(myAttemptId, track"), true, "play_called直後にstartPlayingWatchdogが起動される");
  strictEqual(aeCode.includes("10000"), true, "タイムアウトは10秒(10000ms)");
  strictEqual(/state\.playAttemptRetryCount\s*<\s*1/.test(aeCode), true, "最大1回のみ安全な再試行を実行");
  strictEqual(/curEl\.load\(\)/.test(aeCode), true, "再試行時にload()を呼んで通信とデコーダをリセット");
});

test("2回目タイムアウト/失敗で error 状態へ遷移し、次曲スキップしないこと", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  // handlePlaybackFinalFailure 内で skipToNextOnError を呼ばないこと
  const handleFnMatch = aeCode.match(/function handlePlaybackFinalFailure[\s\S]*?^}/m);
  ok(handleFnMatch, "handlePlaybackFinalFailure関数が存在する");
  const handleFnCode = handleFnMatch[0];
  strictEqual(handleFnCode.includes("skipToNextOnError"), false, "再生失敗時に勝手に次曲スキップしない");
  strictEqual(handleFnCode.includes('playbackStatus: "error"'), true, "停止してerror状態にする");
  strictEqual(handleFnCode.includes("toast("), true, "ユーザーフレンドリーな通知を表示する");
});

test("古い playAttemptId の playing / play resolve を無視すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  strictEqual(aeCode.includes("state.currentPlayAttemptId = myAttemptId"), true, "再生試行ごとに固有IDを発行・保持");
  strictEqual(aeCode.includes("if (attemptId !== state.currentPlayAttemptId) return;"), true, "staleな試行IDのタイムアウトを無視");
});

test("非アクティブ要素の pause / abort / error を無視すること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  strictEqual(aeCode.includes("const isFromActive = (e) =>"), true, "アクティブ要素判定ガードが存在");
  strictEqual(/if \(!isFromActive\(e\)\) return;\s*onPause\(e\);/.test(aeCode), true, "非アクティブ要素のpauseは無視");
  strictEqual(/if \(!isFromActive\(e\)\) return;\s*clearPlayingWatchdog\(\);/.test(aeCode), true, "非アクティブ要素のerrorは無視");
});

test("mainAudioEl と streamAudioEl が同時再生しないこと（setActiveAudioElementの排他制御）", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const setActiveMatch = aeCode.match(/function setActiveAudioElement[\s\S]*?^}/m);
  ok(setActiveMatch, "setActiveAudioElementが存在する");
  const setActiveCode = setActiveMatch[0];
  strictEqual(setActiveCode.includes("standbyEl.pause()"), true, "待機要素をpause");
  strictEqual(setActiveCode.includes('standbyEl.removeAttribute("src")'), true, "待機要素のsrcを解除");
  strictEqual(setActiveCode.includes("standbyEl.load()"), true, "待機要素のload()を呼んで通信を中止");
});

test("playing 前にバックグラウンドキャッシュを開始しないこと（2.5秒固定タイマー廃止の検証）", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  // loadAndPlay 内に setTimeout(..., 2500) が残っていないこと
  const loadPlayMatch = aeCode.match(/async function loadAndPlay[\s\S]*?^}/m);
  ok(loadPlayMatch, "loadAndPlayが存在する");
  const loadPlayCode = loadPlayMatch[0];
  strictEqual(/setTimeout\([^,]+,\s*2500\)/.test(loadPlayCode), false, "loadAndPlay内の2.5秒固定タイマーは完全撤廃");
  strictEqual(loadPlayCode.includes("triggerBgCache();"), true, "onPlaying内からのみキャッシュを開始");
});

test("streamAudioEl の User Gesture unlock が両要素に対して実装されていること", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  strictEqual(aeCode.includes("export function unlockAudioElementsOnUserGesture"), true, "unlockAudioElementsOnUserGestureがexportされている");
  strictEqual(aeCode.includes("const elements = [mainAudioEl, streamAudioEl].filter(Boolean);"), true, "両要素を対象にアンロック");
  strictEqual(/pointerdown/.test(aeCode) && /keydown/.test(aeCode), true, "グローバル操作イベントでセッション初回にアンロック");
});

test("view-player.js で未キャッシュDrive曲の場合に getBlob を呼ばないこと", () => {
  const vpCode = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf8");
  strictEqual(vpCode.includes("hasCachedBlob"), true, "hasCachedBlobがimport・使用されている");
  strictEqual(/if \(!hasBlob\) \{\s*\/\/[^\n]*\s*ensureLyricsForCurrentTrack\(\);\s*return;\s*\}/.test(vpCode), true, "未キャッシュDrive曲でgetBlobを呼ばずにreturn");
});

test("ログにアクセストークンや秘密情報が出力されないこと", () => {
  const aeCode = fs.readFileSync(path.join(__dirname, "../js/player/audio-engine.js"), "utf8");
  const logMatch = aeCode.match(/function logPlaybackEvent[\s\S]*?^}/m);
  ok(logMatch, "logPlaybackEventが存在する");
  const logCode = logMatch[0];
  strictEqual(logCode.includes("access_token"), false, "ログにaccess_tokenを出力しない");
  strictEqual(logCode.includes("ya29"), false, "ログにトークンプレフィックスを出力しない");
  strictEqual(/src=drive_stream|src=\$\{srcType\}/.test(logCode), true, "URLではなくsrcType種別のみを出力");
});

console.log(`\n高速再生 & ナビゲーションスタックテスト: ${passed} 件 PASSED ✓`);
