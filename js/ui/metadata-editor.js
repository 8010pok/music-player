/**
 * メタデータ編集モーダル
 *
 * - 単一曲のメタデータ編集（タイトル、アーティスト、アルバム、アルバムアーティスト、トラック番号、ディスク番号、年、ジャンル）
 * - アルバム一括メタデータ編集（アルバム名、アルバムアーティスト、年）
 * - 編集内容は IndexedDB (tracks) に永続化し、userEdited=true を付与して再スキャンからの上書きを防止
 * - 再生中の曲の場合は appState.currentTrack も即座に同期
 */

import { openModal, toast, escapeHtml, escapeAttr } from "./components.js";
import { updateTrack } from "../store/library-db.js";
import { appState } from "../state.js";

/**
 * 1曲分のメタデータ編集モーダルを表示
 * @param {object} track
 * @param {(updatedTrack: object) => void} [onUpdated]
 * @returns {Promise<object|null>}
 */
export function editTrackMetadata(track, onUpdated) {
  if (!track || !track.id) return Promise.resolve(null);

  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "metadata-form";
    body.innerHTML = `
      <div class="modal-row">
        <label for="meta-title">曲名</label>
        <input type="text" id="meta-title" value="${escapeAttr(track.title || "")}" placeholder="曲名" />
      </div>
      <div class="modal-row">
        <label for="meta-artist">アーティスト</label>
        <input type="text" id="meta-artist" value="${escapeAttr(track.artist || "")}" placeholder="アーティスト" />
      </div>
      <div class="modal-row">
        <label for="meta-album">アルバム名</label>
        <input type="text" id="meta-album" value="${escapeAttr(track.album || "")}" placeholder="アルバム名" />
      </div>
      <div class="modal-row">
        <label for="meta-album-artist">アルバムアーティスト</label>
        <input type="text" id="meta-album-artist" value="${escapeAttr(track.albumArtist || "")}" placeholder="アルバムアーティスト" />
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div class="modal-row">
          <label for="meta-track-no">トラック番号</label>
          <input type="text" id="meta-track-no" value="${escapeAttr(track.trackNo || "")}" placeholder="例: 1 または 1/12" />
        </div>
        <div class="modal-row">
          <label for="meta-disc-no">ディスク番号</label>
          <input type="text" id="meta-disc-no" value="${escapeAttr(track.discNo || "")}" placeholder="例: 1" />
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div class="modal-row">
          <label for="meta-year">リリース年</label>
          <input type="text" id="meta-year" value="${escapeAttr(track.year || "")}" placeholder="例: 2024" />
        </div>
        <div class="modal-row">
          <label for="meta-genre">ジャンル</label>
          <input type="text" id="meta-genre" value="${escapeAttr(track.genre || "")}" placeholder="ジャンル" />
        </div>
      </div>
    `;

    openModal({
      title: "曲の情報を編集",
      body,
      actions: [
        {
          label: "キャンセル",
          onClick: () => resolve(null),
        },
        {
          label: "保存",
          primary: true,
          onClick: async () => {
            const title = body.querySelector("#meta-title").value.trim() || "(無題)";
            const artist = body.querySelector("#meta-artist").value.trim() || "(不明アーティスト)";
            const album = body.querySelector("#meta-album").value.trim();
            const albumArtist = body.querySelector("#meta-album-artist").value.trim();
            const trackNo = body.querySelector("#meta-track-no").value.trim();
            const discNo = body.querySelector("#meta-disc-no").value.trim();
            const year = body.querySelector("#meta-year").value.trim();
            const genre = body.querySelector("#meta-genre").value.trim();

            const patch = {
              title,
              artist,
              album,
              albumArtist,
              trackNo,
              discNo,
              year,
              genre,
              userEdited: true,
            };

            await updateTrack(track.id, patch);
            Object.assign(track, patch);

            // 再生中の曲なら appState の currentTrack も更新
            const cur = appState.get().currentTrack;
            if (cur && cur.id === track.id) {
              appState.set({ currentTrack: { ...cur, ...patch } });
            }

            toast("メタデータを更新しました", "ok");
            if (typeof onUpdated === "function") onUpdated(track);
            resolve(track);
          },
        },
      ],
    });
  });
}

/**
 * アルバム全体の一括メタデータ編集モーダルを表示
 * @param {object} album
 * @param {(updatedAlbum: object) => void} [onUpdated]
 * @returns {Promise<object|null>}
 */
export function editAlbumMetadata(album, onUpdated) {
  if (!album || !album.tracks || album.tracks.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.className = "metadata-form";
    body.innerHTML = `
      <p style="font-size: 12px; color: var(--fg-muted); margin-bottom: 12px;">
        このアルバムに属する全 ${album.tracks.length} 曲のアルバム情報を一括で更新します。
      </p>
      <div class="modal-row">
        <label for="meta-alb-title">アルバム名</label>
        <input type="text" id="meta-alb-title" value="${escapeAttr(album.title || "")}" placeholder="アルバム名" />
      </div>
      <div class="modal-row">
        <label for="meta-alb-artist">アルバムアーティスト</label>
        <input type="text" id="meta-alb-artist" value="${escapeAttr(album.albumArtist || "")}" placeholder="アルバムアーティスト" />
      </div>
      <div class="modal-row">
        <label for="meta-alb-year">リリース年</label>
        <input type="text" id="meta-alb-year" value="${escapeAttr(album.year || "")}" placeholder="例: 2024" />
      </div>
    `;

    openModal({
      title: "アルバム情報を編集",
      body,
      actions: [
        {
          label: "キャンセル",
          onClick: () => resolve(null),
        },
        {
          label: "一括保存",
          primary: true,
          onClick: async () => {
            const albumName = body.querySelector("#meta-alb-title").value.trim() || "不明なアルバム";
            const albumArtist = body.querySelector("#meta-alb-artist").value.trim() || "不明なアーティスト";
            const year = body.querySelector("#meta-alb-year").value.trim();

            const patch = {
              album: albumName,
              albumArtist,
              year,
              userEdited: true,
            };

            for (const t of album.tracks) {
              await updateTrack(t.id, patch);
              Object.assign(t, patch);
            }

            album.title = albumName;
            album.albumArtist = albumArtist;
            album.year = year;

            // 再生中の曲が含まれていれば appState も同期
            const cur = appState.get().currentTrack;
            if (cur && album.tracks.some((t) => t.id === cur.id)) {
              appState.set({ currentTrack: { ...cur, ...patch } });
            }

            toast(`${album.tracks.length} 曲のアルバム情報を更新しました`, "ok");
            if (typeof onUpdated === "function") onUpdated(album);
            resolve(album);
          },
        },
      ],
    });
  });
}
