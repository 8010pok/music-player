import sessionHandler from "../api/drive-session.js";
import streamHandler from "../api/drive-stream.js";
import { getDriveProxyStreamUrl } from "../js/gdrive/drive-service.js";
import { strictEqual, ok, deepStrictEqual } from "node:assert";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}:`, err);
    throw err;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}:`, err);
    throw err;
  }
}

async function run() {
  console.log("=== Testing Secure Google Drive Proxy & Session Handlers ===");

  // --- 1. api/drive-session.js tests ---
  await testAsync("drive-session: POST with valid token sets secure HttpOnly cookie", async () => {
    const req = new Request("https://example.com/api/drive-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": "example.com",
        "Origin": "https://example.com",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ token: "ya29.a0AfH6SMB_valid_test_token_string_here_12345" }),
    });
    const res = await sessionHandler(req);
    strictEqual(res.status, 200);
    const data = await res.json();
    strictEqual(data.ok, true);
    strictEqual(data.expires_in, 3600);

    const setCookie = res.headers.get("set-cookie");
    ok(setCookie, "Set-Cookie header must be present");
    ok(setCookie.includes("drive_stream_token="), "Must contain drive_stream_token");
    ok(setCookie.includes("HttpOnly"), "Must be HttpOnly");
    ok(setCookie.includes("Secure"), "Must be Secure");
    ok(setCookie.includes("SameSite=Lax"), "Must be SameSite=Lax");
    ok(setCookie.includes("Path=/"), "Path must match root /");
    ok(setCookie.includes("Max-Age=3600"), "Max-Age must be 3600");
  });

  await testAsync("drive-session: POST with custom expiresIn sets accurate Max-Age", async () => {
    const req = new Request("https://example.com/api/drive-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": "example.com",
        "Origin": "https://example.com",
      },
      body: JSON.stringify({
        token: "ya29.a0AfH6SMB_valid_test_token_string_here_12345",
        expiresIn: 540,
      }),
    });
    const res = await sessionHandler(req);
    strictEqual(res.status, 200);
    const data = await res.json();
    strictEqual(data.expiresIn, 540);
    const setCookie = res.headers.get("set-cookie");
    ok(setCookie.includes("Max-Age=540"), "Max-Age must reflect custom expiresIn");
  });

  await testAsync("drive-session: Cross-origin POST request is rejected (403 Forbidden)", async () => {
    const req = new Request("https://example.com/api/drive-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": "example.com",
        "Origin": "https://malicious-attacker.com",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ token: "ya29.test" }),
    });
    const res = await sessionHandler(req);
    strictEqual(res.status, 403);
    const data = await res.json();
    ok(data.error.includes("cross-origin"));
  });

  await testAsync("drive-session: Invalid token format is rejected (400 Bad Request)", async () => {
    const req = new Request("https://example.com/api/drive-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": "example.com",
        "Origin": "https://example.com",
      },
      body: JSON.stringify({ token: "short" }), // too short or invalid chars
    });
    const res = await sessionHandler(req);
    strictEqual(res.status, 400);
  });

  await testAsync("drive-session: DELETE clears the session cookie", async () => {
    const req = new Request("https://example.com/api/drive-session", {
      method: "DELETE",
      headers: {
        "Host": "example.com",
        "Origin": "https://example.com",
      },
    });
    const res = await sessionHandler(req);
    strictEqual(res.status, 200);
    const setCookie = res.headers.get("set-cookie");
    ok(setCookie.includes("Max-Age=0"), "Cookie must be cleared with Max-Age=0");
  });

  await testAsync("drive-session: Disallowed HTTP methods return 405 Method Not Allowed", async () => {
    const req = new Request("https://example.com/api/drive-session", {
      method: "GET",
      headers: { "Host": "example.com", "Origin": "https://example.com" },
    });
    const res = await sessionHandler(req);
    strictEqual(res.status, 405);
    strictEqual(res.headers.get("allow"), "POST, DELETE");
  });

  // --- 2. api/drive-stream.js tests ---
  await testAsync("drive-stream: Request without auth cookie returns 401 and clears cookie", async () => {
    const req = new Request("https://example.com/api/drive-stream?fileId=1Abc_xYz-12345");
    const res = await streamHandler(req);
    strictEqual(res.status, 401);
    const data = await res.json();
    strictEqual(data.code, "AUTH_REQUIRED");
    const setCookie = res.headers.get("set-cookie");
    ok(setCookie && setCookie.includes("Max-Age=0"), "Cookie must be cleared on 401");
  });

  await testAsync("drive-stream: Request with cross-site sec-fetch-site is rejected (403)", async () => {
    const req = new Request("https://example.com/api/drive-stream?fileId=1Abc_xYz-12345", {
      headers: {
        "Cookie": "drive_stream_token=ya29.valid_token_1234567890",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    const res = await streamHandler(req);
    strictEqual(res.status, 403);
  });

  await testAsync("drive-stream: Invalid or malicious fileId parameter is rejected (400)", async () => {
    const badIds = [
      "../../etc/passwd",
      "https://evil.com/payload",
      "file with spaces",
      "short",
      "bad$char!",
    ];
    for (const badId of badIds) {
      const req = new Request(`https://example.com/api/drive-stream?fileId=${encodeURIComponent(badId)}`, {
        headers: { "Cookie": "drive_stream_token=ya29.valid_token_1234567890" },
      });
      const res = await streamHandler(req);
      strictEqual(res.status, 400, `fileId '${badId}' should return 400`);
    }
  });

  await testAsync("drive-stream: Disallowed methods (POST/PUT/DELETE) return 405", async () => {
    const req = new Request("https://example.com/api/drive-stream?fileId=1Abc_xYz-12345", {
      method: "POST",
      headers: { "Cookie": "drive_stream_token=ya29.valid_token_1234567890" },
    });
    const res = await streamHandler(req);
    strictEqual(res.status, 405);
    strictEqual(res.headers.get("allow"), "GET, HEAD");
  });

  // --- 3. Mock Google Drive API tests for Range and Stream Handling ---
  const originalFetch = globalThis.fetch;

  await testAsync("drive-stream: Range request is forwarded to Google Drive and returns 206 Partial Content with audio/flac", async () => {
    let capturedUpstreamUrl = null;
    let capturedUpstreamHeaders = null;

    globalThis.fetch = async (url, opts) => {
      capturedUpstreamUrl = url;
      capturedUpstreamHeaders = opts.headers;

      // Mock Google Drive 206 response
      const mockBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x66, 0x4c, 0x61, 0x43])); // fLaC
          controller.close();
        },
      });

      return new Response(mockBody, {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "Content-Type": "application/octet-stream", // Google Drive generic MIME
          "Content-Range": "bytes 0-3/1048576",
          "Content-Length": "4",
          "Accept-Ranges": "bytes",
          "ETag": '"abc123etag"',
        },
      });
    };

    try {
      const req = new Request("https://example.com/api/drive-stream?fileId=1SafeFileId_12345&ext=flac", {
        headers: {
          "Cookie": "drive_stream_token=ya29.my_secure_secret_token_12345",
          "Range": "bytes=0-3",
        },
      });

      const res = await streamHandler(req);

      // Verify status and Range headers preserved
      strictEqual(res.status, 206, "Status must be 206 Partial Content");
      strictEqual(res.headers.get("content-range"), "bytes 0-3/1048576");
      strictEqual(res.headers.get("content-length"), "4");
      strictEqual(res.headers.get("accept-ranges"), "bytes");
      strictEqual(res.headers.get("etag"), '"abc123etag"');
      strictEqual(res.headers.get("cache-control"), "private, no-store, no-transform");
      strictEqual(res.headers.get("content-disposition"), "inline");

      // Verify safe MIME correction from application/octet-stream to audio/flac
      strictEqual(res.headers.get("content-type"), "audio/flac");

      // Verify upstream call parameters
      strictEqual(capturedUpstreamUrl, "https://www.googleapis.com/drive/v3/files/1SafeFileId_12345?alt=media");
      strictEqual(capturedUpstreamHeaders["Authorization"], "Bearer ya29.my_secure_secret_token_12345");
      strictEqual(capturedUpstreamHeaders["Range"], "bytes=0-3");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await testAsync("drive-stream: Google Drive 401 token expiry error is classified cleanly without exposing token", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const req = new Request("https://example.com/api/drive-stream?fileId=1SafeFileId_12345", {
        headers: { "Cookie": "drive_stream_token=ya29.expired_token_12345" },
      });
      const res = await streamHandler(req);
      strictEqual(res.status, 401);
      const data = await res.json();
      strictEqual(data.code, "DRIVE_TOKEN_EXPIRED");
      // Must clear cookie
      const setCookie = res.headers.get("set-cookie");
      ok(setCookie && setCookie.includes("Max-Age=0"), "Cookie must be cleared on upstream 401");
      // Must not be masked as audio/flac
      strictEqual(res.headers.get("content-type"), "application/json");
      // Must not expose the token in response
      strictEqual(JSON.stringify(data).includes("ya29"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await testAsync("drive-stream: Google Drive 404 not found error is classified properly", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { code: 404, message: "File not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const req = new Request("https://example.com/api/drive-stream?fileId=1MissingFileId_12345", {
        headers: { "Cookie": "drive_stream_token=ya29.valid_token_12345" },
      });
      const res = await streamHandler(req);
      strictEqual(res.status, 404);
      const data = await res.json();
      strictEqual(data.code, "DRIVE_NOT_FOUND");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await testAsync("drive-stream: HEAD request returns headers without body", async () => {
    globalThis.fetch = async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "3",
          "Accept-Ranges": "bytes",
        },
      });
    };

    try {
      const req = new Request("https://example.com/api/drive-stream?fileId=1SafeFileId_12345&ext=flac", {
        method: "HEAD",
        headers: { "Cookie": "drive_stream_token=ya29.valid_token_12345" },
      });
      const res = await streamHandler(req);
      strictEqual(res.status, 200);
      strictEqual(res.headers.get("content-type"), "audio/flac");
      strictEqual(res.headers.get("content-length"), "3");
      const body = await res.text();
      strictEqual(body, "", "HEAD body must be empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- 4. Client URL Generator tests ---
  test("getDriveProxyStreamUrl generates clean same-origin URL without token", () => {
    const track = { id: "gd-testFileId123", format: "flac" };
    const url = getDriveProxyStreamUrl(track);
    strictEqual(url.startsWith("/api/drive-stream?"), true, "Must start with /api/drive-stream");
    strictEqual(url.includes("fileId=testFileId123"), true, "Must contain fileId");
    strictEqual(url.includes("ext=flac"), true, "Must contain ext=flac");
    strictEqual(url.includes("token"), false, "Must NEVER contain token");
    strictEqual(url.includes("ya29"), false, "Must NEVER contain ya29");
  });

  // --- 5. Google Drive Redirect (.googleusercontent.com) and Streaming Test ---
  await testAsync("drive-stream: Follows redirect to .googleusercontent.com and maintains 206 stream", async () => {
    let redirectCount = 0;
    globalThis.fetch = async (url) => {
      redirectCount++;
      if (url.includes("googleapis.com")) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "https://doc-01-docs.googleusercontent.com/download/storage/v1/b/flac-file",
          },
        });
      }
      return new Response(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": "bytes 0-3/1000",
          "Content-Length": "4",
          "Accept-Ranges": "bytes",
        },
      });
    };

    try {
      const req = new Request("https://example.com/api/drive-stream?fileId=1RedirectFile_12345&ext=flac", {
        headers: { "Cookie": "drive_stream_token=ya29.valid_token_12345" },
      });
      const res = await streamHandler(req);
      strictEqual(res.status, 206);
      strictEqual(res.headers.get("content-type"), "audio/flac");
      strictEqual(redirectCount, 2, "Must follow 302 redirect to googleusercontent.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\nSecure Google Drive Proxy テスト: ${passed} 件 PASSED ✓`);
}

run().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
