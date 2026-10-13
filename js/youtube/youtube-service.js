/**
 * YouTube 音源取得サービス
 *
 * - YouTube URL / 動画IDの解析
 * - Invidious API / 外部プロキシからの動画情報・音声ストリーム取得
 * - 高速・確実な Range チャンク分割ダウンロード (進捗パーセント通知)
 * - 任意音声 URL およびローカル音声ファイル読み込みへのフォールバック
 */

import { getPublic, setPublic } from "../store/settings.js";

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

  // youtu.be/ID
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

/**
 * YouTube 動画のメタデータ（タイトル、チャンネル名、再生秒数、サムネイル等）を取得
 * @param {string} videoId
 * @returns {Promise<{ title: string, author: string, duration: number, thumbnailUrl: string|null, formats: Array<object>, raw: object }>}
 */
export async function fetchVideoInfo(videoId) {
  const cleanId = extractYouTubeVideoId(videoId);
  if (!cleanId) {
    throw new Error("有効な YouTube URL または動画IDを指定してください");
  }

  // 1. 同一オリジンの Vercel Serverless/Edge API (/api/youtube) を最優先で試行 (CORSフリー・高速)
  try {
    const apiRes = await fetch(`/api/youtube?action=info&id=${cleanId}`);
    if (apiRes.ok) {
      const data = await apiRes.json();
      if (data && data.title) {
        return {
          videoId: cleanId,
          title: data.title || "",
          author: data.author || "",
          duration: data.duration || 0,
          thumbnailUrl: data.thumbnailUrl || `https://img.youtube.com/vi/${cleanId}/hqdefault.jpg`,
          adaptiveFormats: data.adaptiveFormats || [],
          instanceUsed: "/api/youtube",
          raw: data,
        };
      }
    }
  } catch (_) {
    // /api/youtube がローカル等で未配置の場合は Invidious へフォールバック
  }

  // 2. 外部 Invidious インスタンスリストからの直接フォールバック取得
  const instances = getActiveInstances();
  let lastError = null;

  for (const inst of instances) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
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

      return {
        videoId: cleanId,
        title: data.title || "",
        author: data.author || "",
        duration: parseInt(data.lengthSeconds || "0", 10),
        thumbnailUrl: thumbUrl,
        adaptiveFormats: data.adaptiveFormats || [],
        instanceUsed: inst,
        raw: data,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`動画情報の取得に失敗しました: ${lastError ? lastError.message : "接続エラー"}`);
}

/**
 * YouTube 音声ストリームを Range 分割リクエストで高速・確実にダウンロード
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

  // もし audioUrl がクロスオリジン (googlevideo.com 等) の場合、
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

  // totalBytes が既知の場合は Range リクエストで分割取得
  if (knownTotal > 0) {
    while (offset < knownTotal) {
      const end = Math.min(offset + chunkSize - 1, knownTotal - 1);
      let res;
      try {
        res = await fetch(resolvedUrl, {
          headers: {
            Range: `bytes=${offset}-${end}`,
          },
        });
      } catch (err) {
        // もし /api/youtube が使えない環境なら元の audioUrl へフォールバック
        if (resolvedUrl !== audioUrl) {
          res = await fetch(audioUrl, {
            headers: {
              Range: `bytes=${offset}-${end}`,
            },
          });
        } else {
          throw err;
        }
      }

      if (!res.ok && res.status !== 206) {
        throw new Error(`音声データの取得に失敗しました (${res.status} ${res.statusText})`);
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

    // チャンクを単一の ArrayBuffer に結合
    const finalBuffer = new Uint8Array(knownTotal);
    let cur = 0;
    for (const c of chunks) {
      finalBuffer.set(new Uint8Array(c), cur);
      cur += c.byteLength;
    }
    return finalBuffer.buffer;
  }

  // totalBytes が不明な場合のフォールバック直接ストリーム読込
  let res;
  try {
    res = await fetch(resolvedUrl);
  } catch (_) {
    res = await fetch(audioUrl);
  }
  if (!res.ok && resolvedUrl !== audioUrl) {
    res = await fetch(audioUrl);
  }
  if (!res.ok) {
    throw new Error(`音声データの取得に失敗しました (${res.status})`);
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

  // 音声フォーマットの選定 (itag 140 m4a 優先、次に itag 251 webm)
  const audioFormats = (info.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio"));
  if (audioFormats.length === 0) {
    throw new Error("この動画にはダウンロード可能な音声ストリームが見つかりませんでした");
  }

  const bestAudio = audioFormats.find((f) => f.itag === "140") ||
                    audioFormats.find((f) => f.itag === "251") ||
                    audioFormats[0];

  const audioUrl = bestAudio.url;
  if (!audioUrl) {
    throw new Error("音声ストリームの URL を取得できませんでした");
  }

  const totalBytes = parseInt(bestAudio.clen || "0", 10);
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
    mimeType: bestAudio.type ? bestAudio.type.split(";")[0] : "audio/mp4",
  };
}
