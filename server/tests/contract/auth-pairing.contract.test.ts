import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from '../helpers/test-server.ts';
import { createPairingCode, revokeDevice } from '../../src/auth.ts';

let s: TestServer;
before(async () => {
  s = await startTestServer();
});
after(async () => {
  await s.close();
});

test('계약 1: 쿠키 없이 /api/changes 를 호출하면 401', async () => {
  const res = await s.api('/api/changes?since=0');
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, 'unauthorized');
});

test('계약 1: 모르는 토큰 쿠키도 401', async () => {
  const res = await s.api('/api/changes?since=0', { cookie: 'todo_session=garbage' });
  assert.equal(res.status, 401);
});

test('계약 2: 해제된 기기의 쿠키로 호출하면 401', async () => {
  const { deviceId, cookie } = await s.pair('iPad');
  assert.equal((await s.api('/api/changes?since=0', { cookie })).status, 200);
  revokeDevice(s.db, deviceId, new Date());
  assert.equal((await s.api('/api/changes?since=0', { cookie })).status, 401);
});

test('계약 3: 페어링 코드는 한 번만 성공한다', async () => {
  const code = createPairingCode(s.db, 'iPhone');
  const first = await s.api('/api/pair', { body: { code, deviceId: crypto.randomUUID() } });
  assert.equal(first.status, 201);
  const body = (await first.json()) as { deviceId: string; deviceName: string };
  assert.equal(body.deviceName, 'iPhone');
  const again = await s.api('/api/pair', { body: { code, deviceId: crypto.randomUUID() } });
  assert.equal(again.status, 400);
  assert.equal(((await again.json()) as { error: string }).error, 'invalid_code');
});

test('계약 4: 만료된 코드는 400, 이미 등록된/잘못된 deviceId 는 invalid_device_id', async () => {
  const expired = createPairingCode(s.db, 'old', new Date(Date.now() - 11 * 60_000));
  const r1 = await s.api('/api/pair', { body: { code: expired, deviceId: crypto.randomUUID() } });
  assert.equal(r1.status, 400);
  assert.equal(((await r1.json()) as { error: string }).error, 'invalid_code');

  const r2 = await s.api('/api/pair', { body: { code: createPairingCode(s.db, 'x'), deviceId: 'nope' } });
  assert.equal(r2.status, 400);
  assert.equal(((await r2.json()) as { error: string }).error, 'invalid_device_id');

  const { deviceId } = await s.pair('dup');
  const r3 = await s.api('/api/pair', { body: { code: createPairingCode(s.db, 'y'), deviceId } });
  assert.equal(r3.status, 400);
  assert.equal(((await r3.json()) as { error: string }).error, 'invalid_device_id');
});

test('계약 5: X-Todo-Client 헤더가 없는 쓰기 요청은 403', async () => {
  const { cookie } = await s.pair();
  const res = await s.api('/api/changes', { cookie, body: { changes: [] }, csrf: false });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, 'csrf');
});

test('Set-Cookie 속성: HttpOnly; SameSite=Strict; Path=/api; Max-Age=315360000 (개발 모드에서는 Secure 제외)', async () => {
  const code = createPairingCode(s.db, 'cookie');
  const res = await s.api('/api/pair', { body: { code, deviceId: crypto.randomUUID() } });
  const c = res.headers.get('set-cookie')!;
  assert.match(c, /^todo_session=[A-Za-z0-9_-]{43};/);
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/api', 'Max-Age=315360000']) assert.ok(c.includes(attr), attr);
  assert.ok(!c.includes('Secure'), '개발 모드(secureCookie=false)에서는 Secure 가 없다');
});

test('운영 모드(secureCookie=true)에서는 Secure 가 붙는다', async () => {
  const prod = await startTestServer({ secureCookie: true });
  try {
    const res = await prod.api('/api/pair', { body: { code: createPairingCode(prod.db, 'p'), deviceId: crypto.randomUUID() } });
    assert.ok(res.headers.get('set-cookie')!.includes('Secure'));
  } finally {
    await prod.close();
  }
});

test('페어링 실패가 1분에 5회를 넘으면 429', async () => {
  const srv = await startTestServer();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await srv.api('/api/pair', { body: { code: 'AAAA-AAAA', deviceId: crypto.randomUUID() } });
      assert.equal(r.status, 400);
    }
    const limited = await srv.api('/api/pair', { body: { code: 'AAAA-AAAA', deviceId: crypto.randomUUID() } });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: string }).error, 'rate_limited');
  } finally {
    await srv.close();
  }
});

test('/api/health 는 인증 없이 응답하고 /api/* 응답에는 Cache-Control: no-store', async () => {
  const res = await s.api('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('본문이 1 MiB 를 넘으면 413', async () => {
  const { cookie } = await s.pair();
  const big = 'x'.repeat(1024 * 1024 + 10);
  const res = await fetch(s.base + '/api/changes', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Todo-Client': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ pad: big }),
  });
  assert.equal(res.status, 413);
});

test('GET /api/devices/me', async () => {
  const { deviceId, cookie } = await s.pair('내 아이폰');
  const res = await s.api('/api/devices/me', { cookie });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { deviceId: string; deviceName: string; createdAt: string; push: { subscribed: boolean } };
  assert.equal(body.deviceId, deviceId);
  assert.equal(body.deviceName, '내 아이폰');
  assert.equal(body.push.subscribed, false);
  assert.ok(Date.parse(body.createdAt));
});
