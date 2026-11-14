// 서비스 워커: 앱 셸을 캐시해 오프라인에서도 앱이 열린다. /api/* 는 절대 캐시하지 않는다.
// 알림: 서버가 보낸 push 를 받아 시스템 알림을 띄우고(항상 — iOS 규칙), 알림을 누르면 해당 할 일로 간다.
import { handleNotificationClick, handlePush, type NotifySw } from './sw-notify.ts';

declare const __BUILD_ID__: string;

interface SwScope extends NotifySw {
  addEventListener(type: string, listener: (event: any) => void): void;
  skipWaiting(): Promise<void>;
  clients: NotifySw['clients'] & { claim(): Promise<void> };
}
const sw = self as unknown as SwScope;

const CACHE = `todo-shell-${__BUILD_ID__}`;
const SHELL = [
  '/',
  '/main.js',
  '/main.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

sw.addEventListener('install', (event) => {
  // 새 버전의 앱 파일은 브라우저의 HTTP 캐시(정적 파일은 최대 1시간)를 건너뛰고 서버에서 받는다.
  // 그러지 않으면 방금 배포한 버전이 아니라 묵은 파일이 새 캐시에 들어가 업데이트가 늦어진다.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('todo-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (event) => {
  const req: Request = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 데이터는 캐시하지 않는다

  // 캐시 우선 + 백그라운드 갱신: 오프라인이거나 서버에 닿기 어려워도 앱이 바로 열린다
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = req.mode === 'navigate' ? '/' : req;
      const cached = await cache.match(key);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) void cache.put(key, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return (await refresh) ?? new Response('오프라인이에요', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })(),
  );
});

// ── 알림 ── (처리 내용은 sw-notify.ts 에 있다)

sw.addEventListener('push', (event) => {
  event.waitUntil(handlePush(sw, () => event.data?.json()));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(sw, event.notification.data?.taskId));
});
