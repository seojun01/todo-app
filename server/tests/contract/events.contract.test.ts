import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, mkTask, readSse, type TestServer } from '../helpers/test-server.ts';
import { revokeDevice } from '../../src/auth.ts';

let s: TestServer;
before(async () => {
  s = await startTestServer({ events: { checkMs: 40, pingMs: 10_000 } });
});
after(async () => {
  await s.close();
});

test('SSE 는 인증이 필요하다', async () => {
  const res = await s.api('/api/events');
  assert.equal(res.status, 401);
});

test('연결 직후 현재 cursor 이벤트가 온다', async () => {
  const { cookie } = await s.pair();
  const res = await s.api('/api/events', { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const sse = await readSse(res);
  const first = await sse.next();
  assert.ok(first && first !== 'timeout');
  assert.equal(first.event, 'cursor');
  assert.equal(typeof JSON.parse(first.data).cursor, 'number');
  sse.cancel();
});

test('계약 11: 다른 클라이언트가 push 하면 1초 안에 cursor 이벤트가 온다', async () => {
  const a = await s.pair('listener');
  const b = await s.pair('writer');
  const res = await s.api('/api/events', { cookie: a.cookie });
  const sse = await readSse(res);
  const first = await sse.next();
  assert.ok(first && first !== 'timeout');
  const start = JSON.parse(first.data).cursor as number;

  const t0 = Date.now();
  const pushed = await s.api('/api/changes', { cookie: b.cookie, body: { changes: [{ type: 'task', record: mkTask() }] } });
  assert.equal(pushed.status, 200);
  const ev = await sse.next(1000);
  assert.ok(ev && ev !== 'timeout', '1초 안에 이벤트가 와야 한다');
  assert.equal(ev.event, 'cursor');
  assert.equal(JSON.parse(ev.data).cursor, start + 1);
  assert.ok(Date.now() - t0 < 1000);
  sse.cancel();
});

test('변경이 반영되지 않은(ignored) push 는 이벤트를 만들지 않는다', async () => {
  const a = await s.pair();
  const task = mkTask();
  await s.api('/api/changes', { cookie: a.cookie, body: { changes: [{ type: 'task', record: task }] } });
  const sse = await readSse(await s.api('/api/events', { cookie: a.cookie }));
  await sse.next(); // 초기 cursor
  await s.api('/api/changes', { cookie: a.cookie, body: { changes: [{ type: 'task', record: task }] } }); // 같은 push → ignored
  assert.equal(await sse.next(300), 'timeout');
  sse.cancel();
});

test('기기를 해제하면 스트림이 닫힌다', async () => {
  const { deviceId, cookie } = await s.pair('to-revoke');
  const sse = await readSse(await s.api('/api/events', { cookie }));
  await sse.next(); // 초기 cursor
  revokeDevice(s.db, deviceId, new Date());
  const end = await sse.next(1500);
  assert.equal(end, null, '스트림이 닫혀야 한다');
  // 이후 재연결은 401
  assert.equal((await s.api('/api/events', { cookie })).status, 401);
});
