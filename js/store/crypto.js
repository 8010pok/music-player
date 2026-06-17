/**
 * AES-256-GCM による軽量な暗号化ラッパ
 *
 * 鍵は端末固有のシード（UserAgent / 言語 / 言語リスト / 画面サイズ・色深度 / タイムゾーン）から PBKDF2 で導出する。
 * 端末を変えると復号できないが、これは「他端末への流出を抑える」狙いの設計。
 *
 * ★ 脅威モデルと限界（リリースレビューで明記）:
 *   - 守れる範囲: localStorage の casual な覗き見 / 暗号文だけが別端末・サーバへ渡った場合の即時復号、
 *     を抑止する「保存時の難読化」。鍵は端末公開属性由来で本サイト外へは出ない。
 *   - 守れない範囲: 同一オリジンで実行される攻撃者(XSS・悪性拡張・同一オリジンの第三者スクリプト)には
 *     防御にならない。devicePassphrase は同一 JS コンテキストから容易に再構成でき、平文を復元できるため。
 *     そもそも XSS が成立する時点で localStorage 読取・API 直叩き等が可能で、本層は防壁にならない。
 *     根本対策は (a) アプリ全体の XSS 防止(出力は escapeHtml 済み)、(b) より強固にするなら端末属性由来でなく
 *     ランダム鍵を crypto.subtle.generateKey(extractable:false) で生成し IndexedDB に CryptoKey として保存する
 *     方式(鍵を端末外へ取り出せず、属性変化による復号失敗も無くなる)への移行。現状は静的PWAの保存時難読化
 *     として割り切っている。
 *   - 属性変化での復号失敗は getSecret 側で「暗号文を消さず null 返却」して transient 変化から復旧できるようにしている。
 *
 * 出力フォーマット:
 *   base64( salt[16] || iv[12] || ciphertext+tag )
 */

const PBKDF2_ITER = 100_000;
const KEY_LEN = 256;
const SALT_LEN = 16;
const IV_LEN = 12;

/**
 * 端末固有のパスフレーズを構成する。
 * 完全な一意性はないが、サーバへ漏洩した暗号文を簡単に復号させない目的。
 */
function devicePassphrase() {
  const parts = [
    navigator.userAgent || "",
    navigator.language || "",
    (navigator.languages || []).join(","),
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    // タイムゾーンは比較的安定
    Intl.DateTimeFormat().resolvedOptions().timeZone || "",
  ];
  return parts.join("|");
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITER,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}

function bytesToBase64(bytes) {
  // 大きすぎる場合に String.fromCharCode のスタック溢れを避ける
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 文字列を暗号化して base64 を返す
 */
export async function encryptString(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(devicePassphrase(), salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain)
    )
  );
  const out = new Uint8Array(SALT_LEN + IV_LEN + ct.byteLength);
  out.set(salt, 0);
  out.set(iv, SALT_LEN);
  out.set(ct, SALT_LEN + IV_LEN);
  return bytesToBase64(out);
}

/**
 * base64 を復号して文字列を返す
 * 端末固有鍵で復号できない場合は例外
 */
export async function decryptString(b64) {
  const buf = base64ToBytes(b64);
  if (buf.byteLength < SALT_LEN + IV_LEN + 16) {
    throw new Error("暗号文が短すぎます");
  }
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const ct = buf.subarray(SALT_LEN + IV_LEN);
  const key = await deriveKey(devicePassphrase(), salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/**
 * MD5（Last.fm API 署名用）
 *
 * Web Crypto は MD5 をサポートしないので、最小限の純JS実装を提供する。
 * 仕様は RFC 1321。短い文字列にしか使わないので速度より可読性を優先。
 */
export function md5(str) {
  // UTF-8 エンコード
  const enc = new TextEncoder();
  const bytes = enc.encode(str);
  return md5Bytes(bytes);
}

function md5Bytes(bytes) {
  // パディング
  const origBitLen = bytes.length * 8;
  const padLen = (bytes.length + 8) % 64;
  const totalLen = bytes.length + (64 - padLen) + 8;
  const msg = new Uint8Array(totalLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  // 末尾 8 バイトに元のビット長(64bit)を little-endian で書く（下位32bit → 上位32bit の順。
  //   上位も書くので 2GB 超の入力でも正しい長さになる）
  const dv = new DataView(msg.buffer);
  dv.setUint32(totalLen - 8, origBitLen >>> 0, true);
  dv.setUint32(totalLen - 4, Math.floor(origBitLen / 0x100000000) >>> 0, true);

  // 初期値
  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  // 定数
  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const M = new Uint32Array(16);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(offset + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const s = S[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  // little-endian で 16 バイト出力
  const out = new Uint8Array(16);
  const dvOut = new DataView(out.buffer);
  dvOut.setUint32(0, a0 >>> 0, true);
  dvOut.setUint32(4, b0 >>> 0, true);
  dvOut.setUint32(8, c0 >>> 0, true);
  dvOut.setUint32(12, d0 >>> 0, true);

  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += out[i].toString(16).padStart(2, "0");
  }
  return hex;
}
