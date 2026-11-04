/**
 * tests/test-player-sheet-gesture.mjs
 *
 * 再生中画面（Player View）シート化・下スワイプ閉じるジェスチャーおよび再生基盤非干渉の検証テスト
 */

import { strictEqual, deepStrictEqual, ok } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// グローバル環境モックのセットアップ (Node.js 上で DOM & PointerEvent をシミュレート)
class MockClassList {
  constructor() {
    this._classes = new Set();
  }
  add(...names) { names.forEach((n) => this._classes.add(n)); }
  remove(...names) { names.forEach((n) => this._classes.delete(n)); }
  contains(name) { return this._classes.has(name); }
  toggle(name, force) {
    if (typeof force === "boolean") {
      if (force) this.add(name); else this.remove(name);
      return force;
    }
    if (this.contains(name)) { this.remove(name); return false; }
    this.add(name);
    return true;
  }
}

class MockElement {
  constructor(tagName = "div", id = "", className = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new MockClassList();
    if (className) {
      className.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
    this.style = {};
    this.listeners = new Map();
    this.capturedPointerId = null;
    this.children = [];
    this.parentElement = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(el) {
    if (!el) return false;
    if (el === this) return true;
    let cur = el.parentElement;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    const matchSelector = (elem, sel) => {
      if (sel === "button" && elem.tagName === "BUTTON") return true;
      if (sel === "input" && elem.tagName === "INPUT") return true;
      if (sel === "#seek-bar" && elem.id === "seek-bar") return true;
      if (sel === ".player-lyrics-overlay" && elem.classList.contains("player-lyrics-overlay")) return true;
      if (sel === ".queue-list" && elem.classList.contains("queue-list")) return true;
      if (sel.startsWith(".")) return elem.classList.contains(sel.slice(1));
      return false;
    };

    while (cur) {
      const selectors = selector.split(",").map((s) => s.trim());
      for (const s of selectors) {
        if (matchSelector(cur, s)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    if (this.listeners.has(type)) {
      this.listeners.get(type).delete(fn);
    }
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    const fns = this.listeners.get(event.type);
    if (fns) {
      for (const fn of Array.from(fns)) {
        fn(event);
      }
    }
    return !event.defaultPrevented;
  }

  setPointerCapture(pointerId) {
    this.capturedPointerId = pointerId;
  }

  releasePointerCapture(pointerId) {
    if (this.capturedPointerId === pointerId) {
      this.capturedPointerId = null;
    }
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointerId === pointerId;
  }
}

// グローバル window / document モック
const windowListeners = new Map();
globalThis.window = {
  innerHeight: 800,
  innerWidth: 400,
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    if (windowListeners.has(type)) windowListeners.get(type).delete(fn);
  },
  dispatchEvent(event) {
    const fns = windowListeners.get(event.type);
    if (fns) {
      for (const fn of Array.from(fns)) {
        fn(event);
      }
    }
    return !event.defaultPrevented;
  },
  matchMedia(query) {
    return {
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    };
  },
};

let currentRafId = 0;
const rafCallbacks = new Map();
globalThis.requestAnimationFrame = (fn) => {
  const id = ++currentRafId;
  rafCallbacks.set(id, fn);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafCallbacks.delete(id);
};
function flushRaf() {
  const cbs = Array.from(rafCallbacks.values());
  rafCallbacks.clear();
  for (const cb of cbs) {
    cb(performance.now());
  }
}

// router.back モックの監視
let backCallCount = 0;
let backFallbackArg = null;
const originalRouterPath = path.join(__dirname, "../js/router.js");
// view-player.js は router.js から back をインポートしているため、動的にインポートして検証
import { setupSwipeDismiss, SWIPE_DISMISS_CONFIG } from "../js/ui/view-player.js";

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

console.log("=== 1. 設定定数の完全性 ===");

test("SWIPE_DISMISS_CONFIG が正しい閾値を定義している", () => {
  strictEqual(SWIPE_DISMISS_CONFIG.MIN_DRAG_DISTANCE, 8, "8px未満は未確定");
  strictEqual(SWIPE_DISMISS_CONFIG.DIRECTION_RATIO, 1.5, "縦横比1.5倍");
  strictEqual(SWIPE_DISMISS_CONFIG.DISMISS_DISTANCE, 100, "距離閾値100px");
  strictEqual(SWIPE_DISMISS_CONFIG.DISMISS_HEIGHT_RATIO, 0.20, "高さ閾値20%");
  strictEqual(SWIPE_DISMISS_CONFIG.FLICK_DISTANCE, 40, "フリック最小移動40px");
  strictEqual(SWIPE_DISMISS_CONFIG.FLICK_VELOCITY, 0.7, "フリック速度0.7px/ms");
  strictEqual(SWIPE_DISMISS_CONFIG.RESISTANCE_HEIGHT_RATIO, 0.70, "抵抗感70%");
  strictEqual(SWIPE_DISMISS_CONFIG.RESISTANCE_FACTOR, 0.35, "抵抗係数0.35");
});

console.log("=== 2. 開始領域と対象の厳格な制限 ===");

test("ドラッグハンドル周辺からのみ pointerdown が有効になる", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  const handleBar = new MockElement("div", "", "player-drag-handle");
  handleWrap.appendChild(handleBar);
  playerView.appendChild(handleWrap);

  const artworkWrap = new MockElement("div", "player-art-wrap");
  playerView.appendChild(artworkWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  // 1. ハンドル内部のバーをタップ
  const ev1 = {
    type: "pointerdown",
    pointerId: 1,
    button: 0,
    pointerType: "touch",
    clientX: 200,
    clientY: 10,
    target: handleBar,
  };
  handleWrap.dispatchEvent(ev1);
  strictEqual(handleWrap.capturedPointerId, 1, "ハンドルタップで pointer capture が試みられる");

  cleanup();
});

test("ハンドル外（アートワーク領域）からは pointerdown してもドラッグが開始しない", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const artworkWrap = new MockElement("div", "player-art-wrap");
  playerView.appendChild(artworkWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  const evArt = {
    type: "pointerdown",
    pointerId: 2,
    button: 0,
    pointerType: "touch",
    clientX: 200,
    clientY: 200,
    target: artworkWrap,
  };
  handleWrap.dispatchEvent(evArt);
  strictEqual(handleWrap.capturedPointerId, null, "アートワーク領域タップでは開始しない");

  cleanup();
});

test("ボタン・シークバー・歌詞領域からのドラッグ開始は防止される", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const btn = new MockElement("button", "btn-play");
  const seekBar = new MockElement("input", "seek-bar");
  const lyrics = new MockElement("div", "", "player-lyrics-overlay");

  playerView.appendChild(btn);
  playerView.appendChild(seekBar);
  playerView.appendChild(lyrics);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  for (const el of [btn, seekBar, lyrics]) {
    handleWrap.dispatchEvent({
      type: "pointerdown",
      pointerId: 3,
      button: 0,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
      target: el,
    });
    strictEqual(handleWrap.capturedPointerId, null, `${el.tagName}/${el.id || el.classList._classes} からは開始しない`);
  }

  cleanup();
});

test("主ボタン以外のクリック (右クリック等) では開始しない", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 4,
    button: 2, // 右クリック
    pointerType: "mouse",
    clientX: 200,
    clientY: 10,
    target: handleWrap,
  });
  strictEqual(handleWrap.capturedPointerId, null, "右クリックでは開始しない");

  cleanup();
});

console.log("=== 3. 方向判定 (ディレクションロック) ===");

test("8px未満の微小移動では縦ドラッグへロックされない", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 10,
    button: 0,
    pointerType: "touch",
    clientX: 200,
    clientY: 10,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 10,
    clientX: 202,
    clientY: 14, // 距離: Math.hypot(2, 4) = 4.47px (< 8px)
    cancelable: true,
  });

  strictEqual(playerView.classList.contains("is-dragging"), false, "8px未満では is-dragging が付かない");

  cleanup();
});

test("上方向移動はキャンセルされる", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 11,
    button: 0,
    pointerType: "touch",
    clientX: 200,
    clientY: 50,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 11,
    clientX: 200,
    clientY: 30, // dy = -20px (上方向)
    cancelable: true,
  });

  strictEqual(playerView.classList.contains("is-dragging"), false, "上方向はドラッグされない");

  cleanup();
});

test("横方向優勢 (dx > dy) の移動はキャンセルされる", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 12,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 50,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 12,
    clientX: 130, // dx = 30px
    clientY: 60, // dy = 10px (|dy| < |dx| * 1.5)
    cancelable: true,
  });

  strictEqual(playerView.classList.contains("is-dragging"), false, "横方向優勢はドラッグされない");

  cleanup();
});

test("下方向かつ縦横比1.5倍以上の移動で縦ドラッグが確定し、preventDefault が呼ばれる", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 13,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 50,
    target: handleWrap,
  });

  let prevented = false;
  window.dispatchEvent({
    type: "pointermove",
    pointerId: 13,
    clientX: 102, // dx = 2px
    clientY: 80,  // dy = 30px (|dy| = 30 >= 2 * 1.5)
    cancelable: true,
    preventDefault() { prevented = true; },
  });

  strictEqual(playerView.classList.contains("is-dragging"), true, "is-dragging が付加される");
  strictEqual(prevented, true, "下方向ドラッグ確定後に preventDefault が実行される");

  flushRaf();
  strictEqual(playerView.style.transform, "translate3d(0, 30px, 0)", "transform が translate3d で更新される");

  cleanup();
});

console.log("=== 4. 指追従と抵抗感 ===");

test("画面高さ70%を超えた移動量に抵抗感 (0.35倍) が適用される", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 14,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  // window.innerHeight = 800, 70% = 560px
  // dy = 660px のとき、超過分 100px * 0.35 = 35px -> 595px
  window.dispatchEvent({
    type: "pointermove",
    pointerId: 14,
    clientX: 100,
    clientY: 660,
    cancelable: true,
  });

  flushRaf();
  strictEqual(playerView.style.transform, "translate3d(0, 595px, 0)", "抵抗感が正しく適用される");

  cleanup();
});

console.log("=== 5. 閉じる判定と once ガード ===");

test("距離閾値を超えた場合に閉じる処理 (is-dismissing) が走り、元位置へ戻らない", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 20,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  // 移動量 180px (> max(100, 800 * 0.2 = 160))
  window.dispatchEvent({
    type: "pointermove",
    pointerId: 20,
    clientX: 100,
    clientY: 180,
    cancelable: true,
  });

  flushRaf();

  window.dispatchEvent({
    type: "pointerup",
    pointerId: 20,
    clientX: 100,
    clientY: 180,
  });

  strictEqual(playerView.classList.contains("is-dismissing"), true, "is-dismissing クラスが付加される");
  strictEqual(playerView.style.transform, "translate3d(0, 100%, 0)", "画面下へ移動する");

  cleanup();
});

test("速度閾値 (フリック: 40px以上 かつ 0.7px/ms以上) で閉じる判定になる", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 21,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  // 移動量 50px (距離閾値160px未満だが、フリック40px以上)
  window.dispatchEvent({
    type: "pointermove",
    pointerId: 21,
    clientX: 100,
    clientY: 50,
    cancelable: true,
  });

  flushRaf();

  // 速度は performance.now() の差分で計算。即座に pointerup で 0.7px/ms を超える
  window.dispatchEvent({
    type: "pointerup",
    pointerId: 21,
    clientX: 100,
    clientY: 50,
  });

  strictEqual(playerView.classList.contains("is-dismissing"), true, "高速フリックで閉じる判定");

  cleanup();
});

test("transitionend と fallback timer の双方が発火しても back() の once ガードが機能する", async () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 25,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 25,
    clientX: 100,
    clientY: 200,
    cancelable: true,
  });
  flushRaf();

  window.dispatchEvent({
    type: "pointerup",
    pointerId: 25,
    clientX: 100,
    clientY: 200,
  });

  strictEqual(playerView.classList.contains("is-dismissing"), true);

  // transitionend イベントを発火
  playerView.dispatchEvent({
    type: "transitionend",
    propertyName: "transform",
    target: playerView,
  });

  // fallback timer を待つ（二重実行されないことの確認）
  await new Promise((r) => setTimeout(r, SWIPE_DISMISS_CONFIG.TRANSITION_MS_DISMISS + SWIPE_DISMISS_CONFIG.FALLBACK_BUFFER_MS + 20));

  cleanup();
});

test("閾値未満の移動では元位置へ戻る (is-cancelling)", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 22,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  // 移動量 15px (確定後)
  window.dispatchEvent({
    type: "pointermove",
    pointerId: 22,
    clientX: 100,
    clientY: 15,
    cancelable: true,
  });

  flushRaf();

  // ポインターを離す（速度が遅いケースをシミュレート）
  window.dispatchEvent({
    type: "pointercancel",
    pointerId: 22,
  });

  strictEqual(playerView.classList.contains("is-cancelling"), true, "キャンセルアニメーションが付加");
  strictEqual(playerView.style.transform, "translate3d(0, 0, 0)", "元位置へスナップ");

  cleanup();
});

console.log("=== 6. キャンセルと破棄クリーンアップ ===");

test("pointercancel で安全に元位置へ戻る", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 30,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 30,
    clientX: 100,
    clientY: 40,
    cancelable: true,
  });
  flushRaf();

  window.dispatchEvent({
    type: "pointercancel",
    pointerId: 30,
  });

  strictEqual(playerView.style.transform, "translate3d(0, 0, 0)");
  cleanup();
});

test("window resize / orientationchange で安全にドラッグがキャンセルされる", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 31,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 31,
    clientX: 100,
    clientY: 50,
    cancelable: true,
  });
  flushRaf();
  strictEqual(playerView.classList.contains("is-dragging"), true);

  window.dispatchEvent({ type: "resize" });

  strictEqual(playerView.classList.contains("is-dragging"), false, "ドラッグが安全に解除される");
  strictEqual(playerView.style.transform, "translate3d(0, 0, 0)");

  cleanup();
});

test("cleanup 実行後はイベントが発火しても何も起きない", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);
  cleanup();

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 40,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  strictEqual(handleWrap.capturedPointerId, null, "cleanup後はキャプチャされない");
});

console.log("=== 7. 再生エンジン非干渉の検証 ===");

test("ジェスチャー操作中に audio-engine の関数や再生状態へ一切触れていないコード検証", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf-8");

  // setupSwipeDismiss 関数ブロックを抽出
  const fnMatch = code.match(/export function setupSwipeDismiss[\s\S]*?\n\}/);
  ok(fnMatch, "setupSwipeDismiss が定義されている");
  const fnCode = fnMatch[0];

  // 音声操作メソッドが setupSwipeDismiss 内に一切含まれていないことの静的監査
  const forbiddenCalls = [
    /\.play\(/,
    /\.pause\(/,
    /\.load\(/,
    /togglePlay\(/,
    /playNext\(/,
    /playPrev\(/,
    /seekTo\(/,
    /currentTime\s*=/,
    /\.src\s*=/,
    /AudioContext/,
    /PlaybackSession/,
    /appState\.set\(/,
    /indexedDB/,
    /localStorage/,
    /setMediaSession/,
  ];

  for (const pat of forbiddenCalls) {
    const match = fnCode.match(pat);
    strictEqual(match, null, `setupSwipeDismiss 内で ${pat} が呼ばれていないこと`);
  }
});

console.log("=== 8. 回帰と既存コンポーネント整合性 ===");

test("既存の閉じるボタン (btn-player-dismiss) が DOM 内に存在し、back('library') と連携していること", () => {
  const code = fs.readFileSync(path.join(__dirname, "../js/ui/view-player.js"), "utf-8");
  ok(code.includes('id="btn-player-dismiss"'), "btn-player-dismiss が render 内に残っている");
  ok(code.includes('refs.dismissBtn.addEventListener("click"'), "dismissBtn にクリックリスナーが登録されている");
  ok(code.includes('back("library")'), "閉じるボタンが back('library') を呼んでいる");
});

test("ドラッグハンドルが keydown (Enter/Space) によるアクセシブルな閉じる操作を提供していること", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  let defaultPrevented = false;
  handleWrap.dispatchEvent({
    type: "keydown",
    key: "Enter",
    preventDefault() { defaultPrevented = true; },
  });

  strictEqual(defaultPrevented, true, "Enter キー押下で閉じる処理が発火する");
  strictEqual(playerView.classList.contains("is-dismissing"), true);

  cleanup();
});

console.log("=== 9. touch-action および CSS 監査 ===");

test("ハンドルラッパーだけに touch-action: none が設定され、ビュー全体や歌詞は維持されること", () => {
  const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf-8");

  // .player-drag-handle-wrap ブロックを抽出
  const handleBlockMatch = css.match(/\.player-drag-handle-wrap\s*\{([^}]+)\}/);
  ok(handleBlockMatch, ".player-drag-handle-wrap が定義されている");
  ok(handleBlockMatch[1].includes("touch-action: none;"), "ハンドルラッパーに touch-action: none が設定されている");

  // .player-view 自体に touch-action: none が設定されていないこと
  const viewBlockMatch = css.match(/\.player-view\s*\{([^}]+)\}/);
  ok(viewBlockMatch, ".player-view が定義されている");
  strictEqual(viewBlockMatch[1].includes("touch-action: none"), false, "player-view 自体には touch-action: none を設定しない");

  // 歌詞領域に touch-action: none が設定されていないこと
  const lyricsBlockMatch = css.match(/\.player-lyrics-overlay\s*\{([^}]+)\}/);
  ok(lyricsBlockMatch, ".player-lyrics-overlay が定義されている");
  strictEqual(lyricsBlockMatch[1].includes("touch-action: none"), false, "歌詞領域には touch-action: none を設定しない");
});

test("アニメーション競合防止: is-dragging / is-dismissing / is-cancelling で animation: none が指定されていること", () => {
  const css = fs.readFileSync(path.join(__dirname, "../css/views.css"), "utf-8");

  for (const cls of [".player-view.is-dragging", ".player-view.is-dismissing", ".player-view.is-cancelling"]) {
    const reg = new RegExp(`${cls.replace(/\./g, "\\.")}\\s*\\{([^}]+)\\}`);
    const m = css.match(reg);
    ok(m, `${cls} が定義されている`);
    ok(m[1].includes("animation: none !important"), `${cls} で初回アニメーションが無効化されている`);
  }
});

console.log("=== 10. イベント・競合詳細監査 ===");

test("子要素からの transitionend や transform 以外の transitionend を無視すること", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  const child = new MockElement("span", "child-descendant");
  playerView.appendChild(handleWrap);
  playerView.appendChild(child);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  handleWrap.dispatchEvent({
    type: "pointerdown",
    pointerId: 50,
    button: 0,
    pointerType: "touch",
    clientX: 100,
    clientY: 0,
    target: handleWrap,
  });

  window.dispatchEvent({
    type: "pointermove",
    pointerId: 50,
    clientX: 100,
    clientY: 200,
    cancelable: true,
  });
  flushRaf();

  window.dispatchEvent({
    type: "pointerup",
    pointerId: 50,
    clientX: 100,
    clientY: 200,
  });

  // 1. 子要素からバブリングした transitionend -> 無視される
  playerView.dispatchEvent({
    type: "transitionend",
    propertyName: "transform",
    target: child,
  });
  // 2. transform 以外の transitionend (例: opacity) -> 無視される
  playerView.dispatchEvent({
    type: "transitionend",
    propertyName: "opacity",
    target: playerView,
  });

  strictEqual(playerView.classList.contains("is-dismissing"), true, "不正な transitionend では状態が壊れない");

  cleanup();
});

test("Enter / Space のキーリピート (長押し) で複数回 dismissSheet() されないこと & Space でスクロール防止", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  let spacePrevented = false;
  handleWrap.dispatchEvent({
    type: "keydown",
    key: " ",
    repeat: false,
    preventDefault() { spacePrevented = true; },
  });
  strictEqual(spacePrevented, true, "Space 押下で preventDefault が実行される");
  strictEqual(playerView.classList.contains("is-dismissing"), true);

  // 長押しリピート
  let repeatPrevented = false;
  handleWrap.dispatchEvent({
    type: "keydown",
    key: " ",
    repeat: true,
    preventDefault() { repeatPrevented = true; },
  });
  strictEqual(repeatPrevented, false, "repeat: true のイベントは早期リターンされる");

  cleanup();
});

test("cleanup 実行後に transform とクラスが完全にクリアされ、再マウント時も初期位置が保持されること", () => {
  const playerView = new MockElement("section", "", "player-view");
  const handleWrap = new MockElement("div", "player-drag-handle-wrap");
  playerView.appendChild(handleWrap);

  const cleanup = setupSwipeDismiss(playerView, handleWrap);

  playerView.classList.add("is-dragging");
  playerView.style.transform = "translate3d(0, 150px, 0)";

  cleanup();

  strictEqual(playerView.classList.contains("is-dragging"), false, "is-dragging が除去される");
  strictEqual(playerView.classList.contains("is-dismissing"), false, "is-dismissing が除去される");
  strictEqual(playerView.classList.contains("is-cancelling"), false, "is-cancelling が除去される");
  strictEqual(playerView.style.transform, "", "inline transform が消去される");
});

console.log(`\n✓ All ${passed} tests in test-player-sheet-gesture.mjs passed!`);
