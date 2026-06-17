/**
 * ライブラリビュー（保持曲の管理）
 *
 * - ファイル選択 / フォルダ選択 で曲追加（モバイル前提のためドロップ対応なし）
 * - 検索 (タイトル/アーティスト/アルバム)
 * - ソート (手動 / タイトル(昇順|降順) / アーティスト(昇順|降順) / 再生回数 / ♥お気に入り(Love))
 * - 行: 行 / アート / 曲名タップで再生（再生ボタン無し）
 * - Loved 表示・スピーカートグル・削除
 * - 削除 or 無効化された曲が現在再生中なら自動停止
 */

import { extractMetadata, readDurationViaAudio } from "../metadata/index.js";
import { mimeFromName, formatFromName } from "../metadata/util.js";
import { putTrack, getTrack, getAllTracks, updateTrack, setTracksOrder, deleteTrack, getStorageEstimate, getBlob, removeTrackFromAllPlaylists } from "../store/library-db.js";
import { setQueueAndPlay, stopPlayback } from "../player/audio-engine.js";
import { toast, confirm, escapeHtml, escapeAttr } from "./components.js";
import { appState } from "../state.js";
import { go } from "../router.js";
import { getArtworkUrl, releaseArtwork } from "./artwork-cache.js";

// ファイル拡張子の許可リスト
const ALLOW_EXT = /\.(mp3|m4a|m4b|aac|mp4|flac|ogg|oga|opus|wav|webm)$/i;

let unsubState = null;
let tracksCache = [];
// 直近の renderList で生成した「画面に見えているそのままの順序の」配列。
// 再生キューはこれを使う（ソート/フィルタを尊重する）
let visibleTracks = [];
let filterText = "";
// デフォルトは手動並び替え（曲を追加した順 = addedAt にフォールバック）
let sortKey = "manual-asc";
let showDisabled = true;
// ドラッグ並び替え用の一時状態
let dragState = null;
// 現在マウント中のライブラリ画面の refs。取込/再スキャンの後追い完了処理やトグル書込の
//   遅延失敗ハンドラが「いま表示されている画面か」を判定するのに使う(画面遷移後や別マウント
//   への誤った描画・文脈外トーストを防ぐ)。mount でセットし cleanup で null に戻す。
let activeRefs = null;
// 曲 id ごとの再生有効/無効トグル書き込みチェーン。同一曲の連続トグルを直列化し、
//   library-db の一過性リトライ(遅延あり)で「古い書き込みが新しい書き込みより後に commit
//   する順序逆転」が起きるのを防ぐ(後発トグルは前の書き込み完了後に commit される)。
const enabledWriteChains = new Map();
// ストレージ使用量の表示文字列。libStats を renderList と refreshStorage が
// 別フォーマットで奪い合わないよう、ここに保持して常に統一表示する。
let storageInfo = "";
// 取込(onFiles)と再スキャン(rescanMeta)の相互排他フラグ。両者は進捗を
// rescanProgress 要素で共有し tracksCache を書き換えるため、同時実行を禁止する。
let bulkBusy = false;

export async function mount(root) {
  // --- ドラッグ並び替えの残置状態をリセット ---
  // モジュールスコープの dragState は SPA 内では他画面遷移を跨いで生存する。
  // 万一 dragend 系イベントが取りこぼされた状態で別画面に遷移すると、
  // 次回ライブラリを開いたとき該当行が画面外 (fixed positioning) のまま
  // 残ってドラッグハンドルが「見えない」現象が起きる可能性がある。
  // mount 開始時に必ずクリアする。
  resetDragState();

  root.innerHTML = render();
  const refs = collectRefs(root);
  // この画面を「現在表示中」として記録する(後追い完了処理/遅延失敗ハンドラの判定用)。
  activeRefs = refs;

  // ★ 検索/ソート/表示状態を、render() が描画したコントロールの初期値
  //   (検索空・手動並び替え・無効も表示)に合わせてリセットする。これをしないと
  //   別画面から戻ったとき、コントロール表示は初期値なのに一覧だけ前回の filter/
  //   sort 状態で描画され(表示と操作が食い違い)、その誤った visibleTracks から
  //   再生キューが作られてしまう(dragState を mount 冒頭でリセットするのと同じ理由)。
  filterText = "";
  sortKey = "manual-asc";
  showDisabled = true;
  // storageInfo も初期化する。これをしないと再マウント時、refreshStorage で
  // 更新される前の最初の描画に前回マウントの古いストレージ文字列が一瞬出る。
  storageInfo = "";

  // 初期描画。IDB エラー等で読込に失敗しても未処理例外にせず、空一覧+通知に留める
  // (他経路 onFiles/delete/rescanMeta と同じエラーハンドリング方針に揃える)。
  try {
    await reloadTracks(refs);
    await refreshStorage(refs);
  } catch (e) {
    console.warn("ライブラリ初期読込に失敗", e);
    toast("ライブラリの読込に失敗しました。画面を開き直してください", "err");
  }

  // 入力結線
  // onFiles は冒頭で FileList を同期コピー(Array.from)してから await するため、呼び出し直後に
  //   value をクリアしても取込に影響しない。クリアしないと同一ファイルの再選択で change が
  //   再発火せず「取込(または削除)→同じファイルを再追加」の導線が塞がる。
  refs.fileInput.addEventListener("change", (e) => { onFiles(refs, e.target.files); e.target.value = ""; });
  refs.folderInput.addEventListener("change", (e) => { onFiles(refs, e.target.files); e.target.value = ""; });
  refs.addBtn.addEventListener("click", () => refs.fileInput.click());
  refs.addFolderBtn.addEventListener("click", () => refs.folderInput.click());
  if (refs.rescanBtn) refs.rescanBtn.addEventListener("click", () => rescanMeta(refs));

  // 検索
  refs.search.addEventListener("input", () => {
    filterText = refs.search.value.trim().toLowerCase();
    renderList(refs);
  });
  refs.sort.addEventListener("change", () => {
    sortKey = refs.sort.value;
    renderList(refs);
  });
  refs.showDisabledChk.addEventListener("change", () => {
    showDisabled = refs.showDisabledChk.checked;
    renderList(refs);
  });

  // 一覧クリック委譲
  refs.list.addEventListener("click", (e) => onListClick(e, refs));

  // 並び替え（手動ソート時のみ動作）
  const cleanupReorder = installReorder(refs);

  // 再生中ハイライト
  unsubState = appState.subscribe(["currentTrack"], () => renderList(refs));

  // 「現在再生中のプレイリスト」バナー
  const unsubPlaylist = appState.subscribe(
    ["currentPlaylistId", "currentPlaylistName"],
    (s) => updateNowPlayingBanner(refs, s)
  );

  return () => {
    if (unsubState) unsubState();
    unsubState = null;
    if (unsubPlaylist) unsubPlaylist();
    if (cleanupReorder) cleanupReorder();
    // この画面はもう表示されていない。後追い処理/遅延失敗ハンドラが誤って描画・通知しないよう
    //   activeRefs を解除する(同 refs で再マウントされた場合は mount が再セットする)。
    activeRefs = null;
  };
}

/**
 * ライブラリ画面の上部に「プレイリスト「X」を再生中」バナーを表示
 */
function updateNowPlayingBanner(refs, s) {
  const banner = refs.npBanner;
  if (!banner) return;
  if (s.currentPlaylistId && s.currentPlaylistName) {
    banner.hidden = false;
    banner.innerHTML = `🔊 プレイリスト <a class="np-link" href="#/playlist?id=${escapeAttr(s.currentPlaylistId)}">「${escapeHtml(s.currentPlaylistName)}」</a> を再生中`;
  } else {
    banner.hidden = true;
    banner.innerHTML = "";
  }
}

function render() {
  return `
    <section class="library-view">
      <!-- 「現在再生中のプレイリスト」バナー -->
      <div class="now-playing-from" id="np-banner" hidden></div>

      <div class="library-add">
        <div class="library-add-title">音源ファイルを追加</div>
        <div class="library-add-buttons">
          <button class="btn primary" id="btn-add">ファイル</button>
          <button class="btn primary" id="btn-add-folder">フォルダ</button>
        </div>
        <input type="file" id="file-input" multiple
               accept=".mp3,.m4a,.m4b,.aac,.mp4,.flac,.ogg,.oga,.opus,.wav,.webm,audio/*"
               style="display:none" />
        <input type="file" id="folder-input" multiple webkitdirectory directory
               style="display:none" />
        <div class="library-rescan-row">
          <button class="btn" id="btn-rescan-meta" title="保存済み全曲のファイルを再パースしてメタデータを更新します">
            📋 メタデータ再スキャン
          </button>
          <span id="rescan-progress" class="rescan-progress"></span>
        </div>
      </div>

      <div class="library-toolbar">
        <input type="search" id="lib-search" placeholder="検索: 曲タイトルなどを入力" />
        <select id="lib-sort">
          <option value="manual-asc">手動並び替え</option>
          <option value="title-asc">タイトル(昇順)</option>
          <option value="title-desc">タイトル(降順)</option>
          <option value="artist-asc">アーティスト(昇順)</option>
          <option value="artist-desc">アーティスト(降順)</option>
          <option value="playCount-desc">再生回数が多い順</option>
          <option value="loved-desc">♥ お気に入り (Love)</option>
        </select>
        <label class="settings-row" style="border:none;padding:0;display:flex;gap:6px;align-items:center;">
          <input type="checkbox" id="show-disabled" checked />
          <span>🔇 一時的な再生無効も表示</span>
        </label>
      </div>

      <div class="library-stats" id="lib-stats"></div>

      <ul class="track-list" id="track-list"></ul>
    </section>
  `;
}

function collectRefs(root) {
  return {
    npBanner: root.querySelector("#np-banner"),
    fileInput: root.querySelector("#file-input"),
    folderInput: root.querySelector("#folder-input"),
    addBtn: root.querySelector("#btn-add"),
    addFolderBtn: root.querySelector("#btn-add-folder"),
    rescanBtn: root.querySelector("#btn-rescan-meta"),
    rescanProgress: root.querySelector("#rescan-progress"),
    search: root.querySelector("#lib-search"),
    sort: root.querySelector("#lib-sort"),
    showDisabledChk: root.querySelector("#show-disabled"),
    libStats: root.querySelector("#lib-stats"),
    list: root.querySelector("#track-list"),
  };
}

async function reloadTracks(refs) {
  tracksCache = await getAllTracks();
  renderList(refs);
}

function renderList(refs) {
  if (!refs || !refs.list) return;
  // ★ 手動並び替えのドラッグ中は DOM (浮かせた行・プレースホルダ) を直接
  //   操作しているため、全再描画すると進行中のドラッグが壊れる。
  //   currentTrack 購読は曲切替のたびに renderList を呼ぶので、ドラッグ中に
  //   曲が変わるとここで弾かないと並び替えが中断される。
  //   (ドラッグ完了時の onDragEnd は dragState=null 後に renderList を呼ぶので
  //    そちらは通る)
  if (dragState) return;
  const cur = appState.get().currentTrack;
  let list = tracksCache.slice();
  if (filterText) {
    list = list.filter((t) =>
      (t.title || "").toLowerCase().includes(filterText) ||
      (t.artist || "").toLowerCase().includes(filterText) ||
      (t.album || "").toLowerCase().includes(filterText)
    );
  }
  if (!showDisabled) list = list.filter((t) => t.enabled !== false);
  list.sort(getComparator(sortKey));

  // 表示順をキャッシュ（再生時はこの順でキューを作る）
  visibleTracks = list;
  refs.list.innerHTML = list.map((t) => rowHtml(t, cur)).join("");
  refs.libStats.textContent = `${list.length} / ${tracksCache.length} 曲${storageInfo}`;
}

function rowHtml(t, cur) {
  const playing = cur && cur.id === t.id;
  const enabled = t.enabled !== false;
  const loved = !!t.loved;
  const sub = [t.artist || "(不明)", t.album || ""].filter(Boolean).join(" — ");
  // アートワーク URL（無ければ <img> 自体を出さず空の枠を残す）
  const artUrl = getArtworkUrl(t);
  const artImg = artUrl
    ? `<img class="track-art" src="${escapeAttr(artUrl)}" alt="" />`
    : `<div class="track-art"></div>`;
  // 手動並び替えモード時のみドラッグハンドル表示（アートワークの左隣に配置）。
  // ★ ただし検索/「無効非表示」フィルタが効いていると一覧は部分集合になり、
  //   onDragEnd が可視行だけに order を振り直して全体の手動順を壊してしまう。
  //   フィルタ中はハンドルを出さず(=is-manual も付けず)並び替えを無効化する。
  const filterActive = !!filterText || !showDisabled;
  const isManual = sortKey === "manual-asc" && !filterActive;
  const handle = isManual
    ? `<span class="drag-handle" data-act="handle" role="button" tabindex="0" aria-label="並び替えハンドル（ドラッグで上下移動）" title="ドラッグで並び替え">☰</span>`
    : ``;
  // Love されている曲はハートを表示（旧 ▶ 再生ボタンの代わり）
  // 行/アートワーク/曲名タップで再生されるので、明示的な再生ボタンは不要
  const lovedMark = loved
    ? `<span class="track-loved" title="Loved" aria-label="Loved">♥</span>`
    : `<span class="track-loved-spacer" aria-hidden="true"></span>`;
  // 一時無効/有効はスピーカーアイコン
  const toggleIcon = enabled ? "🔊" : "🔇";
  const toggleTitle = enabled ? "一時的に再生無効にする" : "再生を再び有効にする";
  return `
    <li class="track-row ${playing ? "is-playing" : ""} ${enabled ? "" : "is-disabled"} ${isManual ? "is-manual" : ""}" data-id="${escapeAttr(t.id)}">
      ${handle}
      ${artImg}
      <div class="track-info">
        <div class="track-title">${escapeHtml(t.title || "(無題)")}</div>
        <div class="track-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="track-actions">
        ${lovedMark}
        <button class="icon-btn" data-act="toggle" title="${toggleTitle}">${toggleIcon}</button>
        <button class="icon-btn" data-act="delete" title="削除">🗑</button>
      </div>
    </li>
  `;
}

// escapeHtml は属性値エスケープにも使用（components.js 側で null-safe）
// escapeAttr は components.js から import 済み

/** CSS セレクタで安全に使える形にエスケープ (CSS.escape のフォールバック) */
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/([!"#$%&'()*+,./:;<=>?@\[\]^`{|}~])/g, "\\$1");
}

function getComparator(key) {
  switch (key) {
    case "manual-asc":   return (a, b) => orderOf(a) - orderOf(b);
    case "title-asc":    return (a, b) => (a.title || "").localeCompare(b.title || "", "ja");
    case "title-desc":   return (a, b) => (b.title || "").localeCompare(a.title || "", "ja");
    case "artist-asc":   return (a, b) => (a.artist || "").localeCompare(b.artist || "", "ja");
    case "artist-desc":  return (a, b) => (b.artist || "").localeCompare(a.artist || "", "ja");
    case "playCount-desc": return (a, b) => (b.playCount || 0) - (a.playCount || 0);
    case "loved-desc":
      // Love されている曲を上に。Love 同士はタイトル昇順をタイブレーカに使う
      return (a, b) => {
        const la = !!a.loved, lb = !!b.loved;
        if (la !== lb) return Number(lb) - Number(la);
        return (a.title || "").localeCompare(b.title || "", "ja");
      };
    default:             return (a, b) => orderOf(a) - orderOf(b);
  }
}

/**
 * 手動並び替え用: order が無い旧データには addedAt をフォールバック
 */
function orderOf(t) {
  if (typeof t.order === "number") return t.order;
  return t.addedAt || 0;
}

/**
 * クリック委譲
 */
async function onListClick(e, refs) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) {
    // 行クリックで再生（ハンドル領域は除外）
    if (e.target.closest('[data-act="handle"]')) return;
    const row = e.target.closest(".track-row");
    if (row) {
      const id = row.dataset.id;
      const t = tracksCache.find((x) => x.id === id);
      if (t) await playEnabledFrom(t);
    }
    return;
  }
  const row = btn.closest(".track-row");
  const id = row && row.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  const t = tracksCache.find((x) => x.id === id);
  if (!t) return;

  if (act === "toggle") {
    // === iOS タップ反応性 (実機フィードバック対応) ===
    // 以前は await updateTrack の後に DOM を書き換えていたため、
    // IndexedDB 書き込み完了まで「タップしたのに何も起きない」ように見える
    // ケースがあった (ゴミ箱は confirm モーダルがすぐ出るので体感差があった)。
    // → DOM は同期的に即座に書き換え、DB は後追いで非同期に書く。
    //   失敗時のみロールバックして toast でユーザに通知する。
    const prev = (t.enabled !== false);
    const next = !prev;
    const row = btn.closest(".track-row");
    // 1) 楽観更新: DOM とキャッシュを先に書き換える
    t.enabled = next;
    if (row) {
      row.classList.toggle("is-disabled", !next);
      btn.textContent = next ? "🔊" : "🔇";
      btn.title = next ? "一時的に再生無効にする" : "再生を再び有効にする";
    }
    // 2) 再生中の曲を無効化したら即時停止
    if (!next && appState.get().currentTrack?.id === id) {
      stopPlayback();
      toast("再生中の曲を無効化したため停止しました", "info");
    }
    // 3) 「無効も表示」が OFF のときだけ、行を消すために再描画
    //    それ以外は DOM 直編集のみで十分 (余分な再描画でタップ列が壊れない)
    if (!next && !showDisabled) {
      renderList(refs);
    }
    // 4) DB 書き込みは非同期 (await しない)。同一曲の連続トグルは id 単位で直列化する。
    //    library-db の書き込みは一過性 abort 時にリトライ(最大 ~300ms 遅延)するため、直列化
    //    しないと「1回目のリトライが2回目より後に commit して古い値が確定する順序逆転」で
    //    DB と楽観更新 UI が乖離しうる。直列化により後発トグルは前の書き込み完了後に commit
    //    され、最後のトグル値に収束する。
    const runWrite = () => updateTrack(id, { enabled: next });
    const prevChain = enabledWriteChains.get(id) || Promise.resolve();
    // 前段の成否に関わらず次の書き込みを実行する(前段が失敗しても後発トグルは確定させる)。
    const myChain = prevChain.then(runWrite, runWrite);
    enabledWriteChains.set(id, myChain);
    myChain.then(
      () => { if (enabledWriteChains.get(id) === myChain) enabledWriteChains.delete(id); },
      (err) => {
        // 画面遷移後(unmount/別マウント)に失敗した場合は、文脈外のエラートーストや detached
        //   refs への renderList を避ける。今表示中のライブラリと異なる refs なら、自分の保留
        //   チェーンだけ片付けて静かに抜ける(書き込みは abort=未コミットで DB は旧値のまま、
        //   再マウント時の getAllTracks が正となるためロールバック描画は不要)。
        if (activeRefs !== refs) {
          if (enabledWriteChains.get(id) === myChain) enabledWriteChains.delete(id);
          return;
        }
        // 自分が最新の書き込みでなければ、後続トグルが状態を確定させるのでロールバックしない
        // (中間トグルの失敗で誤った「失敗」トーストやちらつきを出さない)。
        if (enabledWriteChains.get(id) !== myChain) return;
        enabledWriteChains.delete(id);
        console.warn("enabled 更新失敗", err);
        // ロールバック
        t.enabled = prev;
        const curRow = refs.list.querySelector(`.track-row[data-id="${cssEscape(id)}"]`);
        if (curRow) {
          curRow.classList.toggle("is-disabled", !prev);
          const tgl = curRow.querySelector('button[data-act="toggle"]');
          if (tgl) {
            tgl.textContent = prev ? "🔊" : "🔇";
            tgl.title = prev ? "一時的に再生無効にする" : "再生を再び有効にする";
          }
        } else {
          // 楽観更新後に再描画(例: 再生中曲の無効化→stopPlayback→currentTrack 購読で
          // renderList)が走り対象行が DOM から消えている場合は、行を直接戻せない。
          // ロールバック済みの tracksCache に合わせて一覧全体を描き直す。
          renderList(refs);
        }
        toast("再生有効/無効の切替に失敗しました", "err");
      }
    );
  } else if (act === "delete") {
    const yes = await confirm(`「${t.title || "(無題)"}」を削除しますか？`, { danger: true, okLabel: "削除" });
    if (yes) {
      // 現在再生中の曲を削除する場合は、まず再生を停止する
      if (appState.get().currentTrack?.id === id) {
        stopPlayback();
      }
      // 削除本体の失敗は握り潰さず通知する(他経路と同じ「意味あるメッセージで通知」方針)。
      //   失敗時は以降のカスケード除去/キャッシュ更新/成功トーストへ進まず、行は残したままにする。
      try {
        await deleteTrack(id);
      } catch (e) {
        console.warn("曲削除に失敗", e);
        toast("削除に失敗しました。もう一度お試しください", "err");
        return;
      }
      // 削除した曲に保留中の有効/無効トグル書き込みが残っていると、その後の遅延失敗で
      //   「切替に失敗」トーストが削除済み曲について誤表示される。保留チェーンを片付ける
      //   (in-flight Promise の失敗ハンドラは get(id)!==myChain で早期 return する)。
      enabledWriteChains.delete(id);
      // ★ プレイリストに残る孤児 trackId をカスケード削除する(曲数水増し/DB 肥大の防止)。
      //   ベストエフォート: 失敗してもトラック削除自体は成功扱いにする。
      await removeTrackFromAllPlaylists(id).catch((err) => console.warn("プレイリストからの除去失敗", err));
      releaseArtwork(id);
      tracksCache = tracksCache.filter((x) => x.id !== id);
      renderList(refs);
      // 削除は完了済み。ストレージ表示更新は副次的なので失敗しても握り潰し、
      // 削除成功の toast は必ず出す(未処理例外で toast が出ないのを防ぐ)。
      try { await refreshStorage(refs); } catch (e) { console.warn("削除後のストレージ表示更新に失敗", e); }
      toast("削除しました", "ok");
    }
  }
}

/* ============ 手動並び替え（Pointer Events 統一）============ */

/**
 * 並び替えハンドラを track-list に取り付ける
 *
 * Pointer Events は iOS Safari 13+ / Android Chrome / デスクトップで統一して
 * 扱えるので、これ一本でマウス・タッチの両方をカバーする。
 *
 * - pointerdown でハンドル要素ならドラッグ開始
 * - setPointerCapture で以降のイベントを必ず同じ要素で受ける（指が動いて
 *   他の要素に乗ってもイベントが取れる）
 * - touch-action: none をハンドル CSS に当てて、スクロール等のジェスチャ
 *   を抑止する（passive リスナでも preventDefault しなくて済む）
 */
function installReorder(refs) {
  const list = refs.list;
  if (!list) return () => {};

  // unmount で document リスナを外せるようにハンドラを束ねる
  const onListDown = (e) => onDragStart(e, refs);
  const onDocMove = (e) => onDragMove(e);
  const onDocEnd = () => onDragEnd(refs);
  list.addEventListener("pointerdown", onListDown);
  document.addEventListener("pointermove", onDocMove);
  document.addEventListener("pointerup", onDocEnd);
  document.addEventListener("pointercancel", onDocEnd);
  return () => {
    list.removeEventListener("pointerdown", onListDown);
    document.removeEventListener("pointermove", onDocMove);
    document.removeEventListener("pointerup", onDocEnd);
    document.removeEventListener("pointercancel", onDocEnd);
    // unmount 時にドラッグ中だった場合、行スタイルとプレースホルダを必ず復元する。
    // (画面遷移で pointerup が取りこぼされ、次回マウント時にハンドル等が
    //  見えなくなる症状の予防)
    resetDragState();
  };
}

/**
 * dragState を null に戻し、関連する DOM 残骸も掃除する
 */
function resetDragState() {
  if (!dragState) return;
  const { row, placeholder, handle, pointerId } = dragState;
  try { handle && handle.releasePointerCapture && handle.releasePointerCapture(pointerId); } catch {}
  if (row) {
    row.classList.remove("is-dragging");
    row.style.position = "";
    row.style.left = "";
    row.style.top = "";
    row.style.width = "";
    row.style.zIndex = "";
    row.style.pointerEvents = "";
  }
  if (placeholder && placeholder.parentNode) {
    // 行があるならプレースホルダの位置に戻してからプレースホルダ除去
    if (row && row.parentNode !== placeholder.parentNode) {
      placeholder.parentNode.insertBefore(row, placeholder);
    }
    placeholder.remove();
  }
  dragState = null;
}

function onDragStart(e, refs) {
  // 既にドラッグ進行中なら無視する。マルチタッチで2本目の指が別ハンドルを掴むと
  //   dragState が上書きされ、1本目の浮いた行とプレースホルダが DOM に取り残される。
  //   onDocEnd は pointerId 非依存で発火し dragState=null に戻すため、ここで弾いても
  //   デッドロックしない（リスト画面の onDragStart と同等の安全網）。
  if (dragState) return;
  // 手動ソート時のみ、かつフィルタ非適用時のみ並び替えを許可する。
  // (フィルタ中は rowHtml がハンドルを出さないが、念のためここでも弾く)
  if (sortKey !== "manual-asc" || filterText || !showDisabled) return;
  // 主ボタンのみ（マウス右クリック等を除外）
  if (e.button !== undefined && e.button !== 0) return;
  const handle = e.target.closest('[data-act="handle"]');
  if (!handle) return;
  const row = handle.closest(".track-row");
  if (!row) return;
  e.preventDefault();

  // setPointerCapture でこのポインタを handle が捕まえ続ける
  try { handle.setPointerCapture(e.pointerId); } catch {}

  const rect = row.getBoundingClientRect();
  dragState = {
    id: row.dataset.id,
    row,
    offsetY: e.clientY - rect.top,
    placeholder: null,
    initialIndex: Array.from(refs.list.children).indexOf(row),
    handle,
    pointerId: e.pointerId,
  };

  // プレースホルダ（行の隙間）を作る
  const ph = document.createElement("li");
  ph.className = "track-row drag-placeholder";
  ph.style.height = rect.height + "px";
  ph.style.border = "2px dashed var(--accent)";
  ph.style.background = "transparent";
  ph.style.borderRadius = "8px";
  row.parentNode.insertBefore(ph, row);
  dragState.placeholder = ph;

  // 行を「浮かせる」
  row.classList.add("is-dragging");
  row.style.position = "fixed";
  row.style.left = rect.left + "px";
  row.style.width = rect.width + "px";
  row.style.zIndex = "1000";
  row.style.pointerEvents = "none";
  moveRowTo(row, e.clientY, dragState.offsetY);
}

function onDragMove(e) {
  if (!dragState) return;
  // 関係ない pointer は無視
  if (dragState.pointerId !== undefined && e.pointerId !== dragState.pointerId) return;
  e.preventDefault();
  moveRowTo(dragState.row, e.clientY, dragState.offsetY);

  // プレースホルダの位置決定
  const list = dragState.placeholder.parentNode;
  const siblings = Array.from(list.children).filter(
    (c) => c !== dragState.row && c !== dragState.placeholder && c.classList.contains("track-row")
  );
  let inserted = false;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      list.insertBefore(dragState.placeholder, sib);
      inserted = true;
      break;
    }
  }
  if (!inserted) list.appendChild(dragState.placeholder);
}

function moveRowTo(row, clientY, offsetY) {
  row.style.top = (clientY - offsetY) + "px";
}

async function onDragEnd(refs) {
  if (!dragState) return;
  const { row, placeholder, id, initialIndex, handle, pointerId } = dragState;
  try { handle && handle.releasePointerCapture && handle.releasePointerCapture(pointerId); } catch {}

  // 行のスタイルをリセット
  row.classList.remove("is-dragging");
  row.style.position = "";
  row.style.left = "";
  row.style.top = "";
  row.style.width = "";
  row.style.zIndex = "";
  row.style.pointerEvents = "";
  // 行をプレースホルダの位置に戻し、プレースホルダを除去
  placeholder.parentNode.insertBefore(row, placeholder);
  placeholder.remove();

  // 新しい並びを取得し、order を割り当てて DB に保存
  const list = row.parentNode;
  const ids = Array.from(list.children)
    // placeholder も class "track-row" を持つが data-id を持たない。通常フローでは
    //   上で placeholder を除去済みだが、マルチタッチ残骸が紛れても order 再付与から
    //   除外する（undefined が ids に混じるのを防ぐ防御。リスト画面と同等）。
    .filter((c) => c.classList.contains("track-row") && c.dataset.id)
    .map((c) => c.dataset.id);

  dragState = null;

  const newIndex = ids.indexOf(id);
  if (newIndex === initialIndex) return;

  // 全行に対し新しい order を 1000 刻みで再付与し、変更分を【単一トランザクション】で一括保存する。
  //   件数ぶんの個別 tx だと iOS の一過性 abort で「どれか1件が失敗」しやすかったため、失敗機会を
  //   N→1 に減らし原子的(全件成功か全件未反映)にする。
  try {
    const entries = [];
    for (let i = 0; i < ids.length; i++) {
      const tid = ids[i];
      const newOrder = (i + 1) * 1000;
      const cached = tracksCache.find((t) => t.id === tid);
      if (cached && cached.order !== newOrder) entries.push([tid, newOrder]);
    }
    if (entries.length) await setTracksOrder(entries);
    // DB 反映(原子的)成功後に tracksCache の order もまとめて更新する。
    for (const [tid, newOrder] of entries) {
      const cached = tracksCache.find((t) => t.id === tid);
      if (cached) cached.order = newOrder;
    }
    toast("並び順を保存しました", "ok");
  } catch (e) {
    console.warn("並び順保存失敗", e);
    toast("並び順の保存に失敗しました", "err");
    // 単一 tx なので原子的に未反映だが、念のため DB から読み直して tracksCache を整合させ、
    // 以降の描画/再生キューが正しい順序になるようにする。
    try { tracksCache = await getAllTracks(); } catch {}
  }
  renderList(refs);
}

/**
 * 「画面に見えている並び」の有効曲をキューにして、選択曲から再生開始
 * - ソート/検索/フィルタを尊重する
 * - 一時的に再生無効になっている曲はそもそも再生対象外（toast で通知）
 */
async function playEnabledFrom(track) {
  if (track.enabled === false) {
    toast("この曲は再生無効に設定されています", "info");
    return;
  }
  // ライブラリからの再生はプレイリスト由来ではないのでコンテキストをクリア
  appState.set({ currentPlaylistId: null, currentPlaylistName: null });
  const enabled = visibleTracks.filter((t) => t.enabled !== false);
  const idx = enabled.findIndex((t) => t.id === track.id);
  if (idx < 0) {
    // フィルタ等で表示から外れている等の理由で見つからない場合は単曲再生
    await setQueueAndPlay([track], 0);
  } else {
    await setQueueAndPlay(enabled, idx);
  }
  go("player");
}

/* ============ 追加処理 ============ */

// bulk 操作(取込/再スキャン)中、追加・再スキャンボタンをまとめて無効化/復帰する。
// 実際の二重実行防止は bulkBusy が担保するが、rescanBtn だけ無効化して追加ボタンが
// 押せてしまう不整合を避けるための視覚フィードバック(.btn:disabled の CSS が効く)。
function setBulkButtonsDisabled(refs, disabled) {
  if (refs.addBtn) refs.addBtn.disabled = disabled;
  if (refs.addFolderBtn) refs.addFolderBtn.disabled = disabled;
  if (refs.rescanBtn) refs.rescanBtn.disabled = disabled;
}

async function onFiles(refs, fileList) {
  if (!fileList || !fileList.length) return;
  if (bulkBusy) { toast("他の処理が進行中です。完了をお待ちください", "info"); return; }
  const audio = Array.from(fileList).filter((f) => ALLOW_EXT.test(f.name));
  // ★ 0 バイトファイルは除外する。空ファイルは name|size|lastModified+末尾4KB が
  //   同一になりやすく、hashFile が衝突 → putTrack(upsert) で無言上書き(データ消失)
  //   を起こすため。再生もできないので取込前に弾く。
  const files = audio.filter((f) => f.size > 0);
  const skippedEmpty = audio.length - files.length;
  if (files.length === 0) {
    toast(audio.length === 0 ? "対応する音源ファイルがありません" : "0 バイトのファイルのみのため追加しませんでした", "err");
    return;
  }
  bulkBusy = true;
  setBulkButtonsDisabled(refs, true);
  toast(`${files.length} 件を追加中…`);
  // rescanMeta と同様、開始時点で「0 / N」を表示してから進めると進捗の起点が分かる。
  if (refs.rescanProgress) refs.rescanProgress.textContent = `追加中 0 / ${files.length}`;
  let added = 0, failed = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      // ★ 大量取込でも進捗が分かるよう、ファイルごとに進捗を表示する
      //   (開始トーストは数秒で消えるため、無反応に見えるのを防ぐ)。
      if (refs.rescanProgress) refs.rescanProgress.textContent = `追加中 ${i + 1} / ${files.length}`;
      try {
        await ingestFile(files[i]);
        added++;
      } catch (e) {
        failed++;
        console.warn("ingest 失敗", files[i].name, e);
      }
      // ★ 大量取込でメインスレッドを占有しないようファイルごとに event loop へ譲る
      //   (rescanMeta と同じ。タップ応答・ロック画面更新の遅延を防ぐ)。
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    // 例外/中断でも進捗表示・ボタン・busy フラグを必ず戻す
    bulkBusy = false;
    setBulkButtonsDisabled(refs, false);
    if (refs.rescanProgress) refs.rescanProgress.textContent = "";
  }
  const extra = skippedEmpty > 0 ? `（0 バイト ${skippedEmpty} 件をスキップ）` : "";
  // 取込後の一覧再読込はベストエフォート。成功/失敗を 1 つの toast にまとめ、
  // 「追加成功」と「再読込失敗」が別々に出てユーザを混乱させないようにする。
  // (追加自体は IDB に書けているが、失敗すると一覧/再生キューが古いまま=要再表示)
  // 後追いの一覧再読込は「いま表示中の画面(activeRefs)」へ反映する。取込中に別画面へ遷移して
  //   から戻った場合、捕捉した refs は旧マウントの detached DOM なので現在の画面に描画する。
  try {
    await reloadTracks(activeRefs || refs);
    await refreshStorage(activeRefs || refs);
    // 全件失敗(added===0)は容量不足等の要対処エラー。中立の info ではなく err で通知する
    //   (files.length>0 が保証済みのため added===0 のときは failed>0)。
    toast(
      added > 0 ? `${added} 件追加しました${extra}` : "追加に失敗しました（容量不足などの可能性があります）",
      added > 0 ? "ok" : "err"
    );
  } catch (e) {
    console.warn("取込後の一覧再読込に失敗", e);
    toast(
      added > 0
        ? `${added} 件追加しましたが一覧の更新に失敗しました。画面を開き直してください`
        : "追加に失敗しました（容量不足などの可能性があります）",
      "err"
    );
  }
}

/**
 * 単一ファイルをライブラリに登録
 */
async function ingestFile(file) {
  const meta = await extractMetadata(file);
  // duration が 0 なら <audio> で取り直す
  let duration = meta.duration;
  if (!duration || duration <= 0) {
    duration = await readDurationViaAudio(file);
  }
  const id = await hashFile(file);
  // ★ 既存レコードの再取込(同一 id)では、ユーザ管理項目を維持してデータ消失を防ぐ。
  //   フォルダ再選択等で過去に取り込んだ曲を再 ingest しても、再生回数・お気に入り・
  //   再生有効/無効・手動並び順(order)・追加日時を引き継ぐ(rescanMeta の「ユーザ管理項目は
  //   維持」方針に揃える)。メタ/duration/fileSize は新規パース結果で更新し、artworkBlob は
  //   新規取得できたときだけ差し替え、取れなければ既存を温存する(rescanMeta と同方針)。
  const existing = await getTrack(id);
  const track = {
    id,
    title: meta.title,
    artist: meta.artist,
    album: meta.album || "",
    albumArtist: meta.albumArtist || "",
    year: meta.year || "",
    genre: meta.genre || "",
    trackNo: meta.trackNo || "",
    // composer/discNo/bpm はパーサ拡張で追加された項目。従来 ingest 時に保存されず rescanMeta
    //   でしか入らなかったため、取込時にも保存する(他メタ項目と同様、再取込時は新規パース値を
    //   優先し、取れなければ既存値を温存して rescan 済みの値を putTrack の全置換で失わない)。
    composer: meta.composer || (existing && existing.composer) || "",
    discNo: meta.discNo || (existing && existing.discNo) || "",
    bpm: meta.bpm || (existing && existing.bpm) || "",
    duration: duration || 0,
    mime: meta.mime || mimeFromName(file.name),
    format: meta.format || formatFromName(file.name) || "unknown",
    addedAt: existing ? (existing.addedAt || Date.now()) : Date.now(),
    playCount: existing ? (existing.playCount || 0) : 0,
    lastPlayedAt: existing ? (existing.lastPlayedAt || 0) : 0,
    enabled: existing ? (existing.enabled !== false) : true,
    loved: existing ? !!existing.loved : false,
    fileSize: file.size,
    originalName: file.name,
    artworkBlob: meta.artworkBlob || (existing && existing.artworkBlob) || null,
  };
  // 手動並び順(order)は既存があれば維持する(orderOf は order 無→addedAt にフォールバック)。
  if (existing && typeof existing.order === "number") track.order = existing.order;
  await putTrack(track, file);
  // ★ 同一 id (同名・同サイズ・同更新日時) を再追加した場合、artwork-cache に
  //   旧 blob の URL がキャッシュされたままだと古いアートワークが表示される。
  //   新規 id なら no-op、再追加なら旧 URL を破棄して次の描画で再生成させる。
  releaseArtwork(id);
  return track;
}

/**
 * ファイル名 + サイズ + 更新日時 + 末尾4KBハッシュで一意ID（簡易、SHA-1ベース）
 */
async function hashFile(file) {
  const seed = `${file.name}|${file.size}|${file.lastModified || 0}`;
  // 末尾チャンクも含めて軽くハッシュ（同名同サイズ別ファイルの誤一致を抑える）
  const tail = file.size > 4096 ? file.slice(file.size - 4096) : file;
  const tailBuf = await tail.arrayBuffer();
  const seedBuf = new TextEncoder().encode(seed).buffer;
  const cat = new Uint8Array(seedBuf.byteLength + tailBuf.byteLength);
  cat.set(new Uint8Array(seedBuf), 0);
  cat.set(new Uint8Array(tailBuf), seedBuf.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", cat);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t-${hex.slice(0, 16)}`;
}

/* ============ ストレージ表示 ============ */

async function refreshStorage(refs) {
  const est = await getStorageEstimate();
  if (!est) return;
  const used = formatBytes(est.usage || 0);
  const quota = formatBytes(est.quota || 0);
  // ストレージ情報は storageInfo に保持し、libStats は常に
  // 「表示曲数 / 全曲数 + ストレージ」の統一フォーマットにする。
  // (renderList と refreshStorage が同じ要素を別フォーマットで上書きし、
  //  検索中の絞り込み件数が消える問題を防ぐ)
  storageInfo = ` / ストレージ ${used} / ${quota}`;
  // 表示は renderList に一任する(現在のフィルタで visibleTracks を再計算して
  // 「表示曲数 / 全曲数 + storageInfo」を書く)。直接 visibleTracks.length を読むと
  // renderList を経ずに呼ばれた場合に古い件数を表示する暗黙依存になるため避ける。
  renderList(refs);
}

/* ============ メタデータ再スキャン ============ */

/**
 * 保存済み全曲の Blob を再パースしてメタデータを更新する
 *   - title/artist/album/albumArtist/year/genre/trackNo に加えて
 *     新メタ (composer/discNo/bpm) を保存
 *   - enabled / loved / playCount / lastPlayedAt / addedAt / order は維持
 *   - artworkBlob は新規取得分があれば更新
 */
async function rescanMeta(refs) {
  // bulkBusy は confirm より先に確認する(取込中に確認ダイアログだけ出て弾く無駄を防ぐ)。
  if (bulkBusy) { toast("他の処理が進行中です。完了をお待ちください", "info"); return; }
  const yes = await confirm(
    "全曲のメタデータを再スキャンします。\n所要時間は曲数に比例します。続けますか？",
    { okLabel: "実行", danger: false }
  );
  if (!yes) return;
  // confirm の待機中に別の bulk 操作が始まっていないか再確認する。
  if (bulkBusy) { toast("他の処理が進行中です。完了をお待ちください", "info"); return; }
  bulkBusy = true;
  setBulkButtonsDisabled(refs, true);
  const all = tracksCache.slice();
  const total = all.length;
  let done = 0, updated = 0, failed = 0;
  // 進捗は onFiles の「追加中 N/M」と揃え、共有要素でどちらの処理中か分かるようにする。
  if (refs.rescanProgress) refs.rescanProgress.textContent = `再スキャン中 0 / ${total}`;
  try {
    for (const t of all) {
      try {
        const blob = await getBlob(t.id);
        if (!blob) { failed++; continue; }
        const file = new File([blob], t.originalName || (t.title || "audio") + "." + (t.format || ""), { type: t.mime || blob.type || "" });
        const meta = await extractMetadata(file);
        // メタ項目を上書き (ユーザ管理項目は維持)
        const patch = {
          title: meta.title || t.title,
          artist: meta.artist || t.artist,
          album: meta.album ?? t.album,
          albumArtist: meta.albumArtist ?? t.albumArtist,
          year: meta.year ?? t.year,
          genre: meta.genre ?? t.genre,
          trackNo: meta.trackNo ?? t.trackNo,
          composer: meta.composer ?? t.composer,
          discNo: meta.discNo ?? t.discNo,
          bpm: meta.bpm ?? t.bpm,
          duration: meta.duration || t.duration,
          mime: meta.mime || t.mime,
          format: meta.format || t.format,
        };
        if (meta.artworkBlob) patch.artworkBlob = meta.artworkBlob;
        await updateTrack(t.id, patch);
        Object.assign(t, patch);
        // ★ アートワークが更新された場合、artwork-cache の古い URL を破棄する。
        //   getArtworkUrl は track.id をキーに旧 blob の URL をキャッシュしている
        //   ため、解放しないと再スキャン後も古いアートワークが表示され続ける
        //   (次の描画で新しい artworkBlob から URL が再生成される)。
        if (meta.artworkBlob) releaseArtwork(t.id);
        updated++;
      } catch (e) {
        console.warn("rescan 失敗", t.id, e);
        failed++;
      } finally {
        done++;
        if (refs.rescanProgress) refs.rescanProgress.textContent = `再スキャン中 ${done} / ${total}`;
        // UI が固まらないように譲る
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    // 後追いの再読込は「いま表示中の画面(activeRefs)」へ反映する(取込/再スキャン中に別画面へ
    //   遷移してから戻った場合、捕捉した refs は旧マウントの detached DOM のため)。
    await reloadTracks(activeRefs || refs);
    await refreshStorage(activeRefs || refs); // 他経路(onFiles/delete/mount)と同様にストレージ表示も更新

    // ★ 再生中の曲が再スキャンで更新された場合、再生画面・ミニプレイヤーの
    //   表示 (タイトル・アーティスト・アートワーク) を新しいメタに更新する。
    //   appState.currentTrack を最新キャッシュの値で差し替えると、currentTrack
    //   購読側 (player/mini) が再描画し、新しい artwork URL を取り直す
    //   (releaseArtwork で旧 URL を revoke した影響もここで吸収される)。
    //   id は不変なので audio-engine の再生キューやデコードには影響しない。
    const curId = appState.get().currentTrack?.id;
    if (curId) {
      const fresh = tracksCache.find((x) => x.id === curId);
      if (fresh) {
        // ★ getArtworkUrl は id だけでキャッシュし blob 変更を検知しない。rescan 中の
        //   再描画で旧 blob から URL が再キャッシュされている可能性があるため、ここで
        //   明示的に解放してから currentTrack を差し替える。解放しないと appState.set
        //   しても画像が更新されない(キャッシュヒットで旧 URL が返り続ける)。
        releaseArtwork(curId);
        appState.set({ currentTrack: { ...fresh } });
      }
    }

    toast(`再スキャン完了: 成功 ${updated} / 失敗 ${failed}`, failed > 0 ? "info" : "ok");
  } catch (e) {
    // 主にループ後の reloadTracks/refreshStorage(getAllTracks 失敗等)を捕捉する。
    // 未処理例外にせず通知する(ループ本体は各曲の try/catch で個別に処理済み)。
    console.warn("再スキャン後処理に失敗", e);
    // ループ内で tracksCache のオブジェクトは Object.assign 済み(新メタを保持)。
    // reloadTracks が失敗して DOM 未更新でも、ここで再描画すれば新メタを反映できる。
    try { renderList(activeRefs || refs); } catch {}
    toast("一覧の再読込に失敗しました。画面を開き直してください", "err");
  } finally {
    // 例外/中断(reloadTracks の getAllTracks 失敗等)でもボタン・進捗表示・busy を
    // 必ず戻す。これをしないとボタンが disabled のまま固着し再実行できなくなる。
    setBulkButtonsDisabled(refs, false);
    if (refs.rescanProgress) refs.rescanProgress.textContent = "";
    bulkBusy = false;
  }
}

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
