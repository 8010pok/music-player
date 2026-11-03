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

/**
 * リダイレクト先ホストの厳格な検証:
 * - HTTPS のみ許可 (HTTP ダウングレード禁止)
 * - ユーザー情報 (user:pass@) を拒否
 * - localhost やプライベート IP を拒否
 * - Google 正規ドメイン (googleapis.com, googleusercontent.com, drive.google.com) の完全一致または正規サブドメインのみ許可
 * ※ evilgoogleusercontent.com や googleusercontent.com.evil.example は確実に拒絶
 */
export function isAllowedGoogleRedirect(locUrl) {
  if (!locUrl || typeof locUrl.href !== "string") return false;
  if (locUrl.protocol !== "https:") return false;
  if (locUrl.username || locUrl.password) return false;

  const hostname = locUrl.hostname.toLowerCase();

  // 完全一致
  if (hostname === "www.googleapis.com" || hostname === "drive.google.com") {
    return true;
  }

  // 正規サブドメイン:
  // - *.googleapis.com
  // - *.googleusercontent.com
  const isGoogleApis = /^[a-z0-9.-]+\.googleapis\.com$/.test(hostname);
  const isGoogleUserContent = /^[a-z0-9.-]+\.googleusercontent\.com$/.test(hostname);

  if (!isGoogleApis && !isGoogleUserContent) {
    return false;
  }

  // localhost やプライベート IP の混入防止
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)) {
    return false;
  }

  return true;
}

const CLEAR_COOKIE_HEADER = "drive_stream_token=; Path=/api; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax";

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
  const initialHeaders = {
    "Authorization": `Bearer ${token}`,
  };

  const clientRange = req.headers.get("range");
  if (clientRange) {
    initialHeaders["Range"] = clientRange;
  }

  try {
    let currentUrl = driveUrl;
    let currentHeaders = { ...initialHeaders };
    let redirectCount = 0;
    const MAX_REDIRECTS = 3;
    const visitedUrls = new Set([driveUrl]);
    let remoteRes = null;

    while (redirectCount <= MAX_REDIRECTS) {
      // 接続タイムアウト (10秒) を設定し、無応答ハングによる長時間ブロックを防止
      const fetchController = new AbortController();
      let fetchTimer = null;
      const onClientAbort = () => {
        try { fetchController.abort(); } catch {}
      };
      if (req.signal) {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }
        req.signal.addEventListener("abort", onClientAbort, { once: true });
      }
      fetchTimer = setTimeout(() => {
        try { fetchController.abort(); } catch {}
      }, 10000);

      try {
        remoteRes = await fetch(currentUrl, {
          method: req.method === "HEAD" ? "HEAD" : "GET",
          headers: currentHeaders,
          redirect: "manual",
          signal: fetchController.signal,
        });
      } finally {
        if (fetchTimer) clearTimeout(fetchTimer);
        if (req.signal) {
          try { req.signal.removeEventListener("abort", onClientAbort); } catch {}
        }
      }

      // リダイレクト (301, 302, 303, 307, 308) の場合、Vercel 内部で安全に追従
      if ([301, 302, 303, 307, 308].includes(remoteRes.status)) {
        if (redirectCount >= MAX_REDIRECTS) {
          return new Response(JSON.stringify({ error: "Too many upstream redirects", code: "TOO_MANY_REDIRECTS" }), {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
              "X-Proxy-Error": "TOO_MANY_REDIRECTS",
            },
          });
        }

        const location = remoteRes.headers.get("location");
        if (!location) {
          break; // Location ヘッダーなしはループ終了
        }

        let locUrl = null;
        try {
          locUrl = new URL(location, currentUrl);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid redirect location", code: "INVALID_REDIRECT" }), {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
              "X-Proxy-Error": "INVALID_REDIRECT",
            },
          });
        }

        // リダイレクト先ホストの厳格な検証 (Google 正規ホストのみ許可)
        if (!isAllowedGoogleRedirect(locUrl)) {
          return new Response(JSON.stringify({ error: "Upstream redirect rejected", code: "REDIRECT_REJECTED" }), {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
              "X-Proxy-Error": "REDIRECT_REJECTED",
            },
          });
        }

        // ループ検出
        if (visitedUrls.has(locUrl.href)) {
          return new Response(JSON.stringify({ error: "Redirect loop detected", code: "REDIRECT_LOOP" }), {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
              "X-Proxy-Error": "REDIRECT_LOOP",
            },
          });
        }

        visitedUrls.add(locUrl.href);
        currentUrl = locUrl.href;

        // ★ 要件 # 10: Google CDN (*.googleusercontent.com 等) や署名付きURLへのリダイレクト時、
        // URL 署名と Bearer トークンの競合・拒絶を防ぐため Authorization ヘッダーを確実に剥離
        const targetHost = locUrl.hostname.toLowerCase();
        const isCdnOrDifferentHost = targetHost.endsWith(".googleusercontent.com") ||
          targetHost !== "www.googleapis.com" ||
          locUrl.searchParams.has("e") ||
          locUrl.searchParams.has("nonce");

        currentHeaders = {};
        if (clientRange) {
          currentHeaders["Range"] = clientRange;
        }
        if (!isCdnOrDifferentHost) {
          currentHeaders["Authorization"] = `Bearer ${token}`;
        }

        redirectCount++;
        continue;
      }

      // 通常レスポンス (200, 206, 401 等) が得られたら追従終了
      break;
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
    responseHeaders.set("X-Proxy-Redirect-Count", String(redirectCount));

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
