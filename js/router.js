/**
 * ハッシュベースの極小 SPA ルーター
 *
 * - GitHub Pages のサブパス配信に強い（path モードと異なり 404 リライト不要）
 * - 各ルートは「マウント関数」と「アンマウント関数」を持つ
 * - 同じルート + 同じクエリ文字列に遷移しても再マウントしない（音声再生継続のため）
 * - クエリ文字列付き遷移をサポート: #/playlist?id=xxx など
 * - アプリ内ナビゲーションスタック (route, params, scrollY, state, timestamp) による高精度な戻る遷移
 */

import { escapeHtml, dismissActiveModal } from "./ui/components.js";

const routes = new Map();
let currentRoute = null;
let currentQuery = null;
let currentCleanup = null;
// 遷移の世代番号。navigate は async のため、mount(handler) の await 中に次の
// 遷移 (hashchange は await されない) が始まり得る。後発遷移が始まったら先発の
// mount 結果を破棄するために使う（購読リーク・currentCleanup 上書き事故の防止）。
let navSeq = 0;

export const LAST_VIEW_KEY = "music_player_last_view";
export const NAV_STACK_KEY = "music_player_nav_stack";
const MAX_STACK_SIZE = 50;

let navStack = loadNavStack();
let _pendingNavAction = null;
let _backInsuranceTimer = null;
let _activeRoot = null;

function loadNavStack() {
  try {
    if (typeof sessionStorage !== "undefined") {
      const raw = sessionStorage.getItem(NAV_STACK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const now = Date.now();
          // 不正なエントリや24時間以上前のゾンビ履歴を除外
          const valid = parsed.filter(
            (e) => e && typeof e === "object" && typeof e.name === "string" && typeof e.hash === "string" && (!e.timestamp || now - e.timestamp < 86400000)
          );
          return valid.slice(-MAX_STACK_SIZE);
        }
      }
    }
  } catch {}
  return [];
}

function persistNavStack() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(NAV_STACK_KEY, JSON.stringify(navStack.slice(-MAX_STACK_SIZE)));
    }
  } catch {}
}

/**
 * ナビゲーションスタックのコピーを取得（テスト・デバッグ用）
 */
export function getNavStack() {
  return navStack.slice();
}

/**
 * 現在のスタック最上位エントリを取得
 */
export function getCurrentStackEntry() {
  return navStack.length > 0 ? navStack[navStack.length - 1] : null;
}

/**
 * 現在のスタック最上位エントリの状態 (state) を取得
 */
export function getCurrentState() {
  const cur = getCurrentStackEntry();
  return (cur && cur.state) ? cur.state : {};
}

/**
 * 現在のスタック最上位エントリの状態 (state) を更新（履歴を増やさず上書き）
 * @param {Record<string, any>} stateUpdates
 */
export function updateCurrentState(stateUpdates) {
  if (!stateUpdates || typeof stateUpdates !== "object") return;
  const cur = getCurrentStackEntry();
  if (cur) {
    cur.state = { ...(cur.state || {}), ...stateUpdates };
    persistNavStack();
    saveLastView({
      hash: cur.hash,
      name: cur.name,
      query: cur.query,
      scrollTop: cur.scrollTop || 0,
      state: cur.state,
    });
  }
}

export const replaceCurrentState = updateCurrentState;

/**
 * ナビゲーションスタックをリセット
 */
export function clearNavStack() {
  navStack = [];
  persistNavStack();
}

/**
 * ルートを登録する
 * @param {string} name        例: "player"
 * @param {(root: HTMLElement) => (Promise<void>|void|() => void)} handler
 */
export function register(name, handler) {
  routes.set(name, handler);
}

export function getLastView() {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && typeof data.hash === "string" && data.hash.startsWith("#/")) {
      return data;
    }
  } catch {}
  return null;
}

export function saveLastView(data) {
  try {
    if (!data || !data.hash) return;
    if (data.name === "welcome" || data.hash === "#/welcome") return;
    const existing = getLastView() || {};
    const payload = { ...existing, ...data, timestamp: Date.now() };
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(payload));
  } catch {}
}

function parseHashParams(queryString) {
  const params = {};
  if (queryString) {
    try {
      const sp = new URLSearchParams(queryString);
      for (const [k, v] of sp.entries()) {
        params[k] = v;
      }
    } catch {}
  }
  return params;
}

/**
 * ルーターの起動
 */
export function start(root, fallback = "player") {
  _activeRoot = root;

  // スクロール位置の自動追従保存
  let scrollSaveTimer = null;
  if (root) {
    root.addEventListener("scroll", () => {
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        if (currentRoute && currentRoute !== "welcome") {
          const cur = getCurrentStackEntry();
          if (cur) {
            cur.scrollTop = root.scrollTop || 0;
            persistNavStack();
          }
          saveLastView({
            hash: location.hash || `"#/${currentRoute}"`,
            name: currentRoute,
            query: currentQuery || "",
            scrollTop: root.scrollTop || 0,
            state: cur?.state || {},
          });
        }
      }, 150);
    }, { passive: true });
  }

  const handle = async () => {
    const hash = location.hash || "";
    // 形式: #/name または #/name?query
    const m = hash.match(/^#\/([^?]+)(?:\?(.*))?$/);
    const name = (m && m[1]) || fallback;
    const query = (m && m[2]) || "";
    const params = parseHashParams(query);

    // ナビゲーションスタックの同期
    syncNavStackOnTransition(name, query, params, hash || `#/${name}`);

    await navigate(name, query, root, fallback);
  };

  window.addEventListener("hashchange", handle);
  if (!location.hash) {
    const last = getLastView();
    if (last && last.hash && last.name !== "welcome") {
      location.hash = last.hash;
    } else {
      location.hash = `#/${fallback}`;
    }
  } else {
    handle();
  }
}

function syncNavStackOnTransition(name, query, params, hash) {
  if (_backInsuranceTimer) {
    clearTimeout(_backInsuranceTimer);
    _backInsuranceTimer = null;
  }

  if (_pendingNavAction?.type === "replace") {
    const st = _pendingNavAction.state || (navStack.length > 0 ? navStack[navStack.length - 1].state : {});
    const entry = { name, query, params, hash, scrollTop: 0, state: st, timestamp: Date.now() };
    if (navStack.length > 0) {
      navStack[navStack.length - 1] = entry;
    } else {
      navStack.push(entry);
    }
    _pendingNavAction = null;
  } else if (_pendingNavAction?.type === "back") {
    if (navStack.length > 1) {
      navStack.pop();
    }
    _pendingNavAction = null;
  } else {
    // 同一ハッシュへの再入・同一画面連打はスタックを増やさず上書き
    if (navStack.length > 0 && navStack[navStack.length - 1].hash === hash) {
      navStack[navStack.length - 1].timestamp = Date.now();
      if (_pendingNavAction?.state) {
        navStack[navStack.length - 1].state = {
          ...navStack[navStack.length - 1].state,
          ..._pendingNavAction.state,
        };
      }
      _pendingNavAction = null;
      persistNavStack();
      return;
    }

    // ブラウザの戻る/進む、または通常の遷移
    if (navStack.length >= 2 && navStack[navStack.length - 2].hash === hash) {
      // ブラウザの「戻る」ボタンによる遷移を検知
      navStack.pop();
    } else {
      // 過去のスタックに同一URLが存在するか走査（複数画面ジャンプ戻り）
      const prevIdx = navStack.slice(0, -1).findIndex((e) => e.hash === hash);
      if (prevIdx !== -1) {
        navStack = navStack.slice(0, prevIdx + 1);
      } else {
        // 新規画面遷移: 離脱元画面のスクロール位置を現在のスタック先頭に記録
        if (navStack.length > 0 && _activeRoot) {
          navStack[navStack.length - 1].scrollTop = _activeRoot.scrollTop || 0;
        }
        const st = _pendingNavAction?.state || {};
        navStack.push({ name, query, params, hash, scrollTop: 0, state: st, timestamp: Date.now() });
      }
    }
    _pendingNavAction = null;
  }
  if (navStack.length > MAX_STACK_SIZE) {
    navStack = navStack.slice(-MAX_STACK_SIZE);
  }
  persistNavStack();
}

/**
 * 指定ルート + クエリへ遷移
 */
async function navigate(name, query, root, fallback) {
  const handler = routes.get(name) || routes.get(fallback);
  if (!handler) return;

  // ルート名 + クエリ が両方同じなら再マウントしない（タブ連打時の無駄を避ける）。
  // currentRoute/currentQuery は「最後に受理した遷移先」を即時反映する(下記)ため、
  // mount 進行中でも最新の目標と比較でき、A→B→A 連打でも A を取りこぼさない。
  if (currentRoute === name && currentQuery === query) {
    updateNavActive(name);
    return;
  }

  // この遷移の世代番号を採番。mount(handler) は async なので、その await 中に
  // 後発の遷移が始まり得る。後発が始まったらこの遷移は陳腐化したとみなす。
  const myNav = ++navSeq;
  // 受理した遷移先を即座に確定する。これにより上の同一判定が常に最新の目標を指し、
  // mount 進行中(B)に同じ画面(A)へ戻る連打でも取りこぼさない。
  // (実際の表示確定・履歴は後段の updateNavActive / 成功時処理で行う)
  currentRoute = name;
  currentQuery = query;

  const performTransition = async () => {
    // 既存ビューのクリーンアップ
    if (typeof currentCleanup === "function") {
      try { currentCleanup(); } catch (e) { console.warn("cleanup failed", e); }
      currentCleanup = null;
    }
    // 画面遷移時、共有 #modal-root に開いたまま残った確認/入力モーダルを閉じる。
    //   開いたまま遷移すると backdrop が遷移後画面の全タップを吸収し操作不能になるため、
    //   各ビューの cleanup 後に一括でキャンセル相当のクローズを行う(全画面共通の防御)。
    try { dismissActiveModal(); } catch (e) { console.warn("modal dismiss failed", e); }
    root.innerHTML = "";

    try {
      const cleanup = await handler(root);
      if (myNav !== navSeq) {
        // mount 中に後発の遷移が開始済み。今 mount したビューは表示されないので、
        // 購読リークを防ぐため即座に cleanup して破棄する。currentCleanup は
        // 後発遷移が管理するので、ここでは上書きしない。
        if (typeof cleanup === "function") {
          try { cleanup(); } catch (e) { console.warn("stale cleanup failed", e); }
        }
        return;
      }
      currentCleanup = typeof cleanup === "function" ? cleanup : null;
      // currentRoute/currentQuery は採番直後に確定済み（上記）。ここでは表示のみ確定。
      updateNavActive(name);

      // 保存されていたスクロール位置をスタックまたは LastView から高精度復元
      let restoredScroll = false;
      const curStack = getCurrentStackEntry();
      const last = getLastView();
      const targetScroll = (curStack && typeof curStack.scrollTop === "number" && curStack.scrollTop > 0)
        ? curStack.scrollTop
        : (last && (last.hash === location.hash || (last.name === name && last.query === query)) ? last.scrollTop : 0);

      if (last && (last.hash === location.hash || (last.name === name && last.query === query))) {
        if (typeof last.scrollTop === "number" && last.scrollTop > 0) {
          root.scrollTop = last.scrollTop;
          restoredScroll = true;
        }
      }
      if (typeof targetScroll === "number" && targetScroll > 0) {
        root.scrollTop = targetScroll;
        restoredScroll = true;
        // DOM の非同期レンダリング完了を待って確実にスクロール位置を復元
        setTimeout(() => { if (myNav === navSeq) root.scrollTop = targetScroll; }, 50);
        setTimeout(() => { if (myNav === navSeq) root.scrollTop = targetScroll; }, 180);
      }
      if (!restoredScroll) {
        root.scrollTop = 0;
      }

      // 現在画面の状態を保存（welcome画面以外）
      if (name !== "welcome") {
        saveLastView({
          hash: location.hash,
          name,
          query,
          scrollTop: root.scrollTop,
          state: curStack?.state || {},
        });
      }
    } catch (err) {
      // 陳腐化した遷移のエラーは握りつぶす（後発遷移の表示を壊さない）
      if (myNav !== navSeq) return;
      // mount 失敗。早期確定した currentRoute を無効化し、同一ルートへの再遷移
      // (リトライ) を可能にする（さもないと同一判定で弾かれ再試行できない）。
      currentRoute = null;
      currentQuery = null;
      console.error("route mount failed", name, err);
      root.innerHTML = `<div class="empty-state">画面の読み込みに失敗しました。<br><small>${escapeHtml(String(err && err.message || err))}</small></div>`;
    }
  };

  // ブラウザの View Transition API (Safari 18+, Chrome, Edge) を優先利用して極めて滑らかに切替
  if (typeof document !== "undefined" && typeof document.startViewTransition === "function") {
    document.startViewTransition(() => performTransition());
  } else {
    await performTransition();
  }
}

function updateNavActive(name) {
  document.querySelectorAll(".nav-item").forEach((el) => {
    const route = el.dataset.route;
    const active = route === name || (name === "album" && route === "albums");
    el.classList.toggle("is-active", active);
  });
  // body に現在ルートを保持 (CSS で画面ごとの余白調整等に利用)
  document.body.dataset.route = name;
}

// escapeHtml は components.js から import している (DRY 化のため)

/**
 * プログラム遷移
 * @param {string} name
 * @param {Record<string,string>} [params]  クエリ化したい key/value
 * @param {{ replace?: boolean, state?: Record<string, any> }} [options]
 */
export function go(name, params = null, { replace = false, state = null } = {}) {
  let hash = `#/${name}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) hash += `?${qs}`;
  }

  if (replace) {
    _pendingNavAction = { type: "replace", name, params, state, hash };
    if (typeof history !== "undefined" && typeof history.replaceState === "function") {
      try {
        history.replaceState(null, "", hash);
      } catch {}
    }
    // replaceState は hashchange イベントを発火させないため直接同期・遷移を実行
    const query = (hash.match(/^#\/[^?]+(?:\?(.*))?$/) || [])[1] || "";
    syncNavStackOnTransition(name, query, params || {}, hash);
    if (_activeRoot) {
      navigate(name, query, _activeRoot, "library");
    }
  } else {
    _pendingNavAction = { type: "push", name, params, state, hash };
    if (location.hash === hash) {
      if (state) updateCurrentState(state);
    } else {
      location.hash = hash;
    }
  }
}

/**
 * ナビゲーションスタックに基づき直前の画面へ戻る（統一バックハンドラ）
 * @param {string} [fallback="library"]
 * @param {Record<string,string>} [fallbackParams=null]
 */
export function back(fallback = "library", fallbackParams = null) {
  if (_backInsuranceTimer) {
    clearTimeout(_backInsuranceTimer);
    _backInsuranceTimer = null;
  }

  if (navStack.length > 1) {
    const prev = navStack[navStack.length - 2];
    _pendingNavAction = { type: "back", targetHash: prev.hash };

    if (typeof window !== "undefined" && window.history && window.history.length > 1) {
      window.history.back();
      // 万が一 history.back() で hashchange が即時発火しない環境（スタンドアロンPWA等）の保険
      _backInsuranceTimer = setTimeout(() => {
        if (_pendingNavAction?.type === "back") {
          _pendingNavAction = null;
          navStack.pop();
          persistNavStack();
          location.hash = prev.hash;
        }
      }, 150);
      return;
    }

    // history.length <= 1 の場合（再起動後・直接リンク起動時）
    navStack.pop();
    persistNavStack();
    location.hash = prev.hash;
    return;
  }

  // スタックが空または1件のみの場合、安全なフォールバック先へ replace で遷移
  navStack = [];
  persistNavStack();
  go(fallback, fallbackParams, { replace: true });
}
