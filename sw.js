/*
 * 오프라인 지원: 앱 셸 캐시 (네트워크 우선 → 실패 시 캐시)
 * 네트워크 요청은 cache:'no-cache'로 보내 브라우저 HTTP 캐시에 묵은 파일이 있어도 항상 서버에 확인한다.
 * (python http.server는 Cache-Control을 주지 않아 브라우저가 옛 CSS/JS를 계속 쓰는 문제가 있었음)
 */
const CACHE = 'focus-tracker-v7';
const SHELL = ['./', './index.html', './styles.css', './js/stats.js', './js/store.js', './js/app.js', './manifest.webmanifest', './icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) return res;
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
