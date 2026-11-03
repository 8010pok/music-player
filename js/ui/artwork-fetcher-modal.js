/**
 * ジャケット画像（アートワーク）単独取得・更新モーダル
 *
 * - 曲名・アーティスト名・アルバム名から iTunes / MusicBrainz の高解像度ジャケット画像を検索
 * - 候補画像プレビューからユーザーが明示的に選択して適用
 * - 音源本体やタイトル・アーティスト・アルバム・メモなど他のメタデータは一切変更せず、画像のみを安全に更新
 * - アルバム単位または複数曲への一括適用に対応
 */

import { openModal, closeActiveModalSync, toast, escapeHtml, escapeAttr } from "./components.js";
import { searchAlbumMetadata, searchTrackMetadata, fetchArtworkBlob } from "../metadata/musicbrainz.js";
import { validateAndDecodeArtworkBlob } from "../metadata/util.js";
import { bulkUpdateTracks } from "../store/library-db.js";
import { releaseArtwork, recordArtworkDiagnostics } from "./artwork-cache.js";
import { recordLibraryModified } from "../store/sync-service.js";
import { appState } from "../state.js";

/**
 * ジャケット画像単独取得・変更モーダルを開く（端末内の画像選択 + オンライン検索の両対応）
 * @param {object} options
 * @param {Array<object>} options.tracks 対象のトラック配列（単一曲でも配列）
 * @param {string} [options.albumName] アルバム名（アルバム単位の場合）
 * @param {string} [options.artistName] アーティスト名
 * @param {"track"|"album"|"artist"|"multi"} [options.targetType] 対象種別
 * @param {() => void} [options.onUpdated] 更新完了後のコールバック
 */
export async function openArtworkFetcherModal({ tracks = [], albumName = "", artistName = "", targetType = "", onUpdated } = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    toast("対象の曲がありません", "err");
    return;
  }

  const primaryTrack = tracks[0];
  const resolvedTargetType = targetType || (albumName ? "album" : artistName && tracks.length > 1 ? "artist" : tracks.length > 1 ? "multi" : "track");
  const targetId = albumName || (artistName && tracks.length > 1 ? artistName : primaryTrack.id);
  const defaultArtist = artistName || primaryTrack.artist || primaryTrack.albumArtist || "";
  const defaultAlbum = albumName || primaryTrack.album || primaryTrack.title || "";
  const initialQuery = `${defaultArtist ? defaultArtist + " " : ""}${defaultAlbum}`.trim();

  const container = document.createElement("div");
  container.className = "artwork-fetcher-container";
  container.style.cssText = "display:flex; flex-direction:column; gap:12px; max-height:75vh; overflow-y:auto;";

  container.innerHTML = `
    <div style="font-size:0.88rem; color:var(--text-muted, #9ca3af); line-height:1.5;">
      💡 タイトル・アーティスト・メモ等のメタデータは変更せず、<strong>ジャケット画像（アートワーク）のみ</strong>を取得・差し替えます。
      対象: <strong>${tracks.length}曲</strong> (${escapeHtml(primaryTrack.title || "曲")}${tracks.length > 1 ? ` ほか${tracks.length - 1}曲` : ""})
    </div>

    <div style="display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px; background:rgba(255,255,255,0.04); border:1px solid var(--border-color, rgba(255,255,255,0.12));">
      <img id="art-local-preview" src="./icons/icon-192.png" alt="" style="width:52px; height:52px; border-radius:6px; object-fit:cover; display:none; flex-shrink:0;" />
      <div style="flex:1; min-width:0;">
        <div style="font-size:0.84rem; font-weight:600;">📁 端末から画像を選択 (JPEG / PNG / WebP)</div>
        <div id="art-local-filename" style="font-size:0.76rem; color:var(--text-muted, #9ca3af); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">写真ライブラリやファイルから直接選択できます</div>
      </div>
      <button type="button" class="btn" id="btn-art-local-file" style="white-space:nowrap; font-size:0.82rem; padding:6px 10px;">📁 画像を選択</button>
      <input type="file" id="art-local-file-input" accept="image/jpeg,image/png,image/webp,image/*" style="display:none;" />
    </div>

    <div style="display:flex; gap:8px;">
      <input type="text" class="input" id="art-search-query" value="${escapeAttr(initialQuery)}" placeholder="アーティスト名 アルバム名で検索" style="flex:1;" />
      <button type="button" class="btn primary" id="art-search-btn">🔍 検索</button>
    </div>

    <div id="art-search-status" style="font-size:0.84rem; color:var(--text-muted, #9ca3af); min-height:1.2em;"></div>

    <div id="art-results-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); gap:12px; min-height:120px;">
      <div style="grid-column:1/-1; text-align:center; padding:24px 0; color:var(--text-muted, #9ca3af); font-size:0.88rem;">
        「検索」ボタンを押すか、「📁 画像を選択」から画像を選んでください
      </div>
    </div>

    ${tracks.length > 1 ? `
      <label style="display:flex; align-items:center; gap:8px; font-size:0.88rem; cursor:pointer; user-select:none; margin-top:6px;">
        <input type="checkbox" id="art-apply-all-chk" checked />
        <span>選択中の全 ${tracks.length} 曲に同じアートワークを適用する</span>
      </label>
    ` : ""}
  `;

  let selectedResult = null;
  let selectedLocalBlob = null;
  let selectedLocalDecoded = null;
  let isApplying = false;

  const modal = openModal({
    title: "🖼️ ジャケット画像のみ取得・変更",
    body: container,
    actions: [
      {
        label: "キャンセル",
        onClick: () => {},
      },
      {
        label: "この画像を適用",
        primary: true,
        id: "btn-art-apply",
        disabled: true,
        onClick: async () => {
          if (!selectedLocalDecoded && (!selectedResult || !selectedResult.artworkUrl)) return false;
          if (isApplying) return false;

          const applyAll = tracks.length > 1 ? (container.querySelector("#art-apply-all-chk")?.checked !== false) : false;
          const targetTracks = applyAll ? tracks : [primaryTrack];

          isApplying = true;
          const applyBtn = modal.el ? modal.el.querySelector("#btn-art-apply") : document.getElementById("btn-art-apply");
          if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.textContent = selectedLocalDecoded ? "⏳ 画像を保存中…" : "⏳ 画像ダウンロード中…";
          }

          recordArtworkDiagnostics({
            targetType: resolvedTargetType,
            targetId,
            fileType: selectedLocalDecoded ? selectedLocalDecoded.fileType : "remote/url",
            fileSize: selectedLocalDecoded ? selectedLocalDecoded.fileSize : 0,
            decoded: !!selectedLocalDecoded,
            resized: !!selectedLocalDecoded,
            saved: false,
            recordUpdated: false,
            syncQueued: false,
            rendered: false,
            errorName: null,
          });

          try {
            let dataUrl = null;
            if (selectedLocalDecoded && selectedLocalDecoded.dataUrl) {
              dataUrl = selectedLocalDecoded.dataUrl;
            } else if (selectedLocalBlob) {
              const decoded = await validateAndDecodeArtworkBlob(selectedLocalBlob, { maxSize: 600 });
              dataUrl = decoded.dataUrl;
              recordArtworkDiagnostics({
                fileType: decoded.fileType,
                fileSize: decoded.fileSize,
                decoded: true,
                resized: true,
              });
            } else {
              toast("高解像度画像をダウンロードしています…", "info", 2000);
              const blob = await fetchArtworkBlob(selectedResult.artworkUrl);
              if (!blob) {
                const dlErr = new Error("画像のダウンロードに失敗しました。別の候補をお試しください。");
                dlErr.name = "ArtworkDownloadError";
                throw dlErr;
              }
              const decoded = await validateAndDecodeArtworkBlob(blob, { maxSize: 600 });
              dataUrl = decoded.dataUrl;
              recordArtworkDiagnostics({
                fileType: decoded.fileType,
                fileSize: decoded.fileSize,
                decoded: true,
                resized: true,
              });
            }

            const now = Date.now();
            const patch = {
              artworkBlob: null,
              artworkDataUrl: dataUrl,
              hasArtwork: true,
              _noEmbeddedArt: false,
              userEdited: true,
              artworkUpdatedAt: now,
              updatedAt: now,
            };

            const batch = targetTracks.map((t) => ({ id: t.id, patch }));
            await bulkUpdateTracks(batch);
            recordArtworkDiagnostics({ saved: true, recordUpdated: true });

            for (const t of targetTracks) {
              Object.assign(t, patch);
              releaseArtwork(t.id);
            }
            const cur = appState.get().currentTrack;
            if (cur && targetTracks.some((t) => t.id === cur.id)) {
              releaseArtwork(cur.id);
              appState.set({ currentTrack: { ...cur, ...patch } });
            }
            recordLibraryModified();
            recordArtworkDiagnostics({ syncQueued: true });

            if (typeof onUpdated === "function") {
              await onUpdated();
            }
            recordArtworkDiagnostics({ rendered: true, errorName: null });

            toast(`${targetTracks.length} 曲のジャケット画像を更新しました`, "ok");
            closeActiveModalSync();
            return true;
          } catch (err) {
            console.warn("[artwork-fetcher] 適用エラー:", err);
            recordArtworkDiagnostics({
              errorName: err?.name || "ArtworkApplyError",
            });
            toast(err?.message || "画像の適用に失敗しました", "err");
            if (applyBtn) {
              applyBtn.disabled = false;
              applyBtn.textContent = "この画像を適用";
            }
            return false;
          } finally {
            isApplying = false;
          }
        },
      },
    ],
  });

  const searchInput = container.querySelector("#art-search-query");
  const searchBtn = container.querySelector("#art-search-btn");
  const statusEl = container.querySelector("#art-search-status");
  const gridEl = container.querySelector("#art-results-grid");
  const localFileBtn = container.querySelector("#btn-art-local-file");
  const localFileInput = container.querySelector("#art-local-file-input");
  const localPreview = container.querySelector("#art-local-preview");
  const localFilename = container.querySelector("#art-local-filename");
  const applyBtn = modal.el ? modal.el.querySelector("#btn-art-apply") : document.getElementById("btn-art-apply");

  if (localFileBtn && localFileInput) {
    localFileBtn.addEventListener("click", () => localFileInput.click());
    localFileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      // 同じファイルを連続で再選択しても change が発火するよう即座にリセット
      e.target.value = "";
      if (!file) return;

      recordArtworkDiagnostics({
        targetType: resolvedTargetType,
        targetId,
        fileType: file.type || "unknown",
        fileSize: file.size || 0,
        decoded: false,
        resized: false,
        saved: false,
        recordUpdated: false,
        syncQueued: false,
        rendered: false,
        errorName: null,
      });

      try {
        const decoded = await validateAndDecodeArtworkBlob(file, { maxSize: 600 });
        selectedLocalBlob = file;
        selectedLocalDecoded = decoded;
        selectedResult = null;

        recordArtworkDiagnostics({
          fileType: decoded.fileType,
          fileSize: decoded.fileSize,
          decoded: true,
          resized: true,
        });

        if (localPreview) {
          localPreview.src = decoded.dataUrl;
          localPreview.style.display = "block";
        }
        if (localFilename) {
          localFilename.textContent = `選択済み (${Math.round(file.size / 1024)} KB) — 「この画像を適用」を押して確定`;
          localFilename.style.color = "var(--accent, #60a5fa)";
        }
        if (gridEl) {
          gridEl.querySelectorAll(".art-candidate-card").forEach((c) => {
            c.style.borderColor = "transparent";
            c.style.background = "rgba(255,255,255,0.04)";
          });
        }
        if (applyBtn) {
          applyBtn.disabled = false;
        }
      } catch (err) {
        selectedLocalBlob = null;
        selectedLocalDecoded = null;
        recordArtworkDiagnostics({
          errorName: err?.name || "ImageDecodeError",
        });
        toast(err?.message || "画像を読み込めませんでした", "err");
      }
    });
  }

  const runSearch = async () => {
    const q = (searchInput && searchInput.value.trim()) || "";
    if (!q) {
      if (statusEl) statusEl.textContent = "検索キーワードを入力してください";
      return;
    }

    selectedResult = null;
    if (applyBtn) applyBtn.disabled = true;
    if (statusEl) statusEl.textContent = "🔍 高解像度ジャケット画像を検索中…";
    if (gridEl) {
      gridEl.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:30px 0;"><span class="track-spinner"></span> 検索中…</div>`;
    }

    try {
      // アルバム検索と曲検索を並行実行し、アートワークURLを持つ候補をマージ
      const [albumRes, trackRes] = await Promise.all([
        searchAlbumMetadata(q).catch(() => []),
        searchTrackMetadata(q).catch(() => []),
      ]);

      const seenUrls = new Set();
      const candidates = [];

      for (const item of [...albumRes, ...trackRes]) {
        if (!item || !item.artworkUrl) continue;
        if (seenUrls.has(item.artworkUrl)) continue;
        seenUrls.add(item.artworkUrl);
        candidates.push(item);
      }

      if (candidates.length === 0) {
        if (statusEl) statusEl.textContent = "ジャケット画像が見つかりませんでした。キーワードを変更してお試しください。";
        if (gridEl) {
          gridEl.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:24px 0; color:var(--text-muted, #9ca3af);">画像が見つかりませんでした</div>`;
        }
        return;
      }

      if (statusEl) statusEl.textContent = `${candidates.length} 件の候補画像が見つかりました。適用したい画像を選択してください:`;
      if (gridEl) {
        gridEl.innerHTML = candidates.map((item, idx) => {
          const title = item.title || item.album || "";
          const artist = item.artist || item.albumArtist || "";
          const source = item.source || "iTunes";
          return `
            <div class="art-candidate-card" data-idx="${idx}" role="button" tabindex="0" style="display:flex; flex-direction:column; gap:4px; padding:6px; border-radius:8px; border:2px solid transparent; background:rgba(255,255,255,0.04); cursor:pointer; text-align:left; transition:all 0.15s ease;">
              <div style="aspect-ratio:1; border-radius:6px; overflow:hidden; background:#111;">
                <img src="${escapeAttr(item.artworkUrl)}" alt="" loading="lazy" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='./icons/icon-192.png'" />
              </div>
              <div style="font-size:0.78rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
              <div style="font-size:0.72rem; color:var(--text-muted, #9ca3af); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(artist)}</div>
              <div style="font-size:0.68rem; color:var(--accent, #60a5fa);">${escapeHtml(source)} (高解像度)</div>
            </div>
          `;
        }).join("");

        gridEl.querySelectorAll(".art-candidate-card").forEach((card) => {
          card.addEventListener("click", () => {
            const idx = parseInt(card.dataset.idx, 10);
            selectedResult = candidates[idx] || null;
            selectedLocalBlob = null;
            selectedLocalDecoded = null;
            if (localPreview) localPreview.style.display = "none";
            if (localFilename) {
              localFilename.textContent = "写真ライブラリやファイルから直接選択できます";
              localFilename.style.color = "var(--text-muted, #9ca3af)";
            }

            gridEl.querySelectorAll(".art-candidate-card").forEach((c) => {
              c.style.borderColor = "transparent";
              c.style.background = "rgba(255,255,255,0.04)";
            });
            card.style.borderColor = "var(--accent, #3b82f6)";
            card.style.background = "rgba(59,130,246,0.12)";

            if (applyBtn) {
              applyBtn.disabled = !selectedResult;
            }
          });
        });
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = `検索エラー: ${e.message}`;
    }
  };

  if (searchBtn) {
    searchBtn.addEventListener("click", runSearch);
  }
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch();
      }
    });
  }

  // 初回自動検索
  runSearch();
}
