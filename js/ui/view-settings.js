/**
 * 設定ビュー
 *
 * - Last.fm 認証（API キー/シークレット入力、認可フロー、ログアウト）
 * - 読み取り専用キー設定（API キー + ユーザ名）
 * - テーマ切替
 * - オーディオエフェクト切替（iOS バックグラウンド再生と非互換、警告つき）
 *   - 10 バンドグラフィック EQ
 *   - プリアンプ / 低音ブースト
 *   - コンプレッサー / ノイズ除去
 *   - ヴォーカル除去 / ステレオ幅 / モノラル化 / パン
 *   - 出力デバイス選択 (Android Chrome 等のみ)
 * - キャッシュ削除 / 全データ削除
 * - スクロブルキュー状況
 */

import { appState } from "../state.js";
import { getPublic, setPublic, getSecret, classifyAuth } from "../store/settings.js";
import { prepareAuthorization, completeAuthorization, setReadOnlyKey, signOut, checkReadOnlyKey } from "../lastfm/auth.js";
import { count as queueCount, wipeQueue } from "../store/queue-db.js";
import { wipeLibrary } from "../store/library-db.js";
import { flushQueue, refreshBadge } from "../lastfm/scrobble.js";
import { clearCache as clearStatsCache } from "../lastfm/stats-cache.js";
import { wipeAll as wipeStats } from "../lastfm/stats-storage.js";
import { cancel as cancelStatsService, reset as resetStatsService, startIfNeeded as startStatsIfNeeded } from "../lastfm/stats-service.js";
import { toast, confirm, promptForm, escapeHtml, escapeAttr } from "./components.js";
import { releaseAllArtwork } from "./artwork-cache.js";
import { isDriveConnected, disconnectDrive, openDriveImportModal } from "../gdrive/drive-service.js";
import { shareOrDownloadLibrary, importLibraryData } from "../store/sync-service.js";
// 属性値のエスケープは escapeHtml で代用 (quote/&/</> をエスケープ)
// escapeAttr は components.js から import 済み
import {
  applyEffectsSetting,
  applyEqGains,
  applyPreamp,
  applyBassBoost,
  applyCompressor,
  applyPan,
  applyMidSide,
  applyNoiseReduction,
  setAudioOutputDevice,
  isOutputDeviceSelectionSupported,
  listAudioOutputDevices,
  PRESETS,
  EQ_BANDS,
  bandLabel,
  presetToGains,
} from "../player/eq.js";
import { getAudioElement, stopPlayback } from "../player/audio-engine.js";

let pendingToken = null;
let pendingApiKey = null;
let pendingApiSecret = null;
// 認可ページ URL を保持（window.open が iOS PWA 等で失敗した場合に
// ユーザがリンクから手動で開けるようにするため）
let pendingAuthorizeUrl = null;
// 認証操作(フル認証/完了/読取専用)の二重実行防止フラグ。ボタン連打で
// 並行して token/session を取得し pending* が競合上書きされるのを防ぐ。
let authBusy = false;

// 現在の mount で登録した appState 購読のクリーンアップ関数群。
// remount() / アンマウント時にここを参照して確実に解除し、購読リークを防ぐ。
let viewSubscriptions = [];

// 「MUSIC-PLAYERの使い方」展開状態。モジュールスコープに保持することで、
// テーマ変更等で remount() されても展開状態が維持される。
let helpExpanded = false;

// 「制限事項・既知の問題」展開状態。同じく remount() でも保持される。
let limitationsExpanded = false;

function clearViewSubscriptions() {
  for (const unsub of viewSubscriptions) {
    try { unsub(); } catch {}
  }
  viewSubscriptions = [];
}

export async function mount(root) {
  // remount や画面遷移で残った購読を確実に解除（多重購読を防ぐ）
  clearViewSubscriptions();

  const pub = getPublic();
  const secret = await getSecret();
  const authMode = classifyAuth(secret);
  // キュー件数: appState に同期しておく。これにより画面上部のステータスピル
  // とこの画面の件数表示が常に一致する。
  await refreshBadge();
  const qCount = appState.get().scrobbleQueueCount || 0;
  const isIOS = appState.get().isIOS;
  const outputSupported = isOutputDeviceSelectionSupported();
  const outputDevices = outputSupported ? await listAudioOutputDevices() : [];
  const driveConnected = await isDriveConnected();

  // await 中にユーザが他ルートへ遷移していたら、共有コンテナ #view-root には既に
  // 別ビューが描画済み。ここで innerHTML を書くと現在ビューを破壊するため、設定
  // ルートに留まっているときだけ描画する(remountSettings と同じ離脱ガード方針)。
  if (((location.hash.match(/^#\/([^?]+)/) || [])[1]) !== "settings") return;

  root.innerHTML = render(pub, authMode, qCount, isIOS, outputSupported, outputDevices, driveConnected);
  const refs = collect(root);

  // ===== スクロブルキュー件数のリアルタイム購読 =====
  // appState.scrobbleQueueCount が変化したら、再描画せず該当 DOM だけ更新する。
  // 再生中に新しい曲がキューに登録された場合、設定画面を開いていてもその場で
  // 件数表示と「送信/破棄」ボタンの disabled が反映される。
  // 件数 0 → 1 への変化は「送信/破棄」ボタンを enabled にし、1 → 0 は disabled にする。
  const updateQueueUI = (cnt) => {
    const countEl = root.querySelector("#scrobble-queue-count");
    if (countEl) countEl.textContent = String(cnt);
    const btnFlush = root.querySelector("#btn-flush");
    const btnWipe = root.querySelector("#btn-wipe-queue");
    if (btnFlush) btnFlush.disabled = cnt === 0;
    if (btnWipe) btnWipe.disabled = cnt === 0;
  };
  viewSubscriptions.push(
    appState.subscribe(["scrobbleQueueCount"], (s) => updateQueueUI(s.scrobbleQueueCount || 0))
  );

  // ===== テーマ =====
  refs.themeSel.value = pub.theme || "system";
  refs.themeSel.addEventListener("change", () => {
    const v = refs.themeSel.value;
    setPublic({ theme: v });
    document.documentElement.dataset.theme = v;
  });

  // ===== オーディオエフェクト ON/OFF =====
  refs.fxChk.checked = !!pub.enableAudioEffects;
  refs.fxChk.addEventListener("change", async () => {
    if (refs.fxChk.checked) {
      const ok = await confirm(
        "AudioContext を音声経路に挟むため、iOS のロック画面・バックグラウンドで再生が停止する可能性があります。\n一度有効化すると、ページを再読込するまで完全には無効化されません。本当に有効化しますか？",
        { title: "オーディオエフェクトを有効化", danger: true, okLabel: "有効化" }
      );
      if (!ok) { refs.fxChk.checked = false; return; }
      // chain を構築 → 保存済みエフェクト全部を反映
      // ★ mount() 時の pub スナップショットは古くなっている可能性があるため、
      //   getPublic() で常に最新の設定を取得してからエフェクトに反映する。
      //   (EQ スライダを動かした後に一度無効化 → 再有効化すると変更が失われるバグを防止)
      const audioEl = getAudioElement();
      applyEffectsSetting(audioEl, true);
      applyAllEffects(getPublic());
      setPublic({ enableAudioEffects: true });
      appState.set({ enableAudioEffects: true });
      remount();
    } else {
      // 無効化: 全パラメータを中立にバイパス
      applyEffectsSetting(getAudioElement(), false);
      setPublic({ enableAudioEffects: false });
      appState.set({ enableAudioEffects: false });
      toast("無効化しました（iOS バックグラウンド再生を完全に戻すにはページ再読込が必要）", "ok");
      remount();
    }
  });

  // ===== プリセット =====
  if (refs.eqPresetSel) {
    refs.eqPresetSel.value = pub.eqPreset || "flat";
    refs.eqPresetSel.addEventListener("change", () => {
      const name = refs.eqPresetSel.value;
      if (name === "custom") return;
      const gains = presetToGains(name);
      setPublic({ eqPreset: name, eqGains: gains });
      appState.set({ eqPreset: name, eqGains: gains });
      applyEqGains(gains);
      // 各スライダ UI を反映
      for (const f of EQ_BANDS) {
        const s = refs.eqSliders[String(f)];
        const v = refs.eqVals[String(f)];
        if (s && v) {
          s.value = gains[f] || 0;
          v.textContent = formatDb(gains[f] || 0);
        }
      }
    });
  }

  // ===== EQ スライダ × 10 =====
  for (const f of EQ_BANDS) {
    const slider = refs.eqSliders[String(f)];
    const valEl = refs.eqVals[String(f)];
    if (!slider || !valEl) continue;
    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value) || 0;
      valEl.textContent = formatDb(v);
      const current = getPublic().eqGains || {};
      const next = { ...current, [f]: v };
      setPublic({ eqGains: next, eqPreset: "custom" });
      appState.set({ eqGains: next, eqPreset: "custom" });
      if (refs.eqPresetSel) refs.eqPresetSel.value = "custom";
      applyEqGains(next);
    });
  }

  // ===== プリアンプ =====
  if (refs.preampSlider) {
    refs.preampSlider.addEventListener("input", () => {
      const v = parseFloat(refs.preampSlider.value) || 0;
      refs.preampVal.textContent = formatDb(v);
      setPublic({ preamp: v });
      appState.set({ preamp: v });
      applyPreamp(v);
    });
  }

  // ===== 低音ブースト =====
  if (refs.bassBoostSlider) {
    refs.bassBoostSlider.addEventListener("input", () => {
      const v = parseFloat(refs.bassBoostSlider.value) || 0;
      refs.bassBoostVal.textContent = formatDb(v);
      setPublic({ bassBoost: v });
      appState.set({ bassBoost: v });
      applyBassBoost(v);
    });
  }

  // ===== コンプレッサー =====
  if (refs.compressorSel) {
    refs.compressorSel.value = pub.compressor || "off";
    refs.compressorSel.addEventListener("change", () => {
      const v = refs.compressorSel.value;
      setPublic({ compressor: v });
      appState.set({ compressor: v });
      applyCompressor(v);
    });
  }

  // ===== ノイズ除去 =====
  if (refs.noiseSel) {
    refs.noiseSel.value = pub.noiseReduction || "off";
    refs.noiseSel.addEventListener("change", () => {
      const v = refs.noiseSel.value;
      setPublic({ noiseReduction: v });
      appState.set({ noiseReduction: v });
      applyNoiseReduction(v);
    });
  }

  // ===== ヴォーカル除去 =====
  if (refs.vocalRemoveSlider) {
    refs.vocalRemoveSlider.addEventListener("input", () => {
      const v = parseFloat(refs.vocalRemoveSlider.value) / 100;
      refs.vocalRemoveVal.textContent = Math.round(v * 100) + " %";
      const pubNow = getPublic();
      setPublic({ vocalRemove: v });
      appState.set({ vocalRemove: v });
      applyMidSide({ stereoWidth: pubNow.stereoWidth ?? 1, vocalRemove: v, mono: !!pubNow.mono });
    });
  }

  // ===== ステレオ幅 =====
  if (refs.stereoWidthSlider) {
    refs.stereoWidthSlider.addEventListener("input", () => {
      const v = parseFloat(refs.stereoWidthSlider.value) / 100;
      refs.stereoWidthVal.textContent = Math.round(v * 100) + " %";
      const pubNow = getPublic();
      setPublic({ stereoWidth: v });
      appState.set({ stereoWidth: v });
      applyMidSide({ stereoWidth: v, vocalRemove: pubNow.vocalRemove || 0, mono: !!pubNow.mono });
    });
  }

  // ===== モノラル化 =====
  if (refs.monoChk) {
    refs.monoChk.checked = !!pub.mono;
    refs.monoChk.addEventListener("change", () => {
      const v = refs.monoChk.checked;
      const pubNow = getPublic();
      setPublic({ mono: v });
      appState.set({ mono: v });
      applyMidSide({ stereoWidth: pubNow.stereoWidth ?? 1, vocalRemove: pubNow.vocalRemove || 0, mono: v });
    });
  }

  // ===== パン =====
  if (refs.panSlider) {
    refs.panSlider.addEventListener("input", () => {
      const v = parseFloat(refs.panSlider.value) / 100;
      refs.panVal.textContent = panLabel(v);
      setPublic({ pan: v });
      appState.set({ pan: v });
      applyPan(v);
    });
  }

  // ===== 出力デバイス選択 (Android Chrome 等のみ) =====
  if (refs.outputSel) {
    refs.outputSel.value = pub.audioOutputDeviceId || "";
    refs.outputSel.addEventListener("change", async () => {
      const id = refs.outputSel.value;
      try {
        await setAudioOutputDevice(getAudioElement(), id);
        setPublic({ audioOutputDeviceId: id });
        appState.set({ audioOutputDeviceId: id });
        toast("出力デバイスを変更しました", "ok");
      } catch (e) {
        toast("変更失敗: " + e.message, "err");
      }
    });
  }

  // ===== フル認証時の送信トグル =====
  if (refs.scrobbleChk) {
    refs.scrobbleChk.addEventListener("change", () => {
      setPublic({ scrobbleEnabled: refs.scrobbleChk.checked });
      toast(`スクロブル送信を${refs.scrobbleChk.checked ? "有効" : "無効"}にしました`, "ok");
    });
  }
  if (refs.nowPlayingChk) {
    refs.nowPlayingChk.addEventListener("change", () => {
      setPublic({ nowPlayingEnabled: refs.nowPlayingChk.checked });
      toast(`Now Playing 通知を${refs.nowPlayingChk.checked ? "有効" : "無効"}にしました`, "ok");
    });
  }

  // ===== Last.fm 認証 =====
  // btnFullAuth は anonymous / key-only モードでのみ描画される
  // btnKeyOnly は anonymous モードでのみ描画される
  // → 認証モードによっては null になりうるためオプショナルチェーンで登録
  refs.btnFullAuth?.addEventListener("click", () => startFullAuth());
  refs.btnKeyOnly?.addEventListener("click", () => startKeyOnly());
  refs.btnCompleteAuth?.addEventListener("click", () => completeAuth());
  refs.btnCancelAuth?.addEventListener("click", () => cancelAuth());

  // ===== 認証解除（フル認証 / 読取専用の両モードで共通） =====
  //
  // 読取専用モードはセッションキーを持たないため sendScrobble が早期 return
  // し、キューに積まれることがない仕様。よって読取専用解除時のキュー削除処理
  // は不要（呼ばない）。
  // フル認証時のみ未送信スクロブルが発生し得るので、件数があれば確認ダイアログ
  // で明示しつつ削除する。
  refs.btnUnauth?.addEventListener("click", async () => {
    const isFullAuth = authMode === "authenticated";
    // キュー件数はフル認証時のみ意味を持つ
    const qc = isFullAuth ? await queueCount().catch(() => 0) : 0;

    // 確認ダイアログ文言の切替
    let msg;
    if (isFullAuth) {
      if (qc > 0) {
        msg =
          `フル認証を解除します。\n` +
          `未送信スクロブル ${qc} 件も削除されます（送信不可になるため）。\n\n` +
          `本当に解除しますか？`;
      } else {
        msg =
          `フル認証を解除しますか？\n` +
          `保存されたセッションキーと API キーが削除されます。`;
      }
    } else {
      msg =
        `読み取り専用認証を解除しますか？\n` +
        `保存された API キーが削除されます。`;
    }

    const ok = await confirm(msg, { danger: true, okLabel: "認証解除" });
    if (!ok) return;

    try {
      // 統計サービスを完全リセット（取得中断・ライブ停止・state クリア）。
      // state.user を残さないことで、認証解除後の JST 日付変更で未認証ユーザの
      // 再取得が走り誤エラートーストが出るのを防ぐ(LIFE-1)。
      resetStatsService();
      // 未送信スクロブルを削除（フル認証で件数がある場合のみ）
      if (isFullAuth && qc > 0) {
        await wipeQueue().catch(() => {});
        // キュー消去後にバッジ件数を同期
        await refreshBadge();
      }
      // 認証情報を削除（apiKey / apiSecret / sessionKey をすべて消去）
      signOut();
      // 進行中の認証フロー(prepare 済みトークン等)も破棄する。残すと解除直後に旧トークンの
      //   「認可済みを反映」で意図せず再認証できてしまう(cancelAuth と同じ後始末)。
      pendingToken = pendingApiKey = pendingApiSecret = pendingAuthorizeUrl = null;
      toast("認証を解除しました", "ok");
    } catch (e) {
      console.warn("認証解除でエラー", e);
      toast("認証解除でエラーが発生しました: " + (e.message || e), "err");
    }
    remount();
  });

  // ===== スクロブルキュー =====
  refs.btnFlush?.addEventListener("click", async () => {
    // オフライン時はネットワーク送信が不可能なので早期リターン
    if (!navigator.onLine) {
      toast("オフラインです。オンライン復帰時に自動送信されます", "info");
      return;
    }
    try {
      await flushQueue();
      // flushQueue 内部で refreshBadge() が呼ばれて appState.scrobbleQueueCount が
      // 更新されるため、件数表示は購読経由で自動更新される（remount 不要）。
      toast("キュー送信を試行しました", "ok");
    } catch (e) {
      toast("送信失敗: " + e.message, "err");
    }
  });
  refs.btnWipeQueue?.addEventListener("click", async () => {
    const ok = await confirm("未送信スクロブルを全削除しますか？", { danger: true, okLabel: "削除" });
    if (!ok) return;
    try {
      await wipeQueue();
      // ★ wipeQueue は queue-db の関数で、scrobble.js を経由しないので
      //   ここで refreshBadge() を明示的に呼んで appState を同期する。
      //   これにより画面上部のステータスピル（appState 購読）も即座に 0 件に更新される。
      //   (修正前: refreshBadge が呼ばれず、画面上部のバッジが残ったまま)
      //   バッジ同期は補助処理なので best-effort 化（失敗しても削除は成功扱いにし、
      //   wipeQueue 自体の失敗だけを error トーストの対象にする。btnWipeAll と統一）。
      await refreshBadge().catch(() => {});
      toast("キューを削除しました", "ok");
    } catch (e) {
      // 破壊的操作なので失敗は握りつぶさず通知する（認証解除ハンドラと同じ方針）。
      console.warn("キュー削除でエラー", e);
      toast("キュー削除でエラーが発生しました", "err");
    }
    // 件数表示は購読経由で更新されるので remount 不要
  });

  // ===== 「MUSIC-PLAYERの使い方」展開トグル =====
  // 展開状態 (helpExpanded) はモジュールスコープで保持しているので、
  // テーマ変更等で remount() されても展開のまま維持される。
  applyHelpExpanded(refs);
  refs.btnHelpToggle?.addEventListener("click", () => {
    helpExpanded = !helpExpanded;
    applyHelpExpanded(refs);
  });

  // ===== 「制限事項・既知の問題」展開トグル =====
  applyLimitationsExpanded(refs);
  refs.btnLimitationsToggle?.addEventListener("click", () => {
    limitationsExpanded = !limitationsExpanded;
    applyLimitationsExpanded(refs);
  });

  // ===== 全データ削除 =====
  refs.btnWipeAll.addEventListener("click", async () => {
    const ok = await confirm("ライブラリ・履歴・スクロブルキュー・認証情報・統計データを全て削除します。続けますか？", { danger: true, okLabel: "全削除" });
    if (!ok) return;
    stopPlayback();
    // 表示済みアートワークの Object URL を一括解放する。全削除でライブラリが空になり
    // 個別 releaseArtwork が呼ばれない全件分が revoke 漏れになるのを防ぐ。stopPlayback 後
    // なのでロック画面 MediaSession のアートワークを生きたまま revoke することはない。
    releaseAllArtwork();
    // 統計サービスを完全リセット（取得中断 + state クリア。LIFE-1）
    resetStatsService();
    // ★ 認証情報の削除は IDB wipe の成否に依らず必ず実行する。try 内に置くと
    //   wipeLibrary/wipeQueue が throw した場合に signOut がスキップされ、
    //   confirm で約束した「認証情報を削除」が果たされない。signOut は同期かつ
    //   localStorage/state 操作のみで IDB に依存しないため、先に確実に実行する。
    signOut();
    // 進行中の認証フロー(prepare 済みトークン等)も破棄する(全削除後に旧トークンで再認証できる
    //   ステイル状態を残さない。btn-unauth と同じ後始末)。
    pendingToken = pendingApiKey = pendingApiSecret = pendingAuthorizeUrl = null;
    // ★ ライブラリ/キュー/統計キャッシュ/統計スナップショットは独立した別 IndexedDB なので、
    //   逐次 await だと前段(例: wipeLibrary)の失敗で後段(wipeQueue/統計消去)がスキップされ
    //   「消したはずのデータが残る」。Promise.allSettled で全て独立に実行し、いずれか失敗なら
    //   その旨を通知する(部分削除を無通知にしない / 片方の失敗で他方の削除機会を奪わない)。
    const wipeResults = await Promise.allSettled([
      wipeLibrary(),
      wipeQueue(),
      clearStatsCache(),   // 統計キャッシュ消去
      wipeStats(),         // 統計スナップショット消去
    ]);
    // キュー件数バッジ同期は純粋な表示更新なので best-effort（削除成否には影響させない）。
    await refreshBadge().catch(() => {});
    const wipeFailed = wipeResults.filter((r) => r.status === "rejected");
    if (wipeFailed.length === 0) {
      toast("全データを削除しました", "ok");
    } else {
      // 破壊的操作なので失敗は握りつぶさず通知する（部分削除のまま無通知にしない）。
      console.warn("全データ削除で一部エラー", wipeFailed.map((r) => r.reason));
      toast("削除中にエラーが発生しました。一部のデータが残っている可能性があります", "err");
    }
    // 成否に関わらず画面を再構築して現在の状態を反映する。
    remount();
  });

  // ===== Google Drive 連携 =====
  refs.btnGdriveConnect?.addEventListener("click", () => {
    openDriveImportModal({
      onImported: () => remount(),
    });
  });

  refs.btnGdriveDisconnect?.addEventListener("click", async () => {
    await disconnectDrive();
    toast("Google Drive との接続を解除しました", "ok");
    remount();
  });

  refs.gdriveAutoCacheChk?.addEventListener("change", () => {
    setPublic({ gdriveAutoCache: refs.gdriveAutoCacheChk.checked });
    toast(refs.gdriveAutoCacheChk.checked ? "再生時自動キャッシュを有効にしました" : "再生時自動キャッシュを無効にしました", "ok");
  });

  // ===== 端末間ライブラリ同期 (iPad ↔ iPhone) =====
  refs.btnSyncExport?.addEventListener("click", async () => {
    try {
      toast("ライブラリを書き出し中…", "info");
      const res = await shareOrDownloadLibrary();
      if (res.shared) {
        toast("AirDrop / 共有で送信しました", "ok");
      } else if (res.downloaded) {
        toast("ライブラリ同期ファイルを保存しました", "ok");
      }
    } catch (e) {
      toast(`書き出し失敗: ${e.message}`, "err");
    }
  });

  refs.btnSyncImport?.addEventListener("click", () => {
    refs.syncFileInput?.click();
  });

  refs.syncFileInput?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      toast("ライブラリを同期中…", "info");
      const text = await file.text();
      const res = await importLibraryData(text);
      toast(`${res.tracksCount} 曲、${res.playlistsCount} 件のプレイリストを同期・復元しました`, "ok");
      remount();
    } catch (err) {
      toast(`読み込みエラー: ${err.message}`, "err");
    } finally {
      if (refs.syncFileInput) refs.syncFileInput.value = "";
    }
  });

  function remount() {
    // remount でも購読を一度クリアして mount 内で再登録する
    // (mount 冒頭の clearViewSubscriptions() でも実行されるが、
    //  呼出側を意識しやすいようここでも明示)
    clearViewSubscriptions();
    // mount は async。各ハンドラからは fire-and-forget で呼ばれるため、reject が
    //   unhandled rejection にならないよう .catch でログ + 通知する。
    mount(root).catch((e) => {
      console.error("[settings] 画面の再描画に失敗", e);
      toast("画面の再描画に失敗しました", "err");
    });
  }

  // 画面遷移時の購読クリーンアップを router.js に伝える。
  // 設定画面を離れたあとも appState 購読が残らないようにする。
  return () => {
    clearViewSubscriptions();
    // 認証フロー進行中(pending*)に設定画面を離れた場合、秘匿情報をメモリに残さない。
    // (画面内 remount は mount() 直呼びでここを通らないため、認証フローは維持される)
    pendingToken = pendingApiKey = pendingApiSecret = pendingAuthorizeUrl = null;
  };
}

/**
 * 保存済みの全エフェクトパラメータをチェーンへ反映
 * (ON 切替や設定画面復元時に使う)
 */
function applyAllEffects(pub) {
  applyEqGains(pub.eqGains || {});
  applyPreamp(pub.preamp || 0);
  applyBassBoost(pub.bassBoost || 0);
  applyCompressor(pub.compressor || "off");
  applyPan(pub.pan || 0);
  applyMidSide({
    stereoWidth: pub.stereoWidth ?? 1,
    vocalRemove: pub.vocalRemove || 0,
    mono: !!pub.mono,
  });
  applyNoiseReduction(pub.noiseReduction || "off");
}

function render(pub, authMode, qCount, isIOS, outputSupported, outputDevices, driveConnected) {
  const username = pub.username || "(未設定)";
  return `
    <section class="settings-view">

      <div class="settings-section">
        <h2>Last.fm 連携</h2>
        <div class="settings-row">
          <div>
            <div class="label">状態</div>
            <div class="help">
              ${authMode === "authenticated" ? `<span style="color:var(--success);">フル認証</span>（スクロブル・Love 可）` :
                authMode === "key-only" ? `<span style="color:var(--accent-2);">読み取りのみ</span>（統計閲覧のみ可、スクロブル不可）` :
                `<span style="color:var(--fg-muted);">未認証</span>`}
              <br/>ユーザ: ${escapeHtml(username)}
            </div>
          </div>
        </div>

        ${(authMode === "anonymous" || authMode === "key-only") ? `
          <div class="settings-row">
            <div>
              <div class="label">📘 API キー / シークレットの取得方法</div>
              <div class="help">
                Last.fm の API キーは無料で取得できます (Last.fm アカウントが必要)。<br/>
                下のリンクをタップして「Application name」等を入力するとキーが発行されます。<br/>
                <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;font-weight:600;">
                  🔗 Last.fm で API アカウントを作成する
                </a>
                <br/>
                <span style="color:var(--fg-muted);font-size:11px;">既存のアプリは <a href="https://www.last.fm/api/accounts" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">こちら</a> で確認できます。</span>
              </div>
            </div>
          </div>
        ` : ""}

        ${authMode === "anonymous" ? `
          <div class="settings-row">
            <div>
              <div class="label">フル認証（推奨）</div>
              <div class="help">
                API キー＋シークレットを入力 → Last.fm 認可ページで承認 → スクロブル・Love が可能に。<br/>
                ※ Last.fm のユーザ名・パスワードはこのアプリには入力しません（Last.fm のページで直接ログインします）。<br/>
                ※ 同じ Last.fm アカウントなら、読み取り専用と同じ API キー／シークレットでも構いません。
              </div>
            </div>
            <button class="btn primary" id="btn-full-auth">認証開始</button>
          </div>
          ${renderPendingAuthBox()}
          <div class="settings-row">
            <div>
              <div class="label">読み取り専用（API キーのみ）</div>
              <div class="help">統計画面の閲覧のみ可能になります（スクロブルは無効）</div>
            </div>
            <button class="btn" id="btn-key-only">API キー設定</button>
          </div>
        ` : ""}

        ${authMode === "key-only" ? `
          <div class="settings-row">
            <div>
              <div class="label">フル認証へアップグレード</div>
              <div class="help">
                スクロブル・Love が可能になります。<br/>
                ※ Last.fm のユーザ名・パスワードはこのアプリには入力しません。<br/>
                ※ 読み取り専用と同じ／別の API キーいずれでも OK（フル認証成功時に上書きされます）。
              </div>
            </div>
            <button class="btn primary" id="btn-full-auth">認証開始</button>
          </div>
          ${renderPendingAuthBox()}
          <div class="settings-row">
            <div>
              <div class="label">認証解除</div>
              <div class="help">保存された API キーを削除して未認証に戻します</div>
            </div>
            <button class="btn danger" id="btn-unauth">認証解除</button>
          </div>
        ` : ""}

        ${authMode === "authenticated" ? `
          <div class="settings-row">
            <div>
              <div class="label">スクロブルを有効にする</div>
              <div class="help">再生条件（30 秒以上の曲を 50% or 4 分再生）を満たした曲を Last.fm に送信</div>
            </div>
            <label class="switch"><input type="checkbox" id="scrobble-chk" ${pub.scrobbleEnabled !== false ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="settings-row">
            <div>
              <div class="label">Now Playing 通知を送る</div>
              <div class="help">再生開始時に「今聴いている曲」を Last.fm へ通知</div>
            </div>
            <label class="switch"><input type="checkbox" id="nowplaying-chk" ${pub.nowPlayingEnabled !== false ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="settings-row">
            <div>
              <div class="label">認証解除</div>
              <div class="help">セッションキーと API キーを削除して未認証に戻します</div>
            </div>
            <button class="btn danger" id="btn-unauth">認証解除</button>
          </div>
        ` : ""}

        <div class="settings-row">
          <div>
            <div class="label">未送信スクロブル</div>
            <div class="help" id="scrobble-queue-help">オフライン時や送信失敗分が <span id="scrobble-queue-count">${qCount}</span> 件キューされています</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn" id="btn-flush" ${qCount === 0 ? "disabled" : ""}>送信</button>
            <button class="btn danger" id="btn-wipe-queue" ${qCount === 0 ? "disabled" : ""}>破棄</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>Google Drive 連携</h2>
        <div class="settings-row">
          <div>
            <div class="label">状態</div>
            <div class="help" id="gdrive-status-help">
              ${driveConnected ? `<span style="color:var(--success); font-weight:600;">接続中</span> ${pub.gdriveUserEmail ? `(${escapeHtml(pub.gdriveUserEmail)})` : ""}` : `<span style="color:var(--fg-muted);">未接続</span>`}
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            ${driveConnected ? `
              <button class="btn danger" id="btn-gdrive-disconnect">切断</button>
            ` : `
              <button class="btn primary" id="btn-gdrive-connect">接続 / 追加</button>
            `}
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="label">再生時に自動キャッシュ</div>
            <div class="help">Google Drive の曲を再生した際、音源を端末（IndexedDB）に保存して次回以降オフラインで即座に再生できるようにします</div>
          </div>
          <label class="switch"><input type="checkbox" id="gdrive-autocache-chk" ${pub.gdriveAutoCache !== false ? "checked" : ""} /><span class="slider"></span></label>
        </div>
      </div>

      <div class="settings-section">
        <h2>📱 端末間ライブラリ同期 (iPad ↔ iPhone)</h2>
        <div class="settings-row">
          <div>
            <div class="label">ライブラリを書き出す (iPad → iPhone)</div>
            <div class="help">曲一覧、Google Drive 接続情報、プレイリスト、お気に入り、編集メタデータを書き出します。AirDrop や iCloud ドライブで別の端末にそのまま共有できます。</div>
          </div>
          <div>
            <button class="btn primary" id="btn-sync-export" style="white-space:nowrap;">📤 書き出す</button>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="label">ライブラリを読み込む (復元 / 同期)</div>
            <div class="help">AirDrop や iCloud で受信した同期ファイル (.json) を選択して取り込みます。Google Drive 音源はそのまま即座にストリーミング＆キャッシュ再生可能です。</div>
          </div>
          <div>
            <button class="btn" id="btn-sync-import" style="white-space:nowrap;">📥 読み込む</button>
            <input type="file" id="sync-file-input" accept=".json,application/json" style="display:none;" />
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>表示</h2>
        <div class="settings-row">
          <div>
            <div class="label">テーマ</div>
            <div class="help">システム連動 / ダーク / ライト</div>
          </div>
          <select id="theme-sel">
            <option value="system">システム連動</option>
            <option value="dark">ダーク</option>
            <option value="light">ライト</option>
          </select>
        </div>
      </div>

      <div class="settings-section">
        <h2>オーディオ詳細 / イコライザ</h2>
        ${isIOS ? `<div class="warn-box">この端末は iPhone / iPad と判定されました。<br/>下のオプションを有効化するとロック画面・バックグラウンドでの再生が停止する可能性があります。</div>` : ""}
        <div class="settings-row">
          <div>
            <div class="label">オーディオエフェクトを有効化（実験的）</div>
            <div class="help">有効にするとイコライザ・各種エフェクトが使えるようになります。<br/>※ AudioContext を音声経路に挟むため、iOS ではロック画面再生が停止する場合があります。<br/>※ 一度有効化すると、ページを再読込する（アプリを再起動）するまで内部接続は戻りません（OFF にしてもパラメータを中立にしてバイパスする形）。</div>
          </div>
          <label class="switch"><input type="checkbox" id="fx-chk" /><span class="slider"></span></label>
        </div>

        ${pub.enableAudioEffects ? renderEffectsControls(pub, outputSupported, outputDevices) : `<div class="help" style="font-size:11px;color:var(--fg-muted);margin-top:8px;">エフェクトを有効化すると、10バンドEQ・プリアンプ・低音ブースト・コンプレッサー・ヴォーカル除去・ノイズ除去・ステレオ幅・パン・モノラル化${outputSupported ? "・出力デバイス選択" : ""}が表示されます。</div>`}
      </div>

      <!-- 「MUSIC-PLAYERの使い方」展開セクション -->
      <div class="settings-section">
        <button class="btn help-toggle-btn" id="btn-help-toggle" aria-expanded="false">
          📖 MUSIC-PLAYERの使い方
        </button>
        <div class="help-content" id="help-content" hidden>
          ${renderUsageHelp()}
        </div>
      </div>

      <div class="settings-section">
        <h2>データ管理</h2>
        <div class="settings-row">
          <div>
            <div class="label">全データ削除</div>
            <div class="help">ライブラリ・履歴・スクロブルキュー・認証情報・統計データを消去</div>
          </div>
          <button class="btn danger" id="btn-wipe-all">全削除</button>
        </div>
      </div>

      <!-- 「制限事項・既知の問題」展開セクション (画面最下部) -->
      <div class="settings-section">
        <button class="btn help-toggle-btn" id="btn-limitations-toggle" aria-expanded="false">
          ⚠ 制限事項・既知の問題
        </button>
        <div class="help-content" id="limitations-content" hidden>
          ${renderLimitationsInfo()}
        </div>
      </div>

    </section>
  `;
}

/**
 * オーディオエフェクト ON 時の各種コントロール UI
 */
function renderEffectsControls(pub, outputSupported, outputDevices) {
  const gains = pub.eqGains || {};
  return `
    <!-- プリアンプ -->
    <div class="fx-row-header">プリアンプ</div>
    <div class="eq-row">
      <div class="eq-label">プリアンプ</div>
      <input class="eq-slider" id="preamp-slider" type="range" min="-12" max="6" step="1" value="${pub.preamp || 0}" />
      <div class="eq-value" id="preamp-val">${formatDb(pub.preamp || 0)}</div>
    </div>

    <!-- プリセット -->
    <div class="settings-row" style="grid-template-columns: 1fr;">
      <div>
        <div class="label">プリセット</div>
        <select id="eq-preset-sel" style="margin-top:6px;">
          ${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join("")}
          <option value="custom">カスタム</option>
        </select>
      </div>
    </div>

    <!-- 10 バンドグラフィック EQ -->
    <div class="fx-row-header">グラフィックイコライザ (10バンド)</div>
    <div class="eq-sliders">
      ${EQ_BANDS.map((f) => eqSliderRow(bandLabel(f), `eq-${f}`, gains[f] ?? gains[String(f)] ?? 0)).join("")}
    </div>

    <!-- 低音ブースト -->
    <div class="fx-row-header">低音ブースト</div>
    <div class="eq-row">
      <div class="eq-label">Bass Boost (~100Hz)</div>
      <input class="eq-slider" id="bass-boost-slider" type="range" min="0" max="12" step="1" value="${pub.bassBoost || 0}" />
      <div class="eq-value" id="bass-boost-val">${formatDb(pub.bassBoost || 0)}</div>
    </div>

    <!-- コンプレッサー -->
    <div class="settings-row">
      <div>
        <div class="label">コンプレッサー</div>
        <div class="help">小さい音を持ち上げ、大きい音を抑える</div>
      </div>
      <select id="compressor-sel">
        <option value="off">なし</option>
        <option value="soft">弱</option>
        <option value="medium">中</option>
        <option value="hard">強</option>
      </select>
    </div>

    <!-- ノイズ除去 -->
    <div class="settings-row">
      <div>
        <div class="label">ノイズ除去</div>
        <div class="help">低域ハム・高域ヒスをカット (簡易版)</div>
      </div>
      <select id="noise-sel">
        <option value="off">なし</option>
        <option value="weak">弱</option>
        <option value="medium">中</option>
        <option value="strong">強</option>
      </select>
    </div>

    <!-- ヴォーカル除去 -->
    <div class="fx-row-header">ヴォーカル除去 (歌声を小さく)</div>
    <div class="eq-row">
      <div class="eq-label">除去強度</div>
      <input class="eq-slider" id="vocal-remove-slider" type="range" min="0" max="100" step="5" value="${Math.round((pub.vocalRemove || 0) * 100)}" />
      <div class="eq-value" id="vocal-remove-val">${Math.round((pub.vocalRemove || 0) * 100)} %</div>
    </div>
    <div class="help" style="font-size:11px;color:var(--fg-muted);margin-top:-6px;">※ 中央定位の音を消すため、歌声以外のセンター楽器も減衰します。モノラル音源では効きません。</div>

    <!-- ステレオ幅 -->
    <div class="fx-row-header">ステレオ幅</div>
    <div class="eq-row">
      <div class="eq-label">幅 (100%=元音)</div>
      <input class="eq-slider" id="stereo-width-slider" type="range" min="0" max="200" step="10" value="${Math.round((pub.stereoWidth ?? 1) * 100)}" />
      <div class="eq-value" id="stereo-width-val">${Math.round((pub.stereoWidth ?? 1) * 100)} %</div>
    </div>

    <!-- パンニング -->
    <div class="fx-row-header">パン (左右バランス)</div>
    <div class="eq-row">
      <div class="eq-label">L &harr; R</div>
      <input class="eq-slider" id="pan-slider" type="range" min="-100" max="100" step="5" value="${Math.round((pub.pan || 0) * 100)}" />
      <div class="eq-value" id="pan-val">${panLabel(pub.pan || 0)}</div>
    </div>

    <!-- モノラル化 -->
    <div class="settings-row">
      <div>
        <div class="label">モノラル化</div>
        <div class="help">L+R を 1ch にまとめる (片耳イヤホン用)</div>
      </div>
      <label class="switch"><input type="checkbox" id="mono-chk" ${pub.mono ? "checked" : ""} /><span class="slider"></span></label>
    </div>

    <!-- 出力デバイス選択 (Android Chrome 等のみ) -->
    ${outputSupported ? `
      <div class="settings-row">
        <div>
          <div class="label">出力デバイス</div>
          <div class="help">音を再生する出力先を選択 (Android Chrome 等のみ)</div>
        </div>
        <select id="output-sel">
          <option value="">既定</option>
          ${outputDevices.map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label)}</option>`).join("")}
        </select>
      </div>
    ` : ""}
  `;
}

function collect(root) {
  const eqSliders = {};
  const eqVals = {};
  for (const f of EQ_BANDS) {
    eqSliders[String(f)] = root.querySelector(`#eq-${f}`);
    eqVals[String(f)] = root.querySelector(`#eq-${f}-val`);
  }
  return {
    themeSel: root.querySelector("#theme-sel"),
    fxChk: root.querySelector("#fx-chk"),
    eqPresetSel: root.querySelector("#eq-preset-sel"),
    eqSliders,
    eqVals,
    preampSlider: root.querySelector("#preamp-slider"),
    preampVal: root.querySelector("#preamp-val"),
    bassBoostSlider: root.querySelector("#bass-boost-slider"),
    bassBoostVal: root.querySelector("#bass-boost-val"),
    compressorSel: root.querySelector("#compressor-sel"),
    noiseSel: root.querySelector("#noise-sel"),
    vocalRemoveSlider: root.querySelector("#vocal-remove-slider"),
    vocalRemoveVal: root.querySelector("#vocal-remove-val"),
    stereoWidthSlider: root.querySelector("#stereo-width-slider"),
    stereoWidthVal: root.querySelector("#stereo-width-val"),
    panSlider: root.querySelector("#pan-slider"),
    panVal: root.querySelector("#pan-val"),
    monoChk: root.querySelector("#mono-chk"),
    outputSel: root.querySelector("#output-sel"),
    btnFullAuth: root.querySelector("#btn-full-auth"),
    btnKeyOnly: root.querySelector("#btn-key-only"),
    btnCompleteAuth: root.querySelector("#btn-complete-auth"),
    btnCancelAuth: root.querySelector("#btn-cancel-auth"),
    btnUnauth: root.querySelector("#btn-unauth"),
    btnFlush: root.querySelector("#btn-flush"),
    btnWipeQueue: root.querySelector("#btn-wipe-queue"),
    btnWipeAll: root.querySelector("#btn-wipe-all"),
    btnGdriveConnect: root.querySelector("#btn-gdrive-connect"),
    btnGdriveDisconnect: root.querySelector("#btn-gdrive-disconnect"),
    gdriveAutoCacheChk: root.querySelector("#gdrive-autocache-chk"),
    btnSyncExport: root.querySelector("#btn-sync-export"),
    btnSyncImport: root.querySelector("#btn-sync-import"),
    syncFileInput: root.querySelector("#sync-file-input"),
    scrobbleChk: root.querySelector("#scrobble-chk"),
    nowPlayingChk: root.querySelector("#nowplaying-chk"),
    btnHelpToggle: root.querySelector("#btn-help-toggle"),
    helpContent: root.querySelector("#help-content"),
    btnLimitationsToggle: root.querySelector("#btn-limitations-toggle"),
    limitationsContent: root.querySelector("#limitations-content"),
  };
}

/**
 * helpExpanded フラグに従って、使い方コンテンツの表示/非表示・
 * ボタンラベル・aria-expanded を切り替える。
 */
function applyHelpExpanded(refs) {
  if (!refs.btnHelpToggle || !refs.helpContent) return;
  refs.helpContent.hidden = !helpExpanded;
  refs.btnHelpToggle.textContent = helpExpanded
    ? "📖 MUSIC-PLAYERの使い方 ▲"
    : "📖 MUSIC-PLAYERの使い方 ▼";
  refs.btnHelpToggle.setAttribute("aria-expanded", String(helpExpanded));
}

/**
 * limitationsExpanded フラグに従って、制限事項コンテンツの表示/非表示・
 * ボタンラベル・aria-expanded を切り替える。
 */
function applyLimitationsExpanded(refs) {
  if (!refs.btnLimitationsToggle || !refs.limitationsContent) return;
  refs.limitationsContent.hidden = !limitationsExpanded;
  refs.btnLimitationsToggle.textContent = limitationsExpanded
    ? "⚠ 制限事項・既知の問題 ▲"
    : "⚠ 制限事項・既知の問題 ▼";
  refs.btnLimitationsToggle.setAttribute("aria-expanded", String(limitationsExpanded));
}

/**
 * 「MUSIC-PLAYERの使い方」セクションの HTML を返す。
 * 各画面（再生・ライブラリ・リスト・統計（タブ別）・設定）の機能を網羅。
 */
function renderUsageHelp() {
  return `
    <section class="usage-help">
      <p class="usage-intro">
        MUSIC-PLAYER は端末内に保存した音源を再生し、Last.fm へスクロブル送信できる PWA 音楽プレイヤーです。
        画面下のナビゲーションタブから 5 つの画面に切り替えられます。
      </p>

      <h3>▶ 再生画面</h3>
      <p>現在再生中の曲のジャケット・タイトル・進捗バー・操作ボタンを表示します。</p>
      <h4>基本操作</h4>
      <ul>
        <li><b>▶ / ⏸</b>: 再生・一時停止</li>
        <li><b>⏮ / ⏭</b>: 前の曲・次の曲へ移動</li>
        <li><b>シークバー</b>: ドラッグで再生位置を変更</li>
      </ul>
      <h4>シャッフル / リピート</h4>
      <ul>
        <li><b>🔀 シャッフル</b>: タップで ON / OFF。ON にすると現在の曲を先頭にして残りをランダム順に並べ替えます。</li>
        <li><b>🔁 リピート</b>: タップするたびに <code>OFF → キュー全体 (🔁) → 単曲 (🔂) → OFF</code> と切り替わります。
          <ul>
            <li><b>単曲リピート (🔂)</b>: 同じ曲を繰り返し再生。シャッフルとは排他で、🔂 にするとシャッフルは自動的に OFF になります。</li>
            <li><b>キュー全体 (🔁)</b>: キューの最後まで再生したら先頭に戻ります。シャッフルとは併用できます。</li>
          </ul>
        </li>
      </ul>
      <h4>その他</h4>
      <ul>
        <li><b>♡ / ♥ (Love)</b>: Last.fm のフル認証時にタップで Love 登録/解除。</li>
        <li><b>スクロブル進捗バー</b>: 30 秒を超える曲を、曲の長さの半分以上または 4 分以上再生するとスクロブル送信されます。送信結果は「スクロブル送信済」「キューに登録（オンライン復帰で送信）」等で表示されます。</li>
        <li><b>再生速度</b>: スライダーまたは入力で 0.5〜2.0 倍速に変更。「ピッチ維持」を ON にすると速度を変えても声の高さが保たれます。</li>
        <li><b>ℹ 曲の情報 ▼</b>: タップでサンプリングレート・ビットレート・コーデック等の詳細情報を展開表示。</li>
      </ul>

      <h3>📂 ライブラリ画面</h3>
      <p>端末に取り込んだ全ての曲が一覧表示されます。曲の追加・並び替え・検索・削除が可能です。</p>
      <h4>曲の追加</h4>
      <ul>
        <li><b>ファイル</b>: mp3 / m4a / m4b / aac / mp4 / flac / ogg / oga / opus / wav / webm 等のファイルを選択して追加。</li>
        <li><b>フォルダ</b>: フォルダごと一括取り込み（フォルダ内の対応ファイルが追加されます）。</li>
        <li><b>📋 メタデータ再スキャン</b>: 保存済み全曲のファイルを再パースしてタイトル・アーティスト・アルバム等を更新します。</li>
      </ul>
      <h4>検索・並び替え</h4>
      <ul>
        <li><b>検索ボックス</b>: 曲タイトル・アーティスト・アルバムを部分一致で絞り込み。</li>
        <li><b>並び替えメニュー</b>: 手動 / タイトル(昇順/降順) / アーティスト(昇順/降順) / 再生回数が多い順 / ♥ お気に入り (Love)。</li>
        <li><b>☰ ハンドル</b>: 「手動並び替え」選択時、ドラッグで順番を変更できます。</li>
      </ul>
      <h4>各曲の操作</h4>
      <ul>
        <li><b>曲行タップ</b>: その曲から再生開始（ライブラリ全体がキューになります）。</li>
        <li><b>🔇 / 🔊</b>: その曲を一時的に再生対象から外す / 戻す。シャッフル時もスキップされます。</li>
        <li><b>🗑</b>: その曲をライブラリから完全削除（取り消し不可）。</li>
        <li><b>「🔇 一時的な再生無効も表示」</b>: チェックを外すと再生無効化した曲を一覧から隠せます。</li>
      </ul>

      <h3>📝 リスト画面（プレイリスト）</h3>
      <p>お気に入りの曲をグルーピングしたプレイリストを作成・管理できます。</p>
      <h4>一覧画面</h4>
      <ul>
        <li><b>プレイリスト名入力 + 作成</b>: 新しいプレイリストを追加。</li>
        <li><b>☰ ハンドル</b>: ドラッグでプレイリスト自体の並び順を変更。</li>
        <li><b>🗑</b>: プレイリスト削除（曲自体はライブラリに残ります）。</li>
        <li><b>行タップ</b>: プレイリスト詳細画面へ。</li>
      </ul>
      <h4>詳細画面</h4>
      <ul>
        <li><b>▶ すべて再生</b>: シャッフル OFF にして先頭から再生。</li>
        <li><b>🔀 シャッフル再生</b>: シャッフル ON にしてランダムな曲から再生開始。</li>
        <li><b>🔁 リピート</b>: リピートモード (none ⇔ all) を切替。再生画面と連動します。</li>
        <li><b>＋ 曲を追加</b>: ライブラリから曲を選んで追加。</li>
        <li><b>☰ ハンドル</b>: ドラッグで曲順を変更。</li>
        <li><b>✕</b>: プレイリストからその曲を外す（曲自体は残ります）。</li>
        <li><b>✏</b>: プレイリスト名を編集。</li>
      </ul>

      <h3>📊 統計画面</h3>
      <p>Last.fm 連携時に、聴取履歴の集計と分析を表示します。データは 1 日 1 回（JST）自動更新され、🔄 更新ボタンで手動更新も可能です。</p>
      <p class="usage-note">※ 一度表示したデータは次回起動時に瞬時に表示され、バックグラウンドで新データを取得します（ダブルバッファリング）。</p>

      <h4>ダッシュボードタブ</h4>
      <ul>
        <li><b>Now Playing カード</b>: 再生中の曲を Last.fm から取得して表示（オンライン時のみ、30 秒おきに更新）。</li>
        <li><b>プロフィール</b>: アバター・累計 scrobble 数・国・登録日。</li>
        <li><b>リスニング数</b>: 直近 24 時間 / 7 日 / 30 日の scrobble 件数。</li>
        <li><b>今週のサマリー</b>: 直近 7 日の scrobble 数 / 先週比 (📈📉) / 今週のトップアーティスト。</li>
        <li><b>🧬 リスニング DNA</b>: 聴き方の傾向タグ。例: 「🌙 夜型」「☀️ 朝型」「🏖 週末派」「💼 平日派」「📚 リピート派」「🎯 集中型 (Top5 が ~%)」「🌈 幅広型」「🔥 N 日連続聴取中」など。</li>
        <li><b>クイックカード</b>: 累計リスニング時間 / 平均曲数/日 / 最大の 1 日 / 連続日数 / ユニーク曲数 / ユニークアーティスト数。</li>
        <li><b>📈 30 日トレンド</b>: 日別 scrobble 数のスパークライン（保存済みデータから集計するため追加の API 取得なし。2 日以上蓄積されると表示）。</li>
        <li><b>最近聴いた曲</b>: 直近 20 曲。時刻は「29 mins ago」「24 May 23:09」のような Last.fm 公式形式。</li>
        <li><b>👥 フレンド</b>: Last.fm のフレンドと、各フレンドが最近聴いた曲（フレンドがいる場合のみ表示）。</li>
      </ul>

      <h4>トップタブ</h4>
      <ul>
        <li><b>期間切替</b>: 1 週間 / 1 ヶ月 / 3 ヶ月 / 6 ヶ月 / 12 ヶ月 / 全期間。</li>
        <li><b>種別切替</b>: アーティスト / アルバム / トラック の各上位 20 件。</li>
      </ul>

      <h4>比較タブ</h4>
      <ul>
        <li><b>範囲切替</b>: 今週 vs 先週 / 今月 vs 先月 / 今年 vs 去年。</li>
        <li>各項目の<b>ランキング変動</b>を表示: <code>↑N</code> 上昇、<code>↓N</code> 下降、<code>→</code> 同位、<code>★ NEW</code> 新登場。前期間でランクインしていたが今期間で圏外なら下部に「圏外」表示。</li>
        <li><b>新しい発見</b>: 直近 1 週間で初めて再生した曲・アーティスト・アルバム。</li>
      </ul>

      <h4>ジャンルタブ</h4>
      <ul>
        <li><b>🧬 ジャンル DNA</b>: 全期間トップアーティストの Last.fm タグを再生数で重み付け集計したジャンル分布（ドーナツグラフ + タグクラウド）。</li>
        <li><b>🏔 ジャンル踏破率</b>: 主要ジャンルの代表アーティスト 50 組のうち、聴いたことのある割合。未聴の定番アーティストも提示します。</li>
        <li><b>📅 聴いている音楽の年代分布</b>: 全期間トップアルバムのリリース年を集計（棒グラフ）。「あなたの耳は平均◯年生まれ」も表示。</li>
      </ul>

      <h4>世界と自分タブ</h4>
      <ul>
        <li><b>🌍 メインストリーム度</b>: 世界チャート上位アーティストと、あなたの全期間聴取履歴の一致度（%）。</li>
        <li><b>🗺 国別チャート照合</b>: 各国で聴かれているトップ 50 アーティストとの一致度。「あなたの耳はどの国のチャートに最も近いか」を表示（その国出身という意味ではありません）。</li>
        <li><b>🏅 トップ曲の世界での立ち位置</b>: 全期間トップ 10 曲の世界リスナー数・再生数・占有率。世界のリスナーが少ない曲には「💎レア」バッジが付きます。</li>
      </ul>

      <h4>振り返りタブ</h4>
      <ul>
        <li><b>年別グラフ</b>: アカウント開設以降のアクティブ年 (scrobble がある年) の再生数推移。</li>
        <li><b>各年のトップ 3</b>: アーティスト・アルバム・トラック。</li>
        <li><b>マイルストン</b>: 累計 1,000 / 5,000 / 10,000 / 25,000 / 50,000 / ... scrobble を達成した年。</li>
        <li><b>あなたの始まり</b>: 初めて scrobble があった年と、その年のトップアーティスト。</li>
        <li><b>🕰 タイムトラベル</b>: 「N 年前」を選ぶと、その年の今週によく聴いていたアーティスト・トラックを振り返れます（履歴が 1 年以上ある場合のみ）。</li>
      </ul>

      <h4>時間タブ</h4>
      <ul>
        <li><b>リスニングクロック</b>: 24 時間ごとの再生頻度をレーダーチャートで表示。</li>
        <li><b>時間帯分布</b>: 深夜 (0-5) / 朝 (6-11) / 昼 (12-17) / 夜 (18-23) の集計。</li>
        <li><b>平日 vs 週末</b>: 平均聴取量の比較。</li>
        <li><b>ヒートマップ</b>: 曜日 × 時間帯 (7 × 24) のマトリクスで聴取頻度を可視化。</li>
        <li><b>月別グラフ</b>: 月単位の scrobble 数推移。</li>
        <li><b>🧭 発見の歴史</b>: 月別の「新しく聴き始めたアーティスト数」の推移。</li>
        <li><b>アーティスト分布 (上位 20)</b>: 円グラフ + 順位リストで再生比率を表示。</li>
      </ul>

      <h4>Loved タブ</h4>
      <ul>
        <li>Last.fm 上で <b>Love (♥)</b> 登録した曲の一覧。再生画面で ♡ をタップすると追加されます。</li>
      </ul>

      <h3>⚙ 設定画面</h3>
      <h4>Last.fm 連携</h4>
      <ul>
        <li><b>フル認証</b>: API キー + Secret + セッションキーを保存。スクロブル送信・Now Playing 送信・Love 操作・統計取得が全て利用可能。</li>
        <li><b>読取専用キーのみ</b>: API キーだけ保存。統計取得・Now Playing 表示は可能ですが、スクロブル送信・Love はできません。</li>
        <li><b>スクロブル送信 / Now Playing 送信</b>: スイッチで個別 ON/OFF。</li>
        <li><b>未送信スクロブル</b>: オフライン時や送信失敗分が件数表示されます。<b>送信</b>ボタンで再試行、<b>破棄</b>ボタンで全削除（送信されません）。オンライン復帰で自動送信。</li>
        <li><b>認証解除</b>: 保存済み認証情報とキューを削除。</li>
      </ul>
      <h4>表示</h4>
      <ul>
        <li><b>テーマ</b>: システム連動 / ダーク / ライト。</li>
      </ul>
      <h4>オーディオ詳細 / イコライザ</h4>
      <p class="usage-warn">
        ⚠ iPhone でこの機能を有効化すると、AudioContext を音声経路に挟むため
        ロック画面・バックグラウンド再生が止まる可能性があります。一度有効化すると
        ページ再読込まで完全には無効化されません。
      </p>
      <ul>
        <li><b>10 バンド EQ</b> (31〜16000 Hz) + プリセット (Flat / Bass Boost / Vocal / Acoustic / EDM / Rock 等)</li>
        <li><b>プリアンプ</b> / <b>低音ブースト</b> / <b>コンプレッサー</b> (弱 / 中 / 強)</li>
        <li><b>ヴォーカル除去</b> / <b>ノイズ除去</b></li>
        <li><b>ステレオ幅</b> / <b>パン (L⇔R)</b> / <b>モノラル化</b></li>
        <li><b>出力デバイス選択</b> (対応ブラウザのみ、iPhone は非対応)</li>
      </ul>
      <h4>データ管理</h4>
      <ul>
        <li><b>全削除</b>: ライブラリ・履歴・スクロブルキュー・認証情報・統計データを全消去（取り消し不可）。</li>
      </ul>
    </section>
  `;
}

/**
 * 「制限事項・既知の問題」セクションの HTML を返す。
 * 端末別・機能別の既知の制限と、ユーザ側で対処可能な回避策を記載。
 */
function renderLimitationsInfo() {
  return `
    <section class="usage-help">
      <p class="usage-intro">
        ブラウザの制約や Last.fm 側の事情で、以下の制限事項・既知の問題があります。
        多くは回避策があるので、現象に気付いたら対応方法を試してみてください。
      </p>

      <h3>📱 iPhone / iPad (iOS / iPadOS)</h3>

      <h4>ロック画面・バックグラウンド再生</h4>
      <ul>
        <li><b>(対策済み) 初回起動直後にロック画面からの再生再開が効かないことがあった</b>
          <ul>
            <li><b>以前の現象</b>: アプリ起動後の最初の再生をロック画面やワイヤレスイヤホンで一時停止し、再度再生しても「進捗バーは進むのに無音」になることがありました。</li>
            <li><b>原因</b>: コールドスタート直後は iOS の audio セッションが冷えており、バックグラウンドからの再生再開ではセッションが再活性化されないため。</li>
            <li><b>対策</b>: 最新版で、再生再開時に audio セッションを明示的に再活性化するようにして解消しました。万一それでも音が出ない場合は、再生ボタンをもう一度タップするか、アプリを前面に表示して再生し直してください。</li>
          </ul>
        </li>
        <li><b>ロック画面で進捗バーがズレる / 0% から始まらない場合がある</b>
          <ul>
            <li>曲を切り替えた直後の数秒間、稀に発生します。10〜30 秒待つと自然に正しい位置へ戻ります。</li>
          </ul>
        </li>
        <li><b>「オーディオ詳細 / イコライザ」を有効化するとバックグラウンド再生が止まる</b>
          <ul>
            <li><b>原因</b>: iOS PWA は AudioContext を音声経路に挟むとバックグラウンド再生・ロック画面制御が機能しなくなる仕様。</li>
            <li><b>回避策</b>: iPhone / iPad ではエフェクトを有効化せず、デフォルト OFF のまま使ってください。一度有効化した場合、設定画面で OFF にしてもページを再読み込みするまで完全には元に戻りません（PWA を完全終了 → 再起動）。</li>
          </ul>
        </li>
        <li><b>ロック画面のアートワークが空白になることがある</b>
          <ul>
            <li>同じ曲をリピートした直後など、まれにアートワークが消えます。曲を切り替えると正常に表示されます。</li>
          </ul>
        </li>
      </ul>

      <h4>PWA インストール・ストレージ</h4>
      <ul>
        <li><b>iOS の Safari からホーム画面に追加</b>: 共有メニュー → 「ホーム画面に追加」を選択。インストール後はホーム画面のアイコンから起動してください（スタンドアロンモード）。</li>
        <li><b>ストレージ自動削除</b>: iOS は「最近の使用がなく、容量が逼迫」した PWA の IndexedDB を自動削除することがあります。ライブラリや認証情報が消えた場合、再度ファイル追加・Last.fm 認証が必要です。<b>定期的に PWA を開く</b>ことで削除を防げます。</li>
        <li><b>標準ブラウザ (Safari) 以外からはホーム画面追加できない</b>: Chrome for iOS / Edge for iOS では PWA インストールができません。Safari を使ってください。</li>
      </ul>

      <h4>認証フロー</h4>
      <ul>
        <li><b>Last.fm のフル認証で「ブラウザが開かない」場合</b>: iOS PWA では <code>window.open()</code> が動作しないことがあります。トークン取得後に表示される「🔗 認可ページを開く」リンクをタップして手動で開いてください。</li>
      </ul>

      <h3>🤖 Android</h3>
      <ul>
        <li><b>機種・ブラウザによってロック画面コントロールの挙動が異なる</b>: Chrome は概ね正常ですが、一部の Android ブラウザ（Firefox Android、Samsung Internet）ではロック画面の進捗バーが表示されないことがあります。</li>
        <li><b>ファイル/フォルダ選択ダイアログ</b>: Android Chrome では「フォルダ」選択がサポートされていますが、機種によっては実際のフォルダではなく「最近のファイル」が出る場合があります。その場合は「ファイル」ボタンで複数ファイルを選択してください。</li>
        <li><b>出力デバイス選択 (Bluetooth/有線切替)</b>: Android Chrome では対応していますが、iOS では非対応です。</li>
      </ul>

      <h3>🖥 iPad / 大画面端末</h3>
      <ul>
        <li><b>横画面でのレイアウト</b>: 一部のチャート（統計画面のヒートマップ・年別グラフ）は横方向のスクロールが必要な場合があります。指でスクロールしてください。</li>
        <li><b>iPadOS の Safari でも「ホーム画面に追加」可能</b>: iPhone と同じ手順でインストールできます。</li>
      </ul>

      <h3>📊 Last.fm データ取得時の制限</h3>
      <ul>
        <li><b>初回のデータ取得に時間がかかる</b>
          <ul>
            <li><b>原因</b>: 統計画面の「時間」「振り返り」タブは Last.fm の全 scrobble 履歴を反復取得します。長期間のユーザは数千〜数万ページの取得になり、数分〜十数分かかる場合があります。</li>
            <li><b>回避策</b>: 一度取得が完了すれば次回起動時は瞬時に表示されます（ダブルバッファリング）。バックグラウンドで継続取得しているので、画面を閉じても OK です。</li>
          </ul>
        </li>
        <li><b>取得中に PWA を終了した場合</b>: 次回起動時に自動的に取得が再開されます。前回保存済みのデータがあれば瞬時に表示し、新データはバックグラウンドで取得されます。</li>
        <li><b>「API キーが無効です」「停止されています」とトーストが出る</b>
          <ul>
            <li><b>原因</b>: API キーが Last.fm 側で無効化・サスペンドされている、または間違って入力されている。</li>
            <li><b>回避策</b>: <a href="https://www.last.fm/api/accounts" target="_blank" rel="noopener noreferrer">Last.fm API Accounts</a> でキーの状態を確認。問題があれば新しいキーを発行し、設定画面で再認証してください。</li>
          </ul>
        </li>
        <li><b>ユーザー名が見つからないエラー</b>: 設定画面のユーザー名を確認してください（大文字小文字も区別されます）。</li>
        <li><b>Last.fm のレート制限</b>: 短時間に大量リクエストすると一時的にエラーになります。本アプリは自動的に遅延を入れているので通常は問題ありません。エラーが出たら数分待って再試行してください。</li>
        <li><b>取得中に画面がフリーズしているように見える</b>: 「📊 集計中 (N/M)」と進捗が止まっていてもバックグラウンドで処理は続いています。長時間 (数分以上) 動かない場合のみ、画面上部の「🔄 更新」ボタンで強制再取得してください。</li>
      </ul>

      <h3>🌐 オフライン・通信</h3>
      <ul>
        <li><b>オフライン時に再生したスクロブルは送信されない</b>: 送信失敗分はキューに溜まり、オンライン復帰時または手動「送信」ボタンで自動送信されます。設定画面の「未送信スクロブル」で件数を確認できます。</li>
        <li><b>オフライン中の Last.fm Now Playing は表示されない</b>: 統計画面ダッシュボードの Now Playing カードはオンライン時のみ表示されます。</li>
        <li><b>初回起動はオンライン必須</b>: Service Worker がキャッシュされていないため、初回は通信が必要です。2 回目以降は完全オフラインでも起動できます。</li>
        <li><b>ネットワーク不調で取得失敗した場合</b>: 各タスクは自動でリトライします (最大 3 回、待機間隔 4 秒 → 12 秒)。永続的なエラーの場合はリトライせず即座に通知します。</li>
      </ul>

      <h3>🎵 音源・メタデータ</h3>
      <ul>
        <li><b>対応フォーマット</b>: mp3 / m4a / m4b / aac / mp4 / flac / ogg / oga / opus / wav / webm。それ以外のフォーマット（DSD、APE、WMA 等）は再生できません。</li>
        <li><b>メタデータが取れない曲がある</b>: ID3 タグや MP4 アトムが破損していたり、特殊エンコードの場合、タイトルやアーティストが空欄になることがあります。「📋 メタデータ再スキャン」で再パースを試せます。</li>
        <li><b>アートワークが表示されない曲</b>: タグに埋め込まれていない曲はアートワークが空になります。タグ編集ソフトでアートワークを埋め込んでから再追加してください。</li>
        <li><b>再生対象なのに「曲がスキップされた」</b>: ファイル本体が壊れている / IndexedDB から失われている可能性があります。トースト「読み込めずスキップしました」が出ます。連続 5 曲スキップで自動停止します。ライブラリでその曲を削除して再度追加してください。</li>
        <li><b>大量ファイル追加時の動作</b>: たくさんの曲を一度に追加するとブラウザがフリーズすることがあります。程度に分けての追加を推奨。</li>
      </ul>

      <h3>💾 ストレージ容量</h3>
      <ul>
        <li><b>IndexedDB の容量制限</b>: ブラウザ・端末によって異なります。一般的に iOS は 1GB 程度、Android は端末の空き容量の数割。容量を超えるとファイル追加が失敗します。</li>
        <li><b>容量逼迫時の自動削除リスク</b>: 各ブラウザは容量逼迫時に IndexedDB を削除することがあります。重要な認証情報・ライブラリは別途バックアップを取っておくことを推奨します（現状エクスポート機能はありません）。</li>
        <li><b>ストレージ使用量の確認</b>: 端末の設定 → ストレージ → Safari/Chrome → サイトデータで確認できます。</li>
      </ul>

      <h3>🔁 シャッフル・リピート関連</h3>
      <ul>
        <li><b>単曲リピート (🔂) とシャッフルは排他</b>: 🔂 にするとシャッフルが自動的に OFF になり、元の曲順に戻ります。</li>
        <li><b>シャッフル ON 時に曲を切り替えた時の挙動</b>: 「次へ」ボタンを押すと、シャッフルキューの次の曲（ランダム順）に進みます。元の並びには戻りません。</li>
        <li><b>キュー末尾でリピート OFF の場合</b>: 自動停止します。曲一覧から手動で次の曲を選択してください。</li>
      </ul>

      <h3>🔧 その他の既知の問題</h3>
      <ul>
        <li><b>テーマ「システム連動」と OS の自動切替</b>: 一部の端末（古い Android、iOS 13 以前）ではシステムテーマ変化を即時反映できません。設定画面で「ダーク」「ライト」を明示指定してください。</li>
        <li><b>サブパス配信での画像読込</b>: GitHub Pages 等のサブパス配信時、稀にアートワークが表示されないことがあります。PWA を完全終了 → 再起動でほぼ解決します。</li>
        <li><b>Service Worker の更新タイミング</b>: アプリのアップデートは、PWA を完全終了 → 次回起動時に反映されます。ブラウザのリロードではキャッシュが古いまま使われることがあります。</li>
      </ul>

      <p class="usage-note">
        本アプリは個人開発のため、すべての端末・OS バージョンでの動作保証はできません。
        重要な認証情報・スクロブル履歴を扱う場合は Last.fm 公式アプリと併用することを推奨します。
      </p>
    </section>
  `;
}

function eqSliderRow(label, id, value) {
  const v = Number(value) || 0;
  return `
    <div class="eq-row">
      <div class="eq-label">${escapeHtml(label)}</div>
      <input class="eq-slider" id="${id}" type="range" min="-12" max="12" step="1" value="${v}" />
      <div class="eq-value" id="${id}-val">${formatDb(v)}</div>
    </div>
  `;
}

function formatDb(v) {
  const n = Math.round(Number(v) || 0);
  return (n > 0 ? "+" : "") + n + " dB";
}

function panLabel(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 0.05) return "C";
  if (n < 0) return "L " + Math.round(Math.abs(n) * 100) + "%";
  return "R " + Math.round(n * 100) + "%";
}

/* ============ 認証フロー ============ */

/**
 * 認証中の案内 UI を描画する（anonymous / key-only 両方で使う）。
 *
 * window.open が iOS PWA 等で失敗するケースに備え、認可 URL を
 * タップ可能なリンクとしても提示する（こちらが本命）。
 */
function renderPendingAuthBox() {
  if (!pendingToken) return "";
  const url = pendingAuthorizeUrl || "";
  return `
    <div class="warn-box" style="border:2px solid var(--accent);">
      <strong style="font-size:14px;">🔓 次のステップ: Last.fm 上で認可を完了してください</strong>
      <div class="help" style="margin-top:8px;line-height:1.6;color:var(--fg);">
        <strong>1.</strong> 下の <strong>「認可ページを開く」</strong> をタップ (Last.fm が別タブで開きます)<br/>
        <strong>2.</strong> Last.fm にログインして <strong>「はい、許可します」</strong> をタップ<br/>
        <strong>3.</strong> このアプリに戻って <strong>「認可済みを反映」</strong> をタップ<br/>
        <span style="color:var(--fg-muted);font-size:11px;">※ トークンの有効期限は約 60 分です。時間がかかりすぎた場合は「やり直し」してください。</span>
      </div>
      <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
        ${url ? `<a class="btn primary" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">🔗 認可ページを開く</a>` : ""}
        <button class="btn" id="btn-complete-auth">✅ 認可済みを反映</button>
        <button class="btn danger" id="btn-cancel-auth">やり直し</button>
      </div>
    </div>
  `;
}

async function startFullAuth() {
  if (authBusy) return; // 連打による二重 token 取得を防ぐ
  authBusy = true;
  try {
  const form = await promptForm("Last.fm 認証（フル）", [
    { name: "apiKey", label: "API キー（32桁の16進）", placeholder: "" },
    // シークレットは秘匿情報なので password 型でマスクする(肩越し盗み見/履歴残り防止)。
    // autocomplete="new-password" でパスワードマネージャ/Keychain への保存提案を抑止。
    { name: "apiSecret", label: "シークレット（32桁の16進）", type: "password", autocomplete: "new-password", placeholder: "" },
  ]);
  if (!form) return;
  if (!form.apiKey || !form.apiSecret) {
    toast("両方の入力が必要です", "err");
    return;
  }
  try {
    const { token, authorizeUrl } = await prepareAuthorization({
      apiKey: form.apiKey.trim(), apiSecret: form.apiSecret.trim(),
    });
    // ★ await 中にユーザが設定画面を離れていた場合、秘匿情報(apiSecret等)を
    //   モジュール変数へ再代入しない。離脱時は cleanup が pending* を null 化済みで、
    //   ここで代入すると router の cleanup 対象外のまま秘匿情報がメモリに残る
    //   (M2 の意図を await 後の再代入で打ち消さないためのガード)。
    //   finally{authBusy=false} は try 内 return でも実行されるため flag は復帰する。
    if (((location.hash.match(/^#\/([^?]+)/) || [])[1]) !== "settings") return;
    pendingToken = token;
    pendingApiKey = form.apiKey.trim();
    pendingApiSecret = form.apiSecret.trim();
    pendingAuthorizeUrl = authorizeUrl;
    // ★ iOS PWA (standalone Safari) では user gesture が await 後に
    //   失われるため、ここでの window.open はブロックされて何も起きない。
    //   デスクトップブラウザではベストエフォートで動くため試みるが、
    //   メインの導線は UI 側の「認可ページを開く」リンクをタップしてもらうこと。
    //   このリンクは <a href target="_blank"> の素のタップなので、user
    //   gesture が確実に有効で、iOS PWA でも問題なく Last.fm を開ける。
    try { window.open(authorizeUrl, "_blank", "noopener,noreferrer"); } catch {}
    toast("トークンを取得しました。下の『認可ページを開く』をタップして Last.fm にアクセスし、認可してください。", "ok");
    // ★ remountSettings() を await することで DOM 更新を確実に待ってから
    //   スクロールする。以前の setTimeout(250ms) ハックはなくなる。
    await remountSettings();
    // ユーザが「認可ページを開く」ボタンを見落とさないように warn-box へスクロール。
    // await 後は mount() 完了済みのため、DOM に warn-box が確実に存在する。
    const box = document.querySelector(".warn-box");
    if (box) {
      try { box.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
    }
  } catch (e) {
    toast("トークン取得失敗: " + e.message, "err");
  }
  } finally {
    authBusy = false;
  }
}

async function completeAuth() {
  if (authBusy) return; // 連打による二重セッション取得を防ぐ
  if (!pendingToken || !pendingApiKey || !pendingApiSecret) {
    toast("認証フローが未開始です", "err");
    return;
  }
  authBusy = true;
  try {
    const { username } = await completeAuthorization({
      apiKey: pendingApiKey, apiSecret: pendingApiSecret, token: pendingToken,
    });
    pendingToken = pendingApiKey = pendingApiSecret = pendingAuthorizeUrl = null;

    // ★ 認証完了で apiKey / username が変わった可能性があるため、進行中だった
    //   読み取り専用モードの統計取得を破棄し、新しい認証情報で再起動する。
    //   これをしないと「途中まで取得していて『データがありません』のまま固まる」
    //   状態に陥る (読み取りで途中だったため saveCurrent も走らず、部分的な
    //   in-memory section だけが残ったまま)。
    try {
      await cancelStatsService();
      startStatsIfNeeded(username).catch((e) => console.warn("[settings] stats restart failed", e));
    } catch (e) {
      console.warn("[settings] stats restart after full auth failed", e);
    }

    toast(`認証成功: ${username}`, "ok");
    await remountSettings();
  } catch (e) {
    // Last.fm エラー 14 = Unauthorized Token
    //   トークンがまだ Last.fm 上で認可されていない（最頻出ケース）。
    //   多くは「認可ページで『はい、許可します』をタップしていない」「ブラウザで
    //   Last.fm にログインしていない」「認可ページが実際には開かれていない」のいずれか。
    if (e && e.code === 14) {
      toast(
        "Last.fm 上での認可がまだ完了していません。『認可ページを開く』をタップして Last.fm にアクセスし、『はい、許可します』をタップしてから再度『認可済みを反映』を押してください。",
        "err"
      );
    } else {
      toast("セッション取得失敗: " + e.message, "err");
    }
  } finally {
    authBusy = false;
  }
}

/**
 * 認証フローのキャンセル: pending 状態を全て破棄して最初からやり直せる状態に戻す。
 *   - ストレージには prepareAuthorization 時点では何も書き込んでいないため、
 *     キャンセルしても元の認証状態（読み取り専用など）はそのまま維持される。
 */
async function cancelAuth() {
  pendingToken = pendingApiKey = pendingApiSecret = pendingAuthorizeUrl = null;
  toast("認証フローをキャンセルしました", "info");
  await remountSettings();
}

async function startKeyOnly() {
  if (authBusy) return; // 連打防止
  authBusy = true;
  try {
  const form = await promptForm("Last.fm 読み取り専用", [
    { name: "apiKey", label: "API キー（32桁の16進）", placeholder: "" },
    { name: "username", label: "Last.fm ユーザ名", placeholder: "" },
  ]);
  if (!form) return;
  if (!form.apiKey || !form.username) {
    toast("両方の入力が必要です", "err");
    return;
  }
  const apiKey = form.apiKey.trim();
  let username = form.username.trim();

  // ★ 事前検証: オンラインなら Last.fm に user.getInfo を投げて
  //   apiKey × username の組合せが有効かを確認する。
  //   オフライン時は検証をスキップして保存（後で統計画面で改めて失敗検知）。
  if (navigator.onLine) {
    try {
      const user = await checkReadOnlyKey({ apiKey, username });
      // 大小文字を Last.fm の正準表記に揃える（例: "User" → "user"）
      if (user && user.name && user.name !== username) {
        username = user.name;
      }
    } catch (e) {
      if (e && e.code === 6) {
        toast(`Last.fm にユーザー「${username}」が見つかりません。スペルを確認してください。`, "err");
        return;
      }
      if (e && e.code === 10) {
        toast("API キーが無効です。Last.fm の API アカウント設定を確認してください。", "err");
        return;
      }
      if (e && e.code === 26) {
        toast("この API キーは Last.fm によって停止されています。新しい API キーを取得してください。", "err");
        return;
      }
      // ネットワーク一時障害など → 警告のみで保存続行
      toast(`検証中にエラー: ${e.message || e}（とりあえず保存します）`, "info");
    }
  } else {
    toast("オフラインのため検証をスキップします（オンライン時に統計画面で再確認されます）", "info");
  }

  try {
    await setReadOnlyKey({ apiKey, username });
    toast("読み取り専用キーを保存しました", "ok");

    // ★ 認証情報が変わったため、進行中の統計取得を破棄して再起動する。
    //   (例: 別ユーザー名で再設定した場合、古いユーザーの取得が継続するのを防ぐ)
    try {
      await cancelStatsService();
      startStatsIfNeeded(username).catch(() => {});
    } catch {}

    await remountSettings();
  } catch (e) {
    toast("保存失敗: " + e.message, "err");
  }
  } finally {
    authBusy = false;
  }
}

/**
 * 設定画面を再マウントする。
 * mount() は async のため、その Promise を返す。
 * 呼び出し側が await することで「DOM 更新完了後」に後続処理を行える。
 */
async function remountSettings() {
  // 認証フローのネットワーク await 中にユーザが別ルートへ遷移していた場合、
  // 共有コンテナ #view-root は既に他ビューが占有している。ここで設定画面を
  // 再 mount すると (a)現在ビューの DOM を破壊し、(b)設定画面の購読が router の
  // cleanup 対象外(currentCleanup は他ビューを指す)となって漏れる。
  // よって設定ルートに居るときだけ再マウントする(ルート名解析は router.js の
  // #/name 形式に合わせる)。離脱済みなら何もしない。
  const name = (location.hash.match(/^#\/([^?]+)/) || [])[1];
  if (name !== "settings") return;
  const root = document.getElementById("view-root");
  if (root) await mount(root);
}
