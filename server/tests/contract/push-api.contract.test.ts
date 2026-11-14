import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revokeDevice } from '../../src/auth.ts';
import { startTestServer, type TestServer } from '../helpers/test-server.ts';
import { startFakePush, type FakePush } from '../helpers/fake-push-service.ts';

let fake: FakePush;
let s: TestServer;
let cookie = '';
let deviceId = '';
before(async () => {
  fake = await startFakePush();
  s = await startTestServer({ push: { allowHosts: [fake.host] } });
  ({ cookie, deviceId } = await s.pair('iPhone'));
});
after(async () => {
  await s.close();
  await fake.close();
});

const put = (body: unknown, c = cookie) => s.api('/api/devices/me/push', { method: 'PUT', body, cookie: c });
const subBody = (sub = fake.newSubscription(), extra: Record<string, unknown> = {}) => ({ subscription: { endpoint: sub.endpoint, keys: sub.keys }, timezone: 'Asia/Seoul', ...extra });
const rows = () => s.db.prepare('SELECT device_id, endpoint, timezone, enabled FROM push_subscriptions ORDER BY device_id').all() as { device_id: string; endpoint: string; timezone: string; enabled: number }[];

test('계약 13: GET /api/push/key 는 인증이 필요하고 공개키(비압축 점 65바이트)를 돌려준다', async () => {
  assert.equal((await s.api('/api/push/key')).status, 401);
  const res = await s.api('/api/push/key', { cookie });
  assert.equal(res.status, 200);
  const { publicKey } = (await res.json()) as { publicKey: string };
  const raw = Buffer.from(publicKey, 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
});

test('계약 13: 서버를 다시 시작해도(같은 키 파일) 같은 공개키를 돌려준다', async () => {
  const vapidFile = join(mkdtempSync(join(tmpdir(), 'vapid-restart-')), 'vapid.json');
  const first = await startTestServer({ vapidFile });
  const a = ((await (await first.api('/api/push/key', { cookie: (await first.pair()).cookie })).json()) as { publicKey: string }).publicKey;
  await first.close();
  const second = await startTestServer({ vapidFile });
  const b = ((await (await second.api('/api/push/key', { cookie: (await second.pair()).cookie })).json()) as { publicKey: string }).publicKey;
  await second.close();
  assert.equal(a, b);
});

test('계약 12: 구독을 등록하면 이 기기의 구독·시간대·켜짐 상태가 저장되고, /api/devices/me 에도 보인다', async () => {
  const res = await put(subBody());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { subscribed: true, enabled: true, timezone: 'Asia/Seoul' });
  assert.equal(rows().length, 1);
  const me = (await (await s.api('/api/devices/me', { cookie })).json()) as { push: unknown };
  assert.deepEqual(me.push, { subscribed: true, enabled: true, timezone: 'Asia/Seoul' });
  // 같은 기기가 다시 등록하면 갱신된다 (행이 늘지 않는다)
  assert.equal((await put(subBody(undefined, { timezone: 'America/New_York' }))).status, 200);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0]!.timezone, 'America/New_York');
});

test('계약 12: 허용되지 않은 호스트·http·자격 증명이 든 endpoint 는 400 invalid_endpoint', async () => {
  const good = fake.newSubscription();
  const before = rows().length;
  for (const endpoint of [
    'https://evil.example.com/push/1',
    'http://web.push.apple.com/x',
    'https://web.push.apple.com.evil.com/x',
    'https://user:pw@web.push.apple.com/x',
    'https://169.254.169.254/latest',
    `http://127.0.0.1:1/push/1`, // 허용 호스트가 아닌 포트
    'not a url',
    '',
  ]) {
    const res = await put({ subscription: { endpoint, keys: good.keys }, timezone: 'Asia/Seoul' });
    assert.equal(res.status, 400, endpoint);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_endpoint', endpoint);
  }
  for (const subscription of [null, 'x', 5, {}, { keys: good.keys }]) {
    assert.equal((await put({ subscription, timezone: 'Asia/Seoul' })).status, 400, JSON.stringify(subscription));
  }
  assert.equal(rows().length, before, '아무것도 저장되지 않았다');
  // 애플 푸시 서비스의 https 주소는 허용된다 (실제 전송은 하지 않는다)
  const apple = await put({ subscription: { endpoint: 'https://web.push.apple.com/QGxx1', keys: good.keys }, timezone: 'Asia/Seoul' });
  assert.equal(apple.status, 200);
});

test('계약 12: 구독 키가 잘못되면 400 invalid_subscription, 잘못된 시간대는 400 invalid_timezone', async () => {
  const sub = fake.newSubscription();
  for (const keys of [{ p256dh: 'AAAA', auth: sub.keys.auth }, { p256dh: sub.keys.p256dh, auth: 'AAAA' }, { p256dh: sub.keys.p256dh }, {}, { p256dh: 5, auth: 6 }]) {
    const res = await put({ subscription: { endpoint: sub.endpoint, keys }, timezone: 'Asia/Seoul' });
    assert.equal(res.status, 400, JSON.stringify(keys));
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_subscription');
  }
  for (const timezone of ['Seoul', 'Not/AZone', '', 5, null]) {
    const res = await put({ ...subBody(sub), timezone });
    assert.equal(res.status, 400, String(timezone));
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_timezone');
  }
  // 시간대를 안 보내면 이 기기에 이미 저장된 값을 쓴다 (앞 테스트에서 Asia/Seoul 로 갱신됐다)
  assert.equal(rows().find((r) => r.device_id === deviceId)!.timezone, 'Asia/Seoul');
  assert.equal(((await (await put({ ...subBody(sub), timezone: undefined })).json()) as { timezone: string }).timezone, 'Asia/Seoul');
  assert.equal((await put({ ...subBody(), enabled: 'yes' })).status, 400, 'enabled 는 true/false');
});

test('계약 12: subscription 을 생략하면 enabled·시간대만 바꾸고, 구독이 없으면 409 not_subscribed', async () => {
  const other = await s.pair('iPad');
  const none = await put({ enabled: false }, other.cookie);
  assert.equal(none.status, 409);
  assert.equal(((await none.json()) as { error: string }).error, 'not_subscribed');

  assert.equal((await put(subBody())).status, 200);
  const off = await put({ enabled: false });
  assert.deepEqual(await off.json(), { subscribed: true, enabled: false, timezone: 'Asia/Seoul' });
  assert.equal(rows().find((r) => r.device_id === deviceId)!.enabled, 0);
  const tz = await put({ timezone: 'Europe/London' });
  assert.deepEqual(await tz.json(), { subscribed: true, enabled: false, timezone: 'Europe/London' }, '시간대만 바꿔도 켜짐 상태는 그대로');
  assert.deepEqual(await (await put({ enabled: true })).json(), { subscribed: true, enabled: true, timezone: 'Europe/London' });
  assert.equal((await put({ timezone: 'Bad/Zone' })).status, 400);
});

test('계약 12: 인증과 CSRF 헤더가 필요하다', async () => {
  assert.equal((await s.api('/api/devices/me/push', { method: 'PUT', body: subBody() })).status, 401);
  assert.equal((await s.api('/api/devices/me/push', { method: 'DELETE' })).status, 401);
  assert.equal((await s.api('/api/push/test', { method: 'POST', body: {} })).status, 401);
  assert.equal((await s.api('/api/devices/me/push', { method: 'PUT', body: subBody(), cookie, csrf: false })).status, 403);
  assert.equal((await s.api('/api/push/test', { method: 'POST', body: {}, cookie, csrf: false })).status, 403);
});

test('한 푸시 구독은 기기 하나에만 속한다: 같은 endpoint 를 다른 기기가 등록하면 옛 기기의 구독이 지워진다', async () => {
  const a = await s.pair('A');
  const b = await s.pair('B');
  const sub = fake.newSubscription();
  assert.equal((await put(subBody(sub), a.cookie)).status, 200);
  assert.equal(rows().filter((r) => r.endpoint === sub.endpoint).length, 1);
  assert.equal((await put(subBody(sub), b.cookie)).status, 200);
  const owners = rows().filter((r) => r.endpoint === sub.endpoint).map((r) => r.device_id);
  assert.deepEqual(owners, [b.deviceId]);
});

test('DELETE: 이 기기의 구독을 지운다 (없어도 성공)', async () => {
  const d = await s.pair('D');
  assert.equal((await put(subBody(), d.cookie)).status, 200);
  const res = await s.api('/api/devices/me/push', { method: 'DELETE', cookie: d.cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { subscribed: false, enabled: false, timezone: null });
  assert.equal(rows().some((r) => r.device_id === d.deviceId), false);
  assert.equal((await s.api('/api/devices/me/push', { method: 'DELETE', cookie: d.cookie })).status, 200);
  assert.equal((await s.api('/api/push/test', { method: 'POST', body: {}, cookie: d.cookie })).status, 409);
});

test('계약 14: POST /api/push/test 는 RFC 8291 대로 암호화한 푸시를 보내고, 복호화한 페이로드에는 test:true 만 있다', async () => {
  const t = await s.pair('Tester');
  const sub = fake.newSubscription();
  assert.equal((await put(subBody(sub), t.cookie)).status, 200);
  fake.received.length = 0;
  const res = await s.api('/api/push/test', { method: 'POST', body: {}, cookie: t.cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  assert.equal(fake.received.length, 1);
  const r = fake.received[0]!;
  assert.equal(r.subscription, sub.id);
  assert.deepEqual(r.payload, { v: 1, test: true });
  assert.equal(r.headers['content-encoding'], 'aes128gcm');
  assert.equal(r.headers.ttl, '900');
  assert.match(String(r.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test('계약 14: 구독이 없으면 409 not_subscribed, 꺼져 있으면 409 disabled', async () => {
  const none = await s.pair('NoSub');
  const res = await s.api('/api/push/test', { method: 'POST', body: {}, cookie: none.cookie });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, 'not_subscribed');

  const off = await s.pair('Off');
  assert.equal((await put(subBody(undefined, { enabled: false }), off.cookie)).status, 200);
  const r2 = await s.api('/api/push/test', { method: 'POST', body: {}, cookie: off.cookie });
  assert.equal(r2.status, 409);
  assert.equal(((await r2.json()) as { error: string }).error, 'disabled');
});

test('테스트 푸시: 푸시 서비스가 구독이 없어졌다고 답하면(410) 구독을 지우고 409, 서버 오류면 502', async () => {
  const t = await s.pair('Flaky');
  assert.equal((await put(subBody(), t.cookie)).status, 200);
  fake.setStatus(503);
  const retry = await s.api('/api/push/test', { method: 'POST', body: {}, cookie: t.cookie });
  assert.equal(retry.status, 502);
  assert.equal(((await retry.json()) as { error: string }).error, 'push_unavailable');
  fake.setStatus(403);
  const fail = await s.api('/api/push/test', { method: 'POST', body: {}, cookie: t.cookie });
  assert.equal(fail.status, 502);
  assert.equal(((await fail.json()) as { error: string }).error, 'push_failed');
  assert.equal(rows().some((r) => r.device_id === t.deviceId), true, '일시적인 오류로는 구독을 지우지 않는다');
  fake.setStatus(410);
  const gone = await s.api('/api/push/test', { method: 'POST', body: {}, cookie: t.cookie });
  assert.equal(gone.status, 409);
  assert.equal(((await gone.json()) as { error: string }).error, 'not_subscribed');
  assert.equal(rows().some((r) => r.device_id === t.deviceId), false, '410 이면 구독을 지운다');
  fake.setStatus(201);
});

test('기기를 해제하면 그 기기의 푸시 구독이 삭제되고 이후 요청은 401 이다', async () => {
  const r = await s.pair('Revoked');
  assert.equal((await put(subBody(), r.cookie)).status, 200);
  assert.equal(rows().some((x) => x.device_id === r.deviceId), true);
  revokeDevice(s.db, r.deviceId, new Date());
  assert.equal(rows().some((x) => x.device_id === r.deviceId), false);
  assert.equal((await put(subBody(), r.cookie)).status, 401);
});
