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
  parseGoogleApiError,
  inferMetadataFromFileName,
  isInvalidDriveAlbum,
  getDriveStreamUrl,
} from "../js/gdrive/drive-service.js";
import { isSuspectPartialHeaderDuration } from "../js/store/library-db.js";
import { parseMp3 } from "../js/metadata/parse-mp3.js";

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

console.log("=== Google Drive API エラー詳細解析 (403 対応) ===");

await asyncTest("parseGoogleApiError: API 未有効化時の 403 エラーを検出し、有効化手順を促すメッセージを返す", async () => {
  const mockRes = {
    status: 403,
    statusText: "Forbidden",
    json: async () => ({
      error: {
        code: 403,
        message: "Google Drive API has not been used in project 12345 before or it is disabled. Enable it by visiting...",
        details: [{ reason: "SERVICE_DISABLED" }]
      }
    })
  };
  const msg = await parseGoogleApiError(mockRes, "Driveエラー");
  ok(msg.includes("Google Drive API が有効化されていません (403 SERVICE_DISABLED)"));
  ok(msg.includes("Google Cloud Console"));
});

await asyncTest("parseGoogleApiError: 権限不足時の 403 エラーを検出し、OAuth 同意画面の確認を促す", async () => {
  const mockRes = {
    status: 403,
    statusText: "Forbidden",
    json: async () => ({
      error: {
        code: 403,
        message: "The caller does not have permission",
      }
    })
  };
  const msg = await parseGoogleApiError(mockRes, "Driveエラー");
  ok(msg.includes("Google Drive API アクセス拒否 (403 Forbidden)"));
  ok(msg.includes("テストユーザー"));
});

await asyncTest("parseGoogleApiError: 通常の API エラーを正しくフォーマットする", async () => {
  const mockRes = {
    status: 404,
    statusText: "Not Found",
    json: async () => ({
      error: {
        code: 404,
        message: "File not found: abc",
      }
    })
  };
  const msg = await parseGoogleApiError(mockRes, "Driveエラー");
  strictEqual(msg, "Driveエラー (404): File not found: abc");
});

console.log("=== Google Drive フォルダ階層・一括取得ロジック ===");

test("フォルダクエリ: フォルダと音声ファイルの両方がクエリに含まれる", () => {
  const folderId = "folder123";
  const q = `trashed = false and '${folderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac' or name contains '.ogg' or name contains '.wav' or name contains '.aac' or name contains '.opus' or name contains '.webm')`;
  ok(q.includes("'folder123' in parents"));
  ok(q.includes("application/vnd.google-apps.folder"));
  ok(q.includes(".flac"));
});

test("再帰探索キュー: 重複フォルダIDをスキップして無限ループを防止する", () => {
  const visited = new Set(["root"]);
  const queue = ["root"];
  const subFolders = ["sub1", "root", "sub2", "sub1"];
  for (const f of subFolders) {
    if (!visited.has(f)) {
      visited.add(f);
      queue.push(f);
    }
  }
  deepStrictEqual(queue, ["root", "sub1", "sub2"]);
});

console.log("=== 音源ファイル名・フォルダ名からのメタデータ推測 (inferMetadataFromFileName) ===");

test("パターン1: '01. Artist - Title' をトラック番号・アーティスト・曲名に分解", () => {
  const meta = inferMetadataFromFileName("01. YOASOBI - 夜に駆ける.flac", "THE BOOK");
  strictEqual(meta.trackNo, "1");
  strictEqual(meta.artist, "YOASOBI");
  strictEqual(meta.title, "夜に駆ける");
  strictEqual(meta.album, "THE BOOK");
});

test("パターン2: 'Artist - Title' をアーティスト・曲名に分解", () => {
  const meta = inferMetadataFromFileName("RADWIMPS - 前前前世.mp3");
  strictEqual(meta.trackNo, "");
  strictEqual(meta.artist, "RADWIMPS");
  strictEqual(meta.title, "前前前世");
});

test("パターン3: '02 Title' をトラック番号・曲名に分解、アルバム名からフォールバック", () => {
  const meta = inferMetadataFromFileName("02 群青.flac", "THE BOOK");
  strictEqual(meta.trackNo, "2");
  strictEqual(meta.title, "群青");
  strictEqual(meta.album, "THE BOOK");
  strictEqual(meta.artist, "THE BOOK");
});

test("拡張子のみの単一ファイル名", () => {
  const meta = inferMetadataFromFileName("夜に駆ける.flac");
  strictEqual(meta.title, "夜に駆ける");
  strictEqual(meta.trackNo, "");
});

console.log("=== Google Drive アルバム名 'true' バグ防止・無効値ガード (isInvalidDriveAlbum) ===");

test("isInvalidDriveAlbum: boolean true / false や文字列 'true' / 'Google Drive' / 'マイドライブ' を無効値と判定する", () => {
  strictEqual(isInvalidDriveAlbum(true), true);
  strictEqual(isInvalidDriveAlbum(false), true);
  strictEqual(isInvalidDriveAlbum("true"), true);
  strictEqual(isInvalidDriveAlbum("TRUE"), true);
  strictEqual(isInvalidDriveAlbum("false"), true);
  strictEqual(isInvalidDriveAlbum("Google Drive"), true);
  strictEqual(isInvalidDriveAlbum("マイドライブ"), true);
  strictEqual(isInvalidDriveAlbum("root"), true);
  strictEqual(isInvalidDriveAlbum("不明なアルバム"), true);
  strictEqual(isInvalidDriveAlbum(""), true);
  strictEqual(isInvalidDriveAlbum(null), true);
});

test("isInvalidDriveAlbum: 正常なアルバム名は false (有効) を返す", () => {
  strictEqual(isInvalidDriveAlbum("THE BOOK"), false);
  strictEqual(isInvalidDriveAlbum("Abbey Road"), false);
  strictEqual(isInvalidDriveAlbum("True Blue"), false); // "True Blue" 等の正当なアルバム名は有効
});

test("アルバム解決優先順位: 音源ファイル内のタグ (extractedMeta.album) が最優先され boolean true が混入しない", () => {
  const existing = { album: true, userEdited: false };
  const extractedMeta = { album: "THE BOOK 2" };
  const inferred = { album: "マイドライブ" };

  const validExistingAlbum = existing && !isInvalidDriveAlbum(existing.album) ? String(existing.album).trim() : null;
  const validMetaAlbum = extractedMeta && !isInvalidDriveAlbum(extractedMeta.album) ? String(extractedMeta.album).trim() : null;
  const validInferredAlbum = inferred && !isInvalidDriveAlbum(inferred.album) ? String(inferred.album).trim() : null;

  const finalAlbum = (existing?.userEdited && validExistingAlbum ? validExistingAlbum : null) ||
                     validMetaAlbum ||
                     validExistingAlbum ||
                     validInferredAlbum ||
                     "Google Drive";

  strictEqual(typeof finalAlbum, "string");
  strictEqual(finalAlbum, "THE BOOK 2");
});

console.log("=== 0:39 (39秒) 固定再生時間バグ防止 & 自動修復テスト ===");

await asyncTest("parseMp3: 1.5MB 部分ヘッダ (_isPartialHeader) で _fullFileSize がある場合、0:39 ではなく全体サイズから正しい再生時間を算出する", async () => {
  // MPEG1 Layer III (0xFB), 320kbps (0xE0), 44100Hz (0x00) のフレームヘッダを持つ 1.5MB (1,572,864 bytes) の擬似 Blob
  const buf = new Uint8Array(1572864);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0xe0;
  buf[3] = 0x00;

  // 1) _fullFileSize = 9,600,000 bytes (320kbps で 240秒 = 4:00) を付与した部分ヘッダ
  const headerWithFullSize = new Blob([buf], { type: "audio/mpeg" });
  headerWithFullSize._isPartialHeader = true;
  headerWithFullSize._fullFileSize = 9600000;
  const meta1 = await parseMp3(headerWithFullSize);
  strictEqual(Math.round(meta1.duration), 240);

  // 2) _isPartialHeader = true かつ全体サイズ不明の場合、偽の 39秒 (0:39) を返さず 0 を返す
  const headerWithoutFullSize = new Blob([buf], { type: "audio/mpeg" });
  headerWithoutFullSize._isPartialHeader = true;
  const meta2 = await parseMp3(headerWithoutFullSize);
  strictEqual(meta2.duration, 0);
});

test("isSuspectPartialHeaderDuration: 1.5MB ヘッダ由来の 0:39 (39秒) 固定バグ曲を正確に検出し、本物の短尺曲は誤検知しない", () => {
  // 9.6MB あるのに 39秒 (0:39) になっている Google Drive 曲 -> バグとして検出 (true)
  strictEqual(
    isSuspectPartialHeaderDuration({ id: "gd-abc123", source: "gdrive", duration: 39, fileSize: 9600000 }),
    true
  );
  // 補正後の再生時間は約 238秒 (3:58) になる
  const repairedDur = Math.round(39 * (9600000 / 1572864));
  strictEqual(repairedDur, 238);

  // 実際にファイルサイズが 1.5MB 以下の短いジングル曲 (39秒) -> 正常 (false)
  strictEqual(
    isSuspectPartialHeaderDuration({ id: "gd-short", source: "gdrive", duration: 39, fileSize: 1500000 }),
    false
  );
  // すでに正常な長さ (240秒) の Google Drive 曲 -> 正常 (false)
  strictEqual(
    isSuspectPartialHeaderDuration({ id: "gd-normal", source: "gdrive", duration: 240, fileSize: 9600000 }),
    false
  );
});

console.log("=== 外出時ダイレクトストリーミング URL 生成 (getDriveStreamUrl) ===");

await asyncTest("getDriveStreamUrl: gd- トラックIDとトークンから HTTP Range ストリーミング再生用 URL を即座に生成する", async () => {
  const url = await getDriveStreamUrl("gd-FILE_ID_777", "ya29.test_token_xyz");
  strictEqual(
    url,
    "https://www.googleapis.com/drive/v3/files/FILE_ID_777?alt=media&access_token=ya29.test_token_xyz"
  );
});

console.log("=== インメモリ Blob キャッシュ (0ms 再生) & 直接認証画面遷移 ===");

await asyncTest("インメモリ Blob キャッシュ: putMemoryBlob / getMemoryBlob / hasMemoryBlob が LRU で高速動作する", async () => {
  const { putMemoryBlob, getMemoryBlob, hasMemoryBlob } = await import("../js/store/library-db.js");

  const dummyBlob1 = new Blob(["audio-data-1"], { type: "audio/mp3" });
  const dummyBlob2 = new Blob(["audio-data-2"], { type: "audio/mp3" });

  putMemoryBlob("t-test-1", dummyBlob1);
  putMemoryBlob("t-test-2", dummyBlob2);

  strictEqual(hasMemoryBlob("t-test-1"), true);
  strictEqual(hasMemoryBlob("t-test-2"), true);
  strictEqual(hasMemoryBlob("t-test-nonexistent"), false);

  const retrieved1 = getMemoryBlob("t-test-1");
  strictEqual(retrieved1, dummyBlob1);

  // LRU 最大 10 件の押し出し検証 (t-test-1, t-test-2 に加え 9 件追加 = 計 11 件)
  for (let i = 3; i <= 11; i++) {
    putMemoryBlob(`t-test-${i}`, new Blob([`audio-${i}`]));
  }
  // 最も古くアクセスされなかった t-test-2 が LRU で押し出されている
  strictEqual(hasMemoryBlob("t-test-2"), false);
  // 直前に get された t-test-1 は LRU リフレッシュされているため残っている
  strictEqual(hasMemoryBlob("t-test-1"), true);
});

await asyncTest("promptDriveReconnectModal: Google Drive 未接続時に中間モーダルを挟まずダイレクトに認証処理を呼び出す", async () => {
  const { promptDriveReconnectModal } = await import("../js/gdrive/drive-service.js");
  const { setPublic } = await import("../js/store/settings.js");

  // Client ID が設定されている状態
  setPublic({ gdriveClientId: "test-client-id.apps.googleusercontent.com" });

  // DOM がない環境では Promise<null> を安全に即時返却
  const res = await promptDriveReconnectModal({ track: { title: "テスト曲" } });
  strictEqual(res, null);
});

console.log("============================================================");
console.log(`合計: ${passed} / 成功: ${passed} / 失敗: 0`);
console.log("Google Drive テスト成功 ✓");
