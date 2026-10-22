/**
 * Last.fm スクロブル用メタデータ サニタイズ & インテリジェント正規化
 *
 * - Last.fm の Filtered Artist (ignoredMessage code=1) や Filtered Track (code=2)
 *   を未然に防止し、スクロブル成功率を最大化する純粋関数群。
 * - プレースホルダー（"YouTube", "(不明アーティスト)", "Unknown Artist", "Various Artists" 等）の検知
 * - タイトルからのアーティスト名・曲名の自動分離 ("Artist - Track", "Artist「Track」" 等)
 * - YouTube 特有のゴミ文字列 (トピックチャンネル " - Topic", "【MV】", 公式タグ等) や不可視文字の除去
 */

/**
 * プレースホルダー（無効またはLast.fm規約で拒否されるアーティスト名）判定
 * @param {string|unknown} artist
 * @returns {boolean}
 */
export function isPlaceholderArtist(artist) {
  if (!artist || typeof artist !== "string") return true;
  const trimmed = artist.trim();
  if (!trimmed) return true;

  // 記号や空白を取り除いた小文字比較用文字列
  const s = trimmed.toLowerCase().replace(/[\s\-_・/／\\()（）[\]「」『』]+/g, "");
  if (!s) return true;

  // 数字のみ（例: "01", "2", "001"）やトラック番号形式（例: "01.", "Track 1"）はアーティスト名とみなさない
  if (/^\d+$/.test(s) || /^track\s*\d+$/i.test(trimmed)) return true;

  const placeholders = new Set([
    "youtube",
    "savetube",
    "dirpy",
    "soundcloud",
    "niconico",
    "bilibili",
    "googledrive",
    "gdrive",
    "drive",
    "download",
    "downloads",
    "music",
    "mymusic",
    "audio",
    "sound",
    "voice",
    "recording",
    "album",
    "single",
    "singles",
    "root",
    "folder",
    "local",
    "video",
    "unknownartist",
    "unknown",
    "unknownsong",
    "不明なアーティスト",
    "不明アーティスト",
    "不明",
    "アーティスト不明",
    "アーティスト名不明",
    "不明な曲",
    "variousartists",
    "various",
    "va",
    "v/a",
    "v.a.",
    "none",
    "null",
    "undefined",
    "true",
    "false",
    "マイドライブ",
    "musicplayer",
    "test",
    "artist",
    "noartist",
    "トラック",
    "track",
    "track01",
  ]);

  if (placeholders.has(s)) return true;

  // 単独のハイフンやピリオド、クエスチョンマークなどの記号のみ
  if (/^[-–—~〜.?*#_!/]+$/.test(trimmed)) return true;

  // 音声ファイルの拡張子のみ (.mp3, .m4a など)
  if (/^\.(mp3|flac|m4a|wav|aac|ogg|opus|webm|wma)$/i.test(trimmed)) return true;

  return false;
}

/**
 * アーティスト名から不可視文字・不要な装飾・ゴミ文字列を除去
 * @param {string|unknown} artist
 * @returns {string}
 */
export function cleanArtistName(artist) {
  if (!artist || typeof artist !== "string") return "";
  let s = artist;

  // 1. 不可視文字・ゼロ幅文字・ASCII/C1制御文字・NULL文字・BOMの完全除去
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\u200B-\u200D]/g, "");

  // 2. URL の除去
  s = s.replace(/https?:\/\/[^\s]+/gi, "").replace(/www\.[^\s]+/gi, "");

  // 3. 末尾のファイル拡張子 (.mp3, .flac 等) の除去
  s = s.replace(/\.(mp3|flac|m4a|wav|aac|ogg|opus|webm|wma)$/i, "");

  // 4. 先頭のトラック番号・記号（例: "01. ", "01 - ", "01 "）の除去
  s = s.replace(/^\s*\d{1,3}[\s._-]+\s*/, "");

  // 5. キャラクターソング特有の (CV: ...) / （CV. ...）の除去 (Last.fm Filter 回避)
  s = s.replace(/\s*[\(（]CV[.:\s][^\)）]+[\)）]/gi, "");

  // 6. YouTube 自動生成トピックチャンネル サフィックスの除去 (例: "YOASOBI - Topic" → "YOASOBI")
  s = s.replace(/\s*[-–—〜~・/]\s*(?:Topic|トピック)$/i, "");
  s = s.replace(/\s+(?:Topic|トピック)$/i, "");

  // 7. 末尾の公式タグ・装飾の除去 (例: "YOASOBI Official Channel" → "YOASOBI", "アーティスト - Official" → "アーティスト")
  //    ※ 先頭の "Official髭男dism" などを破壊しないよう、末尾に限定
  s = s.replace(/\s*[-–—〜~・/]\s*(?:Official\s*Channel|Official\s*YouTube\s*Channel|Official|公式チャンネル|公式|VEVO)$/i, "");
  s = s.replace(/\s+(?:Official\s*Channel|Official\s*YouTube\s*Channel|VEVO)$/i, "");
  s = s.replace(/\s*[\(（](?:Official|公式)[\)）]$/i, "");

  // 8. 前後の空白トリム & 連続空白（全角含む）の統合
  s = s.replace(/[\s\u3000]+/g, " ").trim();

  return s;
}

/**
 * トラック名（曲名）から動画特有の装飾・拡張子・不可視文字を除去
 * @param {string|unknown} title
 * @returns {string}
 */
export function cleanTrackTitle(title) {
  if (!title || typeof title !== "string") return "";
  let s = title;

  // 1. 不可視文字・ゼロ幅文字・ASCII/C1制御文字・NULL文字・BOMの完全除去
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\u200B-\u200D]/g, "");

  // 2. 末尾の拡張子除去
  s = s.replace(/\.(mp3|flac|m4a|wav|aac|ogg|opus|webm|wma)$/i, "");

  // 3. YouTube などの動画装飾タグ（MV, 公式音源, フル尺等）の除去
  const videoDecorations = [
    /【(?:MV|Music\s*Video|Official\s*Video|Official\s*Music\s*Video|Official\s*Audio|Official|Full|Full\s*Song|Lyric\s*Video|Lyrics|歌詞|公式|公式音源|音源|Short\s*Ver\.?|Anime\s*Ver\.?)】/gi,
    /\[(?:MV|Music\s*Video|Official\s*Video|Official\s*Music\s*Video|Official\s*Audio|Official|Full|Full\s*Song|Lyric\s*Video|Lyrics|HD|4K|Audio)\]/gi,
    /\((?:MV|Music\s*Video|Official\s*Video|Official\s*Music\s*Video|Official\s*Audio|Official|Lyric\s*Video|Lyrics|Audio)\)/gi,
  ];
  for (const regex of videoDecorations) {
    s = s.replace(regex, " ");
  }

  // 4. 前後空白トリム & 連続空白の統合
  s = s.replace(/[\s\u3000]+/g, " ").trim();

  return s;
}

/**
 * 動画タイトルやファイル名から "Artist - Track" または "Artist「Track」" を自動分離
 * @param {string|unknown} rawTitle
 * @returns {{ artist: string, title: string } | null}
 */
export function parseArtistAndTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== "string") return null;
  const cleaned = cleanTrackTitle(rawTitle);

  // 1. "Artist - Track" (区切り: " - ", " – ", " — ", " : ", " / ", "／")
  //    先頭または末尾に曲名/アーティストが来ているかを判定
  const delimiterMatch = cleaned.match(/^(.+?)\s*(?:[-–—:]|\s[\/／]\s)\s*(.+)$/);
  if (delimiterMatch) {
    const p1 = cleanArtistName(delimiterMatch[1]);
    const p2 = cleanTrackTitle(delimiterMatch[2]);
    // 先頭がトラック番号（例: "01", "02 - Title", "1. Title" など数字のみ）の場合はアーティスト名と誤認しない
    if (p1 && p2 && !isPlaceholderArtist(p1) && !/^\d+$/.test(p1.replace(/[\s._-]+/g, ""))) {
      return { artist: p1, title: p2 };
    }
  }

  // 2. "Artist「Track」" または "Artist『Track』"
  const bracketMatch = cleaned.match(/^(.+?)\s*[「『](.+?)[」』]/);
  if (bracketMatch) {
    const candArtist = cleanArtistName(bracketMatch[1]);
    const candTitle = cleanTrackTitle(bracketMatch[2]);
    if (candArtist && candTitle && !isPlaceholderArtist(candArtist) && !/^\d+$/.test(candArtist.replace(/[\s._-]+/g, ""))) {
      return { artist: candArtist, title: candTitle };
    }
  }

  // 3. "「Track」/ Artist" または "『Track』/ Artist"
  const revBracketMatch = cleaned.match(/^[「『](.+?)[」』]\s*(?:[-–—:]|\s[\/／]\s)\s*(.+)$/);
  if (revBracketMatch) {
    const candTitle = cleanTrackTitle(revBracketMatch[1]);
    const candArtist = cleanArtistName(revBracketMatch[2]);
    if (candArtist && candTitle && !isPlaceholderArtist(candArtist) && !/^\d+$/.test(candArtist.replace(/[\s._-]+/g, ""))) {
      return { artist: candArtist, title: candTitle };
    }
  }

  return null;
}

/**
 * スクロブル送信用のメタデータを Last.fm 最適化形式に解決・正規化
 * @param {object} track
 * @returns {{
 *   artist: string,
 *   title: string,
 *   album: string,
 *   albumArtist: string,
 *   isInvalid: boolean,
 *   resolved: boolean,
 *   originalArtist: string,
 *   originalTitle: string
 * } | null}
 */
export function resolveScrobbleTrack(track) {
  if (!track) return null;

  const originalArtist = track.artist || "";
  const originalTitle = track.title || "";
  const originalAlbum = track.album || "";
  const originalAlbumArtist = track.albumArtist || "";

  let artist = cleanArtistName(originalArtist);
  let title = cleanTrackTitle(originalTitle);
  let album = cleanTrackTitle(originalAlbum);
  let albumArtist = cleanArtistName(originalAlbumArtist);
  let resolved = false;

  // アーティスト名決定ロジックの厳格化（誤上書き防止）:
  // track.artist（または track.albumArtist）に有効な文字列（プレースホルダー以外の値）が
  // 既に設定されている場合は、ファイル名やタイトルからの推測ロジックで上書きせず、
  // 登録されている artist（なければ albumArtist）を最優先でそのまま使用する。
  if (!isPlaceholderArtist(artist)) {
    // 登録されたアーティスト名が有効な場合:
    // タイトル先頭にアーティスト名が二重に入っている場合のみタイトル側をクリーンアップする
    // 例: artist: "YOASOBI", title: "YOASOBI - 夜に駆ける" → title: "夜に駆ける"
    const esc = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixRegex = new RegExp(`^${esc}\\s*(?:[-–—:]|\\s[\\/／]\\s)\\s*`, "i");
    if (prefixRegex.test(title)) {
      const stripped = title.replace(prefixRegex, "").trim();
      if (stripped) {
        title = stripped;
        resolved = true;
      }
    }
  } else if (!isPlaceholderArtist(albumArtist)) {
    // artist が無効だが albumArtist が有効な場合
    artist = albumArtist;
    resolved = true;
  } else {
    // artist も albumArtist もプレースホルダー（無効）の場合のみ、タイトルや元ファイル名からの自動分離を試みる
    let parsed = parseArtistAndTitle(originalTitle);
    if (!parsed || isPlaceholderArtist(parsed.artist)) {
      if (track.originalName) {
        parsed = parseArtistAndTitle(track.originalName);
      }
    }
    if (parsed && !isPlaceholderArtist(parsed.artist)) {
      artist = parsed.artist;
      title = parsed.title;
      resolved = true;
    }
  }

  // 1.1 フィーチャリング・コラボレーション表記の分離 (Last.fm Filter 回避)
  // 例: artist: "Eve feat. suis", title: "平行線" → artist: "Eve", title: "平行線 (feat. suis)"
  const featMatch = artist.match(/^(.+?)\s*(?:[\(（]?(?:feat\.?|ft\.?|featuring|with)[\s:.]+(.+?)[\)）]?)$/i);
  if (featMatch) {
    const mainArt = cleanArtistName(featMatch[1]);
    const guestArt = cleanArtistName(featMatch[2]);
    if (mainArt && !isPlaceholderArtist(mainArt)) {
      artist = mainArt;
      if (guestArt && !title.toLowerCase().includes(guestArt.toLowerCase())) {
        title = `${title} (feat. ${guestArt})`;
      }
      resolved = true;
    }
  }

  // 2. アルバム名が "YouTube" や "Google Drive" などのプレースホルダーなら除外（Last.fm のアルバム汚染を防ぐ）
  if (isPlaceholderArtist(album) || album.toLowerCase().includes("google drive")) {
    album = "";
  }

  // 3. albumArtist:
  //    ★ Last.fm API の重大仕様対策:
  //    track.scrobble / track.updateNowPlaying に albumArtist を送信すると、
  //    Last.fm がアルバムアーティストでの検証を優先し、トラックの artist が実在しても
  //    "ignoredMessage code=1 (Artist ignored / Filtered artist)" で拒否する致命的不具合が存在する。
  //    Web Scrobbler / Navidrome など主要スクロブラーの標準仕様に準拠し、
  //    Last.fm 送信用メタデータでは albumArtist を送信パラメータから完全に除外 ("") する。
  albumArtist = "";

  // 最終検証: artist が未だにプレースホルダー、または title が空の場合は Last.fm で拒否される
  const isInvalid = isPlaceholderArtist(artist) || !title;

  return {
    ...track,
    artist,
    title: title || "(無題)",
    album,
    albumArtist,
    isInvalid,
    resolved,
    originalArtist,
    originalTitle,
  };
}
