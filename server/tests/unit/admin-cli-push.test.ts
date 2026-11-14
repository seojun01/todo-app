import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.ts';
import { createPairingCode, redeemPairingCode } from '../../src/auth.ts';
import { startFakePush, type FakePush } from '../helpers/fake-push-service.ts';

let dir = '';
let dbFile = '';
let fake: FakePush;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-cli-push-'));
  dbFile = join(dir, 'todo.db');
  fake = await startFakePush();
});
afterEach(async () => {
  await fake.close();
});

/** 비동기로 실행한다: 가짜 푸시 서비스가 이 프로세스에서 응답해야 하므로 spawnSync 를 쓰면 멈춘다 */
function cli(...args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', 'server/src/admin-cli.ts', ...args], {
      env: { ...process.env, TODO_DB: dbFile, TODO_VAPID_FILE: join(dir, 'vapid.json'), TODO_PUSH_ALLOW_HOSTS: fake.host },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

function registerDevice(name: string, opts: { subscribe?: boolean; enabled?: boolean } = {}): { id: string; subId?: string } {
  const db = openDb(dbFile);
  const id = crypto.randomUUID();
  redeemPairingCode(db, createPairingCode(db, name), id);
  let subId: string | undefined;
  if (opts.subscribe !== false) {
    const sub = fake.newSubscription();
    subId = sub.id;
    db.prepare('INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, timezone, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, 'Asia/Seoul', opts.enabled === false ? 0 : 1, new Date().toISOString(),
    );
  }
  db.close();
  return { id, subId };
}

test('push-test: 구독한 기기에 테스트 푸시를 보내고 푸시 서비스의 응답 코드를 출력한다 (성공이면 종료 코드 0)', async () => {
  const d = registerDevice('iPhone');
  const r = await cli('push-test', d.id);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /푸시 서비스 응답: 201 \(ok\)/);
  assert.match(r.out, /전달됐어요/);
  assert.equal(fake.received.length, 1);
  assert.equal(fake.received[0]!.subscription, d.subId);
  assert.deepEqual(fake.received[0]!.payload, { v: 1, test: true }, 'RFC 8291 로 암호화돼 가짜 서비스가 풀었을 때 test:true 만 있다');
  assert.equal(fake.received[0]!.headers.ttl, '900');
});

test('push-test: 푸시 서비스가 거절하거나 구독이 만료됐으면 응답 코드와 해결 안내를 보이고 종료 코드 1', async () => {
  const d = registerDevice('iPhone');
  fake.setStatus(410);
  const gone = await cli('push-test', d.id);
  assert.equal(gone.status, 1);
  assert.match(gone.out, /푸시 서비스 응답: 410 \(gone\)/);
  assert.match(gone.out, /알림을 다시 켜세요/);

  fake.setStatus(403);
  const fail = await cli('push-test', d.id);
  assert.equal(fail.status, 1);
  assert.match(fail.out, /푸시 서비스 응답: 403 \(fail\)/);
  assert.match(fail.out, /VAPID/);

  fake.setStatus(503);
  const retry = await cli('push-test', d.id);
  assert.equal(retry.status, 1);
  assert.match(retry.out, /푸시 서비스 응답: 503 \(retry\)/);
  assert.match(retry.out, /다시 시도/);
});

test('push-test: 구독이 없는 기기·모르는 기기·인자 없음을 안내한다', async () => {
  const none = registerDevice('구독 없음', { subscribe: false });
  const noSub = await cli('push-test', none.id);
  assert.equal(noSub.status, 1);
  assert.match(noSub.err, /구독하지 않았어요/);
  assert.match(noSub.err, /이 기기에서 알림 받기/);
  assert.equal(fake.received.length, 0, '아무것도 보내지 않았다');

  const unknown = await cli('push-test', crypto.randomUUID());
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /그런 기기가 없어요/);

  const usage = await cli('push-test');
  assert.equal(usage.status, 2);
  assert.match(usage.err, /push-test <deviceId>/);
});

test('push-test: 앱에서 알림을 꺼 둔 기기라면 보내되 그 사실을 알려 준다', async () => {
  const d = registerDevice('끈 기기', { enabled: false });
  const r = await cli('push-test', d.id);
  assert.equal(r.status, 0);
  assert.match(r.out, /알림은 앱에서 꺼져 있어요/);
});

test('push-test: 허용되지 않은 푸시 주소는 요청을 보내지 않고 거절로 보고한다', async () => {
  const db = openDb(dbFile);
  const id = crypto.randomUUID();
  redeemPairingCode(db, createPairingCode(db, '이상한 구독'), id);
  const good = fake.newSubscription();
  db.prepare('INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, timezone, enabled, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(
    id, 'https://evil.example.com/push/1', good.keys.p256dh, good.keys.auth, 'Asia/Seoul', new Date().toISOString(),
  );
  db.close();
  const r = await cli('push-test', id);
  assert.equal(r.status, 1);
  assert.match(r.out, /푸시 서비스 응답: 응답 없음 \(fail\)/);
  assert.equal(fake.received.length, 0);
});

test('devices 의 알림 열과 revoke 가 구독을 지우는 동작은 그대로다', async () => {
  const on = registerDevice('켜짐');
  const off = registerDevice('꺼짐', { enabled: false });
  const none = registerDevice('없음', { subscribe: false });
  const list = await cli('devices');
  const line = (name: string) => list.out.split('\n').find((l) => l.includes(name))!;
  assert.match(line('켜짐'), /\s켬\s/);
  assert.match(line('꺼짐'), /\s끔\s/);
  assert.match(line('없음'), /\s없음\s/);
  assert.equal((await cli('revoke', on.id)).status, 0);
  const db = openDb(dbFile);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE device_id = ?').get(on.id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE device_id = ?').get(off.id) as { n: number }).n, 1);
  db.close();
  void none;
});
