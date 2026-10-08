/**
 * Service Worker
 * - 静的アセットは Cache-First
 * - Last.fm API リクエストは Network-First（オンライン時は常に最新。通信失敗時のみキャッシュへフォールバック＝TTLなし・件数LRU）
 * - 画像（アートワーク）は Cache-First
 *
 * バージョンを上げると古いキャッシュは破棄される。
 */

const CACHE_VERSION = "v1.2.2";
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const API_CACHE = `api-${CACHE_VERSION}`;
const IMG_CACHE = `img-${CACHE_VERSION}`;

// 事前キャッシュ対象（相対パスで /music-player/ サブパスにも追従）
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/theme.css",
  "./css/layout.css",
  "./css/views.css",
  "./js/app.js",
  "./js/router.js",
  "./js/state.js",
  "./js/store/crypto.js",
  "./js/store/library-db.js",
  "./js/store/queue-db.js",
  "./js/store/settings.js",
  "./js/gdrive/drive-service.js",
  "./js/player/audio-engine.js",
  "./js/player/visualizer.js",
  "./js/player/eq.js",
  "./js/metadata/index.js",
  "./js/metadata/util.js",
  "./js/metadata/album-util.js",
  "./js/metadata/artist-util.js",
  "./js/metadata/parse-mp3.js",
  "./js/metadata/parse-m4a.js",
  "./js/metadata/parse-flac.js",
  "./js/metadata/parse-ogg.js",
  "./js/metadata/parse-wav.js",
  "./js/metadata/parse-webm.js",
  // ★ lyrics.js は parse-mp3/m4a/flac/ogg/wav が静的 import する依存。
  //   precache 漏れだとオフライン初回起動で metadata/index.js の解決が失敗し、
  //   それを静的 import する再生/ライブラリ画面ごと起動不能になるため必ず含める。
  "./js/metadata/lyrics.js",
  "./js/lastfm/api.js",
  "./js/lastfm/auth.js",
  "./js/lastfm/scrobble.js",
  "./js/lastfm/stats.js",
  "./js/lastfm/stats-cache.js",
  "./js/lastfm/stats-compare.js",
  "./js/lastfm/stats-service.js",
  "./js/lastfm/stats-storage.js",
  "./js/workers/stats-worker.js",
  "./js/ui/components.js",
  "./js/ui/artwork-cache.js",
  "./js/ui/metadata-editor.js",
  "./js/ui/view-welcome.js",
  "./js/ui/view-player.js",
  "./js/ui/view-library.js",
  "./js/ui/view-albums.js",
  "./js/ui/view-album.js",
  "./js/ui/view-artist.js",
  "./js/ui/view-playlists.js",
  "./js/ui/view-playlist.js",
  "./js/ui/view-playlist-add.js",
  "./js/ui/view-stats.js",
  "./js/ui/view-settings.js",
  "./js/ui/mini-player.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/favicon.ico",
  "./icons/favicon-16.png",
  "./icons/favicon-32.png",
  "./icons/apple-touch-icon.png",
  "./icons/apple-touch-icon-152.png",
  "./icons/apple-touch-icon-167.png",
  "./icons/apple-touch-icon-180.png",
  // Chart.js は統計画面で使うため事前キャッシュ
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
];

self.addEventListener("install", (event) => {
  // すぐに新バージョンを適用
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // 失敗しても継続（CDNが落ちている等の場合）
      return Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => null))
      );
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // 旧バージョンのキャッシュを削除
      await Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, API_CACHE, IMG_CACHE].includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Last.fm API: Network-First（オンライン時は常に最新、通信失敗時のみキャッシュへフォールバック）。
  //   第3引数はキャッシュ件数上限(肥大防止の簡易LRU)。
  if (url.hostname === "ws.audioscrobbler.com") {
    event.respondWith(networkFirst(req, API_CACHE, 100));
    return;
  }

  // Last.fm 画像（アートワーク）: Cache-First
  if (
    url.hostname.endsWith("last.fm") ||
    url.hostname.includes("lastfm.freetls.fastly.net") ||
    url.hostname.includes("audioscrobbler")
  ) {
    event.respondWith(cacheFirst(req, IMG_CACHE, 300));
    return;
  }

  // Google API や外部認証は SW でキャッシュせず直接通信
  if (
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("google.com") ||
    url.hostname.endsWith("gstatic.com")
  ) {
    return;
  }

  // 静的アセット: Cache-First
  event.respondWith(cacheFirst(req, STATIC_CACHE));
});

/**
 * Cache-First 戦略
 * キャッシュにあれば即返し、なければネットワークから取得してキャッシュへ保存。
 *   maxEntries を渡すと保存後に件数上限で簡易 LRU 間引きする(IMG_CACHE 用)。
 *   STATIC_CACHE(プリキャッシュ済みアプリシェル)は maxEntries 省略=間引かない(アプリ本体の誤削除防止)。
 */
async function cacheFirst(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    // 成功レスポンスのみキャッシュ。opaque(CORSなしのクロスオリジン画像)はステータス不明だが、
    //   オフライン時のアートワーク表示に必要なので保存する。壊れた opaque が固定化しないよう
    //   maxEntries の LRU 間引きで上限を設ける(無制限永続を避ける)。
    if (res && (res.status === 200 || res.type === "opaque")) {
      await cache.put(req, res.clone());
      if (maxEntries) await trimCache(cache, maxEntries);
    }
    return res;
  } catch (err) {
    // オフラインで未キャッシュ：HTMLならフォールバックを返す
    if (req.destination === "document") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

/**
 * Network-First 戦略
 * オンライン時は常にネットワークの最新を返し、通信失敗時のみキャッシュへフォールバックする。
 *   キャッシュは「オフライン時の最後の手段」であり TTL は設けない(古くてもゼロより良い)。
 *   maxEntries で保存件数を上限化し API_CACHE の肥大を防ぐ(簡易 LRU)。
 */
async function networkFirst(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      await cache.put(req, res.clone());
      if (maxEntries) await trimCache(cache, maxEntries);
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

/**
 * 件数ベースの簡易 LRU 間引き。
 *   Cache API の keys() は挿入順を返すため、上限超過分を先頭(最古)から削除する。
 *   厳密な LRU ではないが(更新時の順序保証は実装依存)、無制限増大を防ぐ目的には十分。
 *   失敗は無視(キャッシュ間引きはベストエフォート)。
 */
async function trimCache(cache, maxEntries) {
  try {
    const keys = await cache.keys();
    const over = keys.length - maxEntries;
    for (let i = 0; i < over; i++) {
      await cache.delete(keys[i]);
    }
  } catch {}
}
