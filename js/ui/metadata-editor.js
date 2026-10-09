/**
 * メタデータ編集モーダル
 *
 * - 単一曲のメタデータ編集（タイトル、アーティスト、アルバム、アルバムアーティスト、トラック番号、ディスク番号、年、ジャンル）
 * - アルバム一括メタデータ編集（アルバム名、アルバムアーティスト、アーティスト一括、年、ジャンル）
 * - MusicBrainz & iTunes API からのメタデータ自動検索・ワンクリック反映機能
 * - 編集内容は IndexedDB (tracks) に永続化し、userEdited=true を付与して再スキャンからの上書きを防止
 * - 再生中の曲の場合は appState.currentTrack も即座に同期
 */

import { openModal, toast, escapeHtml, escapeAttr } from "./components.js";
import { updateTrack } from "../store/library-db.js";
import { appState } from "../state.js";
import { searchTrackMetadata, searchAlbumMetadata, fetchArtworkBlob } from "../metadata/musicbrainz.js";

/**
 * 1曲分のメタデータ編集モーダルを表示
 * @param {object} track
 * @param {(updatedTrack: object) => void} [onUpdated]
 * @returns {Promise<object|null>}
 */
export function editTrackMetadata(track, onUpdated) {
  if (!track || !track.id) return Promise.resolve(null);

  return new Promise((resolve) => {
    let pendingArtworkBlob = null;

    const body = document.createElement("div");
    body.className = "metadata-form";

    // 検索語の初期値: アーティストが "(Google Drive)" や "(不明アーティスト)" の場合はファイル名ベース
    const hasMeaningfulArtist = track.artist && !track.artist.includes("Google Drive") && !track.artist.includes("不明");
    const initialQuery = `${hasMeaningfulArtist ? track.artist + " " : ""}${track.title && track.title !== "(無題)" ? track.title : track.originalName || ""}`.trim();

    body.innerHTML = `
      <!-- MusicBrainz / iTunes 自動検索ボックス -->
      <div style="background: var(--bg-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 12px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 6px;">
          🌐 メタデータを自動検索 (MusicBrainz / iTunes)
        </div>
        <div style="display: flex; gap: 6px;">
          <input type="text" id="meta-search-input" value="${escapeAttr(initialQuery)}" placeholder="曲名やアーティスト名を入力…" style="flex: 1; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
          <button type="button" class="btn primary" id="btn-meta-search" style="padding: 4px 10px; font-size: 12px; white-space: nowrap;">検索</button>
        </div>
        <div id="meta-search-results" style="max-height: 180px; overflow-y: auto; margin-top: 8px; display: none;"></div>
      </div>

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
      <div id="meta-art-preview" style="margin-top: 8px; font-size: 11px; color: var(--success); display: none;">
        ✓ アートワーク（ジャケット写真）が選択されました
      </div>
    `;

    // 検索ハンドラ
    const searchInput = body.querySelector("#meta-search-input");
    const searchBtn = body.querySelector("#btn-meta-search");
    const resultsContainer = body.querySelector("#meta-search-results");

    const performSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) return;

      searchBtn.disabled = true;
      searchBtn.textContent = "検索中…";
      resultsContainer.style.display = "block";
      resultsContainer.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--fg-muted); font-size: 11px;">候補を検索中…</div>`;

      try {
        const results = await searchTrackMetadata(q);
        if (results.length === 0) {
          resultsContainer.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--fg-muted); font-size: 11px;">該当する曲が見つかりませんでした</div>`;
          return;
        }

        resultsContainer.innerHTML = results.map((res, i) => `
          <div class="meta-search-item" data-idx="${i}" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-size: 11px; cursor: pointer; border-radius: 4px;">
            <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
              ${res.artworkUrl ? `<img src="${escapeAttr(res.artworkUrl)}" style="width: 32px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0;" />` : `<div style="width: 32px; height: 32px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; font-size: 14px;">🎵</div>`}
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(res.title)}</div>
                <div style="color: var(--fg-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(res.artist)} • ${escapeHtml(res.album || "アルバム不明")} (${escapeHtml(res.year || "年不明")})</div>
              </div>
            </div>
            <button type="button" class="btn btn-apply-meta" data-idx="${i}" style="padding: 3px 8px; font-size: 10px; white-space: nowrap; margin-left: 6px;">
              反映
            </button>
          </div>
        `).join("");

        resultsContainer.querySelectorAll(".btn-apply-meta").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const sel = results[idx];
            if (!sel) return;

            body.querySelector("#meta-title").value = sel.title || "";
            body.querySelector("#meta-artist").value = sel.artist || "";
            body.querySelector("#meta-album").value = sel.album || "";
            body.querySelector("#meta-album-artist").value = sel.albumArtist || sel.artist || "";
            if (sel.trackNo) body.querySelector("#meta-track-no").value = sel.trackNo;
            if (sel.year) body.querySelector("#meta-year").value = sel.year;
            if (sel.genre) body.querySelector("#meta-genre").value = sel.genre;

            if (sel.artworkUrl) {
              btn.textContent = "画像取得…";
              pendingArtworkBlob = await fetchArtworkBlob(sel.artworkUrl);
              const preview = body.querySelector("#meta-art-preview");
              if (preview) preview.style.display = "block";
            }

            toast(`「${sel.title}」のメタデータを入力欄に反映しました`, "ok");
            resultsContainer.style.display = "none";
          });
        });
      } catch (err) {
        resultsContainer.innerHTML = `<div style="padding: 8px; color: var(--err); font-size: 11px;">検索エラー: ${escapeHtml(err.message)}</div>`;
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = "検索";
      }
    };

    searchBtn.addEventListener("click", performSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });

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

            if (pendingArtworkBlob) {
              patch.artworkBlob = pendingArtworkBlob;
            }

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
    let pendingArtworkBlob = null;

    const body = document.createElement("div");
    body.className = "metadata-form";

    const hasMeaningfulArtist = album.albumArtist && !album.albumArtist.includes("Google Drive") && !album.albumArtist.includes("不明");
    const initialQuery = `${hasMeaningfulArtist ? album.albumArtist + " " : ""}${album.title && album.title !== "Google Drive" ? album.title : ""}`.trim();

    body.innerHTML = `
      <p style="font-size: 12px; color: var(--fg-muted); margin-bottom: 10px;">
        このアルバムに属する全 <strong>${album.tracks.length} 曲</strong> の情報を一括で更新します。
      </p>

      <!-- MusicBrainz / iTunes アルバム自動検索ボックス -->
      <div style="background: var(--bg-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 12px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 6px;">
          🌐 アルバム情報を自動検索 (MusicBrainz / iTunes)
        </div>
        <div style="display: flex; gap: 6px;">
          <input type="text" id="meta-alb-search-input" value="${escapeAttr(initialQuery)}" placeholder="アルバム名やアーティスト名を入力…" style="flex: 1; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
          <button type="button" class="btn primary" id="btn-meta-alb-search" style="padding: 4px 10px; font-size: 12px; white-space: nowrap;">検索</button>
        </div>
        <div id="meta-alb-search-results" style="max-height: 180px; overflow-y: auto; margin-top: 8px; display: none;"></div>
      </div>

      <div class="modal-row">
        <label for="meta-alb-title">アルバム名</label>
        <input type="text" id="meta-alb-title" value="${escapeAttr(album.title || "")}" placeholder="アルバム名" />
      </div>
      <div class="modal-row">
        <label for="meta-alb-artist">アルバムアーティスト</label>
        <input type="text" id="meta-alb-artist" value="${escapeAttr(album.albumArtist || "")}" placeholder="アルバムアーティスト" />
      </div>
      <div class="modal-row">
        <label for="meta-alb-track-artist">全曲のアーティスト名も統一する (任意)</label>
        <input type="text" id="meta-alb-track-artist" value="${escapeAttr(album.albumArtist || "")}" placeholder="全曲に適用するアーティスト名" />
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div class="modal-row">
          <label for="meta-alb-year">リリース年</label>
          <input type="text" id="meta-alb-year" value="${escapeAttr(album.year || "")}" placeholder="例: 2024" />
        </div>
        <div class="modal-row">
          <label for="meta-alb-genre">ジャンル</label>
          <input type="text" id="meta-alb-genre" value="${escapeAttr(album.genre || "")}" placeholder="ジャンル" />
        </div>
      </div>
      <div id="meta-alb-art-preview" style="margin-top: 8px; font-size: 11px; color: var(--success); display: none;">
        ✓ アルバムジャケット画像が全曲に一括適用されます
      </div>
    `;

    // アルバム検索ハンドラ
    const searchInput = body.querySelector("#meta-alb-search-input");
    const searchBtn = body.querySelector("#btn-meta-alb-search");
    const resultsContainer = body.querySelector("#meta-alb-search-results");

    const performSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) return;

      searchBtn.disabled = true;
      searchBtn.textContent = "検索中…";
      resultsContainer.style.display = "block";
      resultsContainer.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--fg-muted); font-size: 11px;">アルバム候補を検索中…</div>`;

      try {
        const results = await searchAlbumMetadata(q);
        if (results.length === 0) {
          resultsContainer.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--fg-muted); font-size: 11px;">該当するアルバムが見つかりませんでした</div>`;
          return;
        }

        resultsContainer.innerHTML = results.map((res, i) => `
          <div class="meta-search-item" data-idx="${i}" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-size: 11px; cursor: pointer; border-radius: 4px;">
            <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
              ${res.artworkUrl ? `<img src="${escapeAttr(res.artworkUrl)}" style="width: 32px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0;" />` : `<div style="width: 32px; height: 32px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; font-size: 14px;">💿</div>`}
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(res.title)}</div>
                <div style="color: var(--fg-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(res.artist)} • ${escapeHtml(res.year || "年不明")} (${res.trackCount ? res.trackCount + "曲" : ""})</div>
              </div>
            </div>
            <button type="button" class="btn btn-apply-alb-meta" data-idx="${i}" style="padding: 3px 8px; font-size: 10px; white-space: nowrap; margin-left: 6px;">
              一括反映
            </button>
          </div>
        `).join("");

        resultsContainer.querySelectorAll(".btn-apply-alb-meta").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const sel = results[idx];
            if (!sel) return;

            body.querySelector("#meta-alb-title").value = sel.title || "";
            body.querySelector("#meta-alb-artist").value = sel.artist || "";
            body.querySelector("#meta-alb-track-artist").value = sel.artist || "";
            if (sel.year) body.querySelector("#meta-alb-year").value = sel.year;
            if (sel.genre) body.querySelector("#meta-alb-genre").value = sel.genre;

            if (sel.artworkUrl) {
              btn.textContent = "画像取得…";
              pendingArtworkBlob = await fetchArtworkBlob(sel.artworkUrl);
              const preview = body.querySelector("#meta-alb-art-preview");
              if (preview) preview.style.display = "block";
            }

            toast(`「${sel.title}」のアルバム情報を入力欄に反映しました`, "ok");
            resultsContainer.style.display = "none";
          });
        });
      } catch (err) {
        resultsContainer.innerHTML = `<div style="padding: 8px; color: var(--err); font-size: 11px;">検索エラー: ${escapeHtml(err.message)}</div>`;
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = "検索";
      }
    };

    searchBtn.addEventListener("click", performSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });

    openModal({
      title: "アルバム情報を一括編集",
      body,
      actions: [
        {
          label: "キャンセル",
          onClick: () => resolve(null),
        },
        {
          label: "全曲に一括保存",
          primary: true,
          onClick: async () => {
            const albumName = body.querySelector("#meta-alb-title").value.trim() || "不明なアルバム";
            const albumArtist = body.querySelector("#meta-alb-artist").value.trim() || "不明なアーティスト";
            const trackArtist = body.querySelector("#meta-alb-track-artist").value.trim();
            const year = body.querySelector("#meta-alb-year").value.trim();
            const genre = body.querySelector("#meta-alb-genre").value.trim();

            const patch = {
              album: albumName,
              albumArtist,
              year,
              userEdited: true,
            };
            if (genre) patch.genre = genre;
            if (trackArtist) patch.artist = trackArtist;
            if (pendingArtworkBlob) patch.artworkBlob = pendingArtworkBlob;

            for (const t of album.tracks) {
              await updateTrack(t.id, patch);
              Object.assign(t, patch);
            }

            album.title = albumName;
            album.albumArtist = albumArtist;
            album.year = year;
            if (genre) album.genre = genre;

            // 再生中の曲が含まれていれば appState も同期
            const cur = appState.get().currentTrack;
            if (cur && album.tracks.some((t) => t.id === cur.id)) {
              appState.set({ currentTrack: { ...cur, ...patch } });
            }

            toast(`${album.tracks.length} 曲のアルバム情報を一括更新しました`, "ok");
            if (typeof onUpdated === "function") onUpdated(album);
            resolve(album);
          },
        },
      ],
    });
  });
}
