/**
 * アルバム一覧画面
 *
 * - ライブラリの全曲から動的にアルバムをグループ化してグリッド表示
 * - 検索 (アルバム名、アルバムアーティスト、年)
 * - ソート (アルバム名 昇順/降順、アーティスト名、年 新しい順/古い順、最近追加順)
 * - タップでアルバム詳細画面 (#/album?key=...) へ遷移
 */

import { getAllTracks } from "../store/library-db.js";
import { groupTracksIntoAlbums, sortAlbums } from "../metadata/album-util.js";
import { getArtworkUrl } from "./artwork-cache.js";
import { go } from "../router.js";
import { escapeHtml, escapeAttr, toast } from "./components.js";

let allAlbumsCache = [];
let filterText = "";
let sortKey = "title-asc";

export async function mount(root) {
  root.innerHTML = render();
  const refs = collectRefs(root);

  filterText = "";
  sortKey = "title-asc";

  try {
    await reloadAlbums(refs);
  } catch (e) {
    console.warn("アルバム一覧の読み込み失敗", e);
    toast("アルバムの読み込みに失敗しました", "err");
  }

  // 検索
  refs.search.addEventListener("input", () => {
    filterText = refs.search.value.trim().toLowerCase();
    renderGrid(refs);
  });

  // 並び替え
  refs.sort.addEventListener("change", () => {
    sortKey = refs.sort.value;
    renderGrid(refs);
  });

  // カードクリック委譲
  refs.grid.addEventListener("click", (e) => {
    const card = e.target.closest(".album-card");
    if (!card) return;
    const key = card.dataset.key;
    if (key) {
      go("album", { key });
    }
  });

  // キーボードアクセシビリティ
  refs.grid.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      const card = e.target.closest(".album-card");
      if (card && card.dataset.key) {
        e.preventDefault();
        go("album", { key: card.dataset.key });
      }
    }
  });

  return () => {
    // cleanup
  };
}

function render() {
  return `
    <section class="albums-view">
      <div class="library-toolbar">
        <input type="search" id="album-search" placeholder="アルバム・アーティスト・年を検索" autocomplete="off" />
        <select id="album-sort">
          <option value="title-asc">アルバム名 (昇順)</option>
          <option value="title-desc">アルバム名 (降順)</option>
          <option value="artist-asc">アーティスト名 (昇順)</option>
          <option value="year-desc">リリース年 (新しい順)</option>
          <option value="year-asc">リリース年 (古い順)</option>
          <option value="recent">最近追加した順</option>
        </select>
      </div>

      <div class="library-stats" id="album-stats"></div>

      <div class="album-grid" id="album-grid" role="list"></div>
    </section>
  `;
}

function collectRefs(root) {
  return {
    search: root.querySelector("#album-search"),
    sort: root.querySelector("#album-sort"),
    stats: root.querySelector("#album-stats"),
    grid: root.querySelector("#album-grid"),
  };
}

async function reloadAlbums(refs) {
  const tracks = await getAllTracks();
  allAlbumsCache = groupTracksIntoAlbums(tracks);
  renderGrid(refs);
}

function renderGrid(refs) {
  if (!refs || !refs.grid) return;

  let list = allAlbumsCache.slice();
  if (filterText) {
    list = list.filter((a) => {
      const t = (a.title || "").toLowerCase();
      const art = (a.albumArtist || "").toLowerCase();
      const yr = (a.year || "").toLowerCase();
      return t.includes(filterText) || art.includes(filterText) || yr.includes(filterText);
    });
  }

  list = sortAlbums(list, sortKey);

  if (list.length === 0) {
    refs.grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        ${allAlbumsCache.length === 0 ? "ライブラリに楽曲がありません。<br/>ライブラリ画面から音源を追加してください。" : "該当するアルバムが見つかりません。"}
      </div>
    `;
    refs.stats.textContent = `0 / ${allAlbumsCache.length} アルバム`;
    return;
  }

  refs.stats.textContent = `${list.length} / ${allAlbumsCache.length} アルバム`;
  refs.grid.innerHTML = list.map((a) => albumCardHtml(a)).join("");
}

function albumCardHtml(album) {
  const artUrl = album.artworkTrack ? getArtworkUrl(album.artworkTrack) : null;
  const artImg = artUrl
    ? `<img class="album-card-art" src="${escapeAttr(artUrl)}" alt="${escapeAttr(album.title)}" loading="lazy" decoding="async" />`
    : `<div class="album-card-art album-card-placeholder">💿</div>`;

  const metaParts = [];
  if (album.year) metaParts.push(album.year);
  metaParts.push(`${album.trackCount}曲`);
  const metaStr = metaParts.join(" • ");

  return `
    <div class="album-card" data-key="${escapeAttr(album.key)}" role="button" tabindex="0" aria-label="${escapeAttr(album.title)} - ${escapeAttr(album.albumArtist)}">
      <div class="album-card-art-wrap">
        ${artImg}
      </div>
      <div class="album-card-info">
        <div class="album-card-title" title="${escapeAttr(album.title)}">${escapeHtml(album.title)}</div>
        <div class="album-card-artist" title="${escapeAttr(album.albumArtist)}">${escapeHtml(album.albumArtist)}</div>
        <div class="album-card-meta">${escapeHtml(metaStr)}</div>
      </div>
    </div>
  `;
}
