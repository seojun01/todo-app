// 계약 테스트용: 메모리 SQLite 와 임시 포트로 실제 HTTP 서버를 띄운다.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerHandle, type ServerOptions } from '../../src/main.ts';
import { createPairingCode } from '../../src/auth.ts';

export interface TestServer extends ServerHandle {
  base: string;
  /** 새 기기를 페어링하고 세션 쿠키를 돌려준다 */
  pair(name?: string): Promise<{ deviceId: string; cookie: string }>;
  /** 쿠키·CSRF 헤더를 붙여 JSON API 를 호출한다 */
  api(path: string, init?: { method?: string; cookie?: string; body?: unknown; csrf?: boolean; headers?: Record<string, string> }): Promise<Response>;
}

export async function startTestServer(options: Partial<ServerOptions> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'todo-test-'));
  const handle = createServer({
    dbPath: ':memory:',
    staticDir: dir,
    secureCookie: false,
    vapidFile: join(dir, 'vapid.json'),
    ...options,
  });
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const addr = handle.server.address();
  if (!addr || typeof addr === 'string') throw new Error('서버 주소를 알 수 없어요');
  const base = `http://127.0.0.1:${addr.port}`;

  const api: TestServer['api'] = (path, init = {}) => {
    const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && init.csrf !== false) headers['X-Todo-Client'] = '1';
    return fetch(base + path, { method, headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  };

  return {
    ...handle,
    base,
    api,
    async pair(name = 'test-device') {
      const code = createPairingCode(handle.db, name);
      const deviceId = crypto.randomUUID();
      const res = await api('/api/pair', { body: { code, deviceId } });
      if (res.status !== 201) throw new Error(`페어링 실패: ${res.status} ${await res.text()}`);
      const setCookie = res.headers.get('set-cookie') ?? '';
      const cookie = setCookie.split(';')[0]!;
      return { deviceId, cookie };
    },
  };
}

/** 계약 테스트용 유효한 레코드 */
let counter = 0;
export function mkTask(over: Record<string, unknown> = {}) {
  counter++;
  return {
    id: crypto.randomUUID(),
    title: `할 일 ${counter}`,
    dueDate: '2026-11-20',
    dueTime: null,
    projectId: 'inbox',
    priority: 4,
    recurrence: null,
    reminders: [],
    tags: [],
    done: false,
    createdAt: '2026-11-12T00:00:00.000Z',
    deleted: false,
    version: `001762950896789-${String(counter).padStart(6, '0')}-dev`,
    updatedBy: 'dev',
    ...over,
  };
}

export function mkProject(over: Record<string, unknown> = {}) {
  counter++;
  return {
    id: crypto.randomUUID(),
    name: `프로젝트 ${counter}`,
    color: 'blue',
    createdAt: '2026-11-12T00:00:00.000Z',
    deleted: false,
    version: `001762950896789-${String(counter).padStart(6, '0')}-dev`,
    updatedBy: 'dev',
    ...over,
  };
}

export function mkSettings(over: Record<string, unknown> = {}) {
  counter++;
  return {
    id: 'settings',
    defaultReminderTime: '09:00',
    version: `001762950896789-${String(counter).padStart(6, '0')}-dev`,
    updatedBy: 'dev',
    ...over,
  };
}

export async function readSse(res: Response): Promise<{ next(timeoutMs?: number): Promise<{ event: string; data: string } | null | 'timeout'>; cancel(): void }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    async next(timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // 버퍼에 완성된 이벤트가 있으면 꺼낸다 (주석 줄 ": ping" 은 건너뛴다)
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
          return { event, data };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return 'timeout';
        const chunk = await Promise.race([reader.read(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining))]);
        if (chunk === 'timeout') return 'timeout';
        if (chunk.done) return null; // 스트림이 닫힘
        buf += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  };
}
