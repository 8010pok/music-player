/**
 * Vercel Serverless / Edge Function: YouTube 音源プロキシ & 情報取得
 *
 * - クライアント (ブラウザ) からの CORS 制限を解消
 * - Invidious API から動画情報 (タイトル、作者、再生時間、サムネイル、音源URL) を取得
 * - googlevideo からの音声ストリーム (Range リクエスト対応) をストリーミング中継
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

    // targetUrl が指定されていないが id が指定されている場合、音源 URL を解決
    if (!audioUrl && id) {
      try {
        const info = await resolveVideoInfo(id);
        const audios = (info.adaptiveFormats || []).filter((f) => f.type && f.type.includes("audio"));
        const best = audios.find((f) => f.itag === "140") || audios.find((f) => f.itag === "251") || audios[0];
        if (best && best.url) {
          audioUrl = best.url;
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
      const fetchHeaders = {};
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

      const ct = remoteRes.headers.get("content-type") || "audio/mp4";
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

  // アクション 2: 動画メタデータの取得 (action=info)
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

async function resolveVideoInfo(videoId) {
  let lastErr = null;
  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${inst}/api/v1/videos/${videoId}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(t);
      if (!res.ok) {
        lastErr = new Error(`${inst} status: ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (!data || !data.title) {
        lastErr = new Error("Empty response");
        continue;
      }

      let thumbUrl = null;
      if (Array.isArray(data.videoThumbnails)) {
        const sorted = [...data.videoThumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
        thumbUrl = sorted[0]?.url || null;
      }
      if (!thumbUrl) {
        thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      }

      return {
        videoId,
        title: data.title || "",
        author: data.author || "",
        duration: parseInt(data.lengthSeconds || "0", 10),
        thumbnailUrl: thumbUrl,
        adaptiveFormats: data.adaptiveFormats || [],
      };
    } catch (e) {
      lastErr = e;
    }
  }

  // Invidious が全滅した場合の YouTube oEmbed フォールバック (動画タイトル・作者・サムネイルを100%確実に取得)
  try {
    const oRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
    if (oRes.ok) {
      const oData = await oRes.json();
      if (oData && oData.title) {
        return {
          videoId,
          title: oData.title || "",
          author: oData.author_name || "",
          duration: 0,
          thumbnailUrl: oData.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          adaptiveFormats: [],
        };
      }
    }
  } catch (_) {}

  // 第2フォールバック: 公式 YouTube oEmbed
  try {
    const ytOembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (ytOembed.ok) {
      const ytData = await ytOembed.json();
      if (ytData && ytData.title) {
        return {
          videoId,
          title: ytData.title || "",
          author: ytData.author_name || "",
          duration: 0,
          thumbnailUrl: ytData.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          adaptiveFormats: [],
        };
      }
    }
  } catch (_) {}

  throw new Error(`動画情報の取得に失敗しました: ${lastErr ? lastErr.message : "接続エラー"}`);
}
