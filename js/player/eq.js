/**
 * 音声エフェクトチェーン
 *
 * 構成 (enableAudioEffects = true 時にのみ初期化):
 *   source (MediaElementAudioSource)
 *    → preampGain               プリアンプ (Gain, -12〜+6 dB)
 *    → highPass                 ノイズ除去用 HPF (frequency で強度切替)
 *    → eq31 → ... → eq16k       10 バンドピーキング EQ (各 ±12 dB)
 *    → bassBoost                低音ブースト専用 lowshelf (+0〜+12 dB)
 *    → [MS encode/decode]       ステレオ幅・ヴォーカル除去・モノ化 を一括
 *    → panner (StereoPanner)    左右バランス (-1〜+1)
 *    → compressor               コンプレッサー (バイパス時は threshold=0, ratio=1)
 *    → lowPass                  ノイズ除去用 LPF (frequency で強度切替)
 *    → destination
 *
 * === 重要な制約 ===
 * createMediaElementSource を一度呼ぶと、その <audio> 要素の音声経路は
 * 永続的に AudioContext を通る。これは iOS ロック画面 / バックグラウンド
 * 再生を壊す既知の挙動。なので：
 *   - applyEffectsSetting(audioEl, true)  : 初回呼出で chain を作成、以降は no-op
 *   - applyEffectsSetting(audioEl, false) : chain は一度作ったら戻せない（要再読込）
 *     → 各パラメータを「中立値」にすることで実質的にバイパスする
 *
 * 新規 createMediaElementSource は追加で呼ばないため、有効化後の制約は
 * 既存EQと完全に同じ (新たに iPhone ロック画面挙動を悪化させない)。
 */

let ctx = null;
let source = null;

// 各 Node の参照
let preampGain = null;
let highPass = null;
let lowPass = null;
const eqFilters = {}; // { '31': BiquadFilterNode, ... }
let bassBoost = null;
let panner = null;
let compressor = null;

// MS encode/decode ステージ用ノード
let msInput = null;                              // splitter 前段: 入力を必ず 2ch にそろえる
let msSplitter = null;
let msMidGainL = null, msMidGainR = null;      // mid = (L+R)/2
let msSideGainL = null, msSideGainR_neg = null; // side = (L-R)/2
let msMidSum = null, msSideSum = null;          // 1ch mid / 1ch side
let msMidScaleNode = null;                       // mid * midScale (ヴォーカル除去用)
let msSideScaleNode = null;                      // side * sideScale (ステレオ幅・モノラル用)
let msOutMidToL = null, msOutMidToR = null;     // mid → L, R に分配
let msOutSideToL = null, msOutSideToR_neg = null; // side → L+, R-
let msMerger = null;                             // 2ch にマージ

// 10 バンド EQ の中心周波数 (ISO オクターブ標準)
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * 各 EQ バンドのラベル
 */
export function bandLabel(freq) {
  if (freq >= 1000) return (freq / 1000) + " kHz";
  return freq + " Hz";
}

/**
 * EQ chain を audioEl に接続する（または既に接続済みなら無効化に切替）。
 * @param {HTMLAudioElement} audioEl
 * @param {boolean} enabled
 */
export function applyEffectsSetting(audioEl, enabled) {
  if (!enabled) {
    // 既に作成済みの場合は全パラメータを中立にしてバイパス相当に
    bypassAll();
    return;
  }
  if (ctx) return; // 既に初期化済み
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    source = ctx.createMediaElementSource(audioEl);

    // --- プリアンプ ---
    preampGain = ctx.createGain();
    preampGain.gain.value = 1.0; // 0 dB

    // --- ノイズ除去 HPF (中立: frequency=0) ---
    highPass = ctx.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = 0; // バイパス
    highPass.Q.value = 0.7;

    // --- 10 バンドピーキング EQ ---
    for (const f of EQ_BANDS) {
      const bq = ctx.createBiquadFilter();
      bq.type = "peaking";
      bq.frequency.value = f;
      bq.Q.value = 1.4;
      bq.gain.value = 0;
      eqFilters[String(f)] = bq;
    }

    // --- 低音ブースト (専用 lowshelf) ---
    bassBoost = ctx.createBiquadFilter();
    bassBoost.type = "lowshelf";
    bassBoost.frequency.value = 100;
    bassBoost.gain.value = 0;

    // --- MS encode/decode ステージ ---
    setupMidSideStage();

    // --- パンナー ---
    panner = ctx.createStereoPanner();
    panner.pan.value = 0;

    // --- コンプレッサー (バイパス時は ratio=1 等で実質透過) ---
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = 0;
    compressor.knee.value = 0;
    compressor.ratio.value = 1;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    // --- ノイズ除去 LPF (中立: frequency=22050) ---
    lowPass = ctx.createBiquadFilter();
    lowPass.type = "lowpass";
    lowPass.frequency.value = 22050;
    lowPass.Q.value = 0.7;

    // --- chain 接続 ---
    let node = source.connect(preampGain).connect(highPass);
    for (const f of EQ_BANDS) {
      node = node.connect(eqFilters[String(f)]);
    }
    node = node
      .connect(bassBoost)
      .connect(msInput); // ここから MS stage 入口 (msInput → msSplitter で 2ch 化)

    // MS stage 出口は msMerger
    msMerger.connect(panner).connect(compressor).connect(lowPass).connect(ctx.destination);
  } catch (e) {
    console.warn("音声エフェクト初期化失敗", e);
    // source 生成済み(createMediaElementSource 後)に chain 構築が中断すると、
    // audioEl の音が AudioContext に取り込まれたまま destination に繋がらず無音化する。
    // 最低限 source→destination を直結して音だけは出す(エフェクトは無効)。
    // ctx は null にしない: source 生成済みで再度 createMediaElementSource すると
    // 同一要素への二重生成で InvalidStateError → 最悪その曲が無音化するため、
    // 初期化済み扱い(74行 if(ctx) return)を維持して再構築を防ぐ。
    try {
      if (source && ctx) source.connect(ctx.destination);
    } catch {}
  }
}

/**
 * Mid/Side エンコード/デコード ステージを構築
 *
 *   入力 (Stereo L,R)
 *     → ChannelSplitter (2ch)
 *         L → midGainL(*0.5) → midSum
 *           → sideGainL(*0.5) → sideSum
 *         R → midGainR(*0.5) → midSum
 *           → sideGainR_neg(*-0.5) → sideSum
 *     → midSum (1ch)、sideSum (1ch)
 *     → midScaleNode (gain=midScale, ヴォーカル除去で 0)
 *     → sideScaleNode (gain=sideScale, ステレオ幅で可変)
 *     → 再 decode:
 *         midScaleOut → outMidToL → merger.input[0]
 *                    → outMidToR → merger.input[1]
 *         sideScaleOut → outSideToL → merger.input[0]
 *                     → outSideToR_neg(-1) → merger.input[1]
 *     → ChannelMerger (2ch) → 出力
 */
function setupMidSideStage() {
  // ★ 入力を必ず 2ch にそろえる前段ゲイン。
  //   MediaElementSource はモノラル音源だと 1ch を出力する。ChannelSplitter は
  //   仕様で channelInterpretation="discrete" 固定のため、1ch 入力を
  //   「ch0=信号 / ch1=無音」に展開してしまい、MS デコード後に outR=0 となって
  //   モノラル音源が左チャンネルのみで再生される。
  //   channelInterpretation="speakers" の明示 2ch ゲインを挟むと、モノラルは
  //   L=R に正しくアップミックスされ、ステレオはそのまま 2ch で通過する。
  //   (エフェクト有効時のみ通る経路。iOS 既定 OFF 時は ctx=null でここは動かない)
  msInput = ctx.createGain();
  msInput.gain.value = 1;
  msInput.channelCount = 2;
  msInput.channelCountMode = "explicit";
  msInput.channelInterpretation = "speakers";

  msSplitter = ctx.createChannelSplitter(2);
  msInput.connect(msSplitter);

  // Mid encode: (L + R) / 2
  msMidGainL = ctx.createGain();
  msMidGainL.gain.value = 0.5;
  msMidGainR = ctx.createGain();
  msMidGainR.gain.value = 0.5;
  msMidSum = ctx.createGain();
  msMidSum.gain.value = 1;

  msSplitter.connect(msMidGainL, 0).connect(msMidSum);
  msSplitter.connect(msMidGainR, 1).connect(msMidSum);

  // Side encode: (L - R) / 2
  msSideGainL = ctx.createGain();
  msSideGainL.gain.value = 0.5;
  msSideGainR_neg = ctx.createGain();
  msSideGainR_neg.gain.value = -0.5;
  msSideSum = ctx.createGain();
  msSideSum.gain.value = 1;

  msSplitter.connect(msSideGainL, 0).connect(msSideSum);
  msSplitter.connect(msSideGainR_neg, 1).connect(msSideSum);

  // Mid Scale (ヴォーカル除去): 0 で mid 消える
  msMidScaleNode = ctx.createGain();
  msMidScaleNode.gain.value = 1;
  msMidSum.connect(msMidScaleNode);

  // Side Scale (ステレオ幅・モノ化): 0=モノ, 1=通常, 2=ワイド
  msSideScaleNode = ctx.createGain();
  msSideScaleNode.gain.value = 1;
  msSideSum.connect(msSideScaleNode);

  // Decode:
  //   outL = mid * midScale + side * sideScale
  //   outR = mid * midScale - side * sideScale
  msOutMidToL = ctx.createGain();
  msOutMidToL.gain.value = 1;
  msOutMidToR = ctx.createGain();
  msOutMidToR.gain.value = 1;
  msMidScaleNode.connect(msOutMidToL);
  msMidScaleNode.connect(msOutMidToR);

  msOutSideToL = ctx.createGain();
  msOutSideToL.gain.value = 1;
  msOutSideToR_neg = ctx.createGain();
  msOutSideToR_neg.gain.value = -1;
  msSideScaleNode.connect(msOutSideToL);
  msSideScaleNode.connect(msOutSideToR_neg);

  msMerger = ctx.createChannelMerger(2);
  msOutMidToL.connect(msMerger, 0, 0);
  msOutSideToL.connect(msMerger, 0, 0);
  msOutMidToR.connect(msMerger, 0, 1);
  msOutSideToR_neg.connect(msMerger, 0, 1);
}

/* ============ 公開 API: 各エフェクトの値設定 ============ */

/**
 * 10 バンド EQ ゲイン (dB)。UI の想定範囲は -12〜+12 だが、安全マージン込みで -24〜+24 にクランプ。
 * @param {Record<string|number, number>} gains  キーは EQ_BANDS の値
 */
export function applyEqGains(gains = {}) {
  if (!ctx) return;
  for (const f of EQ_BANDS) {
    const bq = eqFilters[String(f)];
    if (!bq) continue;
    const v = clamp(Number(gains[f] ?? gains[String(f)] ?? 0), -24, 24);
    bq.gain.value = v;
  }
}

/**
 * プリアンプ (dB)。UI の想定範囲は -12〜+6 だが、安全マージン込みで -24〜+12 にクランプ。
 */
export function applyPreamp(db) {
  if (!ctx || !preampGain) return;
  const v = clamp(Number(db) || 0, -24, 12);
  preampGain.gain.value = Math.pow(10, v / 20);
}

/**
 * 低音ブースト (dB)。UI の想定範囲は 0〜+12 だが、安全マージン込みで 0〜+18 にクランプ。
 */
export function applyBassBoost(db) {
  if (!ctx || !bassBoost) return;
  bassBoost.gain.value = clamp(Number(db) || 0, 0, 18);
}

/**
 * コンプレッサー設定
 * @param {"off"|"soft"|"medium"|"hard"} level
 */
export function applyCompressor(level) {
  if (!ctx || !compressor) return;
  const presets = {
    off:    { threshold:   0, ratio: 1, knee: 0,  attack: 0.003, release: 0.25 },
    soft:   { threshold: -18, ratio: 2, knee: 6,  attack: 0.005, release: 0.30 },
    medium: { threshold: -24, ratio: 4, knee: 10, attack: 0.004, release: 0.25 },
    hard:   { threshold: -30, ratio: 8, knee: 12, attack: 0.003, release: 0.20 },
  };
  const p = presets[level] || presets.off;
  compressor.threshold.value = p.threshold;
  compressor.ratio.value = p.ratio;
  compressor.knee.value = p.knee;
  compressor.attack.value = p.attack;
  compressor.release.value = p.release;
}

/**
 * パンニング (-1=左, 0=中央, +1=右)
 */
export function applyPan(v) {
  if (!ctx || !panner) return;
  panner.pan.value = clamp(Number(v) || 0, -1, 1);
}

/**
 * ステレオ幅・ヴォーカル除去・モノラル化 を一括設定
 * @param {object} p
 * @param {number} p.stereoWidth  0(モノ)〜2(ワイド)、既定 1
 * @param {number} p.vocalRemove  0〜1 (1で完全に mid を消す)
 * @param {boolean} p.mono        true なら強制モノラル
 *
 * 計算:
 *   midScale  = (1 - vocalRemove)
 *   sideScale = mono ? 0 : stereoWidth
 */
export function applyMidSide({ stereoWidth = 1, vocalRemove = 0, mono = false } = {}) {
  if (!ctx) return;
  const midScale = clamp(1 - clamp(Number(vocalRemove) || 0, 0, 1), 0, 1);
  const sideScale = mono ? 0 : clamp(Number(stereoWidth) || 0, 0, 3);
  if (msMidScaleNode) msMidScaleNode.gain.value = midScale;
  if (msSideScaleNode) msSideScaleNode.gain.value = sideScale;
}

/**
 * ノイズ除去 (HPF + LPF)
 * @param {"off"|"weak"|"medium"|"strong"} level
 */
export function applyNoiseReduction(level) {
  if (!ctx || !highPass || !lowPass) return;
  const presets = {
    off:    { hp: 0,    lp: 22050 },
    weak:   { hp: 50,   lp: 18000 },
    medium: { hp: 100,  lp: 15000 },
    strong: { hp: 150,  lp: 12000 },
  };
  const p = presets[level] || presets.off;
  highPass.frequency.value = p.hp;
  lowPass.frequency.value = p.lp;
}

/**
 * 出力デバイス選択 (setSinkId) - Android Chrome 等のみ
 * @param {HTMLAudioElement} audioEl
 * @param {string} sinkId
 */
export async function setAudioOutputDevice(audioEl, sinkId) {
  const elCan = !!(audioEl && typeof audioEl.setSinkId === "function");
  const ctxCan = !!(ctx && typeof ctx.setSinkId === "function");
  if (!elCan && !ctxCan) {
    throw new Error("出力デバイス選択はこの端末ではサポートされていません");
  }
  // エフェクト ON/OFF どちらの状態でも効くよう、利用可能な両経路に best-effort で適用する:
  //   - エフェクト無効: <audio> 要素が直接出力するので audioEl.setSinkId が本命。
  //   - エフェクト有効: 音声は createMediaElementSource で AudioContext に吸収され
  //     ctx.destination から出力されるため、AudioContext.setSinkId (Chrome 110+ /
  //     Android Chrome) が本命。audioEl.setSinkId は無音になるが害はない。
  // 一方が失敗してももう一方が成功すれば成功扱いとし、両方失敗時のみ throw する。
  //   (接続済み要素への setSinkId を拒否するブラウザがあっても ctx 側で切替できる)
  // iOS は setSinkId 非対応のため両方とも該当せず、UI も出ない（安全）。
  let applied = false;
  let lastErr = null;
  if (ctxCan) {
    try { await ctx.setSinkId(sinkId); applied = true; }
    catch (e) { lastErr = e; console.warn("[eq] AudioContext.setSinkId 失敗", e); }
  }
  if (elCan) {
    try { await audioEl.setSinkId(sinkId); applied = true; }
    catch (e) { lastErr = e; console.warn("[eq] audio.setSinkId 失敗", e); }
  }
  if (!applied) throw lastErr || new Error("出力デバイスを変更できませんでした");
}

/**
 * 出力デバイス選択が利用可能か
 */
export function isOutputDeviceSelectionSupported() {
  return typeof HTMLMediaElement !== "undefined"
    && typeof HTMLMediaElement.prototype.setSinkId === "function";
}

/**
 * 利用可能な出力デバイス一覧を取得
 * @returns {Promise<{deviceId: string, label: string}[]>}
 */
export async function listAudioOutputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audiooutput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label || "(名前未取得)" }));
  } catch {
    return [];
  }
}

/**
 * 全パラメータを中立 (バイパス相当) に
 */
function bypassAll() {
  if (!ctx) return;
  if (preampGain) preampGain.gain.value = 1.0;
  if (highPass) highPass.frequency.value = 0;
  if (lowPass) lowPass.frequency.value = 22050;
  if (bassBoost) bassBoost.gain.value = 0;
  for (const f of EQ_BANDS) {
    const bq = eqFilters[String(f)];
    if (bq) bq.gain.value = 0;
  }
  if (panner) panner.pan.value = 0;
  applyCompressor("off");
  applyMidSide({ stereoWidth: 1, vocalRemove: 0, mono: false });
}

/**
 * 「EQ が実際に音声経路に挿入されているか」を返す。
 */
export function isEqWired() {
  return !!ctx;
}

/**
 * AudioContext を resume する（ユーザ操作起点で呼ぶこと）。
 */
export async function resumeEqContext() {
  if (ctx && ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }
}

/* ============ プリセット ============ */

/**
 * 10 バンド EQ プリセット
 *   各値は dB (-12〜+12 程度)
 */
export const PRESETS = {
  flat:       { label: "フラット",       gains: [  0,  0,  0,  0,  0,  0,  0,  0,  0,  0] },
  bassBoost:  { label: "低音強調",       gains: [ +6, +5, +4, +2,  0,  0,  0,  0,  0,  0] },
  trebleBoost:{ label: "高音強調",       gains: [  0,  0,  0,  0,  0,  0, +2, +4, +5, +6] },
  vocal:      { label: "ボーカル",       gains: [ -3, -2, -1,  0, +2, +4, +4, +2,  0, -1] },
  rock:       { label: "ロック",         gains: [ +4, +3, +1, -1, -2,  0, +2, +4, +5, +5] },
  jazz:       { label: "ジャズ",         gains: [ +3, +2,  0,  0, -1,  0, +1, +2, +3, +3] },
  pop:        { label: "ポップ",         gains: [ -1, +1, +2, +3, +3, +2,  0, -1, +1, +2] },
  classical:  { label: "クラシック",     gains: [ +3, +2,  0,  0,  0,  0, -1, -1, +1, +2] },
  edm:        { label: "EDM",            gains: [ +6, +5, +2,  0, -2,  0, +1, +3, +5, +6] },
  movie:      { label: "映画",           gains: [ +4, +3, +1, -1,  0, +1, +2, +3, +3, +4] },
  speech:     { label: "スピーチ",       gains: [ -6, -4, -2,  0, +3, +4, +4, +2,  0, -2] },
  rnb:        { label: "R&B/ヒップホップ", gains: [ +5, +4, +2, +1,  0, -1, -1,  0, +2, +3] },
  acoustic:   { label: "アコースティック", gains: [ +2, +2, +1,  0, +1, +2, +2, +1,  0,  0] },
  metal:      { label: "メタル",         gains: [ +5, +3, -2, -3, -2, +1, +3, +4, +5, +5] },
  live:       { label: "ライブ",         gains: [ -2,  0, +1, +2, +2, +2, +2, +1,  0, -1] },
};

/**
 * プリセットの dB 配列を { freq: db } のマップに変換
 */
export function presetToGains(presetKey) {
  const p = PRESETS[presetKey];
  if (!p) return {};
  const gains = {};
  EQ_BANDS.forEach((f, i) => { gains[f] = p.gains[i] || 0; });
  return gains;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * デバッグ・テスト用: 各ノードに現在反映されているパラメータ値を返す。
 * 本番動作には影響しない読み取り専用 API。
 */
export function getEffectsState() {
  if (!ctx) return { wired: false };
  const eqGains = {};
  for (const f of EQ_BANDS) {
    eqGains[f] = eqFilters[String(f)]?.gain?.value ?? 0;
  }
  return {
    wired: true,
    contextState: ctx.state,
    preampGain: preampGain?.gain?.value ?? 1,
    highPassFreq: highPass?.frequency?.value ?? 0,
    lowPassFreq: lowPass?.frequency?.value ?? 22050,
    bassBoostGain: bassBoost?.gain?.value ?? 0,
    eqGains,
    pannerValue: panner?.pan?.value ?? 0,
    compressor: {
      threshold: compressor?.threshold?.value ?? 0,
      ratio: compressor?.ratio?.value ?? 1,
      knee: compressor?.knee?.value ?? 0,
    },
    msMidScale: msMidScaleNode?.gain?.value ?? 1,
    msSideScale: msSideScaleNode?.gain?.value ?? 1,
  };
}
