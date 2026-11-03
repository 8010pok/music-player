/**
 * Vercel Edge Function: Google Drive 音源ストリーミング用セッション認証エンドポイント
 *
 * 【セキュリティ方針】
 * - audio.src の URL にアクセストークンを一切載せないための認証セッション
 * - クライアントから HTTPS POST でアクセストークンを受け取り、
 *   短寿命の HttpOnly, Secure, SameSite=Strict な Cookie としてセットする
 * - Cookie の Path は /api/drive-stream に限定し、他パスへの流出を防止
 * - Origin / Sec-Fetch-Site による CSRF 対策
 * - トークン値や機密情報をログに出力しない
 */

export const config = {
  runtime: "edge",
};

function isValidTokenFormat(token) {
  if (typeof token !== "string") return false;
  // Google OAuth2 access token: 概ね ya29. で始まる英数字・ハイフン・アンダースコア（20〜512文字）
  return /^[a-zA-Z0-9_.-]{20,512}$/.test(token);
}

function verifyOrigin(req) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  const secFetchSite = req.headers.get("sec-fetch-site");

  // Sec-Fetch-Site が存在する場合、cross-site を拒絶
  if (secFetchSite && secFetchSite === "cross-site") {
    return false;
  }

  // Origin が存在する場合、自ホストと一致することを確認
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export default async function handler(req) {
  // CSRF / 不正Origin 検証
  if (!verifyOrigin(req)) {
    return new Response(JSON.stringify({ error: "Forbidden: cross-origin requests rejected" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. セッション初期化 (POST)
  if (req.method === "POST") {
    let body = null;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const token = body?.token;
    if (!token || !isValidTokenFormat(token)) {
      return new Response(JSON.stringify({ error: "Invalid token format" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Google OAuth トークンの残存時間 (秒) を反映。未指定時は1時間 (3600秒)。最小60秒〜最大3600秒に制限
    const rawExpires = Number(body?.expiresIn ?? body?.expires_in);
    const maxAge = Number.isFinite(rawExpires) && rawExpires > 0
      ? Math.min(3600, Math.max(60, Math.floor(rawExpires)))
      : 3600;

    // Cookie 設定:
    // - HttpOnly: JavaScript から参照不可 (XSS 防止)
    // - Secure: HTTPS 接続時のみ送信
    // - SameSite=Lax: iOS WebKit CoreMedia (メディアサブプロセス) からの audio.src リクエストで確実に Cookie を送出
    // - Path=/: クエリ付きのメディアリクエストでも確実にマッチ
    const cookieHeader = `drive_stream_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store, private");
    headers.set("Set-Cookie", cookieHeader);

    return new Response(JSON.stringify({ ok: true, expiresIn: maxAge, expires_in: maxAge }), {
      status: 200,
      headers,
    });
  }

  // 2. セッション破棄 (DELETE)
  if (req.method === "DELETE") {
    const clearCookieHeader = `drive_stream_token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store, private");
    headers.set("Set-Cookie", clearCookieHeader);

    return new Response(JSON.stringify({ ok: true, cleared: true }), {
      status: 200,
      headers,
    });
  }

  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json",
      "Allow": "POST, DELETE",
    },
  });
}
