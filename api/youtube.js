/**
 * Vercel Serverless / Edge Function: YouTube 音源プロキシ & 情報取得
 *
 * - クライアント (ブラウザ) からの CORS 制限を解消
 * - Savetube (MP3 320kbps 直接リンク) & InnerTube (Android VR) から高音質音源 URL を直接抽出
 * - Invidious & YouTube oEmbed による確実なメタデータ フォールバック
 * - 音声ストリーム (Range リクエスト対応) をストリーミング中継
 */

export const config = {
  runtime: "edge",
};

const INVIDIOUS_INSTANCES = [
  "https://invidious.f5.si",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.drgnz.club",
  "https://invidious.perennialte.ch",
];

// Savetube 暗号化データの AES-128-CBC 復号
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
  } else {
    binaryString = Buffer.from(encBase64, "base64").toString("binary");
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

// 1. Savetube による MP3 320kbps 音源解決 (複数 CDN 自動ローテーション)
async function resolveSavetube(videoId) {
  const cdns = [
    "cdn400.savetube.vip",
    "cdn405.savetube.vip",
    "cdn406.savetube.vip",
    "cdn401.savetube.vip",
    "cdn403.savetube.vip",
  ];
  try {
    const cdnRes = await fetch("https://media.savetube.vip/api/random-cdn", {
      signal: AbortSignal.timeout(2500),
    });
    if (cdnRes.ok) {
      const { cdn } = await cdnRes.json();
      if (cdn && !cdns.includes(cdn)) cdns.unshift(cdn);
    }
  } catch (_) {}

  let lastErr = null;
  for (const cdn of cdns) {
    try {
      const infoRes = await fetch(`https://${cdn}/v2/info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://save-tube.com/",
        },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
        signal: AbortSignal.timeout(4000),
      });
      if (!infoRes.ok) continue;
      const infoJson = await infoRes.json();
      if (!infoJson.data) continue;

      const info = await decryptSavetubeData(infoJson.data);
      if (!info || !info.key) continue;

      // 320kbps MP3 変換リンク発行
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
        signal: AbortSignal.timeout(4000),
      });
      if (!dlRes.ok) continue;
      const dlJson = await dlRes.json();
      const audioUrl = dlJson.data?.downloadUrl;
      if (!audioUrl) continue;

      let title = info.title || "";
      let author = "";
      if (title.includes(" - ")) {
        const parts = title.split(" - ");
        author = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      }

      return {
        videoId,
        title: title || "無題",
        author: author || "YouTube",
        duration: parseInt(info.duration || "0", 10),
        thumbnailUrl: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        audioUrl,
        adaptiveFormats: [
          {
            url: audioUrl,
            type: "audio/mp3",
            itag: "320",
          },
        ],
        source: "savetube",
      };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Savetube CDN 解決失敗");
}

// 2. InnerTube ANDROID_VR クライアントによる直接音声ストリーム解決
async function resolveInnerTube(videoId) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "ANDROID_VR",
          clientVersion: "1.61.48",
          deviceModel: "Quest 3",
          hl: "en",
          gl: "US",
        },
      },
      videoId,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`InnerTube HTTP ${res.status}`);
  const data = await res.json();
  if (data.playabilityStatus?.status !== "OK") {
    throw new Error(`InnerTube status: ${data.playabilityStatus?.status}`);
  }
  const af = (data.streamingData?.adaptiveFormats || []).filter(
    (f) => f.mimeType && f.mimeType.includes("audio") && f.url
  );
  if (af.length === 0) throw new Error("InnerTube direct audio formats not available");

  const best = af.find((f) => f.itag === 140) || af.find((f) => f.itag === 251) || af[0];
  return {
    videoId,
    title: data.videoDetails?.title || "",
    author: data.videoDetails?.author || "",
    duration: parseInt(data.videoDetails?.lengthSeconds || "0", 10),
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    audioUrl: best.url,
    adaptiveFormats: af.map((f) => ({
      url: f.url,
      type: f.mimeType,
      itag: String(f.itag),
      clen: f.contentLength,
    })),
    source: "innertube",
  };
}

// 3. 動画メタデータ & 音源の統合解決
async function resolveVideoInfo(videoId) {
  let lastErr = null;

  // 第1優先: Savetube (MP3 320kbps 直接リンク)
  try {
    return await resolveSavetube(videoId);
  } catch (e) {
    lastErr = e;
  }

  // 第2優先: InnerTube ANDROID_VR クライアント (暗号化不要の直接音声ストリーム)
  try {
    return await resolveInnerTube(videoId);
  } catch (e) {
    lastErr = e;
  }

  // 第3優先: Invidious インスタンス群
  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${inst}/api/v1/videos/${videoId}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !data.title) continue;

      let thumbUrl = null;
      if (Array.isArray(data.videoThumbnails)) {
        const sorted = [...data.videoThumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
        thumbUrl = sorted[0]?.url || null;
      }
      if (!thumbUrl) thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

      const audioFormats = (data.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio") && f.url);
      const best = audioFormats.find((f) => f.itag === "140") || audioFormats.find((f) => f.itag === "251") || audioFormats[0];

      return {
        videoId,
        title: data.title || "",
        author: data.author || "",
        duration: parseInt(data.lengthSeconds || "0", 10),
        thumbnailUrl: thumbUrl,
        audioUrl: best?.url || null,
        adaptiveFormats: data.adaptiveFormats || [],
        source: "invidious",
      };
    } catch (e) {
      lastErr = e;
    }
  }

  // 第4優先: NoEmbed (確実なタイトル・サムネイルメタデータ)
  try {
    const oRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (oRes.ok) {
      const oData = await oRes.json();
      if (oData && oData.title) {
        return {
          videoId,
          title: oData.title || "",
          author: oData.author_name || "",
          duration: 0,
          thumbnailUrl: oData.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          audioUrl: null,
          adaptiveFormats: [],
          source: "noembed",
        };
      }
    }
  } catch (_) {}

  // 第5優先: 公式 YouTube oEmbed
  try {
    const ytOembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (ytOembed.ok) {
      const ytData = await ytOembed.json();
      if (ytData && ytData.title) {
        return {
          videoId,
          title: ytData.title || "",
          author: ytData.author_name || "",
          duration: 0,
          thumbnailUrl: ytData.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          audioUrl: null,
          adaptiveFormats: [],
          source: "youtube-oembed",
        };
      }
    }
  } catch (_) {}

  throw new Error(`動画情報の取得に失敗しました: ${lastErr ? lastErr.message : "接続エラー"}`);
}

export default async function handler(req) {
  // CORS プリフライト対応
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "info";
  const id = url.searchParams.get("id");
  const targetUrl = url.searchParams.get("url");

  // アクション 1: 音声ストリームのプロキシ中継 (action=stream)
  if (action === "stream") {
    let audioUrl = targetUrl;

    // targetUrl が指定されていないが id が指定されている場合、音源 URL を直接解決
    if (!audioUrl && id) {
      try {
        const info = await resolveVideoInfo(id);
        if (info.audioUrl) {
          audioUrl = info.audioUrl;
        } else {
          const audios = (info.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio") && f.url);
          const best = audios.find((f) => f.itag === "140") || audios.find((f) => f.itag === "251") || audios[0];
          if (best && best.url) audioUrl = best.url;
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: `音源URL解決失敗: ${e.message}` }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    if (!audioUrl) {
      return new Response(JSON.stringify({ error: "url または id パラメータが必要です" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    try {
      const fetchHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://save-tube.com/",
      };
      const rangeHeader = req.headers.get("range");
      if (rangeHeader) {
        fetchHeaders["Range"] = rangeHeader;
      }

      const remoteRes = await fetch(audioUrl, {
        headers: fetchHeaders,
      });

      const responseHeaders = new Headers();
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Range");
      responseHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
      responseHeaders.set("Accept-Ranges", "bytes");

      const ct = remoteRes.headers.get("content-type") || "audio/mpeg";
      responseHeaders.set("Content-Type", ct);

      const cl = remoteRes.headers.get("content-length");
      if (cl) responseHeaders.set("Content-Length", cl);

      const cr = remoteRes.headers.get("content-range");
      if (cr) responseHeaders.set("Content-Range", cr);

      responseHeaders.set("Cache-Control", "public, max-age=3600");

      return new Response(remoteRes.body, {
        status: remoteRes.status,
        headers: responseHeaders,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: `ストリーム取得エラー: ${e.message}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  }

  // アクション 2: 動画メタデータ & 音源情報の取得 (action=info)
  if (!id) {
    return new Response(JSON.stringify({ error: "id パラメータが必要です" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const info = await resolveVideoInfo(id);
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=1800",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
