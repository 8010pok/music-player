/**
 * Last.fm 統計 API ラッパ（読み取りのみ）
 *
 * - すべて api_key のみで呼べる（署名不要）
 * - 各エンドポイントの「ページネーション全件取得」と「最小限の正規化」を提供
 * - 重い集計（月別/年別/ヒートマップ/分布）は Web Worker 側で行う
 */

import { callGet } from "./api.js";
import { getAuth } from "./auth.js";

/**
 * 現在の API キーを取得（無ければ例外）
 */
async function requireKey() {
  const { apiKey } = await getAuth();
  if (!apiKey) throw new Error("API キーが設定されていません");
  return apiKey;
}

// 永続的 Last.fm エラーコード（リトライしても回復しないので即諦める）。
// stats-service.js の PERMANENT_LASTFM_ERROR_CODES と整合させること。
//   6=User not found, 10=Invalid API key, 26=Suspended API key ほか各種パラメータ/認証/権限エラー
//   ★ 8(Operation failed=backend一時失敗。公式 errorcodes は「Please try again」)・11・16・29 は一過性のため
//     含めない（指数バックオフ/レート待機で再試行する）。9(Invalid session key)は公式上は再試行可だが
//     要再認証で自動リトライでは復旧しないため便宜上ここに含める（scrobble.js と同方針）。
const PERMANENT_ERROR_CODES = new Set([2, 3, 4, 5, 6, 7, 9, 10, 13, 14, 17, 18, 26]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 単一 GET をリトライ付きで実行する。
 *
 * 全期間履歴の反復取得 (iterateAllRecentTracks) は数百〜数千ページに及ぶため、
 * 途中 1 ページでも一過性エラー (タイムアウト / 一時的 HTTP / レート制限) で例外に
 * なると、それまでの集計を全て捨てて中断してしまう（時間タブの集計が「少件数で
 * 集計完了」「発見の歴史が集計中のまま」になる原因）。各ページを個別にリトライして
 * 長い反復の堅牢性を上げる。方針は stats-service.js の withRetry と揃える。
 *
 *   - 永続エラー (ユーザ不在 / APIキー無効・停止等) は待つだけ無駄なので即 throw
 *   - レート制限 (code 29 / HTTP 429) は通常より十分長く待つ
 *   - それ以外は指数バックオフ (4s → 12s)。小ジッタで同時再試行の二次バーストを防ぐ
 *   - shouldAbort() が true を返したら待機・再試行を打ち切り即 throw
 *     (run 世代切替・キャンセル時に stale な反復を素早く畳んで無駄な API 呼び出しを止める)
 *
 * @param {() => boolean} [opts.shouldAbort] 中断判定
 */
async function callGetWithRetry(method, params, apiKey, { maxAttempts = 3, shouldAbort } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shouldAbort && shouldAbort()) throw new Error("aborted");
    try {
      return await callGet(method, params, apiKey);
    } catch (err) {
      lastError = err;
      if (err && PERMANENT_ERROR_CODES.has(err.code)) throw err; // 永続エラーは即中断
      if (attempt >= maxAttempts) break;
      const isRateLimit = !!(err && (err.code === 29 || err.httpStatus === 429));
      const delay = isRateLimit
        ? 30000 + Math.floor(Math.random() * 2000)                  // レート制限: ~30s
        : 4000 * Math.pow(3, attempt - 1) + Math.floor(Math.random() * 500); // 4s → 12s
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * ユーザ情報
 */
export async function getUserInfo(user) {
  const apiKey = await requireKey();
  const j = await callGet("user.getInfo", { user }, apiKey);
  return j.user || null;
}

/**
 * 最近聴いた曲（1ページ分）
 * @param {number} limit 1..200
 * @param {number} page  1始まり
 */
export async function getRecentTracks(user, { limit = 50, page = 1, from, to } = {}) {
  const apiKey = await requireKey();
  const params = { user, limit, page };
  if (from) params.from = from;
  if (to) params.to = to;
  const j = await callGet("user.getRecentTracks", params, apiKey);
  const list = j.recenttracks?.track || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * 指定期間の scrobble 件数だけを取得する（limit=1 で実トラックは引かず、
 * レスポンスの @attr.total だけを参照することで軽量に件数を得る）。
 *  @param {string} user
 *  @param {{from?: number, to?: number}} [opts] - unix 秒
 */
export async function getRecentTracksCount(user, { from, to } = {}) {
  const apiKey = await requireKey();
  const params = { user, limit: 1, page: 1 };
  if (from) params.from = from;
  if (to) params.to = to;
  const j = await callGet("user.getRecentTracks", params, apiKey);
  const meta = j.recenttracks?.["@attr"] || {};
  return parseInt(meta.total || "0", 10);
}

/**
 * 最近聴いた曲（全件取得をストリームで返す async iterator）
 *  - 大量データになり得るので呼び出し側でキャンセル可能にしておく
 */
export async function* iterateAllRecentTracks(user, { onProgress, shouldAbort } = {}) {
  const apiKey = await requireKey();
  let page = 1;
  while (true) {
    if (shouldAbort && shouldAbort()) return; // 世代切替・キャンセル時は即終了（部分集計扱い）
    // ★ 各ページをリトライ付きで取得する。1 ページの一過性エラーで全反復を捨てない。
    const j = await callGetWithRetry(
      "user.getRecentTracks",
      { user, limit: 200, page },
      apiKey,
      { maxAttempts: 3, shouldAbort }
    );
    const meta = j.recenttracks?.["@attr"] || {};
    const list = j.recenttracks?.track || [];
    const arr = Array.isArray(list) ? list : [list];
    for (const t of arr) yield t;
    const totalPages = parseInt(meta.totalPages || "0", 10);
    if (onProgress) onProgress({ page, totalPages });
    if (!totalPages || page >= totalPages) break;
    page++;
  }
}

/**
 * Top tracks / artists / albums
 * @param {"7day"|"1month"|"3month"|"6month"|"12month"|"overall"} period
 */
export async function getTopTracks(user, period = "overall", limit = 50) {
  const apiKey = await requireKey();
  const j = await callGet("user.getTopTracks", { user, period, limit }, apiKey);
  const list = j.toptracks?.track || [];
  return Array.isArray(list) ? list : [list];
}

export async function getTopArtists(user, period = "overall", limit = 50) {
  const apiKey = await requireKey();
  const j = await callGet("user.getTopArtists", { user, period, limit }, apiKey);
  const list = j.topartists?.artist || [];
  return Array.isArray(list) ? list : [list];
}

export async function getTopAlbums(user, period = "overall", limit = 50) {
  const apiKey = await requireKey();
  const j = await callGet("user.getTopAlbums", { user, period, limit }, apiKey);
  const list = j.topalbums?.album || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * 週次チャート利用可能期間リスト
 *   { from, to } のペアが新しいもの順 (Last.fm 仕様で逆順) で並ぶ。
 *   各 from/to は unix 秒 (文字列)。
 */
export async function getWeeklyChartList(user) {
  const apiKey = await requireKey();
  const j = await callGet("user.getWeeklyChartList", { user }, apiKey);
  const list = j.weeklychartlist?.chart || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((c) => ({ from: parseInt(c.from, 10), to: parseInt(c.to, 10) }));
}

/**
 * 指定週のアーティストチャート
 */
export async function getWeeklyArtistChart(user, from, to) {
  const apiKey = await requireKey();
  const j = await callGet("user.getWeeklyArtistChart", { user, from, to }, apiKey);
  const list = j.weeklyartistchart?.artist || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * 指定週のアルバムチャート
 */
export async function getWeeklyAlbumChart(user, from, to) {
  const apiKey = await requireKey();
  const j = await callGet("user.getWeeklyAlbumChart", { user, from, to }, apiKey);
  const list = j.weeklyalbumchart?.album || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * 指定週のトラックチャート
 */
export async function getWeeklyTrackChart(user, from, to) {
  const apiKey = await requireKey();
  const j = await callGet("user.getWeeklyTrackChart", { user, from, to }, apiKey);
  const list = j.weeklytrackchart?.track || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * Loved tracks
 */
export async function getLovedTracks(user, { limit = 50, page = 1 } = {}) {
  const apiKey = await requireKey();
  const j = await callGet("user.getLovedTracks", { user, limit, page }, apiKey);
  const list = j.lovedtracks?.track || [];
  const meta = j.lovedtracks?.["@attr"] || {};
  return {
    list: Array.isArray(list) ? list : [list],
    totalPages: parseInt(meta.totalPages || "0", 10),
    total: parseInt(meta.total || "0", 10),
  };
}

/**
 * 似たアーティストを取得 (artist.getSimilar)
 *   @param {string} artist
 *   @param {number} limit
 */
export async function getSimilarArtists(artist, limit = 10) {
  const apiKey = await requireKey();
  const j = await callGet("artist.getSimilar", { artist, limit, autocorrect: 1 }, apiKey);
  const list = j.similarartists?.artist || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * 似たトラックを取得 (track.getSimilar)
 */
export async function getSimilarTracks(artist, track, limit = 10) {
  const apiKey = await requireKey();
  const j = await callGet("track.getSimilar", { artist, track, limit, autocorrect: 1 }, apiKey);
  const list = j.similartracks?.track || [];
  return Array.isArray(list) ? list : [list];
}

/* ============ 統計拡張用の追加ラッパ（すべて API キーのみで可・読み取り専用） ============ */

/**
 * 世界チャートのトップアーティスト (chart.getTopArtists)
 *   ユーザ非依存のグローバルデータ。メインストリーム度の算出に使う。
 */
export async function getChartTopArtists(limit = 100) {
  const apiKey = await requireKey();
  const j = await callGet("chart.getTopArtists", { limit }, apiKey);
  const list = j.artists?.artist || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * 国別チャートのトップアーティスト (geo.getTopArtists)
 *   @param {string} country - ISO 3166-1 の英語国名 (例 "Japan", "United States")
 */
export async function getGeoTopArtists(country, limit = 50) {
  const apiKey = await requireKey();
  const j = await callGet("geo.getTopArtists", { country, limit }, apiKey);
  const list = j.topartists?.artist || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * アーティストの人気タグ (artist.getTopTags)
 *   ジャンル DNA(タグ分布)の材料。count は 0-100 の相対値。
 */
export async function getArtistTopTags(artist) {
  const apiKey = await requireKey();
  const j = await callGet("artist.getTopTags", { artist, autocorrect: 1 }, apiKey);
  const list = j.toptags?.tag || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * アーティスト詳細 (artist.getInfo)
 *   - username 指定でそのユーザの再生数 (stats.userplaycount) が付く
 *   - lang=ja で bio が日本語の場合は日本語で返る
 *   - ontour フラグで「ツアー中」を判定できる
 */
export async function getArtistInfo(artist, username) {
  const apiKey = await requireKey();
  const params = { artist, autocorrect: 1, lang: "ja" };
  if (username) params.username = username;
  const j = await callGet("artist.getInfo", params, apiKey);
  return j.artist || null;
}

/**
 * トラック詳細 (track.getInfo)
 *   - listeners / playcount は全世界の値
 *   - username 指定で userplaycount / userloved が付く
 */
export async function getTrackInfo(artist, track, username) {
  const apiKey = await requireKey();
  const params = { artist, track, autocorrect: 1 };
  if (username) params.username = username;
  const j = await callGet("track.getInfo", params, apiKey);
  return j.track || null;
}

/**
 * アルバム詳細 (album.getInfo)
 *   - tracks にトラックリスト(各曲 rank/duration 付き)が入る
 *   - username 指定でアルバムの userplaycount が付く
 */
export async function getAlbumInfo(artist, album, username) {
  const apiKey = await requireKey();
  const params = { artist, album, autocorrect: 1 };
  if (username) params.username = username;
  const j = await callGet("album.getInfo", params, apiKey);
  return j.album || null;
}

/**
 * タグ(ジャンル)別トップアーティスト (tag.getTopArtists)
 *   ジャンル踏破率の分母(そのジャンルの代表アーティスト)に使う。ユーザ非依存。
 */
export async function getTagTopArtists(tag, limit = 50) {
  const apiKey = await requireKey();
  const j = await callGet("tag.getTopArtists", { tag, limit }, apiKey);
  const list = j.topartists?.artist || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * フレンド一覧 (user.getFriends)
 *   recenttracks=1 で各フレンドの最近聴いた曲が付く。フレンド 0 人ではエラーに
 *   なる場合があるため呼び出し側で catch して非表示にする。
 */
export async function getFriends(user, { recenttracks = true, limit = 20 } = {}) {
  const apiKey = await requireKey();
  const params = { user, limit };
  if (recenttracks) params.recenttracks = 1;
  const j = await callGet("user.getFriends", params, apiKey);
  const list = j.friends?.user || [];
  return Array.isArray(list) ? list : [list];
}

/**
 * Last.fm の「画像なし」プレースホルダ URL を判定する。
 *
 * Last.fm は 2020年5月にアーティスト画像 API を廃止し、以降は実画像の代わりに
 * 共通の「星アイコン」プレースホルダ URL を返すようになった。
 * これを実画像として扱うとすべてのアーティスト行に同じ壊れた星アイコンが
 * 出てしまうため、空文字として扱う。
 */
function isLastfmPlaceholder(url) {
  if (!url) return true;
  // 2020 年以降の Last.fm 共通プレースホルダ画像のハッシュ
  return url.includes("2a96cbd8b46e442fc41c2b86b821562f");
}

/**
 * 画像の最大サイズ URL を抽出
 *   - Last.fm の placeholder URL は空文字として返す
 */
export function pickImage(images) {
  if (!images) return "";
  const arr = Array.isArray(images) ? images : [images];
  // size: small/medium/large/extralarge
  const priority = ["extralarge", "large", "medium", "small"];
  for (const p of priority) {
    const hit = arr.find((i) => i.size === p && i["#text"] && !isLastfmPlaceholder(i["#text"]));
    if (hit) return hit["#text"];
  }
  const first = arr[0]?.["#text"] || "";
  return isLastfmPlaceholder(first) ? "" : first;
}
