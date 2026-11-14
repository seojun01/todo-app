import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../../src/db.ts';
import {
  CODE_ALPHABET,
  FailureLimiter,
  authenticate,
  createPairingCode,
  hashToken,
  redeemPairingCode,
  revokeDevice,
} from '../../src/auth.ts';
import { HttpError } from '../../src/http.ts';

const uuid = () => crypto.randomUUID();
const T0 = new Date('2026-11-12T09:00:00.000Z');
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

function expectHttp(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status && e.code === code, `${status} ${code}`);
}

test('페어링 코드는 혼동하기 쉬운 문자(0/O, 1/I/L)를 뺀 대문자와 숫자 8자리다', () => {
  const db = openDb(':memory:');
  for (const bad of ['0', 'O', '1', 'I', 'L']) assert.ok(!CODE_ALPHABET.includes(bad), bad);
  for (let i = 0; i < 300; i++) {
    const code = createPairingCode(db, 'phone', T0);
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  }
});

test('DB 에는 코드의 해시만 저장된다', () => {
  const db = openDb(':memory:');
  const code = createPairingCode(db, 'iPhone', T0);
  const plain = code.replace('-', '');
  const rows = db.prepare('SELECT * FROM pairing_codes').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  for (const v of Object.values(rows[0]!)) assert.ok(!String(v).includes(plain) && !String(v).includes(code), '평문 코드가 저장되면 안 된다');
  assert.equal(rows[0]!.code_hash, createHash('sha256').update(plain).digest('hex'));
});

test('발급 후 10분이 지나면 만료되고, 한 번 쓰면 다시 쓸 수 없다', () => {
  const db = openDb(':memory:');
  const code = createPairingCode(db, 'iPhone', T0);
  expectHttp(() => redeemPairingCode(db, code, uuid(), { now: plus(T0, 10 * 60_000 + 1000) }), 400, 'invalid_code');

  const code2 = createPairingCode(db, 'iPad', T0);
  const ok = redeemPairingCode(db, code2, uuid(), { now: plus(T0, 9 * 60_000 + 59_000) });
  assert.equal(ok.deviceName, 'iPad');
  expectHttp(() => redeemPairingCode(db, code2, uuid(), { now: T0 }), 400, 'invalid_code'); // 1회용
});

test('코드는 대소문자·하이픈·공백 차이를 무시하고, 틀린 코드는 거부한다', () => {
  const db = openDb(':memory:');
  const code = createPairingCode(db, 'Mac', T0);
  const sloppy = ' ' + code.toLowerCase().replace('-', ' ') + ' ';
  assert.equal(redeemPairingCode(db, sloppy, uuid(), { now: T0 }).deviceName, 'Mac');
  expectHttp(() => redeemPairingCode(db, 'ZZZZ-ZZZZ', uuid(), { now: T0 }), 400, 'invalid_code');
});

test('세션 토큰은 256비트 랜덤이고 DB 에는 SHA-256(hex) 해시만 저장된다', () => {
  const db = openDb(':memory:');
  const id = uuid();
  const { token } = redeemPairingCode(db, createPairingCode(db, 'iPhone', T0), id, { now: T0 });
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(row.token_hash, hashToken(token));
  for (const v of Object.values(row)) assert.notEqual(v, token);
  assert.equal(row.name, 'iPhone');
  assert.equal(row.revoked_at, null);
});

test('deviceId 는 UUID 여야 하고 이미 등록된 값이면 거부한다', () => {
  const db = openDb(':memory:');
  expectHttp(() => redeemPairingCode(db, createPairingCode(db, 'a', T0), 'not-a-uuid', { now: T0 }), 400, 'invalid_device_id');
  const id = uuid();
  redeemPairingCode(db, createPairingCode(db, 'a', T0), id, { now: T0 });
  expectHttp(() => redeemPairingCode(db, createPairingCode(db, 'b', T0), id, { now: T0 }), 400, 'invalid_device_id');
});

test('실패가 1분에 5회를 넘으면 rate_limited, 1분이 지나면 다시 시도할 수 있다', () => {
  const db = openDb(':memory:');
  const limiter = new FailureLimiter(5, 60_000);
  for (let i = 0; i < 5; i++) expectHttp(() => redeemPairingCode(db, 'AAAA-AAAA', uuid(), { now: plus(T0, i * 1000), limiter }), 400, 'invalid_code');
  // 유효한 코드라도 제한 중에는 429
  const code = createPairingCode(db, 'iPhone', T0);
  expectHttp(() => redeemPairingCode(db, code, uuid(), { now: plus(T0, 10_000), limiter }), 429, 'rate_limited');
  // 1분 뒤에는 통과
  const ok = redeemPairingCode(db, code, uuid(), { now: plus(T0, 61_000 + 4000), limiter });
  assert.equal(ok.deviceName, 'iPhone');
});

test('authenticate: 활성 기기는 통과하고 last_seen_at 이 갱신된다. 해제된 기기·모르는 토큰은 실패', () => {
  const db = openDb(':memory:');
  const id = uuid();
  const { token } = redeemPairingCode(db, createPairingCode(db, 'iPhone', T0), id, { now: T0 });
  const t1 = plus(T0, 5000);
  const dev = authenticate(db, token, t1);
  assert.equal(dev?.id, id);
  assert.equal((db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(id) as { last_seen_at: string }).last_seen_at, t1.toISOString());
  assert.equal(authenticate(db, 'unknown-token', t1), null);
  assert.equal(authenticate(db, undefined, t1), null);

  assert.equal(revokeDevice(db, id, plus(T0, 9000)), true);
  assert.equal(authenticate(db, token, plus(T0, 10_000)), null, '해제된 기기');
  assert.equal(revokeDevice(db, uuid(), T0), false);
});

test('기기 이름은 1~50자', () => {
  const db = openDb(':memory:');
  assert.throws(() => createPairingCode(db, '', T0));
  assert.throws(() => createPairingCode(db, 'x'.repeat(51), T0));
  assert.ok(createPairingCode(db, 'x'.repeat(50), T0));
});
