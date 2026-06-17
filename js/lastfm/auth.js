/**
 * Last.fm 認証フロー（Desktop Application 方式）
 *
 * Last.fm の認証には Web / Desktop / Mobile の 3 方式がある。
 *   - Web:     コールバック URL に Last.fm がトークンを redirect する（サーバ要）
 *   - Desktop: 先に auth.getToken でトークンを取得し、ユーザが認可後に手動で
 *              アプリへ戻る（コールバック不要）
 *   - Mobile:  ユーザ名＋パスワードを直接送る（本アプリでは採用しない＝非推奨）
 * 本アプリはサーバを持たない PWA でコールバックを受け取れないため、コールバック
 * 不要の Desktop Application 方式を採用する。
 *
 *   1) auth.getToken で token 取得（api_key + 署名）
 *   2) https://www.last.fm/api/auth/?api_key=...&token=... を別タブで開く
 *   3) ユーザが Last.fm 上で許可
 *   4) アプリに戻り「認可済みを反映」を押す
 *   5) auth.getSession(token) で session_key + name を取得
 *
 * 参照: https://www.last.fm/api/desktopauth/ , https://www.last.fm/api/authspec/
 */

import { callGet, callPost } from "./api.js";
import { getSecret, setSecret, setPublic, clearSecret } from "../store/settings.js";
import { appState } from "../state.js";

/**
 * トークン取得（要 apiKey + apiSecret）
 */
export async function fetchToken(apiKey, apiSecret) {
  // auth.getToken は署名要だが sk は不要
  const r = await callPost("auth.getToken", {}, apiKey, apiSecret);
  if (!r || !r.token) throw new Error("token が取得できません");
  return r.token;
}

/**
 * Last.fm の認可ページ URL
 */
export function buildAuthorizeUrl(apiKey, token) {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
}

/**
 * セッションキー取得（ユーザの認可後）
 */
export async function fetchSession(apiKey, apiSecret, token) {
  const r = await callPost("auth.getSession", { token }, apiKey, apiSecret);
  if (!r || !r.session || !r.session.key) {
    throw new Error("session_key が取得できません（認可が完了していない可能性）");
  }
  return { key: r.session.key, name: r.session.name };
}

/**
 * 認証フルフロー: token 発行 → 認可ページを開く → セッション取得 → 保存
 * UI からは「ステップ単位」で進行できるよう分解した方が良いので、ヘルパは
 * 「準備」と「セッション確定」の 2 段階に分けて提供する。
 */
export async function prepareAuthorization({ apiKey, apiSecret }) {
  // ★ ここではストレージに保存しない。
  //   理由: 読み取り専用モード（既存の apiKey）からフル認証へ移行する際、
  //   フル認証が完了する前に新 apiKey/apiSecret を保存してしまうと、
  //   ユーザがフル認証を中断・失敗した場合に「読み取り専用の元 apiKey が
  //   失われ」「中途半端な key-only 状態（新 apiKey + 旧 username）」に
  //   陥る。完了 (completeAuthorization) 時に apiKey/apiSecret/sessionKey
  //   をまとめて保存する設計に変更。
  //   apiKey/apiSecret は fetchToken の応答が成功している時点で正しい
  //   ことが保証されている（誤った値だと Last.fm がトークンを返さない）。
  const token = await fetchToken(apiKey, apiSecret);
  const url = buildAuthorizeUrl(apiKey, token);
  // ユーザに対し別タブで開かせる（ポップアップブロックを避けるため、UI 側で window.open する）
  return { token, authorizeUrl: url };
}

/**
 * 認可後に呼び出してセッション確定
 *   - apiKey / apiSecret / sessionKey をまとめて保存（アトミック）
 *   - 失敗時はストレージに何も書き込まないため、元の認証状態を保持する
 */
export async function completeAuthorization({ apiKey, apiSecret, token }) {
  const { key, name } = await fetchSession(apiKey, apiSecret, token);
  // ★ 3 つまとめて保存。setSecret は部分マージなので apiKey/apiSecret も
  //   ここで初めて書き込まれる（prepareAuthorization では保存していない）。
  await setSecret({ apiKey, apiSecret, sessionKey: key });
  setPublic({ username: name, authMode: "authenticated" });
  appState.set({ authState: "authenticated", username: name });
  return { sessionKey: key, username: name };
}

/**
 * 読み取り専用キー入力時の事前検証。
 *
 * 入力された apiKey と username の組合せが Last.fm 上で有効かを確認する。
 * 保存前に呼ぶことで、ユーザー名のスペルミスや API キー誤入力を即座に
 * 検出できる（保存してから統計画面で初めて気付くより UX が良い）。
 *
 * 成功時は { name, ... } の Last.fm user オブジェクトを返す（name は
 * Last.fm の正準表記なので、入力の大小文字を正してくれる効果もある）。
 *
 * 失敗時は例外を投げる:
 *   - code === 6:  指定ユーザーが Last.fm に存在しない
 *   - code === 10: API キーが無効
 *   - code === 26: API キーが Suspended
 *   - その他:      ネットワーク一時障害など
 */
export async function checkReadOnlyKey({ apiKey, username }) {
  if (!apiKey) throw new Error("API キーが空です");
  if (!username) throw new Error("ユーザー名が空です");
  const j = await callGet("user.getInfo", { user: username }, apiKey);
  if (!j || !j.user) throw new Error("ユーザー情報を取得できませんでした");
  return j.user;
}

/**
 * 読み取りのみのキー設定（API key だけ知っている場合）
 *  - 統計画面の閲覧などに使用可
 *  - scrobble はできない
 */
export async function setReadOnlyKey({ apiKey, username }) {
  await setSecret({ apiKey });
  setPublic({ username: username || null, authMode: "key-only" });
  appState.set({ authState: "key-only", username: username || null });
}

/**
 * ログアウト（全消去）
 */
export function signOut() {
  clearSecret();
  setPublic({ username: null, authMode: "anonymous" });
  appState.set({ authState: "anonymous", username: null });
}

/**
 * 起動時に現在の認証状態を読み込んで state に反映
 */
export async function bootstrapAuth() {
  const secret = await getSecret();
  if (!secret || !secret.apiKey) {
    appState.set({ authState: "anonymous", username: null });
    return { authState: "anonymous" };
  }
  if (secret.sessionKey) {
    // ユーザ名は public 側にある
    // ここで Last.fm に問い合わせて検証することもできるが、起動を速くするため省略
    appState.set({ authState: "authenticated" });
    return { authState: "authenticated" };
  }
  appState.set({ authState: "key-only" });
  return { authState: "key-only" };
}

/**
 * 現在の認証情報を返す（呼び出し側用ヘルパ）
 */
export async function getAuth() {
  const secret = (await getSecret()) || {};
  return {
    apiKey: secret.apiKey || null,
    apiSecret: secret.apiSecret || null,
    sessionKey: secret.sessionKey || null,
  };
}
