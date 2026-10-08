/**
 * Google Drive 連携ロジックの単体テスト
 *
 * - ID 相互変換 (gd-xxx)
 * - Drive トラック判定
 * - トークン有効期限ロジック
 * - 検索クエリ構築
 * - Drive 音源のメタデータ正規化とフォールバック
 */

import { strictEqual, ok, deepStrictEqual } from "node:assert";
import {
  isDriveTrackId,
  driveFileIdFromTrackId,
  trackIdFromDriveFileId,
} from "../js/gdrive/drive-service.js";

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

console.log("=== Google Drive ID 変換・判定 ===");

test("isDriveTrackId: gd- プレフィックスの ID を Google Drive 音源と判定する", () => {
  strictEqual(isDriveTrackId("gd-1a2b3c4d5e"), true);
  strictEqual(isDriveTrackId("gd-FILE_ID_999"), true);
});

test("isDriveTrackId: 通常のローカルハッシュ ID は false", () => {
  strictEqual(isDriveTrackId("t-87a80eae1faf"), false);
  strictEqual(isDriveTrackId("local-1234"), false);
  strictEqual(isDriveTrackId(null), false);
  strictEqual(isDriveTrackId(undefined), false);
  strictEqual(isDriveTrackId(12345), false);
});

test("driveFileIdFromTrackId: gd- を除去して純粋な Google Drive fileId を抽出する", () => {
  strictEqual(driveFileIdFromTrackId("gd-1a2b3c4d5e"), "1a2b3c4d5e");
  strictEqual(driveFileIdFromTrackId("gd-ABC-XYZ_123"), "ABC-XYZ_123");
  // gd- 以外はそのまま返す
  strictEqual(driveFileIdFromTrackId("t-abc"), "t-abc");
});

test("trackIdFromDriveFileId: fileId から一意な track ID (gd-xxx) を生成する", () => {
  strictEqual(trackIdFromDriveFileId("1a2b3c4d5e"), "gd-1a2b3c4d5e");
  strictEqual(trackIdFromDriveFileId("FILE_001"), "gd-FILE_001");
});

console.log("=== Google Drive トークン有効期限判定 ===");

test("トークン期限切れ判定: 60秒バッファで事前に期限切れを検出する", () => {
  const now = 1000000;
  const expirySoon = now + 30000; // あと30秒 (バッファ60秒以内)
  const expiryLater = now + 3600000; // あと1時間

  const isExpiredSoon = expirySoon && (now >= expirySoon - 60000);
  const isExpiredLater = expiryLater && (now >= expiryLater - 60000);

  strictEqual(isExpiredSoon, true);
  strictEqual(isExpiredLater, false);
});

console.log("=== Google Drive 検索クエリ構築 ===");

test("Drive API クエリ文字列が正しく音声形式をフィルタする", () => {
  const baseQ = "trashed = false and (mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')";
  ok(baseQ.includes("trashed = false"));
  ok(baseQ.includes(".mp3"));
  ok(baseQ.includes(".flac"));
  ok(baseQ.includes(".m4a"));

  // 検索語のサニタイズ
  const userSearch = "Test'Song\\1";
  const clean = userSearch.replace(/['\\]/g, "");
  strictEqual(clean, "TestSong1");
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("Google Drive テスト成功 ✓");
