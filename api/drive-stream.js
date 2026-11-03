/**
 * Vercel Edge Function: Google Drive 音源セキュア Range ストリーミング中継
 *
 * 【セキュリティ方針】
 * - URL にアクセストークンを含めない (Cookie: drive_stream_token より抽出)
 * - fileId の厳格なバリデーション (/^[a-zA-Z0-9_-]{5,100}$/)
 * - Google Drive API (files.get?alt=media) 以外へのリクエスト転送を禁止 (オープンプロキシ化防止)
 * - Sec-Fetch-Site: cross-site の拒絶
 * - ReadableStream をバッファリングせずそのままストリーミング転送
 * - クライアント切断時は req.signal により Google Drive 上流 fetch を即座に中断
 * - Cache-Control: private, no-store を徹底
 * - トークンや機密情報をログおよびエラーレスポンスへ出力しない
 */

export const config = {
  runtime: "edge",
};

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function isValidFileId(fileId) {
  if (typeof fileId !== "string") return false;
  return /^[a-zA-Z0-9_-]{10,100}$/.test(fileId);
}

const CLEAR_COOKIE_HEADER = "drive_stream_token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax";

const ALLOWED_EXT_MIME = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function resolveMimeType(upstreamContentType, extHint) {
  // すでに具体的な audio/* MIME (octet-stream 以外) が返されている場合はそのまま信用
  if (upstreamContentType && upstreamContentType.startsWith("audio/") && upstreamContentType !== "audio/octet-stream") {
    return upstreamContentType;
  }

  // Google Drive が application/octet-stream, binary/octet-stream または空を返した場合のみ安全に補正
  // ※ JSON や HTML などの構造化テキスト・エラー応答には絶対に audio MIME を付けない
  const isGenericBinary = !upstreamContentType ||
    upstreamContentType.includes("octet-stream") ||
    upstreamContentType === "application/x-download";

  if (isGenericBinary) {
    const ext = String(extHint || "").toLowerCase().trim();
    if (ALLOWED_EXT_MIME[ext]) {
      return ALLOWED_EXT_MIME[ext];
    }
    // デフォルトは FLAC（iOS PWA では FLAC の MIME 指定が再生可否を左右するため）
    return "audio/flac";
  }

  // それ以外の MIME (application/json, text/html 等) はそのまま返し、クライアント側でデコードエラー等にならぬよう保護
  return upstreamContentType;
}

export default async function handler(req) {
  // 1. メソッド制限 (GET, HEAD のみ)
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Allow": "GET, HEAD",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // 2. CSRF / クロスサイトリクエスト防止
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite === "cross-site") {
    return new Response(JSON.stringify({ error: "Forbidden: cross-site requests rejected" }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // 3. 認証Cookieの検証 (URLクエリからのトークン取得は禁止)
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies["drive_stream_token"];
  if (!token || !/^[a-zA-Z0-9_.-]{20,512}$/.test(token)) {
    return new Response(JSON.stringify({ error: "Authentication required", code: "AUTH_REQUIRED" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        "Set-Cookie": CLEAR_COOKIE_HEADER,
      },
    });
  }

  // 4. パラメータ検証
  const url = new URL(req.url);
  const fileId = url.searchParams.get("fileId");
  if (!fileId || !isValidFileId(fileId)) {
    return new Response(JSON.stringify({ error: "Invalid or missing fileId", code: "INVALID_FILE_ID" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  }

  const extHint = url.searchParams.get("ext") || "flac";

  // 5. Google Drive API 宛ての Range リクエストを構築
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const upstreamHeaders = {
    "Authorization": `Bearer ${token}`,
  };

  const clientRange = req.headers.get("range");
  if (clientRange) {
    upstreamHeaders["Range"] = clientRange;
  }

  try {
    let remoteRes = await fetch(driveUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "manual",
      signal: req.signal, // ★ クライアント切断時に上流 fetch を即座に中断
    });

    // リダイレクト (301, 302, 307) 安全性検証
    if ([301, 302, 303, 307, 308].includes(remoteRes.status)) {
      const location = remoteRes.headers.get("location");
      if (location) {
        try {
          const locUrl = new URL(location);
          if (
            locUrl.hostname.endsWith(".googleapis.com") ||
            locUrl.hostname.endsWith(".google.com") ||
            locUrl.hostname.endsWith(".googleusercontent.com")
          ) {
            remoteRes = await fetch(location, {
              method: "GET",
              headers: upstreamHeaders,
              signal: req.signal,
            });
          } else {
            return new Response(JSON.stringify({ error: "Upstream redirect rejected" }), {
              status: 502,
              headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
            });
          }
        } catch {
          return new Response(JSON.stringify({ error: "Invalid redirect location" }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
          });
        }
      }
    }

    // 6. Google Drive エラーハンドリング
    if (!remoteRes.ok) {
      const errStatus = remoteRes.status;
      if (errStatus === 401) {
        return new Response(JSON.stringify({ error: "Google Drive token expired", code: "DRIVE_TOKEN_EXPIRED" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
            "Set-Cookie": CLEAR_COOKIE_HEADER,
          },
        });
      }
      if (errStatus === 403) {
        return new Response(JSON.stringify({ error: "Google Drive access forbidden", code: "DRIVE_FORBIDDEN" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
        });
      }
      if (errStatus === 404) {
        return new Response(JSON.stringify({ error: "Google Drive file not found", code: "DRIVE_NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
        });
      }
      return new Response(JSON.stringify({ error: `Google Drive error (${errStatus})`, code: "DRIVE_ERROR" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
      });
    }

    // 7. レスポンスヘッダーの正確な構築 (バッファリング禁止)
    const responseHeaders = new Headers();
    responseHeaders.set("Cache-Control", "private, no-store, no-transform");
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("Vary", "Range");
    responseHeaders.set("Content-Disposition", "inline");

    // Content-Type 補正
    const upstreamCt = remoteRes.headers.get("content-type");
    const safeCt = resolveMimeType(upstreamCt, extHint);
    responseHeaders.set("Content-Type", safeCt);

    // Range / Content 長の伝播
    const cl = remoteRes.headers.get("content-length");
    if (cl) responseHeaders.set("Content-Length", cl);

    const cr = remoteRes.headers.get("content-range");
    if (cr) responseHeaders.set("Content-Range", cr);

    const etag = remoteRes.headers.get("etag");
    if (etag) responseHeaders.set("ETag", etag);

    const lastMod = remoteRes.headers.get("last-modified");
    if (lastMod) responseHeaders.set("Last-Modified", lastMod);

    // HEAD リクエストの場合はボディなしでヘッダーのみ返却
    if (req.method === "HEAD") {
      return new Response(null, {
        status: remoteRes.status,
        headers: responseHeaders,
      });
    }

    // GET リクエスト: ReadableStream をダイレクトに中継 (メモリに蓄積しない)
    return new Response(remoteRes.body, {
      status: remoteRes.status, // 206 Partial Content または 200 OK
      headers: responseHeaders,
    });
  } catch (err) {
    if (req.signal?.aborted || err.name === "AbortError") {
      // クライアント切断による正常な中断
      return new Response(null, { status: 499 });
    }
    return new Response(JSON.stringify({ error: "Stream error", message: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }
}
