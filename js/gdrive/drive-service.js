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
      return { ok: false, error: `Google API エラー: ${res.status} ${res.statusText}` };
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
 * Google Drive 上の音源ファイルを検索・一覧取得
 * @param {{ query?: string, pageToken?: string, pageSize?: number }} [opts]
 * @returns {Promise<{ files: Array<object>, nextPageToken: string|null }>}
 */
export async function listDriveAudioFiles({ query = "", pageToken = null, pageSize = 100 } = {}) {
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません");

  let q = "trashed = false and (mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')";
  if (query.trim()) {
    const clean = query.trim().replace(/['\\]/g, "");
    if (clean) q += ` and name contains '${clean}'`;
  }

  let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${pageSize}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)&orderBy=name`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 401) {
      await disconnectDrive();
      throw new Error("認証の有効期限が切れました。再度接続してください。");
    }
    throw new Error(`Google Drive API エラー: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return {
    files: data.files || [],
    nextPageToken: data.nextPageToken || null,
  };
}

/**
 * Google Drive から音源ファイルの Blob をダウンロード
 * @param {string} fileId
 * @param {{ onProgress?: (loaded: number, total: number) => void }} [opts]
 * @returns {Promise<Blob>}
 */
export async function fetchDriveAudioBlob(fileId, { onProgress } = {}) {
  const token = await getDriveToken();
  if (!token) throw new Error("Google Drive に接続されていません。設定画面で接続してください。");

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 401) {
      await disconnectDrive();
      throw new Error("Google Drive の認証期限が切れました (401)。再接続してください。");
    }
    throw new Error(`Google Drive ダウンロード失敗: ${res.status} ${res.statusText}`);
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
}

/**
 * 選択した Drive ファイル群を IndexedDB ライブラリにインポート
 * @param {Array<object>} driveFiles
 * @param {{ cacheBlobs?: boolean, onProgress?: (current: number, total: number, file: object) => void }} [opts]
 * @returns {Promise<{ added: number, failed: number }>}
 */
export async function importDriveFilesToLibrary(driveFiles, { cacheBlobs = false, onProgress } = {}) {
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

      if (cacheBlobs) {
        // Blob をダウンロードして完全メタデータを抽出
        const blob = await fetchDriveAudioBlob(file.id);
        const meta = await extractMetadata(blob, file.name);
        let duration = meta.duration;
        if ((!duration || duration <= 0) && typeof document !== "undefined") {
          duration = await readDurationViaAudio(blob);
        }

        const track = {
          id: trackId,
          title: meta.title || stripExt(file.name),
          artist: meta.artist || "(不明アーティスト)",
          album: meta.album || "Google Drive",
          albumArtist: meta.albumArtist || "",
          year: meta.year || "",
          genre: meta.genre || "",
          trackNo: meta.trackNo || "",
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
        // メタデータレコードのみ作成（音源 Blob は再生時にオンデマンドで取得・キャッシュ）
        const format = formatFromName(file.name) || "unknown";
        const mime = file.mimeType || mimeFromName(file.name);
        const baseTitle = stripExt(file.name);

        const track = {
          id: trackId,
          title: (existing && existing.title) || baseTitle || "(無題)",
          artist: (existing && existing.artist) || "(Google Drive)",
          album: (existing && existing.album) || "Google Drive",
          albumArtist: (existing && existing.albumArtist) || "",
          year: (existing && existing.year) || "",
          genre: (existing && existing.genre) || "",
          trackNo: (existing && existing.trackNo) || "",
          discNo: (existing && existing.discNo) || "",
          duration: (existing && existing.duration) || 0,
          mime,
          format,
          addedAt: existing ? (existing.addedAt || Date.now()) : Date.now(),
          playCount: existing ? (existing.playCount || 0) : 0,
          lastPlayedAt: existing ? (existing.lastPlayedAt || 0) : 0,
          enabled: existing ? (existing.enabled !== false) : true,
          loved: existing ? !!existing.loved : false,
          fileSize: parseInt(file.size, 10) || 0,
          originalName: file.name,
          artworkBlob: (existing && existing.artworkBlob) || null,
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
        <button class="btn primary" id="btn-drive-gis-login" style="width: 100%;">
          🔑 Google アカウントでログイン
        </button>
      </div>

      <div style="background: var(--bg-surface); padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid var(--border-color);">
        <h4 style="margin: 0 0 8px 0; font-size: 14px;">方法 2: Access Token を直接入力</h4>
        <div style="font-size: 11px; color: var(--fg-muted); margin-bottom: 8px;">
          Google OAuth Playground 等で取得した一時的なアクセストークン（drive.readonly 権限）を直接使用します。
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

  // 接続済み画面：ファイル一覧と選択
  let currentFiles = [];
  let existingTrackIds = new Set();
  try {
    const existing = await getAllTracks();
    existingTrackIds = new Set(existing.map((t) => t.id));
  } catch {}

  const emailDisplay = pub.gdriveUserEmail ? ` (${escapeHtml(pub.gdriveUserEmail)})` : "";

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 13px;">
      <div>
        <span style="color: var(--success); font-weight: bold;">● 接続中</span>${emailDisplay}
      </div>
      <button class="btn danger" id="btn-drive-disconnect" style="padding: 4px 8px; font-size: 11px;">切断</button>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 10px;">
      <input type="search" id="drive-search-input" placeholder="Google Drive 内を検索…" style="flex: 1; font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--fg);" />
      <button class="btn" id="btn-drive-search" style="padding: 6px 12px; font-size: 12px;">検索</button>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px;">
      <div style="display: flex; gap: 6px;">
        <button class="btn" id="btn-drive-select-all" style="padding: 2px 8px; font-size: 11px;">全選択</button>
        <button class="btn" id="btn-drive-unselect-all" style="padding: 2px 8px; font-size: 11px;">全解除</button>
      </div>
      <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;">
        <input type="checkbox" id="chk-drive-cache-now" ${pub.gdriveAutoCache !== false ? "checked" : ""} />
        <span>音源をローカルに即時キャッシュ</span>
      </label>
    </div>

    <div id="drive-file-list" style="max-height: 280px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-surface); padding: 4px;">
      <div style="padding: 24px; text-align: center; color: var(--fg-muted); font-size: 12px;">
        読み込み中…
      </div>
    </div>

    <div id="drive-import-progress" style="margin-top: 10px; font-size: 12px; color: var(--accent); display: none;"></div>
  `;

  let modalCloseFn = null;

  openModal({
    title: "☁ Google Drive から追加",
    body: container,
    actions: [
      { label: "キャンセル", onClick: () => {} },
      {
        label: "追加する (0件)",
        primary: true,
        onClick: async () => {
          const checkedCheckboxes = container.querySelectorAll(".drive-file-chk:checked");
          const selectedFiles = [];
          for (const chk of checkedCheckboxes) {
            const idx = parseInt(chk.dataset.index, 10);
            if (currentFiles[idx]) selectedFiles.push(currentFiles[idx]);
          }

          if (selectedFiles.length === 0) {
            toast("インポートする曲を選択してください", "err");
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
              onProgress: (cur, tot, file) => {
                progressEl.textContent = `追加中 ${cur} / ${tot}: ${escapeHtml(file.name)}…`;
              },
            });

            toast(`${added} 件の Google Drive 音源を追加しました`, "ok");
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
  const updateCount = () => {
    const checked = container.querySelectorAll(".drive-file-chk:checked").length;
    const btn = document.querySelector(".modal-actions .btn.primary");
    if (btn) btn.textContent = `追加する (${checked}件)`;
  };

  const renderFiles = (files) => {
    currentFiles = files;
    if (files.length === 0) {
      fileListEl.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--fg-muted); font-size: 12px;">音源ファイルが見つかりませんでした</div>`;
      updateCount();
      return;
    }

    fileListEl.innerHTML = files.map((f, i) => {
      const trackId = trackIdFromDriveFileId(f.id);
      const isAlreadyAdded = existingTrackIds.has(trackId);
      const sizeStr = f.size ? `${(parseInt(f.size, 10) / 1024 / 1024).toFixed(1)} MB` : "";
      return `
        <label style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; border-bottom: 1px solid var(--border-color); font-size: 12px;">
          <input type="checkbox" class="drive-file-chk" data-index="${i}" ${isAlreadyAdded ? "" : "checked"} />
          <div style="flex: 1; min-width: 0;">
            <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500;">
              ${escapeHtml(f.name)}
            </div>
            <div style="font-size: 10px; color: var(--fg-muted); display: flex; gap: 8px;">
              <span>${sizeStr}</span>
              ${isAlreadyAdded ? `<span style="color: var(--accent);">追加済み</span>` : ""}
            </div>
          </div>
        </label>
      `;
    }).join("");

    fileListEl.querySelectorAll(".drive-file-chk").forEach((chk) => {
      chk.addEventListener("change", updateCount);
    });
    updateCount();
  };

  // ファイルリスト読み込み
  const loadFiles = async (q = "") => {
    fileListEl.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--fg-muted); font-size: 12px;">読み込み中…</div>`;
    try {
      const res = await listDriveAudioFiles({ query: q });
      renderFiles(res.files);
    } catch (err) {
      fileListEl.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--err); font-size: 12px;">取得エラー: ${escapeHtml(err.message)}</div>`;
    }
  };

  loadFiles();

  // 検索
  const searchInput = container.querySelector("#drive-search-input");
  container.querySelector("#btn-drive-search").addEventListener("click", () => {
    loadFiles(searchInput.value);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadFiles(searchInput.value);
  });

  // 全選択・全解除
  container.querySelector("#btn-drive-select-all").addEventListener("click", () => {
    container.querySelectorAll(".drive-file-chk").forEach((c) => { c.checked = true; });
    updateCount();
  });
  container.querySelector("#btn-drive-unselect-all").addEventListener("click", () => {
    container.querySelectorAll(".drive-file-chk").forEach((c) => { c.checked = false; });
    updateCount();
  });

  // 切断
  container.querySelector("#btn-drive-disconnect").addEventListener("click", async () => {
    await disconnectDrive();
    toast("Google Drive との接続を解除しました", "ok");
    const closeBtn = document.querySelector(".modal-close");
    if (closeBtn) closeBtn.click();
  });
}
