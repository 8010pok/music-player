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

  const placeholders = new Set([
    "youtube",
    "savetube",
    "dirpy",
    "soundcloud",
    "niconico",
    "bilibili",
    "googledrive",
    "gdrive",
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

  // 1. 不可視文字・ゼロ幅文字・ASCII制御文字・BOMの除去
  s = s.replace(/[\u200B-\u200D\uFEFF\u0000-\u001F\u007F]/g, "");

  // 2. URL の除去
  s = s.replace(/https?:\/\/[^\s]+/gi, "").replace(/www\.[^\s]+/gi, "");

  // 3. 末尾のファイル拡張子 (.mp3, .flac 等) の除去
  s = s.replace(/\.(mp3|flac|m4a|wav|aac|ogg|opus|webm|wma)$/i, "");

  // 4. YouTube 自動生成トピックチャンネル サフィックスの除去 (例: "YOASOBI - Topic" → "YOASOBI")
  s = s.replace(/\s*[-–—〜~・/]\s*(?:Topic|トピック)$/i, "");
  s = s.replace(/\s+(?:Topic|トピック)$/i, "");

  // 5. 末尾の公式タグ・装飾の除去 (例: "YOASOBI Official Channel" → "YOASOBI", "アーティスト - Official" → "アーティスト")
  //    ※ 先頭の "Official髭男dism" などを破壊しないよう、末尾に限定
  s = s.replace(/\s*[-–—〜~・/]\s*(?:Official\s*Channel|Official\s*YouTube\s*Channel|Official|公式チャンネル|公式|VEVO)$/i, "");
  s = s.replace(/\s+(?:Official\s*Channel|Official\s*YouTube\s*Channel|VEVO)$/i, "");

  // 6. 前後の空白トリム & 連続空白（全角含む）の統合
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

  // 1. 不可視文字・ゼロ幅文字・制御文字の除去
  s = s.replace(/[\u200B-\u200D\uFEFF\u0000-\u001F\u007F]/g, "");

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
    if (p1 && p2 && !isPlaceholderArtist(p1)) {
      return { artist: p1, title: p2 };
    }
  }

  // 2. "Artist「Track」" または "Artist『Track』"
  const bracketMatch = cleaned.match(/^(.+?)\s*[「『](.+?)[」』]/);
  if (bracketMatch) {
    const candArtist = cleanArtistName(bracketMatch[1]);
    const candTitle = cleanTrackTitle(bracketMatch[2]);
    if (candArtist && candTitle && !isPlaceholderArtist(candArtist)) {
      return { artist: candArtist, title: candTitle };
    }
  }

  // 3. "「Track」/ Artist" または "『Track』/ Artist"
  const revBracketMatch = cleaned.match(/^[「『](.+?)[」』]\s*(?:[-–—:]|\s[\/／]\s)\s*(.+)$/);
  if (revBracketMatch) {
    const candTitle = cleanTrackTitle(revBracketMatch[1]);
    const candArtist = cleanArtistName(revBracketMatch[2]);
    if (candArtist && candTitle && !isPlaceholderArtist(candArtist)) {
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

  // 1. アーティスト名がプレースホルダー（"YouTube", "不明", etc.）の場合の自動救済
  if (isPlaceholderArtist(artist)) {
    // a. タイトルからの自動分離を試みる (例: "YOASOBI - アイドル" → artist: "YOASOBI", track: "アイドル")
    const parsed = parseArtistAndTitle(originalTitle);
    if (parsed && !isPlaceholderArtist(parsed.artist)) {
      artist = parsed.artist;
      title = parsed.title;
      resolved = true;
    } else if (!isPlaceholderArtist(albumArtist)) {
      // b. albumArtist が有効ならそれをアーティスト名に採用
      artist = albumArtist;
      resolved = true;
    }
  } else {
    // アーティスト名は有効だが、タイトル先頭にアーティスト名が二重に入っている場合のクリーンアップ
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
  }

  // 2. アルバム名が "YouTube" などのプレースホルダーなら除外（Last.fm のアルバム汚染を防ぐ）
  if (isPlaceholderArtist(album)) {
    album = "";
  }

  // 3. albumArtist:
  //    Last.fm 公式仕様: "The album artist - if different to the artist of the track."
  //    artist と同一、またはプレースホルダーならパラメータから除外して余計な競合・フィルタを防ぐ
  if (isPlaceholderArtist(albumArtist) || albumArtist.toLowerCase() === artist.toLowerCase()) {
    albumArtist = "";
  }

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
