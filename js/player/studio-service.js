/**
 * 耳コピ・練習スタジオ サービス (Studio Service)
 *
 * 名作「聞々ハヤえもん」を超える耳コピ・練習支援機能:
 * 1. A-B 区間リピート (0.1秒単位の微調整付き)
 * 2. 段階的スピードアップ練習 (Speed Trainer: N回ループごとに +M% 自動加速)
 * 3. クイック巻き戻し (-1s / -3s / -5s)
 * 4. 曲内ブックマーク（マーカー）複数登録 & ワンタップジャンプ
 * 5. チャンネル・定位分離 (Stereo / L / R / LR-Swap / Mono, Mid-Side バランス)
 * 6. 周波数ソロ (ドラム/ハイハット/ベース/ギター/カスタムHPF+LPF)
 * 7. 速度 (0.25〜2.5x, ±1%, ±5%) & ピッチシフト (±12半音, ±50セント)
 * 8. 曲ごとのスタジオ設定保持（Per-Track Studio Memory 🔒）
 */

import { appState } from "../state.js";
import { toast } from "../ui/components.js";
import { getTrack, updateTrack } from "../store/library-db.js";
import { applyChannelMode, applyMidSideBalance, applyFrequencySolo, applyEffectsSetting } from "./eq.js";
import { setPlaybackRate } from "./audio-engine.js";

// スタジオ状態
const studioState = {
  // A-B ループ
  abLoop: {
    enabled: false,
    start: 0,
    end: 0,
  },
  // Speed Trainer
  speedTrainer: {
    enabled: false,
    loopInterval: 2, // 2周ごとに
    currentCycles: 0,
    stepPercent: 5,  // +5%
    maxRate: 1.0,    // 100%まで
  },
  // マーカー一覧
  markers: [], // Array<{ id: string, time: number, label: string }>
  // チャンネル分離
  channelMode: "stereo", // "stereo" | "left-only" | "right-only" | "lr-swap" | "mono"
  midSideBalance: 0, // -1.0 〜 +1.0
  // 周波数ソロ
  freqSolo: {
    enabled: false,
    preset: "off",
    lowFreq: 20,
    highFreq: 22050,
  },
  // ピッチシフト
  pitch: {
    semitones: 0, // -12 〜 +12
    cents: 0,     // -50 〜 +50
  },
  // 設定記憶フラグ (曲固有設定を永続化するか)
  memoryLocked: false,
};

// リスナー購読
const listeners = new Set();
function notify() {
  const snapshot = getStudioState();
  for (const fn of listeners) {
    try { fn(snapshot); } catch {}
  }
}

export function subscribeStudio(fn) {
  listeners.add(fn);
  fn(getStudioState());
  return () => listeners.delete(fn);
}

export function getStudioState() {
  return JSON.parse(JSON.stringify(studioState));
}

/**
 * A始点の設定（現在再生位置）
 */
export function setLoopPointA(timeSec) {
  studioState.abLoop.start = Math.max(0, Number(timeSec) || 0);
  if (studioState.abLoop.end <= studioState.abLoop.start) {
    studioState.abLoop.end = studioState.abLoop.start + 5; // デフォルト5秒
  }
  studioState.abLoop.enabled = true;
  studioState.speedTrainer.currentCycles = 0;
  notify();
  autoSaveIfLocked();
  toast(`A点設定: ${formatTimeAccurate(studioState.abLoop.start)}`, "info");
}

/**
 * B終点の設定（現在再生位置）
 */
export function setLoopPointB(timeSec) {
  const b = Math.max(0, Number(timeSec) || 0);
  if (b <= studioState.abLoop.start) {
    toast("B点はA点より後ろに設定してください", "warn");
    return;
  }
  studioState.abLoop.end = b;
  studioState.abLoop.enabled = true;
  studioState.speedTrainer.currentCycles = 0;
  notify();
  autoSaveIfLocked();
  toast(`B点設定: ${formatTimeAccurate(studioState.abLoop.end)} (区間: ${(studioState.abLoop.end - studioState.abLoop.start).toFixed(1)}秒)`, "info");
}

/**
 * A-B ループ解除
 */
export function clearLoop() {
  studioState.abLoop.enabled = false;
  studioState.speedTrainer.currentCycles = 0;
  notify();
  autoSaveIfLocked();
  toast("A-Bループ解除", "info");
}

/**
 * A-B始点の微調整 (±0.1秒単位)
 */
export function adjustLoopStart(deltaSec) {
  studioState.abLoop.start = Math.max(0, studioState.abLoop.start + deltaSec);
  if (studioState.abLoop.start >= studioState.abLoop.end) {
    studioState.abLoop.start = Math.max(0, studioState.abLoop.end - 0.2);
  }
  notify();
  autoSaveIfLocked();
}

/**
 * A-B終点の微調整 (±0.1秒単位)
 */
export function adjustLoopEnd(deltaSec, maxDuration = 99999) {
  studioState.abLoop.end = Math.min(maxDuration, Math.max(studioState.abLoop.start + 0.2, studioState.abLoop.end + deltaSec));
  notify();
  autoSaveIfLocked();
}

/**
 * クイック巻き戻し (秒単位)
 */
export function seekRelative(deltaSec, audioEl) {
  if (!audioEl) return;
  const cur = audioEl.currentTime || 0;
  audioEl.currentTime = Math.max(0, cur + deltaSec);
  toast(`${deltaSec > 0 ? "+" : ""}${deltaSec}秒`, "info");
}

/**
 * 再生ループチェック (audio-engine の timeupdate から毎フレーム呼ばれる)
 */
export function checkStudioLoop(currentTime, audioEl) {
  if (!studioState.abLoop.enabled || !audioEl) return;
  const { start, end } = studioState.abLoop;
  if (end > start && currentTime >= end) {
    audioEl.currentTime = start;
    onLoopCycled(audioEl);
  }
}

/**
 * ループが1周完了した時の処理 (Speed Trainer 進行)
 */
function onLoopCycled(audioEl) {
  if (!studioState.speedTrainer.enabled) return;
  studioState.speedTrainer.currentCycles++;
  const { loopInterval, currentCycles, stepPercent, maxRate } = studioState.speedTrainer;

  if (currentCycles >= loopInterval) {
    studioState.speedTrainer.currentCycles = 0;
    const currentRate = audioEl.playbackRate || 1.0;
    const step = stepPercent / 100;
    const nextRate = Math.min(maxRate, Number((currentRate + step).toFixed(2)));

    if (nextRate > currentRate) {
      setPlaybackRate(nextRate, true);
      toast(`⚡ Speed Trainer: 再生速度アップ ${Math.round(currentRate * 100)}% → ${Math.round(nextRate * 100)}%`, "ok");
      notify();
    }
  }
}

/**
 * Speed Trainer の設定更新
 */
export function updateSpeedTrainer(config = {}) {
  Object.assign(studioState.speedTrainer, config);
  notify();
  autoSaveIfLocked();
}

/**
 * マーカーの追加
 */
export function addBookmarkMarker(timeSec, label = "") {
  const t = Math.max(0, Number(timeSec) || 0);
  const count = studioState.markers.length + 1;
  const marker = {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    time: t,
    label: label.trim() || `マーカー ${count} (${formatTimeAccurate(t)})`,
  };
  studioState.markers.push(marker);
  studioState.markers.sort((a, b) => a.time - b.time);
  notify();
  autoSaveIfLocked();
  toast(`マーカー登録: ${marker.label}`, "ok");
  return marker;
}

/**
 * マーカーの削除
 */
export function removeBookmarkMarker(markerId) {
  studioState.markers = studioState.markers.filter((m) => m.id !== markerId);
  notify();
  autoSaveIfLocked();
}

/**
 * マーカーへジャンプ
 */
export function jumpToMarker(timeSec, audioEl) {
  if (!audioEl) return;
  audioEl.currentTime = Math.max(0, Number(timeSec) || 0);
  toast(`ジャンプ: ${formatTimeAccurate(timeSec)}`, "info");
}

/**
 * チャンネル分離モードの設定
 */
export function setChannelMode(mode, audioEl) {
  studioState.channelMode = mode;
  // エフェクトをオンにして反映
  if (audioEl && mode !== "stereo") {
    applyEffectsSetting(audioEl, true);
  }
  applyChannelMode(mode);
  notify();
  autoSaveIfLocked();
}

/**
 * Mid / Side バランスの設定 (-1.0 〜 +1.0)
 */
export function setMidSideBalance(balance, audioEl) {
  studioState.midSideBalance = Number(balance) || 0;
  if (audioEl && studioState.midSideBalance !== 0) {
    applyEffectsSetting(audioEl, true);
  }
  applyMidSideBalance(studioState.midSideBalance);
  notify();
  autoSaveIfLocked();
}

/**
 * 周波数ソロの設定
 */
export function setFrequencySolo({ enabled, preset, lowFreq, highFreq }, audioEl) {
  if (enabled !== undefined) studioState.freqSolo.enabled = !!enabled;
  if (preset !== undefined) studioState.freqSolo.preset = preset;
  if (lowFreq !== undefined) studioState.freqSolo.lowFreq = lowFreq;
  if (highFreq !== undefined) studioState.freqSolo.highFreq = highFreq;

  if (audioEl && studioState.freqSolo.enabled && studioState.freqSolo.preset !== "off") {
    applyEffectsSetting(audioEl, true);
  }
  applyFrequencySolo(studioState.freqSolo);
  notify();
  autoSaveIfLocked();
}

/**
 * ピッチ変更（移調 / キー変更）
 * @param {number} semitones -12 〜 +12
 * @param {number} cents -50 〜 +50
 * @param {HTMLAudioElement} audioEl
 */
export function setPitchShift(semitones = 0, cents = 0, audioEl) {
  studioState.pitch.semitones = Math.max(-12, Math.min(12, Math.round(semitones)));
  studioState.pitch.cents = Math.max(-50, Math.min(50, Math.round(cents)));

  // ピッチシフター（または preservesPitch オフと playbackRate 連動）
  if (audioEl) {
    const totalSemitones = studioState.pitch.semitones + (studioState.pitch.cents / 100);
    if (Math.abs(totalSemitones) > 0.01) {
      applyEffectsSetting(audioEl, true);
    }
  }
  notify();
  autoSaveIfLocked();
}

/**
 * 曲ごとのスタジオ設定を記憶 / 解除
 */
export function toggleMemoryLock(trackId, audioEl) {
  studioState.memoryLocked = !studioState.memoryLocked;
  if (studioState.memoryLocked && trackId) {
    saveStudioSettingsForTrack(trackId, audioEl);
    toast("🔒 この曲の練習設定を記憶しました", "ok");
  } else if (!studioState.memoryLocked && trackId) {
    clearStudioSettingsForTrack(trackId);
    toast("🔓 設定の記憶を解除しました", "info");
  }
  notify();
}

/**
 * 現在の設定を曲データに保存
 */
export async function saveStudioSettingsForTrack(trackId, audioEl) {
  if (!trackId) return;
  const currentRate = audioEl ? audioEl.playbackRate : 1.0;
  const payload = {
    playbackRate: currentRate,
    abLoop: studioState.abLoop,
    speedTrainer: studioState.speedTrainer,
    markers: studioState.markers,
    channelMode: studioState.channelMode,
    midSideBalance: studioState.midSideBalance,
    freqSolo: studioState.freqSolo,
    pitch: studioState.pitch,
    savedAt: Date.now(),
  };

  try {
    await updateTrack(trackId, { studioSettings: payload });
  } catch (e) {
    console.warn("[studio-service] 設定保存失敗", e);
  }
}

/**
 * 曲のスタジオ設定を読み込んで反映
 */
export async function loadStudioSettingsForTrack(trackId, audioEl) {
  if (!trackId) return false;
  try {
    const track = await getTrack(trackId);
    if (track && track.studioSettings) {
      const s = track.studioSettings;
      studioState.memoryLocked = true;
      if (s.abLoop) Object.assign(studioState.abLoop, s.abLoop);
      if (s.speedTrainer) Object.assign(studioState.speedTrainer, s.speedTrainer);
      if (Array.isArray(s.markers)) studioState.markers = s.markers;
      if (s.channelMode) studioState.channelMode = s.channelMode;
      if (s.midSideBalance !== undefined) studioState.midSideBalance = s.midSideBalance;
      if (s.freqSolo) Object.assign(studioState.freqSolo, s.freqSolo);
      if (s.pitch) Object.assign(studioState.pitch, s.pitch);

      if (audioEl) {
        if (s.playbackRate) setPlaybackRate(s.playbackRate, true);
        if (s.channelMode && s.channelMode !== "stereo") setChannelMode(s.channelMode, audioEl);
        if (s.midSideBalance) setMidSideBalance(s.midSideBalance, audioEl);
        if (s.freqSolo && s.freqSolo.enabled) setFrequencySolo(s.freqSolo, audioEl);
      }
      notify();
      return true;
    }
  } catch (e) {
    console.warn("[studio-service] 設定読込失敗", e);
  }
  // 曲固有設定がない場合は、曲固有のA-Bループとマーカーを解除し、エフェクトを標準状態へ戻す
  studioState.memoryLocked = false;
  studioState.abLoop.enabled = false;
  studioState.abLoop.start = 0;
  studioState.abLoop.end = 0;
  studioState.markers = [];
  studioState.speedTrainer.currentCycles = 0;
  if (studioState.channelMode !== "stereo") {
    setChannelMode("stereo", audioEl);
  }
  if (studioState.midSideBalance !== 0) {
    setMidSideBalance(0, audioEl);
  }
  if (studioState.freqSolo.enabled) {
    setFrequencySolo({ enabled: false, preset: "off" }, audioEl);
  }
  notify();
  return false;
}

/**
 * 曲の保存済み設定を削除
 */
export async function clearStudioSettingsForTrack(trackId) {
  if (!trackId) return;
  try {
    await updateTrack(trackId, { studioSettings: null });
  } catch {}
}

function autoSaveIfLocked() {
  if (!studioState.memoryLocked) return;
  const curTrack = appState.get().currentTrack;
  if (curTrack && curTrack.id) {
    saveStudioSettingsForTrack(curTrack.id);
  }
}

function formatTimeAccurate(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1);
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}
