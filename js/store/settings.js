/**
 * 設定の永続化（localStorage + 暗号化）
 *
 * 秘匿情報（apiKey, apiSecret, sessionKey）は AES-256-GCM で暗号化保管。
 * 非秘匿（theme, enableAudioEffects 等）は平文 JSON で保管。
 */

import { encryptString, decryptString } from "./crypto.js";

const KEY_PUBLIC = "music-player.settings";
const KEY_SECRET = "music-player.secret";

const PUBLIC_DEFAULTS = {
  theme: "system",            // "system" | "dark" | "light"
  shuffleMode: false,
  repeatMode: "none",         // "none" | "one" | "all"
  enableAudioEffects: false,  // iOS バックグラウンド再生と非互換のためデフォルトOFF
  // 10 バンドグラフィック EQ ゲイン (dB)
  eqGains: { 31: 0, 62: 0, 125: 0, 250: 0, 500: 0, 1000: 0, 2000: 0, 4000: 0, 8000: 0, 16000: 0 },
  eqPreset: "flat",           // 現在のプリセット名
  preamp: 0,                  // プリアンプ (dB, -12〜+6)
  bassBoost: 0,               // 低音ブースト (dB, 0〜+12)
  compressor: "off",          // "off" | "soft" | "medium" | "hard"
  pan: 0,                     // 左右バランス (-1〜+1)
  stereoWidth: 1,             // ステレオ幅 (0〜2)
  vocalRemove: 0,             // ヴォーカル除去 (0〜1)
  mono: false,                // モノラル化
  noiseReduction: "off",      // "off" | "weak" | "medium" | "strong"
  audioOutputDeviceId: "",    // 出力デバイス (Androidのみ)
  playbackRate: 1.0,          // 再生速度 (0.5〜2.0, AudioContext不要)
  preservesPitch: true,       // 再生速度変更時にピッチを維持
  volume: 1.0,
  username: null,             // Last.fm のユーザ名（公開情報なので暗号化不要）
  authMode: "anonymous",      // "anonymous" | "key-only" | "authenticated"
  // === Last.fm フル認証時の送信トグル（デフォルト両方ON） ===
  scrobbleEnabled: true,      // スクロブルを Last.fm に送信するか
  nowPlayingEnabled: true,    // Now Playing 通知を Last.fm に送信するか
  // === Google Drive 連携 ===
  gdriveClientId: "",         // Google OAuth Client ID
  gdriveAutoCache: true,      // 再生時に自動でローカル IndexedDB にキャッシュ
  gdriveUserEmail: "",        // 連携中アカウントのメール/表示名
  gdriveTokenExpiry: 0,       // トークン有効期限タイムスタンプ
};

const SECRET_KEYS = ["apiKey", "apiSecret", "sessionKey", "gdriveAccessToken"];

/**
 * 公開設定の取得
 *
 * 破損レコードを検出した場合は localStorage から削除する。
 * 旧バージョンのバグや手動編集等で JSON が壊れた場合、毎回起動で
 * 同じパースエラーが発生し続けるのを防ぐため。
 */
export function getPublic() {
  const raw = localStorage.getItem(KEY_PUBLIC);
  if (!raw) return { ...PUBLIC_DEFAULTS };
  try {
    return { ...PUBLIC_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    console.warn("[settings] 公開設定のパース失敗、破損レコードを削除します", e);
    try { localStorage.removeItem(KEY_PUBLIC); } catch {}
    return { ...PUBLIC_DEFAULTS };
  }
}

/**
 * 公開設定の保存（部分更新）
 */
export function setPublic(patch) {
  const cur = getPublic();
  const next = { ...cur, ...patch };
  localStorage.setItem(KEY_PUBLIC, JSON.stringify(next));
  return next;
}

/**
 * 秘匿情報を取得（復号）
 * 端末固有鍵で復号できない場合は null
 */
export async function getSecret() {
  const raw = localStorage.getItem(KEY_SECRET);
  if (!raw) return null;
  try {
    const json = await decryptString(raw);
    return JSON.parse(json);
  } catch (err) {
    console.warn("秘匿情報の復号に失敗:", err);
    // ★ ここで clearSecret() しない。端末固有鍵は揮発的な属性(言語/解像度/TZ 等)にも依存するため、
    //   一時的な変化(外部モニタ接続・旅行先での言語/TZ 切替 等)でも復号が失敗しうる。即削除すると
    //   その一時変化だけで資格情報が恒久消失し再認証を強いるが、暗号文を残せば属性が元に戻った次回起動で
    //   自動復旧できる。null 返却中は anonymous 扱いで、再認証成功時の setSecret が record を全置換するため
    //   (getSecret=null → cur={} から書き直す)孤児蓄積や read-modify-write の取りこぼしも起きない。
    //   恒久的な変化(UA 更新等)で復号不能のまま残る暗号文は localStorage 1 レコードのみで無害、
    //   再認証時に上書きされる。明示削除は signOut()/全データ消去に委ねる。
    return null;
  }
}

/**
 * 秘匿情報を保存（部分更新）
 * @param {Partial<{apiKey: string, apiSecret: string, sessionKey: string}>} patch
 */
export async function setSecret(patch) {
  const cur = (await getSecret()) || {};
  const next = { ...cur };
  for (const k of SECRET_KEYS) {
    if (k in patch) next[k] = patch[k];
  }
  const json = JSON.stringify(next);
  const enc = await encryptString(json);
  localStorage.setItem(KEY_SECRET, enc);
  return next;
}

/**
 * 秘匿情報全消去
 */
export function clearSecret() {
  localStorage.removeItem(KEY_SECRET);
}

/**
 * 公開設定全消去
 */
export function clearPublic() {
  localStorage.removeItem(KEY_PUBLIC);
}

/**
 * 認証モードを判定
 *   apiKey が無い → anonymous
 *   apiKey のみ   → key-only
 *   sessionKey 有 → authenticated
 */
export function classifyAuth(secret) {
  if (!secret || !secret.apiKey) return "anonymous";
  if (secret.sessionKey) return "authenticated";
  return "key-only";
}
