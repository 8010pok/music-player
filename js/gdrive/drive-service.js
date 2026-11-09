/**
 * Google Drive 連携サービス
 *
 * - Google Drive API v3 を使用した音源ファイルの検索・ダウンロード
 * - GIS (Google Identity Services) トークンフローおよび直接アクセストークン入力のサポート
 * - 音源のローカル IndexedDB への事前キャッシュ、または再生時オンデマンド取得
 * - ローカル音源と同一のデータ構造（id: "gd-${fileId}", source: "gdrive"）でライブラリに統合
 */

import { getPublic, setPublic, getSecret, setSecret } from "../store/settings.js";
import { putTrack, getTrack, getAllTracks, deleteCachedBlob } from "../store/library-db.js";
import { extractMetadata, readDurationViaAudio } from "../metadata/index.js";
import { formatFromName, mimeFromName } from "../metadata/util.js";
import { openModal, toast, escapeHtml, escapeAttr } from "../ui/components.js";
import { processAudioNormalization } from "../audio/normalize-service.js";
import { isPlaceholderArtist, parseArtistAndTitle } from "../lastfm/scrobble-cleaner.js";
import { removeTombstone, isTombstoned } from "../store/tombstone.js";
import { getAlbumKey, getAlbumArtist } from "../metadata/album-util.js";

const MAX_DIAGNOSES = 50;
const _importAlbumDiagnoses = [];

/**
 * 直近のアルバム分類診断情報（最大50件）を取得
 * @returns {Array<object>}
 */
export function getRecentImportAlbumDiagnoses() {
  return [..._importAlbumDiagnoses];
}

/**
 * アルバム分類診断情報をクリア（テスト・検証用）
 */
export function clearImportAlbumDiagnoses() {
  _importAlbumDiagnoses.length = 0;
}

let _cachedToken = null;
let _gisTokenClient = null;

/**
 * トラック ID が Google Drive 音源か判定
 * @param {string} id
 * @returns {boolean}
 */
export function isDriveTrackId(id) {
  return typeof id === "string" && id.startsWith("gd-");
}

/**
 * トラックまたはトラックIDが Google Drive 音源か判定（source, driveFileId, gd- プレフィックスを全考慮）
 * @param {object|string} track
 * @returns {boolean}
 */
export function isDriveTrack(track) {
  if (!track) return false;
  if (typeof track === "object") {
    if (track.source === "gdrive") return true;
    if (Boolean(track.driveFileId)) return true;
    if (typeof track.id === "string" && track.id.startsWith("gd-")) return true;
    return false;
  }
  return typeof track === "string" && track.startsWith("gd-");
}

/**
 * トラックまたはトラックIDから Google Drive fileId を抽出
 * 優先順位:
 * 1. track.driveFileId
 * 2. Drive専用の保存済みfile ID (gdriveFileId, fileId)
 * 3. track.id が gd- で始まる場合のみ gd- を除去
 * 4. ファイル名やTrack IDを推測しない (推測不能時は null)
 * @param {object|string} track
 * @returns {string|null}
 */
export function resolveDriveFileId(track) {
  if (!track) return null;
  let raw = null;
  if (typeof track === "object") {
    if (typeof track.driveFileId === "string" && track.driveFileId.trim()) {
      raw = track.driveFileId.trim();
    } else if (typeof track.gdriveFileId === "string" && track.gdriveFileId.trim()) {
      raw = track.gdriveFileId.trim();
    } else if (typeof track.fileId === "string" && track.fileId.trim() && !track.fileId.includes("/")) {
      raw = track.fileId.trim();
    } else if (typeof track.id === "string" && track.id.startsWith("gd-")) {
      raw = track.id.slice(3).trim();
    }
  } else if (typeof track === "string") {
    const s = track.trim();
    if (s.startsWith("gd-")) {
      raw = s.slice(3).trim();
    }
  }
  if (!raw) return null;
  raw = raw.replace(/^["']|["']$/g, "").trim();
  while (raw.startsWith("gd-")) {
    raw = raw.slice(3).trim();
  }
  if (raw === "undefined" || raw === "null" || raw === "") {
    return null;
  }
  return raw;
}

export function getDriveFileId(track) {
  return resolveDriveFileId(track);
}

/**
 * トラック ID から Google Drive fileId を抽出
 * @param {string} id
 * @returns {string}
 */
export function driveFileIdFromTrackId(id) {
  return isDriveTrackId(id) ? id.slice(3) : id;
}

/**
 * Google Drive fileId からトラック ID を生成
 * @param {string} fileId
 * @returns {string}
 */
export function trackIdFromDriveFileId(fileId) {
  return `gd-${fileId}`;
}

/**
 * 保存されたアクセストークンを取得
 * @returns {Promise<string|null>}
 */
let _refreshingPromise = null;

function getLocalStorageToken() {
  if (typeof localStorage === "undefined") return null;
  try {
    const token = localStorage.getItem("gdrive_access_token");
    const expiry = parseInt(localStorage.getItem("gdrive_token_expiry") || "0", 10);
    return { token, expiry };
  } catch {
    return null;
  }
}

function setLocalStorageToken(token, expiry) {
  if (typeof localStorage === "undefined") return;
  try {
    if (token) {
      localStorage.setItem("gdrive_access_token", token);
      localStorage.setItem("gdrive_token_expiry", String(expiry));
    } else {
      localStorage.removeItem("gdrive_access_token");
      localStorage.removeItem("gdrive_token_expiry");
    }
  } catch {}
}

/**
 * 保存されたアクセストークンを取得（有効期限切れ時は自動サイレントリフレッシュ）
 * @param {{ forceRefresh?: boolean, allowSilentRefresh?: boolean }} [opts]
 * @returns {Promise<string|null>}
 */
export async function getDriveToken({ forceRefresh = false, allowSilentRefresh = true } = {}) {
  const pub = getPublic() || {};
  const now = Date.now();
  // 有効期限の3分前（180秒前）から早めにリフレッシュを試みることで再生中の401切れを防ぐ
  const EXPIRY_MARGIN_MS = 180000;

  if (!forceRefresh) {
    // 1. メモリキャッシュが有効
    if (_cachedToken) {
      if (!pub.gdriveTokenExpiry || now < pub.gdriveTokenExpiry - EXPIRY_MARGIN_MS) {
        return _cachedToken;
      }
    }

    // 2. localStorage からの即時参照
    const ls = getLocalStorageToken();
    if (ls && ls.token && (!ls.expiry || now < ls.expiry - EXPIRY_MARGIN_MS)) {
      _cachedToken = ls.token;
      return ls.token;
    }

    // 3. settings (IndexedDB) から参照
    const secret = await getSecret();
    const token = secret && secret.gdriveAccessToken ? secret.gdriveAccessToken : null;
    if (token && (!pub.gdriveTokenExpiry || now < pub.gdriveTokenExpiry - EXPIRY_MARGIN_MS)) {
      _cachedToken = token;
      setLocalStorageToken(token, pub.gdriveTokenExpiry || 0);
      return token;
    }
  } else {
    _cachedToken = null;
    setLocalStorageToken(null, 0);
  }

  // ★ 明示的に接続されたアカウント識別子（メールまたは表示名）が存在しない場合は、
  //    prompt: "" のサイレント更新でブラウザのデフォルト別アカウントへ自動接続されるのを防ぐため実行しない。
  const hasConnectedAccountIdentity = Boolean(
    (pub.gdriveUserEmail && String(pub.gdriveUserEmail).trim()) ||
    (pub.gdriveUserDisplayName && String(pub.gdriveUserDisplayName).trim())
  );
  if (!allowSilentRefresh || !hasConnectedAccountIdentity) {
    recordTokenResolution(!allowSilentRefresh ? "refresh_not_allowed" : "no_identity", pub);
    return null;
  }

  // 4. 有効期限切れ（または forceRefresh）かつ接続アカウントが確定済みの場合のみ自動サイレントリフレッシュを試行
  if (_refreshingPromise) return _refreshingPromise;

  const clientId = pub.gdriveClientId;
  if (clientId && typeof window !== "undefined") {
    _refreshingPromise = (async () => {
      try {
        const refreshedToken = await silentRefreshGisToken(clientId);
        if (refreshedToken) {
          _cachedToken = refreshedToken;
          recordTokenResolution("silent_refresh_success", pub);
          return refreshedToken;
        }
      } catch (e) {
        console.warn("[drive-service] サイレントリフレッシュ失敗:", e);
        _lastSilentRefreshFailure = { at: Date.now(), error: e?.message || String(e) };
        recordTokenResolution("silent_refresh_failed", pub);
      } finally {
        _refreshingPromise = null;
      }
      // 期限切れトークンは返さず null を返す（401 ループを防止し、必要なら再連携モーダルへ誘導）
      recordTokenResolution("silent_refresh_null", pub);
      return null;
    })();
    return _refreshingPromise;
  }

  recordTokenResolution("no_client_id", pub);
  return null;
}

/**
 * アクセストークンを保存（IndexedDB + localStorage 永続化）
 * @param {string} token
 * @param {{ expiresIn?: number, email?: string, displayName?: string }} [opts]
 */
export async function setDriveToken(token, { expiresIn = 3600, email, displayName } = {}) {
  const pub = getPublic() || {};
  const prevToken = _cachedToken;
  _cachedToken = token || null;
  const now = Date.now();
  const expiry = token && expiresIn ? now + expiresIn * 1000 : 0;
  const acquiredAt = token ? now : 0;
  _tokenAcquiredAt = acquiredAt;
  setLocalStorageToken(token, expiry);
  await setSecret({ gdriveAccessToken: token || "" });
  const patch = {
    gdriveTokenExpiry: expiry,
    gdriveTokenAcquiredAt: acquiredAt,
  };
  // ★ email / displayName が明示的に指定された場合のみ更新する（サイレントリフレッシュ時に既存の値を空文字で消さない）
  if (typeof email === "string" && email.trim().length > 0) {
    patch.gdriveUserEmail = email.trim();
  }
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    patch.gdriveUserDisplayName = displayName.trim();
  }
  const nextPub = setPublic(patch);
  if (token && nextPub.driveProxyStreamEnabled) {
    ensureDriveStreamSession(token, { force: token !== prevToken }).catch(() => {});
  }
}

/**
 * トークンのみをクリア（Client ID やユーザーメールアドレスは保持し、再連携時に前回アカウントを表示可能にする）
 */
export async function clearExpiredDriveToken() {
  clearDriveStreamSession().catch(() => {});
  _cachedToken = null;
  setLocalStorageToken(null, 0);
  await setSecret({ gdriveAccessToken: "" });
  setPublic({
    gdriveTokenExpiry: 0,
  });
}

/**
 * Google Drive 連携を明示的に切断（設定画面の「Drive連携を解除」ボタン用）
 * ※ 既存ライブラリのローカルデータや旧アカウント由来の登録曲データは削除しない
 */
export async function disconnectDrive() {
  clearDriveStreamSession().catch(() => {});
  _cachedToken = null;
  setLocalStorageToken(null, 0);
  await setSecret({ gdriveAccessToken: "" });
  setPublic({
    gdriveTokenExpiry: 0,
    gdriveUserEmail: "",
    gdriveUserDisplayName: "",
  });
}

/**
 * 現在の Google Drive アカウント接続状態と識別情報を取得する
 * @returns {Promise<{ connected: boolean, status: "connected"|"expired"|"disconnected", email: string, displayName: string, accountLabel: string, tokenExpiry: number }>}
 */
export async function getDriveAccountInfo() {
  const pub = getPublic() || {};
  const token = await getDriveToken({ allowSilentRefresh: false });
  const email = (pub.gdriveUserEmail || "").trim();
  const displayName = (pub.gdriveUserDisplayName || "").trim();
  const accountLabel = email || displayName || "";
  const connected = !!token;
  let status = "disconnected";
  if (connected) {
    status = "connected";
  } else if (accountLabel || pub.gdriveTokenExpiry > 0) {
    status = "expired";
  }
  return {
    connected,
    status,
    email,
    displayName,
    accountLabel,
    tokenExpiry: Number(pub.gdriveTokenExpiry) || 0,
  };
}

// 画面復帰時（バックグラウンドから戻った時）にトークン有効期限が残り10分未満なら事前リフレッシュを試行
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    try {
      const pub = getPublic();
      if (!pub || !pub.gdriveClientId || !pub.gdriveTokenExpiry) return;
      if (!pub.gdriveUserEmail && !pub.gdriveUserDisplayName) return;
      const remainingMs = pub.gdriveTokenExpiry - Date.now();
      if (remainingMs < 10 * 60 * 1000) {
        getDriveToken({ forceRefresh: remainingMs <= 60000 }).catch(() => {});
      }
    } catch (_) {}
  });
}

// GIS スクリプト事前プリロード（Client ID が設定されている場合、初回認証のポップアップ遅延をゼロ化）
if (typeof window !== "undefined") {
  try {
    const pub = getPublic();
    if (pub && pub.gdriveClientId) {
      ensureGisScript().catch(() => {});
    }
  } catch (_) {}
}

/**
 * Google Drive が接続中（有効なトークンがある）か判定
 * @param {{ allowSilentRefresh?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isDriveConnected({ allowSilentRefresh = false } = {}) {
  const token = await getDriveToken({ allowSilentRefresh });
  return !!token;
}

/**
 * Google Drive API のエラーレスポンスから詳細なエラーメッセージを抽出
 * @param {Response} res
 * @param {string} [defaultMsg]
 * @returns {Promise<string>}
 */
export async function parseGoogleApiError(res, defaultMsg = "Google API エラー") {
  try {
    const data = await res.json();
    const gError = data?.error;
    if (gError) {
      const msg = gError.message || "";
      const reason = gError.errors?.[0]?.reason || gError.details?.[0]?.reason || "";

      // 403: Google Drive API がプロジェクトで有効化されていない場合
      if (
        res.status === 403 &&
        (msg.includes("has not been used in project") ||
          msg.includes("disabled") ||
          reason === "SERVICE_DISABLED" ||
          reason === "accessNotConfigured")
      ) {
        return (
          `Google Drive API が有効化されていません (403 SERVICE_DISABLED)。\n` +
          `Google Cloud Console で「Google Drive API」を有効にする必要があります。\n` +
          `(${msg})`
        );
      }

      // 403: 権限不足またはテストユーザー制限
      if (res.status === 403) {
        return (
          `Google Drive API アクセス拒否 (403 Forbidden):\n` +
          `${msg || "権限がありません。"}\n` +
          `Google Cloud Console の「OAuth 同意画面」でテストユーザーに自分のアカウントが登録されているか、Google Drive API が有効化されているか確認してください。`
        );
      }

      return `${defaultMsg} (${res.status}): ${msg || res.statusText}`;
    }
  } catch (_) {
    // レスポンスが JSON ではない場合
  }
  return `${defaultMsg}: ${res.status} ${res.statusText || ""}`.trim();
}

/**
 * トークンの有効性とユーザー情報をテスト
 * @param {string} token
 * @returns {Promise<{ ok: boolean, user?: object, quota?: object, error?: string }>}
 */
export async function testConnection(token) {
  if (!token) return { ok: false, error: "トークンが指定されていません" };
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,picture),storageQuota", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, error: "アクセストークンが無効または期限切れです (401)" };
      }
      const errorMsg = await parseGoogleApiError(res, "Google Drive 接続テスト失敗");
      return { ok: false, error: errorMsg };
    }
    const data = await res.json();
    return {
      ok: true,
      user: data.user,
      quota: data.storageQuota,
    };
  } catch (err) {
    return { ok: false, error: `通信エラー: ${err.message}` };
  }
}

/**
 * GIS スクリプトを確実にロードする
 * @returns {Promise<void>}
 */
export function ensureGisScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("ブラウザ環境ではありません"));
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  return new Promise((res, rej) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => res());
      existing.addEventListener("error", () => rej(new Error("GIS スクリプトの読み込みに失敗しました")));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error("GIS スクリプトの読み込みに失敗しました"));
    document.head.appendChild(s);
  });
}

/**
 * GIS サイレントトークンリフレッシュ（ユーザー操作ダイアログなしで更新）
 * ※ すでに明示接続されたアカウントが存在し、かつ取得トークンのアカウントが一致する場合のみ採用する
 * @param {string} clientId
 * @returns {Promise<string>}
 */
export function silentRefreshGisToken(clientId) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error("Google OAuth Client ID が指定されていません"));
      return;
    }

    const pub = getPublic() || {};
    const expectedEmail = (pub.gdriveUserEmail || "").trim();
    const expectedName = (pub.gdriveUserDisplayName || "").trim();
    if (!expectedEmail && !expectedName) {
      reject(new Error("接続済みGoogleアカウントが未確定のためサイレント更新を行いません。アカウントを選択してログインしてください。"));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("サイレント更新タイムアウト (3.0s)"));
    }, 3000);

    const safeResolve = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    ensureGisScript()
      .then(() => {
        try {
          const emailHint = expectedEmail.includes("@") ? expectedEmail : undefined;
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
            ...(emailHint ? { hint: emailHint } : {}),
            callback: async (resp) => {
              if (resp.error) {
                safeReject(new Error(`サイレント更新エラー: ${resp.error_description || resp.error}`));
                return;
              }
              if (resp.access_token) {
                try {
                  const expiresIn = resp.expires_in ? parseInt(resp.expires_in, 10) : 3600;
                  const test = await testConnection(resp.access_token);
                  if (!test.ok || !test.user) {
                    safeReject(new Error("サイレント更新トークンのアカウント検証に失敗したため採用を中止しました。アカウントを選択して再ログインしてください。"));
                    return;
                  }
                  const actualEmail = (test.user.emailAddress || "").trim();
                  const actualName = (test.user.displayName || "").trim();
                  let isSameAccount = false;
                  if (expectedEmail && expectedEmail.includes("@")) {
                    isSameAccount = Boolean(actualEmail && actualEmail.toLowerCase() === expectedEmail.toLowerCase());
                  } else {
                    isSameAccount = Boolean(
                      (expectedEmail && (actualEmail === expectedEmail || actualName === expectedEmail)) ||
                      (expectedName && (actualName === expectedName || actualEmail === expectedName))
                    );
                  }
                  if (!isSameAccount) {
                    safeReject(new Error(`サイレント更新で別のGoogleアカウント (${actualEmail || actualName || "不明"}) が返されたため採用しませんでした。アカウントを選び直してください。`));
                    return;
                  }
                  await setDriveToken(resp.access_token, {
                    expiresIn,
                    email: actualEmail || expectedEmail,
                    displayName: actualName || expectedName,
                  });
                  safeResolve(resp.access_token);
                } catch (verifyErr) {
                  safeReject(verifyErr);
                }
              } else {
                safeReject(new Error("アクセストークンが取得できませんでした"));
              }
            },
            error_callback: (err) => {
              safeReject(new Error(err && err.message ? err.message : "サイレント更新失敗"));
            },
          });
          client.requestAccessToken(emailHint ? { prompt: "", hint: emailHint } : { prompt: "" });
        } catch (e) {
          safeReject(e);
        }
      })
      .catch(safeReject);
  });
}

/**
 * Google Identity Services (GIS) スクリプトを読み込み、明示的アカウント選択UI（prompt: "select_account"）でトークンを取得
 * ※ 保存済み login_hint や既存セッションで別アカウントへ自動確定しないよう hint は渡さない
 * @param {string} clientId
 * @returns {Promise<string>}
 */
export function requestGisToken(clientId) {
  return new Promise((resolve, reject) => {
    const resolvedClientId = (clientId || getPublic()?.gdriveClientId || "").trim();
    if (!resolvedClientId) {
      reject(new Error("Google OAuth Client ID を入力してください"));
      return;
    }

    ensureGisScript()
      .then(() => {
        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: resolvedClientId,
            scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
            prompt: "select_account",
            callback: async (resp) => {
              if (resp.error) {
                reject(new Error(`Google 認証エラー: ${resp.error_description || resp.error}`));
                return;
              }
              if (resp.access_token) {
                try {
                  const expiresIn = resp.expires_in ? parseInt(resp.expires_in, 10) : 3600;
                  // ユーザー情報取得を試行し、選択されたアカウントのメールアドレス/表示名を確実に記録
                  const test = await testConnection(resp.access_token);
                  const actualEmail = (test.ok && test.user && test.user.emailAddress) ? test.user.emailAddress.trim() : "";
                  const actualName = (test.ok && test.user && test.user.displayName) ? test.user.displayName.trim() : "";
                  const primaryIdentity = actualEmail || actualName || "";
                  // 旧アカウントの情報が残らないよう明示更新
                  setPublic({
                    gdriveClientId: resolvedClientId,
                    gdriveUserEmail: primaryIdentity,
                    gdriveUserDisplayName: actualName,
                  });
                  await setDriveToken(resp.access_token, {
                    expiresIn,
                    email: primaryIdentity,
                    displayName: actualName,
                  });
                  resolve(resp.access_token);
                } catch (cbErr) {
                  reject(cbErr);
                }
              } else {
                reject(new Error("アクセストークンが取得できませんでした"));
              }
            },
            error_callback: (err) => {
              const errType = err && err.type ? String(err.type) : "";
              if (errType === "popup_closed") {
                reject(new Error("認証ウィンドウが閉じられました（キャンセル）"));
              } else if (errType === "popup_failed_to_open") {
                reject(new Error("認証ポップアップを開けませんでした。ブラウザのポップアップブロック設定を確認してください"));
              } else {
                reject(new Error((err && (err.message || err.type)) ? String(err.message || err.type) : "認証ウィンドウが閉じられたか失敗しました"));
              }
            },
          });
          client.requestAccessToken({ prompt: "select_account" });
        } catch (e) {
          reject(e);
        }
      })
      .catch(reject);
  });
}

/**
 * Google アカウントを明示的に選び直す（旧アカウントの登録曲データは削除せず、トークン・アカウント情報・Proxy Cookie を更新）
 * @param {string} [clientId]
 * @returns {Promise<string>}
 */
export async function switchDriveAccount(clientId) {
  const targetClientId = (clientId || getPublic()?.gdriveClientId || "").trim();
  if (!targetClientId) {
    throw new Error("Google OAuth Client ID が未設定です。「接続 / 追加」から Client ID を設定してください。");
  }
  return requestGisToken(targetClientId);
}

/**
 * Google Drive 上のアイテム（フォルダおよび音源ファイル）を検索・一覧取得
 * @param {{ folderId?: string, query?: string, pageToken?: string, pageSize?: number }} [opts]
 * @returns {Promise<{ files: Array<object>, nextPageToken: string|null }>}
 */
export async function listDriveItems({ folderId = "root", query = "", pageToken = null, pageSize = 100 } = {}) {
  let token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません");

  let q = "trashed = false";
  if (query.trim()) {
    const clean = query.trim().replace(/['\\]/g, "");
    q += ` and name contains '${clean}' and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')`;
  } else {
    q += ` and '${folderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')`;
  }

  let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${pageSize}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&orderBy=folder,name`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    // 1回だけサイレントリフレッシュを試行（即座に disconnectDrive でメール等を消さない）
    const refreshed = await getDriveToken({ forceRefresh: true }).catch(() => null);
    if (refreshed) {
      token = refreshed;
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      await clearExpiredDriveToken();
      throw new Error("認証の有効期限が切れました。再度接続してください。");
    }
    const errMsg = await parseGoogleApiError(res, "Google Drive API エラー");
    throw new Error(errMsg);
  }

  const data = await res.json();
  return {
    files: data.files || [],
    nextPageToken: data.nextPageToken || null,
  };
}

/**
 * サポート確認済み音声拡張子（iPhone PWA / ブラウザ対応形式）
 * ※ 未確認形式 (.alac, .aiff, .wma 等) は再生保証がないため検索およびインポート対象から除外
 */
export const CONFIRMED_AUDIO_EXTENSIONS = [
  "mp3", "flac", "m4a", "wav", "aac", "ogg", "opus", "webm"
];

/**
 * ファイル名から小文字拡張子を取得
 * @param {string} filename
 * @returns {string}
 */
export function getFileExtension(filename) {
  if (!filename || typeof filename !== "string") return "";
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

/**
 * Google Drive アイテムがサポート対象音源ファイルか判定
 * @param {object} file
 * @returns {boolean}
 */
export function isSupportedDriveAudioFile(file) {
  if (!file || typeof file !== "object") return false;
  if (file.mimeType === "application/vnd.google-apps.folder") return false;
  const ext = getFileExtension(file.name);
  const hasSupportedExt = CONFIRMED_AUDIO_EXTENSIONS.includes(ext);

  // 1. application/octet-stream: 音声拡張子を持つ場合のみ許可
  if (file.mimeType === "application/octet-stream") {
    return hasSupportedExt;
  }

  // 2. 拡張子が確認済み音声形式（大文字小文字問わず）
  if (hasSupportedExt) {
    return true;
  }

  // 3. MIME タイプが audio/ で始まる場合
  if (file.mimeType && typeof file.mimeType === "string" && file.mimeType.startsWith("audio/")) {
    // 明示的に非対応/未確認拡張子が付与されている場合は除外
    if (ext && !hasSupportedExt) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * 機密情報（トークン、Authorization ヘッダ、URL 引数等）を除去した安全なエラー情報を生成
 * @param {any} err
 * @param {object} context
 * @returns {object}
 */
export function sanitizeDriveSafeError(err, { folderName = "", folderId = "", stage = "request", pageToken = null } = {}) {
  const rawMsg = err && err.message ? String(err.message) : "Unknown error";
  let safeMsg = rawMsg
    .replace(/ya29\.[a-zA-Z0-9_\-]+/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-]+/gi, "Bearer [REDACTED]")
    .replace(/access_token=[a-zA-Z0-9_\-]+/gi, "access_token=[REDACTED]");

  const status = (err && typeof err.status === "number") ? err.status : (err && err.code ? Number(err.code) : null);
  let errorCode = err && err.errorCode ? err.errorCode : (status ? `HTTP_${status}` : "NETWORK_ERROR");
  if (err && err.name === "AbortError") errorCode = "ABORTED";

  const folderIdSuffix = folderId ? (folderId.length > 8 ? `...${folderId.slice(-6)}` : folderId) : "";

  return {
    stage,
    folderName: folderName || "マイドライブ",
    folderIdSuffix,
    status,
    errorCode,
    message: safeMsg,
    ...(pageToken ? { pageTokenSuffix: `...${String(pageToken).slice(-6)}` } : {}),
  };
}

/**
 * フォルダ（およびその全サブフォルダ）内の全音源ファイルを再帰的に取得
 * - 部分成功に対応: 一部フォルダやページの取得に失敗しても取得済み曲を保持して返却
 * - 循環参照防止 (visitedFolderIds)、重複音源防止 (discoveredFileIds)、最大深度ガード
 * - HTTP 再試行規則: 401 (トークン再取得1回), 403 (レート制限のみ指数バックオフ再試行・権限不足はリトライなし), 429 (Retry-After尊重), 5xx / ネットワーク例外 (最大2回再試行), AbortError (即中断)
 * - 機密情報 (トークン、秘密URL) をエラーに一切含めない安全設計
 * @param {string} rootFolderId
 * @param {{ onProgress?: (msg: string) => void, signal?: AbortSignal|null, maxDepth?: number, maxFolders?: number, sleepFn?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ files: Array<object>, foldersVisited: number, pagesFetched: number, failedFolders: Array<object>, failedPages: Array<object>, warnings: Array<string>, aborted: boolean, authRequired: boolean, partial: boolean }>}
 */
export async function fetchFolderAudioFilesRecursive(
  rootFolderId,
  {
    onProgress,
    signal = null,
    maxDepth = 20,
    maxFolders = 500,
    sleepFn = null,
  } = {}
) {
  const sleep = typeof sleepFn === "function" ? sleepFn : (ms) => new Promise((r) => setTimeout(r, ms));
  let token = await getDriveToken();

  const audioFiles = [];
  const folderQueue = [{ id: rootFolderId, name: "", depth: 0 }];
  const visitedFolderIds = new Set([rootFolderId]);
  const discoveredFileIds = new Set();
  const failedFolders = [];
  const failedPages = [];
  const warnings = [];
  let authRequired = !token;
  let aborted = false;
  let totalPagesFetched = 0;

  if (!token) {
    const safeErr = sanitizeDriveSafeError(new Error("Google Drive に接続されていません"), {
      folderName: "マイドライブ",
      folderId: rootFolderId,
      stage: "init",
    });
    failedFolders.push(safeErr);
    return {
      files: audioFiles,
      foldersVisited: visitedFolderIds.size,
      pagesFetched: 0,
      failedFolders,
      failedPages,
      warnings,
      aborted: false,
      authRequired: true,
      partial: true,
    };
  }

  while (folderQueue.length > 0) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const curFolder = folderQueue.shift();
    const curFolderId = curFolder.id;
    const curFolderName = curFolder.name || "";
    const curDepth = curFolder.depth || 0;

    if (typeof onProgress === "function") {
      onProgress(`フォルダを探索中 (検出: ${audioFiles.length} 曲)…`);
    }

    let pageToken = null;
    let folderFailed = false;

    do {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      const q = `trashed = false and '${curFolderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')`;
      let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=100&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)&orderBy=folder,name`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

      let res = null;
      let attempt = 0;
      const maxRetries = 3;
      let lastAttemptError = null;

      while (attempt < maxRetries) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        attempt++;
        try {
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: signal || undefined,
          });

          // 1. 401 Unauthorized: トークン再取得は最大1回のみ試行
          if (res.status === 401) {
            const refreshed = await getDriveToken({ forceRefresh: true }).catch(() => null);
            if (refreshed) {
              token = refreshed;
              res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                signal: signal || undefined,
              });
            } else {
              authRequired = true;
              break;
            }
          }

          if (res.ok) {
            lastAttemptError = null;
            break;
          }

          // 2. 403 Forbidden
          if (res.status === 403) {
            let isRateLimit = false;
            try {
              const errBody = await res.clone().json();
              const reason = errBody?.error?.errors?.[0]?.reason || errBody?.error?.details?.[0]?.reason || "";
              const msg = errBody?.error?.message || "";
              if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || msg.includes("Rate Limit Exceeded")) {
                isRateLimit = true;
              }
            } catch (_) {}

            if (isRateLimit && attempt < maxRetries) {
              const waitMs = Math.min(5000, 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
              await sleep(waitMs);
              continue;
            }
            lastAttemptError = new Error(`403 Forbidden: 権限がないかAPIが無効です`);
            lastAttemptError.status = 403;
            break;
          }

          // 3. 429 Too Many Requests
          if (res.status === 429) {
            if (attempt < maxRetries) {
              const retryAfter = res.headers?.get?.("Retry-After");
              let waitMs = 0;
              if (retryAfter) {
                const parsedSec = parseInt(retryAfter, 10);
                if (!isNaN(parsedSec) && parsedSec > 0) {
                  waitMs = Math.min(10000, parsedSec * 1000);
                }
              }
              if (waitMs <= 0) {
                waitMs = Math.min(5000, 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
              }
              await sleep(waitMs);
              continue;
            }
            lastAttemptError = new Error(`429 Too Many Requests`);
            lastAttemptError.status = 429;
            break;
          }

          // 4. 5xx Server Error
          if (res.status >= 500) {
            if (attempt < maxRetries) {
              const waitMs = Math.min(5000, 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
              await sleep(waitMs);
              continue;
            }
            lastAttemptError = new Error(`HTTP ${res.status} サーバー一時エラー`);
            lastAttemptError.status = res.status;
            break;
          }

          // その他 HTTP エラー
          lastAttemptError = new Error(`HTTP ${res.status} エラー`);
          lastAttemptError.status = res.status;
          break;
        } catch (fetchErr) {
          lastAttemptError = fetchErr;
          if (fetchErr.name === "AbortError" || signal?.aborted) {
            aborted = true;
            break;
          }
          if (attempt >= maxRetries) break;
          const waitMs = Math.min(5000, 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
          await sleep(waitMs);
        }
      }

      if (aborted) break;

      if (!res || !res.ok) {
        const safeErr = sanitizeDriveSafeError(lastAttemptError || new Error(`ページ取得失敗`), {
          folderName: curFolderName,
          folderId: curFolderId,
          stage: "page_fetch",
          pageToken,
        });
        failedPages.push(safeErr);
        if (!failedFolders.some((f) => f.folderIdSuffix === safeErr.folderIdSuffix)) {
          failedFolders.push(safeErr);
        }
        warnings.push(`フォルダ「${curFolderName || "マイドライブ"}」のページ取得をスキップしました (${safeErr.errorCode})`);
        folderFailed = true;
        break;
      }

      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        const safeErr = sanitizeDriveSafeError(jsonErr, {
          folderName: curFolderName,
          folderId: curFolderId,
          stage: "json_parse",
          pageToken,
        });
        failedPages.push(safeErr);
        warnings.push(`フォルダ「${curFolderName || "マイドライブ"}」のレスポンス解析に失敗しました`);
        folderFailed = true;
        break;
      }

      totalPagesFetched++;
      const items = data?.files || [];

      for (const item of items) {
        if (!item || !item.id) continue;

        // フォルダ
        if (item.mimeType === "application/vnd.google-apps.folder") {
          if (curDepth + 1 > maxDepth) {
            warnings.push(`最大深度 (${maxDepth}) に達したためサブフォルダ「${item.name || ""}」をスキップしました`);
            continue;
          }
          if (visitedFolderIds.size >= maxFolders) {
            warnings.push(`最大探索フォルダ数 (${maxFolders}) に達したためサブフォルダ「${item.name || ""}」をスキップしました`);
            continue;
          }
          if (visitedFolderIds.has(item.id)) {
            warnings.push(`循環フォルダ参照を検出したためスキップしました (フォルダ名: ${item.name || ""})`);
            continue;
          }
          visitedFolderIds.add(item.id);
          folderQueue.push({ id: item.id, name: item.name || "", depth: curDepth + 1 });
          continue;
        }

        // ショートカット
        if (item.mimeType === "application/vnd.google-apps.shortcut") {
          const targetMime = item.shortcutDetails?.targetMimeType;
          const targetId = item.shortcutDetails?.targetId;
          if (targetId && targetMime === "application/vnd.google-apps.folder") {
            if (curDepth + 1 <= maxDepth && visitedFolderIds.size < maxFolders) {
              if (!visitedFolderIds.has(targetId)) {
                visitedFolderIds.add(targetId);
                folderQueue.push({ id: targetId, name: item.name || "", depth: curDepth + 1 });
              }
            }
          } else if (targetId && isSupportedDriveAudioFile({ name: item.name, mimeType: targetMime })) {
            if (!discoveredFileIds.has(targetId)) {
              discoveredFileIds.add(targetId);
              audioFiles.push({
                ...item,
                id: targetId,
                mimeType: targetMime || item.mimeType,
                folderName: curFolderName,
              });
            }
          }
          continue;
        }

        // 音源ファイル
        if (isSupportedDriveAudioFile(item)) {
          if (!discoveredFileIds.has(item.id)) {
            discoveredFileIds.add(item.id);
            item.folderName = curFolderName;
            audioFiles.push(item);
          }
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken && !folderFailed && !aborted && !authRequired);

    if (authRequired) {
      warnings.push("認証の有効期限が切れ、再認証が必要です");
      break;
    }
  }

  const partial = failedFolders.length > 0 || failedPages.length > 0 || aborted || authRequired;
  return {
    files: audioFiles,
    foldersVisited: visitedFolderIds.size,
    pagesFetched: totalPagesFetched,
    failedFolders,
    failedPages,
    warnings,
    aborted,
    authRequired,
    partial,
  };
}

/**
 * Google Drive 上の音源ファイルを検索・一覧取得
 * @param {{ query?: string, pageToken?: string, pageSize?: number }} [opts]
 * @returns {Promise<{ files: Array<object>, nextPageToken: string|null }>}
 */
export async function listDriveAudioFiles({ query = "", pageToken = null, pageSize = 100 } = {}) {
  const res = await listDriveItems({ query, pageToken, pageSize });
  return {
    files: res.files.filter((f) => isSupportedDriveAudioFile(f)),
    nextPageToken: res.nextPageToken,
  };
}

/**
 * Google Drive から音源ファイルの Blob をダウンロード (リトライ機能付き)
 * @param {string} fileId
 * @param {{ onProgress?: (loaded: number, total: number) => void, maxRetries?: number, signal?: AbortSignal|null }} [opts]
 * @returns {Promise<Blob>}
 */
export async function fetchDriveAudioBlob(fileId, { onProgress, maxRetries = 3, signal = null } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    try {
      const token = await getDriveToken();
      if (!token) throw new Error("Google Drive に接続されていません。設定画面で接続してください。");

      // ★ access_token をクエリパラメータで渡すことで CORS プリフライト (OPTIONS) を完全に回避し、
      // 1RTT のゼロ遅延で即座にバイナリ受信を開始する
      const queryUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&access_token=${encodeURIComponent(token)}`;
      let res = null;
      try {
        res = await fetch(queryUrl, { signal: signal || undefined });
      } catch (fetchErr) {
        // ネットワーク切断や一時エラー時のフォールバック
        console.warn("[drive-service] クエリ形式 fetch 失敗、ヘッダー形式へフォールバック:", fetchErr);
        const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: signal || undefined,
        });
      }

      if (!res.ok) {
        if (res.status === 401) {
          _cachedToken = null;
          setLocalStorageToken(null, 0);
          const pub = getPublic();
          if (pub.gdriveClientId && attempt < maxRetries) {
            try {
              const newToken = await silentRefreshGisToken(pub.gdriveClientId);
              if (newToken) {
                _cachedToken = newToken;
                continue;
              }
            } catch (refErr) {
              console.warn("[drive-service] fetch 401後のサイレントリフレッシュ失敗:", refErr);
            }
          }
          throw new Error("Google Drive の認証期限が切れました (401)。再接続してください。");
        }
        if (res.status === 403) {
          const errMsg = await parseGoogleApiError(res, "Google Drive 権限エラー (403)");
          throw new Error(errMsg);
        }
        if (res.status >= 500 || res.status === 429) {
          const errMsg = await parseGoogleApiError(res, `Google Drive 一時エラー (${res.status})`);
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, attempt * 1000));
            continue;
          }
          throw new Error(errMsg);
        }
        const errMsg = await parseGoogleApiError(res, "Google Drive ダウンロード失敗");
        throw new Error(errMsg);
      }

      // プログレス監視付きのダウンロード
      if (typeof onProgress === "function" && res.body) {
        const contentLength = res.headers.get("Content-Length");
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        let lastProgressCall = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
          if (now - lastProgressCall > 100 || (total > 0 && loaded >= total)) {
            lastProgressCall = now;
            try { onProgress(loaded, total); } catch (_) {}
          }
        }
        try { onProgress(loaded, total || loaded); } catch (_) {}

        let contentType = res.headers.get("Content-Type") || "audio/mpeg";
        const rawBlob = new Blob(chunks, { type: contentType });
        const isFlac = await checkBlobFlac(rawBlob);
        if (isFlac) {
          return new Blob(chunks, { type: "audio/flac" });
        }
        return rawBlob;
      }

      let resBlob = await res.blob();
      const isFlac = await checkBlobFlac(resBlob);
      if (isFlac && resBlob.type !== "audio/flac") {
        resBlob = new Blob([resBlob], { type: "audio/flac" });
      }
      return resBlob;
    } catch (err) {
      lastError = err;
      if (err.name === "AbortError" || signal?.aborted) {
        throw err;
      }
      if (err.message && (err.message.includes("401") || err.message.includes("403") || err.message.includes("接続されていません"))) {
        throw err;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 800));
      }
    }
  }

  throw lastError || new Error("Google Drive 音源のダウンロードに失敗しました");
}

/**
 * FLAC マジックナンバー (先頭4バイト 'fLaC' = 0x66, 0x4C, 0x61, 0x43) を判定
 * @param {Uint8Array|ArrayBuffer|number[]} bytes
 * @returns {boolean}
 */
export function isFlacMagic(bytes) {
  if (!bytes) return false;
  const arr = bytes instanceof Uint8Array ? bytes : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  if (arr.length < 4) return false;
  return arr[0] === 0x66 && arr[1] === 0x4c && arr[2] === 0x61 && arr[3] === 0x43;
}

/**
 * Blob の先頭バイトを読み込み FLAC か判定
 * @param {Blob} blob
 * @returns {Promise<boolean>}
 */
export async function checkBlobFlac(blob) {
  if (!blob || blob.size < 4) return false;
  try {
    const slice = blob.slice(0, 4);
    const buf = await slice.arrayBuffer();
    return isFlacMagic(new Uint8Array(buf));
  } catch {
    return false;
  }
}

/**
 * 外出時・モバイル回線向けに、ファイル全体のダウンロードを待たずに
 * <audio> の HTTP Range プログレッシブストリーミングで即時再生するための URL を生成する
 * @param {string|object} fileId
 * @param {string} [tokenOverride]
 * @returns {Promise<string|null>}
 */
export async function getDriveStreamUrl(fileId, tokenOverride = null) {
  if (!fileId) return null;
  const cleanId = resolveDriveFileId(fileId) || driveFileIdFromTrackId(fileId);
  if (!cleanId || cleanId === "undefined" || cleanId === "null") return null;
  const token = tokenOverride || (await getDriveToken());
  if (!token) return null;
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cleanId)}?alt=media&access_token=${encodeURIComponent(token)}`;
}

let _driveSessionToken = null;
let _driveSessionExpiry = 0;
let _driveSessionCreatedAt = 0;
let _driveSessionPromise = null;
let _lastSilentRefreshFailure = null;
let _tokenAcquiredAt = 0;

const MAX_SESSION_DIAGNOSES = 50;
const _driveSessionDiagnoses = [];
let _lastDriveSessionDiagnostic = null;

/**
 * 直近のプロキシセッション確立試行の診断情報を取得
 * @returns {object|null}
 */
export function getLastDriveSessionDiagnostic() {
  return _lastDriveSessionDiagnostic ? { ..._lastDriveSessionDiagnostic } : null;
}

/**
 * プロキシセッション確立試行の履歴（最大50件）を取得
 * @returns {Array<object>}
 */
export function getDriveSessionDiagnoses() {
  return [..._driveSessionDiagnoses];
}

/**
 * プロキシセッション確立試行の履歴をクリア（テスト・検証用）
 */
export function clearDriveSessionDiagnoses() {
  _driveSessionDiagnoses.length = 0;
  _lastDriveSessionDiagnostic = null;
}

/**
 * ストリーミングセッションの状態を取得
 * @returns {"ready"|"expired"|"no_token"|"uninitialized"|"connecting"}
 */
export function getDriveStreamSessionStatus() {
  if (_driveSessionPromise) return "connecting";
  if (!_cachedToken && !getLocalStorageToken()?.token) return "no_token";
  if (!_driveSessionToken || !_driveSessionExpiry) return "uninitialized";
  if (Date.now() >= _driveSessionExpiry - 30000) return "expired";
  return "ready";
}

/**
 * 直近のサイレント更新失敗情報を取得
 * @returns {{ at: number, error: string } | null}
 */
export function getLastSilentRefreshFailure() {
  return _lastSilentRefreshFailure ? { ..._lastSilentRefreshFailure } : null;
}

let _lastTokenResolution = null;

/**
 * getDriveToken の直近の解決結果を記録する（診断専用）
 * 記録するのは結果種別と、判定材料（アカウント識別子 / Client ID）の有無だけ。
 * メールアドレスや Client ID の値そのもの等の秘密情報は含まない（引き継ぎ資料 §16 準拠）。
 * outcome: "refresh_not_allowed" | "no_identity" | "no_client_id" |
 *          "silent_refresh_success" | "silent_refresh_failed" | "silent_refresh_null"
 */
function recordTokenResolution(outcome, pub) {
  const p = pub || {};
  _lastTokenResolution = {
    at: Date.now(),
    outcome,
    hasIdentity: Boolean(
      (p.gdriveUserEmail && String(p.gdriveUserEmail).trim()) ||
      (p.gdriveUserDisplayName && String(p.gdriveUserDisplayName).trim())
    ),
    hasClientId: Boolean(p.gdriveClientId && String(p.gdriveClientId).trim()),
  };
}

/**
 * getDriveToken の直近の解決結果（診断用）を取得
 * @returns {{ at: number, outcome: string, hasIdentity: boolean, hasClientId: boolean } | null}
 */
export function getLastTokenResolution() {
  return _lastTokenResolution ? { ..._lastTokenResolution } : null;
}

/**
 * ストリーミング中継セッションの診断情報を取得
 * @returns {{ createdAt: string|null, expiresAt: string|null, remainingMs: number, isReady: boolean }}
 */
export function getDriveSessionDiagnostics() {
  const now = Date.now();
  return {
    createdAt: _driveSessionCreatedAt ? new Date(_driveSessionCreatedAt).toISOString() : null,
    expiresAt: _driveSessionExpiry ? new Date(_driveSessionExpiry).toISOString() : null,
    remainingMs: Math.max(0, _driveSessionExpiry - now),
    isReady: Boolean(_driveSessionToken && now < _driveSessionExpiry - 30000),
  };
}

/**
 * Google Drive OAuth トークンの診断情報を取得
 * @returns {{ acquiredAt: string|null, expiresAt: string|null, remainingMs: number, expiryMarginMs: number }}
 */
export function getDriveTokenDiagnostics() {
  const pub = getPublic() || {};
  const now = Date.now();
  const expiry = pub.gdriveTokenExpiry || 0;
  const acquiredAt = _tokenAcquiredAt || pub.gdriveTokenAcquiredAt || (expiry ? Math.max(0, expiry - 3600 * 1000) : 0);
  return {
    acquiredAt: acquiredAt ? new Date(acquiredAt).toISOString() : null,
    expiresAt: expiry ? new Date(expiry).toISOString() : null,
    remainingMs: Math.max(0, expiry - now),
    expiryMarginMs: 180000,
    lastResolutionOutcome: _lastTokenResolution ? _lastTokenResolution.outcome : null,
    lastResolutionHasIdentity: _lastTokenResolution ? _lastTokenResolution.hasIdentity : null,
    lastResolutionHasClientId: _lastTokenResolution ? _lastTokenResolution.hasClientId : null,
  };
}

/**
 * ストリーミングセッションが即座に利用可能か確認
 * @param {string} [token] - 特定のトークンとの一致も検証する場合に指定
 * @returns {boolean}
 */
export function isDriveStreamSessionReady(token = null) {
  if (token && _driveSessionToken && _driveSessionToken !== token) {
    return false;
  }
  return getDriveStreamSessionStatus() === "ready";
}

/**
 * Vercel Edge 中継用のセキュアストリーミングセッションを初期化
 * - クライアントから POST /api/drive-session へトークンを送り、HttpOnly Cookie を設定
 * - audio.src の URL にトークンを含めない安全な設計
 * - セッション確立済みの場合は 0ms で完了し、曲タップごとの遅延を根絶
 * - in-flight Promise の共有により同一トークンへの多重 POST を完全排除
 * @param {string} [tokenOverride]
 * @param {{ force?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureDriveStreamSession(tokenOverride = null, { force = false, timeoutMs = 3500 } = {}) {
  if (typeof fetch === "undefined") return false;
  const token = tokenOverride || (await getDriveToken());
  if (!token) {
    _driveSessionToken = null;
    _driveSessionExpiry = 0;
    _driveSessionCreatedAt = 0;
    return false;
  }

  const now = Date.now();
  // すでに同じトークンでセッション確立済みかつ有効期限内なら、POST せず即座に true を返す
  if (!force && _driveSessionToken === token && now < _driveSessionExpiry - 60000) {
    return true;
  }

  // 多重呼び出し時は既存の進行中 Promise を共有
  if (_driveSessionPromise && !force) {
    return _driveSessionPromise;
  }

  const configuredTimeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 3500;
  const sessionReadyBefore = isDriveStreamSessionReady(token);

  _driveSessionPromise = (async () => {
    const startedAt = Date.now();
    let completedAt = startedAt;
    let timedOut = false;
    let fetchErrorName = null;
    let fetchErrorCategory = null;
    let responseOk = null;
    let responseCode = null;
    let responseBodyCode = null;

    try {
      const pub = getPublic() || {};
      const remainingSec = pub.gdriveTokenExpiry
        ? Math.max(60, Math.floor((pub.gdriveTokenExpiry - Date.now()) / 1000))
        : 3600;

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timer = null;
      if (controller && configuredTimeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, configuredTimeoutMs);
      }

      let res;
      try {
        res = await fetch("/api/drive-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token, expiresIn: remainingSec }),
          signal: controller ? controller.signal : undefined,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      completedAt = Date.now();
      responseOk = Boolean(res.ok);
      responseCode = res.status;

      if (responseOk) {
        _driveSessionToken = token;
        _driveSessionCreatedAt = Date.now();
        _driveSessionExpiry = Date.now() + remainingSec * 1000;
      } else {
        if (responseCode >= 400 && responseCode < 500) {
          fetchErrorCategory = "http_client_error";
        } else if (responseCode >= 500) {
          fetchErrorCategory = "http_server_error";
        } else {
          fetchErrorCategory = "invalid_response";
        }

        // 安全な固定エラーコードの抽出（トークン・URL・メッセージ全文は一切除外）
        try {
          const data = await res.json();
          const rawCode = data?.error || data?.code;
          if (typeof rawCode === "string") {
            const sanitized = rawCode.replace(/ya29\.[^\s"']+/g, "").replace(/https?:\/\/[^\s"']+/g, "").trim();
            if (/cross-origin/i.test(sanitized)) {
              responseBodyCode = "cross_origin_rejected";
            } else if (/invalid token/i.test(sanitized)) {
              responseBodyCode = "invalid_token";
            } else if (/forbidden/i.test(sanitized)) {
              responseBodyCode = "forbidden";
            }
          }
        } catch (_) {}
      }

      return responseOk;
    } catch (err) {
      completedAt = Date.now();
      const isAbort = timedOut || err?.name === "AbortError";
      const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
      fetchErrorName = isAbort ? "AbortError" : (err?.name || (err instanceof Error ? err.constructor.name : "Error"));

      if (isAbort) {
        timedOut = true;
        fetchErrorCategory = "timeout_aborted";
      } else if (isOffline) {
        fetchErrorCategory = "network_offline";
      } else if (err instanceof TypeError || err?.name === "TypeError") {
        fetchErrorCategory = "fetch_failed";
      } else {
        fetchErrorCategory = "unknown";
      }

      console.warn("[drive-service] drive-session 接続失敗:", err);
      return false;
    } finally {
      _driveSessionPromise = null;
      const sessionReadyAfter = isDriveStreamSessionReady(token);
      const sessionTokenMatched = Boolean(_driveSessionToken && _driveSessionToken === token);
      const sessionExpiryRemainingMs = Math.max(0, _driveSessionExpiry - Date.now());
      const durationMs = Math.max(0, completedAt - startedAt);

      const record = {
        proxyRequestStartedAt: startedAt,
        proxyRequestCompletedAt: completedAt,
        proxyDurationMs: durationMs,
        proxyTimedOut: timedOut,
        proxyFetchErrorName: fetchErrorName,
        proxyFetchErrorCategory: fetchErrorCategory,
        proxyResponseOk: responseOk,
        proxyResponseCode: responseCode,
        proxyResponseBodyCode: responseBodyCode,
        sessionReadyBefore,
        sessionReadyAfter,
        sessionTokenMatched,
        sessionExpiryRemainingMs,
        configuredTimeoutMs,
      };

      _lastDriveSessionDiagnostic = record;
      _driveSessionDiagnoses.unshift(record);
      if (_driveSessionDiagnoses.length > MAX_SESSION_DIAGNOSES) {
        _driveSessionDiagnoses.length = MAX_SESSION_DIAGNOSES;
      }
    }
  })();

  return _driveSessionPromise;
}

/**
 * ストリーミングセッション Cookie を破棄
 */
export async function clearDriveStreamSession() {
  _driveSessionToken = null;
  _driveSessionExpiry = 0;
  _driveSessionCreatedAt = 0;
  _driveSessionPromise = null;
  if (typeof fetch === "undefined") return;
  try {
    await fetch("/api/drive-session", { method: "DELETE" });
  } catch (_) {}
}

/**
 * 同一オリジン Range 中継用ストリーミング URL を生成
 * ★ URL にアクセストークンを一切含めない（認証は HttpOnly Cookie 経由）
 * @param {string|object} fileIdOrTrack
 * @param {string} [extHint]
 * @returns {string|null}
 */
export function getDriveProxyStreamUrl(fileIdOrTrack, extHint = "flac") {
  if (!fileIdOrTrack) return null;
  const cleanId = resolveDriveFileId(fileIdOrTrack) || driveFileIdFromTrackId(fileIdOrTrack);
  if (!cleanId || cleanId === "undefined" || cleanId === "null") return null;
  const ext = (typeof fileIdOrTrack === "object" ? (fileIdOrTrack.format || fileIdOrTrack.extension) : null) || extHint || "flac";
  return `/api/drive-stream?fileId=${encodeURIComponent(cleanId)}&ext=${encodeURIComponent(ext)}`;
}

let _activeReconnectModalPromise = null;

/**
 * 未連携またはトークン有効期限切れの状態で Google Drive の曲を再生しようとした際、
 * 勝手に曲をスキップせず「その場で再連携」してそのまま再生を開始するためのモーダルを表示する。
 * @param {{ track?: object, reason?: string }} [opts]
 * @returns {Promise<string|null>} 再連携成功時は新しいアクセストークン、キャンセル時は null
 */
export async function promptDriveReconnectModal({
  track = null,
  reason = "",
  forceModal = false,
  title = null,
  bodyText = null,
} = {}) {
  if (!title && !bodyText && !forceModal) {
    clearDriveStreamSession().catch(() => {});
  }
  if (typeof document === "undefined") return Promise.resolve(null);
  if (_activeReconnectModalPromise) return _activeReconnectModalPromise;

  const pub = getPublic() || {};
  const savedClientId = pub.gdriveClientId || "";

  _activeReconnectModalPromise = new Promise((resolve) => {
    let settled = false;
    const closeCurrentModal = () => {
      try {
        const closeBtn = document.querySelector("#modal-root .modal-close");
        if (closeBtn) closeBtn.click();
      } catch {}
    };
    const finish = (tokenVal) => {
      if (settled) return;
      settled = true;
      _activeReconnectModalPromise = null;
      resolve(tokenVal || null);
    };

    const savedEmail = pub.gdriveUserEmail || pub.gdriveUserDisplayName || "";
    const trackTitle = (track && track.title) ? track.title : "Google Drive の曲";
    const modalTitle = title || "☁ Google Drive の再連携";
    const modalBodyIntro = bodyText || "Google Drive の認証有効期限が切れているか未連携のため、Google アカウントを選択してログインするとそのまま再生を開始します。";
    const redirectUri = (typeof window !== "undefined" && window.location) ? (window.location.origin + window.location.pathname) : "";
    const oauthDirectUrl = savedClientId ? `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(savedClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file")}&prompt=select_account` : "";

    const container = document.createElement("div");
    container.className = "gdrive-reconnect-modal";
    container.style.cssText = "display:flex; flex-direction:column; gap:14px;";
    container.innerHTML = `
      <div style="padding:12px 14px; border-radius:10px; background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.3); font-size:0.92rem; line-height:1.5;">
        <div style="font-weight:700; margin-bottom:4px;">🎵 「${escapeHtml(trackTitle)}」</div>
        <div class="muted" style="font-size:0.84rem;">
          ${escapeHtml(modalBodyIntro)}
          ${savedEmail ? `<br><span style="color:var(--accent, #60a5fa);">前回の連携アカウント: ${escapeHtml(savedEmail)}</span>` : ""}
        </div>
      </div>

      <button type="button" class="btn primary" id="gd-reconnect-now-btn" style="padding:14px 18px; font-size:1.05rem; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px; width:100%;">
        🔑 Driveへ再接続
      </button>

      ${oauthDirectUrl ? `
        <div style="margin-top:-4px; text-align:center;">
          <a href="${oauthDirectUrl}" class="btn" id="gd-reconnect-direct-link" style="display:flex; align-items:center; justify-content:center; gap:6px; font-size:0.86rem; text-decoration:none; padding:8px 12px; background:transparent; border:1px solid var(--border-color, rgba(255,255,255,0.15));">
            🌐 ポップアップが開かない場合はこちら（リダイレクトでアカウント選択）
          </a>
        </div>
      ` : ""}

      <details style="font-size:0.84rem; color:var(--text-muted, #9ca3af);" ${!savedClientId ? "open" : ""}>
        <summary style="cursor:pointer; user-select:none; padding:4px 0;">詳細設定（Client ID / アクセストークン直接入力）</summary>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px; padding:10px; border-radius:8px; background:rgba(255,255,255,0.04);">
          <label style="display:flex; flex-direction:column; gap:4px;">
            <span>Google OAuth Client ID</span>
            <input type="text" id="gd-reconnect-client-id" class="input" placeholder="xxxx.apps.googleusercontent.com" value="${escapeAttr(savedClientId)}" style="width:100%;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:4px;">
            <span>またはアクセストークンを直接貼り付け (任意)</span>
            <div style="display:flex; gap:6px;">
              <input type="password" id="gd-reconnect-manual-token" class="input" placeholder="ya29.a0..." style="flex:1;" />
              <button type="button" class="btn" id="gd-reconnect-manual-btn">適用して再生</button>
            </div>
          </label>
        </div>
      </details>

      <div id="gd-reconnect-status" style="font-size:0.84rem; min-height:1.2em; color:#f87171;"></div>
    `;

    openModal({
      title: modalTitle,
      body: container,
      actions: [
        {
          label: "診断情報をコピー",
          onClick: () => {
            if (typeof window !== "undefined" && typeof window.__getLastPlaybackDiagnostics === "function") {
              const diag = window.__getLastPlaybackDiagnostics();
              import("../player/audio-engine.js").then((mod) => {
                if (typeof mod.showDiagnosticsModal === "function") {
                  mod.showDiagnosticsModal(diag);
                }
              }).catch(() => {});
            }
          },
        },
        {
          label: "キャンセル",
          onClick: () => {
            finish(null);
          },
        },
      ],
    }).then(() => {
      finish(null);
    });

    const nowBtn = container.querySelector("#gd-reconnect-now-btn");
    const directLink = container.querySelector("#gd-reconnect-direct-link");
    const clientIdInput = container.querySelector("#gd-reconnect-client-id");
    const manualInput = container.querySelector("#gd-reconnect-manual-token");
    const manualBtn = container.querySelector("#gd-reconnect-manual-btn");
    const statusEl = container.querySelector("#gd-reconnect-status");

    if (directLink) {
      directLink.addEventListener("click", () => {
        if (typeof sessionStorage !== "undefined") {
          try {
            sessionStorage.setItem("music-player:pending-track", JSON.stringify({
              trackId: track?.id || null,
            }));
          } catch {}
        }
      });
    }

    if (nowBtn) {
      nowBtn.addEventListener("click", async () => {
        const cid = (clientIdInput && clientIdInput.value.trim()) || getPublic().gdriveClientId || "";
        if (!cid) {
          if (statusEl) statusEl.textContent = "Google OAuth Client ID を入力するか、アクセストークンを貼り付けてください。";
          if (clientIdInput) clientIdInput.focus();
          return;
        }
        setPublic({ gdriveClientId: cid });
        nowBtn.disabled = true;
        nowBtn.textContent = "⏳ アカウント選択画面を開いています…";
        try {
          const tok = await requestGisToken(cid);
          const latestPub = getPublic() || {};
          const accLabel = latestPub.gdriveUserEmail || latestPub.gdriveUserDisplayName || "OK";
          toast(`☁ Google Drive に接続しました (${accLabel})`, "ok");
          finish(tok);
          closeCurrentModal();
        } catch (err) {
          if (statusEl) statusEl.textContent = err?.message || "認証に失敗しました。";
          nowBtn.disabled = false;
          nowBtn.textContent = "🔑 Google アカウントでログイン（アカウントを選択）";
        }
      });
    }

    if (manualBtn) {
      manualBtn.addEventListener("click", async () => {
        const rawTok = manualInput ? manualInput.value.trim() : "";
        if (!rawTok) {
          if (statusEl) statusEl.textContent = "アクセストークンを入力してください。";
          return;
        }
        manualBtn.disabled = true;
        if (statusEl) statusEl.textContent = "";
        try {
          const check = await testConnection(rawTok);
          if (!check.ok) {
            if (statusEl) statusEl.textContent = check.error || "無効なトークンです";
            return;
          }
          const actualEmail = (check.user && check.user.emailAddress) ? check.user.emailAddress.trim() : "";
          const actualName = (check.user && check.user.displayName) ? check.user.displayName.trim() : "";
          const email = actualEmail || actualName || "";
          setPublic({ gdriveUserEmail: email, gdriveUserDisplayName: actualName });
          await setDriveToken(rawTok, { expiresIn: 3600, email, displayName: actualName });
          toast(`☁ Google Drive に再連携しました (${email || "OK"})`, "ok");
          finish(rawTok);
          closeCurrentModal();
        } finally {
          manualBtn.disabled = false;
        }
      });
    }
  });

  return _activeReconnectModalPromise;
}

/**
 * Google Drive から音源ファイルの先頭ヘッダ部分（maxBytes）のみを取得
 * FLAC や MP3 のメタデータ解析をフルダウンロードせず高速に行う（通信量・ストレージ節約）
 * @param {string} fileId
 * @param {number} [maxBytes=1572864] 1.5MB（高解像度カバーアートの欠損防止）
 * @param {number} [fullFileSize=0] ファイル全体のバイトサイズ（CBR MP3等の再生時間計算で0:39固定化を防ぐため）
 * @returns {Promise<Blob|null>}
 */
export async function fetchDriveAudioHeader(fileId, maxBytes = 1572864, fullFileSize = 0) {
  let token = await getDriveToken();
  if (!token) return null;

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  try {
    let res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=0-${maxBytes - 1}`,
      },
    });

    if (res.status === 401) {
      const refreshed = await getDriveToken({ forceRefresh: true }).catch(() => null);
      if (refreshed) {
        token = refreshed;
        res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=0-${maxBytes - 1}`,
          },
        });
      }
    }

    if (!res.ok && res.status !== 206) return null;

    // Content-Range: bytes 0-1572863/12345678 からファイル全体サイズを抽出
    let detectedTotalSize = Number(fullFileSize) || 0;
    try {
      const cr = res.headers && typeof res.headers.get === "function" ? res.headers.get("Content-Range") : null;
      if (cr) {
        const m = cr.match(/\/(\d+)\s*$/);
        if (m && m[1]) {
          const parsedTotal = parseInt(m[1], 10);
          if (parsedTotal > 0) detectedTotalSize = parsedTotal;
        }
      }
    } catch (_) {}

    let outBlob = null;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (loaded < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
      }
      try { await reader.cancel(); } catch {}
      const contentType = res.headers.get("Content-Type") || "audio/flac";
      outBlob = new Blob(chunks, { type: contentType });
    } else {
      outBlob = await res.blob();
    }

    if (outBlob) {
      // ★ 部分ヘッダであることをマークし、全体ファイルサイズを付与（parse-mp3 等で 1.5MB=0:39 と誤算出されるのを完全防止）
      outBlob._isPartialHeader = true;
      if (detectedTotalSize > 0) {
        outBlob._fullFileSize = detectedTotalSize;
      }
    }
    return outBlob;
  } catch (err) {
    console.warn("[drive-service] ヘッダ取得スキップ:", fileId, err);
    return null;
  }
}

/**
 * Google Drive のアルバム名として無効（プレースホルダーまたは boolean 変換ゴミ）か判定
 * @param {unknown} val
 * @returns {boolean}
 */
export function isInvalidDriveAlbum(val) {
  if (!val || typeof val !== "string") return true;
  const s = val.trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  return (
    lower === "true" ||
    lower === "false" ||
    lower === "null" ||
    lower === "undefined" ||
    lower === "google drive" ||
    lower === "gdrive" ||
    lower === "root" ||
    lower === "music-player" ||
    s === "マイドライブ" ||
    s === "不明なアルバム" ||
    s === "不明アルバム"
  );
}

/**
 * 音源ファイル名および配置フォルダ名からメタデータを推測
 * 例:
 *  "01. YOASOBI - 夜に駆ける.flac" -> trackNo: "1", artist: "YOASOBI", title: "夜に駆ける"
 *  "YOASOBI - 夜に駆ける.mp3"     -> artist: "YOASOBI", title: "夜に駆ける"
 *  "10 - 曲名.mp3"                -> trackNo: "10", artist: "", title: "曲名"（※数字がartistになるバグを完全防止）
 *  "01 夜に駆ける.flac"           -> trackNo: "1", title: "夜に駆ける"
 * @param {string} filename
 * @param {string} [folderName=""]
 * @returns {{ title: string, artist: string, album: string, trackNo: string }}
 */
export function inferMetadataFromFileName(filename, folderName = "") {
  const base = stripExt(filename).trim();
  let trackNo = "";
  let artist = "";
  let title = base;
  const album = folderName && !isInvalidDriveAlbum(folderName) ? folderName.trim() : "";

  // 1. 先頭のトラック番号（例: "01. ", "01 - ", "10-", "01 ", "01_"）を抽出・分離
  let work = base;
  const trackMatch = work.match(/^\s*(\d{1,3})([\s._-]+|\s+)(.*)$/);
  if (trackMatch) {
    trackNo = String(parseInt(trackMatch[1], 10));
    work = (trackMatch[3] || "").trim();
  }

  // 2. parseArtistAndTitle によるインテリジェント分離
  const parsed = parseArtistAndTitle(work);
  if (parsed && parsed.artist && !isPlaceholderArtist(parsed.artist)) {
    artist = parsed.artist;
    title = parsed.title;
  } else if (work) {
    // 3. 残りの work から "Artist - Title" を抽出
    const dashMatch = work.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
      const part1 = dashMatch[1].trim();
      const part2 = dashMatch[2].trim();
      // part1 が数字のみ（例: "01" や "10" など）の場合はアーティスト名にしない
      if (/^\d+$/.test(part1)) {
        if (!trackNo) trackNo = String(parseInt(part1, 10));
        // part2 がさらに "Artist - Title" に分かれるか？
        const subDash = part2.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
        if (subDash && !/^\d+$/.test(subDash[1].trim()) && !isPlaceholderArtist(subDash[1].trim())) {
          artist = subDash[1].trim();
          title = subDash[2].trim();
        } else {
          title = part2;
        }
      } else if (!isPlaceholderArtist(part1)) {
        artist = part1;
        title = part2;
      }
    } else {
      title = work;
    }
  }

  // 4. 最終安全ガード: artist が数字のみ、またはプレースホルダーの場合はアーティストにしない
  if (/^\d+$/.test(artist) || isPlaceholderArtist(artist)) {
    if (/^\d+$/.test(artist) && !trackNo) trackNo = String(parseInt(artist, 10));
    artist = "";
  }

  // 5. フォルダ名フォールバック: album が実在アーティスト名（プレースホルダー以外）の場合のみ考慮
  if (!artist && album && !isPlaceholderArtist(album)) {
    artist = album;
  }

  return {
    title: title || base || "(無題)",
    artist: artist || "",
    album: album || "",
    trackNo,
  };
}

/**
 * Drive ファイルからライブラリ保存用トラックオブジェクトを安全に生成
 * - 同一 Drive file ID の既存トラックが存在する場合は、ユーザーデータ（再生回数、お気に入り、評価、追加日時、手動編集メタデータ、キー変更、歌詞、メモ、カスタム画像）を完全に保持
 * - 別の Drive file ID の曲は、タイトルやアーティストが似ていても絶対に既存IDを奪わない
 * @param {object} params
 * @returns {object}
 */
export function buildDriveTrackRecord({
  file,
  existing = null,
  extractedMeta = null,
  inferred = null,
  folder = "",
  normResult = null,
  blob = null,
  isCached = false,
  importTarget = null,
}) {
  const trackId = trackIdFromDriveFileId(file.id);
  const isNumeric = (s) => typeof s === "string" && /^\d+$/.test(s.trim());

  // 1. タイトルの決定
  const validMetaTitle = extractedMeta && extractedMeta.title && extractedMeta.title !== "(無題)" && extractedMeta.title !== stripExt(file.name) ? extractedMeta.title : null;
  const validExistingTitle = existing && typeof existing.title === "string" && existing.title !== "(無題)" && existing.title !== "true" ? existing.title : null;
  const title =
    (existing && existing.userEdited && validExistingTitle ? validExistingTitle : null) ||
    validMetaTitle ||
    validExistingTitle ||
    (inferred && inferred.title) ||
    (extractedMeta && extractedMeta.title) ||
    stripExt(file.name) ||
    "(無題)";

  // 2. アーティストの決定
  const validExistingArtist = existing && typeof existing.artist === "string" && !isPlaceholderArtist(existing.artist) && !isNumeric(existing.artist) ? existing.artist : null;
  const validMetaArtist = extractedMeta && typeof extractedMeta.artist === "string" && !isPlaceholderArtist(extractedMeta.artist) && !isNumeric(extractedMeta.artist) ? extractedMeta.artist : null;
  const validInferredArtist = inferred && inferred.artist && !isPlaceholderArtist(inferred.artist) && !isNumeric(inferred.artist) ? inferred.artist : null;
  const fallbackParsed = parseArtistAndTitle(file.name);
  const validParsedArtist = fallbackParsed && fallbackParsed.artist && !isPlaceholderArtist(fallbackParsed.artist) && !isNumeric(fallbackParsed.artist) ? fallbackParsed.artist : null;

  const artist =
    (existing && existing.userEdited && validExistingArtist ? validExistingArtist : null) ||
    validMetaArtist ||
    validExistingArtist ||
    validInferredArtist ||
    validParsedArtist ||
    "(不明アーティスト)";

  // 3. アルバム & アルバムアーティストの決定（明示的 importTarget / 優先順位監査）
  const validTargetAlbum = importTarget && typeof importTarget.album === "string" && importTarget.album.trim() ? importTarget.album.trim() : null;
  const validTargetAlbumArtist = importTarget && importTarget.albumArtist != null ? String(importTarget.albumArtist).trim() : null;

  const validExistingAlbum = existing && typeof existing.album === "string" && !isInvalidDriveAlbum(existing.album) ? existing.album : null;
  const validMetaAlbum = extractedMeta && typeof extractedMeta.album === "string" && !isInvalidDriveAlbum(extractedMeta.album) ? extractedMeta.album : null;
  const validFolderAlbum = folder && !isInvalidDriveAlbum(folder) ? folder : null;
  const validInferredAlbum = inferred && inferred.album && !isInvalidDriveAlbum(inferred.album) ? inferred.album : null;

  let album = "";
  let albumArtist = "";
  let albumDecisionSource = "fallback";
  let importTargetMismatch = null;

  if (existing && existing.userEdited) {
    // 既存曲かつ手動編集済み: ユーザー編集値を最優先保護（importTarget による無条件上書きを防止）
    album = validExistingAlbum || "Google Drive";
    albumArtist = existing.albumArtist != null ? existing.albumArtist : "";
    albumDecisionSource = "user_edited";
    if (validTargetAlbum && (validTargetAlbum !== album || (validTargetAlbumArtist != null && validTargetAlbumArtist !== albumArtist))) {
      importTargetMismatch = {
        targetAlbum: validTargetAlbum,
        targetAlbumArtist: validTargetAlbumArtist,
        preservedAlbum: album,
        preservedAlbumArtist: albumArtist,
      };
    }
  } else if (validTargetAlbum) {
    // 明示的 importTarget (新規曲、または既存曲で userEdited: false)
    album = validTargetAlbum;
    albumArtist = validTargetAlbumArtist != null ? validTargetAlbumArtist : "";
    albumDecisionSource = "import_target";
  } else if (validMetaAlbum) {
    // 埋め込みタグ
    album = validMetaAlbum;
    albumArtist = (extractedMeta && extractedMeta.albumArtist) || (existing && existing.albumArtist) || "";
    albumDecisionSource = "embedded_tag";
  } else if (existing && validExistingAlbum) {
    // 既存レコード（同一 file ID の過去の保存値）
    album = validExistingAlbum;
    albumArtist = (existing && existing.albumArtist) || "";
    albumDecisionSource = "existing_record";
  } else if (validFolderAlbum) {
    // 親フォルダ名
    album = validFolderAlbum;
    albumArtist = (existing && existing.albumArtist) || "";
    albumDecisionSource = "parent_folder";
  } else if (validInferredAlbum) {
    // ファイル名推測
    album = validInferredAlbum;
    albumArtist = (existing && existing.albumArtist) || "";
    albumDecisionSource = "filename_inference";
  } else {
    // フォールバック
    album = "Google Drive";
    albumArtist = (existing && existing.albumArtist) || "";
    albumDecisionSource = "fallback";
  }

  // 4. その他メタデータ（ユーザー編集時は既存優先）
  const year = (existing && existing.userEdited && existing.year != null ? existing.year : null) ||
    (extractedMeta && extractedMeta.year) ||
    (existing && existing.year) ||
    "";
  const genre = (existing && existing.userEdited && existing.genre != null ? existing.genre : null) ||
    (extractedMeta && extractedMeta.genre) ||
    (existing && existing.genre) ||
    "";
  const trackNo = (existing && existing.userEdited && existing.trackNo != null ? existing.trackNo : null) ||
    (extractedMeta && extractedMeta.trackNo) ||
    (existing && existing.trackNo) ||
    (inferred && inferred.trackNo) ||
    "";
  const discNo = (existing && existing.userEdited && existing.discNo != null ? existing.discNo : null) ||
    (extractedMeta && extractedMeta.discNo) ||
    (existing && existing.discNo) ||
    "";
  const duration = (normResult && normResult.duration) ||
    (extractedMeta && extractedMeta.duration) ||
    (existing && existing.duration) ||
    0;

  // 5. フォーマット・MIME
  const format = normResult ? "mp3" : ((extractedMeta && extractedMeta.format) || formatFromName(file.name) || "unknown");
  const mime = normResult ? "audio/mp3" : ((extractedMeta && extractedMeta.mime) || file.mimeType || mimeFromName(file.name));

  // 6. アートワーク（手動変更済み、または明示削除済みの場合はそれを厳格に保護）
  const hasUserArtwork = Boolean(
    existing &&
    (existing.artworkUpdatedAt ||
      existing._noEmbeddedArt ||
      (existing.userEdited && (existing.artworkDataUrl || existing.artworkBlob)))
  );
  const artworkBlob = hasUserArtwork
    ? (existing.artworkBlob || null)
    : ((extractedMeta && extractedMeta.artworkBlob) || (existing && existing.artworkBlob) || null);
  const artworkDataUrl = hasUserArtwork
    ? (existing.artworkDataUrl || "")
    : ((extractedMeta && extractedMeta.artworkDataUrl) || (existing && existing.artworkDataUrl) || "");
  const _noEmbeddedArt = hasUserArtwork
    ? Boolean(existing._noEmbeddedArt)
    : false;
  const artworkUpdatedAt = hasUserArtwork
    ? existing.artworkUpdatedAt
    : undefined;

  // 7. トラックレコードの組み立て
  // 実体変更の検知 (サイズまたは更新日時の相違)
  const remoteSize = parseInt(file.size, 10) || 0;
  const existingSize = existing ? (existing.fileSize || 0) : 0;
  const sizeChanged = Boolean(remoteSize && existingSize && remoteSize !== existingSize);
  const remoteMod = file.modifiedTime || "";
  const existingMod = existing ? (existing.driveModifiedTime || "") : "";
  const modChanged = Boolean(remoteMod && existingMod && remoteMod !== existingMod);
  const fileContentChanged = sizeChanged || modChanged;

  // 以前のキャッシュを安全に引き継げるのは「実体変更がない場合」のみ
  const retainExistingCache = Boolean(existing && existing.cached && !fileContentChanged);
  const cached = Boolean(isCached || retainExistingCache);

  const track = {
    id: trackId,
    title,
    artist,
    album,
    albumArtist,
    year,
    genre,
    trackNo,
    discNo,
    duration,
    mime,
    format,
    addedAt: existing ? (existing.addedAt || Date.now()) : Date.now(),
    playCount: existing ? (existing.playCount || 0) : 0,
    lastPlayedAt: existing ? (existing.lastPlayedAt || 0) : 0,
    enabled: existing ? (existing.enabled !== false) : true,
    loved: existing ? Boolean(existing.loved) : false,
    fileSize: (blob && blob.size) || parseInt(file.size, 10) || (existing && existing.fileSize) || 0,
    originalName: file.name,
    artworkBlob,
    artworkDataUrl,
    _noEmbeddedArt,
    source: "gdrive",
    driveFileId: file.id,
    cached,
  };

  if (artworkUpdatedAt) track.artworkUpdatedAt = artworkUpdatedAt;
  if (existing && existing.rating != null) track.rating = existing.rating;
  if (existing && existing.memo != null) track.memo = existing.memo;
  if (existing && existing.keyShift != null) track.keyShift = existing.keyShift;
  if (existing && typeof existing.order === "number") track.order = existing.order;
  if (existing && existing.lyrics) {
    track.lyrics = existing.lyrics;
  } else if (extractedMeta && extractedMeta.lyrics) {
    track.lyrics = extractedMeta.lyrics;
  }
  if (existing && existing.userEdited) {
    track.userEdited = true;
  }
  if (file.modifiedTime) {
    track.driveModifiedTime = file.modifiedTime;
  } else if (existing && existing.driveModifiedTime) {
    track.driveModifiedTime = existing.driveModifiedTime;
  }

  if (normResult) {
    track.normalized = true;
    track.normalizedGainDb = normResult.gainDb;
    track.normalizedAt = Date.now();
    track.originalRmsDb = normResult.sourceLoudness?.rmsDb;
    track.originalPeakDb = normResult.sourceLoudness?.peakDb;
    track.normalizedRmsDb = normResult.finalRmsDb;
    track.normalizedPeakDb = normResult.finalPeakDb;
  } else if (existing && existing.normalized) {
    track.normalized = existing.normalized;
    track.normalizedGainDb = existing.normalizedGainDb;
    track.normalizedAt = existing.normalizedAt;
    track.originalRmsDb = existing.originalRmsDb;
    track.originalPeakDb = existing.originalPeakDb;
    track.normalizedRmsDb = existing.normalizedRmsDb;
    track.normalizedPeakDb = existing.normalizedPeakDb;
  }

  // 8. アルバム分類診断情報の構築（機密情報を除外）
  const driveFileIdSuffix = file && file.id ? String(file.id).slice(-6) : "";
  const diagnosis = {
    fileName: file?.name || "",
    driveFileIdSuffix,
    embeddedAlbum: extractedMeta?.album || null,
    embeddedAlbumArtist: extractedMeta?.albumArtist || null,
    existingAlbum: existing?.album || null,
    existingAlbumArtist: existing?.albumArtist || null,
    existingUserEdited: Boolean(existing?.userEdited),
    inferredAlbum: inferred?.album || null,
    parentFolderName: folder || null,
    selectedTargetAlbum: validTargetAlbum,
    selectedTargetAlbumArtist: validTargetAlbumArtist,
    albumDecisionSource,
    normalizedAlbumKey: getAlbumKey(track),
    finalAlbumGroupKey: getAlbumKey(track),
    finalAlbum: track.album,
    finalAlbumArtist: getAlbumArtist(track),
  };
  if (importTargetMismatch) {
    diagnosis.importTargetMismatch = importTargetMismatch;
  }
  track._importDiagnosis = diagnosis;

  return track;
}

/**
 * 選択した Drive ファイル群を IndexedDB ライブラリにインポート
 * - サポート確認済み形式のみインポートし、未対応形式は除外して failures に記録
 * - 同一 Drive file ID の既存曲がある場合はユーザー設定（再生回数、お気に入り、評価、歌詞、キー変更、カスタム画像等）を完全保持
 * - 削除済みアイテム (Tombstone) をユーザーが明示的に再インポートした場合は Tombstone を安全に解除
 * - 詳細な構造化戻り値 { selected, discovered, attempted, added, updated, skippedSameFile, restored, failed, unsupported, tombstoned, partialFolders, failures } を返却
 * @param {Array<object>} driveFiles
 * @param {{ cacheBlobs?: boolean, normalizeAudio?: boolean, defaultAlbumName?: string, onProgress?: (current: number, total: number, file: object) => void }} [opts]
 * @returns {Promise<{ selected: number, discovered: number, attempted: number, added: number, updated: number, skippedSameFile: number, restored: number, failed: number, unsupported: number, tombstoned: number, partialFolders: number, failures: Array<object> }>}
 */
export async function importDriveFilesToLibrary(driveFiles, { cacheBlobs = false, normalizeAudio = false, defaultAlbumName = "", importTarget = null, onProgress } = {}) {
  let added = 0;
  let updated = 0;
  let restored = 0;
  let failed = 0;
  let unsupported = 0;
  let tombstoned = 0;
  const skippedSameFile = 0;
  let attempted = 0;
  const failures = [];
  const selected = Array.isArray(driveFiles) ? driveFiles.length : 0;
  const discovered = selected;
  let partialFolders = 0;

  const allExistingTracks = await getAllTracks().catch(() => []);
  const existingByIdMap = new Map();
  const existingByDriveIdMap = new Map();
  for (const t of allExistingTracks) {
    if (t && t.id) existingByIdMap.set(t.id, t);
    if (t && t.driveFileId) existingByDriveIdMap.set(t.driveFileId, t);
  }

  for (let i = 0; i < driveFiles.length; i++) {
    const file = driveFiles[i];
    if (typeof onProgress === "function") {
      onProgress(i + 1, driveFiles.length, file);
    }

    // 1. サポート音声形式チェック (形式外は attempted に含めず unsupported として除外)
    if (!isSupportedDriveAudioFile(file)) {
      unsupported++;
      failures.push({
        name: file?.name || "unknown",
        stage: "format_check",
        errorCode: "UNSUPPORTED_FORMAT",
        message: `非対応または未確認の音声形式です (${file?.mimeType || getFileExtension(file?.name)})`,
      });
      continue;
    }

    // 実際に保存処理へ進む件数をカウント (attempted)
    attempted++;

    try {
      const trackId = trackIdFromDriveFileId(file.id);
      // 同一 Drive file ID の既存レコードのみを引き継ぐ（別ファイルIDの曲は絶対に引き継がない！）
      let existing = existingByIdMap.get(trackId) || existingByDriveIdMap.get(file.id) || (await getTrack(trackId).catch(() => null));
      const isExisting = Boolean(existing);

      // 実体変更の検知
      const remoteSize = parseInt(file.size, 10) || 0;
      const existingSize = existing ? (existing.fileSize || 0) : 0;
      const sizeChanged = Boolean(remoteSize && existingSize && remoteSize !== existingSize);
      const remoteMod = file.modifiedTime || "";
      const existingMod = existing ? (existing.driveModifiedTime || "") : "";
      const modChanged = Boolean(remoteMod && existingMod && remoteMod !== existingMod);
      const fileContentChanged = sizeChanged || modChanged;

      // Tombstone の事前検知（※この時点では解除しない！putTrack 成功後にのみ解除する）
      const wasTombstoned = isTombstoned(trackId, 0, "track");
      if (wasTombstoned) {
        tombstoned++;
      }

      const folder = file.folderName || defaultAlbumName || "";
      const inferred = inferMetadataFromFileName(file.name, folder);

      const shouldFetchBlob = cacheBlobs || normalizeAudio;

      if (shouldFetchBlob) {
        // Blob をダウンロードして完全メタデータを抽出
        let blob = await fetchDriveAudioBlob(file.id);
        let normResult = null;
        if (normalizeAudio) {
          if (typeof onProgress === "function") {
            onProgress(i + 1, driveFiles.length, { ...file, name: `${file.name} (🔊 音量ノーマライズ中…)` });
          }
          try {
            const pub = getPublic();
            const ref = pub.normalizeReferenceTrack;
            const targetRmsDb = (ref && typeof ref.rmsDb === "number")
              ? ref.rmsDb
              : (typeof pub.normalizeTargetRms === "number" ? pub.normalizeTargetRms : -14.0);
            normResult = await processAudioNormalization(blob, {
              track: { ...file, title: inferred.title, artist: inferred.artist, album: folder },
              targetRmsDb,
            });
            if (normResult && (normResult.normalizedBlob || normResult.blob)) {
              blob = normResult.normalizedBlob || normResult.blob;
            }
          } catch (normErr) {
            console.warn("[drive-service] 音量ノーマライズ失敗、元音源を使用します:", normErr);
          }
        }

        const meta = await extractMetadata(blob, file.name);
        let duration = meta.duration;
        if ((!duration || duration <= 0) && typeof document !== "undefined") {
          duration = await readDurationViaAudio(blob);
        }
        if (duration > 0 && (!meta.duration || meta.duration <= 0)) {
          meta.duration = duration;
        }

        const track = buildDriveTrackRecord({
          file,
          existing,
          extractedMeta: meta,
          inferred,
          folder,
          normResult,
          blob,
          isCached: true,
          importTarget,
        });

        // 3. putTrack 実行
        await putTrack(track, blob);

        // 4. putTrack 成功確認後にのみ同一 track ID の Tombstone を安全に解除
        if (wasTombstoned) {
          const didRemove = removeTombstone(trackId, "track");
          if (didRemove) {
            restored++;
          } else {
            console.warn(`[drive-service] ⚠️ 曲 ${trackId} の Tombstone 解除に失敗しました`);
            failures.push({
              name: file?.name || "unknown",
              stage: "tombstone_restore",
              errorCode: "TOMBSTONE_REMOVE_FAILED",
              message: "トラック保存後のTombstone解除に失敗しました。次回同期で再削除される恐れがあります",
            });
          }
        }

        if (track._importDiagnosis) {
          _importAlbumDiagnoses.push(track._importDiagnosis);
          if (_importAlbumDiagnoses.length > MAX_DIAGNOSES) {
            _importAlbumDiagnoses.shift();
          }
        }

        existingByIdMap.set(track.id, track);
        existingByDriveIdMap.set(file.id, track);
        if (isExisting) {
          updated++;
        } else {
          added++;
        }
      } else {
        // メタデータレコードを作成（音源 Blob は再生時にオンデマンドで取得・ストリーミング）
        let extractedMeta = null;
        try {
          const headerBlob = await fetchDriveAudioHeader(file.id, 1572864, parseInt(file.size, 10) || 0);
          if (headerBlob && headerBlob.size > 0) {
            extractedMeta = await extractMetadata(headerBlob, file.name);
          }
        } catch (e) {
          console.warn("[drive-service] 先頭ヘッダメタデータ抽出失敗、推測へフォールバック:", file.name, e);
        }

        const track = buildDriveTrackRecord({
          file,
          existing,
          extractedMeta,
          inferred,
          folder,
          normResult: null,
          blob: null,
          isCached: false,
          importTarget,
        });

        // 実体変更があり今回Blobを取得しない場合は、古いキャッシュBlobを削除して不整合を防止
        if (fileContentChanged && existing && existing.cached) {
          await deleteCachedBlob(track.id).catch((delErr) => {
            console.warn("[drive-service] 古いBlobキャッシュ削除失敗:", delErr);
          });
        }

        // 3. putTrack 実行
        await putTrack(track, null);

        // 4. putTrack 成功確認後にのみ同一 track ID の Tombstone を安全に解除
        if (wasTombstoned) {
          const didRemove = removeTombstone(trackId, "track");
          if (didRemove) {
            restored++;
          } else {
            console.warn(`[drive-service] ⚠️ 曲 ${trackId} の Tombstone 解除に失敗しました`);
            failures.push({
              name: file?.name || "unknown",
              stage: "tombstone_restore",
              errorCode: "TOMBSTONE_REMOVE_FAILED",
              message: "トラック保存後のTombstone解除に失敗しました。次回同期で再削除される恐れがあります",
            });
          }
        }

        if (track._importDiagnosis) {
          _importAlbumDiagnoses.push(track._importDiagnosis);
          if (_importAlbumDiagnoses.length > MAX_DIAGNOSES) {
            _importAlbumDiagnoses.shift();
          }
        }

        existingByIdMap.set(track.id, track);
        existingByDriveIdMap.set(file.id, track);
        if (isExisting) {
          updated++;
        } else {
          added++;
        }
      }
    } catch (e) {
      console.warn("[drive-service] インポート失敗:", file?.name, e);
      failed++;
      const safeErr = sanitizeDriveSafeError(e, {
        folderName: file?.folderName || defaultAlbumName || "",
        folderId: file?.id || "",
        stage: "import",
      });
      failures.push({
        name: file?.name || "unknown",
        stage: safeErr.stage,
        errorCode: safeErr.errorCode,
        message: safeErr.message,
      });
    }

    // イベントループに譲る
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    selected,
    discovered,
    attempted,
    added,
    updated,
    skippedSameFile,
    restored,
    failed,
    unsupported,
    tombstoned,
    partialFolders,
    failures,
    diagnoses: [..._importAlbumDiagnoses],
    importTarget: importTarget || null,
  };
}

function stripExt(name) {
  return String(name || "").replace(/\.[^./\\]+$/, "");
}

/**
 * Google Drive インポートモーダルを表示
 * @param {{ onImported?: (res?: object) => void, importTarget?: object|null }} [opts]
 */
export async function openDriveImportModal({ onImported, importTarget = null } = {}) {
  const isConnected = await isDriveConnected();
  const pub = getPublic();

  const container = document.createElement("div");
  container.className = "drive-import-container";

  if (!isConnected) {
    // 未接続画面
    container.innerHTML = `
      <div style="font-size: 13px; color: var(--fg-muted); line-height: 1.6; margin-bottom: 16px;">
        Google Drive 内の音源（MP3, M4A, FLAC 等）をライブラリに追加して再生できます。<br/>
        以下のいずれかの方法で接続してください。
      </div>

      <div style="background: var(--bg-surface); padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid var(--border-color);">
        <h4 style="margin: 0 0 8px 0; font-size: 14px;">方法 1: Google アカウントでログイン (OAuth)</h4>
        <div class="modal-row" style="margin-bottom: 8px;">
          <label for="drive-client-id" style="font-size: 12px;">Google Cloud Client ID</label>
          <input type="text" id="drive-client-id" value="${escapeAttr(pub.gdriveClientId || "")}" placeholder="例: 123456789-xxx.apps.googleusercontent.com" style="font-size: 12px;" />
        </div>
        <div style="font-size: 11px; color: var(--fg-muted); margin-bottom: 10px; line-height: 1.4;">
          💡 <strong>403エラーが出る場合:</strong> Google Cloud Console で「Google Drive API」が未有効です。<a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:underline;">こちら</a> を開いて「有効にする」を1回クリックしてください。
        </div>
        <button class="btn primary" id="btn-drive-gis-login" style="width: 100%;">
          🔑 Google アカウントでログイン
        </button>
      </div>

      <div style="background: var(--bg-surface); padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid var(--border-color);">
        <h4 style="margin: 0 0 8px 0; font-size: 14px;">方法 2: Access Token を直接入力 (Client ID 設定不要)</h4>
        <div style="font-size: 11px; color: var(--fg-muted); margin-bottom: 8px; line-height: 1.4;">
          Google Cloud の設定を省略したい場合、<a href="https://developers.google.com/oauthplayground" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:underline;">OAuth 2.0 Playground</a> で <code>drive.readonly</code> の一時トークンを発行して貼り付けるだけで即座に接続できます。
        </div>
        <div class="modal-row" style="margin-bottom: 8px;">
          <input type="password" id="drive-direct-token" placeholder="ya29.a0AfH6SM..." style="font-size: 12px;" />
        </div>
        <button class="btn" id="btn-drive-direct-connect" style="width: 100%;">
          ⚡ トークンで接続
        </button>
      </div>
    `;

    openModal({
      title: "☁ Google Drive 連携",
      body: container,
      actions: [{ label: "閉じる", onClick: () => {} }],
    });

    // 方法1 ハンドラ
    const gisBtn = container.querySelector("#btn-drive-gis-login");
    gisBtn.addEventListener("click", async () => {
      const clientId = container.querySelector("#drive-client-id").value.trim();
      if (!clientId) {
        toast("Google Client ID を入力してください", "err");
        return;
      }
      gisBtn.disabled = true;
      gisBtn.textContent = "接続中…";
      try {
        await requestGisToken(clientId);
        toast("Google Drive に接続しました", "ok");
        // モーダルを再表示（接続済み画面へ遷移）
        const closeBtn = document.querySelector(".modal-close");
        if (closeBtn) closeBtn.click();
        openDriveImportModal({ onImported, importTarget });
      } catch (err) {
        toast(err.message, "err");
        gisBtn.disabled = false;
        gisBtn.textContent = "🔑 Google アカウントでログイン";
      }
    });

    // 方法2 ハンドラ
    const directBtn = container.querySelector("#btn-drive-direct-connect");
    directBtn.addEventListener("click", async () => {
      const token = container.querySelector("#drive-direct-token").value.trim();
      if (!token) {
        toast("アクセストークンを入力してください", "err");
        return;
      }
      directBtn.disabled = true;
      directBtn.textContent = "テスト中…";
      try {
        const test = await testConnection(token);
        if (!test.ok) {
          toast(test.error || "トークンの検証に失敗しました", "err");
          directBtn.disabled = false;
          directBtn.textContent = "⚡ トークンで接続";
          return;
        }
        const actualEmail = (test.user && test.user.emailAddress) ? test.user.emailAddress.trim() : "";
        const actualName = (test.user && test.user.displayName) ? test.user.displayName.trim() : "";
        const email = actualEmail || actualName || "";
        setPublic({ gdriveUserEmail: email, gdriveUserDisplayName: actualName });
        await setDriveToken(token, { expiresIn: 3600, email, displayName: actualName });
        toast(`Google Drive に接続しました (${email || "OK"})`, "ok");
        const closeBtn = document.querySelector(".modal-close");
        if (closeBtn) closeBtn.click();
        openDriveImportModal({ onImported, importTarget });
      } catch (err) {
        toast(err.message, "err");
        directBtn.disabled = false;
        directBtn.textContent = "⚡ トークンで接続";
      }
    });

    return;
  }

  // 接続済み画面：フォルダ階層ナビゲーション & 一括追加
  let currentFolderId = "root";
  let currentFolderName = "マイドライブ";
  let breadcrumbs = [{ id: "root", name: "マイドライブ" }];
  let currentSearch = "";
  let displayedItems = [];
  let selectedFileIds = new Set();
  let currentNextPageToken = null;
  let existingTrackIds = new Set();
  try {
    const existing = await getAllTracks();
    existingTrackIds = new Set(existing.map((t) => t.id));
  } catch {}

  const accountLabel = pub.gdriveUserEmail || pub.gdriveUserDisplayName || "";
  const emailDisplay = accountLabel ? ` (${escapeHtml(accountLabel)})` : "";

  const targetBannerHtml = (importTarget && importTarget.album)
    ? `<div style="background: rgba(70, 79, 235, 0.08); border: 1px solid rgba(70, 79, 235, 0.25); border-radius: 6px; padding: 6px 10px; font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <div>
          <span style="font-weight: 600; color: var(--accent);">追加先アルバム:</span>
          <span style="margin-left: 4px; font-weight: 500;">${escapeHtml(importTarget.album)}</span>
          ${importTarget.albumArtist ? `<span style="color: var(--fg-muted); font-size: 11px; margin-left: 4px;">(${escapeHtml(importTarget.albumArtist)})</span>` : ""}
        </div>
      </div>`
    : "";

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <!-- 接続ヘッダー -->
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; flex-wrap: wrap; gap: 6px;">
        <div id="drive-modal-account-status">
          <span style="color: var(--success); font-weight: bold;">● 接続中</span><span id="drive-modal-account-label">${emailDisplay}</span>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn" id="btn-drive-switch-account" style="padding: 2px 8px; font-size: 11px;">🔄 アカウントを選び直す</button>
          <button class="btn danger" id="btn-drive-disconnect" style="padding: 2px 8px; font-size: 11px;">Drive連携を解除</button>
        </div>
      </div>

      ${targetBannerHtml}

      <!-- 検索バー -->
      <div style="display: flex; gap: 6px;">
        <input type="search" id="drive-search-input" placeholder="Google Drive 内を検索 (曲名・フォルダ名)…" style="flex: 1; font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
        <button class="btn" id="btn-drive-search" style="padding: 6px 12px; font-size: 12px;">検索</button>
      </div>

      <!-- ナビゲーション（戻るボタン & パンくずリスト） -->
      <div style="display: flex; align-items: center; gap: 6px;">
        <button class="btn" id="btn-drive-back" style="padding: 4px 10px; font-size: 11px; white-space: nowrap;" title="上の階層へ戻る" disabled>
          ◀ 戻る
        </button>
        <div id="drive-breadcrumbs" style="flex: 1; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; padding: 4px 8px; background: var(--bg-surface); border-radius: 6px; border: 1px solid var(--border-color); min-height: 28px;"></div>
      </div>

      <!-- アクションバー -->
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn primary" id="btn-drive-import-folder" style="padding: 4px 10px; font-size: 11px; white-space: nowrap;" title="現在のフォルダ内（サブフォルダ含む）の全音源を一括追加">
            📂 このフォルダの曲を全追加
          </button>
          <button class="btn" id="btn-drive-select-all" style="padding: 4px 8px; font-size: 11px;">全選択</button>
          <button class="btn" id="btn-drive-unselect-all" style="padding: 4px 8px; font-size: 11px;">全解除</button>
        </div>
        <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; user-select: none;">
            <input type="checkbox" id="chk-drive-normalize" />
            <span title="インポート時に音量を基準曲（または標準音量）に合わせて自動調整します">🔊 音量ノーマライズ</span>
          </label>
          <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; user-select: none;">
            <input type="checkbox" id="chk-drive-cache-now" />
            <span title="チェックを外すと本体ストレージを消費せず、再生時に直接ストリーミングします">即時キャッシュ (OFFで容量0)</span>
          </label>
        </div>
      </div>

      <!-- アイテム一覧領域 -->
      <div id="drive-file-list" style="max-height: 360px; min-height: 220px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-surface); padding: 4px;">
        <div style="padding: 30px; text-align: center; color: var(--fg-muted); font-size: 12px;">
          読み込み中…
        </div>
      </div>

      <!-- 進捗表示 -->
      <div id="drive-import-progress" style="font-size: 12px; color: var(--accent); font-weight: 500; display: none; padding: 4px 0;"></div>
    </div>
  `;

  openModal({
    title: "☁ Google Drive から追加",
    body: container,
    actions: [
      { label: "閉じる", onClick: () => true },
      {
        label: "選択した曲を追加 (0件)",
        primary: true,
        onClick: async () => {
          const selectedFiles = displayedItems.filter(
            (it) => it.mimeType !== "application/vnd.google-apps.folder" && selectedFileIds.has(it.id)
          );

          if (selectedFiles.length === 0) {
            toast("インポートする曲を選択するか、【このフォルダの曲を全追加】を押してください", "err");
            return false;
          }

          const normalizeNow = !!container.querySelector("#chk-drive-normalize")?.checked;
          const cacheNow = normalizeNow || !!container.querySelector("#chk-drive-cache-now")?.checked;
          const progressEl = container.querySelector("#drive-import-progress");
          progressEl.style.display = "block";
          progressEl.textContent = `追加中 0 / ${selectedFiles.length}…`;

          const importBtn = document.querySelector(".modal-actions .btn.primary");
          if (importBtn) {
            importBtn.disabled = true;
            importBtn.textContent = "インポート中…";
          }

          try {
            const importRes = await importDriveFilesToLibrary(selectedFiles, {
              cacheBlobs: cacheNow,
              normalizeAudio: normalizeNow,
              defaultAlbumName: currentFolderName,
              importTarget,
              onProgress: (cur, tot, file) => {
                progressEl.textContent = `追加中 ${cur} / ${tot}: ${escapeHtml(file.name)}…`;
              },
            });

            const { added, updated, failed, unsupported, attempted } = importRes;
            const totalSuccess = (added || 0) + (updated || 0);
            const totalFailed = (failed || 0) + (unsupported || 0);

            if (totalFailed === 0) {
              if (importTarget && importTarget.album) {
                if (updated > 0 && added > 0) {
                  toast(`✅ ${added}曲を追加、${updated}曲を更新しました\n追加先：${importTarget.album}`, "ok");
                } else if (updated > 0 && added === 0) {
                  toast(`✅ ${updated}曲を更新しました\n追加先：${importTarget.album}`, "ok");
                } else {
                  toast(`✅ ${added}曲を追加しました\n追加先：${importTarget.album}`, "ok");
                }
              } else {
                if (updated > 0 && added > 0) {
                  toast(`✅ ${added} 曲を追加、${updated} 曲を更新しました`, "ok");
                } else if (updated > 0 && added === 0) {
                  toast(`✅ ${updated} 曲を更新しました`, "ok");
                } else {
                  toast(`✅ ${added} 曲を追加しました`, "ok");
                }
              }
            } else if (totalSuccess > 0) {
              const targetNote = importTarget && importTarget.album ? ` (追加先: ${importTarget.album})` : "";
              toast(`⚠️ ${attempted} 曲中 ${totalSuccess} 曲を追加しました${targetNote}。${totalFailed} 曲は追加できませんでした`, "warn");
            } else {
              toast("❌ 曲を追加できませんでした", "err");
            }

            for (const f of selectedFiles) {
              existingTrackIds.add(trackIdFromDriveFileId(f.id));
            }
            selectedFileIds.clear();
            renderItems(displayedItems, false);
            updateCount();
            if (typeof onImported === "function") onImported(importRes);
            progressEl.textContent = totalFailed > 0
              ? `⚠️ ${totalSuccess} 件を追加/更新、${totalFailed} 件失敗しました。続けて別のフォルダや曲もインポートできます`
              : `✅ ${totalSuccess} 件を追加/更新しました！続けて別のフォルダや曲もインポートできます`;
          } catch (err) {
            toast(`インポート中にエラーが発生しました: ${err.message}`, "err");
            progressEl.style.display = "none";
          } finally {
            if (importBtn) {
              importBtn.disabled = false;
              importBtn.textContent = "選択した曲を追加 (0件)";
            }
          }
          // モーダルを閉じずに連続インポートを許可
          return false;
        },
      },
    ],
  });

  const fileListEl = container.querySelector("#drive-file-list");
  const chkNormalize = container.querySelector("#chk-drive-normalize");
  const chkCache = container.querySelector("#chk-drive-cache-now");
  if (chkNormalize && chkCache) {
    chkNormalize.addEventListener("change", () => {
      if (chkNormalize.checked) {
        chkCache.checked = true;
      }
    });
  }

  // カウント更新
  const updateCount = () => {
    const audioFiles = displayedItems.filter((it) => it.mimeType !== "application/vnd.google-apps.folder");
    let checkedCount = 0;
    for (const f of audioFiles) {
      if (selectedFileIds.has(f.id)) checkedCount++;
    }
    const btn = document.querySelector(".modal-actions .btn.primary");
    if (btn) btn.textContent = `選択した曲を追加 (${checkedCount}件)`;
  };

  // 戻るボタンの更新 & ハンドラ
  const backBtn = container.querySelector("#btn-drive-back");
  const updateBackButton = () => {
    if (!backBtn) return;
    if (currentSearch) {
      backBtn.disabled = false;
      backBtn.textContent = "◀ 戻る";
      backBtn.title = "検索を解除して元のフォルダへ戻る";
    } else {
      backBtn.disabled = breadcrumbs.length <= 1;
      backBtn.textContent = "◀ 戻る";
      backBtn.title = breadcrumbs.length > 1 ? "上の階層へ戻る" : "最上位階層（マイドライブ）です";
    }
  };

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (currentSearch) {
        currentSearch = "";
        const searchInput = container.querySelector("#drive-search-input");
        if (searchInput) searchInput.value = "";
        loadFolder(currentFolderId, false);
        return;
      }
      if (breadcrumbs.length > 1) {
        breadcrumbs.pop();
        const parent = breadcrumbs[breadcrumbs.length - 1];
        currentFolderId = parent.id;
        currentFolderName = parent.name;
        loadFolder(currentFolderId, false);
      }
    });
  }

  // パンくずリスト描画
  const renderBreadcrumbs = () => {
    updateBackButton();
    const crumbsEl = container.querySelector("#drive-breadcrumbs");
    if (!crumbsEl) return;
    if (currentSearch) {
      crumbsEl.innerHTML = `
        <span style="color:var(--accent); font-weight:600;">🔍 検索結果: "${escapeHtml(currentSearch)}"</span>
        <button class="btn" id="btn-clear-search" style="padding:2px 8px; font-size:11px; margin-left:auto;">✕ 解除</button>
      `;
      crumbsEl.querySelector("#btn-clear-search")?.addEventListener("click", () => {
        currentSearch = "";
        const searchInput = container.querySelector("#drive-search-input");
        if (searchInput) searchInput.value = "";
        loadFolder(currentFolderId, false);
      });
      return;
    }

    crumbsEl.innerHTML = breadcrumbs.map((b, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      if (isLast) {
        return `<span style="font-weight:600; color:var(--fg);">${escapeHtml(b.name)}</span>`;
      }
      return `
        <a href="#" class="drive-crumb-link" data-idx="${idx}" style="color:var(--accent); text-decoration:none;">${escapeHtml(b.name)}</a>
        <span style="color:var(--fg-muted); margin:0 2px;">/</span>
      `;
    }).join("");

    crumbsEl.querySelectorAll(".drive-crumb-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const idx = parseInt(link.dataset.idx, 10);
        const target = breadcrumbs[idx];
        breadcrumbs = breadcrumbs.slice(0, idx + 1);
        currentFolderId = target.id;
        currentFolderName = target.name;
        loadFolder(currentFolderId, false);
      });
    });
  };

  // フォルダ内の曲を一括追加ハンドラ
  const handleImportFolder = async (folderId, folderName) => {
    const progressEl = container.querySelector("#drive-import-progress");
    progressEl.style.display = "block";
    progressEl.textContent = `フォルダ「${folderName}」を探索中…`;

    const folderBtn = container.querySelector("#btn-drive-import-folder");
    if (folderBtn) folderBtn.disabled = true;

    try {
      const folderRes = await fetchFolderAudioFilesRecursive(folderId, {
        onProgress: (msg) => { progressEl.textContent = msg; },
      });

      // 1. 中断時の処理（エラーとみなさずキャンセルとして扱う）
      if (folderRes.aborted) {
        toast("フォルダ探索をキャンセルしました", "info");
        progressEl.style.display = "none";
        if (folderBtn) folderBtn.disabled = false;
        return;
      }

      // 2. 認証切れ時の専用メッセージ
      if (folderRes.authRequired) {
        toast("Google Driveとの接続が切れています。再接続後、取得できなかったフォルダをもう一度開いてください。", "warn");
      }

      // 3. 部分成功時の詳細通知（失敗フォルダ数・失敗ページ数）
      if (folderRes.partial && !folderRes.authRequired) {
        const failFolderCount = folderRes.failedFolders?.length || 0;
        const failPageCount = folderRes.failedPages?.length || 0;
        const failDetail = failFolderCount > 0 ? ` (失敗: フォルダ ${failFolderCount}件)` : (failPageCount > 0 ? ` (失敗: ページ ${failPageCount}件)` : "");
        toast(`⚠️ フォルダの一部を取得できませんでした${failDetail}。取得できた曲のみ追加します`, "warn");
      }

      const audioFiles = folderRes.files || [];
      if (audioFiles.length === 0) {
        if (!folderRes.authRequired) {
          toast(`フォルダ「${folderName}」内に音源ファイルは見つかりませんでした`, "info");
        }
        progressEl.style.display = "none";
        if (folderBtn) folderBtn.disabled = false;
        return;
      }

      const normalizeNow = !!container.querySelector("#chk-drive-normalize")?.checked;
      const cacheNow = normalizeNow || !!container.querySelector("#chk-drive-cache-now")?.checked;
      progressEl.textContent = `追加中 0 / ${audioFiles.length}…`;

      const importRes = await importDriveFilesToLibrary(audioFiles, {
        cacheBlobs: cacheNow,
        normalizeAudio: normalizeNow,
        defaultAlbumName: folderName,
        importTarget,
        onProgress: (cur, tot, file) => {
          progressEl.textContent = `追加中 ${cur} / ${tot}: ${escapeHtml(file.name)}…`;
        },
      });

      const { added, updated, failed, unsupported, attempted } = importRes;
      const totalSuccess = (added || 0) + (updated || 0);
      const totalFailed = (failed || 0) + (unsupported || 0);

      if (totalFailed === 0) {
        if (importTarget && importTarget.album) {
          if (updated > 0 && added > 0) {
            toast(`✅ ${added}曲を追加、${updated}曲を更新しました\n追加先：${importTarget.album}`, "ok");
          } else if (updated > 0 && added === 0) {
            toast(`✅ ${updated}曲を更新しました\n追加先：${importTarget.album}`, "ok");
          } else {
            toast(`✅ ${added}曲を追加しました\n追加先：${importTarget.album}`, "ok");
          }
        } else {
          if (updated > 0 && added > 0) {
            toast(`✅ ${added} 曲を追加、${updated} 曲を更新しました`, "ok");
          } else if (updated > 0 && added === 0) {
            toast(`✅ ${updated} 曲を更新しました`, "ok");
          } else {
            toast(`✅ 「${folderName}」から ${added} 曲を追加しました`, "ok");
          }
        }
      } else if (totalSuccess > 0) {
        const targetNote = importTarget && importTarget.album ? ` (追加先: ${importTarget.album})` : "";
        toast(`⚠️ ${attempted} 曲中 ${totalSuccess} 曲を追加しました${targetNote}。${totalFailed} 曲は追加できませんでした`, "warn");
      } else {
        toast("❌ 曲を追加できませんでした", "err");
      }

      for (const f of audioFiles) {
        existingTrackIds.add(trackIdFromDriveFileId(f.id));
      }
      renderItems(displayedItems, false);
      if (typeof onImported === "function") onImported(importRes);
    } catch (err) {
      toast(`フォルダ追加エラー: ${err.message}`, "err");
    } finally {
      progressEl.style.display = "none";
      if (folderBtn) folderBtn.disabled = false;
    }
  };

  // アイテム一覧描画
  const renderItems = (items, isAppend = false) => {
    if (!isAppend) {
      displayedItems = items;
    } else {
      displayedItems = displayedItems.concat(items);
    }

    const audioFiles = displayedItems.filter((it) => it.mimeType !== "application/vnd.google-apps.folder");
    const folders = displayedItems.filter((it) => it.mimeType === "application/vnd.google-apps.folder");

    let html = "";

    // 上の階層へ戻るボタン (ルート以外かつ検索中ではない場合)
    if (currentFolderId !== "root" && !currentSearch && !isAppend) {
      html += `
        <div class="drive-go-up" style="display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:6px; cursor:pointer; background:rgba(10,132,255,0.08); margin-bottom:4px; font-size:12px; color:var(--accent); font-weight:600;">
          <span>⬆</span><span>[上のフォルダへ戻る]</span>
        </div>
      `;
    }

    if (displayedItems.length === 0) {
      html += `<div style="padding:28px 16px; text-align:center; color:var(--fg-muted); font-size:12px;">このフォルダには音源やフォルダがありません</div>`;
    } else {
      // フォルダ一覧
      for (const f of folders) {
        html += `
          <div class="drive-folder-row" data-folder-id="${f.id}" data-folder-name="${escapeAttr(f.name)}" style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:6px; margin-bottom:3px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-color); cursor:pointer;">
            <div class="drive-folder-click" style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
              <span style="font-size:18px; line-height:1;">📁</span>
              <div style="flex:1; min-width:0;">
                <div style="font-weight:600; font-size:13px; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(f.name)}</div>
                <div style="font-size:10px; color:var(--fg-muted);">フォルダ (タップして開く)</div>
              </div>
            </div>
            <button class="btn btn-add-folder-quick" data-folder-id="${f.id}" data-folder-name="${escapeAttr(f.name)}" style="padding:4px 8px; font-size:11px; white-space:nowrap; margin-left:8px;" title="このフォルダ内の曲を一括追加">
              ⚡ 一括追加
            </button>
          </div>
        `;
      }

      // 音源ファイル一覧
      for (let i = 0; i < audioFiles.length; i++) {
        const af = audioFiles[i];
        const trackId = trackIdFromDriveFileId(af.id);
        const isAlreadyAdded = existingTrackIds.has(trackId);
        const sizeStr = af.size ? `${(parseInt(af.size, 10) / 1024 / 1024).toFixed(1)} MB` : "";
        const extMatch = af.name.match(/\.([a-zA-Z0-9]+)$/);
        const extStr = extMatch ? extMatch[1].toUpperCase() : "AUDIO";
        const isChecked = selectedFileIds.has(af.id);

        html += `
          <label class="drive-file-row" style="display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:6px; margin-bottom:3px; cursor:pointer; border-bottom:1px solid var(--border-color); font-size:12px;">
            <input type="checkbox" class="drive-file-chk" data-file-id="${af.id}" ${isChecked ? "checked" : ""} style="width:18px; height:18px; cursor:pointer; flex-shrink:0;" />
            <div style="flex:1; min-width:0;">
              <div style="font-weight:500; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${escapeHtml(af.name)}
              </div>
              <div style="font-size:10px; color:var(--fg-muted); display:flex; gap:6px; align-items:center; margin-top:2px;">
                <span style="padding:1px 4px; border-radius:3px; background:rgba(255,255,255,0.08); font-weight:600; font-size:9px;">${extStr}</span>
                <span>${sizeStr}</span>
                ${isAlreadyAdded ? `<span style="color:var(--accent); font-weight:600;">✓ 追加済み</span>` : ""}
              </div>
            </div>
          </label>
        `;
      }
    }

    // さらに読み込むボタン
    if (currentNextPageToken) {
      html += `
        <div style="padding:10px 4px; text-align:center;">
          <button class="btn" id="btn-drive-load-more" style="width:100%; font-size:12px; padding:8px;">
            さらに読み込む (次の100件) ▼
          </button>
        </div>
      `;
    }

    fileListEl.innerHTML = html;
    bindListEvents();
    renderBreadcrumbs();
    updateCount();
  };

  // 一覧内イベント結線
  const bindListEvents = () => {
    // 上の階層へ
    fileListEl.querySelector(".drive-go-up")?.addEventListener("click", () => {
      if (breadcrumbs.length > 1) {
        breadcrumbs.pop();
        const parent = breadcrumbs[breadcrumbs.length - 1];
        currentFolderId = parent.id;
        currentFolderName = parent.name;
        loadFolder(currentFolderId, false);
      }
    });

    // フォルダクリック (展開)
    fileListEl.querySelectorAll(".drive-folder-click").forEach((el) => {
      el.addEventListener("click", () => {
        const row = el.closest(".drive-folder-row");
        const folderId = row.dataset.folderId;
        const folderName = row.dataset.folderName;
        breadcrumbs.push({ id: folderId, name: folderName });
        currentFolderId = folderId;
        currentFolderName = folderName;
        loadFolder(folderId, false);
      });
    });

    // フォルダ横「⚡ 一括追加」
    fileListEl.querySelectorAll(".btn-add-folder-quick").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const folderId = btn.dataset.folderId;
        const folderName = btn.dataset.folderName;
        handleImportFolder(folderId, folderName);
      });
    });

    // 曲チェックボックス
    fileListEl.querySelectorAll(".drive-file-chk").forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const fileId = chk.dataset.fileId;
        if (chk.checked) {
          selectedFileIds.add(fileId);
        } else {
          selectedFileIds.delete(fileId);
        }
        updateCount();
      });
    });

    // さらに読み込む
    fileListEl.querySelector("#btn-drive-load-more")?.addEventListener("click", () => {
      if (currentSearch) {
        searchDrive(currentSearch, true);
      } else {
        loadFolder(currentFolderId, true);
      }
    });
  };

  // フォルダ読み込み
  const loadFolder = async (folderId, isAppend = false) => {
    if (!isAppend) {
      fileListEl.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--fg-muted); font-size: 12px;">読み込み中…</div>`;
      selectedFileIds.clear();
      currentNextPageToken = null;
    }
    try {
      const res = await listDriveItems({
        folderId,
        query: "",
        pageToken: isAppend ? currentNextPageToken : null,
      });
      currentNextPageToken = res.nextPageToken;

      // 新規読み込み時、未追加の音源を自動チェック
      if (!isAppend) {
        for (const item of res.files) {
          if (item.mimeType !== "application/vnd.google-apps.folder") {
            const trackId = trackIdFromDriveFileId(item.id);
            if (!existingTrackIds.has(trackId)) {
              selectedFileIds.add(item.id);
            }
          }
        }
      }

      renderItems(res.files, isAppend);
    } catch (err) {
      renderError(err, () => loadFolder(folderId, isAppend));
    }
  };

  // 全体検索
  const searchDrive = async (q, isAppend = false) => {
    if (!isAppend) {
      fileListEl.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--fg-muted); font-size: 12px;">検索中…</div>`;
      selectedFileIds.clear();
      currentNextPageToken = null;
    }
    try {
      const res = await listDriveItems({
        query: q,
        pageToken: isAppend ? currentNextPageToken : null,
      });
      currentNextPageToken = res.nextPageToken;

      if (!isAppend) {
        for (const item of res.files) {
          if (item.mimeType !== "application/vnd.google-apps.folder") {
            const trackId = trackIdFromDriveFileId(item.id);
            if (!existingTrackIds.has(trackId)) {
              selectedFileIds.add(item.id);
            }
          }
        }
      }

      renderItems(res.files, isAppend);
    } catch (err) {
      renderError(err, () => searchDrive(q, isAppend));
    }
  };

  // エラー描画
  const renderError = (err, onRetry) => {
    const is403 = String(err.message).includes("403");
    fileListEl.innerHTML = `
      <div style="padding: 16px; text-align: left; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 8px; font-size: 12px; line-height: 1.6;">
        <div style="color: var(--err, #ff453a); font-weight: bold; margin-bottom: 8px; font-size: 13px;">
          ⚠️ 一覧の取得に失敗しました
        </div>
        <div style="white-space: pre-wrap; color: var(--fg); margin-bottom: 12px;">${escapeHtml(err.message)}</div>
        ${
          is403
            ? `<div style="background: rgba(10, 132, 255, 0.08); border: 1px solid rgba(10, 132, 255, 0.3); border-radius: 6px; padding: 10px; margin-bottom: 12px; font-size: 11px; line-height: 1.6;">
            <strong style="color: var(--accent);">🛠 解決手順 (Google Cloud Console):</strong><br/>
            1. <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: underline; font-weight: bold;">Google Drive API 有効化ページ</a> をブラウザで開く<br/>
            2. Client ID を作成したプロジェクトが選択されていることを確認<br/>
            3. <strong>【有効にする】</strong> ボタンをクリック<br/>
            4. 反映に数十秒かかる場合があるため、少し待ってから下の【再試行】ボタンを押してください。
          </div>`
            : ""
        }
        <button class="btn primary" id="btn-drive-retry" style="width: 100%; font-size: 12px; padding: 8px;">🔄 もう一度読み込む (再試行)</button>
      </div>
    `;
    fileListEl.querySelector("#btn-drive-retry")?.addEventListener("click", onRetry);
  };

  // 初期読み込み (マイドライブ)
  loadFolder("root", false);

  // 検索ハンドラ
  const searchInput = container.querySelector("#drive-search-input");
  const doSearch = () => {
    const q = searchInput.value.trim();
    if (q) {
      currentSearch = q;
      searchDrive(q, false);
    } else {
      currentSearch = "";
      loadFolder(currentFolderId, false);
    }
  };
  container.querySelector("#btn-drive-search").addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  // 現在フォルダ一括追加ボタン
  container.querySelector("#btn-drive-import-folder").addEventListener("click", () => {
    handleImportFolder(currentFolderId, currentFolderName);
  });

  // 全選択・全解除
  container.querySelector("#btn-drive-select-all").addEventListener("click", () => {
    displayedItems.forEach((it) => {
      if (it.mimeType !== "application/vnd.google-apps.folder") {
        selectedFileIds.add(it.id);
      }
    });
    renderItems(displayedItems, false);
  });
  container.querySelector("#btn-drive-unselect-all").addEventListener("click", () => {
    selectedFileIds.clear();
    renderItems(displayedItems, false);
  });

  // 接続中だがアカウント識別情報が未保存の場合、バックグラウンドで取得して補完
  if (!accountLabel) {
    getDriveToken({ allowSilentRefresh: false })
      .then((tok) => (tok ? testConnection(tok) : null))
      .then((res) => {
        if (res && res.ok && res.user) {
          const email = (res.user.emailAddress || "").trim();
          const name = (res.user.displayName || "").trim();
          const label = email || name || "";
          if (label) {
            setPublic({ gdriveUserEmail: label, gdriveUserDisplayName: name });
            const lblEl = container.querySelector("#drive-modal-account-label");
            if (lblEl) lblEl.textContent = ` (${label})`;
          }
        }
      })
      .catch(() => {});
  }

  // アカウントを選び直す
  container.querySelector("#btn-drive-switch-account")?.addEventListener("click", async () => {
    const switchBtn = container.querySelector("#btn-drive-switch-account");
    const cid = (getPublic()?.gdriveClientId || "").trim();
    if (!cid) {
      await disconnectDrive();
      const closeBtn = document.querySelector(".modal-close");
      if (closeBtn) closeBtn.click();
      openDriveImportModal({ onImported });
      return;
    }
    if (switchBtn) {
      switchBtn.disabled = true;
      switchBtn.textContent = "選択中…";
    }
    try {
      await switchDriveAccount(cid);
      const nextPub = getPublic() || {};
      const nextAcc = nextPub.gdriveUserEmail || nextPub.gdriveUserDisplayName || "OK";
      toast(`Google アカウントを切り替えました (${nextAcc})`, "ok");
      const closeBtn = document.querySelector(".modal-close");
      if (closeBtn) closeBtn.click();
      openDriveImportModal({ onImported });
    } catch (err) {
      toast(err?.message || "アカウントの切り替えに失敗しました", "err");
      if (switchBtn) {
        switchBtn.disabled = false;
        switchBtn.textContent = "🔄 アカウントを選び直す";
      }
    }
  });

  // 切断
  container.querySelector("#btn-drive-disconnect").addEventListener("click", async () => {
    await disconnectDrive();
    toast("Google Drive との接続を解除しました", "ok");
    const closeBtn = document.querySelector(".modal-close");
    if (closeBtn) closeBtn.click();
  });
}

/**
 * Google Drive 上で指定フォルダを検索、存在しなければ自動作成
 * @param {string} [folderName="MUSIC-PLAYER"]
 * @param {string} [parentFolderId=null]
 * @returns {Promise<string>} フォルダID
 */
export async function getOrCreateDriveFolder(folderName = "MUSIC-PLAYER", parentFolderId = null) {
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません");

  // 1. 既存フォルダを検索
  try {
    const query = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false` +
      (parentFolderId ? ` and '${parentFolderId}' in parents` : "");
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
      }
    }
  } catch (searchErr) {
    console.warn("[gdrive] フォルダ検索フォールバック:", searchErr);
  }

  // 2. 存在しなければ作成
  const meta = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentFolderId) {
    meta.parents = [parentFolderId];
  }

  try {
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(meta),
    });

    if (createRes.ok) {
      const created = await createRes.json();
      return created.id;
    }
  } catch (createErr) {
    console.warn("[gdrive] フォルダ作成フォールバック:", createErr);
  }

  return null;
}

/**
 * Google Drive へ音声ファイル (Blob) をアップロード
 * - 多段階アップロードアーキテクチャ:
 *   1. Multipart Upload (Google Drive 公式標準・ブラウザCORS完全対応・1リクエストでメタデータとファイルを同時作成)
 *   2. Simple Media Upload (POST uploadType=media -> PATCH metadata)
 * @param {object|Blob} arg1 引数オブジェクトまたはBlob
 * @param {string} [arg2] ファイル名 (Blob指定時)
 * @param {string} [arg3] MIMEタイプ (Blob指定時)
 * @returns {Promise<{ id: string, name: string, mimeType: string, size?: number }>}
 */
export async function uploadFileToDrive(arg1, arg2 = null, arg3 = null) {
  let name, blob, mimeType, folderName, folderId, onProgress;
  if (arg1 instanceof Blob || (arg1 && arg1.size !== undefined && typeof arg1.slice === "function")) {
    blob = arg1;
    name = (typeof arg2 === "string" ? arg2 : null) || "audio.mp3";
    mimeType = (typeof arg3 === "string" ? arg3 : null) || "audio/mpeg";
    folderName = "MUSIC-PLAYER";
    folderId = null;
    onProgress = null;
  } else if (arg1 && typeof arg1 === "object") {
    ({
      name = "audio.mp3",
      blob,
      mimeType = "audio/mpeg",
      folderName = "MUSIC-PLAYER",
      folderId = null,
      onProgress = null,
    } = arg1);
  } else {
    throw new Error("アップロードするデータが指定されていません");
  }

  const token = await getDriveToken();
  if (!token) {
    throw new Error("Google Drive に接続されていません。設定画面または連携ボタンから接続してください。");
  }

  if (onProgress) onProgress(10);

  // 保存先フォルダの解決
  let targetFolderId = folderId;
  if (!targetFolderId && folderName) {
    try {
      targetFolderId = await getOrCreateDriveFolder(folderName);
    } catch (e) {
      console.warn("[gdrive] フォルダ作成フォールバック:", e);
    }
  }

  if (onProgress) onProgress(20);

  const metadata = {
    name: name || "audio.mp3",
    mimeType: mimeType || "audio/mpeg",
  };
  if (targetFolderId) {
    metadata.parents = [targetFolderId];
  }

  // 方法 1: 2段階アップロード (POST JSON メタデータ作成 -> PATCH uploadType=media でバイナリ書き込み)
  // Google Drive 公式推奨 & 最も CORS 互換性が高く、Safari/Chrome での "Load failed" を完全に防ぐ
  try {
    if (onProgress) onProgress(30);

    const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(metadata),
    });

    if (createRes.status === 401) {
      throw new Error("Google Drive 認証の有効期限が切れています。再接続してください。");
    }

    if (createRes.ok) {
      const createdFile = await createRes.json();
      const fileId = createdFile.id;

      if (onProgress) onProgress(50);

      // バイナリ本体を PATCH でアップロード
      const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": mimeType || "audio/mpeg",
        },
        body: blob,
      });

      if (uploadRes.status === 401) {
        throw new Error("Google Drive 認証の有効期限が切れています。再接続してください。");
      }

      if (uploadRes.ok) {
        if (onProgress) onProgress(100);
        return {
          id: fileId,
          name: createdFile.name || name,
          mimeType: createdFile.mimeType || mimeType,
          size: blob.size,
        };
      } else {
        // メディアアップロード失敗時は空エントリを削除してクリーンアップ
        try {
          await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (_) {}
      }
    }
  } catch (twoStepErr) {
    if (twoStepErr.message && twoStepErr.message.includes("有効期限")) throw twoStepErr;
    console.warn("[gdrive] 2段階アップロード失敗、代替メディアアップロードへ移行:", twoStepErr);
  }

  // 方法 2: Simple Media Upload (POST uploadType=media) + PATCH メタデータ
  if (onProgress) onProgress(60);
  const mediaRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=media", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mimeType || "audio/mpeg",
    },
    body: blob,
  });

  if (!mediaRes.ok) {
    if (mediaRes.status === 401) {
      throw new Error("Google Drive 認証の有効期限が切れています。設定画面から再接続してください。");
    }
    const errMsg = await parseGoogleApiError(mediaRes, "Google Drive アップロード失敗");
    throw new Error(errMsg);
  }

  const fileData = await mediaRes.json();
  const fileId = fileData.id;

  // メタデータ（ファイル名・親フォルダ）の更新
  if (fileId && (name || targetFolderId)) {
    try {
      const patchUrl = targetFolderId
        ? `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${targetFolderId}&fields=id,name,mimeType`
        : `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`;

      await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ name }),
      });
    } catch (patchErr) {
      console.warn("[gdrive] メタデータ更新警告:", patchErr);
    }
  }

  if (onProgress) onProgress(100);
  return {
    id: fileId,
    name: name,
    mimeType: mimeType || "audio/mpeg",
    size: blob.size,
  };
}

/**
 * Google Drive 内の特定名前のファイルを検索
 * @param {string} fileName
 * @param {string} [folderId]
 * @returns {Promise<{ id: string, name: string, modifiedTime?: string, size?: number }|null>}
 */
export async function findDriveFileByName(fileName, folderId = null) {
  const token = await getDriveToken();
  if (!token) return null;

  let q = `trashed = false and name = '${fileName.replace(/'/g, "")}'`;
  if (folderId) {
    q += ` and '${folderId}' in parents`;
  }

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

/**
 * Google Drive 上のテキストファイル (JSON 等) の中身を取得
 * @param {string} fileId
 * @returns {Promise<string>}
 */
export async function fetchDriveTextFile(fileId) {
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません");

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errMsg = await parseGoogleApiError(res, "同期ファイルの取得に失敗しました");
    throw new Error(errMsg);
  }

  return await res.text();
}

/**
 * Google Drive 上の同期ファイル (JSON) を保存または上書き更新
 * @param {string} fileName
 * @param {string} textContent
 * @param {string} [folderName="MUSIC-PLAYER"]
 * @returns {Promise<{ id: string, name: string, modifiedTime: string }>}
 */
export async function saveOrUpdateDriveSyncFile(fileName, textContent, folderName = "MUSIC-PLAYER") {
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません。設定画面から再接続してください。");

  let targetFolderId = null;
  try {
    targetFolderId = await getOrCreateDriveFolder(folderName);
  } catch (fe) {
    console.warn("[gdrive] フォルダ取得警告（ルートを検索・保存対象とします）:", fe);
  }

  let existing = null;
  try {
    existing = await findDriveFileByName(fileName, targetFolderId);
    if (!existing && targetFolderId) {
      existing = await findDriveFileByName(fileName, null);
    }
  } catch (findErr) {
    console.warn("[gdrive] 既存ファイル検索失敗:", findErr);
  }

  const blob = new Blob([textContent], { type: "application/json; charset=utf-8" });

  if (existing && existing.id) {
    try {
      // 既存ファイルを PATCH で上書き更新
      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=media`;
      const res = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: blob,
      });

      if (res.ok) {
        const updated = await res.json();
        return {
          id: existing.id,
          name: fileName,
          modifiedTime: updated.modifiedTime || new Date().toISOString(),
        };
      }
      console.warn(`[gdrive] 既存同期ファイル PATCH 失敗 (HTTP ${res.status})。他端末作成ファイルまたは権限の制約のため新規作成へ自己修復フォールバックします。`);
    } catch (patchErr) {
      console.warn("[gdrive] 同期ファイル PATCH 通信エラー。新規作成へフォールバックします:", patchErr);
    }
  }

  // PATCH 失敗、または既存ファイルがない場合は新規作成
  const uploaded = await uploadFileToDrive({
    name: fileName,
    blob,
    mimeType: "application/json",
    folderId: targetFolderId,
    folderName,
  });

  return {
    id: uploaded.id,
    name: fileName,
    modifiedTime: new Date().toISOString(),
  };
}

