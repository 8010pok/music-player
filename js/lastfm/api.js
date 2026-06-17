/**
 * Last.fm API ラッパ
 *
 * - GET / POST 共通の署名・パラメータ整形
 * - 署名は MD5( キー名アルファベット順で連結した key+value ... + api_secret )
 * - 書込系 (track.scrobble, track.updateNowPlaying, track.love 等) は POST + 署名
 * - 読取系 (user.getInfo 等) は GET、api_key のみで可（署名不要）
 *
 * 参照: https://www.last.fm/api/authspec
 */

import { md5 } from "../store/crypto.js";

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

// 個別リクエストの最大待ち時間 (ミリ秒)。
// iOS の PWA バックグラウンドや Wi-Fi/セルラー切替で fetch がハングする
// ケースがあり、これがあると統計画面のタブが「取得中…」のまま完了しない。
// AbortController で強制中断することで、上位の withRetry が正しく retry でき、
// 最終的に .finally で markReady が確実に発火するようにする。
const DEFAULT_TIMEOUT_MS = 30000;

// ───────── 読取 GET 用のグローバルなレート制御（トークンバケット） ─────────
// Last.fm の公式な数値レート上限は非公開だが、コミュニティ/ToS の目安は ~5 req/s/IP。
// 統計画面のコールドロードは複数セクションが同時に多数の GET を撃つため（各セクション
// 内の mapPool/mapSequential では横断的なバーストを抑えきれない）、全 callGet 横断で
// 発火レートを物理的に上限化し、code 29 (Rate limit exceeded) や一時的 IP 制限を防ぐ。
// 署名付き POST（scrobble / now playing / auth）はリアルタイム性優先かつ低頻度なので
// このバケットを通さない（callGet 限定）。
const GET_RATE_CAPACITY = 5;        // バースト許容トークン数
const GET_RATE_REFILL_PER_SEC = 5;  // 毎秒の補充トークン数
let getRateTokens = GET_RATE_CAPACITY;
let getRateLastRefill = Date.now();

function refillGetTokens() {
  const now = Date.now();
  const elapsedSec = (now - getRateLastRefill) / 1000;
  if (elapsedSec > 0) {
    getRateTokens = Math.min(GET_RATE_CAPACITY, getRateTokens + elapsedSec * GET_RATE_REFILL_PER_SEC);
    getRateLastRefill = now;
  }
}

/**
 * GET 発火前に 1 トークンを取得する。トークンが無ければ補充されるまで待機する。
 * 中断シグナルが既に abort 済みなら待たずに通す（下流の fetchJson が即 abort する）。
 */
async function acquireGetToken(signal) {
  while (true) {
    if (signal && signal.aborted) return;
    refillGetTokens();
    if (getRateTokens >= 1) {
      getRateTokens -= 1;
      return;
    }
    // 次の 1 トークンが貯まるまでの概算待機（最低 20ms）。
    const waitMs = Math.max(20, Math.ceil(((1 - getRateTokens) / GET_RATE_REFILL_PER_SEC) * 1000));
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * fetch + JSON 読み取り を「単一のタイムアウト + 外部 AbortSignal」監視下で行う。
 *   ★ ボディ(res.json())読み取りも timer/signal の監視下に含める。fetch が resolve
 *     した後にボディが流れてこないハング(iOS バックグラウンド/回線切替)も timeout で
 *     中断できるようにする(以前は fetch 完了で clearTimeout していたため res.json() の
 *     ハングを検知できなかった = API-3)。
 */
async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timedOut = false;
  const externalSignal = options.signal;
  let externalListener = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      ctrl.abort();
    } else {
      externalListener = () => ctrl.abort();
      externalSignal.addEventListener("abort", externalListener, { once: true });
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return await parseResponse(res);
  } catch (err) {
    if (timedOut) {
      const e = new Error(`リクエストがタイムアウトしました (${Math.round(timeoutMs / 1000)}秒)`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal && externalListener) {
      externalSignal.removeEventListener("abort", externalListener);
    }
  }
}

/**
 * GET （読み取り。署名なし。api_key と format=json を付与）
 * @param {string} method  例 "user.getInfo"
 * @param {object} params
 * @param {string} apiKey
 */
export async function callGet(method, params, apiKey, { signal, timeoutMs } = {}) {
  if (!apiKey) throw new Error("API キーが設定されていません");
  // 全 GET 横断のレート制御。発火レートを ~5 req/s に均してバーストを防ぐ。
  await acquireGetToken(signal);
  const merged = { ...params, method, api_key: apiKey, format: "json" };
  const url = `${BASE_URL}?${buildQuery(merged)}`;
  // timeoutMs 省略時は fetchJson の既定値。軽量呼び出し(ライブ更新等)は短い値を指定可(API-2)。
  return fetchJson(url, { method: "GET", signal }, timeoutMs);
}

/**
 * POST （書き込み。署名必須）
 * @param {string} method
 * @param {object} params
 * @param {string} apiKey
 * @param {string} apiSecret
 * @param {string} [sessionKey]
 */
export async function callPost(method, params, apiKey, apiSecret, sessionKey) {
  if (!apiKey || !apiSecret) throw new Error("API キー/シークレットが設定されていません");
  const all = { ...params, method, api_key: apiKey };
  if (sessionKey) all.sk = sessionKey;
  all.api_sig = signParams(all, apiSecret);
  all.format = "json"; // 署名対象に含めない
  const body = buildQuery(all);
  return fetchJson(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

/**
 * 署名生成
 * - format 等を除外し、アルファベット順に key+value を連結
 * - 末尾に api_secret を付け MD5
 */
export function signParams(params, apiSecret) {
  const keys = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback" && params[k] != null && params[k] !== "")
    .sort();
  let s = "";
  for (const k of keys) s += k + params[k];
  s += apiSecret;
  return md5(s);
}

function buildQuery(obj) {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    // null / undefined / 空文字は送信しない:
    //   Last.fm API は空パラメータを「指定なし」と区別せず受け取るため、
    //   無駄な送信を避けて URL を短く保つ
    if (v == null || v === "") continue;
    out.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  return out.join("&");
}

async function parseResponse(res) {
  let json;
  try {
    json = await res.json();
  } catch (e) {
    // パース失敗(空ボディ/HTML/204 等)。上位(withRetry/トースト)が HTTP 状態で
    // 判定できるよう httpStatus を付与する(API-1)。
    const err = new Error(`Last.fm 応答が JSON ではありません: HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  if (json && json.error) {
    const err = new Error(`Last.fm エラー: ${json.error} ${json.message || ""}`);
    err.code = json.error;
    err.httpStatus = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Last.fm HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}
