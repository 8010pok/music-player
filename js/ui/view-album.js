/**
 * アルバム詳細画面
 *
 * - ヘッダー: 戻るボタン、大ジャケット、アルバム名、アルバムアーティスト、年、曲数、合計時間
 * - アクション: 「すべて再生」「シャッフル再生」
 * - 曲一覧: ディスク/トラック番号順、複数ディスク時のDisc見出し、曲タップ再生
 */

import { getAllTracks, deleteTrack, removeTrackFromAllPlaylists } from "../store/library-db.js";
import { groupTracksIntoAlbums, parseTrackIndex } from "../metadata/album-util.js";
import { setQueueAndPlay, setShuffleMode, stopPlayback } from "../player/audio-engine.js";
import { appState } from "../state.js";
import { getArtworkUrl, releaseArtwork } from "./artwork-cache.js";
import { go } from "../router.js";
import { escapeHtml, escapeAttr, toast, confirm } from "./components.js";
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
    editAlbumMetadata(album, (updatedAlb) => {
      if (!updatedAlb) {
        go("albums");
      } else {
        mount(root);
      }
    });
  };
  if (refs.editAlbumBtn) {
    refs.editAlbumBtn.addEventListener("click", openAlbumEditor);
  }
  if (refs.deleteAlbumBtn) {
    refs.deleteAlbumBtn.addEventListener("click", async () => {
      const yes = await confirm(`アルバム「${album.title || "(無題)"}」と属する全 ${album.tracks.length} 曲をすべて削除しますか？\n（曲データは完全に削除されます）`, { danger: true, okLabel: "アルバムを削除" });
      if (yes) {
        for (const t of album.tracks) {
          if (appState.get().currentTrack?.id === t.id) {
            stopPlayback();
          }
          await deleteTrack(t.id).catch(() => {});
          await removeTrackFromAllPlaylists(t.id).catch(() => {});
          releaseArtwork(t.id);
        }
        toast(`アルバムと全 ${album.tracks.length} 曲を削除しました`, "ok");
        go("albums");
      }
    });
  }
  if (refs.artWrapBtn) {
    refs.artWrapBtn.addEventListener("click", openAlbumEditor);
  }
  refs.list.addEventListener("click", (e) => onListClick(e, root));

  // 再生中トラックのハイライト追従
  unsubState = appState.subscribe(["currentTrack", "isPlaying"], () => {
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
  if (alb.year) metaParts.push(`${alb.year}年`);
  metaParts.push(`${alb.trackCount}曲`);
  metaParts.push(totalStr);
  const metaStr = metaParts.join(" • ");

  return `
    <section class="album-detail-view">
      <div class="album-detail-nav">
        <button class="album-nav-back-btn" id="btn-album-back" title="ライブラリへ戻る">
          <svg class="ic" viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          <span>ライブラリ</span>
        </button>
      </div>

      <div class="album-detail-hero">
        <div class="album-detail-art-wrap" id="btn-album-art-wrap" title="クリックしてアルバム画像・情報を変更">
          ${artImg}
          <div class="album-detail-art-badge">📷 画像・情報変更</div>
        </div>
        <div class="album-detail-info">
          <h2 class="album-detail-title">${escapeHtml(alb.title)}</h2>
          <div class="album-detail-artist">
            <a href="#/artist?name=${encodeURIComponent(alb.albumArtist)}" class="artist-link" title="アーティストの詳細へ">${escapeHtml(alb.albumArtist)}</a>
          </div>
          <div class="album-detail-meta">${escapeHtml(metaStr)}</div>
        </div>
      </div>

      <div class="album-detail-actions">
        <button class="album-action-btn primary" id="btn-album-play-all">
          <svg class="ic" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <span>再生</span>
        </button>
        <button class="album-action-btn secondary" id="btn-album-play-shuffle">
          <svg class="ic" viewBox="0 0 24 24"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
          <span>シャッフル</span>
        </button>
        <button class="album-action-btn secondary" id="btn-album-edit" title="アルバム情報・収録曲を一括編集">
          <svg class="ic" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          <span>一括編集</span>
        </button>
        <button class="album-action-btn secondary danger" id="btn-album-delete" title="アルバムを削除" style="color: #ff453a;">
          <svg class="ic" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          <span>削除</span>
        </button>
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
      <li class="track-row album-track-row ${enabled ? "" : "is-disabled"}" data-id="${escapeAttr(t.id)}" data-track-num="${escapeAttr(trackNumDisplay)}">
        <span class="album-track-num-slot"><span class="album-track-num">${escapeHtml(trackNumDisplay)}</span></span>
        <div class="track-info">
          <div class="track-title">${gdriveMark}${escapeHtml(t.title || "(無題)")}</div>
          ${artistDisplay ? `<div class="track-sub">${escapeHtml(artistDisplay)}</div>` : ""}
        </div>
        <div class="album-track-right">
          ${lovedMark}
          <button class="icon-btn edit-track-btn" data-act="edit" title="曲の情報を編集">
            <svg class="ic" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button class="icon-btn delete-track-btn" data-act="delete" title="曲を削除" style="color: #ff453a;">
            <svg class="ic" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
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
    deleteAlbumBtn: root.querySelector("#btn-album-delete"),
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
  if (btn && btn.dataset.act === "delete") {
    const row = btn.closest(".track-row");
    const id = row?.dataset.id;
    const t = album.tracks.find((x) => x.id === id);
    if (t) {
      const yes = await confirm(`「${t.title || "(無題)"}」を削除しますか？`, { danger: true, okLabel: "削除" });
      if (yes) {
        if (appState.get().currentTrack?.id === t.id) {
          stopPlayback();
        }
        try {
          await deleteTrack(t.id);
        } catch (err) {
          console.warn("曲削除に失敗", err);
          toast("削除に失敗しました", "err");
          return;
        }
        await removeTrackFromAllPlaylists(t.id).catch(() => {});
        releaseArtwork(t.id);
        album.tracks = album.tracks.filter((x) => x.id !== t.id);
        if (album.tracks.length === 0) {
          toast("アルバムの全曲が削除されました", "ok");
          go("albums");
        } else {
          toast("削除しました", "ok");
          mount(root);
        }
      }
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
  const s = appState.get();
  const curId = s.currentTrack?.id || null;
  const isPlaying = !!s.isPlaying;
  const rows = refs.list.querySelectorAll(".album-track-row[data-id]");
  rows.forEach((row) => {
    const isCur = !!curId && row.dataset.id === curId;
    row.classList.toggle("is-playing", isCur);
    const slot = row.querySelector(".album-track-num-slot");
    if (slot) {
      if (isCur) {
        slot.innerHTML = `<div class="eq-anim ${isPlaying ? "" : "is-paused"}" aria-label="再生中"><span class="eq-bar b1"></span><span class="eq-bar b2"></span><span class="eq-bar b3"></span></div>`;
      } else {
        const origNum = row.dataset.trackNum || "-";
        slot.innerHTML = `<span class="album-track-num">${escapeHtml(origNum)}</span>`;
      }
    }
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
