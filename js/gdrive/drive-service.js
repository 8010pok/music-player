/**
 * Google Drive 連携サービス
 *
 * - Google Drive API v3 を使用した音源ファイルの検索・ダウンロード
 * - GIS (Google Identity Services) トークンフローおよび直接アクセストークン入力のサポート
 * - 音源のローカル IndexedDB への事前キャッシュ、または再生時オンデマンド取得
 * - ローカル音源と同一のデータ構造（id: "gd-${fileId}", source: "gdrive"）でライブラリに統合
 */

import { getPublic, setPublic, getSecret, setSecret } from "../store/settings.js";
import { putTrack, getTrack, getAllTracks } from "../store/library-db.js";
import { extractMetadata, readDurationViaAudio } from "../metadata/index.js";
import { formatFromName, mimeFromName } from "../metadata/util.js";
import { openModal, toast, escapeHtml, escapeAttr } from "../ui/components.js";

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
export async function getDriveToken() {
  if (_cachedToken) {
    const pub = getPublic();
    if (!pub.gdriveTokenExpiry || Date.now() < pub.gdriveTokenExpiry - 60000) {
      return _cachedToken;
    }
  }

  const secret = await getSecret();
  const token = secret && secret.gdriveAccessToken ? secret.gdriveAccessToken : null;
  if (!token) {
    _cachedToken = null;
    return null;
  }

  const pub = getPublic();
  // 有効期限が設定されており、かつ切れている場合は null
  if (pub.gdriveTokenExpiry && Date.now() >= pub.gdriveTokenExpiry - 60000) {
    _cachedToken = null;
    return null;
  }

  _cachedToken = token;
  return token;
}

/**
 * アクセストークンを保存
 * @param {string} token
 * @param {{ expiresIn?: number, email?: string }} [opts]
 */
export async function setDriveToken(token, { expiresIn = 3600, email = "" } = {}) {
  _cachedToken = token || null;
  await setSecret({ gdriveAccessToken: token || "" });
  const patch = {
    gdriveTokenExpiry: token && expiresIn ? Date.now() + expiresIn * 1000 : 0,
  };
  if (email !== undefined) patch.gdriveUserEmail = email;
  setPublic(patch);
}

/**
 * Google Drive 連携を切断
 */
export async function disconnectDrive() {
  _cachedToken = null;
  await setSecret({ gdriveAccessToken: "" });
  setPublic({
    gdriveTokenExpiry: 0,
    gdriveUserEmail: "",
  });
}

/**
 * Google Drive が接続中（有効なトークンがある）か判定
 * @returns {Promise<boolean>}
 */
export async function isDriveConnected() {
  const token = await getDriveToken();
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
 * Google Identity Services (GIS) スクリプトを読み込み、トークンを取得
 * @param {string} clientId
 * @returns {Promise<string>}
 */
export function requestGisToken(clientId) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error("Google OAuth Client ID を入力してください"));
      return;
    }

    const loadScript = () => {
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
    };

    loadScript()
      .then(() => {
        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: "https://www.googleapis.com/auth/drive.readonly",
            callback: async (resp) => {
              if (resp.error) {
                reject(new Error(`Google 認証エラー: ${resp.error_description || resp.error}`));
                return;
              }
              if (resp.access_token) {
                const expiresIn = resp.expires_in ? parseInt(resp.expires_in, 10) : 3600;
                // ユーザー情報取得を試行
                const test = await testConnection(resp.access_token);
                const email = (test.ok && test.user && (test.user.emailAddress || test.user.displayName)) || "";
                await setDriveToken(resp.access_token, { expiresIn, email });
                setPublic({ gdriveClientId: clientId });
                resolve(resp.access_token);
              } else {
                reject(new Error("アクセストークンが取得できませんでした"));
              }
            },
            error_callback: (err) => {
              reject(new Error(err && err.message ? err.message : "認証ウィンドウが閉じられたか失敗しました"));
            },
          });
          client.requestAccessToken({ prompt: "" });
        } catch (e) {
          reject(e);
        }
      })
      .catch(reject);
  });
}

/**
 * Google Drive 上のアイテム（フォルダおよび音源ファイル）を検索・一覧取得
 * @param {{ folderId?: string, query?: string, pageToken?: string, pageSize?: number }} [opts]
 * @returns {Promise<{ files: Array<object>, nextPageToken: string|null }>}
 */
export async function listDriveItems({ folderId = "root", query = "", pageToken = null, pageSize = 100 } = {}) {
  const token = await getDriveToken();
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

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 401) {
      await disconnectDrive();
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
 * フォルダ（およびその全サブフォルダ）内の全音源ファイルを再帰的に取得
 * @param {string} rootFolderId
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchFolderAudioFilesRecursive(rootFolderId, { onProgress } = {}) {
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません");

  const audioFiles = [];
  const folderQueue = [{ id: rootFolderId, name: "" }];
  const visitedFolders = new Set([rootFolderId]);

  while (folderQueue.length > 0) {
    const curFolder = folderQueue.shift();
    const curFolderId = curFolder.id;
    const curFolderName = curFolder.name;

    if (typeof onProgress === "function") {
      onProgress(`フォルダを探索中 (検出: ${audioFiles.length} 曲)…`);
    }

    let pageToken = null;
    do {
      const q = `trashed = false and '${curFolderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')`;
      let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=100&fields=nextPageToken,files(id,name,mimeType,size)&orderBy=folder,name`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const data = await res.json();
      const items = data.files || [];
      for (const item of items) {
        if (item.mimeType === "application/vnd.google-apps.folder") {
          if (!visitedFolders.has(item.id)) {
            visitedFolders.add(item.id);
            folderQueue.push({ id: item.id, name: item.name });
          }
        } else {
          item.folderName = curFolderName;
          audioFiles.push(item);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return audioFiles;
}

/**
 * Google Drive 上の音源ファイルを検索・一覧取得
 * @param {{ query?: string, pageToken?: string, pageSize?: number }} [opts]
 * @returns {Promise<{ files: Array<object>, nextPageToken: string|null }>}
 */
export async function listDriveAudioFiles({ query = "", pageToken = null, pageSize = 100 } = {}) {
  const res = await listDriveItems({ query, pageToken, pageSize });
  return {
    files: res.files.filter((f) => f.mimeType !== "application/vnd.google-apps.folder"),
    nextPageToken: res.nextPageToken,
  };
}

/**
 * Google Drive から音源ファイルの Blob をダウンロード (リトライ機能付き)
 * @param {string} fileId
 * @param {{ onProgress?: (loaded: number, total: number) => void, maxRetries?: number }} [opts]
 * @returns {Promise<Blob>}
 */
export async function fetchDriveAudioBlob(fileId, { onProgress, maxRetries = 3 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const token = await getDriveToken();
      if (!token) throw new Error("Google Drive に接続されていません。設定画面で接続してください。");

      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        if (res.status === 401) {
          _cachedToken = null;
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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          onProgress(loaded, total);
        }

        const contentType = res.headers.get("Content-Type") || "audio/mpeg";
        return new Blob(chunks, { type: contentType });
      }

      return await res.blob();
    } catch (err) {
      lastError = err;
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
 * Google Drive から音源ファイルの先頭ヘッダ部分（maxBytes）のみを取得
 * FLAC や MP3 のメタデータ解析をフルダウンロードせず高速に行う（通信量・ストレージ節約）
 * @param {string} fileId
 * @param {number} [maxBytes=262144] 256KB
 * @returns {Promise<Blob|null>}
 */
export async function fetchDriveAudioHeader(fileId, maxBytes = 262144) {
  const token = await getDriveToken();
  if (!token) return null;

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=0-${maxBytes - 1}`,
      },
    });

    if (!res.ok && res.status !== 206) return null;

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
      return new Blob(chunks, { type: contentType });
    }

    return await res.blob();
  } catch (err) {
    console.warn("[drive-service] ヘッダ取得スキップ:", fileId, err);
    return null;
  }
}

/**
 * 音源ファイル名および配置フォルダ名からメタデータを推測
 * 例:
 *  "01. YOASOBI - 夜に駆ける.flac" -> trackNo: "1", artist: "YOASOBI", title: "夜に駆ける"
 *  "YOASOBI - 夜に駆ける.mp3"     -> artist: "YOASOBI", title: "夜に駆ける"
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
  const album = folderName && folderName !== "root" ? folderName : "";

  // パターン 1: "01. Artist - Title" または "01 - Artist - Title" または "01.Artist - Title"
  let match = base.match(/^(\d+)[\s._-]+([^-–—]+)\s*[-–—]\s*(.+)$/);
  if (match) {
    trackNo = String(parseInt(match[1], 10));
    artist = match[2].trim();
    title = match[3].trim();
  } else {
    // パターン 2: "Artist - Title"
    match = base.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
    if (match) {
      artist = match[1].trim();
      title = match[2].trim();
    } else {
      // パターン 3: "01 Title" または "01. Title" または "01_Title"
      match = base.match(/^(\d+)[\s._-]+(.+)$/);
      if (match) {
        trackNo = String(parseInt(match[1], 10));
        title = match[2].trim();
      }
    }
  }

  return {
    title: title || base || "(無題)",
    artist: artist || (album ? album : ""),
    album: album || "",
    trackNo,
  };
}

/**
 * 選択した Drive ファイル群を IndexedDB ライブラリにインポート
 * @param {Array<object>} driveFiles
 * @param {{ cacheBlobs?: boolean, defaultAlbumName?: string, onProgress?: (current: number, total: number, file: object) => void }} [opts]
 * @returns {Promise<{ added: number, failed: number }>}
 */
export async function importDriveFilesToLibrary(driveFiles, { cacheBlobs = false, defaultAlbumName = "", onProgress } = {}) {
  let added = 0;
  let failed = 0;

  for (let i = 0; i < driveFiles.length; i++) {
    const file = driveFiles[i];
    if (typeof onProgress === "function") {
      onProgress(i + 1, driveFiles.length, file);
    }

    try {
      const trackId = trackIdFromDriveFileId(file.id);
      const existing = await getTrack(trackId);
      const folder = file.folderName || defaultAlbumName || "";
      const inferred = inferMetadataFromFileName(file.name, folder);

      if (cacheBlobs) {
        // Blob をダウンロードして完全メタデータを抽出
        const blob = await fetchDriveAudioBlob(file.id);
        const meta = await extractMetadata(blob, file.name);
        let duration = meta.duration;
        if ((!duration || duration <= 0) && typeof document !== "undefined") {
          duration = await readDurationViaAudio(blob);
        }

        const title = meta.title || inferred.title || stripExt(file.name) || "(無題)";
        const artist = (meta.artist && meta.artist !== "(不明アーティスト)") ? meta.artist : (inferred.artist || "(不明アーティスト)");
        const album = (meta.album && meta.album !== "Google Drive") ? meta.album : (inferred.album || "Google Drive");

        const track = {
          id: trackId,
          title,
          artist,
          album,
          albumArtist: meta.albumArtist || "",
          year: meta.year || "",
          genre: meta.genre || "",
          trackNo: meta.trackNo || inferred.trackNo || "",
          discNo: meta.discNo || "",
          duration: duration || 0,
          mime: meta.mime || file.mimeType || mimeFromName(file.name),
          format: meta.format || formatFromName(file.name) || "unknown",
          addedAt: existing ? (existing.addedAt || Date.now()) : Date.now(),
          playCount: existing ? (existing.playCount || 0) : 0,
          lastPlayedAt: existing ? (existing.lastPlayedAt || 0) : 0,
          enabled: existing ? (existing.enabled !== false) : true,
          loved: existing ? !!existing.loved : false,
          fileSize: blob.size || parseInt(file.size, 10) || 0,
          originalName: file.name,
          artworkBlob: meta.artworkBlob || (existing && existing.artworkBlob) || null,
          source: "gdrive",
          driveFileId: file.id,
          cached: true,
        };
        if (existing && typeof existing.order === "number") track.order = existing.order;
        if (existing && existing.userEdited) {
          track.userEdited = true;
          track.title = existing.title || track.title;
          track.artist = existing.artist || track.artist;
          track.album = existing.album || track.album;
          track.albumArtist = existing.albumArtist || track.albumArtist;
        }

        await putTrack(track, blob);
        added++;
      } else {
        // メタデータレコードを作成（音源 Blob は再生時にオンデマンドで取得・ストリーミング）
        // Range リクエストで先頭 256KB のみ取得し、本体ダウンロード（ストレージ消費）なしでメタデータを高速解析
        const format = formatFromName(file.name) || "unknown";
        const mime = file.mimeType || mimeFromName(file.name);

        let extractedMeta = null;
        try {
          const headerBlob = await fetchDriveAudioHeader(file.id, 262144);
          if (headerBlob && headerBlob.size > 0) {
            extractedMeta = await extractMetadata(headerBlob, file.name);
          }
        } catch (e) {
          console.warn("[drive-service] 先頭ヘッダメタデータ抽出失敗、推測へフォールバック:", file.name, e);
        }

        const title =
          (existing && existing.title) ||
          (extractedMeta && extractedMeta.title && extractedMeta.title !== "(無題)" && extractedMeta.title !== stripExt(file.name) ? extractedMeta.title : null) ||
          inferred.title ||
          (extractedMeta && extractedMeta.title) ||
          stripExt(file.name) ||
          "(無題)";

        const artist =
          (existing && existing.artist && existing.artist !== "(Google Drive)") ||
          (extractedMeta && extractedMeta.artist && extractedMeta.artist !== "(不明アーティスト)" && !extractedMeta.artist.includes("Google Drive") ? extractedMeta.artist : null) ||
          (inferred.artist && !inferred.artist.includes("Google Drive") ? inferred.artist : null) ||
          (existing && existing.artist) ||
          "(不明アーティスト)";

        const album =
          (existing && existing.album && existing.album !== "Google Drive") ||
          (extractedMeta && extractedMeta.album && extractedMeta.album !== "Google Drive" ? extractedMeta.album : null) ||
          inferred.album ||
          (file.folderName && file.folderName !== "root" ? file.folderName : null) ||
          (defaultAlbumName && defaultAlbumName !== "root" ? defaultAlbumName : null) ||
          (existing && existing.album) ||
          "Google Drive";

        const albumArtist = (existing && existing.albumArtist) || (extractedMeta && extractedMeta.albumArtist) || "";
        const year = (existing && existing.year) || (extractedMeta && extractedMeta.year) || "";
        const genre = (existing && existing.genre) || (extractedMeta && extractedMeta.genre) || "";
        const trackNo = (existing && existing.trackNo) || (extractedMeta && extractedMeta.trackNo) || inferred.trackNo || "";
        const discNo = (existing && existing.discNo) || (extractedMeta && extractedMeta.discNo) || "";
        const duration = (existing && existing.duration) || (extractedMeta && extractedMeta.duration) || 0;
        const artworkBlob = (existing && existing.artworkBlob) || (extractedMeta && extractedMeta.artworkBlob) || null;

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
          format: (extractedMeta && extractedMeta.format) || format,
          addedAt: existing ? (existing.addedAt || Date.now()) : Date.now(),
          playCount: existing ? (existing.playCount || 0) : 0,
          lastPlayedAt: existing ? (existing.lastPlayedAt || 0) : 0,
          enabled: existing ? (existing.enabled !== false) : true,
          loved: existing ? !!existing.loved : false,
          fileSize: parseInt(file.size, 10) || 0,
          originalName: file.name,
          artworkBlob,
          source: "gdrive",
          driveFileId: file.id,
          cached: false,
        };
        if (existing && typeof existing.order === "number") track.order = existing.order;
        if (existing && existing.userEdited) track.userEdited = true;

        await putTrack(track, null);
        added++;
      }
    } catch (e) {
      console.warn("[drive-service] インポート失敗:", file.name, e);
      failed++;
    }

    // イベントループに譲る
    await new Promise((r) => setTimeout(r, 0));
  }

  return { added, failed };
}

function stripExt(name) {
  return String(name || "").replace(/\.[^./\\]+$/, "");
}

/**
 * Google Drive インポートモーダルを表示
 * @param {{ onImported?: () => void }} [opts]
 */
export async function openDriveImportModal({ onImported } = {}) {
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
        openDriveImportModal({ onImported });
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
        const email = (test.user && (test.user.emailAddress || test.user.displayName)) || "";
        await setDriveToken(token, { expiresIn: 3600, email });
        toast(`Google Drive に接続しました (${email || "OK"})`, "ok");
        const closeBtn = document.querySelector(".modal-close");
        if (closeBtn) closeBtn.click();
        openDriveImportModal({ onImported });
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

  const emailDisplay = pub.gdriveUserEmail ? ` (${escapeHtml(pub.gdriveUserEmail)})` : "";

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <!-- 接続ヘッダー -->
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px;">
        <div>
          <span style="color: var(--success); font-weight: bold;">● 接続中</span>${emailDisplay}
        </div>
        <button class="btn danger" id="btn-drive-disconnect" style="padding: 2px 8px; font-size: 11px;">切断</button>
      </div>

      <!-- 検索バー -->
      <div style="display: flex; gap: 6px;">
        <input type="search" id="drive-search-input" placeholder="Google Drive 内を検索 (曲名・フォルダ名)…" style="flex: 1; font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
        <button class="btn" id="btn-drive-search" style="padding: 6px 12px; font-size: 12px;">検索</button>
      </div>

      <!-- パンくずリスト -->
      <div id="drive-breadcrumbs" style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; padding: 6px 8px; background: var(--bg-surface); border-radius: 6px; border: 1px solid var(--border-color); min-height: 28px;"></div>

      <!-- アクションバー -->
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn primary" id="btn-drive-import-folder" style="padding: 4px 10px; font-size: 11px; white-space: nowrap;" title="現在のフォルダ内（サブフォルダ含む）の全音源を一括追加">
            📂 このフォルダの曲を全追加
          </button>
          <button class="btn" id="btn-drive-select-all" style="padding: 4px 8px; font-size: 11px;">全選択</button>
          <button class="btn" id="btn-drive-unselect-all" style="padding: 4px 8px; font-size: 11px;">全解除</button>
        </div>
        <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; user-select: none;">
          <input type="checkbox" id="chk-drive-cache-now" />
          <span title="チェックを外すと本体ストレージを消費せず、再生時に直接ストリーミングします">即時キャッシュ (OFFで容量0)</span>
        </label>
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
      { label: "キャンセル", onClick: () => {} },
      {
        label: "選択した曲を追加 (0件)",
        primary: true,
        onClick: async () => {
          const selectedFiles = displayedItems.filter(
            (it) => it.mimeType !== "application/vnd.google-apps.folder" && selectedFileIds.has(it.id)
          );

          if (selectedFiles.length === 0) {
            toast("インポートする曲を選択するか、【このフォルダの曲を全追加】を押してください", "err");
            return;
          }

          const cacheNow = container.querySelector("#chk-drive-cache-now").checked;
          const progressEl = container.querySelector("#drive-import-progress");
          progressEl.style.display = "block";
          progressEl.textContent = `追加中 0 / ${selectedFiles.length}…`;

          const importBtn = document.querySelector(".modal-actions .btn.primary");
          if (importBtn) {
            importBtn.disabled = true;
            importBtn.textContent = "インポート中…";
          }

          try {
            const { added, failed } = await importDriveFilesToLibrary(selectedFiles, {
              cacheBlobs: cacheNow,
              defaultAlbumName: currentFolderName,
              onProgress: (cur, tot, file) => {
                progressEl.textContent = `追加中 ${cur} / ${tot}: ${escapeHtml(file.name)}…`;
              },
            });

            toast(`${added} 件の Google Drive 音源を追加しました`, "ok");
            for (const f of selectedFiles) {
              existingTrackIds.add(trackIdFromDriveFileId(f.id));
            }
            if (typeof onImported === "function") onImported();
          } catch (err) {
            toast(`インポート中にエラーが発生しました: ${err.message}`, "err");
          } finally {
            const closeBtn = document.querySelector(".modal-close");
            if (closeBtn) closeBtn.click();
          }
        },
      },
    ],
  });

  const fileListEl = container.querySelector("#drive-file-list");

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

  // パンくずリスト描画
  const renderBreadcrumbs = () => {
    const crumbsEl = container.querySelector("#drive-breadcrumbs");
    if (!crumbsEl) return;
    if (currentSearch) {
      crumbsEl.innerHTML = `
        <span style="color:var(--accent); font-weight:600;">🔍 検索結果: "${escapeHtml(currentSearch)}"</span>
        <button class="btn" id="btn-clear-search" style="padding:2px 8px; font-size:11px; margin-left:auto;">✕ フォルダ表示に戻る</button>
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
      const audioFiles = await fetchFolderAudioFilesRecursive(folderId, {
        onProgress: (msg) => { progressEl.textContent = msg; },
      });

      if (audioFiles.length === 0) {
        toast(`フォルダ「${folderName}」内に音源ファイルは見つかりませんでした`, "info");
        progressEl.style.display = "none";
        if (folderBtn) folderBtn.disabled = false;
        return;
      }

      const cacheNow = container.querySelector("#chk-drive-cache-now").checked;
      progressEl.textContent = `追加中 0 / ${audioFiles.length}…`;

      const { added, failed } = await importDriveFilesToLibrary(audioFiles, {
        cacheBlobs: cacheNow,
        defaultAlbumName: folderName,
        onProgress: (cur, tot, file) => {
          progressEl.textContent = `追加中 ${cur} / ${tot}: ${escapeHtml(file.name)}…`;
        },
      });

      toast(`「${folderName}」から ${added} 曲を追加しました`, "ok");
      for (const f of audioFiles) {
        existingTrackIds.add(trackIdFromDriveFileId(f.id));
      }
      renderItems(displayedItems, false);
      if (typeof onImported === "function") onImported();
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

  // 切断
  container.querySelector("#btn-drive-disconnect").addEventListener("click", async () => {
    await disconnectDrive();
    toast("Google Drive との接続を解除しました", "ok");
    const closeBtn = document.querySelector(".modal-close");
    if (closeBtn) closeBtn.click();
  });
}
