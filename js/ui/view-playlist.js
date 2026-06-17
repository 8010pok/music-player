/**
 * プレイリスト詳細画面
 *
 * - ヘッダー: 戻る / プレイリスト名 (✏で編集) / 曲数+合計時間
 * - アクション (2×2 グリッド):
 *     ▶ すべて再生           🔀 シャッフル再生
 *     🔁 リピート (ON/OFF)    ＋ 曲を追加
 *   - 「すべて再生」: シャッフル OFF を強制してから先頭から再生
 *   - 「シャッフル再生」: シャッフル ON を強制してから再生
 *   - 「リピート」: グローバル repeatMode を "none" ↔ "all" でトグル
 *                  (プレイヤー画面の表示と同期。"one" だった場合は OFF に揃える)
 * - 曲一覧: ドラッグで並び替え、✕ でプレイリストから外す、行タップでそこから再生
 *           行タップ時のシャッフル挙動は現状の「グローバル shuffle に従う」を維持
 * - 削除済み曲 (ライブラリから消えた曲) は trackIds に残っていても自動的に除外
 */

import { appState } from "../state.js";
import {
  getPlaylist,
  updatePlaylist,
  getAllTracks,
  removeTracksFromPlaylist,
} from "../store/library-db.js";
import { setQueueAndPlay, setShuffleMode, setRepeatMode } from "../player/audio-engine.js";
import { go } from "../router.js";
import { toast, confirm, promptForm, escapeHtml } from "./components.js";

/**
 * プレイリスト合計時間の表示用フォーマッタ。
 *   共有 formatTime(曲尺) は mm:ss 固定で、合計が1時間を超えると "75:30" のように分が肥大して
 *   可読性を欠くため、合計専用に1時間以上は h:mm:ss へ繰り上げる(他画面の曲尺表示には影響させない)。
 */
function formatTotal(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
import { getArtworkUrl } from "./artwork-cache.js";

let playlist = null;
let allTracksMap = new Map();
let tracksInOrder = [];
let dragState = null;

export async function mount(root) {
  // ドラッグ中の画面遷移で pointerup/cancel を取りこぼした場合の残置 dragState を
  // クリア (次回マウント後の stray pointer イベントによる例外を防ぐ安全網)。
  resetDragState();

  const params = parseQuery();
  const id = params.id;
  if (!id) {
    go("playlists");
    return () => {};
  }
  playlist = await getPlaylist(id);
  if (!playlist) {
    toast("プレイリストが見つかりません", "err");
    // このプレイリストが再生中コンテキストだった場合、消えた以上ライブラリ画面の
    // バナーが壊れたリンクを出し続けないようコンテキストをクリアする。
    // (別の再生中プレイリストの文脈を誤って消さないよう id 一致時のみ)
    if (appState.get().currentPlaylistId === id) {
      appState.set({ currentPlaylistId: null, currentPlaylistName: null });
    }
    go("playlists");
    return () => {};
  }
  await reloadTracks();

  // await(getPlaylist/reloadTracks) 中に別ルートへ遷移していたら、共有 #view-root には
  // 既に別ビューが描画済み。ここで上書きすると現在ビューを破壊するため、プレイリスト
  // 詳細ルートに留まっているときだけ描画する(view-settings mount と同じ離脱ガード)。
  if (((location.hash.match(/^#\/([^?]+)/) || [])[1]) !== "playlist") return;

  root.innerHTML = render();
  const refs = collectRefs(root);
  renderList(refs);

  refs.backBtn.addEventListener("click", () => go("playlists"));
  refs.renameBtn.addEventListener("click", () => renamePlaylist(refs));
  refs.playBtn.addEventListener("click", () => playPlaylist(false));
  refs.shufflePlayBtn.addEventListener("click", () => playPlaylist(true));
  refs.repeatBtn.addEventListener("click", () => toggleRepeat(refs));
  refs.addBtn.addEventListener("click", () => go("playlist-add", { id: playlist.id }));
  refs.list.addEventListener("click", (e) => onListClick(e, refs));
  const cleanupReorder = installReorder(refs);

  // 初期表示: ボタン群の状態を現在のグローバル状態と同期
  updateRepeatButton(refs);
  updatePlayButtons(refs);

  // 「このプレイリストが現在再生中か」を購読
  const unsubPlaylist = appState.subscribe(["currentPlaylistId"], (s) => {
    updateNowPlayingBadge(refs, s);
    // プレイリスト切替時もプレイボタンの強調状態を更新
    updatePlayButtons(refs);
  });
  // プレイヤー画面側で変更された shuffle/repeat 状態をボタンに反映
  const unsubModes = appState.subscribe(["shuffleMode", "repeatMode"], () => {
    updateRepeatButton(refs);
    // シャッフルON/OFF が変わった場合にも「すべて再生」vs「シャッフル再生」を更新
    updatePlayButtons(refs);
  });
  // 再生中曲のハイライト（赤枠）を切り替わった曲に追従させる。
  // ライブラリ画面と同じく currentTrack 変化を購読して一覧を再描画する。
  // - 全体 innerHTML 入れ替えだとドラッグ並び替え中などに視覚的にちらつくため、
  //   既存行の is-playing クラスを差し替えるだけの軽い更新で済ませる。
  const unsubCurrentTrack = appState.subscribe(["currentTrack"], () => {
    updatePlayingHighlight(refs);
  });

  return () => {
    if (cleanupReorder) cleanupReorder();
    if (unsubPlaylist) unsubPlaylist();
    if (unsubModes) unsubModes();
    if (unsubCurrentTrack) unsubCurrentTrack();
  };
}

/**
 * 現在再生中の曲ハイライトのみを更新する（一覧全体は再描画しない）。
 *   - track-row[data-id] の id を appState.currentTrack と突合
 *   - is-playing クラスを差し替えるだけ
 *   - ドラッグ並び替え中や DOM 再生成による副作用を避ける
 */
function updatePlayingHighlight(refs) {
  if (!refs || !refs.list) return;
  const curId = appState.get().currentTrack?.id || null;
  const rows = refs.list.querySelectorAll(".track-row[data-id]");
  rows.forEach((row) => {
    const isCur = !!curId && row.dataset.id === curId;
    row.classList.toggle("is-playing", isCur);
  });
}

function updateNowPlayingBadge(refs, s) {
  const badge = refs.npBadge;
  if (!badge) return;
  if (s.currentPlaylistId && playlist && s.currentPlaylistId === playlist.id) {
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function parseQuery() {
  const hash = location.hash || "";
  const i = hash.indexOf("?");
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(hash.substring(i + 1)));
}

async function reloadTracks() {
  const all = await getAllTracks();
  allTracksMap = new Map(all.map((t) => [t.id, t]));
  tracksInOrder = (playlist.trackIds || []).map((id) => allTracksMap.get(id)).filter(Boolean);
}

function render() {
  const totalSec = tracksInOrder.reduce((s, t) => s + (t.duration || 0), 0);
  const isPlayingThis = appState.get().currentPlaylistId === playlist.id;
  return `
    <section class="playlist-detail-view">
      <div class="playlist-header">
        <button class="icon-btn" id="btn-back" aria-label="戻る" title="戻る">←</button>
        <div class="playlist-header-info">
          <h2 class="playlist-title" id="pl-title">${escapeHtml(playlist.name)}</h2>
          <div class="playlist-sub" id="pl-sub">${tracksInOrder.length} 曲 ・ 合計 ${formatTotal(totalSec)}</div>
          <div class="playlist-now-playing" id="np-badge" ${isPlayingThis ? "" : "hidden"}>🔊 このプレイリストを再生中</div>
        </div>
        <button class="icon-btn" id="btn-rename" aria-label="名前を編集" title="名前を編集">✏</button>
      </div>

      <div class="playlist-actions">
        <button class="btn" id="btn-pl-play" ${tracksInOrder.length === 0 ? "disabled" : ""}>▶ すべて再生</button>
        <button class="btn" id="btn-pl-shuffle-play" ${tracksInOrder.length === 0 ? "disabled" : ""}>🔀 シャッフル再生</button>
        <button class="btn" id="btn-pl-repeat" aria-pressed="false">🔁 リピート</button>
        <button class="btn" id="btn-pl-add">＋ 曲を追加</button>
      </div>

      <ul class="track-list" id="track-list"></ul>
    </section>
  `;
}

function collectRefs(root) {
  return {
    backBtn: root.querySelector("#btn-back"),
    title: root.querySelector("#pl-title"),
    sub: root.querySelector("#pl-sub"),
    npBadge: root.querySelector("#np-badge"),
    renameBtn: root.querySelector("#btn-rename"),
    playBtn: root.querySelector("#btn-pl-play"),
    shufflePlayBtn: root.querySelector("#btn-pl-shuffle-play"),
    repeatBtn: root.querySelector("#btn-pl-repeat"),
    addBtn: root.querySelector("#btn-pl-add"),
    list: root.querySelector("#track-list"),
  };
}

function renderList(refs) {
  // ドラッグ並び替え中は浮かせた行/プレースホルダを直接操作中のため全再描画しない
  // (view-library/view-playlists と同じガード)。これを怠ると、ドラッグ中に別曲の
  // ✕(マルチタッチ)で renderList が走った場合に、ドラッグ中の行が innerHTML 置換で
  // detach され、onDragEnd の placeholder.parentNode 参照が null になって落ちる。
  if (dragState) return;
  if (tracksInOrder.length === 0) {
    refs.list.innerHTML = `<li class="empty-state">曲がまだありません。<br/>「＋ 曲を追加」から曲を追加してください。</li>`;
    refs.playBtn.disabled = true;
    if (refs.shufflePlayBtn) refs.shufflePlayBtn.disabled = true;
  } else {
    const cur = appState.get().currentTrack;
    refs.list.innerHTML = tracksInOrder.map((t) => trackRowHtml(t, cur)).join("");
    refs.playBtn.disabled = false;
    if (refs.shufflePlayBtn) refs.shufflePlayBtn.disabled = false;
  }
  updateHeader(refs);
}

function updateHeader(refs) {
  const totalSec = tracksInOrder.reduce((s, t) => s + (t.duration || 0), 0);
  refs.sub.textContent = `${tracksInOrder.length} 曲 ・ 合計 ${formatTotal(totalSec)}`;
}

function trackRowHtml(t, cur) {
  const playing = cur && cur.id === t.id;
  const enabled = t.enabled !== false;
  const loved = !!t.loved;
  const sub = [t.artist || "(不明)", t.album || ""].filter(Boolean).join(" — ");
  const artUrl = getArtworkUrl(t);
  const artImg = artUrl
    ? `<img class="track-art" src="${escapeHtml(artUrl)}" alt="" />`
    : `<div class="track-art"></div>`;
  const handle = `<span class="drag-handle" data-act="handle" role="button" tabindex="0" aria-label="並び替え">☰</span>`;
  const lovedMark = loved
    ? `<span class="track-loved" title="Loved" aria-label="Loved">♥</span>`
    : `<span class="track-loved-spacer" aria-hidden="true"></span>`;
  return `
    <li class="track-row is-manual ${playing ? "is-playing" : ""} ${enabled ? "" : "is-disabled"}" data-id="${escapeHtml(t.id)}">
      ${handle}
      ${artImg}
      <div class="track-info">
        <div class="track-title">${escapeHtml(t.title || "(無題)")}</div>
        <div class="track-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="track-actions">
        ${lovedMark}
        <button class="icon-btn" data-act="remove" title="プレイリストから外す">✕</button>
      </div>
    </li>
  `;
}

async function playPlaylist(shuffle) {
  const enabled = tracksInOrder.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    toast("再生可能な曲がありません", "info");
    return;
  }
  // シャッフル状態をボタンに応じて確定（プレイヤー画面側の表示にも反映される）
  setShuffleMode(!!shuffle);
  // 「このプレイリストから再生中」コンテキストを設定
  appState.set({ currentPlaylistId: playlist.id, currentPlaylistName: playlist.name });
  // シャッフル再生の場合は開始位置もランダムにする。
  // - setQueueAndPlay → shuffleCurrentQueue は「現在曲を先頭固定でその他をシャッフル」
  //   する設計のため、startIndex=0 のままだと必ずプレイリスト1曲目が
  //   先頭に固定されてしまい「ランダム」にならない。
  // - ここで startIndex をランダム化することで、毎回違う曲から再生開始できる。
  // - 通常再生 (shuffle=false) は従来どおり先頭から。
  const startIdx = shuffle
    ? Math.floor(Math.random() * enabled.length)
    : 0;
  await setQueueAndPlay(enabled, startIdx);
  go("player");
}

/**
 * リピート ON/OFF トグル
 * - OFF (none) → ON (all)
 * - ON  (all/one) → OFF (none)
 *   "one" 時に押した場合も意図通り「リピート OFF」にする
 */
function toggleRepeat(refs) {
  const cur = appState.get().repeatMode;
  const next = cur === "none" ? "all" : "none";
  setRepeatMode(next);
  // appState の購読で updateRepeatButton が呼ばれるが、即時反映のためここでも更新
  updateRepeatButton(refs);
}

/**
 * 「すべて再生」「シャッフル再生」ボタンの強調状態を現在の再生状態に同期する。
 *
 * - このプレイリストが再生中 + shuffleMode=false →「すべて再生」が primary (赤)
 * - このプレイリストが再生中 + shuffleMode=true  →「シャッフル再生」が primary (赤)
 * - このプレイリストが再生中でない               → 「すべて再生」が primary (デフォルト)
 *
 * これにより「シャッフル再生」で開始した場合は「シャッフル再生」が赤くなり、
 * 「すべて再生」で開始した場合は「すべて再生」が赤くなる。
 */
function updatePlayButtons(refs) {
  const s = appState.get();
  const isPlayingThis =
    !!(s.currentPlaylistId && playlist && s.currentPlaylistId === playlist.id);
  const isShuffle = !!s.shuffleMode;
  const playBtn = refs.playBtn;
  const shuffleBtn = refs.shufflePlayBtn;
  if (!playBtn || !shuffleBtn) return;

  if (isPlayingThis) {
    // 現在このプレイリストを再生中: 使用したモードのボタンを強調
    playBtn.classList.toggle("primary", !isShuffle);
    shuffleBtn.classList.toggle("primary", isShuffle);
  } else {
    // 再生していない / 別プレイリスト: どちらもハイライトなし
    playBtn.classList.remove("primary");
    shuffleBtn.classList.remove("primary");
  }
}

/**
 * リピートボタンの見た目を現在の repeatMode に同期
 * - "none": "🔁 リピート" 通常表示、aria-pressed=false
 * - "all" / "one": "🔁 リピート ON" primary 表示、aria-pressed=true
 */
function updateRepeatButton(refs) {
  const btn = refs.repeatBtn;
  if (!btn) return;
  const mode = appState.get().repeatMode;
  const on = mode !== "none";
  btn.textContent = on ? "🔁 リピート ON" : "🔁 リピート";
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("primary", on);
}

async function renamePlaylist(refs) {
  const form = await promptForm(
    "プレイリスト名の変更",
    [{ name: "name", label: "新しい名前", value: playlist.name, placeholder: "プレイリスト名" }],
    { okLabel: "保存" }
  );
  if (!form) return;
  const newName = (form.name || "").trim();
  if (!newName) {
    toast("名前を入力してください", "err");
    return;
  }
  try {
    await updatePlaylist(playlist.id, { name: newName });
    playlist.name = newName;
    refs.title.textContent = newName;
    // このプレイリストを再生中の場合、再生コンテキスト名も更新する。
    // さもないとライブラリ画面のバナー等が古い名前を表示し続ける。
    if (appState.get().currentPlaylistId === playlist.id) {
      appState.set({ currentPlaylistName: newName });
    }
    toast("名前を変更しました", "ok");
  } catch (e) {
    console.warn("rename failed", e);
    toast("変更に失敗しました", "err");
  }
}

async function onListClick(e, refs) {
  // ドラッグ並び替え中のタップ/✕(マルチタッチ等)は無視する。これにより、
  // ドラッグ中の remove で一覧が再描画され並び替えが壊れる/落ちるのを防ぐ。
  if (dragState) return;
  const btn = e.target.closest("button[data-act]");
  if (!btn) {
    if (e.target.closest('[data-act="handle"]')) return;
    const row = e.target.closest(".track-row");
    if (row) {
      const id = row.dataset.id;
      const enabled = tracksInOrder.filter((t) => t.enabled !== false);
      const idx = enabled.findIndex((t) => t.id === id);
      if (idx < 0) {
        toast("この曲は再生無効に設定されています", "info");
        return;
      }
      // プレイリストの曲を直接タップして再生した場合もコンテキストを設定
      appState.set({ currentPlaylistId: playlist.id, currentPlaylistName: playlist.name });
      await setQueueAndPlay(enabled, idx);
      go("player");
    }
    return;
  }
  const row = btn.closest(".track-row");
  const id = row && row.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === "remove") {
    const t = tracksInOrder.find((x) => x.id === id);
    if (!t) return;
    const yes = await confirm(
      `「${t.title}」をこのプレイリストから外しますか？\n（曲データ自体は残ります）`,
      { okLabel: "外す", danger: true }
    );
    if (!yes) return;
    try {
      const res = await removeTracksFromPlaylist(playlist.id, [id]);
      // ★ DB の確定結果(trackIds)で同期する(view-playlist-add と同じ方針)。
      //   楽観更新のみだと並行編集時にローカル trackIds が DB とズレる。
      if (res && Array.isArray(res.trackIds)) playlist.trackIds = res.trackIds.slice();
      else playlist.trackIds = (playlist.trackIds || []).filter((tid) => tid !== id);
      tracksInOrder = (playlist.trackIds || []).map((tid) => allTracksMap.get(tid)).filter(Boolean);
      renderList(refs);
      toast("プレイリストから外しました", "ok");
    } catch (e) {
      console.warn("remove failed", e);
      toast("プレイリストから外すのに失敗しました", "err");
    }
  }
}

/* ============ 手動並び替え ============ */

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
    // unmount 時にドラッグ中だった場合の残置を掃除 (pointerup 取りこぼし対策)。
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
  //   dragState が上書きされ、1本目の浮遊行/プレースホルダが残置し trackIds に undefined が
  //   混入する(マルチタッチ安全網)。
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
  const newIds = Array.from(list.children)
    // drag-placeholder も class="track-row ..." を持つため dataset.id の有無でも絞り、
    //   マルチタッチ等で残置した placeholder の undefined が trackIds に混入しないようにする。
    .filter((c) => c.classList.contains("track-row") && c.dataset.id)
    .map((c) => c.dataset.id);
  dragState = null;

  const newIndex = newIds.indexOf(id);
  if (newIndex === initialIndex) return;

  try {
    await updatePlaylist(playlist.id, { trackIds: newIds });
    playlist.trackIds = newIds;
    tracksInOrder = newIds.map((tid) => allTracksMap.get(tid)).filter(Boolean);
    toast("並び順を保存しました", "ok");
  } catch (e) {
    console.warn("並び順保存失敗", e);
    toast("並び順の保存に失敗しました", "err");
  }
  renderList(refs);
}
