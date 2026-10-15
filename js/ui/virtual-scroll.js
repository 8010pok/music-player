/**
 * 超軽量 仮想スクロール (Virtual Scroll) エンジン
 *
 * - 数千〜数万曲のリストでも DOM 要素数を最小限（可視領域 + 前後バッファのみ）に抑え、
 *   iOS Safari やモバイル端末でのスクロールの引っかかりやメモリ消費を劇的に解消
 * - paddingTop / paddingBottom 方式による余計なスペーサー要素不要のクリーン設計
 * - requestAnimationFrame スロットリングによる 60fps 追従
 * - 少数アイテム（閾値未満）やドラッグ並べ替えモード時は全行レンダリングへ自動バイパス
 */

export class VirtualList {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container - リスト要素 (ul / ol / div 等)
   * @param {number} [options.itemHeight=58] - 1行あたりの推定高さ (px)
   * @param {number} [options.buffer=8] - 表示領域前後の先読みバッファ行数
   * @param {number} [options.minItemsForVirtual=60] - 仮想スクロールを有効にする最小件数
   * @param {(item: any, index: number) => string} options.renderItem - 1行のHTML文字列生成関数
   * @param {HTMLElement|Window} [options.scrollParent=window] - スクロール親要素
   */
  constructor({
    container,
    itemHeight = 58,
    buffer = 8,
    minItemsForVirtual = 60,
    renderItem,
    scrollParent = typeof window !== "undefined" ? window : null,
  }) {
    this.container = container;
    this.itemHeight = itemHeight;
    this.buffer = buffer;
    this.minItemsForVirtual = minItemsForVirtual;
    this.renderItem = renderItem;
    this.scrollParent = scrollParent;

    this.items = [];
    this.isBypassed = false;
    this.lastStartIndex = -1;
    this.lastEndIndex = -1;
    this.rafId = null;

    this.onScroll = this.onScroll.bind(this);
    this.attach();
  }

  attach() {
    const isWin = typeof window !== "undefined";
    const target = (this.scrollParent === (isWin ? window : null)) && isWin ? window : this.scrollParent;
    if (target && target.addEventListener) {
      target.addEventListener("scroll", this.onScroll, { passive: true });
    }
    if (isWin) {
      window.addEventListener("resize", this.onScroll, { passive: true });
    }
  }

  destroy() {
    if (this.rafId) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.rafId);
      }
      this.rafId = null;
    }
    const isWin = typeof window !== "undefined";
    const target = (this.scrollParent === (isWin ? window : null)) && isWin ? window : this.scrollParent;
    if (target && target.removeEventListener) {
      target.removeEventListener("scroll", this.onScroll);
    }
    if (isWin) {
      window.removeEventListener("resize", this.onScroll);
    }
    if (this.container && this.container.style) {
      this.container.style.paddingTop = "";
      this.container.style.paddingBottom = "";
    }
  }

  /**
   * アイテム一覧の更新と再描画
   * @param {any[]} items
   * @param {object} [opts]
   * @param {boolean} [opts.bypass=false] - 手動並べ替え等で全件レンダリングを強制する場合
   */
  setItems(items, { bypass = false } = {}) {
    this.items = Array.isArray(items) ? items : [];
    this.isBypassed = bypass || this.items.length < this.minItemsForVirtual;
    this.lastStartIndex = -1;
    this.lastEndIndex = -1;
    this.render();
  }

  onScroll() {
    if (this.isBypassed) return;
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  render() {
    if (!this.container) return;

    // バイパスモード（少数件数またはドラッグ中）: 通常の全件描画
    if (this.isBypassed) {
      this.container.style.paddingTop = "";
      this.container.style.paddingBottom = "";
      this.container.innerHTML = this.items.map((item, idx) => this.renderItem(item, idx)).join("");
      return;
    }

    const total = this.items.length;
    if (total === 0) {
      this.container.style.paddingTop = "";
      this.container.style.paddingBottom = "";
      this.container.innerHTML = "";
      return;
    }

    // スクロール位置と可視範囲の計算
    const rect = this.container.getBoundingClientRect ? this.container.getBoundingClientRect() : { top: 0, bottom: 600 };
    const viewportHeight = typeof window !== "undefined"
      ? (window.innerHeight || document.documentElement?.clientHeight || 800)
      : 800;

    // コンテナの上端からの相対スクロールオフセット
    const relativeTop = Math.max(0, -rect.top);
    const visibleHeight = Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top);

    const startIndex = Math.max(0, Math.floor(relativeTop / this.itemHeight) - this.buffer);
    const endIndex = Math.min(total, Math.ceil((relativeTop + Math.max(viewportHeight, visibleHeight)) / this.itemHeight) + this.buffer);

    // インデックスに変化がなければ DOM 更新をスキップ（高速化）
    if (startIndex === this.lastStartIndex && endIndex === this.lastEndIndex) {
      return;
    }

    this.lastStartIndex = startIndex;
    this.lastEndIndex = endIndex;

    const paddingTop = startIndex * this.itemHeight;
    const paddingBottom = Math.max(0, (total - endIndex) * this.itemHeight);

    this.container.style.paddingTop = `${paddingTop}px`;
    this.container.style.paddingBottom = `${paddingBottom}px`;

    const slice = this.items.slice(startIndex, endIndex);
    this.container.innerHTML = slice.map((item, i) => this.renderItem(item, startIndex + i)).join("");
  }

  /**
   * 指定したインデックスの曲へスムーズスクロール
   * @param {number} index
   */
  scrollToIndex(index) {
    if (index < 0 || index >= this.items.length || !this.container) return;
    const isWin = typeof window !== "undefined";
    const containerTop = (this.container.getBoundingClientRect ? this.container.getBoundingClientRect().top : 0) + (isWin ? window.scrollY : 0);
    const targetScrollY = containerTop + (index * this.itemHeight);
    if (isWin && typeof window.scrollTo === "function") {
      window.scrollTo({
        top: Math.max(0, targetScrollY - 60), // ヘッダー分の余裕を持たせる
        behavior: "smooth",
      });
    }
  }
}
