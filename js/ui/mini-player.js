/**
 * ミニプレイヤー（再生画面以外でも常時表示）
 *
 * - 現在再生中の曲がある時のみ表示
 * - 再生/前後 操作を提供
 * - クリックで再生画面に遷移
 */

import { appState } from "../state.js";
import { togglePlay, playNext, playPrev } from "../player/audio-engine.js";
import { go } from "../router.js";
import { getArtworkUrl } from "./artwork-cache.js";

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
    titleEl.textContent = track.title || "(無題)";
    artistEl.textContent = track.artist || "(不明)";
    playBtn.classList.toggle("is-playing", !!s.isPlaying);
    playBtn.setAttribute("aria-label", s.isPlaying ? "一時停止" : "再生");

    const dur = s.duration || 0;
    const cur = s.currentTime || 0;
    if (progressFill) {
      progressFill.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
    }

    // アートワーク（ID キャッシュ経由で URL の再生成を避ける）
    const artUrl = getArtworkUrl(track) || track.artworkUrl || null;
    if (artUrl) {
      if (artEl.getAttribute("src") !== artUrl) artEl.src = artUrl;
    } else {
      artEl.removeAttribute("src");
    }
  };

  appState.subscribe(["currentTrack", "isPlaying", "currentTime", "duration"], updateVisibility);
  // ルート変更にも追従
  window.addEventListener("hashchange", updateVisibility);
  // 初回起動時 (currentTrack が未セットでも player ルート判定が必要)
  updateVisibility();
}
