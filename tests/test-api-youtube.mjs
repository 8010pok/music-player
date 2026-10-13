import handler from "../api/youtube.js";
import { strictEqual, ok } from "node:assert";

async function test() {
  console.log("=== Testing api/youtube.js handler ===");

  // 1. OPTIONS preflight
  const optReq = new Request("http://localhost/api/youtube", { method: "OPTIONS" });
  const optRes = await handler(optReq);
  strictEqual(optRes.status, 204);
  strictEqual(optRes.headers.get("access-control-allow-origin"), "*");
  console.log("  ✓ OPTIONS preflight test passed");

  // 2. Info request
  const infoReq = new Request("http://localhost/api/youtube?action=info&id=dQw4w9WgXcQ");
  const infoRes = await handler(infoReq);
  strictEqual(infoRes.status, 200);
  const infoData = await infoRes.json();
  ok(infoData.title);
  strictEqual(infoData.videoId, "dQw4w9WgXcQ");
  console.log("  ✓ action=info test passed, title:", infoData.title.slice(0, 30));

  // 3. Stream request with Range
  const streamReq = new Request("http://localhost/api/youtube?action=stream&id=dQw4w9WgXcQ", {
    headers: { Range: "bytes=0-1023" }
  });
  const streamRes = await handler(streamReq);
  strictEqual(streamRes.status, 206);
  strictEqual(streamRes.headers.get("access-control-allow-origin"), "*");
  const streamBuf = await streamRes.arrayBuffer();
  strictEqual(streamBuf.byteLength, 1024);
  console.log("  ✓ action=stream test passed, received bytes:", streamBuf.byteLength);

  console.log("All api/youtube.js tests passed! ✓");
}

test().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
