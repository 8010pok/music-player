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
let _fallbackRoute = "player";

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
    // ライブラリ画面のタブ切替時（history.replaceState 等）はスタック最上位の hash / query / params も同期する
    if (cur.name === "library" && typeof stateUpdates.activeTab === "string" && stateUpdates.activeTab) {
      cur.params = { ...(cur.params || {}), tab: stateUpdates.activeTab };
      const qs = new URLSearchParams(cur.params).toString();
      cur.query = qs;
      cur.hash = qs ? `#/${cur.name}?${qs}` : `#/${cur.name}`;
      if (currentRoute === "library") {
        currentQuery = qs;
      }
    }
    if (_activeRoot && typeof _activeRoot.scrollTop === "number") {
      cur.scrollTop = _activeRoot.scrollTop;
    }
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
  _fallbackRoute = fallback;

  // ボトムナビゲーションのクリックを明示的な push 遷移としてマーク（ブラウザ戻る判定との混同を防止）
  if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
    document.querySelectorAll(".bottom-nav .nav-item").forEach((el) => {
      el.addEventListener("click", () => {
        const route = el.dataset?.route;
        if (route) {
          _pendingNavAction = {
            type: "push",
            name: route,
            params: {},
            state: { view: route },
            hash: `#/${route}`,
          };
        }
      });
    });
  }

  // スクロール位置の自動追従保存（スクロール中のストレージ同期書き込みを排除し、600ms デバウンスまたは画面離脱時のみ保存）
  let scrollSaveTimer = null;
  if (root) {
    root.addEventListener("scroll", () => {
      if (currentRoute && currentRoute !== "welcome") {
        const cur = getCurrentStackEntry();
        if (cur) {
          cur.scrollTop = root.scrollTop || 0;
        }
      }
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        if (currentRoute && currentRoute !== "welcome") {
          const cur = getCurrentStackEntry();
          if (cur) {
            cur.scrollTop = root.scrollTop || 0;
            persistNavStack();
          }
          saveLastView({
            hash: location.hash || `#/${currentRoute}`,
            name: currentRoute,
            query: currentQuery || "",
            scrollTop: root.scrollTop || 0,
            state: cur?.state || {},
          });
        }
      }, 600);
    }, { passive: true });
  }

  const handle = async () => {
    const hash = location.hash || "";
    // 形式: #/name または #/name?query
    const m = hash.match(/^#\/([^?]+)(?:\?(.*))?$/);
    const name = (m && m[1]) || fallback;
    let query = (m && m[2]) || "";
    let params = parseHashParams(query);

    // ナビゲーションスタックの同期
    syncNavStackOnTransition(name, query, params, hash || `#/${name}`);

    // ブラウザ戻る等でスタック上のエントリに query/params が保存されている場合はそれを優先反映
    const top = getCurrentStackEntry();
    if (top && top.name === name && top.query && !query) {
      query = top.query;
      params = top.params || parseHashParams(query);
    }

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
    const prevState = navStack.length > 0 ? (navStack[navStack.length - 1].state || {}) : {};
    const st = { view: name, ...(params || {}), ...prevState, ...(_pendingNavAction.state || {}) };
    const entry = {
      name,
      query,
      params,
      hash,
      scrollTop: 0,
      state: st,
      openedOrder: navStack.length || 1,
      timestamp: Date.now(),
    };
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
  } else if (_pendingNavAction?.type === "push") {
    // 明示的な go() による前進遷移:
    // 同一ハッシュ（例: 既に player 表示中に曲切替やミニプレイヤー再タップ）は重複 push せず状態のみ更新
    if (navStack.length > 0 && navStack[navStack.length - 1].hash === hash) {
      navStack[navStack.length - 1].timestamp = Date.now();
      if (_pendingNavAction.state) {
        navStack[navStack.length - 1].state = {
          ...(navStack[navStack.length - 1].state || {}),
          ..._pendingNavAction.state,
        };
      }
      _pendingNavAction = null;
      persistNavStack();
      return;
    }
    // 離脱元画面のスクロール位置を現在のスタック先頭に記録してから 1 段 push する
    // （途中の artist / album / playlist / library(search) は一切削除せず、過去の古い player 重複のみ除去して肥大化を防ぐ）
    if (navStack.length > 0 && _activeRoot) {
      navStack[navStack.length - 1].scrollTop = _activeRoot.scrollTop || 0;
    }
    if (name === "player") {
      navStack = navStack.filter((e) => e.name !== "player");
    }
    const st = { view: name, ...(params || {}), ...(_pendingNavAction.state || {}) };
    navStack.push({
      name,
      query,
      params,
      hash,
      scrollTop: 0,
      state: st,
      openedOrder: navStack.length + 1,
      timestamp: Date.now(),
    });
    _pendingNavAction = null;
  } else {
    // _pendingNavAction === null:
    // 1. すでに go() / back() で同期済みの hashchange イベント到着時は何もしない
    if (navStack.length > 0 && navStack[navStack.length - 1].hash === hash) {
      navStack[navStack.length - 1].timestamp = Date.now();
      persistNavStack();
      return;
    }

    // 2. ブラウザ/OSの「戻る」操作による遷移（1回の操作につき直前の1段だけ戻る）
    if (
      navStack.length >= 2 &&
      (navStack[navStack.length - 2].hash === hash || navStack[navStack.length - 2].name === name)
    ) {
      navStack.pop();
    } else {
      // 3. 初期表示または直接ハッシュ変更による新規遷移
      if (navStack.length > 0 && _activeRoot) {
        navStack[navStack.length - 1].scrollTop = _activeRoot.scrollTop || 0;
      }
      if (name === "player") {
        navStack = navStack.filter((e) => e.name !== "player");
      }
      const st = { view: name, ...(params || {}) };
      navStack.push({
        name,
        query,
        params,
        hash,
        scrollTop: 0,
        state: st,
        openedOrder: navStack.length + 1,
        timestamp: Date.now(),
      });
    }
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
  let query = "";
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) {
      query = qs;
      hash += `?${qs}`;
    }
  }
  const resolvedParams = params ? parseHashParams(query) : {};

  if (replace) {
    _pendingNavAction = { type: "replace", name, params: resolvedParams, state, hash };
    if (typeof history !== "undefined" && typeof history.replaceState === "function") {
      try {
        history.replaceState(null, "", hash);
      } catch {}
    }
    if (typeof location !== "undefined" && location.hash !== hash) {
      try { location.hash = hash; } catch {}
    }
    // replaceState は hashchange イベントを発火させないため直接同期・遷移を実行
    syncNavStackOnTransition(name, query, resolvedParams, hash);
    if (_activeRoot) {
      navigate(name, query, _activeRoot, _fallbackRoute);
    }
  } else {
    _pendingNavAction = { type: "push", name, params: resolvedParams, state, hash };
    // 同期的にスタックを更新（後続の hashchange 発火時は既に最上位が一致しているため二重 push にならない）
    syncNavStackOnTransition(name, query, resolvedParams, hash);
    if (typeof location !== "undefined" && location.hash !== hash) {
      location.hash = hash;
    } else if (state) {
      updateCurrentState(state);
    }
    if (_activeRoot) {
      navigate(name, query, _activeRoot, _fallbackRoute);
    }
  }
}

/**
 * ナビゲーションスタックに基づき直前の画面へ1段だけ戻る（統一バックハンドラ）
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
    const prevQuery = prev.query || "";
    const prevParams = prev.params || parseHashParams(prevQuery);
    _pendingNavAction = { type: "back", targetHash: prev.hash };

    // 1回の操作につき確実に1段だけスタックを戻し、直前の画面・クエリ・状態・スクロール位置を復元する
    syncNavStackOnTransition(prev.name, prevQuery, prevParams, prev.hash);

    if (typeof location !== "undefined" && location.hash !== prev.hash) {
      location.hash = prev.hash;
    }
    if (_activeRoot) {
      navigate(prev.name, prevQuery, _activeRoot, _fallbackRoute);
    }
    return prev;
  }

  // スタックが空または1件のみの場合、安全なフォールバック先へ replace で遷移
  navStack = [];
  persistNavStack();
  go(fallback, fallbackParams, { replace: true });
  return getCurrentStackEntry();
}
