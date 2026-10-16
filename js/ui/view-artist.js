/**
 * アーティスト詳細画面
 *
 * - ヘッダー: 戻るボタン、アーティスト名、丸型アバター、アルバム数・曲数
 * - アクション: 「すべて再生」「シャッフル再生」
 * - セクション1: 「アルバム」グリッド（タップで #/album?key=... へ遷移）
 * - セクション2: 「曲」一覧（タップでアーティスト内キューから再生）
 */

import { getAllTracks } from "../store/library-db.js";
import { groupTracksIntoArtists } from "../metadata/artist-util.js";
import { sortAlbums } from "../metadata/album-util.js";
import { setQueueAndPlay, setShuffleMode, prewarmTrack, prewarmTracks, playNextTrack, addToQueueEnd } from "../player/audio-engine.js";
import { appState } from "../state.js";
import { getArtworkUrl } from "./artwork-cache.js";
import { go } from "../router.js";
import { toast, escapeHtml, escapeAttr, formatTime } from "./components.js";
import { editTrackMetadata } from "./metadata-editor.js";

let artist = null;
let unsubState = null;

export async function mount(root) {
  const params = parseQuery();
  const artistName = params.name ? decodeURIComponent(params.name) : "";

  if (!artistName) {
    go("library", { tab: "artists" });
    return () => {};
  }

  const allTracks = await getAllTracks();
  const allArtists = groupTracksIntoArtists(allTracks);
  const targetLower = artistName.trim().toLowerCase();
  artist =
    allArtists.find((a) => a.name.trim().toLowerCase() === targetLower) ||
    allArtists.find((a) => a.tracks.some((t) => (t.artist || "").trim().toLowerCase() === targetLower));

  if (!artist) {
    toast("アーティストが見つかりません", "err");
    go("library", { tab: "artists" });
    return () => {};
  }

  // 離脱ガード
  if (((location.hash.match(/^#\/([^?]+)/) || [])[1]) !== "artist") return;

  root.innerHTML = render(artist);

  // ★ アーティスト画面表示時にキャッシュ済み楽曲を先行プリウォーム（最大5曲）
  if (artist && Array.isArray(artist.tracks)) {
    prewarmTracks(artist.tracks.map((t) => t.id), 5);
  }
  const refs = collectRefs(root);

  refs.backBtn.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      go("library", { tab: "artists" });
    }
  });

  refs.playAllBtn.addEventListener("click", () => playArtist(false));
  refs.playShuffleBtn.addEventListener("click", () => playArtist(true));

  // アルバムカードクリック委譲
  refs.albumGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".album-card");
    if (!card) return;
    const key = card.dataset.key;
    if (key) {
      go("album", { key });
    }
  });

  // アルバム並び替え (リリース順・タイトル順)
  const albumSortSelect = root.querySelector("#artist-album-sort");
  if (albumSortSelect) {
    albumSortSelect.addEventListener("change", () => {
      const sorted = sortAlbums(artist.albums, albumSortSelect.value);
      refs.albumGrid.innerHTML = renderAlbumCards(sorted);
    });
  }

  // 曲一覧クリック委譲 & タップ直前プリウォーム
  refs.trackList.addEventListener("click", (e) => onTrackClick(e, root));
  refs.trackList.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".artist-track-item");
    if (row && row.dataset.id) {
      prewarmTrack(row.dataset.id, { onlyIfCached: true });
    }
  }, { passive: true });

  // 再生中ハイライト & ローディングスピナー追従
  unsubState = appState.subscribe(["currentTrack", "isPlaying", "loadingTrackId"], () => {
    updatePlayingHighlight(refs);
  });
  updatePlayingHighlight(refs);

  return () => {
    if (unsubState) unsubState();
    unsubState = null;
  };
}

function parseQuery() {
  const hash = location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) return {};
  const qs = hash.slice(qIndex + 1);
  const params = {};
  for (const [k, v] of new URLSearchParams(qs).entries()) {
    params[k] = v;
  }
  return params;
}

function render(art) {
  const artUrl = art.artworkTrack ? getArtworkUrl(art.artworkTrack) : null;
  const avatarHtml = artUrl
    ? `<img class="artist-detail-avatar" src="${escapeAttr(artUrl)}" alt="${escapeAttr(art.name)}" />`
    : `<div class="artist-detail-avatar artist-avatar-placeholder">👤</div>`;

  const metaStr = `${art.albumCount} 枚のアルバム • ${art.trackCount} 曲`;

  return `
    <section class="artist-detail-view">
      <div class="artist-detail-nav">
        <button class="btn icon-btn" id="btn-artist-back" title="戻る">← 戻る</button>
      </div>

      <div class="artist-detail-header">
        <div class="artist-detail-avatar-wrap">
          ${avatarHtml}
        </div>
        <div class="artist-detail-info">
          <div class="artist-detail-type">アーティスト</div>
          <h2 class="artist-detail-title">${escapeHtml(art.name)}</h2>
          <div class="artist-detail-meta">${escapeHtml(metaStr)}</div>
        </div>
      </div>

      <div class="artist-detail-actions">
        <button class="btn primary" id="btn-artist-play-all">▶ すべて再生</button>
        <button class="btn" id="btn-artist-play-shuffle">🔀 シャッフル再生</button>
      </div>

      <!-- アルバム一覧セクション (リリース順 / タイトル順) -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 18px; margin-bottom: 8px;">
        <div class="artist-section-title" style="margin: 0;">アルバム (${art.albumCount})</div>
        <select id="artist-album-sort" style="font-size: 11px; padding: 3px 8px; border-radius: 6px; background: var(--bg-surface, var(--bg-elev)); color: var(--fg); border: 1px solid var(--border-color, var(--border)); cursor: pointer;">
          <option value="year-asc" selected>リリース順 (古い順)</option>
          <option value="year-desc">リリース順 (新しい順)</option>
          <option value="title-asc">アルバム名 (昇順)</option>
        </select>
      </div>
      <div class="album-grid" id="artist-album-grid" role="list">
        ${renderAlbumCards(sortAlbums(art.albums, "year-asc"))}
      </div>

      <!-- 全曲一覧セクション -->
      <div class="artist-section-title" style="margin-top: 24px;">すべての曲 (${art.trackCount})</div>
      <ul class="artist-track-list" id="artist-track-list">
        ${renderTrackRows(art.tracks)}
      </ul>
    </section>
  `;
}

function renderAlbumCards(albums) {
  if (!albums || albums.length === 0) {
    return `<div class="empty-state">アルバムがありません</div>`;
  }
  return albums
    .map((alb) => {
      const artUrl = alb.artworkTrack ? getArtworkUrl(alb.artworkTrack) : null;
      const artImg = artUrl
        ? `<img class="album-card-art" src="${escapeAttr(artUrl)}" alt="${escapeAttr(alb.title)}" loading="lazy" decoding="async" />`
        : `<div class="album-card-art album-card-placeholder">💿</div>`;

      return `
        <article class="album-card" data-key="${escapeAttr(alb.key)}" role="listitem" tabindex="0">
          <div class="album-card-art-wrap">${artImg}</div>
          <div class="album-card-body">
            <h3 class="album-card-title">${escapeHtml(alb.title)}</h3>
            <div class="album-card-meta">${escapeHtml(alb.year ? alb.year + " • " : "")}${alb.trackCount} 曲</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTrackRows(tracks) {
  if (!tracks || tracks.length === 0) {
    return `<li class="empty-state">曲がありません</li>`;
  }
  return tracks
    .map((t, index) => {
      const dur = t.duration ? formatTime(t.duration) : "—";
      const lovedIcon = t.loved ? `<span class="track-loved-indicator" title="お気に入り">♥</span>` : "";
      const albTitle = t.album || "";
      const isGdrive = t.source === "gdrive" || (t.id && t.id.startsWith("gd-"));
      const gdriveMark = isGdrive
        ? `<span class="source-badge gdrive-badge" title="Google Drive 音源">☁</span>`
        : "";
      const numStr = String(index + 1);

      return `
        <li class="artist-track-item ${t.enabled === false ? "is-disabled" : ""}" data-id="${escapeAttr(t.id)}" data-track-num="${escapeAttr(numStr)}">
          <span class="artist-track-num-slot"><span class="track-index">${escapeHtml(numStr)}</span></span>
          <div class="track-main">
            <div class="track-title">${gdriveMark}<span class="track-title-text">${escapeHtml(t.title || "(無題)")}</span>${t.memo ? `<span class="track-memo-badge" title="${escapeAttr(t.memo)}">${escapeHtml(t.memo)}</span>` : ""}</div>
            <div class="track-meta">${escapeHtml(albTitle)}</div>
          </div>
          <div class="artist-track-actions">
            ${lovedIcon}
            <button class="icon-btn track-action-btn" data-action="play-next" title="次に再生" aria-label="次に再生">⏭</button>
            <button class="icon-btn track-action-btn" data-action="add-queue" title="キューの末尾に追加" aria-label="キューの末尾に追加">＋</button>
            <button class="track-btn-edit" data-action="edit" title="曲の情報を編集" aria-label="曲の情報を編集">✏</button>
            <span class="track-duration">${dur}</span>
          </div>
        </li>
      `;
    })
    .join("");
}

function collectRefs(root) {
  return {
    backBtn: root.querySelector("#btn-artist-back"),
    playAllBtn: root.querySelector("#btn-artist-play-all"),
    playShuffleBtn: root.querySelector("#btn-artist-play-shuffle"),
    albumGrid: root.querySelector("#artist-album-grid"),
    trackList: root.querySelector("#artist-track-list"),
  };
}

async function playArtist(shuffle = false) {
  if (!artist || !artist.tracks.length) return;
  const playable = artist.tracks.filter((t) => t.enabled !== false);
  if (!playable.length) {
    toast("再生可能な曲がありません", "info");
    return;
  }
  if (shuffle) {
    setShuffleMode(true);
    const startIdx = Math.floor(Math.random() * playable.length);
    await setQueueAndPlay(playable, startIdx);
  } else {
    setShuffleMode(false);
    await setQueueAndPlay(playable, 0);
  }
}

async function onTrackClick(e, root) {
  const actBtn = e.target.closest("[data-action]");
  const row = e.target.closest(".artist-track-item");
  if (!row) return;
  const trackId = row.dataset.id;
  const track = artist.tracks.find((t) => t.id === trackId);
  if (!track) return;

  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.action;
    if (act === "play-next") {
      playNextTrack(track);
      return;
    }
    if (act === "add-queue") {
      addToQueueEnd(track);
      return;
    }
    if (act === "edit") {
      editTrackMetadata(track, () => mount(root));
      return;
    }
  }

  if (track.enabled === false) {
    toast("この曲は再生無効に設定されています", "info");
    return;
  }

  const playable = artist.tracks.filter((t) => t.enabled !== false);
  const targetIdx = playable.findIndex((t) => t.id === track.id);
  if (targetIdx >= 0) {
    await setQueueAndPlay(playable, targetIdx);
  }
}

function updatePlayingHighlight(refs) {
  if (!refs || !refs.trackList) return;
  const s = appState.get();
  const curId = s.currentTrack?.id || null;
  const loadingId = s.loadingTrackId || null;
  const isPlaying = !!s.isPlaying;

  refs.trackList.querySelectorAll(".artist-track-item").forEach((el) => {
    const isCur = !!curId && el.dataset.id === curId;
    const isLoading = !!loadingId && el.dataset.id === loadingId;
    el.classList.toggle("is-playing", isCur);
    el.classList.toggle("is-loading", isLoading);
    const slot = el.querySelector(".artist-track-num-slot");
    if (slot) {
      if (isLoading) {
        slot.innerHTML = `<span class="track-spinner" aria-label="読み込み中"></span>`;
      } else if (isCur) {
        slot.innerHTML = `<div class="eq-anim ${isPlaying ? "" : "is-paused"}" aria-label="再生中"><span class="eq-bar b1"></span><span class="eq-bar b2"></span><span class="eq-bar b3"></span></div>`;
      } else {
        const origNum = el.dataset.trackNum || "";
        slot.innerHTML = `<span class="track-index">${escapeHtml(origNum)}</span>`;
      }
    }
  });
}
