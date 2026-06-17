/**
 * プレイリストに曲を追加する画面
 *
 * 3 タブ:
 *   - 曲       : 個別タップで追加/削除をトグル（既に追加済みは ✓ 表示）
 *   - アーティスト: 選択でそのアーティストの全曲を一括追加（確認ダイアログあり）
 *   - アルバム  : 選択でそのアルバムの全曲を一括追加（確認ダイアログあり）
 *
 * 「アーティスト」「アルバム」が未設定の曲は「(その他)」グループにまとめる。
 * 初期タブは「曲」。
 */

import {
  getPlaylist,
  getAllTracks,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
} from "../store/library-db.js";
import { appState } from "../state.js";
import { go } from "../router.js";
import { toast, confirm, escapeHtml, escapeAttr } from "./components.js";
import { getArtworkUrl } from "./artwork-cache.js";

let playlist = null;
let allTracks = [];
let currentTab = "tracks"; // "tracks" | "artists" | "albums"
let searchQuery = "";

export async function mount(root) {
  const params = parseQuery();
  const id = params.id;
  if (!id) { go("playlists"); return () => {}; }
  playlist = await getPlaylist(id);
  if (!playlist) {
    toast("プレイリストが見つかりません", "err");
    // 消えたプレイリストが再生中コンテキストなら、ライブラリ画面バナーの壊れた
    // リンクを残さないようクリアする(別プレイリストの文脈を消さないよう id 一致時のみ)。
    if (appState.get().currentPlaylistId === id) {
      appState.set({ currentPlaylistId: null, currentPlaylistName: null });
    }
    go("playlists");
    return () => {};
  }
  allTracks = await getAllTracks();
  // await(getPlaylist/getAllTracks)中に別ルートへ離脱していたら、共有 #view-root を
  //   上書きして遷移先ビューを壊さないよう描画せず抜ける(view-playlist と同じ離脱ガード)。
  //   ガードは購読/リスナ登録より前なのでリークも生じない。
  if (((location.hash.match(/^#\/([^?]+)/) || [])[1]) !== "playlist-add") return () => {};

  // タブは毎回 mount 時に「曲」にリセット
  currentTab = "tracks";
  searchQuery = "";

  root.innerHTML = render();
  const refs = collectRefs(root);

  refs.backBtn.addEventListener("click", () => go("playlist", { id: playlist.id }));
  refs.tabs.forEach((tb) => {
    tb.addEventListener("click", () => {
      currentTab = tb.dataset.tab;
      refs.tabs.forEach((x) => x.classList.toggle("is-active", x.dataset.tab === currentTab));
      renderTabContent(refs);
    });
  });
  refs.searchInput.addEventListener("input", () => {
    searchQuery = refs.searchInput.value.trim().toLowerCase();
    renderTabContent(refs);
  });
  refs.tabContent.addEventListener("click", (e) => onContentClick(e, refs));

  renderTabContent(refs);

  return () => {};
}

function parseQuery() {
  const hash = location.hash || "";
  const i = hash.indexOf("?");
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(hash.substring(i + 1)));
}

function render() {
  return `
    <section class="playlist-add-view">
      <div class="playlist-header">
        <button class="icon-btn" id="btn-back" aria-label="戻る" title="戻る">←</button>
        <div class="playlist-header-info">
          <h2 class="playlist-title">「${escapeHtml(playlist.name)}」に追加</h2>
          <div class="playlist-sub">タップで追加/削除</div>
        </div>
        <span></span>
      </div>

      <div class="playlist-add-tabs">
        <button class="add-tab is-active" data-tab="tracks">曲</button>
        <button class="add-tab" data-tab="artists">アーティスト</button>
        <button class="add-tab" data-tab="albums">アルバム</button>
      </div>

      <div class="playlist-add-search">
        <input type="search" id="add-search" placeholder="検索: 曲タイトル/アーティスト/アルバム" autocomplete="off" />
      </div>

      <div id="add-tab-content"></div>
    </section>
  `;
}

function collectRefs(root) {
  return {
    backBtn: root.querySelector("#btn-back"),
    tabs: Array.from(root.querySelectorAll(".playlist-add-tabs .add-tab")),
    searchInput: root.querySelector("#add-search"),
    tabContent: root.querySelector("#add-tab-content"),
  };
}

/**
 * 検索クエリでフィルタする補助関数
 */
function matchesQuery(text) {
  if (!searchQuery) return true;
  return (text || "").toLowerCase().includes(searchQuery);
}

function renderTabContent(refs) {
  if (currentTab === "tracks") renderTracksTab(refs);
  else if (currentTab === "artists") renderArtistsTab(refs);
  else if (currentTab === "albums") renderAlbumsTab(refs);
}

/* ============ 「曲」タブ ============ */

function renderTracksTab(refs) {
  let enabled = allTracks.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    refs.tabContent.innerHTML = `<div class="empty-state">ライブラリに曲がありません。</div>`;
    return;
  }
  // 検索フィルタ: タイトル/アーティスト/アルバム のいずれかに含まれれば一致
  if (searchQuery) {
    enabled = enabled.filter((t) =>
      matchesQuery(t.title) || matchesQuery(t.artist) || matchesQuery(t.album)
    );
  }
  if (enabled.length === 0) {
    refs.tabContent.innerHTML = `<div class="empty-state">該当する曲が見つかりません。</div>`;
    return;
  }
  enabled.sort((a, b) => (a.title || "").localeCompare(b.title || "", "ja"));
  const inSet = new Set(playlist.trackIds || []);
  refs.tabContent.innerHTML = `
    <ul class="track-list">
      ${enabled.map((t) => trackRowHtml(t, inSet.has(t.id))).join("")}
    </ul>
  `;
}

function trackRowHtml(t, added) {
  const sub = [t.artist || "(不明)", t.album || ""].filter(Boolean).join(" — ");
  const artUrl = getArtworkUrl(t);
  const artImg = artUrl
    ? `<img class="track-art" src="${escapeAttr(artUrl)}" alt="" />`
    : `<div class="track-art"></div>`;
  return `
    <li class="track-row" data-act="track" data-id="${escapeAttr(t.id)}">
      ${artImg}
      <div class="track-info">
        <div class="track-title">${escapeHtml(t.title || "(無題)")}</div>
        <div class="track-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="track-actions">
        <span class="add-check ${added ? "is-added" : ""}" aria-label="${added ? "追加済" : "未追加"}">
          ${added ? "✓" : "＋"}
        </span>
      </div>
    </li>
  `;
}

/* ============ 「アーティスト」タブ ============ */

function renderArtistsTab(refs) {
  const enabled = allTracks.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    refs.tabContent.innerHTML = `<div class="empty-state">ライブラリに曲がありません。</div>`;
    return;
  }
  const groups = groupBy(enabled, (t) => (t.artist || "").trim() || "(その他)");
  const inSet = new Set(playlist.trackIds || []);

  let items = [...groups.entries()].map(([key, tracks]) => {
    const added = tracks.filter((t) => inSet.has(t.id)).length;
    return { key, tracks, added };
  });
  // 検索フィルタ: アーティスト名で絞り込み
  if (searchQuery) {
    items = items.filter((g) => matchesQuery(g.key));
  }
  if (items.length === 0) {
    refs.tabContent.innerHTML = `<div class="empty-state">該当するアーティストが見つかりません。</div>`;
    return;
  }
  // (その他) は末尾、それ以外は名前で昇順
  items.sort((a, b) => {
    if (a.key === "(その他)") return 1;
    if (b.key === "(その他)") return -1;
    return a.key.localeCompare(b.key, "ja");
  });

  refs.tabContent.innerHTML = `
    <ul class="track-list">
      ${items.map((g) => groupRowHtml(g, "artist")).join("")}
    </ul>
  `;
}

/* ============ 「アルバム」タブ ============ */

function renderAlbumsTab(refs) {
  const enabled = allTracks.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    refs.tabContent.innerHTML = `<div class="empty-state">ライブラリに曲がありません。</div>`;
    return;
  }
  const groups = groupBy(enabled, (t) => (t.album || "").trim() || "(その他)");
  const inSet = new Set(playlist.trackIds || []);

  let items = [...groups.entries()].map(([key, tracks]) => {
    const added = tracks.filter((t) => inSet.has(t.id)).length;
    const sub = key === "(その他)" ? "" : (tracks[0]?.artist || "(不明)");
    // アルバムカバー候補（artworkBlob を持つ最初のトラック）
    const cover = tracks.find((t) => t.artworkBlob) || null;
    return { key, tracks, added, sub, cover };
  });
  // 検索フィルタ: アルバム名 or 代表アーティスト名で絞り込み
  if (searchQuery) {
    items = items.filter((g) => matchesQuery(g.key) || matchesQuery(g.sub));
  }
  if (items.length === 0) {
    refs.tabContent.innerHTML = `<div class="empty-state">該当するアルバムが見つかりません。</div>`;
    return;
  }
  items.sort((a, b) => {
    if (a.key === "(その他)") return 1;
    if (b.key === "(その他)") return -1;
    return a.key.localeCompare(b.key, "ja");
  });

  refs.tabContent.innerHTML = `
    <ul class="track-list">
      ${items.map((g) => groupRowHtml(g, "album")).join("")}
    </ul>
  `;
}

/* ============ グループ行（アーティスト/アルバム）共通 ============ */

function groupRowHtml(g, kind) {
  const allAdded = g.added === g.tracks.length;
  const icon = kind === "album" ? "💿" : "👤";
  const subParts = [];
  if (g.sub) subParts.push(g.sub);
  subParts.push(`${g.tracks.length}曲`);
  if (g.added > 0 && !allAdded) subParts.push(`${g.added}追加済`);
  // アルバムタブで cover が取れる場合は <img>、それ以外は絵文字アイコン
  let artHtml;
  if (kind === "album" && g.cover && g.cover.artworkBlob) {
    const url = getArtworkUrl(g.cover);
    artHtml = url
      ? `<img class="track-art" src="${escapeAttr(url)}" alt="" />`
      : `<div class="track-art group-icon">${icon}</div>`;
  } else {
    artHtml = `<div class="track-art group-icon">${icon}</div>`;
  }
  return `
    <li class="track-row" data-act="group" data-kind="${kind}" data-key="${escapeAttr(g.key)}">
      ${artHtml}
      <div class="track-info">
        <div class="track-title">${escapeHtml(g.key)}</div>
        <div class="track-sub">${subParts.map(escapeHtml).join(" ・ ")}</div>
      </div>
      <div class="track-actions">
        <span class="add-check ${allAdded ? "is-added" : ""}" aria-label="${allAdded ? "全て追加済" : "追加可能"}">
          ${allAdded ? "✓" : "＋"}
        </span>
      </div>
    </li>
  `;
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

// escapeHtml=テキストノード用、escapeAttr=属性値用（どちらも components.js で null-safe）

/* ============ クリックハンドリング ============ */

async function onContentClick(e, refs) {
  const row = e.target.closest("[data-act]");
  if (!row) return;
  const act = row.dataset.act;
  if (act === "track") {
    await toggleTrack(row.dataset.id, refs);
  } else if (act === "group") {
    await addGroup(row.dataset.kind, row.dataset.key, refs);
  }
}

async function toggleTrack(id, refs) {
  const inSet = new Set(playlist.trackIds || []);
  if (inSet.has(id)) {
    // 削除
    try {
      const res = await removeTracksFromPlaylist(playlist.id, [id]);
      // ★ DB の確定結果(trackIds)で同期する。楽観更新だと連打/並行時に
      //   ローカル trackIds が DB とズレる(重複や取りこぼし)。
      if (res && Array.isArray(res.trackIds)) playlist.trackIds = res.trackIds.slice();
      else playlist.trackIds = (playlist.trackIds || []).filter((t) => t !== id);
      toast("プレイリストから削除しました", "ok");
    } catch (e) {
      console.warn("remove failed", e);
      toast("削除に失敗しました", "err");
      return;
    }
  } else {
    // 追加
    try {
      const res = await addTracksToPlaylist(playlist.id, [id]);
      // ★ DB の確定結果(重複排除済み trackIds)で同期する。
      if (res && res.playlist && Array.isArray(res.playlist.trackIds)) {
        playlist.trackIds = res.playlist.trackIds.slice();
      } else {
        playlist.trackIds = [...(playlist.trackIds || []), id];
      }
      // addedCount=0 は「既に追加済み(並行追加)」を意味するので文言を分ける。
      const already = res && res.addedCount === 0;
      toast(already ? "既に追加済みです" : "プレイリストに追加しました", already ? "info" : "ok");
    } catch (e) {
      console.warn("add failed", e);
      toast("追加に失敗しました", "err");
      return;
    }
  }
  renderTabContent(refs);
}

async function addGroup(kind, key, refs) {
  const enabled = allTracks.filter((t) => t.enabled !== false);
  const matching = enabled.filter((t) => {
    if (kind === "artist") {
      const a = (t.artist || "").trim() || "(その他)";
      return a === key;
    }
    if (kind === "album") {
      const a = (t.album || "").trim() || "(その他)";
      return a === key;
    }
    return false;
  });
  if (matching.length === 0) return;

  const inSet = new Set(playlist.trackIds || []);
  const toAdd = matching.filter((t) => !inSet.has(t.id));
  if (toAdd.length === 0) {
    toast(`既に全${matching.length}曲が追加済みです`, "info");
    return;
  }
  const yes = await confirm(
    `${toAdd.length}曲を「${playlist.name}」に追加します。よろしいですか？`,
    { okLabel: "追加" }
  );
  if (!yes) return;
  try {
    const res = await addTracksToPlaylist(playlist.id, toAdd.map((t) => t.id));
    // ★ DB の確定結果(重複排除済み trackIds)で同期し、実際に追加された件数を表示する。
    if (res && res.playlist && Array.isArray(res.playlist.trackIds)) {
      playlist.trackIds = res.playlist.trackIds.slice();
    } else {
      playlist.trackIds = [...(playlist.trackIds || []), ...toAdd.map((t) => t.id)];
    }
    const n = res && typeof res.addedCount === "number" ? res.addedCount : toAdd.length;
    toast(`${n}曲を追加しました`, "ok");
    renderTabContent(refs);
  } catch (e) {
    console.warn("add group failed", e);
    toast("追加に失敗しました", "err");
  }
}
