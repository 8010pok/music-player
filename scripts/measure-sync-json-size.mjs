// 同期JSONのサイズ測定スクリプト

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

// 600x600 の JPEG / PNG 相当の Base64 文字列（約 80KB 〜 120KB）
// 1000x1000 の JPEG / PNG 相当の Base64 文字列（約 300KB 〜 500KB）
const base64_600x600 = "data:image/jpeg;base64," + "A".repeat(100 * 1024); // 約100KB
const base64_1000x1000 = "data:image/jpeg;base64," + "B".repeat(400 * 1024); // 約400KB

function measureJson(tracks) {
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
  return {
    bytes,
    kb: (bytes / 1024).toFixed(2),
    mb: (bytes / (1024 * 1024)).toFixed(2)
  };
}

console.log("=== 同期JSON サイズ測定結果 ===");

// 1. 画像なし（メタデータのみ）
for (const count of [100, 1000, 10000]) {
  const tracks = [];
  for (let i = 0; i < count; i++) {
    tracks.push(generateMockTrack(i, false, null));
  }
  const m = measureJson(tracks);
  console.log(`[メタデータのみ] ${count.toLocaleString()} 曲: ${m.kb} KB (${m.mb} MB)`);
}

// 2. アルバム10曲に 600x600 画像（100KB Base64）を設定した場合
{
  const tracks = [];
  for (let i = 0; i < 10; i++) {
    tracks.push(generateMockTrack(i, true, base64_600x600));
  }
  const m = measureJson(tracks);
  console.log(`\n[600x600画像 (100KB) × 10曲 (同一画像)]: ${m.kb} KB (${m.mb} MB)`);
  console.log(` -> 1曲あたり画像サイズ: ~100KB, 10曲で約1MBに達する (重複保存による肥大化)`);
}

// 3. アルバム10曲に 1000x1000 画像（400KB Base64）を設定した場合
{
  const tracks = [];
  for (let i = 0; i < 10; i++) {
    tracks.push(generateMockTrack(i, true, base64_1000x1000));
  }
  const m = measureJson(tracks);
  console.log(`\n[1000x1000画像 (400KB) × 10曲 (同一画像)]: ${m.kb} KB (${m.mb} MB)`);
  console.log(` -> 1曲あたり画像サイズ: ~400KB, 10曲で約4MBに達する (重複保存による肥大化)`);
}

// 4. もし 100曲、1000曲、10000曲すべてに 600x600 画像が含まれていた場合
for (const count of [100, 1000]) {
  const tracks = [];
  for (let i = 0; i < count; i++) {
    tracks.push(generateMockTrack(i, true, base64_600x600));
  }
  const m = measureJson(tracks);
  console.log(`\n[全曲600x600画像付き試算] ${count.toLocaleString()} 曲: ${m.mb} MB`);
}
