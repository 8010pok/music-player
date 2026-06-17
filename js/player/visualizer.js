/**
 * 軽量ビジュアライザ（時間波形のレベルバー + RMS / Peak メータ。周波数スペクトラムではない）
 *
 * === 設計上の重要な制約 ===
 * iOS バックグラウンド再生を維持するため、
 * 既定では <audio> 要素を AudioContext に接続しない。
 * このため AnalyserNode 由来の波形は得られない。
 *
 * 代替として「同じ Blob を decodeAudioData で別途デコードした PCM」を
 * currentTime で同期サンプリングする方式を採る。
 * これは描画用途のみで、音声出力には影響しない。
 *
 * メモリ節約のため、大容量ファイル（iOS 15MB / その他 30MB 超）は PCM
 * デコードを行わず、AudioContext をバイパスした単純な拍動アニメーションに
 * フォールバックする。それ以下のファイルは全体を一度に PCM デコードし、
 * currentTime 付近の窓を切り出して描画する（分割・チャンク化はしない）。
 */

import { appState } from "../state.js";

let canvas = null;
let ctx = null;
let rmsBar = null;
let peakBar = null;
let audioEl = null;
let raf = 0;
let active = false;

// デコード済みPCM（最初のチャンネル、Float32）
let pcm = null;
let sampleRate = 0;
// PCMが「曲全体」をカバーしているか
let pcmCoversFull = false;
// デコード要求の世代カウンタ。曲を素早く切り替えて複数の
// decodePcmForVisualization が並行 in-flight になったとき、完了順が前後しても
// 「最後に要求された曲」の PCM だけを採用し、古い曲の PCM で上書きしない。
let decodeToken = 0;
// peak ホールド
let peakHold = 0;
let peakHoldDecay = 0;

/**
 * 初期化
 * @param {object} els  { canvas, rmsBar, peakBar, audioEl }
 */
export function initVisualizer(els) {
  canvas = els.canvas;
  rmsBar = els.rmsBar;
  peakBar = els.peakBar;
  audioEl = els.audioEl;
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
}

/**
 * ビジュアライザを開始
 */
export function startVisualizer() {
  if (active) return;
  active = true;
  loop();
}

/**
 * ビジュアライザを停止
 *
 * 再生画面を離れる (view-player のアンマウント) ときに呼ばれる。
 * デコード済み PCM (曲全体で数十 MB) もここで解放し、他画面に居る間の
 * メモリ保持を避ける。再生画面に戻ると view-player の currentTrack 購読が
 * 即時発火して再デコードするため、ここでクリアしても表示に支障はない
 * (戻った直後の一瞬だけフォールバックの拍動アニメになる程度)。
 */
export function stopVisualizer() {
  active = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  // バーをリセット
  if (rmsBar) rmsBar.style.width = "0%";
  if (peakBar) peakBar.style.width = "0%";
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 大きな PCM バッファを解放 (世代も進めて in-flight デコードの結果採用を防ぐ)
  pcm = null;
  pcmCoversFull = false;
  sampleRate = 0;
  decodeToken++;
  // resize リスナを解除し、detached になった旧 canvas/DOM 参照を解放する。
  //   これをしないと再生画面の mount/unmount ごとに resize リスナが累積し、旧 canvas を
  //   掴んだまま画面外でも resizeCanvas が走り続ける。再 mount 時に initVisualizer が
  //   リスナを張り直し全参照を再設定するため、ここでの解放は表示に影響しない。
  window.removeEventListener("resize", resizeCanvas);
  canvas = null;
  ctx = null;
  rmsBar = null;
  peakBar = null;
  audioEl = null;
}

/**
 * 新しいトラック用の PCM デコード（任意呼び出し）
 * 失敗時は単純な拍動描画にフォールバック
 * @param {Blob} blob
 */
export async function decodePcmForVisualization(blob) {
  // この呼び出しの世代を採番。以降の await 後に「自分が最新要求か」を確認し、
  // 古い要求なら pcm を書き換えない (並行デコードの完了順前後による
  // stale-PCM 上書き = 波形不整合 を防ぐ)。
  const myToken = ++decodeToken;
  pcm = null;
  pcmCoversFull = false;
  sampleRate = 0;
  if (!blob) return;
  // モバイルやファイルが大きい時は負荷が高いのでスキップ。
  // ★ iOS(PWA はメモリ上限が厳しい)では full PCM 常駐が重く、長尺・大容量
  //   (特にロスレス)を毎曲フルデコードするとタブ強制リロード=再生停止に繋がりうる。
  //   そこで iOS のみデコード上限を低く設定し、超過ファイルは拍動描画フォールバックに
  //   留める(再生自体は継続)。再生経路には一切触れない視覚化のみの安全策。
  const maxBytes = (appState.get().isIOS ? 15 : 30) * 1024 * 1024;
  if (blob.size > maxBytes) return;

  // ★ デコードには OfflineAudioContext を使う(iOS でもオーディオセッションを乱さない)。
  //   実スペクトラム描画には音声ファイルを PCM へデコードする必要があるが、通常の
  //   AudioContext を生成すると iOS では AVAudioSession を掴み、再生中の <audio>
  //   (ロック画面/バックグラウンド再生)を中断させる疑いがあった。そのため旧実装は
  //   iOS で本関数を早期 return し、波形がフォールバックの拍動アニメ固定になっていた。
  //   OfflineAudioContext は「ハードウェアのオーディオ出力に一切触れない離線レンダラ」で、
  //   decodeAudioData にのみ使えばオーディオセッションを掴まない。よって iOS の再生経路に
  //   影響を与えずに実スペクトラムを復活できる(通常 AudioContext より安全)。
  //   close() は不要(ハードウェア資源を持たず、参照が切れれば GC される=リークしない)。
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return; // 念のため未対応環境はフォールバック描画のまま
  try {
    const buf = await blob.arrayBuffer();
    // 取得中に新しいデコード要求が来ていたら自分は stale → 中断
    if (myToken !== decodeToken) return;
    // 1ch / 1サンプル / 44.1kHz の最小オフライン文脈。decodeAudioData は
    // この sampleRate へリサンプルした AudioBuffer を返す(可視化用途では十分)。
    const ac = new OfflineCtx(1, 1, 44100);
    const audioBuf = await ac.decodeAudioData(buf.slice(0));
    // デコード中に新しい要求が来ていたら、その曲の PCM を壊さないよう破棄
    if (myToken !== decodeToken) return;
    pcm = audioBuf.getChannelData(0).slice(); // コピー（Float32Array）
    sampleRate = audioBuf.sampleRate;
    pcmCoversFull = true;
  } catch (e) {
    // 不可なら静かにフォールバック (ただし最新要求のときだけ状態を確定)
    if (myToken === decodeToken) {
      pcm = null;
      pcmCoversFull = false;
    }
  }
}

function resizeCanvas() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
}

function loop() {
  if (!active) return;
  raf = requestAnimationFrame(loop);
  draw();
}

function draw() {
  if (!ctx || !canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // 「実際に音が出ている」と確信できる場合のみアニメーションする。
  // - audio.paused === false
  // - audio.src がセットされている
  // - readyState が HAVE_CURRENT_DATA (>=2) 以上 = データを再生できる状態
  const hasSrc = !!(audioEl && audioEl.src);
  const hasData = !!(audioEl && audioEl.readyState >= 2);
  const playing = !!(audioEl && !audioEl.paused && hasSrc && hasData);
  if (!playing) {
    // 静止時はバーをゆっくり減衰
    decayBars();
    return;
  }

  if (pcm && pcmCoversFull) {
    drawFromPcm(w, h);
  } else {
    drawFallback(w, h);
  }
}

/**
 * PCM ベース描画
 * 現在の currentTime 付近のサンプルから RMS/Peak と簡易DFTを算出
 */
function drawFromPcm(w, h) {
  const cur = audioEl.currentTime || 0;
  const startSample = Math.floor(cur * sampleRate);
  // 解析窓のサンプル数。グローバル window をシャドウしないよう windowSize と命名。
  const windowSize = 2048;
  if (startSample + windowSize >= pcm.length) {
    decayBars();
    return;
  }
  const slice = pcm.subarray(startSample, startSample + windowSize);

  // RMS / Peak
  let sum = 0;
  let pk = 0;
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    sum += v * v;
    const av = Math.abs(v);
    if (av > pk) pk = av;
  }
  const rms = Math.sqrt(sum / slice.length);
  updateBars(rms, pk);

  // 簡易レベルバー（窓内の時間波形を等幅の連続ブロックに分割し、各ブロックの RMS を算出する。
  //   周波数変換=DFT ではなく、対数ビン分割でもない=線形等幅。可視化用途のみ）
  const bins = 48;
  const binData = new Float32Array(bins);
  const blockSize = Math.floor(windowSize / bins);
  for (let b = 0; b < bins; b++) {
    let s = 0;
    for (let i = 0; i < blockSize; i++) {
      const v = slice[b * blockSize + i] || 0;
      s += v * v;
    }
    binData[b] = Math.sqrt(s / blockSize);
  }

  drawBars(binData, w, h);
}

/**
 * フォールバック: 拍動アニメーション
 */
function drawFallback(w, h) {
  const t = performance.now() / 800;
  const bins = 24;
  const binData = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    binData[i] = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t + i * 0.4));
  }
  drawBars(binData, w, h);
  // メータも適当に動かす
  const fakeRms = 0.2 + 0.1 * Math.sin(t);
  updateBars(fakeRms, fakeRms + 0.1);
}

function drawBars(binData, w, h) {
  const n = binData.length;
  const barW = w / n;
  const cs = getComputedStyle(document.documentElement);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, cs.getPropertyValue("--success").trim() || "#57d18a");
  grad.addColorStop(1, cs.getPropertyValue("--accent").trim() || "#ff5e7e");
  ctx.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    // 線形ゲイン(×3)で強調し 1.0 にクランプ（対数スケールではない）
    const v = Math.min(1, binData[i] * 3);
    const bh = v * h;
    ctx.fillRect(i * barW + 1, h - bh, Math.max(1, barW - 2), bh);
  }
}

function updateBars(rms, peak) {
  if (rmsBar) rmsBar.style.width = `${Math.min(100, rms * 200)}%`;
  // peak ホールド（ゆるやかに減衰）
  if (peak > peakHold) {
    peakHold = peak;
    peakHoldDecay = 0;
  } else {
    peakHoldDecay += 1;
    if (peakHoldDecay > 30) peakHold = Math.max(peak, peakHold * 0.92);
  }
  if (peakBar) peakBar.style.width = `${Math.min(100, peakHold * 200)}%`;
}

function decayBars() {
  if (rmsBar) {
    const cur = parseFloat(rmsBar.style.width) || 0;
    rmsBar.style.width = `${Math.max(0, cur * 0.85)}%`;
  }
  if (peakBar) {
    peakHold *= 0.9;
    peakBar.style.width = `${Math.min(100, peakHold * 200)}%`;
  }
}
