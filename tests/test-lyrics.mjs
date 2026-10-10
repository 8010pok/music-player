/**
 * 歌詞抽出モジュール(js/metadata/lyrics.js)の単体テスト
 *
 * 実行: node tests/test-lyrics.mjs
 *
 * ★コピーではなく実装本体を直接 import して検証する(旧来のコピー版テストの轍を踏まない)。
 *   LRC パーサ / USLT / SYLT / 埋め込み ID3 / Vorbis 歌詞キー を網羅。
 */

import {
  parseLrc, parseUSLT, parseSYLT, extractId3Lyrics,
  applyVorbisLyricTag, hasLyrics, makeLyrics,
} from "../js/metadata/lyrics.js";
import {
  cleanTitleForLyrics, cleanArtistForLyrics, fetchOnlineLyrics,
} from "../js/metadata/lrclib.js";

let passCount = 0, failCount = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passCount++; console.log(`  ✓ ${msg}`); }
  else { failCount++; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { passCount++; console.log(`  ✓ ${msg}`); }
  else {
    failCount++;
    const m = `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(m);
    console.error(`  ✗ ${m}`);
  }
}
function describe(name, fn) { console.log(`\n=== ${name} ===`); fn(); }

/* ---- バイト構築ヘルパ ---- */
const enc = new TextEncoder();
function ascii(s) { return Array.from(s, (c) => c.charCodeAt(0)); }
function utf8(s) { return Array.from(enc.encode(s)); }
function u32be(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function synchsafe(n) { return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]; }
function bytes(arr) { return Uint8Array.from(arr); }
// UTF-16 LE/BE バイト列(BMP前提。テスト用)
function utf16le(s) { const o = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o.push(c & 0xff, (c >> 8) & 0xff); } return o; }
function utf16be(s) { const o = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o.push((c >> 8) & 0xff, c & 0xff); } return o; }
// ID3 フレーム/タグ構築(v2.3=素u32beサイズ / v2.4=synchsafeサイズ)
function id3v23Frame(id, body) { return [...ascii(id), ...u32be(body.length), 0x00, 0x00, ...body]; }
function id3v24Frame(id, body) { return [...ascii(id), ...synchsafe(body.length), 0x00, 0x00, ...body]; }
function id3Tag(majorVer, flags, tagBody) { return bytes([...ascii("ID3"), majorVer, 0x00, flags, ...synchsafe(tagBody.length), ...tagBody]); }

/* ============ parseLrc ============ */
describe("parseLrc", () => {
  assertEqual(
    parseLrc("[00:12.34]Hello\n[01:05.00]World"),
    [{ timeMs: 12340, text: "Hello" }, { timeMs: 65000, text: "World" }],
    "基本: [mm:ss.xx] 2行"
  );
  assertEqual(
    parseLrc("[ti:Title]\n[ar:Artist]\n[00:01.00]Line"),
    [{ timeMs: 1000, text: "Line" }],
    "メタ行([ti:]/[ar:])は無視"
  );
  assertEqual(
    parseLrc("[00:01.00][00:05.00]Repeat"),
    [{ timeMs: 1000, text: "Repeat" }, { timeMs: 5000, text: "Repeat" }],
    "同一行に複数タイムタグ"
  );
  assertEqual(
    parseLrc("[00:12:50]Colon"),
    [{ timeMs: 12500, text: "Colon" }],
    "[mm:ss:xx] コロン区切りのサブ秒"
  );
  assertEqual(parseLrc("ただの歌詞\nタグ無し"), null, "時間タグ無し → null");
  assertEqual(parseLrc(""), null, "空文字 → null");
  assertEqual(parseLrc(null), null, "null → null");
  // ソート: 逆順入力でも昇順で返る
  assertEqual(
    parseLrc("[00:05.00]B\n[00:01.00]A"),
    [{ timeMs: 1000, text: "A" }, { timeMs: 5000, text: "B" }],
    "timeMs 昇順ソート"
  );
});

/* ============ parseUSLT ============ */
describe("parseUSLT", () => {
  // enc=0x03(UTF-8), lang="eng", 空descriptor(0x00), 本文
  assertEqual(
    parseUSLT(bytes([0x03, ...ascii("eng"), 0x00, ...utf8("Hello\nWorld")])),
    "Hello\nWorld",
    "UTF-8 / 空descriptor / 改行保持"
  );
  // enc=0x00(ISO-8859-1)
  assertEqual(
    parseUSLT(bytes([0x00, ...ascii("eng"), 0x00, ...ascii("Plain lyric")])),
    "Plain lyric",
    "ISO-8859-1"
  );
  // descriptor付き(無視されて本文だけ返る)
  assertEqual(
    parseUSLT(bytes([0x03, ...ascii("eng"), ...utf8("desc"), 0x00, ...utf8("Body")])),
    "Body",
    "descriptor有り → 本文のみ"
  );
  // \r\n を \n に正規化
  assertEqual(
    parseUSLT(bytes([0x03, ...ascii("eng"), 0x00, ...utf8("A\r\nB")])),
    "A\nB",
    "CRLF → LF 正規化"
  );
  assertEqual(parseUSLT(bytes([0x03])), null, "短すぎ → null");
});

/* ============ parseSYLT ============ */
describe("parseSYLT", () => {
  // enc=0x03, lang="eng", timeFormat=0x02(ms), contentType=0x01, 空descriptor, [行+\0+ts]*
  const body = bytes([
    0x03, ...ascii("eng"), 0x02, 0x01, 0x00,
    ...utf8("\nLine1"), 0x00, ...u32be(1000),
    ...utf8("\nLine2"), 0x00, ...u32be(5000),
  ]);
  assertEqual(
    parseSYLT(body),
    [{ timeMs: 1000, text: "Line1" }, { timeMs: 5000, text: "Line2" }],
    "ms形式 / 行頭\\n除去 / 2行"
  );
  // timeFormat=0x01(MPEGフレーム) → 同期不可で null
  const frameFmt = bytes([
    0x03, ...ascii("eng"), 0x01, 0x01, 0x00,
    ...utf8("\nX"), 0x00, ...u32be(10),
  ]);
  assertEqual(parseSYLT(frameFmt), null, "timeFormat=1(フレーム) → null");
  // 逆順タイムスタンプでも昇順ソート
  const rev = bytes([
    0x03, ...ascii("eng"), 0x02, 0x01, 0x00,
    ...utf8("\nLate"), 0x00, ...u32be(9000),
    ...utf8("\nEarly"), 0x00, ...u32be(1000),
  ]);
  assertEqual(
    parseSYLT(rev),
    [{ timeMs: 1000, text: "Early" }, { timeMs: 9000, text: "Late" }],
    "timeMs 昇順ソート"
  );
  assertEqual(parseSYLT(bytes([0x03, 0x00, 0x00])), null, "短すぎ → null");
});

/* ============ extractId3Lyrics (WAV id3 チャンク用) ============ */
describe("extractId3Lyrics", () => {
  // ID3v2.3 タグに USLT フレーム1つ
  const usltBody = [0x03, ...ascii("eng"), 0x00, ...utf8("FullTag Lyrics")];
  const frame = [...ascii("USLT"), ...u32be(usltBody.length), 0x00, 0x00, ...usltBody]; // v2.3: size は素のu32be
  const tagBody = frame;
  const tag = bytes([...ascii("ID3"), 0x03, 0x00, 0x00, ...synchsafe(tagBody.length), ...tagBody]);
  const res = extractId3Lyrics(tag);
  assertEqual(res, { synced: null, unsynced: "FullTag Lyrics" }, "ID3v2.3 USLT 抽出");

  // ID3 ヘッダ不正 → null
  assertEqual(extractId3Lyrics(bytes([0x00, 0x01, 0x02, ...new Array(20).fill(0)])), null, "ID3でない → null");
  assertEqual(extractId3Lyrics(bytes([0x49, 0x44])), null, "短すぎ → null");
});

/* ============ applyVorbisLyricTag ============ */
describe("applyVorbisLyricTag", () => {
  // UNSYNCEDLYRICS
  let m = {};
  assert(applyVorbisLyricTag("UNSYNCEDLYRICS", "Line A\nLine B", m) === true, "UNSYNCEDLYRICS は処理される");
  assertEqual(m.lyrics, { synced: null, unsynced: "Line A\nLine B" }, "UNSYNCEDLYRICS → unsynced");

  // SYNCEDLYRICS(LRC)
  m = {};
  applyVorbisLyricTag("SYNCEDLYRICS", "[00:01.00]Hi\n[00:03.00]Yo", m);
  assertEqual(m.lyrics, { synced: [{ timeMs: 1000, text: "Hi" }, { timeMs: 3000, text: "Yo" }], unsynced: null }, "SYNCEDLYRICS(LRC) → synced");

  // LYRICS が LRC 形式 → synced
  m = {};
  applyVorbisLyricTag("LYRICS", "[00:02.00]L", m);
  assertEqual(m.lyrics, { synced: [{ timeMs: 2000, text: "L" }], unsynced: null }, "LYRICS が LRC → synced");

  // LYRICS がプレーン → unsynced
  m = {};
  applyVorbisLyricTag("LYRICS", "just plain\nlyrics", m);
  assertEqual(m.lyrics, { synced: null, unsynced: "just plain\nlyrics" }, "LYRICS がプレーン → unsynced");

  // 非歌詞キーは false
  assert(applyVorbisLyricTag("TITLE", "X", {}) === false, "非歌詞キー → false(未処理)");
});

/* ============ hasLyrics ============ */
describe("hasLyrics", () => {
  assert(!hasLyrics(null), "null → false");
  assert(!hasLyrics(makeLyrics()), "空(synced/unsynced とも null) → false");
  assert(!hasLyrics({ synced: [], unsynced: "" }), "空配列+空文字 → false");
  assert(!hasLyrics({ synced: null, unsynced: "   " }), "空白のみ → false");
  assert(hasLyrics({ synced: [{ timeMs: 0, text: "a" }], unsynced: null }), "synced 有り → true");
  assert(hasLyrics({ synced: null, unsynced: "詞" }), "unsynced 有り → true");
});

/* ============ parseUSLT: UTF-16 (LYR-T01) ============ */
describe("parseUSLT: UTF-16", () => {
  // enc=0x01: UTF-16(BOM付きLE), 空descriptor(0x00 0x00), BOM+本文
  assertEqual(
    parseUSLT(bytes([0x01, ...ascii("eng"), 0x00, 0x00, 0xff, 0xfe, ...utf16le("Hi\n詞")])),
    "Hi\n詞",
    "enc=1 BOM付きLE / 空descriptor / 改行・日本語保持"
  );
  // enc=0x02: UTF-16BE(BOM無し)
  assertEqual(
    parseUSLT(bytes([0x02, ...ascii("eng"), 0x00, 0x00, ...utf16be("Hello")])),
    "Hello",
    "enc=2 UTF-16BE"
  );
  // enc=0x01: 非空descriptor('d'+終端)→本文のみ(2バイト境界終端の検証)
  assertEqual(
    parseUSLT(bytes([0x01, ...ascii("eng"), ...utf16le("d"), 0x00, 0x00, 0xff, 0xfe, ...utf16le("Body")])),
    "Body",
    "enc=1 非空descriptor → 本文のみ"
  );
});

/* ============ parseUSLT: 終端未検出 (LYR-T09) ============ */
describe("parseUSLT: 終端未検出(破損耐性)", () => {
  assertEqual(
    parseUSLT(bytes([0x03, ...ascii("eng"), ...ascii("ABC")])),
    null,
    "descriptor 0x00終端なし → null"
  );
});

/* ============ parseSYLT: UTF-16 / 非空descriptor / 破損 (LYR-T02,T08,T09) ============ */
describe("parseSYLT: UTF-16・descriptor・破損", () => {
  // enc=0x01 BOM付きLE, ms, 空descriptor, 1行
  assertEqual(
    parseSYLT(bytes([0x01, ...ascii("eng"), 0x02, 0x01, 0x00, 0x00, 0xff, 0xfe, ...utf16le("\nLine"), 0x00, 0x00, ...u32be(1000)])),
    [{ timeMs: 1000, text: "Line" }],
    "enc=1 UTF-16LE / 行頭\\n除去 / 2バイト境界終端"
  );
  // enc=0x02 BE, 2行(昇順ソートも兼ねる)
  assertEqual(
    parseSYLT(bytes([0x02, ...ascii("eng"), 0x02, 0x01, 0x00, 0x00,
      ...utf16be("\nLate"), 0x00, 0x00, ...u32be(9000),
      ...utf16be("\nEarly"), 0x00, 0x00, ...u32be(1000)])),
    [{ timeMs: 1000, text: "Early" }, { timeMs: 9000, text: "Late" }],
    "enc=2 UTF-16BE / 2行昇順ソート"
  );
  // 非空 descriptor(UTF-8 'desc')のスキップ
  assertEqual(
    parseSYLT(bytes([0x03, ...ascii("eng"), 0x02, 0x01, ...utf8("desc"), 0x00, ...utf8("\nL1"), 0x00, ...u32be(100)])),
    [{ timeMs: 100, text: "L1" }],
    "非空descriptor のスキップ"
  );
  // 破損: text終端なし & timestamp不足 → null
  assertEqual(
    parseSYLT(bytes([0x03, ...ascii("eng"), 0x02, 0x01, 0x00, ...utf8("noterm")])),
    null,
    "text終端・timestamp欠落 → null(破損耐性)"
  );
});

/* ============ parseLrc: サブ秒桁数 (LYR-T06) ============ */
describe("parseLrc: サブ秒桁数", () => {
  assertEqual(parseLrc("[00:01.500]X"), [{ timeMs: 1500, text: "X" }], "3桁(.500)=1.500秒=1500ms");
  assertEqual(parseLrc("[00:01.5]X"), [{ timeMs: 1500, text: "X" }], "1桁(.5)=1.5秒=1500ms");
  assertEqual(parseLrc("[01:02]X"), [{ timeMs: 62000, text: "X" }], "サブ秒省略=62000ms");
  assertEqual(parseLrc("[00:00.999]X"), [{ timeMs: 999, text: "X" }], "丸め(.999)→999ms");
});

/* ============ extractId3Lyrics: v2.4 / SYLT / 拡張ヘッダ (LYR-T03,T04,T05) ============ */
describe("extractId3Lyrics: v2.4 / SYLT / 拡張ヘッダ", () => {
  // v2.4: synchsafe フレームサイズ(本文128byte超でv2.3読み(素u32be)では破綻する)
  const longText = "A".repeat(200);
  const syltLong = [0x03, ...ascii("eng"), 0x02, 0x01, 0x00, ...utf8("\n" + longText), 0x00, ...u32be(2000)];
  assertEqual(
    extractId3Lyrics(id3Tag(0x04, 0x00, id3v24Frame("SYLT", syltLong))),
    { synced: [{ timeMs: 2000, text: longText }], unsynced: null },
    "v2.4 synchsafeフレームサイズ(128byte超)でSYLT抽出"
  );

  // SYLT 単独 (v2.3)
  const syltFoo = [0x03, ...ascii("eng"), 0x02, 0x01, 0x00, ...utf8("\nFoo"), 0x00, ...u32be(2000)];
  assertEqual(
    extractId3Lyrics(id3Tag(0x03, 0x00, id3v23Frame("SYLT", syltFoo))),
    { synced: [{ timeMs: 2000, text: "Foo" }], unsynced: null },
    "v2.3 SYLT 単独 → synced"
  );

  // SYLT + USLT 併存(複数フレーム連続読みの検証)
  const usltPlain = [0x03, ...ascii("eng"), 0x00, ...utf8("Plain")];
  assertEqual(
    extractId3Lyrics(id3Tag(0x03, 0x00, [...id3v23Frame("SYLT", syltFoo), ...id3v23Frame("USLT", usltPlain)])),
    { synced: [{ timeMs: 2000, text: "Foo" }], unsynced: "Plain" },
    "SYLT+USLT 併存(複数フレーム連続読み)"
  );

  // 拡張ヘッダ付き v2.3 (extSize はヘッダ4byteを含まない → p += 4 + extSize)
  const extV23 = [...u32be(6), 0, 0, 0, 0, 0, 0]; // size欄(=6) + 6byteダミー
  assertEqual(
    extractId3Lyrics(id3Tag(0x03, 0x40, [...extV23, ...id3v23Frame("USLT", usltPlain)])),
    { synced: null, unsynced: "Plain" },
    "v2.3 拡張ヘッダをスキップして後続USLTに到達"
  );

  // 拡張ヘッダ付き v2.4 (extSize は自身含む全長 → p += extSize)
  const extV24 = [...synchsafe(6), 0, 0]; // synchsafe size(=6: 自身4+ダミー2)
  assertEqual(
    extractId3Lyrics(id3Tag(0x04, 0x40, [...extV24, ...id3v24Frame("USLT", usltPlain)])),
    { synced: null, unsynced: "Plain" },
    "v2.4 拡張ヘッダをスキップして後続USLTに到達"
  );
});

/* ============ applyVorbisLyricTag: 複数フィールド結合 (LYR-T07) ============ */
describe("applyVorbisLyricTag: 複数フィールド結合", () => {
  // first-wins: 同一キー2回目は無視
  let m = {};
  applyVorbisLyricTag("UNSYNCEDLYRICS", "first", m);
  applyVorbisLyricTag("UNSYNCEDLYRICS", "second", m);
  assertEqual(m.lyrics.unsynced, "first", "同一キー2回 → first-wins");
  // synced + unsynced 併存
  m = {};
  applyVorbisLyricTag("SYNCEDLYRICS", "[00:01.00]S", m);
  applyVorbisLyricTag("UNSYNCEDLYRICS", "plain", m);
  assertEqual(m.lyrics, { synced: [{ timeMs: 1000, text: "S" }], unsynced: "plain" }, "SYNCED+UNSYNCED 併存");
  // synced 既存時に プレーン LYRICS 後付け → synced維持・unsynced設定
  m = {};
  applyVorbisLyricTag("SYNCEDLYRICS", "[00:02.00]X", m);
  applyVorbisLyricTag("LYRICS", "plain text", m);
  assertEqual(m.lyrics, { synced: [{ timeMs: 2000, text: "X" }], unsynced: "plain text" }, "synced既存+プレーンLYRICS後付け");
});

/* ============ LRCLIB オンライン歌詞ヘルパ ============ */
describe("LRCLIB: タイトル/アーティスト名クリーンアップ", () => {
  assertEqual(cleanTitleForLyrics("01. Bohemian Rhapsody.flac"), "Bohemian Rhapsody", "トラック番号・拡張子除去");
  assertEqual(cleanTitleForLyrics("Song Title (Remastered 2021)"), "Song Title", "(Remastered) 除去");
  assertEqual(cleanTitleForLyrics("Track Name [feat. Artist]"), "Track Name", "[feat. ...] 除去");
  assertEqual(cleanTitleForLyrics("アイドル"), "アイドル", "日本語タイトル保持");
  assertEqual(cleanArtistForLyrics("(Google Drive)"), "", "(Google Drive) は空文字に変換");
  assertEqual(cleanArtistForLyrics("(不明)"), "", "(不明) は空文字に変換");
  assertEqual(cleanArtistForLyrics("Queen (Official)"), "Queen", "公式表記除去");
  assertEqual(cleanArtistForLyrics("YOASOBI"), "YOASOBI", "アーティスト名保持");
});

/* ============ 結果 ============ */
console.log("\n" + "=".repeat(60));
console.log(`合計: ${passCount + failCount} / 成功: ${passCount} / 失敗: ${failCount}`);
if (failCount > 0) {
  console.log("\n失敗一覧:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log("全テスト成功 ✓");
}
