/**
 * ハッシュベースの極小 SPA ルーター
 *
 * - GitHub Pages のサブパス配信に強い（path モードと異なり 404 リライト不要）
 * - 各ルートは「マウント関数」と「アンマウント関数」を持つ
 * - 同じルート + 同じクエリ文字列に遷移しても再マウントしない（音声再生継続のため）
 * - クエリ文字列付き遷移をサポート: #/playlist?id=xxx など
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

/**
 * ルートを登録する
 * @param {string} name        例: "player"
 * @param {(root: HTMLElement) => (Promise<void>|void|() => void)} handler
 */
export function register(name, handler) {
  routes.set(name, handler);
}

/**
 * ルーターの起動
 */
export function start(root, fallback = "player") {
  const handle = async () => {
    const hash = location.hash || "";
    // 形式: #/name または #/name?query
    const m = hash.match(/^#\/([^?]+)(?:\?(.*))?$/);
    const name = (m && m[1]) || fallback;
    const query = (m && m[2]) || "";
    await navigate(name, query, root, fallback);
  };
  window.addEventListener("hashchange", handle);
  if (!location.hash) {
    location.hash = `#/${fallback}`;
  } else {
    handle();
  }
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
      root.scrollTop = 0;
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
 */
export function go(name, params) {
  let hash = `#/${name}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) hash += `?${qs}`;
  }
  location.hash = hash;
}
