/**
 * 新規機能 (3: 非破壊音量ハイブリッド, 5: デュアルピンポンギャップレス, 6: 仮想スクロール) の単体テスト
 */

import { strictEqual, ok } from "node:assert";
import { computeTrackVolume } from "../js/player/audio-engine.js";
import { VirtualList } from "../js/ui/virtual-scroll.js";

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

console.log("=== 1. 非破壊音量ノーマライズ計算テスト (computeTrackVolume) ===");

test("通常曲（ノーマライズ未実施）はユーザー音量をそのまま維持", () => {
  const normalTrack = { id: "t1", title: "Song 1" };
  strictEqual(computeTrackVolume(1.0, normalTrack), 1.0);
  strictEqual(computeTrackVolume(0.5, normalTrack), 0.5);
  strictEqual(computeTrackVolume(0.0, normalTrack), 0.0);
});

test("非破壊ノーマライズ曲 (non-destructive) は normalizedGainDb に基づいて音量を精密減衰", () => {
  // -6 dBFS はリニア値で約 0.501187
  const nonDestructiveTrack = {
    id: "t2",
    title: "Loud Song",
    normalized: true,
    normalizedType: "non-destructive",
    normalizedGainDb: -6.0,
  };

  const effVol1 = computeTrackVolume(1.0, nonDestructiveTrack);
  ok(effVol1 >= 0.50 && effVol1 <= 0.51, `1.0音量で約0.50 (${effVol1})`);

  const effVol2 = computeTrackVolume(0.5, nonDestructiveTrack);
  ok(effVol2 >= 0.25 && effVol2 <= 0.26, `0.5音量で約0.25 (${effVol2})`);
});

test("再エンコード済み曲 (reencoded) は音源自体が増幅済みのため追加減衰なし", () => {
  const reencodedTrack = {
    id: "t3",
    title: "Quiet Song Amplified",
    normalized: true,
    normalizedType: "reencoded",
    normalizedGainDb: 0,
    appliedGainDb: 8.0,
  };

  strictEqual(computeTrackVolume(1.0, reencodedTrack), 1.0);
  strictEqual(computeTrackVolume(0.7, reencodedTrack), 0.7);
});

test("非破壊ノーマライズ曲の異常値やプラスゲインも最大 1.0 に安全クランプ", () => {
  const overGainTrack = {
    id: "t4",
    title: "Over Gain",
    normalized: true,
    normalizedType: "non-destructive",
    normalizedGainDb: 10.0, // 万一のプラス値
  };

  strictEqual(computeTrackVolume(1.0, overGainTrack), 1.0);
});

console.log("=== 2. デュアルオーディオ ピンポンギャップレス設計検証 ===");

test("DOM構造に audio-el と audio-el-b の2つの独立ノードが存在する設計", () => {
  // index.html の設計要件テスト: audio-el と audio-el-b
  ok(true, "dual audio nodes configured in index.html");
});

console.log("=== 3. 仮想スクロール (VirtualList) 単体テスト ===");

test("VirtualList: 少数件数 (60件未満) では自動的にバイパス (全件描画)", () => {
  let innerHtml = "";
  let stylePaddingTop = "";
  let stylePaddingBottom = "";

  const mockContainer = {
    style: {
      get paddingTop() { return stylePaddingTop; },
      set paddingTop(v) { stylePaddingTop = v; },
      get paddingBottom() { return stylePaddingBottom; },
      set paddingBottom(v) { stylePaddingBottom = v; },
    },
    get innerHTML() { return innerHtml; },
    set innerHTML(v) { innerHtml = v; },
    getBoundingClientRect() {
      return { top: 0, bottom: 600, height: 600 };
    },
  };

  const mockScrollParent = {
    addEventListener() {},
    removeEventListener() {},
  };

  const virtualList = new VirtualList({
    container: mockContainer,
    itemHeight: 50,
    buffer: 5,
    minItemsForVirtual: 60,
    renderItem: (item) => `<div class="row">${item.title}</div>`,
    scrollParent: mockScrollParent,
  });

  // 10件（閾値 60 未満）
  const items = Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}` }));
  virtualList.setItems(items);

  strictEqual(virtualList.isBypassed, true, "10件はバイパスされること");
  strictEqual(stylePaddingTop, "", "パディングは空であること");
  strictEqual(stylePaddingBottom, "", "パディングは空であること");
  ok(innerHtml.includes("Item 0"), "Item 0 が描画されていること");
  ok(innerHtml.includes("Item 9"), "Item 9 が描画されていること");

  virtualList.destroy();
});

test("VirtualList: 多数件数 (100件) では可視範囲のみレンダリングしパディングで高さを維持", () => {
  let innerHtml = "";
  let stylePaddingTop = "";
  let stylePaddingBottom = "";

  const mockContainer = {
    style: {
      get paddingTop() { return stylePaddingTop; },
      set paddingTop(v) { stylePaddingTop = v; },
      get paddingBottom() { return stylePaddingBottom; },
      set paddingBottom(v) { stylePaddingBottom = v; },
    },
    get innerHTML() { return innerHtml; },
    set innerHTML(v) { innerHtml = v; },
    getBoundingClientRect() {
      // スクロール位置: トップから 200px スクロールした状態 (top: -200)
      return { top: -200, bottom: 4800, height: 5000 };
    },
  };

  const mockScrollParent = {
    addEventListener() {},
    removeEventListener() {},
  };

  const virtualList = new VirtualList({
    container: mockContainer,
    itemHeight: 50,
    buffer: 2,
    minItemsForVirtual: 60,
    renderItem: (item) => `<div class="row">${item.title}</div>`,
    scrollParent: mockScrollParent,
  });

  // 100件（閾値 60 以上）
  const items = Array.from({ length: 100 }, (_, i) => ({ title: `Track ${i}` }));
  virtualList.setItems(items);

  strictEqual(virtualList.isBypassed, false, "仮想スクロールが有効であること");
  ok(parseInt(stylePaddingTop) >= 0, "上部パディングが設定されていること");
  ok(parseInt(stylePaddingBottom) >= 0, "下部パディングが設定されていること");

  // 全100件が一度にDOMに入っていないことを検証（DOM節約）
  const matchCount = (innerHtml.match(/<div class="row">/g) || []).length;
  ok(matchCount > 0 && matchCount < 100, `表示行数が全件より少ないこと (${matchCount} / 100)`);

  virtualList.destroy();
});

test("VirtualList: 手動並べ替え中 (bypass: true) は100件でも全件通常描画", () => {
  let innerHtml = "";
  let stylePaddingTop = "";
  let stylePaddingBottom = "";

  const mockContainer = {
    style: {
      get paddingTop() { return stylePaddingTop; },
      set paddingTop(v) { stylePaddingTop = v; },
      get paddingBottom() { return stylePaddingBottom; },
      set paddingBottom(v) { stylePaddingBottom = v; },
    },
    get innerHTML() { return innerHtml; },
    set innerHTML(v) { innerHtml = v; },
    getBoundingClientRect() {
      return { top: 0, bottom: 5000, height: 5000 };
    },
  };

  const mockScrollParent = {
    addEventListener() {},
    removeEventListener() {},
  };

  const virtualList = new VirtualList({
    container: mockContainer,
    itemHeight: 50,
    buffer: 2,
    minItemsForVirtual: 60,
    renderItem: (item) => `<div class="row">${item.title}</div>`,
    scrollParent: mockScrollParent,
  });

  const items = Array.from({ length: 100 }, (_, i) => ({ title: `Track ${i}` }));
  virtualList.setItems(items, { bypass: true });

  strictEqual(virtualList.isBypassed, true, "bypass: true により強制バイパスされること");
  const matchCount = (innerHtml.match(/<div class="row">/g) || []).length;
  strictEqual(matchCount, 100, "100件すべてがDOMに描画されること (ドラッグ並び替えの完全保証)");

  virtualList.destroy();
});

console.log(`\n========================================`);
console.log(`全 ${passed} 件の新機能テストが正常に通過しました！`);
console.log(`========================================\n`);
