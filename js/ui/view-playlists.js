/**
 * プレイリスト一覧画面
 *
 * - 新規プレイリスト作成（名前入力 + 作成ボタン）
 * - 一覧表示（左: ドラッグ並び替えハンドル、右: ゴミ箱）
 * - タップでプレイリスト詳細画面へ遷移
 */

import { appState } from "../state.js";
import { getAllPlaylists, savePlaylist, deletePlaylist, setPlaylistsOrder } from "../store/library-db.js";
import { go } from "../router.js";
import { toast, confirm, escapeHtml, escapeAttr } from "./components.js";

let playlistsCache = [];
let dragState = null;

export async function mount(root) {
  // ドラッグ中に画面遷移し pointerup/cancel を取りこぼした場合、module スコープの
  // dragState が残置する。次回マウント後の stray pointermove/up で detached な
  // placeholder を参照して例外になるのを防ぐため、mount 開始時に必ずクリアする。
  resetDragState();

  root.innerHTML = render();
  const refs = collectRefs(root);

  await reloadPlaylists(refs);

  refs.createBtn.addEventListener("click", () => createPlaylist(refs));
  refs.nameInput.addEventListener("keydown", (e) => {
    // IME 変換確定の Enter（日本語のプレイリスト名入力など）で誤作成しないよう、
    // composition 中は無視する（components.js のモーダルと同じ対策）。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") createPlaylist(refs);
  });

  refs.list.addEventListener("click", (e) => onListClick(e, refs));
  const cleanupReorder = installReorder(refs);

  // 「現在再生中のプレイリスト」状態を購読 → 該当行をハイライト
  const unsubPlaylist = appState.subscribe(["currentPlaylistId"], () => renderList(refs));

  return () => {
    if (cleanupReorder) cleanupReorder();
    if (unsubPlaylist) unsubPlaylist();
  };
}

function render() {
  return `
    <section class="playlists-view">
      <div class="library-add">
        <div class="library-add-title">新規プレイリスト</div>
        <div class="playlist-create-row">
          <input type="text" id="new-pl-name" placeholder="プレイリスト名" maxlength="100" autocomplete="off" />
          <button class="btn primary" id="btn-create-pl">作成</button>
        </div>
      </div>

      <div class="library-stats" id="pl-stats"></div>

      <ul class="track-list" id="playlist-list"></ul>
    </section>
  `;
}

function collectRefs(root) {
  return {
    nameInput: root.querySelector("#new-pl-name"),
    createBtn: root.querySelector("#btn-create-pl"),
    stats: root.querySelector("#pl-stats"),
    list: root.querySelector("#playlist-list"),
  };
}

async function reloadPlaylists(refs) {
  playlistsCache = await getAllPlaylists();
  // 並び順: order（手動）優先、無ければ createdAt 昇順
  playlistsCache.sort((a, b) => orderOf(a) - orderOf(b));
  renderList(refs);
}

function orderOf(pl) {
  if (typeof pl.order === "number") return pl.order;
  return pl.createdAt || 0;
}

function renderList(refs) {
  // ★ ドラッグ並び替え中は DOM (浮かせた行・プレースホルダ) を直接操作中なので、
  //   全再描画すると進行中のドラッグが壊れる。currentPlaylistId 購読は再生中の
  //   プレイリストが変わる/終わるたびに renderList を呼ぶため、ここで弾く。
  //   (onDragEnd は dragState=null 後に renderList を呼ぶので通る)
  if (dragState) return;
  const playingId = appState.get().currentPlaylistId;
  if (playlistsCache.length === 0) {
    refs.list.innerHTML = `<li class="empty-state">プレイリストがまだありません。<br/>上の入力欄から作成してください。</li>`;
  } else {
    refs.list.innerHTML = playlistsCache.map((pl) => plRowHtml(pl, playingId)).join("");
  }
  refs.stats.textContent = `${playlistsCache.length} 件のプレイリスト`;
}

function plRowHtml(pl, playingId) {
  const count = (pl.trackIds || []).length;
  const isPlaying = playingId === pl.id;
  const playingMark = isPlaying
    ? `<span class="np-pulse" title="再生中" aria-label="再生中">🔊</span>`
    : ``;
  return `
    <li class="track-row playlist-row is-manual ${isPlaying ? "is-playing" : ""}" data-id="${escapeAttr(pl.id)}">
      <span class="drag-handle" data-act="handle" role="button" tabindex="0" aria-label="並び替え" title="ドラッグで並び替え">☰</span>
      <div class="track-info">
        <div class="track-title">${playingMark}${escapeHtml(pl.name)}</div>
        <div class="track-sub">${count} 曲</div>
      </div>
      <div class="track-actions">
        <button class="icon-btn" data-act="delete" title="削除">🗑</button>
      </div>
    </li>
  `;
}

// escapeHtml=テキストノード用、escapeAttr=属性値用（どちらも components.js で null-safe）

async function createPlaylist(refs) {
  const name = (refs.nameInput.value || "").trim();
  if (!name) {
    toast("プレイリスト名を入力してください", "err");
    return;
  }
  // ID: 衝突しにくいランダム文字列
  const id = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 既存の最小 order より小さい値をセットして「先頭」に配置
  const minOrder = playlistsCache.reduce((m, p) => Math.min(m, orderOf(p)), Number.POSITIVE_INFINITY);
  const newOrder = isFinite(minOrder) ? (minOrder - 1000) : 1000;
  const pl = {
    id,
    name,
    trackIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: newOrder,
  };
  try {
    await savePlaylist(pl);
    refs.nameInput.value = "";
    await reloadPlaylists(refs);
    toast(`「${name}」を作成しました`, "ok");
  } catch (e) {
    console.warn("create playlist failed", e);
    toast("作成に失敗しました", "err");
  }
}

async function onListClick(e, refs) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) {
    // 行クリックで詳細画面へ。ハンドル領域は除外。
    if (e.target.closest('[data-act="handle"]')) return;
    const row = e.target.closest(".track-row");
    if (row) {
      go("playlist", { id: row.dataset.id });
    }
    return;
  }
  const row = btn.closest(".track-row");
  if (!row) return;
  const id = row.dataset.id;
  const act = btn.dataset.act;
  const pl = playlistsCache.find((p) => p.id === id);
  if (!pl) return;

  if (act === "delete") {
    const yes = await confirm(
      `プレイリスト「${pl.name}」を削除しますか？\nプレイリスト内の曲データ自体は残ります。`,
      { danger: true, okLabel: "削除" }
    );
    if (!yes) return;
    try {
      await deletePlaylist(id);
      playlistsCache = playlistsCache.filter((p) => p.id !== id);
      // 再生中のプレイリストを削除した場合、再生コンテキストをクリアする。
      // さもないとライブラリ画面のバナーが削除済みプレイリストへのリンクを
      // 表示し続ける（音声の再生キューは別管理なので再生自体は継続する）。
      if (appState.get().currentPlaylistId === id) {
        appState.set({ currentPlaylistId: null, currentPlaylistName: null });
      }
      renderList(refs);
      toast("削除しました", "ok");
    } catch (e) {
      console.warn("delete playlist failed", e);
      toast("削除に失敗しました", "err");
    }
  }
}

/* ============ 手動並び替え（Pointer Events 統一）============ */

function installReorder(refs) {
  const list = refs.list;
  if (!list) return () => {};
  const onListDown = (e) => onDragStart(e, refs);
  const onDocMove = (e) => onDragMove(e);
  const onDocEnd = () => onDragEnd(refs);
  list.addEventListener("pointerdown", onListDown);
  document.addEventListener("pointermove", onDocMove);
  document.addEventListener("pointerup", onDocEnd);
  document.addEventListener("pointercancel", onDocEnd);
  return () => {
    list.removeEventListener("pointerdown", onListDown);
    document.removeEventListener("pointermove", onDocMove);
    document.removeEventListener("pointerup", onDocEnd);
    document.removeEventListener("pointercancel", onDocEnd);
    // unmount 時にドラッグ中だった場合、行スタイルとプレースホルダを復元して
    // dragState を解除する (pointerup 取りこぼし対策、view-library と同じ)。
    resetDragState();
  };
}

/**
 * dragState を null に戻し、関連する DOM 残骸も掃除する。
 * (ドラッグ中の中断や画面遷移で pointerup/cancel を取りこぼした場合の安全網)
 */
function resetDragState() {
  if (!dragState) return;
  const { row, placeholder, handle, pointerId } = dragState;
  try { handle && handle.releasePointerCapture && handle.releasePointerCapture(pointerId); } catch {}
  if (row) {
    row.classList.remove("is-dragging");
    row.style.position = "";
    row.style.left = "";
    row.style.top = "";
    row.style.width = "";
    row.style.zIndex = "";
    row.style.pointerEvents = "";
  }
  if (placeholder && placeholder.parentNode) {
    if (row && row.parentNode !== placeholder.parentNode) {
      placeholder.parentNode.insertBefore(row, placeholder);
    }
    placeholder.remove();
  }
  dragState = null;
}

function onDragStart(e, refs) {
  // 既にドラッグ中なら2本目の指(別 pointerId)の pointerdown を無視する。無視しないと
  //   dragState が上書きされ、1本目の浮遊行/プレースホルダが残置する(マルチタッチ安全網)。
  if (dragState) return;
  if (e.button !== undefined && e.button !== 0) return;
  const handle = e.target.closest('[data-act="handle"]');
  if (!handle) return;
  const row = handle.closest(".track-row");
  if (!row) return;
  e.preventDefault();
  try { handle.setPointerCapture(e.pointerId); } catch {}
  const rect = row.getBoundingClientRect();
  dragState = {
    id: row.dataset.id,
    row,
    offsetY: e.clientY - rect.top,
    placeholder: null,
    initialIndex: Array.from(refs.list.children).indexOf(row),
    handle,
    pointerId: e.pointerId,
  };
  const ph = document.createElement("li");
  ph.className = "track-row drag-placeholder";
  ph.style.height = rect.height + "px";
  ph.style.border = "2px dashed var(--accent)";
  ph.style.background = "transparent";
  ph.style.borderRadius = "8px";
  row.parentNode.insertBefore(ph, row);
  dragState.placeholder = ph;
  row.classList.add("is-dragging");
  row.style.position = "fixed";
  row.style.left = rect.left + "px";
  row.style.width = rect.width + "px";
  row.style.zIndex = "1000";
  row.style.pointerEvents = "none";
  moveRowTo(row, e.clientY, dragState.offsetY);
}

function onDragMove(e) {
  if (!dragState) return;
  if (dragState.pointerId !== undefined && e.pointerId !== dragState.pointerId) return;
  e.preventDefault();
  moveRowTo(dragState.row, e.clientY, dragState.offsetY);
  const list = dragState.placeholder.parentNode;
  const siblings = Array.from(list.children).filter(
    (c) => c !== dragState.row && c !== dragState.placeholder && c.classList.contains("track-row")
  );
  let inserted = false;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      list.insertBefore(dragState.placeholder, sib);
      inserted = true;
      break;
    }
  }
  if (!inserted) list.appendChild(dragState.placeholder);
}

function moveRowTo(row, clientY, offsetY) {
  row.style.top = (clientY - offsetY) + "px";
}

async function onDragEnd(refs) {
  if (!dragState) return;
  const { row, placeholder, id, initialIndex, handle, pointerId } = dragState;
  try { handle && handle.releasePointerCapture && handle.releasePointerCapture(pointerId); } catch {}
  row.classList.remove("is-dragging");
  row.style.position = "";
  row.style.left = "";
  row.style.top = "";
  row.style.width = "";
  row.style.zIndex = "";
  row.style.pointerEvents = "";
  placeholder.parentNode.insertBefore(row, placeholder);
  placeholder.remove();

  const list = row.parentNode;
  const ids = Array.from(list.children)
    // drag-placeholder も class="track-row ..." を持つため dataset.id の有無でも絞り、
    //   マルチタッチ等で残置した placeholder の undefined が並び順 entries に混入しないようにする。
    .filter((c) => c.classList.contains("track-row") && c.dataset.id)
    .map((c) => c.dataset.id);

  dragState = null;
  const newIndex = ids.indexOf(id);
  if (newIndex === initialIndex) return;

  // 変更分の order を【単一トランザクション】で一括保存する(件数ぶんの個別 tx だと iOS の
  //   一過性 abort で「どれか1件が失敗」しやすかったため、失敗機会を N→1 に減らし原子化)。
  try {
    const entries = [];
    for (let i = 0; i < ids.length; i++) {
      const pid = ids[i];
      const newOrder = (i + 1) * 1000;
      const cached = playlistsCache.find((p) => p.id === pid);
      if (cached && cached.order !== newOrder) entries.push([pid, newOrder]);
    }
    if (entries.length) await setPlaylistsOrder(entries);
    // DB 反映(原子的)成功後にキャッシュの order もまとめて更新する。
    for (const [pid, newOrder] of entries) {
      const cached = playlistsCache.find((p) => p.id === pid);
      if (cached) cached.order = newOrder;
    }
    toast("並び順を保存しました", "ok");
  } catch (e) {
    console.warn("並び順保存失敗", e);
    toast("並び順の保存に失敗しました", "err");
  }
  // 並び順ソートし直して再描画
  playlistsCache.sort((a, b) => orderOf(a) - orderOf(b));
  renderList(refs);
}
