/**
 * アルバム詳細画面
 *
 * - ヘッダー: 戻るボタン、大ジャケット、アルバム名、アルバムアーティスト、年、曲数、合計時間
 * - アクション: 「すべて再生」「シャッフル再生」
 * - 曲一覧: ディスク/トラック番号順、複数ディスク時のDisc見出し、曲タップ再生
 */

import { getAllTracks } from "../store/library-db.js";
import { groupTracksIntoAlbums, parseTrackIndex } from "../metadata/album-util.js";
import { setQueueAndPlay, setShuffleMode } from "../player/audio-engine.js";
import { appState } from "../state.js";
import { getArtworkUrl } from "./artwork-cache.js";
import { go } from "../router.js";
import { escapeHtml, escapeAttr, toast } from "./components.js";
import { editTrackMetadata, editAlbumMetadata } from "./metadata-editor.js";

let album = null;
let unsubState = null;

export async function mount(root) {
  const params = parseQuery();
  const key = params.key;

  if (!key) {
    go("albums");
    return () => {};
  }

  const allTracks = await getAllTracks();
  const allAlbums = groupTracksIntoAlbums(allTracks);
  album = allAlbums.find((a) => a.key === key);

  if (!album) {
    toast("アルバムが見つかりません", "err");
    go("albums");
    return () => {};
  }

  // 離脱ガード（await 中に別画面へ遷移していた場合は描画しない）
  if (((location.hash.match(/^#\/([^?]+)/) || [])[1]) !== "album") return;

  root.innerHTML = render(album);
  const refs = collectRefs(root);

  refs.backBtn.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      go("library", { tab: "albums" });
    }
  });
  refs.playAllBtn.addEventListener("click", () => playAlbum(false));
  refs.playShuffleBtn.addEventListener("click", () => playAlbum(true));
  const openAlbumEditor = () => {
    editAlbumMetadata(album, () => mount(root));
  };
  if (refs.editAlbumBtn) {
    refs.editAlbumBtn.addEventListener("click", openAlbumEditor);
  }
  if (refs.artWrapBtn) {
    refs.artWrapBtn.addEventListener("click", openAlbumEditor);
  }
  refs.list.addEventListener("click", (e) => onListClick(e, root));

  // 再生中トラックのハイライト追従
  unsubState = appState.subscribe(["currentTrack"], () => {
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

function render(alb) {
  const artUrl = alb.artworkTrack ? getArtworkUrl(alb.artworkTrack) : null;
  const artImg = artUrl
    ? `<img class="album-detail-art" src="${escapeAttr(artUrl)}" alt="${escapeAttr(alb.title)}" />`
    : `<div class="album-detail-art album-card-placeholder">💿</div>`;

  const totalSec = alb.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const totalStr = formatTotal(totalSec);

  const metaParts = [];
  if (alb.year) metaParts.push(alb.year);
  metaParts.push(`${alb.trackCount} 曲`);
  metaParts.push(totalStr);
  const metaStr = metaParts.join(" • ");

  return `
    <section class="album-detail-view">
      <div class="album-detail-nav">
        <button class="btn icon-btn" id="btn-album-back" title="アルバム一覧へ戻る">← 戻る</button>
      </div>

      <div class="album-detail-header">
        <div class="album-detail-art-wrap" id="btn-album-art-wrap" title="クリックしてアルバム画像・情報を変更" style="cursor: pointer; position: relative;">
          ${artImg}
          <div class="album-detail-art-badge" style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.65); color: #fff; font-size: 10px; text-align: center; padding: 4px 2px; backdrop-filter: blur(4px);">📷 画像を変更</div>
        </div>
        <div class="album-detail-info">
          <div class="album-detail-type">アルバム</div>
          <h2 class="album-detail-title">${escapeHtml(alb.title)}</h2>
          <div class="album-detail-artist"><a href="#/artist?name=${encodeURIComponent(alb.albumArtist)}" class="artist-link" title="アーティストの詳細へ">${escapeHtml(alb.albumArtist)}</a></div>
          <div class="album-detail-meta">${escapeHtml(metaStr)}</div>
        </div>
      </div>

      <div class="album-detail-actions">
        <button class="btn primary" id="btn-album-play-all">▶ すべて再生</button>
        <button class="btn" id="btn-album-play-shuffle">🔀 シャッフル再生</button>
        <button class="btn" id="btn-album-edit" style="grid-column: 1 / -1;">✏ アルバム情報・画像を変更</button>
      </div>

      <ul class="album-track-list" id="album-track-list">
        ${renderTrackRows(alb)}
      </ul>
    </section>
  `;
}

function renderTrackRows(alb) {
  let html = "";
  let currentDisc = -1;
  const isMultiDisc = alb.discCount > 1;

  for (const t of alb.tracks) {
    const discNum = parseTrackIndex(t.discNo, 1);
    if (isMultiDisc && discNum !== currentDisc) {
      currentDisc = discNum;
      html += `
        <li class="album-disc-header">
          <span class="disc-label">Disc ${discNum}</span>
        </li>
      `;
    }

    const enabled = t.enabled !== false;
    const loved = !!t.loved;
    const lovedMark = loved
      ? `<span class="track-loved" title="Loved" aria-label="Loved">♥</span>`
      : `<span class="track-loved-spacer" aria-hidden="true"></span>`;

    const trackIndex = parseTrackIndex(t.trackNo, 0);
    const trackNumDisplay = trackIndex > 0 ? String(trackIndex) : "-";
    const durStr = formatTime(t.duration || 0);

    // アーティスト表示: アルバムアーティストと異なる場合は副題に明記
    const artistDisplay = t.artist && t.artist !== alb.albumArtist ? t.artist : "";

    const isGdrive = t.source === "gdrive" || (t.id && t.id.startsWith("gd-"));
    const gdriveMark = isGdrive
      ? `<span class="source-badge gdrive-badge" title="Google Drive 音源">☁</span>`
      : ``;

    html += `
      <li class="track-row album-track-row ${enabled ? "" : "is-disabled"}" data-id="${escapeAttr(t.id)}">
        <span class="album-track-num">${escapeHtml(trackNumDisplay)}</span>
        <div class="track-info">
          <div class="track-title">${gdriveMark}${escapeHtml(t.title || "(無題)")}</div>
          ${artistDisplay ? `<div class="track-sub">${escapeHtml(artistDisplay)}</div>` : ""}
        </div>
        <div class="album-track-right">
          ${lovedMark}
          <button class="icon-btn" data-act="edit" title="曲の情報を編集">✏</button>
          <span class="album-track-dur">${durStr}</span>
        </div>
      </li>
    `;
  }

  return html;
}

function collectRefs(root) {
  return {
    backBtn: root.querySelector("#btn-album-back"),
    artWrapBtn: root.querySelector("#btn-album-art-wrap"),
    playAllBtn: root.querySelector("#btn-album-play-all"),
    playShuffleBtn: root.querySelector("#btn-album-play-shuffle"),
    editAlbumBtn: root.querySelector("#btn-album-edit"),
    list: root.querySelector("#album-track-list"),
  };
}

async function onListClick(e, root) {
  const btn = e.target.closest("button[data-act]");
  if (btn && btn.dataset.act === "edit") {
    const row = btn.closest(".track-row");
    const id = row?.dataset.id;
    const t = album.tracks.find((x) => x.id === id);
    if (t) {
      await editTrackMetadata(t, () => mount(root));
    }
    return;
  }

  const row = e.target.closest(".track-row");
  if (!row || !album) return;
  const id = row.dataset.id;
  const t = album.tracks.find((x) => x.id === id);
  if (!t) return;

  if (t.enabled === false) {
    toast("この曲は再生無効に設定されています", "info");
    return;
  }

  const playable = album.tracks.filter((x) => x.enabled !== false);
  const idx = playable.findIndex((x) => x.id === id);
  if (idx < 0) return;

  // プレイリストコンテキストをクリア
  appState.set({ currentPlaylistId: null, currentPlaylistName: null });

  await setQueueAndPlay(playable, idx);
}

async function playAlbum(shuffle) {
  if (!album || !album.tracks.length) return;
  const playable = album.tracks.filter((t) => t.enabled !== false);
  if (playable.length === 0) {
    toast("再生可能な曲がありません", "info");
    return;
  }

  // プレイリストコンテキストをクリア
  appState.set({ currentPlaylistId: null, currentPlaylistName: null });

  // 既存エンジンに合わせたシャッフル方式
  setShuffleMode(shuffle);
  const startIdx = shuffle ? Math.floor(Math.random() * playable.length) : 0;
  await setQueueAndPlay(playable, startIdx);
}

function updatePlayingHighlight(refs) {
  if (!refs || !refs.list) return;
  const curId = appState.get().currentTrack?.id || null;
  const rows = refs.list.querySelectorAll(".album-track-row[data-id]");
  rows.forEach((row) => {
    const isCur = !!curId && row.dataset.id === curId;
    row.classList.toggle("is-playing", isCur);
  });
}

function formatTotal(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function formatTime(sec) {
  if (!isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
