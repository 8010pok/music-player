/**
 * メタデータ編集モーダル
 *
 * - 単一曲のメタデータ編集（タイトル、アーティスト、アルバム、アルバムアーティスト、トラック番号、ディスク番号、年、ジャンル、曲削除）
 * - アルバム一括メタデータ編集（アルバム名、アルバムアーティスト、アーティスト一括、年、ジャンル、全収録曲の個別タイトル・番号の一括編集、アルバム削除）
 * - MusicBrainz & iTunes API からのメタデータ自動検索・トラックリスト一括流し込み機能
 * - 編集内容は IndexedDB (tracks) に永続化し、userEdited=true を付与して再スキャンからの上書きを防止
 * - 再生中の曲の場合は appState.currentTrack も即座に同期
 */

import { openModal, toast, escapeHtml, escapeAttr } from "./components.js";
import { updateTrack, deleteTrack, removeTrackFromAllPlaylists } from "../store/library-db.js";
import { stopPlayback } from "../player/audio-engine.js";
import { appState } from "../state.js";
import { releaseArtwork, getArtworkUrl } from "./artwork-cache.js";
import { searchTrackMetadata, searchAlbumMetadata, fetchArtworkBlob, fetchAlbumTracklist, cleanQuery } from "../metadata/musicbrainz.js";

/**
 * 1曲分のメタデータ編集モーダルを表示
 * @param {object} track
 * @param {(updatedTrack: object|null) => void} [onUpdated]
 * @returns {Promise<object|null>}
 */
export function editTrackMetadata(track, onUpdated) {
  if (!track || !track.id) return Promise.resolve(null);

  return new Promise((resolve) => {
    let pendingArtworkBlob = undefined;
    const initialArtUrl = track.artworkBlob ? getArtworkUrl(track) : null;
    let localPreviewUrl = null;

    const body = document.createElement("div");
    body.className = "metadata-form";

    // 検索語の初期値: アーティストが "(Google Drive)" や "(不明アーティスト)" の場合はファイル名ベース
    const hasMeaningfulArtist = track.artist && !track.artist.includes("Google Drive") && !track.artist.includes("不明");
    const cleanArtist = cleanQuery(track.artist || "");
    const cleanTitle = cleanQuery(track.title || track.originalName || "");
    const initialQuery = `${hasMeaningfulArtist && cleanArtist ? cleanArtist + " " : ""}${cleanTitle !== "(無題)" ? cleanTitle : cleanQuery(track.originalName || "")}`.trim();

    body.innerHTML = `
      <!-- MusicBrainz / iTunes 自動検索ボックス -->
      <div style="background: var(--bg-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 12px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 6px;">
          🌐 メタデータを自動検索 (MusicBrainz / iTunes 日本ストア優先)
        </div>
        <div style="display: flex; gap: 6px;">
          <input type="text" id="meta-search-input" value="${escapeAttr(initialQuery)}" placeholder="曲名やアーティスト名を入力…" style="flex: 1; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
          <button type="button" class="btn primary" id="btn-meta-search" style="padding: 4px 10px; font-size: 12px; white-space: nowrap;">検索</button>
        </div>
        <div id="meta-search-results" style="max-height: 180px; overflow-y: auto; margin-top: 8px; display: none;"></div>
      </div>

      <!-- ジャケット写真プレビュー & 変更 -->
      <div class="modal-row" style="margin-bottom: 12px; background: var(--bg-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color);">
        <label style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 8px; display: block;">
          🖼 ジャケット画像
        </label>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div id="meta-track-art-box" style="width: 64px; height: 64px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.2);"></div>
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0;">
            <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              <label for="meta-track-file-input" class="btn" style="padding: 4px 10px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; margin: 0;">
                📁 画像を選択…
              </label>
              <input type="file" id="meta-track-file-input" accept="image/png, image/jpeg, image/webp, image/gif, image/*" style="display: none;" />
              <button type="button" class="btn danger" id="btn-meta-track-remove-art" style="padding: 4px 8px; font-size: 11px;">
                ✕ 削除
              </button>
            </div>
            <div id="meta-track-art-status" style="font-size: 11px; color: var(--fg-muted); line-height: 1.3;">
              現在の画像
            </div>
          </div>
        </div>
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
    `;

    // アートワークプレビュー描画
    const renderTrackArtPreview = () => {
      const box = body.querySelector("#meta-track-art-box");
      const status = body.querySelector("#meta-track-art-status");
      const removeBtn = body.querySelector("#btn-meta-track-remove-art");
      if (!box) return;

      if (localPreviewUrl) {
        try { URL.revokeObjectURL(localPreviewUrl); } catch {}
        localPreviewUrl = null;
      }

      let displayUrl = null;
      if (pendingArtworkBlob instanceof Blob) {
        localPreviewUrl = URL.createObjectURL(pendingArtworkBlob);
        displayUrl = localPreviewUrl;
      } else if (pendingArtworkBlob === null) {
        displayUrl = null;
      } else {
        displayUrl = initialArtUrl;
      }

      if (displayUrl) {
        box.innerHTML = `<img src="${escapeAttr(displayUrl)}" style="width: 100%; height: 100%; object-fit: cover; display: block;" />`;
        if (removeBtn) removeBtn.style.display = "inline-flex";
      } else {
        box.innerHTML = `<div style="font-size: 26px;">🎵</div>`;
        if (removeBtn) removeBtn.style.display = "none";
      }

      if (status) {
        if (pendingArtworkBlob instanceof Blob) {
          const sizeKb = Math.round(pendingArtworkBlob.size / 1024);
          status.innerHTML = `<span style="color: var(--success); font-weight: 600;">✓ 新しい画像を設定中 (${sizeKb} KB)</span>`;
        } else if (pendingArtworkBlob === null) {
          status.innerHTML = `<span style="color: var(--err); font-weight: 600;">✕ 画像を削除（未設定になります）</span>`;
        } else {
          status.textContent = initialArtUrl ? "現在の画像" : "画像なし";
        }
      }
    };

    renderTrackArtPreview();

    // 画像ファイル選択ハンドラ
    const trackFileInput = body.querySelector("#meta-track-file-input");
    trackFileInput?.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        toast("画像ファイルを選択してください", "err");
        return;
      }
      pendingArtworkBlob = file;
      renderTrackArtPreview();
      toast("画像を選択しました。「保存」で反映されます", "ok");
    });

    body.querySelector("#btn-meta-track-remove-art")?.addEventListener("click", () => {
      pendingArtworkBlob = null;
      renderTrackArtPreview();
      toast("画像を削除に設定しました", "info");
    });

    // 自動検索ハンドラ
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
                <div style="color: var(--fg-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(res.artist)} • ${escapeHtml(res.album || "アルバム不明")} (${escapeHtml(res.source)})</div>
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
              const blob = await fetchArtworkBlob(sel.artworkUrl);
              if (blob) {
                pendingArtworkBlob = blob;
                renderTrackArtPreview();
              }
            }

            toast(`「${sel.title}」の情報を入力欄に反映しました`, "ok");
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
          label: "🗑 曲を削除",
          danger: true,
          onClick: async () => {
            const confirmed = window.confirm(`「${track.title || "(無題)"}」をライブラリから完全に削除しますか？\n（本体・Google Drive音源データは保持されます）`);
            if (!confirmed) return false;
            if (appState.get().currentTrack?.id === track.id) {
              stopPlayback();
            }
            try {
              await deleteTrack(track.id);
              await removeTrackFromAllPlaylists(track.id).catch(() => {});
              releaseArtwork(track.id);
              toast("曲を削除しました", "ok");
              if (localPreviewUrl) try { URL.revokeObjectURL(localPreviewUrl); } catch {}
              if (typeof onUpdated === "function") onUpdated(null);
              resolve(null);
              return true;
            } catch (err) {
              console.warn("曲削除失敗:", err);
              toast("削除に失敗しました", "err");
              return false;
            }
          },
        },
        {
          label: "キャンセル",
          onClick: () => {
            if (localPreviewUrl) try { URL.revokeObjectURL(localPreviewUrl); } catch {}
            resolve(null);
          },
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

            if (pendingArtworkBlob !== undefined) {
              patch.artworkBlob = pendingArtworkBlob;
            }

            await updateTrack(track.id, patch);
            releaseArtwork(track.id);
            Object.assign(track, patch);

            // 再生中の曲なら appState の currentTrack も更新
            const cur = appState.get().currentTrack;
            if (cur && cur.id === track.id) {
              releaseArtwork(cur.id);
              appState.set({ currentTrack: { ...cur, ...patch } });
            }

            if (localPreviewUrl) try { URL.revokeObjectURL(localPreviewUrl); } catch {}
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
 * @param {(updatedAlbum: object|null) => void} [onUpdated]
 * @returns {Promise<object|null>}
 */
export function editAlbumMetadata(album, onUpdated) {
  if (!album || !album.tracks || album.tracks.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let pendingArtworkBlob = undefined;
    const currentArtTrack = album.artworkTrack || album.tracks.find((t) => t.artworkBlob);
    const initialArtUrl = currentArtTrack ? getArtworkUrl(currentArtTrack) : null;
    let localPreviewUrl = null;

    const body = document.createElement("div");
    body.className = "metadata-form";

    const cleanArtist = cleanQuery(album.albumArtist || "");
    const cleanAlb = cleanQuery(album.title || "");
    const initialQuery = `${cleanArtist ? cleanArtist + " " : ""}${cleanAlb !== "Google Drive" ? cleanAlb : ""}`.trim();

    body.innerHTML = `
      <p style="font-size: 12px; color: var(--fg-muted); margin-bottom: 10px;">
        このアルバムに属する全 <strong>${album.tracks.length} 曲</strong> の情報・トラックリストを一括で更新します。
      </p>

      <!-- MusicBrainz / iTunes アルバム自動検索ボックス -->
      <div style="background: var(--bg-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 12px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 6px;">
          🌐 アルバム＆曲目を自動検索 (MusicBrainz / iTunes 日本ストア優先)
        </div>
        <div style="display: flex; gap: 6px;">
          <input type="text" id="meta-alb-search-input" value="${escapeAttr(initialQuery)}" placeholder="アルバム名やアーティスト名を入力…" style="flex: 1; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
          <button type="button" class="btn primary" id="btn-meta-alb-search" style="padding: 4px 10px; font-size: 12px; white-space: nowrap;">検索</button>
        </div>
        <div id="meta-alb-search-results" style="max-height: 180px; overflow-y: auto; margin-top: 8px; display: none;"></div>
      </div>

      <!-- アルバムジャケット画像プレビュー & 変更 -->
      <div class="modal-row" style="margin-bottom: 12px; background: var(--bg-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border-color);">
        <label style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 8px; display: block;">
          🖼 アルバムジャケット画像（全曲に一括適用）
        </label>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div id="meta-alb-art-box" style="width: 72px; height: 72px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.2);"></div>
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0;">
            <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              <label for="meta-alb-file-input" class="btn" style="padding: 4px 10px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; margin: 0;">
                📁 画像を選択…
              </label>
              <input type="file" id="meta-alb-file-input" accept="image/png, image/jpeg, image/webp, image/gif, image/*" style="display: none;" />
              <button type="button" class="btn danger" id="btn-meta-alb-remove-art" style="padding: 4px 8px; font-size: 11px;">
                ✕ 削除
              </button>
            </div>
            <div id="meta-alb-art-status" style="font-size: 11px; color: var(--fg-muted); line-height: 1.3;">
              現在のアルバム画像
            </div>
          </div>
        </div>
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
        <label for="meta-alb-track-artist">全曲のアーティスト名を統一する (任意)</label>
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

      <!-- 収録曲の個別タイトル・トラック番号一括編集リスト -->
      <div class="modal-row" style="margin-top: 14px; border-top: 1px solid var(--border-color); padding-top: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label style="font-size: 12px; font-weight: 600; color: var(--accent); margin: 0;">
            🎵 収録曲の個別タイトル・番号 (${album.tracks.length}曲)
          </label>
          <span style="font-size: 10px; color: var(--fg-muted);">直接編集または検索結果から一括自動入力</span>
        </div>
        <div class="meta-album-tracklist" id="meta-alb-tracklist" style="display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; padding-right: 4px;">
          ${album.tracks.map((t, i) => `
            <div class="meta-album-track-row" data-track-id="${escapeAttr(t.id)}" style="display: flex; gap: 6px; align-items: center; background: var(--bg-surface); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color);">
              <input type="text" class="meta-track-no-input" value="${escapeAttr(t.trackNo || String(i + 1))}" placeholder="番号" style="width: 44px; text-align: center; font-size: 11px; padding: 4px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg); color: var(--fg);" title="トラック番号" />
              <input type="text" class="meta-track-title-input" value="${escapeAttr(t.title || "")}" placeholder="曲名" style="flex: 1; min-width: 0; font-size: 11px; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg); color: var(--fg);" title="曲名" />
              <input type="text" class="meta-track-artist-input" value="${escapeAttr(t.artist || "")}" placeholder="アーティスト" style="width: 100px; font-size: 11px; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg); color: var(--fg);" title="アーティスト（空欄ならアルバムアーティスト）" />
            </div>
          `).join("")}
        </div>
      </div>
    `;

    // アートワークプレビュー描画
    const renderAlbArtPreview = () => {
      const box = body.querySelector("#meta-alb-art-box");
      const status = body.querySelector("#meta-alb-art-status");
      const removeBtn = body.querySelector("#btn-meta-alb-remove-art");
      if (!box) return;

      if (localPreviewUrl) {
        try { URL.revokeObjectURL(localPreviewUrl); } catch {}
        localPreviewUrl = null;
      }

      let displayUrl = null;
      if (pendingArtworkBlob instanceof Blob) {
        localPreviewUrl = URL.createObjectURL(pendingArtworkBlob);
        displayUrl = localPreviewUrl;
      } else if (pendingArtworkBlob === null) {
        displayUrl = null;
      } else {
        displayUrl = initialArtUrl;
      }

      if (displayUrl) {
        box.innerHTML = `<img src="${escapeAttr(displayUrl)}" style="width: 100%; height: 100%; object-fit: cover; display: block;" />`;
        if (removeBtn) removeBtn.style.display = "inline-flex";
      } else {
        box.innerHTML = `<div style="font-size: 26px;">💿</div>`;
        if (removeBtn) removeBtn.style.display = "none";
      }

      if (status) {
        if (pendingArtworkBlob instanceof Blob) {
          const sizeKb = Math.round(pendingArtworkBlob.size / 1024);
          status.innerHTML = `<span style="color: var(--success); font-weight: 600;">✓ 新しい画像を設定中 (${sizeKb} KB、全曲に反映)</span>`;
        } else if (pendingArtworkBlob === null) {
          status.innerHTML = `<span style="color: var(--err); font-weight: 600;">✕ 画像を削除（全曲から未設定になります）</span>`;
        } else {
          status.textContent = initialArtUrl ? "現在のアルバム画像" : "画像なし";
        }
      }
    };

    renderAlbArtPreview();

    // 画像ファイル選択ハンドラ
    const albFileInput = body.querySelector("#meta-alb-file-input");
    albFileInput?.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        toast("画像ファイルを選択してください", "err");
        return;
      }
      pendingArtworkBlob = file;
      renderAlbArtPreview();
      toast("アルバム画像を選択しました。「全曲に一括保存」で反映されます", "ok");
    });

    body.querySelector("#btn-meta-alb-remove-art")?.addEventListener("click", () => {
      pendingArtworkBlob = null;
      renderAlbArtPreview();
      toast("アルバム画像を削除に設定しました", "info");
    });

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
                <div style="color: var(--fg-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(res.artist)} • ${escapeHtml(res.year || "年不明")} (${res.trackCount ? res.trackCount + "曲" : ""}) [${escapeHtml(res.source)}]</div>
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

            btn.textContent = "曲目取得中…";
            btn.disabled = true;

            body.querySelector("#meta-alb-title").value = sel.title || "";
            body.querySelector("#meta-alb-artist").value = sel.artist || "";
            body.querySelector("#meta-alb-track-artist").value = sel.artist || "";
            if (sel.year) body.querySelector("#meta-alb-year").value = sel.year;
            if (sel.genre) body.querySelector("#meta-alb-genre").value = sel.genre;

            if (sel.artworkUrl) {
              const blob = await fetchArtworkBlob(sel.artworkUrl);
              if (blob) {
                pendingArtworkBlob = blob;
                renderAlbArtPreview();
              }
            }

            // オンラインの収録曲リスト（トラックリスト）を取得して各曲へ反映
            const onlineTracks = await fetchAlbumTracklist(sel);
            if (onlineTracks && onlineTracks.length > 0) {
              const rows = body.querySelectorAll(".meta-album-track-row");
              rows.forEach((row, rowIdx) => {
                const onlineSong = onlineTracks[rowIdx];
                if (onlineSong) {
                  const noInput = row.querySelector(".meta-track-no-input");
                  const titleInput = row.querySelector(".meta-track-title-input");
                  const artistInput = row.querySelector(".meta-track-artist-input");
                  if (noInput && onlineSong.trackNo) noInput.value = onlineSong.trackNo;
                  if (titleInput && onlineSong.title) titleInput.value = onlineSong.title;
                  if (artistInput && onlineSong.artist) artistInput.value = onlineSong.artist;
                }
              });
              toast(`「${sel.title}」の情報と ${Math.min(rows.length, onlineTracks.length)} 曲の曲名を反映しました`, "ok");
            } else {
              toast(`「${sel.title}」のアルバム情報を反映しました`, "ok");
            }

            btn.textContent = "一括反映";
            btn.disabled = false;
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
          label: "🗑 アルバムを削除",
          danger: true,
          onClick: async () => {
            const confirmed = window.confirm(`アルバム「${album.title || "(無題)"}」と属する全 ${album.tracks.length} 曲をすべて削除しますか？\n（曲データは完全に削除されます）`);
            if (!confirmed) return false;
            for (const t of album.tracks) {
              if (appState.get().currentTrack?.id === t.id) stopPlayback();
              await deleteTrack(t.id);
              await removeTrackFromAllPlaylists(t.id).catch(() => {});
              releaseArtwork(t.id);
            }
            toast(`アルバムと全 ${album.tracks.length} 曲を削除しました`, "ok");
            if (localPreviewUrl) try { URL.revokeObjectURL(localPreviewUrl); } catch {}
            if (typeof onUpdated === "function") onUpdated(null);
            resolve(null);
            return true;
          },
        },
        {
          label: "キャンセル",
          onClick: () => {
            if (localPreviewUrl) try { URL.revokeObjectURL(localPreviewUrl); } catch {}
            resolve(null);
          },
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

            const trackRows = body.querySelectorAll(".meta-album-track-row");
            const trackPatchMap = new Map();
            trackRows.forEach((row) => {
              const tid = row.dataset.trackId;
              const noVal = row.querySelector(".meta-track-no-input")?.value.trim();
              const titleVal = row.querySelector(".meta-track-title-input")?.value.trim();
              const artistVal = row.querySelector(".meta-track-artist-input")?.value.trim();
              trackPatchMap.set(tid, {
                trackNo: noVal,
                title: titleVal,
                artist: artistVal,
              });
            });

            const basePatch = {
              album: albumName,
              albumArtist,
              year,
              userEdited: true,
            };
            if (genre) basePatch.genre = genre;
            if (pendingArtworkBlob !== undefined) {
              basePatch.artworkBlob = pendingArtworkBlob;
            }

            for (const t of album.tracks) {
              const perTrack = trackPatchMap.get(t.id) || {};
              const individualPatch = { ...basePatch };
              if (perTrack.title) individualPatch.title = perTrack.title;
              if (perTrack.trackNo !== undefined && perTrack.trackNo !== "") individualPatch.trackNo = perTrack.trackNo;
              if (perTrack.artist) individualPatch.artist = perTrack.artist;
              else if (trackArtist) individualPatch.artist = trackArtist;

              await updateTrack(t.id, individualPatch);
              releaseArtwork(t.id);
              Object.assign(t, individualPatch);
            }

            album.title = albumName;
            album.albumArtist = albumArtist;
            album.year = year;
            if (genre) album.genre = genre;
            if (pendingArtworkBlob !== undefined) {
              if (pendingArtworkBlob) {
                album.artworkTrack = { ...album.tracks[0], artworkBlob: pendingArtworkBlob };
              } else {
                album.artworkTrack = null;
              }
            }

            // 再生中の曲が含まれていれば appState も同期
            const cur = appState.get().currentTrack;
            if (cur && album.tracks.some((t) => t.id === cur.id)) {
              releaseArtwork(cur.id);
              const curPatch = trackPatchMap.get(cur.id) || {};
              appState.set({ currentTrack: { ...cur, ...basePatch, ...curPatch } });
            }

            if (localPreviewUrl) try { URL.revokeObjectURL(localPreviewUrl); } catch {}
            toast(`${album.tracks.length} 曲のアルバム情報と曲名を更新しました`, "ok");
            if (typeof onUpdated === "function") onUpdated(album);
            resolve(album);
          },
        },
      ],
    });
  });
}
