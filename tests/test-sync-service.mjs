/**
 * 端末間同期・エクスポート/インポートサービスの単体テスト
 *
 * 実行: node tests/test-sync-service.mjs
 */

import { strictEqual, ok, deepStrictEqual, rejects } from "node:assert";
import { importLibraryData } from "../js/store/sync-service.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

console.log("=== 端末間同期データ検証テスト ===");

await asyncTest("不正なJSON文字列でエラーを投げる", async () => {
  await rejects(
    async () => {
      await importLibraryData("{ invalid json }");
    },
    { message: /無効な JSON フォーマット/ }
  );
});

await asyncTest("tracks配列が含まれない場合エラーを投げる", async () => {
  await rejects(
    async () => {
      await importLibraryData({ version: 1 });
    },
    { message: /曲データ \(tracks\) が含まれていません/ }
  );
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("同期サービス テスト成功 ✓");
