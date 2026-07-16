/* Quantareon — service worker.
   Нужен, чтобы Chrome на Android считал сайт приложением
   и предлагал «Установить». Плюс страницы открываются без интернета. */
const CACHE = 'quantareon-v1';
const SHELL = [
  '/', '/index.html', '/ru.html',
  '/architecture.html', '/architecture-ru.html',
  '/labs.html', '/labs-ru.html',
  '/manifest.json', '/favicon.png', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Обработчик fetch обязателен — без него Chrome установку не предложит.
   Сеть первым, кэш запасным: свежее показываем, без сети — из памяти. */
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;   // шрифты, видео — мимо
  e.respondWith(
    fetch(r)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(r, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(r).then(hit => hit || caches.match('/index.html')))
  );
});
