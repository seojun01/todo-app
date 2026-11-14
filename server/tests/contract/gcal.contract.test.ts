import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, mkTask, type TestServer } from '../helpers/test-server.ts';

interface Call {
  method: string;
  url: string;
  body: any;
}
const calls: Call[] = [];
const googleFetch: typeof fetch = async (input, init) => {
  const raw = init?.body;
  const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw ? JSON.parse(String(raw)) : undefined;
  const url = String(input);
  calls.push({ method: init?.method ?? 'GET', url, body });
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/token')) return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt' });
  if (url.endsWith('/calendars')) return json({ id: 'cal-1' });
  if (url.endsWith('/events')) return json({ id: 'ev-1' });
  return json({});
};

let s: TestServer;
let cookie = '';
before(async () => {
  s = await startTestServer({
    gcal: { clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost/api/gcal/callback', timeZone: 'Asia/Seoul', appUrl: '' },
    fetch: googleFetch,
  });
  cookie = (await s.pair()).cookie;
});
after(async () => {
  await s.close();
});

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('시간 안에 조건이 충족되지 않았어요');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('구글 연동 API 는 등록된 기기만 부를 수 있다 (콜백만 공개)', async () => {
  assert.equal((await s.api('/api/gcal/status')).status, 401);
  assert.equal((await s.api('/api/gcal/connect', { method: 'POST', body: {} })).status, 401);
  assert.equal((await s.api('/api/gcal/sync', { method: 'POST', body: {} })).status, 401);
  assert.equal((await s.api('/api/gcal/disconnect', { method: 'POST', body: {} })).status, 401);
});

test('쓰기 요청은 CSRF 헤더가 필요하다', async () => {
  const res = await s.api('/api/gcal/connect', { method: 'POST', body: {}, cookie, csrf: false });
  assert.equal(res.status, 403);
});

test('연결 전 상태 → 연결 시작 → 콜백 → 연결됨, 그리고 변경을 올리면 자동으로 일정이 만들어진다', async () => {
  const before = (await (await s.api('/api/gcal/status', { cookie })).json()) as Record<string, unknown>;
  assert.deepEqual(before, { configured: true, connected: false, needsReauth: false, lastSyncAt: null, lastError: null, pending: 0 });

  const { url } = (await (await s.api('/api/gcal/connect', { method: 'POST', body: {}, cookie })).json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;

  // 콜백은 로그인 쿠키 없이 온다(구글이 브라우저를 되돌려 보낸다). 설정 화면으로 돌려보낸다.
  const cb = await fetch(`${s.base}/api/gcal/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/#/settings');
  assert.equal(((await (await s.api('/api/gcal/status', { cookie })).json()) as { connected: boolean }).connected, true);

  calls.length = 0;
  const task = mkTask({ title: '치과', dueDate: '2026-11-20', dueTime: '15:00' });
  const push = await s.api('/api/changes', { cookie, body: { changes: [{ type: 'task', record: task }] } });
  assert.equal(push.status, 200);
  await until(() => calls.some((c) => c.url.endsWith('/events')));
  const ev = calls.find((c) => c.url.endsWith('/events'))!;
  assert.equal(ev.body.summary, '치과');
  assert.deepEqual(ev.body.start, { dateTime: '2026-11-20T15:00:00', timeZone: 'Asia/Seoul' });
  await until(() => s.gcal.status().pending === 0);
});

test('연결을 해제하면 연결 안 됨으로 돌아간다', async () => {
  const st = (await (await s.api('/api/gcal/disconnect', { method: 'POST', body: {}, cookie })).json()) as { connected: boolean };
  assert.equal(st.connected, false);
});

test('위조된 state 의 콜백은 아무 일도 하지 않고 설정 화면으로만 돌려보낸다', async () => {
  calls.length = 0;
  const cb = await fetch(`${s.base}/api/gcal/callback?code=abc&state=forged`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.equal(calls.length, 0);
  assert.equal(s.gcal.status().connected, false);
});

test('구글 설정이 없는 서버: 상태는 configured=false, 연결 시작은 503', async () => {
  const off = await startTestServer({ gcal: null });
  try {
    const { cookie: c } = await off.pair();
    assert.equal(((await (await off.api('/api/gcal/status', { cookie: c })).json()) as { configured: boolean }).configured, false);
    assert.equal((await off.api('/api/gcal/connect', { method: 'POST', body: {}, cookie: c })).status, 503);
  } finally {
    await off.close();
  }
});

// ── 일정 불러오기 (HTTP) ──

const READ = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];
const ALL = ['https://www.googleapis.com/auth/calendar.app.created', ...READ].join(' ');

function importFetch(sink: Call[]): typeof fetch {
  return async (input, init) => {
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw ? JSON.parse(String(raw)) : undefined;
    const url = String(input);
    sink.push({ method: init?.method ?? 'GET', url, body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/token')) return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: ALL });
    if (url.includes('/users/me/calendarList')) return json({ items: [{ id: 'me@example.com', summary: '내 일정', backgroundColor: '#1a73e8', primary: true }] });
    if (/\/calendars\/me%40example\.com\/events\?/.test(url)) {
      return json({ items: [{ id: 'e1', summary: '치과', start: { dateTime: '2026-11-20T13:00:00+09:00' }, end: { dateTime: '2026-11-20T14:00:00+09:00' } }] });
    }
    if (url.endsWith('/calendars')) return json({ id: 'cal-1' });
    return json({});
  };
}

test('일정 불러오기 API 는 등록된 기기만 부를 수 있고, 쓰기에는 CSRF 헤더가 필요하다', async () => {
  const srv = await startTestServer({ gcal: { clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost/api/gcal/callback', timeZone: 'Asia/Seoul', appUrl: '' }, fetch: importFetch([]) });
  try {
    assert.equal((await srv.api('/api/gcal/import')).status, 401);
    assert.equal((await srv.api('/api/gcal/events?from=2026-11-01&to=2026-11-30')).status, 401);
    assert.equal((await srv.api('/api/gcal/import/settings', { method: 'POST', body: {} })).status, 401);
    assert.equal((await srv.api('/api/gcal/import/refresh', { method: 'POST', body: {} })).status, 401);
    const { cookie: c } = await srv.pair();
    assert.equal((await srv.api('/api/gcal/import/settings', { method: 'POST', body: {}, cookie: c, csrf: false })).status, 403);
    assert.equal((await srv.api('/api/gcal/import/refresh', { method: 'POST', body: {}, cookie: c, csrf: false })).status, 403);
  } finally {
    await srv.close();
  }
});

test('일정 조회: 날짜 형식·순서·범위(400일)를 검증하고, 불러오기가 꺼져 있으면 빈 목록이다', async () => {
  const srv = await startTestServer({ gcal: { clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost/api/gcal/callback', timeZone: 'Asia/Seoul', appUrl: '' }, fetch: importFetch([]) });
  try {
    const { cookie: c } = await srv.pair();
    for (const q of ['', '?from=2026-11-01', '?from=bad&to=2026-11-30', '?from=2026-11-30&to=2026-11-01', '?from=2026-02-30&to=2026-03-01', '?from=2025-01-01&to=2026-11-30']) {
      assert.equal((await srv.api(`/api/gcal/events${q}`, { cookie: c })).status, 400, q);
    }
    const ok = await srv.api('/api/gcal/events?from=2026-11-01&to=2026-11-30', { cookie: c });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { events: [] });
    // 연결하지 않았으면 설정을 바꿀 수 없다 (409)
    assert.equal((await srv.api('/api/gcal/import/settings', { method: 'POST', body: { enabled: true }, cookie: c })).status, 409);
  } finally {
    await srv.close();
  }
});

test('연결(읽기 권한 포함) → 자동으로 일정을 불러옴 → 조회 → 끄면 지워짐 → 연결 해제하면 모두 정리', async () => {
  const calls: Call[] = [];
  const srv = await startTestServer({ gcal: { clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost/api/gcal/callback', timeZone: 'Asia/Seoul', appUrl: '' }, fetch: importFetch(calls) });
  try {
    const { cookie: c } = await srv.pair();
    // 읽기 권한을 함께 요청하는 연결
    const { url } = (await (await srv.api('/api/gcal/connect', { method: 'POST', body: { import: true }, cookie: c })).json()) as { url: string };
    assert.deepEqual(new URL(url).searchParams.get('scope')!.split(' '), ['https://www.googleapis.com/auth/calendar.app.created', ...READ]);
    await fetch(`${srv.base}/api/gcal/callback?code=abc&state=${new URL(url).searchParams.get('state')}`, { redirect: 'manual' });

    const status = async () => (await (await srv.api('/api/gcal/import', { cookie: c })).json()) as { available: boolean; enabled: boolean; calendars: { id: string; selected: boolean }[]; lastImportAt: string | null };
    await until(() => srv.gcal.importStatus().lastImportAt !== null); // 콜백이 뒤에서 불러온다
    const st = await status();
    assert.equal(st.available, true);
    assert.equal(st.enabled, true);
    assert.deepEqual(st.calendars.map((x) => [x.id, x.selected]), [['me@example.com', true]]);

    const events = async () => ((await (await srv.api('/api/gcal/events?from=2026-11-20&to=2026-11-20', { cookie: c })).json()) as { events: { title: string; startTime: string; color: string; calendarName: string }[] }).events;
    assert.deepEqual(await events(), [{ id: 'me@example.com:e1', calendarId: 'me@example.com', calendarName: '내 일정', color: '#1a73e8', title: '치과', startDate: '2026-11-20', endDate: '2026-11-20', startTime: '13:00', endTime: '14:00', allDay: false }]);

    // 끄면 지워진다
    const off = await srv.api('/api/gcal/import/settings', { method: 'POST', body: { enabled: false }, cookie: c });
    assert.equal(off.status, 200);
    assert.deepEqual(await events(), []);
    // 다시 켜면 다시 받는다
    await srv.api('/api/gcal/import/settings', { method: 'POST', body: { enabled: true }, cookie: c });
    assert.equal((await events()).length, 1);
    // 지금 불러오기
    assert.equal((await srv.api('/api/gcal/import/refresh', { method: 'POST', body: {}, cookie: c })).status, 200);

    // 연결 해제 → 불러온 일정과 권한을 지운다
    await srv.api('/api/gcal/disconnect', { method: 'POST', body: {}, cookie: c });
    assert.deepEqual(await events(), []);
    assert.equal((await status()).available, false);
    assert.ok(calls.some((x) => x.url.endsWith('/revoke')));
  } finally {
    await srv.close();
  }
});
