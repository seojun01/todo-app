// 홈서버의 동기화 API(specs/002-personal-task-manager/contracts/sync-api.md)를 부르는 얇은 클라이언트.
// 앱의 다른 기기와 똑같이 페어링해서 쿠키 토큰으로 /api/changes 를 읽고 쓴다.
import { randomUUID } from 'node:crypto';
import { merge } from '../../shared/merge.ts';
import type { Project, Task } from '../../shared/task.ts';
import type { Credentials } from './credentials.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Change = { type: 'task'; record: Task } | { type: 'project'; record: Project };

export interface Snapshot {
  tasks: Map<string, Task>;
  projects: Map<string, Project>;
}

export interface PushResult {
  applied: number;
  ignored: number;
  cursor: number;
}

const PAGE = 1000;
const TIMEOUT_MS = 15_000;

const normalizeBase = (url: string) => url.trim().replace(/\/+$/, '');

function networkError(base: string, err: unknown): ApiError {
  const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
  return new ApiError(
    0,
    'network',
    `홈서버에 연결하지 못했어요 (${base}): ${cause}. 집 Wi-Fi 나 WireGuard 에 연결돼 있는지, 인증서를 신뢰하는지 확인하세요 (NODE_OPTIONS=--use-system-ca).`,
  );
}

async function readJson(res: Response): Promise<{ [k: string]: unknown } | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as { [k: string]: unknown };
  } catch {
    return null;
  }
}

function toApiError(res: Response, body: { [k: string]: unknown } | null): ApiError {
  if (res.status === 401) {
    return new ApiError(401, 'unauthorized', '이 기기(Claude)의 등록이 해제되었거나 토큰이 올바르지 않아요. 서버에서 `todo-admin pair --name "Claude"` 로 새 코드를 받아 다시 페어링하세요.');
  }
  const code = typeof body?.error === 'string' ? body.error : 'http_error';
  const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
  return new ApiError(res.status, code, message, body?.details);
}

export class TodoClient {
  private base: string;
  private token: string;
  private fetchFn: typeof fetch;

  constructor(creds: Pick<Credentials, 'url' | 'token'>, fetchFn: typeof fetch = fetch) {
    this.base = normalizeBase(creds.url);
    this.token = creds.token;
    this.fetchFn = fetchFn;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ [k: string]: unknown }> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { Cookie: `todo_session=${this.token}`, Accept: 'application/json' };
    if (method !== 'GET') headers['X-Todo-Client'] = '1'; // 서버의 CSRF 검사
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(this.base, err);
    }
    const body = await readJson(res);
    if (!res.ok) throw toApiError(res, body);
    return body ?? {};
  }

  /** 서버의 모든 변경을 처음(cursor 0)부터 받아 항목별로 병합한다. 개인용 규모라 매번 통째로 받아도 작다. */
  async pullAll(): Promise<Snapshot> {
    const tasks = new Map<string, Task>();
    const projects = new Map<string, Project>();
    let since = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = (await this.call(`/api/changes?since=${since}&limit=${PAGE}`)) as {
        changes?: { type: string; record: Task | Project }[];
        cursor?: number;
        hasMore?: boolean;
      };
      for (const c of page.changes ?? []) {
        if (c.type === 'task') tasks.set(c.record.id, merge(tasks.get(c.record.id), c.record as Task));
        else if (c.type === 'project') projects.set(c.record.id, merge(projects.get(c.record.id), c.record as Project));
      }
      const next = page.cursor ?? since;
      if (!page.hasMore || next <= since) break;
      since = next;
    }
    return { tasks, projects };
  }

  async push(changes: Change[]): Promise<PushResult> {
    const out = await this.call('/api/changes', { method: 'POST', body: { changes } });
    return { applied: Number(out.applied ?? 0), ignored: Number(out.ignored ?? 0), cursor: Number(out.cursor ?? 0) };
  }
}

/** 서버에서 받은 일회용 코드로 이 기기를 등록한다. 토큰은 응답의 Set-Cookie 에만 있다. */
export async function pair(url: string, code: string, fetchFn: typeof fetch = fetch): Promise<Credentials> {
  const base = normalizeBase(url);
  const deviceId = randomUUID();
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Todo-Client': '1' },
      body: JSON.stringify({ code, deviceId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError(base, err);
  }
  const body = await readJson(res);
  if (res.status !== 201) throw toApiError(res, body);
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const token = /todo_session=([^;]+)/.exec(cookies.join('; '))?.[1];
  if (!token) throw new ApiError(res.status, 'no_token', '서버가 세션 토큰을 주지 않았어요');
  return { url: base, deviceId, token };
}
