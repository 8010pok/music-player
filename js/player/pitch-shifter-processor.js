/**
 * ピッチシフター AudioWorkletProcessor
 *
 * テンポ（再生速度）を変えずに音程（半音単位）をリアルタイムに変更する。
 * - semitones === 0 (原曲キー) のときは完全バイパス (入力配列をそのままコピー、CPU負荷・歪みゼロ)
 * - semitones !== 0 のときはフラクショナルディレイ・インターポレーションによる高品質ピッチシフト
 * - ステレオ (2ch) / モノラル (1ch) 両対応
 */

export class PitchShifterCore {
  /**
   * @param {number} [sampleRate=44100]
   * @param {number} [windowSizeSec=0.1] ディレイウィンドウ長 (0.1秒 = 100ms)
   */
  constructor(sampleRate = 44100, windowSizeSec = 0.1) {
    this.sampleRate = sampleRate || 44100;
    this.windowSize = Math.max(256, Math.floor(windowSizeSec * this.sampleRate));
    // 2タップ分のディレイバッファ (L / R)
    this.delayBufferL = new Float32Array(this.windowSize * 2);
    this.delayBufferR = new Float32Array(this.windowSize * 2);
    this.writeIndex = 0;
    this.phase = 0.0;
    this.semitones = 0;
    this.pitchFactor = 1.0;
    this.phaseStep = 0.0;
  }

  /**
   * 半音シフト量を設定 (-12 〜 +12)
   * @param {number} semitones
   */
  setSemitones(semitones) {
    const s = Math.max(-12, Math.min(12, Math.round(Number(semitones) || 0)));
    this.semitones = s;
    this.pitchFactor = Math.pow(2, s / 12);
    this.phaseStep = (this.pitchFactor - 1.0) / this.windowSize;
  }

  /**
   * 1 量子化ブロック (128 サンプル) の音声処理
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} outputs
   * @returns {boolean}
   */
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    const channelCount = Math.min(input.length, output.length);
    const quantumSize = input[0].length;

    // 原曲キー (0) のときは完全透過バイパス（無処理・CPU消費ゼロ）
    if (this.semitones === 0) {
      for (let ch = 0; ch < channelCount; ch++) {
        output[ch].set(input[ch]);
      }
      return true;
    }

    const inL = input[0];
    const inR = channelCount > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = channelCount > 1 ? output[1] : null;

    const bufL = this.delayBufferL;
    const bufR = this.delayBufferR;
    const bLen = bufL.length;
    const wSize = this.windowSize;
    let wIdx = this.writeIndex;
    let ph = this.phase;
    const phStep = this.phaseStep;

    for (let i = 0; i < quantumSize; i++) {
      bufL[wIdx] = inL[i];
      bufR[wIdx] = inR[i];

      let p1 = ph;
      while (p1 < 0) p1 += 1.0;
      while (p1 >= 1) p1 -= 1.0;

      let p2 = ph + 0.5;
      while (p2 < 0) p2 += 1.0;
      while (p2 >= 1) p2 -= 1.0;

      const d1 = p1 * wSize;
      const d2 = p2 * wSize;

      const r1 = wIdx - d1;
      const r1_idx = Math.floor(r1);
      const r1_frac = r1 - r1_idx;
      const i1_0 = (r1_idx % bLen + bLen) % bLen;
      const i1_1 = ((r1_idx + 1) % bLen + bLen) % bLen;

      const r2 = wIdx - d2;
      const r2_idx = Math.floor(r2);
      const r2_frac = r2 - r2_idx;
      const i2_0 = (r2_idx % bLen + bLen) % bLen;
      const i2_1 = ((r2_idx + 1) % bLen + bLen) % bLen;

      // ハン窓クロスフェード (w1 + w2 = 1.0)
      const w1 = 0.5 * (1 - Math.cos(2 * Math.PI * p1));
      const w2 = 0.5 * (1 - Math.cos(2 * Math.PI * p2));

      outL[i] = (bufL[i1_0] * (1 - r1_frac) + bufL[i1_1] * r1_frac) * w1 +
                (bufL[i2_0] * (1 - r2_frac) + bufL[i2_1] * r2_frac) * w2;

      if (outR) {
        outR[i] = (bufR[i1_0] * (1 - r1_frac) + bufR[i1_1] * r1_frac) * w1 +
                  (bufR[i2_0] * (1 - r2_frac) + bufR[i2_1] * r2_frac) * w2;
      }

      wIdx = (wIdx + 1) % bLen;
      ph -= phStep;
      while (ph < 0) ph += 1.0;
      while (ph >= 1) ph -= 1.0;
    }

    this.writeIndex = wIdx;
    this.phase = ph;
    return true;
  }
}

// AudioWorkletGlobalScope 実行時の登録
if (typeof registerProcessor === "function") {
  class PitchShifterWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      const sr = typeof sampleRate !== "undefined" ? sampleRate : 44100;
      this.core = new PitchShifterCore(sr, 0.1);
      this.port.onmessage = (e) => {
        if (e.data && e.data.type === "setSemitones") {
          this.core.setSemitones(e.data.semitones);
        }
      };
    }

    process(inputs, outputs, parameters) {
      return this.core.process(inputs, outputs);
    }
  }

  registerProcessor("pitch-shifter-processor", PitchShifterWorkletProcessor);
}
