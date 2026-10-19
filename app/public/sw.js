/* 简单离线缓存：网络优先，失败回退缓存 */
/* 缓存名带构建时间戳：每次发布改动此文件（构建时自动替换 __BUILD__）即触发旧缓存清理 */
const CACHE = 'bwc-v4-__BUILD__';
const ASSETS = ['/', '/index.html', '/styles.css', '/md.js', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.clients.matchAll())
      .then((list) => {
        // 首次安装（无受控页面）直接接管；已有页面在使用时等页面指令，避免打断进行中的操作
        if (!list.length) return self.skipWaiting();
      })
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
  );
});
