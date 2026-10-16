/**
 * アルバム詳細画面
 *
 * - ヘッダー: 戻るボタン、大ジャケット、アルバム名、アルバムアーティスト、年、曲数、合計時間
 * - アクション: 「すべて再生」「シャッフル再生」
 * - 曲一覧: ディスク/トラック番号順、複数ディスク時のDisc見出し、曲タップ再生
 */

import { getAllTracks, deleteTrack, removeTrackFromAllPlaylists, updateTrack, getAllPlaylists, savePlaylist, addTracksToPlaylist } from "../store/library-db.js";
import { groupTracksIntoAlbums, parseTrackIndex } from "../metadata/album-util.js";
import { setQueueAndPlay, setShuffleMode, stopPlayback, prewarmTrack, prewarmTracks, playNextTrack, addToQueueEnd } from "../player/audio-engine.js";
import { appState } from "../state.js";
import { getArtworkUrl, releaseArtwork } from "./artwork-cache.js";
import { go } from "../router.js";
import { escapeHtml, escapeAttr, toast, confirm, openModal, dismissActiveModal, promptForm } from "./components.js";
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

  // ★ アルバム画面を開いた時点で楽曲を先行プリウォーム（キャッシュ済み曲のみ最大5曲）
  if (album && Array.isArray(album.tracks)) {
    prewarmTracks(album.tracks.map((t) => t.id), 5);
  }

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
  if (refs.cacheAllBtn) {
    refs.cacheAllBtn.addEventListener("click", async () => {
      refs.cacheAllBtn.disabled = true;
      const uncached = album.tracks.filter((t) => (t.source === "gdrive" || (t.id && t.id.startsWith("gd-"))) && !t.cached);
      if (uncached.length === 0) {
        toast("すべての曲がすでに保存されています", "info");
        return;
      }
      toast(`${uncached.length} 曲のオフライン保存を開始します…`, "info");
      let done = 0;
      const total = uncached.length;
      const { getBlob } = await import("../store/library-db.js");
      let index = 0;
      let success = 0;
      const CONCURRENCY = 2;
      async function worker() {
        while (index < uncached.length) {
          const curIdx = index++;
          const t = uncached[curIdx];
          try {
            await getBlob(t.id);
            t.cached = true;
            success++;
          } catch (e) {
            console.warn("一括保存失敗", t.id, e);
          }
          done++;
          if (refs.cacheBtnText) {
            refs.cacheBtnText.textContent = `保存中 (${done}/${total})`;
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uncached.length) }, () => worker()));
      toast(`${success} / ${total} 曲のオフライン保存が完了しました`, "ok");
      mount(root);
    });
  }
  refs.list.addEventListener("click", (e) => onListClick(e, root));
  refs.list.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".track-row");
    if (row && row.dataset.id) {
      prewarmTrack(row.dataset.id, { onlyIfCached: true });
    }
  }, { passive: true });

  // 再生中トラック・ローディング中トラックのハイライト追従
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
        ${alb.tracks.some((t) => (t.source === "gdrive" || (t.id && t.id.startsWith("gd-"))) && !t.cached)
          ? `<button class="album-action-btn secondary" id="btn-album-cache-all" title="未キャッシュの曲を一括オフライン保存">
              <svg class="ic" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>
              <span id="album-cache-btn-text">一括保存 (${alb.tracks.filter((t) => (t.source === "gdrive" || (t.id && t.id.startsWith("gd-"))) && !t.cached).length})</span>
            </button>`
          : ""
        }
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
    const discNum = parseTrackIndex(t.discNo != null ? t.discNo : t?.discNumber, 1);
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

    const trackIndex = parseTrackIndex(t.trackNo != null ? t.trackNo : t?.trackNumber, 0);
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
          <div class="track-title">${gdriveMark}${escapeHtml(t.title || "(無題)")}${t.memo ? ` <span class="track-memo-badge" title="${escapeAttr(t.memo)}">${escapeHtml(t.memo)}</span>` : ""}</div>
          ${artistDisplay ? `<div class="track-sub">${escapeHtml(artistDisplay)}</div>` : ""}
        </div>
        <div class="album-track-right">
          ${lovedMark}
          <span class="album-track-dur">${durStr}</span>
          <button class="icon-btn album-track-more-btn" data-act="more" title="メニュー" aria-label="曲メニュー">
            <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="12" cy="19" r="1.75"/></svg>
          </button>
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
    cacheAllBtn: root.querySelector("#btn-album-cache-all"),
    cacheBtnText: root.querySelector("#album-cache-btn-text"),
    editAlbumBtn: root.querySelector("#btn-album-edit"),
    deleteAlbumBtn: root.querySelector("#btn-album-delete"),
    list: root.querySelector("#album-track-list"),
  };
}

async function onListClick(e, root) {
  const btn = e.target.closest("button[data-act]");
  if (btn && btn.dataset.act === "more") {
    e.stopPropagation();
    const row = btn.closest(".track-row");
    const id = row?.dataset.id;
    const t = album.tracks.find((x) => x.id === id);
    if (t) {
      openTrackActionsModal(t, root);
    }
    return;
  }
  if (btn && btn.dataset.act === "play-next") {
    const row = btn.closest(".track-row");
    const t = album.tracks.find((x) => x.id === row?.dataset.id);
    if (t) playNextTrack(t);
    return;
  }
  if (btn && btn.dataset.act === "add-queue") {
    const row = btn.closest(".track-row");
    const t = album.tracks.find((x) => x.id === row?.dataset.id);
    if (t) addToQueueEnd(t);
    return;
  }
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

  // アルバム曲タップ時はアルバム曲順で連続再生されるようシャッフルを解除
  setShuffleMode(false);

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
  const loadingId = s.loadingTrackId || null;
  const isPlaying = !!s.isPlaying;
  const rows = refs.list.querySelectorAll(".album-track-row[data-id]");
  rows.forEach((row) => {
    const isCur = !!curId && row.dataset.id === curId;
    const isLoading = !!loadingId && row.dataset.id === loadingId;
    row.classList.toggle("is-playing", isCur);
    row.classList.toggle("is-loading", isLoading);
    const slot = row.querySelector(".album-track-num-slot");
    if (slot) {
      if (isLoading) {
        slot.innerHTML = `<span class="track-spinner" aria-label="読み込み中"></span>`;
      } else if (isCur) {
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

/**
 * トラックのアクションメニュー（3点リーダー押下時）
 */
function openTrackActionsModal(track, root) {
  if (!track) return;
  const isLoved = !!track.loved;
  const actions = [
    {
      label: "⏭ 次に再生",
      primary: true,
      onClick: () => {
        playNextTrack(track);
      },
    },
    {
      label: "＋ 再生待ちキューの最後に追加",
      onClick: () => {
        addToQueueEnd(track);
      },
    },
    {
      label: "📑 プレイリストに追加",
      onClick: () => {
        openAddToPlaylistModal(track);
      },
    },
    {
      label: "✏️ メタデータ（曲情報）を編集",
      onClick: () => {
        editTrackMetadata(track, () => mount(root));
      },
    },
    {
      label: isLoved ? "💔 お気に入り（Loved）を解除" : "❤️ お気に入り（Loved）に追加",
      onClick: async () => {
        const nextLoved = !isLoved;
        await updateTrack(track.id, { loved: nextLoved });
        track.loved = nextLoved;
        toast(nextLoved ? "お気に入りに追加しました" : "お気に入りを解除しました", "ok");
        mount(root);
      },
    },
    {
      label: "🗑️ ライブラリから削除",
      danger: true,
      onClick: async () => {
        const yes = await confirm(`「${track.title || "(無題)"}」を削除しますか？\n（曲データは完全に削除されます）`, { danger: true, okLabel: "削除" });
        if (yes) {
          if (appState.get().currentTrack?.id === track.id) {
            stopPlayback();
          }
          try {
            await deleteTrack(track.id);
          } catch (err) {
            console.warn("曲削除に失敗", err);
            toast("削除に失敗しました", "err");
            return;
          }
          await removeTrackFromAllPlaylists(track.id).catch(() => {});
          releaseArtwork(track.id);
          album.tracks = album.tracks.filter((x) => x.id !== track.id);
          if (album.tracks.length === 0) {
            toast("アルバムの全曲が削除されました", "ok");
            go("albums");
          } else {
            toast("削除しました", "ok");
            mount(root);
          }
        }
      },
    },
  ];

  const bodyEl = document.createElement("div");
  bodyEl.style.fontSize = "13px";
  bodyEl.style.color = "var(--fg-muted)";
  bodyEl.style.padding = "4px 0 8px";
  const artistText = track.artist || (album ? album.albumArtist : "");
  bodyEl.textContent = artistText ? `アーティスト: ${artistText}` : "";

  openModal({
    title: track.title || "(無題)",
    body: bodyEl,
    actions,
  });
}

/**
 * プレイリスト選択・追加モーダル
 */
async function openAddToPlaylistModal(track) {
  const playlists = await getAllPlaylists();
  const wrap = document.createElement("div");
  wrap.className = "playlist-picker-modal";

  let listHtml = `
    <div class="playlist-picker-list">
      <button type="button" class="playlist-picker-item create-new" id="btn-create-playlist-for-track">
        <span class="pl-picker-icon">➕</span>
        <div class="pl-picker-text">
          <div class="pl-picker-title">新規プレイリストを作成して追加</div>
        </div>
      </button>
  `;

  if (playlists.length === 0) {
    listHtml += `<div class="empty-hint" style="padding: 16px 10px; font-size: 13px; color: var(--fg-muted); text-align: center;">作成済みのプレイリストはありません</div>`;
  } else {
    for (const pl of playlists) {
      const count = Array.isArray(pl.trackIds) ? pl.trackIds.length : 0;
      const alreadyIn = Array.isArray(pl.trackIds) && pl.trackIds.includes(track.id);
      listHtml += `
        <button type="button" class="playlist-picker-item ${alreadyIn ? "is-added" : ""}" data-pl-id="${escapeAttr(pl.id)}">
          <span class="pl-picker-icon">📑</span>
          <div class="pl-picker-text">
            <div class="pl-picker-title">${escapeHtml(pl.name || "(無題)")}</div>
            <div class="pl-picker-sub">${count}曲 ${alreadyIn ? "（追加済み）" : ""}</div>
          </div>
          ${alreadyIn ? '<span class="pl-picker-check">✓</span>' : ""}
        </button>
      `;
    }
  }
  listHtml += `</div>`;
  wrap.innerHTML = listHtml;

  openModal({
    title: `「${track.title || "曲"}」をプレイリストに追加`,
    body: wrap,
    actions: [
      { label: "キャンセル" },
    ],
  });

  const createBtn = wrap.querySelector("#btn-create-playlist-for-track");
  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      dismissActiveModal();
      const res = await promptForm("新規プレイリスト", [
        { name: "name", label: "プレイリスト名", value: "", placeholder: "例: マイベスト" },
      ], { okLabel: "作成して追加" });
      if (res && res.name && res.name.trim()) {
        const newId = "pl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        const newPl = {
          id: newId,
          name: res.name.trim(),
          trackIds: [track.id],
          createdAt: Date.now(),
        };
        await savePlaylist(newPl);
        toast(`プレイリスト「${newPl.name}」を作成し、曲を追加しました`, "ok");
      }
    });
  }

  wrap.querySelectorAll(".playlist-picker-item[data-pl-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const plId = btn.dataset.plId;
      const targetPl = playlists.find((p) => p.id === plId);
      if (!targetPl) return;
      dismissActiveModal();
      await addTracksToPlaylist(plId, [track.id]);
      toast(`「${targetPl.name}」に追加しました`, "ok");
    });
  });
}

