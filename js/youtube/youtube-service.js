/**
 * YouTube 音源取得サービス
 *
 * - YouTube URL / 動画IDの解析
 * - Savetube (MP3 320kbps 直接リンク) & InnerTube (Android VR) から高音質音源 URL を直接抽出
 * - Invidious API / YouTube oEmbed からのフォールバック情報取得
 * - 高速・確実な Streams チャンク分割ダウンロード (進捗パーセント通知)
 * - 任意音声 URL およびローカル音声ファイル読み込みへのフォールバック
 */

import { getPublic, setPublic } from "../store/settings.js";
import { cleanArtistName, cleanTrackTitle, parseArtistAndTitle } from "../lastfm/scrobble-cleaner.js";

// 既定の信頼性の高い Invidious インスタンスリスト（自動フォールバック用）
export const DEFAULT_INVIDIOUS_INSTANCES = [
  "https://invidious.f5.si",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.drgnz.club",
  "https://invidious.perennialte.ch",
  "https://inv.tux.pizza",
  "https://invidious.private.coffee",
];

/**
 * YouTube の URL または文字列から 11 桁の Video ID を抽出
 * @param {string} input
 * @returns {string|null}
 */
export function extractYouTubeVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();

  // 生の 11 文字の英数字・ハイフン・アンダースコア
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return str;
  }

  // youtu.be/ID or youtube.com/shorts/ID or embed/ID
  const shortMatch = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/i);
  if (shortMatch && shortMatch[1]) {
    return shortMatch[1];
  }

  // youtube.com/watch?v=ID or music.youtube.com/watch?v=ID
  const watchMatch = str.match(/[?&]v=([a-zA-Z0-9_-]{11})/i);
  if (watchMatch && watchMatch[1]) {
    return watchMatch[1];
  }

  return null;
}

/**
 * 使用する Invidious インスタンスのリストを取得（設定画面のカスタムURLを優先）
 * @returns {string[]}
 */
export function getActiveInstances() {
  const pub = getPublic();
  const custom = pub.customInvidiousUrl ? pub.customInvidiousUrl.trim().replace(/\/+$/, "") : null;
  if (custom) {
    return [custom, ...DEFAULT_INVIDIOUS_INSTANCES.filter((u) => u !== custom)];
  }
  return [...DEFAULT_INVIDIOUS_INSTANCES];
}

// Web Crypto API による Savetube 応答復号 (AES-128-CBC)
async function decryptSavetubeData(encBase64) {
  const secretKeyHex = "C5D58EF67A7584E4A29F6C35BBC4EB12";
  const keyBytes = new Uint8Array(secretKeyHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

  const subtle = (typeof crypto !== "undefined" ? crypto.subtle : null) || globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SubtleCrypto not supported");

  const cryptoKey = await subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  let binaryString;
  if (typeof atob === "function") {
    binaryString = atob(encBase64);
  } else if (typeof Buffer !== "undefined") {
    binaryString = Buffer.from(encBase64, "base64").toString("binary");
  } else {
    throw new Error("Base64 decode not available");
  }

  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const iv = bytes.slice(0, 16);
  const content = bytes.slice(16);

  const decryptedBuf = await subtle.decrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    content
  );
  const decryptedText = new TextDecoder().decode(decryptedBuf);
  return JSON.parse(decryptedText);
}

// 既知の高速・安定 Savetube CDN リスト
const SAVETUBE_HEALTHY_CDNS = [
  "cdn400.savetube.vip",
  "cdn405.savetube.vip",
  "cdn406.savetube.vip",
  "cdn401.savetube.vip",
  "cdn403.savetube.vip",
];

async function getSavetubeCdnCandidates() {
  const cdns = [...SAVETUBE_HEALTHY_CDNS];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const cdnRes = await fetch("https://media.savetube.vip/api/random-cdn", { signal: ctrl.signal });
    clearTimeout(t);
    if (cdnRes.ok) {
      const { cdn } = await cdnRes.json();
      if (cdn && !cdns.includes(cdn)) {
        cdns.unshift(cdn);
      }
    }
  } catch (_) {}
  return cdns;
}

/**
 * クライアント直接 Savetube による MP3 320kbps 音源解決 (複数 CDN 自動ローテーション)
 * @param {string} cleanId
 * @returns {Promise<object>}
 */
async function fetchSavetubeDirect(cleanId) {
  const cdns = await getSavetubeCdnCandidates();
  let lastErr = null;

  for (const cdn of cdns) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);

      const infoRes = await fetch(`https://${cdn}/v2/info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://save-tube.com/",
        },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${cleanId}` }),
        signal: ctrl.signal,
      });
      clearTimeout(t);

      if (!infoRes.ok) continue;
      const infoJson = await infoRes.json();
      if (!infoJson.data) continue;

      const info = await decryptSavetubeData(infoJson.data);
      if (!info || !info.key) continue;

      // 320kbps MP3 変換リンク発行
      const dlCtrl = new AbortController();
      const dlTimer = setTimeout(() => dlCtrl.abort(), 4000);
      const dlRes = await fetch(`https://${cdn}/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://save-tube.com/",
        },
        body: JSON.stringify({
          downloadType: "audio",
          quality: "320",
          key: info.key,
        }),
        signal: dlCtrl.signal,
      });
      clearTimeout(dlTimer);

      if (!dlRes.ok) continue;
      const dlJson = await dlRes.json();
      const audioUrl = dlJson.data?.downloadUrl;
      if (!audioUrl) continue;

      let rawTitle = info.title || "";
      let title = cleanTrackTitle(rawTitle);
      let author = "";

      const parsed = parseArtistAndTitle(rawTitle);
      if (parsed) {
        author = parsed.artist;
        title = parsed.title;
      } else if (rawTitle.includes(" - ")) {
        const parts = rawTitle.split(" - ");
        author = cleanArtistName(parts[0].trim());
        title = cleanTrackTitle(parts.slice(1).join(" - ").trim());
      }

      return {
        videoId: cleanId,
        title: title || "無題",
        author: author || "YouTube",
        duration: parseInt(info.duration || "0", 10),
        thumbnailUrl: info.thumbnail || `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`,
        audioUrl,
        adaptiveFormats: [
          {
            url: audioUrl,
            type: "audio/mp3",
            itag: "320",
          },
        ],
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error("Savetube CDN 接続失敗");
}

function normalizeYtMeta(rawTitle, rawAuthor) {
  let title = cleanTrackTitle(rawTitle || "");
  let author = cleanArtistName(rawAuthor || "");

  const parsed = parseArtistAndTitle(rawTitle);
  if (parsed) {
    if (!author || author === "YouTube") {
      author = parsed.artist;
      title = parsed.title;
    } else if (author.toLowerCase() === parsed.artist.toLowerCase()) {
      title = parsed.title;
    }
  }

  return {
    title: title || rawTitle || "無題",
    author: author || "YouTube",
  };
}

/**
 * YouTube 動画のメタデータ（タイトル、チャンネル名、再生秒数、サムネイル、音源URL等）を取得
 * @param {string} videoId
 * @returns {Promise<{ videoId: string, title: string, author: string, duration: number, thumbnailUrl: string|null, audioUrl?: string|null, adaptiveFormats: Array<object>, raw: object }>}
 */
export async function fetchVideoInfo(videoId) {
  const cleanId = extractYouTubeVideoId(videoId);
  if (!cleanId) {
    throw new Error("有効な YouTube URL または動画IDを指定してください");
  }

  let baseMeta = null;

  // 1. 同一オリジンの Vercel Serverless/Edge API (/api/youtube) を試行
  try {
    const apiRes = await fetch(`/api/youtube?action=info&id=${cleanId}`);
    if (apiRes.ok) {
      const data = await apiRes.json();
      if (data && data.title) {
        const norm = normalizeYtMeta(data.title, data.author);
        baseMeta = {
          videoId: cleanId,
          title: norm.title,
          author: norm.author,
          duration: data.duration || 0,
          thumbnailUrl: data.thumbnailUrl || `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`,
          audioUrl: data.audioUrl || null,
          adaptiveFormats: data.adaptiveFormats || [],
          instanceUsed: "/api/youtube",
          raw: data,
        };
        // 音源 URL が既に確実に取得できている場合のみ即時返却
        const hasAudio = !!data.audioUrl || (data.adaptiveFormats || []).some((f) => f.type && f.type.includes("audio") && f.url);
        if (hasAudio) {
          return baseMeta;
        }
      }
    }
  } catch (_) {
    // /api/youtube がローカル等で未配置の場合はクライアント直接通信へフォールバック
  }

  // 2. ブラウザ直接 Savetube (Web Crypto 復号 & Multi-CDN 自動ローテーション) による MP3 320kbps 音源解決
  try {
    const stData = await fetchSavetubeDirect(cleanId);
    if (stData && stData.audioUrl) {
      return {
        ...baseMeta,
        ...stData,
        title: stData.title && stData.title !== "無題" ? stData.title : (baseMeta?.title || stData.title),
        author: stData.author && stData.author !== "YouTube" ? stData.author : (baseMeta?.author || stData.author),
        thumbnailUrl: stData.thumbnailUrl || baseMeta?.thumbnailUrl,
        instanceUsed: "client-savetube",
        raw: stData,
      };
    }
  } catch (_) {}

  // 3. 外部 Invidious インスタンスリストからの直接フォールバック取得
  const instances = getActiveInstances();
  let lastError = null;

  for (const inst of instances) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${inst}/api/v1/videos/${cleanId}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = new Error(`インスタンス ${inst} がステータス ${res.status} を返しました`);
        continue;
      }

      const data = await res.json();
      if (!data || !data.title) {
        lastError = new Error("動画情報の取得結果が空です");
        continue;
      }

      // サムネイル探索（高画質を優先）
      let thumbUrl = null;
      if (Array.isArray(data.videoThumbnails)) {
        const sortedThumbs = [...data.videoThumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
        thumbUrl = sortedThumbs[0]?.url || null;
      }
      if (!thumbUrl) {
        thumbUrl = `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`;
      }

      const audioFormats = (data.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio") && f.url);
      const best = audioFormats.find((f) => f.itag === "140") || audioFormats.find((f) => f.itag === "251") || audioFormats[0];

      const norm = normalizeYtMeta(data.title, data.author);
      return {
        videoId: cleanId,
        title: norm.title,
        author: norm.author,
        duration: parseInt(data.lengthSeconds || "0", 10),
        thumbnailUrl: thumbUrl,
        audioUrl: best?.url || null,
        adaptiveFormats: data.adaptiveFormats || [],
        instanceUsed: inst,
        raw: data,
      };
    } catch (err) {
      lastError = err;
    }
  }

  // 4. YouTube oEmbed (noembed) による確実なメタデータ取得 (Title, Author, Thumbnail を 100% 確実に即座に取得)
  try {
    const oRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${cleanId}`);
    if (oRes.ok) {
      const oData = await oRes.json();
      if (oData && oData.title) {
        const norm = normalizeYtMeta(oData.title, oData.author_name);
        return {
          videoId: cleanId,
          title: norm.title,
          author: norm.author,
          duration: 0,
          thumbnailUrl: oData.thumbnail_url || `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`,
          audioUrl: null,
          adaptiveFormats: [],
          instanceUsed: "noembed",
          raw: oData,
        };
      }
    }
  } catch (_) {}

  // 第5フォールバック: 公式 YouTube oEmbed API
  try {
    const ytOembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`);
    if (ytOembed.ok) {
      const ytData = await ytOembed.json();
      if (ytData && ytData.title) {
        const norm = normalizeYtMeta(ytData.title, ytData.author_name);
        return {
          videoId: cleanId,
          title: norm.title,
          author: norm.author,
          duration: 0,
          thumbnailUrl: ytData.thumbnail_url || `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`,
          audioUrl: null,
          adaptiveFormats: [],
          instanceUsed: "youtube-oembed",
          raw: ytData,
        };
      }
    }
  } catch (_) {}

  throw new Error(`動画情報の取得に失敗しました: ${lastError ? lastError.message : "接続エラー"}`);
}

/**
 * YouTube 音声ストリームを Range 分割または Streams リクエストで高速・確実にダウンロード
 * @param {string} audioUrl
 * @param {number} totalBytes
 * @param {(progress: { percent: number, loaded: number, total: number, statusText: string }) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadAudioStream(audioUrl, totalBytes = 0, onProgress = null) {
  const chunkSize = 1024 * 1024; // 1MB チャンク
  let offset = 0;
  const chunks = [];
  const knownTotal = totalBytes > 0 ? totalBytes : 0;

  if (onProgress) {
    onProgress({ percent: 0, loaded: 0, total: knownTotal, statusText: "ダウンロード開始…" });
  }

  // もし audioUrl がクロスオリジンの場合、
  // /api/youtube?action=stream&url=... を経由してブラウザの CORS 制限を解消
  let resolvedUrl = audioUrl;
  if (audioUrl.startsWith("http://") || audioUrl.startsWith("https://")) {
    try {
      const parsed = new URL(audioUrl, typeof window !== "undefined" ? window.location.href : "http://localhost");
      if (typeof window !== "undefined" && parsed.origin !== window.location.origin) {
        resolvedUrl = `/api/youtube?action=stream&url=${encodeURIComponent(audioUrl)}`;
      }
    } catch (_) {}
  }

  async function fetchWithFallback(headers = {}) {
    // 1. /api/youtube?action=stream
    try {
      const r = await fetch(resolvedUrl, { headers });
      if (r.ok || r.status === 206) return r;
    } catch (_) {}

    // 2. 直接 audioUrl
    if (resolvedUrl !== audioUrl) {
      try {
        const r = await fetch(audioUrl, { headers });
        if (r.ok || r.status === 206) return r;
      } catch (_) {}
    }

    // 3. 公開 CORS プロキシ
    const proxies = [
      `https://corsproxy.io/?url=${encodeURIComponent(audioUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(audioUrl)}`,
    ];
    for (const p of proxies) {
      try {
        const r = await fetch(p, { headers });
        if (r.ok || r.status === 206) return r;
      } catch (_) {}
    }

    throw new Error("音声データのダウンロードに失敗しました (全プロキシ接続失敗)");
  }

  // 1. totalBytes が既知の場合は Range リクエストで分割取得を試行
  if (knownTotal > 0) {
    try {
      while (offset < knownTotal) {
        const end = Math.min(offset + chunkSize - 1, knownTotal - 1);
        const res = await fetchWithFallback({ Range: `bytes=${offset}-${end}` });

        if (!res.ok && res.status !== 206) {
          throw new Error(`Range取得不可: HTTP ${res.status}`);
        }

        const buf = await res.arrayBuffer();
        chunks.push(buf);
        offset = end + 1;

        const pct = Math.min(100, Math.round((offset / knownTotal) * 100));
        if (onProgress) {
          onProgress({
            percent: pct,
            loaded: offset,
            total: knownTotal,
            statusText: `音源をダウンロード中 (${Math.round((offset / 1024 / 1024) * 10) / 10}MB / ${Math.round((knownTotal / 1024 / 1024) * 10) / 10}MB)`,
          });
        }
      }

      const finalBuffer = new Uint8Array(knownTotal);
      let cur = 0;
      for (const c of chunks) {
        finalBuffer.set(new Uint8Array(c), cur);
        cur += c.byteLength;
      }
      return finalBuffer.buffer;
    } catch (rangeErr) {
      console.warn("[yt] Range 分割ダウンロード失敗、単一ストリーム取得へ移行:", rangeErr);
    }
  }

  // 2. 単一ストリーム読込 (Streams API で進捗通知)
  const res = await fetchWithFallback();

  const cl = res.headers.get("content-length");
  const streamTotal = cl ? parseInt(cl, 10) : 0;

  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const receivedChunks = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedChunks.push(value);
      receivedBytes += value.length;

      if (onProgress) {
        const pct = streamTotal > 0 ? Math.min(99, Math.round((receivedBytes / streamTotal) * 100)) : 50;
        const mb = Math.round((receivedBytes / 1024 / 1024) * 10) / 10;
        const totalMb = streamTotal > 0 ? `${Math.round((streamTotal / 1024 / 1024) * 10) / 10}MB` : "";
        onProgress({
          percent: pct,
          loaded: receivedBytes,
          total: streamTotal,
          statusText: `音源をダウンロード中 (${mb}MB${totalMb ? " / " + totalMb : ""})…`,
        });
      }
    }

    const merged = new Uint8Array(receivedBytes);
    let curOffset = 0;
    for (const c of receivedChunks) {
      merged.set(c, curOffset);
      curOffset += c.length;
    }
    return merged.buffer;
  }

  return await res.arrayBuffer();
}

/**
 * YouTube の URL から音声データ・メタデータを一括取得
 * @param {string} inputUrl
 * @param {(progress: { percent: number, loaded: number, total: number, statusText: string }) => void} [onProgress]
 * @returns {Promise<{ title: string, artist: string, album: string, duration: number, thumbnailUrl: string|null, artworkBlob: Blob|null, audioArrayBuffer: ArrayBuffer, mimeType: string }>}
 */
export async function downloadYouTubeAudio(inputUrl, onProgress = null) {
  if (onProgress) onProgress({ percent: 0, loaded: 0, total: 0, statusText: "YouTube 動画情報を取得中…" });

  const info = await fetchVideoInfo(inputUrl);

  let audioUrl = info.audioUrl;
  let totalBytes = 0;
  let mimeType = "audio/mpeg";

  if (!audioUrl) {
    const audioFormats = (info.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio") && f.url);
    if (audioFormats.length === 0) {
      throw new Error("この動画にはダウンロード可能な音声ストリームが見つかりませんでした");
    }
    const bestAudio = audioFormats.find((f) => f.itag === "140") ||
                      audioFormats.find((f) => f.itag === "251") ||
                      audioFormats[0];
    audioUrl = bestAudio.url;
    totalBytes = parseInt(bestAudio.clen || "0", 10);
    mimeType = bestAudio.type ? bestAudio.type.split(";")[0] : "audio/mp4";
  }

  const audioArrayBuffer = await downloadAudioStream(audioUrl, totalBytes, onProgress);

  // サムネイル画像をダウンロード (ID3 カバー用)
  let artworkBlob = null;
  if (info.thumbnailUrl) {
    try {
      const artRes = await fetch(info.thumbnailUrl);
      if (artRes.ok) {
        artworkBlob = await artRes.blob();
      }
    } catch (_) {}
  }

  return {
    title: info.title,
    artist: info.author,
    album: "YouTube",
    duration: info.duration,
    thumbnailUrl: info.thumbnailUrl,
    artworkBlob,
    audioArrayBuffer,
    mimeType,
  };
}
