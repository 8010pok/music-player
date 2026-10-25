// 同期JSON スキーマ v3 vs v4 サイズ比較・重複排除ベンチマーク測定スクリプト
import { computeArtworkHash, isValidArtworkDataUrl } from "../js/store/sync-service.js";

function generateMockTrack(id, albumIdx, hasArt = false, artDataUrl = null) {
  return {
    id: `trk-${id}`,
    title: `Track Title Number ${id}`,
    artist: `Artist Name ${albumIdx % 50}`,
    album: `Album Title ${albumIdx}`,
    albumArtist: `Artist Name ${albumIdx % 50}`,
    duration: 215.5,
    trackNo: (id % 10) + 1,
    discNo: 1,
    year: "2024",
    genre: "Pop",
    addedAt: 1729000000000,
    updatedAt: 1729000000000,
    userEdited: true,
    loved: id % 3 === 0,
    playCount: id % 10,
    lastPlayedAt: 1729000000000,
    enabled: true,
    hasArtwork: hasArt,
    ...(artDataUrl ? { artworkDataUrl: artDataUrl } : {})
  };
}

/**
 * 600x600 の JPEG / PNG 相当の Base64 文字列（実測 102,400 バイト ＝ 100.00 KB）
 * 各アルバムごとにトークンを全体に敷き詰め、真に異なる内容のBase64を生成
 */
export function generateAlbumImage(albumIndex) {
  const header = "data:image/jpeg;base64,";
  const token = `ALBUM_${String(albumIndex).padStart(6, "0")}_COVER_ART_DATA_`;
  const targetLen = 102400 - header.length;
  const repeatCount = Math.floor(targetLen / token.length);
  const remainder = targetLen % token.length;
  return header + token.repeat(repeatCount) + token.slice(0, remainder);
}

function measureV3(tracks) {
  const t0 = performance.now();
  const syncObj = {
    app: "music-player",
    version: 3,
    schemaVersion: 3,
    deviceId: "dev-test-123456",
    exportedAt: new Date().toISOString(),
    tracksCount: tracks.length,
    playlistsCount: 5,
    tombstonesCount: 10,
    tracks: tracks,
    playlists: [
      { id: "pl-1", name: "Favorites", trackIds: tracks.slice(0, 20).map(t => t.id), updatedAt: 1729000000000 }
    ],
    tombstones: [],
    settings: { gdriveClientId: "xxx", gdriveAutoCache: true, theme: "system" }
  };
  let jsonStr = "";
  let stringifyError = null;
  let stringifyTime = 0;
  let parseTime = 0;
  let parseError = null;

  try {
    const s0 = performance.now();
    jsonStr = JSON.stringify(syncObj);
    stringifyTime = performance.now() - s0;
  } catch (err) {
    stringifyError = err.message;
  }

  if (jsonStr) {
    try {
      const p0 = performance.now();
      JSON.parse(jsonStr);
      parseTime = performance.now() - p0;
    } catch (err) {
      parseError = err.message;
    }
  }

  const bytes = jsonStr ? Buffer.byteLength(jsonStr, "utf8") : 0;
  return {
    bytes,
    kb: (bytes / 1024).toFixed(2),
    mb: (bytes / (1024 * 1024)).toFixed(2),
    stringifyTimeMs: stringifyTime.toFixed(1),
    parseTimeMs: parseTime.toFixed(1),
    stringifyError,
    parseError
  };
}

async function measureV4(tracks) {
  const artworks = {};
  const hashCache = new Map();
  const cleanTracks = [];

  for (const t of tracks) {
    const copy = { ...t };
    delete copy.artworkBlob;
    if (typeof copy.artworkDataUrl === "string" && isValidArtworkDataUrl(copy.artworkDataUrl)) {
      let artId = hashCache.get(copy.artworkDataUrl);
      if (!artId) {
        artId = await computeArtworkHash(copy.artworkDataUrl);
        if (artId) hashCache.set(copy.artworkDataUrl, artId);
      }
      if (artId) {
        artworks[artId] = copy.artworkDataUrl;
        copy.artworkId = artId;
        delete copy.artworkDataUrl;
      }
    }
    cleanTracks.push(copy);
  }

  const syncObj = {
    app: "music-player",
    version: 4,
    schemaVersion: 4,
    deviceId: "dev-test-123456",
    exportedAt: new Date().toISOString(),
    tracksCount: cleanTracks.length,
    playlistsCount: 5,
    tombstonesCount: 10,
    artworksCount: Object.keys(artworks).length,
    artworks,
    tracks: cleanTracks,
    playlists: [
      { id: "pl-1", name: "Favorites", trackIds: cleanTracks.slice(0, 20).map(t => t.id), updatedAt: 1729000000000 }
    ],
    tombstones: [],
    settings: { gdriveClientId: "xxx", gdriveAutoCache: true, theme: "system" }
  };

  let jsonStr = "";
  let stringifyError = null;
  let stringifyTime = 0;
  let parseTime = 0;
  let parseError = null;

  try {
    const s0 = performance.now();
    jsonStr = JSON.stringify(syncObj);
    stringifyTime = performance.now() - s0;
  } catch (err) {
    stringifyError = err.message;
  }

  if (jsonStr) {
    try {
      const p0 = performance.now();
      JSON.parse(jsonStr);
      parseTime = performance.now() - p0;
    } catch (err) {
      parseError = err.message;
    }
  }

  const bytes = jsonStr ? Buffer.byteLength(jsonStr, "utf8") : 0;
  const uniqueArtworkIds = new Set(cleanTracks.map(t => t.artworkId).filter(Boolean));

  return {
    bytes,
    kb: (bytes / 1024).toFixed(2),
    mb: (bytes / (1024 * 1024)).toFixed(2),
    artworksCount: Object.keys(artworks).length,
    artworkIdUniqueCount: uniqueArtworkIds.size,
    stringifyTimeMs: stringifyTime.toFixed(1),
    parseTimeMs: parseTime.toFixed(1),
    stringifyError,
    parseError
  };
}

async function runBenchmark() {
  console.log("==================================================================");
  console.log("   同期JSON v3 vs v4 アートワーク重複排除 ベンチマーク再測定");
  console.log("==================================================================");

  // 1. 画像1枚あたりの実サイズ検証
  const sampleImg = generateAlbumImage(0);
  const header = "data:image/jpeg;base64,";
  const bodyLen = sampleImg.length - header.length;
  const sampleBytes = Buffer.byteLength(sampleImg, "utf8");
  console.log("\n[画像データ詳細]");
  console.log(`- data URL ヘッダー: "${header}" (${Buffer.byteLength(header, "utf8")} bytes)`);
  console.log(`- Base64 データ部分: ${bodyLen} 文字 (${bodyLen} bytes)`);
  console.log(`- 画像1枚の合計サイズ: ${sampleImg.length} 文字 / ${sampleBytes.toLocaleString()} バイト (${(sampleBytes / 1024).toFixed(2)} KB)`);

  // 2. テストA: 同一画像を複数曲で共有する場合（重複排除効果の最大化検証）
  console.log("\n==================================================================");
  console.log("【テスト1: 複数曲で完全に同一画像を共有 (1アルバム10曲)】");
  {
    const tracks = [];
    for (let i = 0; i < 10; i++) {
      tracks.push(generateMockTrack(i, 0, true, sampleImg));
    }
    const v3 = measureV3(tracks);
    const v4 = await measureV4(tracks);
    console.log(`- 曲数: 10曲 (画像あり: 10件 / 画像なし: 0件)`);
    console.log(`- v3 サイズ: ${v3.kb} KB (${v3.mb} MB) [10曲それぞれに100KB保持]`);
    console.log(`- v4 サイズ: ${v4.kb} KB (${v4.mb} MB) [artworks 辞書に1件のみ保持]`);
    console.log(`- artworks 辞書件数: ${v4.artworksCount} 件`);
    console.log(`- Track 内 artworkId ユニーク数: ${v4.artworkIdUniqueCount} 件`);
    console.log(`- 削減率: ${((1 - v4.bytes / v3.bytes) * 100).toFixed(2)}% 削減`);
  }

  // 3. テストB: 正しい条件による再測定 (条件A, B, C)
  const conditions = [
    { label: "条件A", tracksCount: 100, albumsCount: 10, perAlbum: 10 },
    { label: "条件B", tracksCount: 1000, albumsCount: 100, perAlbum: 10 },
    { label: "条件C", tracksCount: 10000, albumsCount: 1000, perAlbum: 10 },
  ];

  for (const cond of conditions) {
    console.log("\n==================================================================");
    console.log(`【${cond.label}: ${cond.tracksCount.toLocaleString()}曲 / ${cond.albumsCount.toLocaleString()}アルバム (各10曲、アルバム毎に異なる100KB画像)】`);

    // アルバム毎にユニークな画像を生成
    const albumImages = [];
    for (let a = 0; a < cond.albumsCount; a++) {
      albumImages.push(generateAlbumImage(a));
    }

    const tracks = [];
    for (let i = 0; i < cond.tracksCount; i++) {
      const albumIdx = Math.floor(i / cond.perAlbum);
      tracks.push(generateMockTrack(i, albumIdx, true, albumImages[albumIdx]));
    }

    // 画像なしTrackの件数確認
    const noArtCount = tracks.filter(t => !t.artworkDataUrl).length;

    let v3Result = { mb: "N/A", bytes: 0, stringifyTimeMs: "N/A", parseTimeMs: "N/A", stringifyError: null };
    try {
      v3Result = measureV3(tracks);
    } catch (err) {
      v3Result.stringifyError = err.message;
    }

    const v4Result = await measureV4(tracks);

    console.log(`- 総曲数: ${cond.tracksCount.toLocaleString()} 曲`);
    console.log(`- アルバム数 (異なる画像数): ${cond.albumsCount.toLocaleString()} 枚`);
    console.log(`- 画像ありTrack件数: ${(cond.tracksCount - noArtCount).toLocaleString()} 件 / 画像なしTrack件数: ${noArtCount} 件`);
    console.log(`- artworks 辞書件数: ${v4Result.artworksCount.toLocaleString()} 件 (期待値: ${cond.albumsCount})`);
    console.log(`- artworkId ユニーク数: ${v4Result.artworkIdUniqueCount.toLocaleString()} 件 (期待値: ${cond.albumsCount})`);

    if (v3Result.stringifyError) {
      console.log(`- v3 JSONサイズ: クラッシュ (${v3Result.stringifyError}) [約 ${((cond.tracksCount * 102400) / (1024 * 1024)).toFixed(1)} MB 相当]`);
    } else {
      console.log(`- v3 JSONサイズ: ${v3Result.mb} MB (${v3Result.kb} KB, ${v3Result.bytes.toLocaleString()} bytes)`);
    }
    console.log(`- v4 JSONサイズ: ${v4Result.mb} MB (${v4Result.kb} KB, ${v4Result.bytes.toLocaleString()} bytes)`);

    if (!v3Result.stringifyError) {
      console.log(`- サイズ削減率: ${((1 - v4Result.bytes / v3Result.bytes) * 100).toFixed(2)}%`);
    } else {
      console.log(`- サイズ削減率: >89% (v3はV8文字列長上限超過でクラッシュ不可逆)`);
    }

    console.log(`- JSON.stringify 所要時間: v4=${v4Result.stringifyTimeMs}ms (v3=${v3Result.stringifyTimeMs}ms)`);
    console.log(`- JSON.parse 所要時間: v4=${v4Result.parseTimeMs}ms (v3=${v3Result.parseTimeMs}ms)`);
    console.log(`- 文字列長エラー/メモリ不足: v4=${v4Result.stringifyError || "なし (正常完了)"} | v3=${v3Result.stringifyError || "なし"}`);
  }

  // 4. 参考: 画像なし (純粋なメタデータのみ)
  console.log("\n==================================================================");
  console.log("【参考: メタデータのみ (画像なし) の JSON サイズ】");
  for (const count of [100, 1000, 10000]) {
    const tracks = [];
    for (let i = 0; i < count; i++) {
      tracks.push(generateMockTrack(i, Math.floor(i / 10), false, null));
    }
    const v3 = measureV3(tracks);
    const v4 = await measureV4(tracks);
    console.log(`- ${count.toLocaleString()} 曲: v3=${v3.kb} KB (${v3.mb} MB) | v4=${v4.kb} KB (${v4.mb} MB)`);
  }
}

runBenchmark().catch(console.error);
