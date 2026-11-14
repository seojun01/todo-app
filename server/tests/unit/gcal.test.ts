import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { openDb } from '../../src/db.ts';
import { applyChanges } from '../../src/sync.ts';
import { createGcal, eventFor, gcalConfigFromEnv, GCAL_READ_SCOPES, GCAL_SCOPE, importRowFor, type GcalConfig, type GoogleEventItem } from '../../src/gcal.ts';
import { HttpError } from '../../src/http.ts';
import type { Task } from '../../../shared/task.ts';
import { mkProject, mkTask } from '../helpers/test-server.ts';

const CONFIG: GcalConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'http://localhost:8080/api/gcal/callback',
  timeZone: 'Asia/Seoul',
  appUrl: '',
};

interface Call {
  method: string;
  url: string;
  body: any;
  auth: string | null;
}

/** 구글 서버를 흉내 낸다. override 가 Response 를 돌려주면 그것을 쓴다. */
function fakeGoogle() {
  const calls: Call[] = [];
  const overrides: ((c: Call) => Response | undefined)[] = [];
  let tokens = 0;
  let eventSeq = 0;
  /** 인증 코드 교환 때 구글이 돌려줄 권한 */
  const granted = { scope: GCAL_SCOPE };
  const calendarList: Record<string, unknown>[] = [];
  /** 캘린더 id → 페이지별 일정 응답 (없으면 404) */
  const eventPages: Record<string, GoogleEventItem[][]> = {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fn: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw ? JSON.parse(String(raw)) : undefined;
    const call: Call = { method: init?.method ?? 'GET', url: String(input), body, auth: headers.get('Authorization') };
    calls.push(call);
    for (const o of overrides) {
      const r = o(call);
      if (r) return r;
    }
    if (call.url === 'https://oauth2.googleapis.com/token') {
      tokens++;
      return json({ access_token: `at-${tokens}`, expires_in: 3600, scope: granted.scope, ...(body.grant_type === 'authorization_code' ? { refresh_token: 'rt-1' } : {}) });
    }
    if (call.method === 'GET' && call.url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) return json({ items: calendarList });
    const listing = /\/calendars\/([^/?]+)\/events\?(.*)$/.exec(call.url);
    if (call.method === 'GET' && listing) {
      const pages = eventPages[decodeURIComponent(listing[1]!)];
      if (!pages) return json({ error: 'not found' }, 404);
      const token = new URLSearchParams(listing[2]!).get('pageToken');
      const i = token ? Number(token) : 0;
      return json({ items: pages[i] ?? [], ...(i + 1 < pages.length ? { nextPageToken: String(i + 1) } : {}) });
    }
    if (call.url === 'https://oauth2.googleapis.com/revoke') return json({});
    if (call.url.endsWith('/calendars') && call.method === 'POST') return json({ id: 'cal-1' });
    if (/\/calendars\/cal-1\/events$/.test(call.url) && call.method === 'POST') return json({ id: `ev-${++eventSeq}` });
    if (/\/calendars\/cal-1\/events\/ev-\d+$/.test(call.url)) return call.method === 'DELETE' ? new Response(null, { status: 204 }) : json({});
    return json({ error: 'unexpected' }, 500);
  };
  return {
    fetch: fn,
    calls,
    overrides,
    granted,
    calendarList,
    eventPages,
    events: () => calls.filter((c) => c.url.includes('/events') && c.method !== 'GET'),
    eventLists: () => calls.filter((c) => c.method === 'GET' && /\/events\?/.test(c.url)),
    clear: () => (calls.length = 0),
  };
}

function setup(config: GcalConfig | null = CONFIG) {
  const db = openDb(':memory:');
  const google = fakeGoogle();
  const gcal = createGcal({ db, config, fetch: google.fetch, now: () => new Date('2026-11-13T09:00:00.000Z'), retryMs: 3_600_000 });
  const push = (...tasks: Record<string, unknown>[]) => applyChanges(db, { changes: tasks.map((record) => ({ type: 'task', record })) });
  /** 콜백 흐름 없이 연결된 상태를 만든다 */
  const connect = () =>
    db.prepare(`INSERT OR REPLACE INTO gcal_account (id, refresh_token, calendar_id, connected_at) VALUES (1, 'rt-1', NULL, '2026-11-13T00:00:00.000Z')`).run();
  return { db, google, gcal, push, connect };
}

let n = 0;
const bump = (t: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ ...t, version: `001762950996789-${String(++n).padStart(6, '0')}-dev`, ...over });

// ── 설정 ──

test('설정: 클라이언트 ID/시크릿이 없으면 꺼짐, 있으면 공개 주소로 리디렉션 URI 를 만든다', () => {
  assert.equal(gcalConfigFromEnv({}), null);
  assert.equal(gcalConfigFromEnv({ GOOGLE_CLIENT_ID: 'a' }), null);
  const dev = gcalConfigFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PORT: '9000' })!;
  assert.equal(dev.redirectUri, 'http://localhost:9000/api/gcal/callback');
  assert.equal(dev.timeZone, 'Asia/Seoul');
  const prod = gcalConfigFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', TODO_PUBLIC_URL: 'https://x.example.com/', TODO_TIMEZONE: 'Asia/Tokyo', TODO_APP_URL: 'https://todo.home.arpa/' })!;
  assert.equal(prod.redirectUri, 'https://x.example.com/api/gcal/callback');
  assert.equal(prod.timeZone, 'Asia/Tokyo');
  assert.equal(prod.appUrl, 'https://todo.home.arpa');
});

// ── 할 일 → 일정 변환 ──

test('변환: 시각이 있으면 30분 일정, 자정을 넘기면 다음 날로 끝난다', () => {
  const a = eventFor(mkTask({ dueDate: '2026-11-20', dueTime: '13:00' }) as unknown as Task, '업무', 'Asia/Seoul')!;
  assert.deepEqual(a.start, { dateTime: '2026-11-20T13:00:00', timeZone: 'Asia/Seoul' });
  assert.deepEqual(a.end, { dateTime: '2026-11-20T13:30:00', timeZone: 'Asia/Seoul' });
  const b = eventFor(mkTask({ dueDate: '2026-11-30', dueTime: '23:50' }) as unknown as Task, '업무', 'Asia/Seoul')!;
  assert.deepEqual(b.end, { dateTime: '2026-12-01T00:20:00', timeZone: 'Asia/Seoul' });
});

test('변환: 시각이 없으면 종일 일정이고 끝 날짜는 다음 날이다', () => {
  const e = eventFor(mkTask({ dueDate: '2026-11-30' }) as unknown as Task, '수신함', 'Asia/Seoul')!;
  assert.deepEqual(e.start, { date: '2026-11-30' });
  assert.deepEqual(e.end, { date: '2026-12-01' });
});

test('변환: 기한이 없으면 null, 완료는 ✓, 우선순위 색, 반복 설명, 프로젝트, 캘린더 알림 끔, 할 일 id 표식', () => {
  assert.equal(eventFor(mkTask({ dueDate: null }) as unknown as Task, '수신함', 'Asia/Seoul'), null);
  const t = mkTask({ title: '보고서', done: true, priority: 1, recurrence: { unit: 'week', interval: 1, weekdays: [1] } }) as unknown as Task;
  const e = eventFor(t, '업무', 'Asia/Seoul')!;
  assert.equal(e.summary, '✓ 보고서');
  assert.equal(e.colorId, '11');
  assert.match(e.description, /프로젝트: 업무/);
  assert.match(e.description, /우선순위: P1/);
  assert.doesNotMatch(e.description, /태그:/);
  assert.match(eventFor(mkTask({ tags: ['집', 'Urgent'] }) as unknown as Task, 'x', 'Asia/Seoul')!.description, /태그: #집 #Urgent/);
  assert.match(e.description, /반복:/);
  assert.deepEqual(e.reminders, { useDefault: false });
  assert.equal(e.extendedProperties.private.todoTaskId, t.id);
  assert.equal(eventFor(mkTask({ priority: 4 }) as unknown as Task, 'x', 'Asia/Seoul')!.colorId, undefined);
});

// ── OAuth ──

test('연결: 설정이 없으면 503, 있으면 최소 권한·PKCE·offline 인 인증 주소를 만든다', () => {
  const off = setup(null);
  assert.throws(() => off.gcal.startAuth(), (e: unknown) => e instanceof HttpError && e.status === 503);
  assert.equal(off.gcal.status().configured, false);

  const { gcal } = setup();
  const url = new URL(gcal.startAuth().url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('scope'), GCAL_SCOPE);
  assert.equal(GCAL_SCOPE, 'https://www.googleapis.com/auth/calendar.app.created');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state'));
});

async function callback(gcal: ReturnType<typeof setup>['gcal'], params: Record<string, string>) {
  const route = gcal.publicRoutes.find((r) => r.path === '/api/gcal/callback')!;
  const headers: Record<string, string> = {};
  const res = { writeHead: (_s: number, h: Record<string, string>) => Object.assign(headers, h), end: () => {} };
  await route.handle({} as never, res as never, new URL(`http://x/api/gcal/callback?${new URLSearchParams(params)}`));
  return headers;
}

test('콜백: 코드를 PKCE verifier 와 함께 교환해 refresh_token 을 저장하고, state 는 한 번만 쓴다', async () => {
  const { gcal, google, db } = setup();
  const auth = new URL(gcal.startAuth().url);
  const state = auth.searchParams.get('state')!;
  const headers = await callback(gcal, { code: 'the-code', state });
  assert.equal(headers.Location, '/#/settings');
  const token = google.calls.find((c) => c.url.endsWith('/token'))!;
  assert.equal(token.body.grant_type, 'authorization_code');
  assert.equal(token.body.code, 'the-code');
  assert.equal(token.body.client_secret, 'csecret');
  assert.equal(createHash('sha256').update(token.body.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(gcal.status().connected, true);
  assert.equal((db.prepare('SELECT refresh_token FROM gcal_account').get() as { refresh_token: string }).refresh_token, 'rt-1');

  // 같은 state 로 다시 오면 무시한다
  google.clear();
  await callback(gcal, { code: 'again', state });
  assert.equal(google.calls.length, 0);
});

test('콜백: 모르는 state 는 무시하고, 사용자가 거부하면 오류만 남긴다', async () => {
  const { gcal, google } = setup();
  await callback(gcal, { code: 'x', state: 'forged' });
  assert.equal(google.calls.length, 0);
  assert.equal(gcal.status().connected, false);

  const state = new URL(gcal.startAuth().url).searchParams.get('state')!;
  await callback(gcal, { error: 'access_denied', state });
  assert.equal(gcal.status().connected, false);
  assert.match(gcal.status().lastError ?? '', /거부|취소/);
});

test('콜백: 10분이 지난 state 는 거부한다', async () => {
  const db = openDb(':memory:');
  const google = fakeGoogle();
  let t = new Date('2026-11-13T09:00:00.000Z');
  const gcal = createGcal({ db, config: CONFIG, fetch: google.fetch, now: () => t, retryMs: 3_600_000 });
  const state = new URL(gcal.startAuth().url).searchParams.get('state')!;
  t = new Date(t.getTime() + 11 * 60_000);
  await callback(gcal, { code: 'late', state });
  assert.equal(gcal.status().connected, false);
  assert.match(gcal.status().lastError ?? '', /시간이 지났/);
  assert.equal(google.calls.filter((c) => c.url.endsWith('/token')).length, 0);
});

// ── 동기화 ──

test('동기화: 캘린더를 한 번 만들고, 기한 있는 할 일만 일정으로 만든다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ title: '기한 있음', dueDate: '2026-11-20' }), mkTask({ title: '기한 없음', dueDate: null }), mkTask({ title: '시각 있음', dueDate: '2026-11-21', dueTime: '09:00' }));
  const st = await gcal.syncNow();
  assert.equal(st.pending, 0);
  assert.equal(st.lastError, null);
  assert.equal(google.calls.filter((c) => c.url.endsWith('/calendars')).length, 1);
  assert.deepEqual(google.calls.find((c) => c.url.endsWith('/calendars'))!.body, { summary: '할 일', timeZone: 'Asia/Seoul' });
  const posts = google.events().filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.body.summary).sort(), ['기한 있음', '시각 있음']);
  assert.ok(posts.every((c) => c.auth === 'Bearer at-1'));

  // 아무것도 안 바뀌면 아무것도 보내지 않는다
  google.clear();
  await gcal.syncNow();
  assert.equal(google.calls.length, 0);
});

test('동기화: 수정은 같은 일정을 PUT 으로 고치고, 완료·기한 제거·삭제를 반영한다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  const a = mkTask({ title: '가', dueDate: '2026-11-20' });
  const b = mkTask({ title: '나', dueDate: '2026-11-20' });
  const c = mkTask({ title: '다', dueDate: '2026-11-20' });
  push(a, b, c);
  await gcal.syncNow();
  const ids = google.events().filter((x) => x.method === 'POST').length;
  assert.equal(ids, 3);

  google.clear();
  push(bump(a, { title: '가 수정', dueDate: '2026-11-22' }), bump(b, { dueDate: null }), bump(c, { deleted: true }));
  await gcal.syncNow();
  const evs = google.events();
  const put = evs.find((x) => x.method === 'PUT')!;
  assert.match(put.url, /\/events\/ev-1$/);
  assert.equal(put.body.summary, '가 수정');
  assert.deepEqual(put.body.start, { date: '2026-11-22' });
  assert.deepEqual(evs.filter((x) => x.method === 'DELETE').map((x) => x.url.split('/').pop()).sort(), ['ev-2', 'ev-3']);

  // 완료하면 ✓ 로 남긴다
  google.clear();
  push(bump(a, { title: '가 수정', dueDate: '2026-11-22', done: true }));
  await gcal.syncNow();
  assert.equal(google.events().find((x) => x.method === 'PUT')!.body.summary, '✓ 가 수정');
});

test('동기화: 순서(sortKey)만 바뀌어 일정 내용이 같으면 다시 올리지 않는다. 내용이 바뀌면 올린다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  const a = mkTask({ title: '순서', dueDate: '2026-11-20', dueTime: '10:00' });
  push(a);
  await gcal.syncNow();
  assert.equal(google.events().filter((x) => x.method === 'POST').length, 1);

  google.clear();
  const moved = bump(a, { sortKey: 'i' });
  push(moved);
  await gcal.syncNow();
  assert.deepEqual(google.events(), []);

  push(bump(moved, { title: '순서 수정' }));
  await gcal.syncNow();
  assert.equal(google.events().find((x) => x.method === 'PUT')!.body.summary, '순서 수정');
});

test('동기화: 이미 완료된 채 처음 보는 할 일, 처음부터 삭제된 할 일은 일정을 만들지 않는다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ done: true }), mkTask({ deleted: true }));
  await gcal.syncNow();
  assert.equal(google.events().length, 0);
});

test('동기화: 캘린더에서 사용자가 일정을 지웠으면(404) 다시 만들고, 지울 일정이 이미 없어도(404) 괜찮다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  const a = mkTask({ dueDate: '2026-11-20' });
  const b = mkTask({ dueDate: '2026-11-20' });
  push(a, b);
  await gcal.syncNow();

  google.clear();
  google.overrides.push((c) => (c.method === 'PUT' || c.method === 'DELETE' ? new Response('{}', { status: 404 }) : undefined));
  push(bump(a, { title: '다시' }), bump(b, { deleted: true }));
  const st = await gcal.syncNow();
  assert.equal(st.lastError, null);
  assert.equal(st.pending, 0);
  assert.equal(google.events().filter((x) => x.method === 'POST').length, 1, '지워진 일정을 새로 만든다');
});

test('동기화: 일시적 오류(5xx)면 멈추고 커서를 그대로 둔 채 다음에 이어서 한다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ title: '가', dueDate: '2026-11-20' }), mkTask({ title: '나', dueDate: '2026-11-21' }));
  google.overrides.push((c) => (c.method === 'POST' && c.url.endsWith('/events') ? new Response('{}', { status: 503 }) : undefined));
  const st = await gcal.syncNow();
  assert.equal(st.pending, 2);
  assert.match(st.lastError ?? '', /503/);
  assert.equal(st.connected, true);

  google.overrides.length = 0;
  const ok = await gcal.syncNow();
  assert.equal(ok.pending, 0);
  assert.equal(ok.lastError, null);
  assert.equal(google.events().filter((x) => x.method === 'POST').length, 3, '실패 1번 + 성공 2번');
});

test('동기화: 한 할 일만 거절당하면(400) 그것만 건너뛰고 나머지는 계속한다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ title: '나쁨', dueDate: '2026-11-20' }), mkTask({ title: '좋음', dueDate: '2026-11-21' }));
  google.overrides.push((c) => (c.method === 'POST' && c.body?.summary === '나쁨' ? new Response('{}', { status: 400 }) : undefined));
  const st = await gcal.syncNow();
  assert.equal(st.pending, 0);
  assert.match(st.lastError ?? '', /400/);
  assert.ok(google.events().some((c) => c.body?.summary === '좋음'));
});

test('동기화: 액세스 토큰이 만료돼 401 을 받으면 토큰을 새로 받아 한 번 다시 시도한다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ dueDate: '2026-11-20' }));
  let first = true;
  google.overrides.push((c) => {
    if (c.method === 'POST' && c.url.endsWith('/calendars') && first) {
      first = false;
      return new Response('{}', { status: 401 });
    }
  });
  const st = await gcal.syncNow();
  assert.equal(st.pending, 0);
  assert.equal(google.calls.filter((c) => c.url.endsWith('/token')).length, 2);
});

test('동기화: 구글에서 권한이 취소돼(invalid_grant) 있으면 다시 연결이 필요하다고 알리고 더는 시도하지 않는다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ dueDate: '2026-11-20' }));
  google.overrides.push((c) => (c.url.endsWith('/token') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : undefined));
  const st = await gcal.syncNow();
  assert.equal(st.needsReauth, true);
  assert.equal(st.connected, false);
  assert.match(st.lastError ?? '', /다시 연결/);
  google.clear();
  await gcal.syncNow();
  assert.equal(google.calls.length, 0);
});

test('동기화: 연결 전에 쌓인 할 일도 연결하면 한꺼번에 반영한다 (60개, 여러 묶음)', async () => {
  const { gcal, google, push, connect } = setup();
  push(...Array.from({ length: 60 }, (_, i) => mkTask({ title: `일 ${i}`, dueDate: '2026-11-20' })));
  await gcal.syncNow(); // 연결 전: 아무 일도 없다
  assert.equal(google.calls.length, 0);
  connect();
  const st = await gcal.syncNow();
  assert.equal(st.pending, 0);
  assert.equal(google.events().filter((c) => c.method === 'POST').length, 60);
});

test('동기화: 동시에 여러 번 불러도 한 번에 하나씩만 돌고, 변경은 빠짐없이 반영된다', async () => {
  const { gcal, google, push, connect } = setup();
  connect();
  push(mkTask({ title: '가', dueDate: '2026-11-20' }));
  const p1 = gcal.syncNow();
  push(mkTask({ title: '나', dueDate: '2026-11-21' }));
  const p2 = gcal.syncNow();
  await Promise.all([p1, p2]);
  assert.equal(gcal.status().pending, 0);
  assert.equal(google.events().filter((c) => c.method === 'POST').length, 2);
});

test('연결 해제: 구글 권한을 취소하고 토큰을 지우되, 다시 연결하면 중복 없이 이어서 한다', async () => {
  const { gcal, google, push, connect, db } = setup();
  connect();
  const a = mkTask({ title: '가', dueDate: '2026-11-20' });
  push(a);
  await gcal.syncNow();

  const st = await gcal.disconnect();
  assert.equal(st.connected, false);
  assert.ok(google.calls.some((c) => c.url.endsWith('/revoke') && c.body.token === 'rt-1'));
  assert.equal((db.prepare('SELECT refresh_token FROM gcal_account').get() as { refresh_token: string | null }).refresh_token, null);

  // 끊어진 동안의 변경은 동기화되지 않는다
  google.clear();
  push(bump(a, { title: '가 수정' }));
  await gcal.syncNow();
  assert.equal(google.calls.length, 0);

  // 다시 연결하면 같은 캘린더·같은 일정에 이어서 반영한다
  db.prepare(`UPDATE gcal_account SET refresh_token = 'rt-2' WHERE id = 1`).run();
  await gcal.syncNow();
  assert.equal(google.calls.filter((c) => c.url.endsWith('/calendars')).length, 0, '캘린더를 새로 만들지 않는다');
  assert.equal(google.events().filter((c) => c.method === 'POST').length, 0, '일정을 중복으로 만들지 않는다');
  assert.equal(google.events().find((c) => c.method === 'PUT')!.body.summary, '가 수정');
});

test('프로젝트 이름이 일정 설명에 들어간다', async () => {
  const { gcal, google, push, connect, db } = setup();
  connect();
  const p = mkProject({ name: '장보기' });
  applyChanges(db, { changes: [{ type: 'project', record: p }] });
  push(mkTask({ dueDate: '2026-11-20', projectId: p.id }));
  await gcal.syncNow();
  assert.match(google.events().find((c) => c.method === 'POST')!.body.description, /프로젝트: 장보기/);
});

// ── 일정 불러오기 ──

const ALL_SCOPES = [GCAL_SCOPE, ...GCAL_READ_SCOPES].join(' ');
const ev = (id: string, summary: string, start: GoogleEventItem['start'], end: GoogleEventItem['end'], extra: Partial<GoogleEventItem> = {}): GoogleEventItem => ({ id, summary, start, end, ...extra });

function setupImport(opts: { scopes?: string; enabled?: boolean } = {}) {
  const t = setup();
  t.google.granted.scope = opts.scopes ?? ALL_SCOPES; // 토큰을 갱신할 때 구글이 돌려주는 권한
  t.db
    .prepare(`INSERT OR REPLACE INTO gcal_account (id, refresh_token, calendar_id, connected_at, scopes, import_enabled) VALUES (1, 'rt-1', 'cal-1', '2026-11-13T00:00:00.000Z', ?, ?)`)
    .run(opts.scopes ?? ALL_SCOPES, opts.enabled === false ? 0 : 1);
  t.google.calendarList.push(
    { id: 'me@example.com', summary: '내 일정', backgroundColor: '#1a73e8', primary: true },
    { id: 'work@group', summary: '업무', backgroundColor: '#e8710a' },
    { id: 'cal-1', summary: '할 일', backgroundColor: '#129eaf' }, // 이 앱이 만든 캘린더
  );
  t.google.eventPages['me@example.com'] = [[ev('e1', '치과', { dateTime: '2026-11-20T13:00:00+09:00' }, { dateTime: '2026-11-20T14:00:00+09:00' })]];
  t.google.eventPages['work@group'] = [[ev('w1', '주간 회의', { dateTime: '2026-11-20T10:00:00+09:00' }, { dateTime: '2026-11-20T11:00:00+09:00' })]];
  return t;
}

test('불러오기 변환: 시각은 설정한 시간대의 현지 시각으로, 날짜가 바뀌는 UTC 값도 맞게 바꾼다', () => {
  const r = importRowFor(ev('a', '회의', { dateTime: '2026-11-20T04:30:00Z' }, { dateTime: '2026-11-20T05:30:00Z' }), 'Asia/Seoul')!;
  assert.deepEqual(r, { eventId: 'a', title: '회의', startDate: '2026-11-20', endDate: '2026-11-20', startTime: '13:30', endTime: '14:30', allDay: false });
  // UTC 20일 16:00 = 서울 21일 01:00
  const next = importRowFor(ev('b', '새벽', { dateTime: '2026-11-20T16:00:00Z' }, { dateTime: '2026-11-20T17:00:00Z' }), 'Asia/Seoul')!;
  assert.equal(next.startDate, '2026-11-21');
  assert.equal(next.startTime, '01:00');
  // 다른 시간대 오프셋으로 와도 같은 순간이면 같은 현지 시각
  assert.equal(importRowFor(ev('c', 'x', { dateTime: '2026-11-20T13:30:00+09:00' }, { dateTime: '2026-11-20T14:30:00+09:00' }), 'Asia/Seoul')!.startTime, '13:30');
  assert.equal(importRowFor(ev('d', 'x', { dateTime: '2026-11-20T00:30:00-05:00' }, { dateTime: '2026-11-20T01:30:00-05:00' }), 'Asia/Seoul')!.startTime, '14:30');
});

test('불러오기 변환: 종일 일정은 끝 날짜(구글은 포함하지 않는 날)를 하루 줄이고, 여러 날도 처리한다', () => {
  assert.deepEqual(importRowFor(ev('a', '휴가', { date: '2026-11-20' }, { date: '2026-11-21' }), 'Asia/Seoul'), {
    eventId: 'a', title: '휴가', startDate: '2026-11-20', endDate: '2026-11-20', startTime: null, endTime: null, allDay: true,
  });
  const multi = importRowFor(ev('b', '출장', { date: '2026-11-20' }, { date: '2026-11-23' }), 'Asia/Seoul')!;
  assert.equal(multi.startDate, '2026-11-20');
  assert.equal(multi.endDate, '2026-11-22');
  assert.equal(importRowFor(ev('c', '끝 없음', { date: '2026-11-20' }, undefined), 'Asia/Seoul')!.endDate, '2026-11-20');
  assert.equal(importRowFor(ev('d', '역전', { date: '2026-11-20' }, { date: '2026-11-19' }), 'Asia/Seoul')!.endDate, '2026-11-20');
});

test('불러오기 변환: 날짜를 넘기는 일정과 자정에 끝나는 일정', () => {
  const across = importRowFor(ev('a', '야간', { dateTime: '2026-11-20T22:00:00+09:00' }, { dateTime: '2026-11-21T02:00:00+09:00' }), 'Asia/Seoul')!;
  assert.deepEqual([across.startDate, across.endDate, across.startTime, across.endTime], ['2026-11-20', '2026-11-21', '22:00', '02:00']);
  const midnight = importRowFor(ev('b', '늦은 저녁', { dateTime: '2026-11-20T23:00:00+09:00' }, { dateTime: '2026-11-21T00:00:00+09:00' }), 'Asia/Seoul')!;
  assert.deepEqual([midnight.startDate, midnight.endDate, midnight.endTime], ['2026-11-20', '2026-11-20', null], '자정에 끝나면 그날까지만');
});

test('불러오기 변환: 취소·거절·이 앱이 보낸 일정·id 없음·날짜 오류는 건너뛰고, 제목은 다듬는다', () => {
  const day = { date: '2026-11-20' };
  const end = { date: '2026-11-21' };
  assert.equal(importRowFor(ev('a', 'x', day, end, { status: 'cancelled' }), 'Asia/Seoul'), null);
  assert.equal(importRowFor(ev('b', 'x', day, end, { attendees: [{ self: false, responseStatus: 'declined' }, { self: true, responseStatus: 'declined' }] }), 'Asia/Seoul'), null);
  assert.notEqual(importRowFor(ev('b2', 'x', day, end, { attendees: [{ self: false, responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }] }), 'Asia/Seoul'), null, '남이 거절한 것은 내 일정이다');
  assert.equal(importRowFor(ev('c', '치과', day, end, { extendedProperties: { private: { todoTaskId: 'abc' } } }), 'Asia/Seoul'), null, '이 앱이 보낸 일정은 중복이라 뺀다');
  assert.equal(importRowFor({ summary: 'x', start: day, end }, 'Asia/Seoul'), null);
  assert.equal(importRowFor(ev('d', 'x', { date: '2026-13-45' }, end), 'Asia/Seoul'), null);
  assert.equal(importRowFor(ev('e', 'x', { dateTime: 'not a date' }, { dateTime: 'nope' }), 'Asia/Seoul'), null);
  assert.equal(importRowFor(ev('f', 'x', undefined, undefined), 'Asia/Seoul'), null);
  assert.equal(importRowFor(ev('g', '   ', day, end), 'Asia/Seoul')!.title, '(제목 없음)');
  assert.equal(importRowFor(ev('h', '  앞뒤 공백  ', day, end), 'Asia/Seoul')!.title, '앞뒤 공백');
  assert.equal([...importRowFor(ev('i', '가'.repeat(300), day, end), 'Asia/Seoul')!.title].length, 200);
});

test('권한: 일정 읽기 권한을 함께 요청하는 인증 주소를 만들고, 허용하고 돌아오면 불러오기가 켜진다', async () => {
  const { gcal, google, db } = setup();
  const plain = new URL(gcal.startAuth().url);
  assert.equal(plain.searchParams.get('scope'), GCAL_SCOPE, '불러오기를 원하지 않으면 최소 권한만');
  const withImport = new URL(gcal.startAuth({ import: true }).url);
  assert.equal(withImport.searchParams.get('scope'), ALL_SCOPES);
  assert.equal(withImport.searchParams.get('include_granted_scopes'), 'true');

  google.granted.scope = ALL_SCOPES;
  await callback(gcal, { code: 'c', state: withImport.searchParams.get('state')! });
  const row = db.prepare('SELECT scopes, import_enabled FROM gcal_account').get() as { scopes: string; import_enabled: number };
  assert.equal(row.scopes, ALL_SCOPES);
  assert.equal(row.import_enabled, 1, '읽기 권한을 허용했으니 켠다');
  assert.equal(gcal.importStatus().available, true);
});

test('권한: 읽기 권한 없이 연결하면 불러오기는 꺼져 있고 설정을 바꿀 수 없다 (409)', async () => {
  const { gcal, google, db } = setup();
  google.granted.scope = GCAL_SCOPE;
  await callback(gcal, { code: 'c', state: new URL(gcal.startAuth().url).searchParams.get('state')! });
  assert.deepEqual(gcal.importStatus(), { available: false, enabled: false, calendars: [], lastImportAt: null, lastError: null });
  const route = gcal.routes.find((r) => r.path === '/api/gcal/import/settings')!;
  const req = (body: unknown) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} });
  await assert.rejects(
    async () => {
      await route.handle(req({ enabled: true }) as never, {} as never, new URL('http://x/'), {} as never);
    },
    (e: unknown) => e instanceof HttpError && e.status === 409,
  );
  assert.equal((db.prepare('SELECT import_enabled FROM gcal_account').get() as { import_enabled: number }).import_enabled, 0);
  await gcal.importNow();
  assert.equal(google.calls.filter((c) => c.url.includes('calendarList')).length, 0, '켜지지 않았으면 구글을 부르지 않는다');
});

test('불러오기: 캘린더 목록에서 이 앱의 "할 일" 캘린더는 빼고, 기본 캘린더만 선택된 채로 시작한다', async () => {
  const { gcal, google } = setupImport();
  const st = await gcal.importNow();
  assert.deepEqual(st.calendars.map((c) => [c.id, c.name, c.color, c.selected, c.primary]), [
    ['me@example.com', '내 일정', '#1a73e8', true, true],
    ['work@group', '업무', '#e8710a', false, false],
  ]);
  assert.equal(st.lastError, null);
  assert.ok(st.lastImportAt);
  // 선택된 캘린더만 일정을 받는다 (업무·할 일 캘린더는 요청하지 않는다)
  const asked = google.eventLists().map((c) => decodeURIComponent(c.url.split('/calendars/')[1]!.split('/events')[0]!));
  assert.deepEqual(asked, ['me@example.com']);
});

test('불러오기: 제목·시각만 요청하고(fields), 앞 31일부터 뒤 366일까지의 범위로 반복 일정은 펼쳐서 받는다', async () => {
  const { gcal, google } = setupImport();
  await gcal.importNow();
  const url = new URL(google.eventLists()[0]!.url);
  assert.equal(url.searchParams.get('singleEvents'), 'true');
  const fields = url.searchParams.get('fields')!;
  assert.match(fields, /summary/);
  for (const secret of ['description', 'location', 'email', 'organizer', 'creator', 'hangoutLink']) assert.ok(!fields.includes(secret), `${secret} 은 요청하지 않는다`);
  const day = 86_400_000;
  const now = new Date('2026-11-13T09:00:00.000Z').getTime();
  assert.equal(Date.parse(url.searchParams.get('timeMin')!), now - 31 * day);
  assert.equal(Date.parse(url.searchParams.get('timeMax')!), now + 366 * day);
});

test('불러오기: 일정을 저장하고 날짜 범위로 조회한다 (종일이 먼저, 시각순, 색·캘린더 이름 포함)', async () => {
  const { gcal, google } = setupImport();
  google.eventPages['me@example.com'] = [[
    ev('t2', '오후 약속', { dateTime: '2026-11-20T15:00:00+09:00' }, { dateTime: '2026-11-20T16:00:00+09:00' }),
    ev('t1', '아침 약속', { dateTime: '2026-11-20T08:00:00+09:00' }, { dateTime: '2026-11-20T09:00:00+09:00' }),
    ev('ad', '휴가', { date: '2026-11-20' }, { date: '2026-11-22' }),
    ev('far', '다음 달', { dateTime: '2026-12-25T10:00:00+09:00' }, { dateTime: '2026-12-25T11:00:00+09:00' }),
  ]];
  await gcal.importNow();
  const day = gcal.eventsBetween('2026-11-20', '2026-11-20');
  assert.deepEqual(day.map((e) => e.title), ['휴가', '아침 약속', '오후 약속'], '종일 → 시각순');
  assert.deepEqual(day[1], {
    id: 'me@example.com:t1', calendarId: 'me@example.com', calendarName: '내 일정', color: '#1a73e8', title: '아침 약속',
    startDate: '2026-11-20', endDate: '2026-11-20', startTime: '08:00', endTime: '09:00', allDay: false,
  });
  // 여러 날 일정은 걸친 날마다 조회된다
  assert.deepEqual(gcal.eventsBetween('2026-11-21', '2026-11-21').map((e) => e.title), ['휴가']);
  assert.deepEqual(gcal.eventsBetween('2026-11-22', '2026-11-22').map((e) => e.title), []);
  assert.deepEqual(gcal.eventsBetween('2026-11-01', '2026-11-30').map((e) => e.title), ['휴가', '아침 약속', '오후 약속']);
  assert.deepEqual(gcal.eventsBetween('2026-12-01', '2026-12-31').map((e) => e.title), ['다음 달']);
});

test('불러오기: 다시 불러오면 통째로 바꿔 넣어 바뀐 일정·지워진 일정이 반영되고 중복되지 않는다', async () => {
  const { gcal, google, db } = setupImport();
  await gcal.importNow();
  assert.equal(gcal.eventsBetween('2026-11-20', '2026-11-20').length, 1);
  google.eventPages['me@example.com'] = [[ev('e1', '치과 (변경)', { dateTime: '2026-11-21T13:00:00+09:00' }, { dateTime: '2026-11-21T14:00:00+09:00' }), ev('e9', '새 일정', { date: '2026-11-20' }, { date: '2026-11-21' })]];
  await gcal.importNow();
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-20').map((e) => e.title), ['새 일정']);
  assert.deepEqual(gcal.eventsBetween('2026-11-21', '2026-11-21').map((e) => e.title), ['치과 (변경)']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gcal_import_events').get() as { n: number }).n, 2);
  google.eventPages['me@example.com'] = [[]]; // 모두 지워짐
  await gcal.importNow();
  assert.equal(gcal.eventsBetween('2026-01-01', '2026-12-31').length, 0);
});

test('불러오기: 여러 페이지의 일정을 이어서 받는다', async () => {
  const { gcal, google } = setupImport();
  google.eventPages['me@example.com'] = [
    [ev('a', '1쪽', { date: '2026-11-20' }, { date: '2026-11-21' })],
    [ev('b', '2쪽', { date: '2026-11-21' }, { date: '2026-11-22' })],
    [ev('c', '3쪽', { date: '2026-11-22' }, { date: '2026-11-23' })],
  ];
  await gcal.importNow();
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-22').map((e) => e.title), ['1쪽', '2쪽', '3쪽']);
  assert.equal(google.eventLists().length, 3);
});

test('불러오기: 다른 캘린더를 선택하면 그 일정도 가져오고, 선택을 풀면 그 일정은 지운다', async () => {
  const { gcal, google } = setupImport();
  await gcal.importNow();
  const select = async (ids: string[]) => {
    const route = gcal.routes.find((r) => r.path === '/api/gcal/import/settings')!;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ calendars: ids }))]), { headers: {} });
    const out: { body?: string } = {};
    await route.handle(req as never, { writeHead: () => {}, end: (b: string) => (out.body = b) } as never, new URL('http://x/'), {} as never);
    return JSON.parse(out.body!) as ReturnType<typeof gcal.importStatus>;
  };
  let st = await select(['me@example.com', 'work@group']);
  assert.deepEqual(st.calendars.filter((c) => c.selected).map((c) => c.id), ['me@example.com', 'work@group']);
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-20').map((e) => e.title), ['주간 회의', '치과']);

  st = await select(['work@group']);
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-20').map((e) => e.title), ['주간 회의'], '선택을 푼 캘린더의 일정은 지운다');
  assert.equal(google.calls.filter((c) => c.url.includes('/calendars/cal-1/events?')).length, 0, '이 앱의 캘린더는 한 번도 읽지 않는다');
});

test('불러오기: 모르는 캘린더 id 나 잘못된 값으로 설정하면 400 이고 아무것도 바뀌지 않는다', async () => {
  const { gcal } = setupImport();
  await gcal.importNow();
  const route = gcal.routes.find((r) => r.path === '/api/gcal/import/settings')!;
  const call = async (body: unknown) => {
    await route.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} }) as never, { writeHead: () => {}, end: () => {} } as never, new URL('http://x/'), {} as never);
  };
  for (const body of [{ calendars: ['nope'] }, { calendars: 'me@example.com' }, { calendars: [1] }, { enabled: 'yes' }]) {
    await assert.rejects(call(body), (e: unknown) => e instanceof HttpError && e.status === 400, JSON.stringify(body));
  }
  assert.deepEqual(gcal.importStatus().calendars.filter((c) => c.selected).map((c) => c.id), ['me@example.com']);
});

test('불러오기: 한 캘린더가 실패(5xx)해도 다른 캘린더는 갱신하고, 실패한 캘린더는 이전 사본을 그대로 둔다', async () => {
  const { gcal, google, db } = setupImport();
  db.exec(`INSERT INTO gcal_import_calendars (calendar_id, name, color, selected, is_primary) VALUES ('work@group', '업무', '#e8710a', 1, 0)`);
  await gcal.importNow();
  assert.equal(gcal.eventsBetween('2026-11-20', '2026-11-20').length, 2);

  google.eventPages['me@example.com'] = [[ev('e2', '바뀐 내 일정', { date: '2026-11-20' }, { date: '2026-11-21' })]];
  google.overrides.push((c) => (c.url.includes('/calendars/work%40group/events?') ? new Response('{}', { status: 503 }) : undefined));
  const st = await gcal.importNow();
  assert.match(st.lastError ?? '', /503/);
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-20').map((e) => e.title).sort(), ['바뀐 내 일정', '주간 회의'], '업무는 이전 사본, 내 일정은 새 사본');
  assert.ok(st.lastImportAt);
});

test('불러오기: 캘린더가 없어졌으면(404) 그 캘린더와 일정을 지운다', async () => {
  const { gcal, google, db } = setupImport();
  db.exec(`INSERT INTO gcal_import_calendars (calendar_id, name, color, selected, is_primary) VALUES ('work@group', '업무', '#e8710a', 1, 0)`);
  await gcal.importNow();
  delete google.eventPages['work@group'];
  const st = await gcal.importNow();
  assert.deepEqual(st.calendars.map((c) => c.id), ['me@example.com']);
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-20').map((e) => e.title), ['치과']);
});

test('불러오기: 구글 캘린더 목록에서 사라진 캘린더는 우리 쪽에서도 지운다', async () => {
  const { gcal, google, db } = setupImport();
  db.exec(`INSERT INTO gcal_import_calendars (calendar_id, name, color, selected, is_primary) VALUES ('old@group', '옛 캘린더', NULL, 1, 0)`);
  db.exec(`INSERT INTO gcal_import_events (calendar_id, event_id, title, start_date, end_date, start_time, end_time, all_day) VALUES ('old@group', 'x', '옛 일정', '2026-11-20', '2026-11-20', NULL, NULL, 1)`);
  await gcal.importNow();
  assert.ok(!gcal.importStatus().calendars.some((c) => c.id === 'old@group'));
  assert.ok(!gcal.eventsBetween('2026-11-20', '2026-11-20').some((e) => e.title === '옛 일정'));
  void google;
});

test('불러오기: 이 앱이 보낸 일정(todoTaskId)이 다른 캘린더에 섞여 있어도 가져오지 않는다', async () => {
  const { gcal, google } = setupImport();
  google.eventPages['me@example.com'] = [[
    ev('mine', '앱이 보낸 일정', { date: '2026-11-20' }, { date: '2026-11-21' }, { extendedProperties: { private: { todoTaskId: 'abc' } } }),
    ev('real', '진짜 일정', { date: '2026-11-20' }, { date: '2026-11-21' }),
  ]];
  await gcal.importNow();
  assert.deepEqual(gcal.eventsBetween('2026-11-20', '2026-11-20').map((e) => e.title), ['진짜 일정']);
});

test('불러오기: 끄면 불러온 일정을 지우고 조회는 빈 목록이다. 다시 켜면 다시 받는다', async () => {
  const { gcal, db } = setupImport();
  await gcal.importNow();
  assert.equal(gcal.eventsBetween('2026-11-20', '2026-11-20').length, 1);
  const route = gcal.routes.find((r) => r.path === '/api/gcal/import/settings')!;
  const post = async (body: unknown) => route.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} }) as never, { writeHead: () => {}, end: () => {} } as never, new URL('http://x/'), {} as never);
  await post({ enabled: false });
  assert.equal(gcal.eventsBetween('2026-11-20', '2026-11-20').length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gcal_import_events').get() as { n: number }).n, 0, '사본도 지운다');
  await post({ enabled: true });
  assert.equal(gcal.eventsBetween('2026-11-20', '2026-11-20').length, 1);
});

test('불러오기: 연결을 해제하면 불러온 일정·캘린더 목록·받은 권한을 모두 지운다', async () => {
  const { gcal, db } = setupImport();
  await gcal.importNow();
  await gcal.disconnect();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gcal_import_events').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gcal_import_calendars').get() as { n: number }).n, 0);
  assert.deepEqual({ ...(db.prepare('SELECT scopes, import_enabled FROM gcal_account').get() as object) }, { scopes: '', import_enabled: 0 });
  assert.equal(gcal.importStatus().available, false);
  assert.deepEqual(gcal.eventsBetween('2026-01-01', '2026-12-31'), []);
});

test('불러오기: 구글에서 권한이 취소돼(invalid_grant) 있으면 다시 연결이 필요하다고 알리고 일정 사본은 남겨 두지 않는다 (오류만 기록)', async () => {
  const { gcal, google } = setupImport();
  google.overrides.push((c) => (c.url.endsWith('/token') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : undefined));
  const st = await gcal.importNow();
  assert.match(st.lastError ?? '', /불러오지 못했어요/);
  assert.equal(gcal.status().needsReauth, true);
});

test('불러오기: 동시에 여러 번 불러와도 한 번에 하나씩 돌고 결과가 같다', async () => {
  const { gcal, google } = setupImport();
  const [a, b] = await Promise.all([gcal.importNow(), gcal.importNow()]);
  assert.deepEqual(a.calendars, b.calendars);
  assert.ok(google.eventLists().length >= 1);
  assert.equal(gcal.eventsBetween('2026-11-20', '2026-11-20').length, 1);
});
