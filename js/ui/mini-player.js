/**
 * ミニプレイヤー（再生画面以外でも常時表示）
 *
 * - 現在再生中の曲がある時のみ表示
 * - 再生/前後 操作を提供
 * - クリックで再生画面に遷移
 */

import { appState } from "../state.js";
import { togglePlay, playNext, playPrev, resolveTrackArtworkFromQueue } from "../player/audio-engine.js";
import { go } from "../router.js";
import { getArtworkUrl } from "./artwork-cache.js";
import { escapeHtml } from "./components.js";

const FALLBACK_ART_SRC = "./icons/icon-192.png";
let initialized = false;

export function initMiniPlayer() {
  if (initialized) return;
  initialized = true;

  const root = document.getElementById("mini-player");
  if (!root) return;
  const playBtn = document.getElementById("mini-play");
  const prevBtn = document.getElementById("mini-prev");
  const nextBtn = document.getElementById("mini-next");
  const titleEl = document.getElementById("mini-title");
  const artistEl = document.getElementById("mini-artist");
  const artEl = document.getElementById("mini-art");
  const progressFill = document.getElementById("mini-progress-fill");

  if (artEl) {
    artEl.addEventListener("error", () => {
      if (artEl.getAttribute("src") !== FALLBACK_ART_SRC) {
        artEl.src = FALLBACK_ART_SRC;
        artEl.style.visibility = "visible";
      } else {
        artEl.removeAttribute("src");
        artEl.style.visibility = "hidden";
      }
    });
    artEl.addEventListener("load", () => {
      artEl.style.visibility = "visible";
    });
  }

  // クリックで再生画面へ（操作ボタン以外）
  root.addEventListener("click", (e) => {
    const t = e.target;
    if (t === playBtn || t === prevBtn || t === nextBtn) return;
    if (t.closest && t.closest("button")) return;
    go("player");
  });

  playBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
  prevBtn.addEventListener("click", (e) => { e.stopPropagation(); playPrev(); });
  nextBtn.addEventListener("click", (e) => { e.stopPropagation(); playNext(); });

  // 現在のルートと再生状態を追跡 (再生画面では同じ情報が大きく見えるのでミニプレイヤー非表示にする)
  const updateVisibility = () => {
    const s = appState.get();
    const track = s.currentTrack;
    const isPlayerRoute = (location.hash || "").startsWith("#/player");
    // 曲なし → 隠す / 再生画面表示中 → 隠す
    if (!track || isPlayerRoute) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    if (track.memo) {
      titleEl.innerHTML = `${escapeHtml(track.title || "(無題)")} <span class="track-memo-badge" title="${escapeHtml(track.memo)}">${escapeHtml(track.memo)}</span>`;
    } else {
      titleEl.textContent = track.title || "(無題)";
    }

    const isPlaceholderArtist = !track.artist
      || track.artist === "(不明)"
      || track.artist === "(不明アーティスト)"
      || track.artist === "(Google Drive)";
    const displayArtist = (!isPlaceholderArtist ? track.artist : (track.albumArtist || track.artist || "(不明)"));
    const displayAlbum = (track.album && track.album !== "(不明アルバム)") ? track.album : "";
    const subText = [displayArtist, displayAlbum].filter(Boolean).join(" — ");

    const isLoading = !!(s.loadingTrackId && (!track || s.loadingTrackId === track.id));
    playBtn.classList.toggle("is-loading", isLoading);
    if (isLoading) {
      artistEl.innerHTML = `<span class="track-spinner"></span> ${escapeHtml(subText)}`;
    } else {
      artistEl.textContent = subText;
    }
    playBtn.classList.toggle("is-playing", !!s.isPlaying && !isLoading);
    playBtn.setAttribute("aria-label", isLoading ? "読み込み中" : s.isPlaying ? "一時停止" : "再生");

    const dur = s.duration || track.duration || 0;
    const cur = s.currentTime || 0;
    if (progressFill) {
      progressFill.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
    }

    // アートワーク（曲自身 ➔ キュー内の同一アルバム曲 ➔ デフォルトアイコンの順で解決）
    const artUrl = getArtworkUrl(track) || resolveTrackArtworkFromQueue(track) || FALLBACK_ART_SRC;
    if (artEl) {
      if (artEl.getAttribute("src") !== artUrl) {
        artEl.style.visibility = "visible";
        artEl.src = artUrl;
      }
    }
  };

  appState.subscribe(["currentTrack", "isPlaying", "currentTime", "duration", "loadingTrackId"], updateVisibility);
  window.addEventListener("music-player:track-updated", updateVisibility);
  window.addEventListener("music-player:library-synced", updateVisibility);
  // ルート変更および画面復帰時にも追従
  window.addEventListener("hashchange", updateVisibility);
  window.addEventListener("pageshow", updateVisibility);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      updateVisibility();
    }
  });
  // 初回起動時 (currentTrack が未セットでも player ルート判定が必要)
  updateVisibility();
}
