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

  // 現在のルートを追跡 (再生画面では同じ情報が大きく見えるのでミニプレイヤー非表示にする)
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
    playBtn.textContent = s.isPlaying ? "⏸" : "▶";

    // アートワーク（ID キャッシュ経由で URL の再生成を避ける）
    const artUrl = getArtworkUrl(track) || track.artworkUrl || null;
    if (artUrl) {
      if (artEl.getAttribute("src") !== artUrl) artEl.src = artUrl;
    } else {
      artEl.removeAttribute("src");
    }
  };

  appState.subscribe(["currentTrack", "isPlaying"], updateVisibility);
  // ルート変更にも追従
  window.addEventListener("hashchange", updateVisibility);
  // 初回起動時 (currentTrack が未セットでも player ルート判定が必要)
  updateVisibility();
}
