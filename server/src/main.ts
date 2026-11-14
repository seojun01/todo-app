// 홈서버 진입점: 정적 파일(PWA)과 /api/* 를 제공한다. TLS 는 앞단의 Caddy 가 처리한다.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.ts';
import { FailureLimiter } from './auth.ts';
import { DEFAULT_DB, openDb, type Db } from './db.ts';
import { createEvents, type EventsOptions } from './events.ts';
import { createGcal, gcalConfigFromEnv, type Gcal, type GcalConfig } from './gcal.ts';
import { createPushRoutes } from './push-api.ts';
import { createScheduler, type Scheduler } from './scheduler.ts';
import { loadOrCreateVapid, type Vapid } from './vapid.ts';
import { createPushSender } from './webpush.ts';
import { HttpError, sendError, sendJson } from './http.ts';

const DEFAULT_STATIC = resolve(fileURLToPath(new URL('../../client/dist', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface AppOptions {
  staticDir?: string;
}

/** /api/* 처리기. 라우트를 더하면 true(처리함)를 돌려주는 함수를 이 배열에 추가한다. */
export type ApiHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean> | boolean;

export function createApp(options: AppOptions = {}, extraHandlers: ApiHandler[] = []): http.Server {
  const staticDir = resolve(options.staticDir ?? DEFAULT_STATIC);

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    for (const h of extraHandlers) {
      if (await h(req, res, url)) return;
    }
    throw new HttpError(404, 'not_found', '없는 경로예요');
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad_path');
    }
    let file = resolve(join(staticDir, rel));
    if (file !== staticDir && !file.startsWith(staticDir + sep)) throw new HttpError(403, 'forbidden'); // 경로 탈출 방지
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = join(file, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st) {
      // SPA 폴백: 확장자가 없는 경로는 index.html
      if (extname(rel)) throw new HttpError(404, 'not_found');
      file = join(staticDir, 'index.html');
      st = await stat(file).catch(() => null);
      if (!st) throw new HttpError(503, 'not_built', '클라이언트가 아직 빌드되지 않았어요 (npm run build)');
    }
    const body = await readFile(file);
    const ext = extname(file);
    // 개발 모드(TODO_DEV=1)에서는 수정한 CSS·JS 가 바로 보이도록 캐시를 끈다
    const noCache = process.env.TODO_DEV === '1' || file.endsWith('index.html') || file.endsWith('sw.js');
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const run = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url);
    run.catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      // 정적 파일 오류도 JSON 으로 통일
      sendError(res, err);
    });
  });
}

export interface ServerOptions {
  /** SQLite 파일 경로 (기본: 환경 변수 TODO_DB). 테스트는 ':memory:' */
  dbPath?: string;
  staticDir?: string;
  /** 세션 쿠키에 Secure 를 붙일지. 운영은 true, 개발·테스트(TODO_DEV=1)만 false */
  secureCookie?: boolean;
  now?: () => Date;
  /** 알림 서버 키 파일 (기본: 환경 변수 TODO_VAPID_FILE) */
  vapidFile?: string;
  events?: EventsOptions;
  /** 구글 캘린더 연동 설정 (기본: 환경 변수 GOOGLE_CLIENT_ID 등. 없으면 기능 꺼짐) */
  gcal?: GcalConfig | null;
  /** 구글 호출에 쓸 fetch (테스트용) */
  fetch?: typeof fetch;
  /** 푸시(알림) 설정. 테스트가 가짜 푸시 서비스를 허용하거나 보내는 fetch 를 바꾼다 */
  push?: {
    /** 허용할 추가 푸시 호스트 "host:port" (기본: 환경 변수 TODO_PUSH_ALLOW_HOSTS, 쉼표로 구분) */
    allowHosts?: string[];
    fetch?: typeof fetch;
    /** VAPID sub 클레임 (기본: 환경 변수 TODO_VAPID_SUBJECT 또는 https://todo.home.arpa) */
    subject?: string;
  };
}

export interface ServerHandle {
  server: http.Server;
  db: Db;
  gcal: Gcal;
  /** 알림 스케줄러. 서버로 실행할 때만 start() 한다 (테스트는 tick() 을 직접 부른다) */
  scheduler: Scheduler;
  close(): Promise<void>;
}

/** DB·SSE·API 를 모두 엮은 서버를 만든다 (listen 은 호출한 쪽이 한다). */
export function createServer(options: ServerOptions = {}): ServerHandle {
  const db = openDb(options.dbPath);
  const now = options.now ?? (() => new Date());
  const events = createEvents(db, options.events);
  const gcal = createGcal({ db, now, config: options.gcal !== undefined ? options.gcal : gcalConfigFromEnv(), fetch: options.fetch });

  // 푸시: VAPID 키는 처음 필요할 때 만든다 (키 파일을 쓸 수 없는 환경에서도 서버는 뜬다)
  const dbPath = options.dbPath ?? process.env.TODO_DB ?? DEFAULT_DB;
  const vapidFile = options.vapidFile ?? process.env.TODO_VAPID_FILE ?? (dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'vapid.json'));
  let vapid: Vapid | undefined;
  const getVapid = (): Vapid => {
    if (vapid) return vapid;
    if (!vapidFile) throw new Error('VAPID 키 파일 경로가 없어요 (TODO_VAPID_FILE)');
    return (vapid = loadOrCreateVapid(vapidFile));
  };
  const allowHosts = options.push?.allowHosts ?? (process.env.TODO_PUSH_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const subject = options.push?.subject ?? process.env.TODO_VAPID_SUBJECT ?? 'https://todo.home.arpa';
  const getSender = () => createPushSender({ vapid: getVapid(), subject, fetch: options.push?.fetch, allowHosts, now });
  const scheduler = createScheduler({ db, getSender, now });
  const pushRoutes = createPushRoutes({ db, getVapid, getSender, allowHosts, now });
  const api = createApi({
    db,
    now,
    events,
    extra: [...gcal.routes, ...pushRoutes],
    publicRoutes: gcal.publicRoutes,
    onChanges: () => gcal.kick(),
    limiter: new FailureLimiter(),
    secureCookie: options.secureCookie ?? process.env.TODO_DEV !== '1',
  });
  const server = createApp({ staticDir: options.staticDir }, [api]);
  return {
    server,
    db,
    gcal,
    scheduler,
    async close() {
      scheduler.close();
      gcal.close();
      events.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8080);
  const handle = createServer();
  handle.server.listen(port, host, () => console.log(`[server] http://${host}:${port}`));
  handle.gcal.kick(); // 서버가 꺼져 있던 동안 쌓인 변경을 구글에 반영한다
  handle.scheduler.start(); // 30초마다 보낼 알림을 확인한다
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void handle.close().then(() => process.exit(0)));
}
