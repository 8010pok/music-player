/**
 * スクロブル / Now Playing / Love
 *
 * - スクロブル条件は audio-engine 側で判定（公式仕様: 曲長が30秒超 & 再生が50% or 4分到達）
 * - 送信失敗時 / オフライン時は IndexedDB キューに積み、復帰時にフラッシュ
 * - キュー件数は appState.scrobbleQueueCount に保持し、UI 側（画面上部の
 *   ステータスピル、設定画面のキュー件数表示）が購読してリアルタイム同期する。
 *   refreshBadge() を呼ぶと count() → appState.set で全 UI が更新される。
 */

import { callPost } from "./api.js";
import { enqueue, peek, removeMany, count } from "../store/queue-db.js";
import { getAuth } from "./auth.js";
import { appState } from "../state.js";
import { toast } from "../ui/components.js";

const MAX_BATCH = 50;
let flushing = false;

/**
 * Last.fm の「リトライしても回復しない」永続的エラーコード。
 *
 * Last.fm 公式 errorcodes に基づく分類:
 *   - 一過性(再試行で回復しうる): 8 (Operation failed = backend 一時失敗。「Please try again」) /
 *     11 (Service Offline) / 16 (Temporary error) / 29 (Rate limit) → 永続セットに含めない。
 *   - 永続(リクエスト不備/認証/キー): 2,3,4,5,6,7,10,13,14,17,18,26 → 含める。
 *
 * code 9 (Invalid session key) は公式上は「リトライ可能」だが、再認証が
 * 必要なため自動リトライでは復旧しない。本アプリでは「即時中断 + ユーザに
 * 再認証を促す toast」を出すため、ここでは便宜的に永続扱いに含めている
 * (リトライしてもキューに残るだけで意味が無いため)。
 *
 * ※ code 8 は flushQueue では「一過性ネットワークエラーと同様: トーストを出さず break し
 *    キュー保持 → 次の online/起動で再送」となる(永続セットに無いため特定トースト分岐を通らない)。
 *
 * 各コードの意味:
 *   2  = Invalid service
 *   3  = Invalid Method
 *   4  = Authentication Failed
 *   5  = Invalid format
 *   6  = Invalid parameters / 必須パラメータ欠落 (公式: Invalid parameters。
 *         なお読取系 user.getInfo ではユーザ不在もこのコードで返るが、scrobble は
 *         sk でユーザを特定するため、この経路の 6 は送信データの不備を意味する)
 *   7  = Invalid resource specified
 *   8  = Operation failed (一過性=backend 一時失敗。永続セットには含めず再試行対象)
 *   9  = Invalid session key (公式: リトライ可だが要再認証)
 *   10 = Invalid API key
 *   13 = Invalid method signature
 *   14 = Token has not been authorized
 *   17 = Login: User requires to be logged in
 *   18 = Trial expired
 *   26 = Suspended API key
 */
const PERMANENT_LASTFM_ERROR_CODES = new Set([2, 3, 4, 5, 6, 7, 9, 10, 13, 14, 17, 18, 26]);

/**
 * Last.fm track.scrobble の ignoredMessage コード対応表
 * (https://www.last.fm/api/show/track.scrobble)
 *
 * Last.fm はリクエスト自体は受け付けるが、内容に問題があると個別の scrobble を
 * 「無視」し、レスポンスの ignoredMessage.code で理由を返す:
 *   1 = アーティスト名が無視された (Artist ignored)
 *   2 = トラック名が無視された (Track ignored)
 *   3 = タイムスタンプが古すぎる (Timestamp too old: 概ね 14 日以上前)
 *   4 = タイムスタンプが未来 (Timestamp too new)
 *   5 = 1 日のスクロブル上限超過 (Daily scrobble limit exceeded)
 */
const SCROBBLE_IGNORED_MESSAGES = {
  1: "アーティスト名が無視されました",
  2: "トラック名が無視されました",
  3: "タイムスタンプが古すぎます",
  4: "タイムスタンプが未来です",
  5: "1日のスクロブル上限に達しました",
};

/**
 * track.scrobble レスポンスから ignored 件数と理由を抽出する。
 *
 * レスポンス形式 (JSON, 単発スクロブル):
 *   { scrobbles: { @attr: { accepted, ignored }, scrobble: { ..., ignoredMessage: { code, #text } } } }
 *
 * レスポンス形式 (JSON, バッチ):
 *   { scrobbles: { @attr: {...}, scrobble: [ { ... }, ... ] } }
 *
 * 戻り値: null (ignored なし) or { accepted, ignored, reasons: string[] }
 */
function inspectScrobbleResponse(response) {
  const sc = response?.scrobbles;
  if (!sc) return null;
  const attr = sc["@attr"];
  const ignored = parseInt(attr?.ignored || "0", 10);
  const accepted = parseInt(attr?.accepted || "0", 10);
  if (!ignored) return null;
  // 単発: scrobble はオブジェクト、バッチ: 配列
  const items = Array.isArray(sc.scrobble) ? sc.scrobble : (sc.scrobble ? [sc.scrobble] : []);
  const reasons = [];
  for (const s of items) {
    const code = parseInt(s?.ignoredMessage?.code || "0", 10);
    if (code > 0) {
      reasons.push(SCROBBLE_IGNORED_MESSAGES[code] || `Last.fm エラー (code ${code})`);
    }
  }
  return { accepted, ignored, reasons };
}

/**
 * Now Playing を送信
 *
 * - Last.fm の updateNowPlaying は「リアルタイム再生中ステータス」なので、
 *   失敗してもキューに積まない（オフライン中は無意味なため）。
 * - navigator.onLine が false の場合は最初から送信しない（無駄な fetch
 *   を回避）。オンライン復帰時は installOnlineListener が再送信する。
 */
export async function sendNowPlaying(track) {
  if (!track) return;
  // オフライン時は黙ってスキップ
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const { apiKey, apiSecret, sessionKey } = await getAuth();
  if (!apiKey || !apiSecret || !sessionKey) return; // 認証なしは黙ってスキップ
  try {
    await callPost("track.updateNowPlaying", buildTrackParams(track), apiKey, apiSecret, sessionKey);
  } catch (e) {
    // 一過性なので失敗は無視
    console.warn("updateNowPlaying 失敗", e);
  }
}

/**
 * スクロブル送信（失敗時はキューへ）
 * @param {object} track
 * @param {number} _durationSec  実再生秒数（参考）
 * @param {number} [startedAtMs] 曲の再生開始時刻 (ms)。省略時は現在時刻
 * @returns {Promise<"sent" | "ignored" | "queued" | "failed" | "skipped">}
 *   - "sent":    Last.fm へ送信成功 (accepted)
 *   - "ignored": リクエストは成功したが Last.fm 側で拒否 (ignoredMessage)
 *   - "queued":  送信失敗（オフライン等）→ キューに登録、復帰時に flush
 *   - "failed":  送信もキュー保存も失敗（IDB エラー等の致命的状況）
 *   - "skipped": 未認証または track 不正で送信せず
 *
 * timestamp について:
 *   Last.fm 公式仕様 (https://www.last.fm/api/show/track.scrobble) では
 *   "UNIX timestamp format (integer number of seconds since 00:00:00,
 *   January 1st 1970 UTC)" で「曲の再生開始時刻」を指定するのが推奨。
 *   startedAtMs を渡せば曲の再生開始時刻が使われ、Last.fm 上のスクロブル
 *   時刻がユーザの体感と一致する。
 */
export async function sendScrobble(track, _durationSec, startedAtMs) {
  if (!track) return "skipped";
  // artist か曲名が空のスクロブルは Last.fm が必須項目欠落として無視する(記録されない)。
  // それを送信/キュー登録すると「無視 → キューから無言で削除(サイレント喪失)」や、
  // バッチ先頭に居座って後続を堰き止める原因になるため、送信前に弾いてキューを汚さない。
  if (!track.artist || !track.title) return "skipped";
  // timestamp は曲の再生開始時刻を優先。startedAtMs 未指定なら現在時刻にフォールバック
  const timestamp = startedAtMs
    ? Math.floor(startedAtMs / 1000)
    : Math.floor(Date.now() / 1000);
  const payload = {
    artist: track.artist || "",
    track: track.title || "",
    album: track.album || "",
    albumArtist: track.albumArtist || "",
    timestamp,
    duration: track.duration ? Math.floor(track.duration) : undefined,
    trackNumber: normalizeTrackNumber(track.trackNo),
  };

  const { apiKey, apiSecret, sessionKey } = await getAuth();
  if (!apiKey || !apiSecret || !sessionKey) {
    // 未認証時はキューに溜めない（混乱を避ける）
    return "skipped";
  }

  try {
    const res = await callPost("track.scrobble", flatten(payload), apiKey, apiSecret, sessionKey);
    // Last.fm はリクエストを受け付けても個別の scrobble を ignored にする
    // ことがあるため、レスポンスを必ず検査する (公式仕様の要請)
    const ignoredInfo = inspectScrobbleResponse(res);
    if (ignoredInfo) {
      console.warn("[scrobble] Last.fm に拒否されました", ignoredInfo);
      return "ignored";
    }
    return "sent";
  } catch (e) {
    console.warn("scrobble 失敗 → キューへ", e);
    try {
      await enqueue(payload);
      await refreshBadge();
      return "queued";
    } catch (qe) {
      console.warn("キュー保存も失敗", qe);
      return "failed";
    }
  }
}

/**
 * Love トグル
 * @returns {Promise<boolean>} 成功
 */
export async function setLoved(track, loved) {
  if (!track) return false;
  const { apiKey, apiSecret, sessionKey } = await getAuth();
  if (!apiKey || !apiSecret || !sessionKey) {
    throw new Error("Love にはフル認証が必要です");
  }
  const method = loved ? "track.love" : "track.unlove";
  await callPost(method, {
    artist: track.artist || "",
    track: track.title || "",
  }, apiKey, apiSecret, sessionKey);
  return true;
}

/**
 * オフラインキューを送信
 *
 * - キューが空になるまで MAX_BATCH 件ずつ繰り返し送信する。
 *   これにより 50 件以上のキューも 1 回の呼び出しで完全に消化できる。
 *   (旧実装は 1 回で MAX_BATCH 件だけ送信し、残りは次の online イベント
 *   まで待つ仕様だった)
 *
 * - エラー種別に応じてループ継続/中断を判定:
 *   - 永続的エラー (API キー無効、サスペンド等) → toast 通知して中断。
 *     キューは保持し、ユーザが認証情報を修正したら次回送信される。
 *   - 一過性エラー (ネットワーク、タイムアウト) → 中断するがキューは保持。
 *     次の online イベント or 起動時に再試行される。
 */
export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const { apiKey, apiSecret, sessionKey } = await getAuth();
    if (!apiKey || !apiSecret || !sessionKey) return;

    // 残件があれば繰り返し送信する
    // 永続エラー対策で「永続エラー検知 → break」も実装するため while で書く
    while (true) {
      const items = await peek(MAX_BATCH);
      if (items.length === 0) break;

      // バッチ送信用パラメータを構築（インデックス記法）
      const params = {};
      items.forEach((p, i) => {
        params[`artist[${i}]`] = p.artist || "";
        params[`track[${i}]`] = p.track || "";
        params[`timestamp[${i}]`] = String(p.timestamp || 0);
        if (p.album) params[`album[${i}]`] = p.album;
        if (p.albumArtist) params[`albumArtist[${i}]`] = p.albumArtist;
        if (p.duration) params[`duration[${i}]`] = String(p.duration);
        // 既にキューにある旧データが "5/12" 形式の trackNumber を持つ可能性があるため
        // 送信時にも整数へ正規化する（新規 enqueue 分は payload 構築時に正規化済み）。
        const tn = normalizeTrackNumber(p.trackNumber);
        if (tn) params[`trackNumber[${i}]`] = String(tn);
      });

      // ★ 送信(POST)とキュー削除(removeMany)を別 try に分ける。
      //   両者を同じ try に入れると、POST 成功後の IDB 削除失敗(tx abort 等)が
      //   catch(e) に落ち、e.code が undefined のため Last.fm エラー分類に
      //   巻き込まれて誤った判定/文言になる。送信成否と削除成否を分離する。
      let res;
      try {
        res = await callPost("track.scrobble", params, apiKey, apiSecret, sessionKey);
      } catch (e) {
        console.warn("バッチ送信失敗", e);
        // 永続エラーならユーザに通知してフラッシュを中断
        // (毎回 online のたびに toast が出ないよう、ここで明示的に break)
        if (e && PERMANENT_LASTFM_ERROR_CODES.has(e.code)) {
          if (e.code === 10) {
            toast("API キーが無効です。設定画面で確認してください。", "err");
          } else if (e.code === 26) {
            toast("API キーが Last.fm により停止されています。新しいキーを取得してください。", "err");
          } else if (e.code === 6) {
            // scrobble はセッションキー(sk)でユーザを特定するため、code 6 は
            // 「ユーザ不在」ではなく送信データ(artist/track/timestamp 等)の必須項目
            // 欠落を意味する(公式: Invalid parameters)。原因誤認を招かない文言にする。
            toast("スクロブルの送信データに不備があります（必須項目の欠落）。", "err");
          } else if (e.code === 9) {
            // 公式上は「リトライ可能」だが、セッションキーが失効しているので
            // 自動リトライでは復旧不能。ユーザに再認証を促す。
            toast("Last.fm のセッションが失効しました。設定画面で再認証してください。", "err");
          } else {
            toast(`スクロブル送信に失敗しました（コード ${e.code}）`, "err");
          }
        }
        // 一過性 / 永続いずれもキューは保持して中断
        break;
      }

      // ここに来たら POST は成功。Last.fm は受理済み（ignored 含め再送しても
      // 重複/再 ignored になるだけ）なのでキューから削除する。
      try {
        await removeMany(items.map((i) => i.id));
        await refreshBadge();
      } catch (de) {
        // 送信は成功したが IndexedDB 削除に失敗（tx abort / ストレージ逼迫等、稀）。
        // 「送信失敗」と誤分類せず明示的にログする。削除できなかったバッチは次回
        // flush で再送され得るが、timestamp+artist+track が同一のため Last.fm 側で
        // 重複排除される。同一バッチの即時再送ループを避けるため中断する。
        console.warn("[scrobble] 送信成功後のキュー削除に失敗（次回再送の可能性、稀）", de);
        break;
      }

      // ignored があればユーザに通知 (キューは既に削除済みなので情報のみ)
      const ignoredInfo = inspectScrobbleResponse(res);
      if (ignoredInfo && ignoredInfo.ignored > 0) {
        // 複数の拒否理由を重複排除して併記(1理由だけだと原因切り分けが難しいため)
        const reasons = [...new Set(ignoredInfo.reasons || [])].filter(Boolean);
        const reasonText = reasons.length ? reasons.join(" / ") : "詳細不明";
        toast(
          `${ignoredInfo.ignored} 件のスクロブルが Last.fm に拒否されました (${reasonText})`,
          "info"
        );
      }
      // 続行（次のバッチがあれば再送信）
    }
  } finally {
    flushing = false;
  }
}

/**
 * キュー件数を IndexedDB から読み直し、appState.scrobbleQueueCount に反映する。
 *
 * 名前は歴史的に「バッジ更新」だが、実際の表示更新は appState 購読側
 * （app.js のステータスピル、view-settings.js のキュー件数表示）に委譲して
 * いる。これにより、キュー操作（enqueue / removeMany / wipeQueue）後に
 * この関数を呼ぶだけで、画面上部バッジと設定画面の両方が同期する。
 *
 * 呼出箇所:
 *   - sendScrobble の enqueue 後
 *   - flushQueue の removeMany 後
 *   - view-settings.js の「破棄」ボタンの wipeQueue 後
 *   - app.js の起動シーケンス
 */
export async function refreshBadge() {
  try {
    const c = await count();
    appState.set({ scrobbleQueueCount: c });
  } catch {}
}

/**
 * ネット復帰イベントで自動フラッシュ + 現在曲の Now Playing 再送信
 *
 * - 500ms 遅延で flushQueue を実行（OS 側のネットワーク状態確定を待つ）
 * - 続けて現在再生中の曲があれば Now Playing を再送信
 *   (オフライン中は updateNowPlaying が失敗していたため、Last.fm 上の
 *   ステータスを最新化する。pause 中はステータスを上書きしないために
 *   isPlaying のときだけ送信)
 */
export function installOnlineListener() {
  window.addEventListener("online", () => {
    setTimeout(async () => {
      try { await flushQueue(); } catch {}
      try {
        const s = appState.get();
        if (s.currentTrack && s.isPlaying) {
          await sendNowPlaying(s.currentTrack);
        }
      } catch {}
    }, 500);
  });
}

/* ============ utility ============ */

function buildTrackParams(track) {
  return flatten({
    artist: track.artist || "",
    track: track.title || "",
    album: track.album || "",
    albumArtist: track.albumArtist || "",
    duration: track.duration ? Math.floor(track.duration) : undefined,
    trackNumber: normalizeTrackNumber(track.trackNo),
  });
}

/**
 * undefined と空文字("")を除外する。
 * album/albumArtist は呼出側で `|| ""` を付けて渡されるため、ここで空文字も
 * 除外することで「空の album/albumArtist を送信しない」ことが保証される(load-bearing)。
 */
function flatten(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== "") out[k] = obj[k];
  }
  return out;
}

/**
 * trackNumber を Last.fm 仕様（アルバム内の整数位置）に正規化する。
 *
 * メタデータパーサは "5/12"（トラック番号/総数）形式や非数値文字列を
 * track.trackNo に入れ得る（m4a の trkn、Vorbis/ID3 の TRACKNUMBER 等）。
 * Last.fm の trackNumber は "The position of the track on the album"＝整数を
 * 期待するため、スラッシュ前の主番号のみを整数として採用し、正の整数でなければ
 * undefined を返して送信パラメータから省く（flatten/buildQuery が undefined を除外）。
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function normalizeTrackNumber(raw) {
  if (raw == null) return undefined;
  const n = parseInt(String(raw).split("/")[0], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
