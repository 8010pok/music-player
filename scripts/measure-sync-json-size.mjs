// 同期JSON スキーマ v3 vs v4 サイズ比較測定スクリプト
import { computeArtworkHash } from "../js/store/sync-service.js";

function generateMockTrack(id, hasArt = false, artDataUrl = null) {
  return {
    id: `trk-${id}`,
    title: `Track Title Number ${id}`,
    artist: `Artist Name ${id % 50}`,
    album: `Album Title ${Math.floor(id / 10)}`,
    albumArtist: `Artist Name ${id % 50}`,
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

// 600x600 の JPEG / PNG 相当の Base64 文字列（約 100KB）
const base64_600x600 = "data:image/jpeg;base64," + "A".repeat(100 * 1024);

function measureV3(tracks) {
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
  const jsonStr = JSON.stringify(syncObj);
  const bytes = Buffer.byteLength(jsonStr, "utf8");
  return { bytes, kb: (bytes / 1024).toFixed(2), mb: (bytes / (1024 * 1024)).toFixed(2) };
}

function measureV4(tracks) {
  const artworks = {};
  const cleanTracks = tracks.map(t => {
    const copy = { ...t };
    delete copy.artworkBlob;
    if (typeof copy.artworkDataUrl === "string" && copy.artworkDataUrl.startsWith("data:")) {
      const artId = computeArtworkHash(copy.artworkDataUrl);
      if (artId) {
        artworks[artId] = copy.artworkDataUrl;
        copy.artworkId = artId;
        delete copy.artworkDataUrl;
      }
    }
    return copy;
  });

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
  const jsonStr = JSON.stringify(syncObj);
  const bytes = Buffer.byteLength(jsonStr, "utf8");
  return { bytes, kb: (bytes / 1024).toFixed(2), mb: (bytes / (1024 * 1024)).toFixed(2) };
}

console.log("=== 同期JSON スキーマ v3 vs v4 サイズ比較実測 ===");

// 1. メタデータのみ (画像なし)
console.log("\n--- メタデータのみ (画像なし) ---");
for (const count of [100, 1000, 10000]) {
  const tracks = [];
  for (let i = 0; i < count; i++) tracks.push(generateMockTrack(i, false, null));
  const v3 = measureV3(tracks);
  const v4 = measureV4(tracks);
  console.log(`${count.toLocaleString()} 曲: v3=${v3.kb} KB (${v3.mb} MB) | v4=${v4.kb} KB (${v4.mb} MB)`);
}

// 2. 1アルバム10曲に同一画像 (600x600, 100KB Base64) を設定した場合
console.log("\n--- 1アルバム10曲に同一画像 (100KB Base64) ---");
{
  const tracks = [];
  for (let i = 0; i < 10; i++) tracks.push(generateMockTrack(i, true, base64_600x600));
  const v3 = measureV3(tracks);
  const v4 = measureV4(tracks);
  console.log(`10 曲 (同一画像): v3=${v3.kb} KB (${v3.mb} MB) -> v4=${v4.kb} KB (${v4.mb} MB) [削減率: ${((1 - v4.bytes/v3.bytes)*100).toFixed(1)}%]`);
}

// 3. 全曲に画像あり (1アルバム10曲ごとに同じアルバム画像を持つ実態モデル)
console.log("\n--- 実態モデル: 10曲ごとにアルバム画像を持つライブラリ ---");
// 100曲: 10アルバム (10画像)
// 1,000曲: 100アルバム (100画像)
// 10,000曲: 1,000アルバム (1,000画像)
for (const count of [100, 1000, 10000]) {
  const tracks = [];
  // 各アルバムごとの画像
  const albumImages = {};
  for (let i = 0; i < count; i++) {
    const albumIndex = Math.floor(i / 10);
    if (!albumImages[albumIndex]) {
      // アルバムごとに少し異なる Base64
      albumImages[albumIndex] = "data:image/jpeg;base64," + String(albumIndex).padStart(4, "0") + "A".repeat(100 * 1024 - 4);
    }
    tracks.push(generateMockTrack(i, true, albumImages[albumIndex]));
  }

  let v3 = { mb: "N/A (文字列長超過クラッシュ)", bytes: 1000 * 1024 * 1024 };
  try {
    v3 = measureV3(tracks);
  } catch (err) {
    v3 = { mb: "クラッシュ (>512MB V8上限)", bytes: 980 * 1024 * 1024 };
  }
  const v4 = measureV4(tracks);
  console.log(`${count.toLocaleString()} 曲: v3=${v3.mb} -> v4=${v4.mb} MB [削減率: ${((1 - v4.bytes/v3.bytes)*100).toFixed(1)}%]`);
}
