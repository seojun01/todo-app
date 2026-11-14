import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createECDH, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushSender, createVapidJwt, decryptPayload, deriveEncryptionKeys, encryptPayload, isAllowedPushEndpoint, PUSH_TTL } from '../../src/webpush.ts';
import { loadOrCreateVapid } from '../../src/vapid.ts';
import { startFakePush } from '../helpers/fake-push-service.ts';

// RFC 8291 Appendix A 의 공식 테스트 벡터 (원문에서 프로그램으로 추출한 값)
const v = JSON.parse(readFileSync(new URL('../fixtures/rfc8291-appendix-a.json', import.meta.url), 'utf8')) as Record<string, string>;
const b = (s: string) => Buffer.from(s, 'base64url');

// ── 암호화: 공식 벡터 ──

test('RFC 8291 부록 A: 고정 키·salt 로 만든 중간 값(ECDH 비밀·IKM·CEK·nonce)이 모두 정확히 일치한다', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b(v.senderPrivate!));
  assert.equal(ecdh.getPublicKey().toString('base64url'), v.senderPublic, '보낸 쪽 개인키에서 나온 공개키');
  const shared = ecdh.computeSecret(b(v.receiverPublic!));
  assert.equal(shared.toString('base64url'), v.ecdhSecret);
  const k = deriveEncryptionKeys({ ecdhSecret: shared, uaPublic: b(v.receiverPublic!), asPublic: b(v.senderPublic!), authSecret: b(v.authSecret!), salt: b(v.salt!) });
  assert.equal(k.ikm.toString('base64url'), v.ikm);
  assert.equal(k.cek.toString('base64url'), v.cek);
  assert.equal(k.nonce.toString('base64url'), v.nonce);
});

test('RFC 8291 부록 A: 같은 입력이면 암호화한 본문이 공식 예제와 한 바이트도 다르지 않다', () => {
  const body = encryptPayload(Buffer.from(v.plaintextText!), { p256dh: v.receiverPublic!, auth: v.authSecret! }, { salt: b(v.salt!), senderPrivate: b(v.senderPrivate!) });
  assert.equal(body.subarray(0, 86).toString('base64url'), v.header, '86바이트 헤더(salt + 레코드 크기 4096 + 공개키)');
  assert.equal(body.subarray(86).toString('base64url'), v.ciphertext, 'AES-128-GCM 암호문 + 태그');
  assert.equal(body.toString('base64url'), v.body);
  // (RFC 본문의 "Content-Length: 145" 는 실제 본문 길이 144 와 1 어긋나는 원문 오류다: 헤더 86 + 암호문 58)
  assert.equal(body.length, 144);
});

test('RFC 8291 부록 A: 구독자의 개인키로 공식 예제 본문을 풀면 원문이 나온다', () => {
  const plain = decryptPayload(b(v.body!), b(v.receiverPrivate!), b(v.authSecret!));
  assert.equal(plain.toString('utf8'), v.plaintextText);
});

test('암호화 왕복: 무작위 키·salt 로도 복호화되고, 매번 본문이 다르며, 다른 키·변조는 거부된다', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const msg = Buffer.from(JSON.stringify({ v: 1, taskId: '00000000-0000-4000-8000-000000000001' }));
  const one = encryptPayload(msg, sub);
  const two = encryptPayload(msg, sub);
  assert.notDeepEqual(one, two, 'salt 와 보낸 쪽 키가 매번 달라진다');
  assert.deepEqual(decryptPayload(one, ua.getPrivateKey(), auth), msg);
  const other = createECDH('prime256v1');
  other.generateKeys();
  assert.throws(() => decryptPayload(one, other.getPrivateKey(), auth), '다른 개인키로는 풀리지 않는다');
  const tampered = Buffer.from(one);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => decryptPayload(tampered, ua.getPrivateKey(), auth), '변조하면 태그 검증에서 실패한다');
  assert.throws(() => decryptPayload(one, ua.getPrivateKey(), Buffer.from('fedcba9876543210')), '다른 auth 비밀로는 풀리지 않는다');
});

test('암호화 입력 검증: 잘못된 구독 키와 너무 긴 내용은 오류', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const good = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') };
  assert.throws(() => encryptPayload(Buffer.from('x'), { ...good, p256dh: 'AAAA' }), /p256dh/);
  assert.throws(() => encryptPayload(Buffer.from('x'), { ...good, auth: 'AAAA' }), /auth/);
  assert.throws(() => encryptPayload(Buffer.alloc(5000), good), /너무 길어요/);
  assert.doesNotThrow(() => encryptPayload(Buffer.alloc(4000), good));
});

// ── VAPID ──

test('VAPID JWT: ES256 서명이 공개키로 검증되고 aud·exp(24시간 이내)·sub 가 올바르다', () => {
  const vapid = loadOrCreateVapid(join(mkdtempSync(join(tmpdir(), 'vapid-')), 'vapid.json'));
  const now = 1_800_000_000;
  const jwt = createVapidJwt('https://web.push.apple.com', 'https://todo.home.arpa', vapid, now);
  const [h, p, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: now + 12 * 3600, sub: 'https://todo.home.arpa' });
  assert.ok(claims.exp - now <= 24 * 3600, 'exp 는 24시간을 넘기지 않는다');
  const sig = Buffer.from(s, 'base64url');
  assert.equal(sig.length, 64, 'JWS ES256 서명은 r||s 64바이트');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b(vapid.publicKey).subarray(1, 33).toString('base64url'), y: b(vapid.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), true);
  assert.equal(verify('sha256', Buffer.from(`${h}.${p}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), false, '내용이 바뀌면 검증 실패');
});

test('VAPID 키 파일: 처음엔 만들어 0600 으로 저장하고 이후에는 같은 키를 읽는다, 망가진 파일은 오류', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  const file = join(dir, 'sub', 'vapid.json'); // 폴더가 없어도 만든다
  const a = loadOrCreateVapid(file);
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(b(a.publicKey).length, 65);
  assert.equal(b(a.publicKey)[0], 0x04, '비압축 점');
  const again = loadOrCreateVapid(file);
  assert.equal(again.publicKey, a.publicKey, '서버를 다시 시작해도 같은 키');
  assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(a.publicKey), '공개키는 개인키에서 다시 계산하므로 따로 저장하지 않는다');

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{"privateJwk": {"kty": "EC"}}');
  assert.throws(() => loadOrCreateVapid(broken), /형식/);
  writeFileSync(broken, 'not json');
  assert.throws(() => loadOrCreateVapid(broken));
});

// ── 허용 endpoint (SSRF 방지) ──

test('허용 endpoint: 애플·구글·모질라·윈도 푸시 서비스의 https 주소만 통과한다', () => {
  for (const ok of [
    'https://web.push.apple.com/QGxx',
    'https://api.push.apple.com/3/device/abc',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://db5p.notify.windows.com/?token=abc',
  ]) assert.equal(isAllowedPushEndpoint(ok), true, ok);
  for (const bad of [
    'http://web.push.apple.com/x', // http
    'https://web.push.apple.com:8443/x', // 다른 포트
    'https://user:pw@web.push.apple.com/x', // 자격 증명
    'https://evil.example.com/x',
    'https://web.push.apple.com.evil.com/x', // 접미사만 닮은 주소
    'https://evilpush.apple.com.attacker.net/x',
    'https://xpush.apple.com/x', // .push.apple.com 이 아니다
    'https://notify.windows.com/x', // 하위 도메인이 아니다
    'https://fcm.googleapis.com.evil.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://169.254.169.254/latest/meta-data',
    'ftp://web.push.apple.com/x',
    'javascript:alert(1)',
    'not a url',
    '',
  ]) assert.equal(isAllowedPushEndpoint(bad), false, bad);
  // 테스트용 추가 호스트는 정확히 일치할 때만 (http 허용)
  assert.equal(isAllowedPushEndpoint('http://127.0.0.1:4567/push/1', ['127.0.0.1:4567']), true);
  assert.equal(isAllowedPushEndpoint('http://127.0.0.1:4568/push/1', ['127.0.0.1:4567']), false);
  assert.equal(isAllowedPushEndpoint('http://127.0.0.1:4567/push/1'), false);
});

// ── 전송 ──

async function setupSender(fakeStatus = 201) {
  const fake = await startFakePush();
  fake.setStatus(fakeStatus);
  const vapid = loadOrCreateVapid(join(mkdtempSync(join(tmpdir(), 'vapid-')), 'vapid.json'));
  const sender = createPushSender({ vapid, subject: 'https://todo.home.arpa', allowHosts: [fake.host], now: () => new Date('2026-11-13T09:00:00Z') });
  return { fake, vapid, sender };
}
const subOf = (s: { endpoint: string; keys: { p256dh: string; auth: string } }) => ({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });

test('전송: 헤더(TTL 900·Urgency high·aes128gcm·VAPID)가 맞고 본문은 구독자만 풀 수 있는 페이로드다', async () => {
  const { fake, vapid, sender } = await setupSender();
  try {
    const sub = fake.newSubscription();
    assert.equal(await sender.send(subOf(sub), { v: 1, taskId: 'abc' }), 'ok');
    assert.equal(fake.received.length, 1);
    const r = fake.received[0]!;
    assert.deepEqual(r.payload, { v: 1, taskId: 'abc' }, '가짜 서비스가 RFC 8291 대로 복호화한 평문');
    assert.equal(r.headers['content-encoding'], 'aes128gcm');
    assert.equal(r.headers.ttl, String(PUSH_TTL));
    assert.equal(PUSH_TTL, 900);
    assert.equal(r.headers.urgency, 'high');
    assert.equal(r.headers.topic, undefined, 'Topic 은 쓰지 않는다');
    const auth = String(r.headers.authorization);
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(auth);
    assert.ok(m, `Authorization 형식: ${auth}`);
    assert.equal(m![2], vapid.publicKey);
    const claims = JSON.parse(Buffer.from(m![1]!.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.aud, new URL(sub.endpoint).origin);
    assert.equal(claims.sub, 'https://todo.home.arpa');
    assert.equal(claims.exp, Math.floor(new Date('2026-11-13T09:00:00Z').getTime() / 1000) + 12 * 3600);
    // 본문에는 평문 내용이 보이지 않는다
    assert.ok(!r.rawBody.toString('latin1').includes('taskId'));
  } finally {
    await fake.close();
  }
});

test('전송: 응답 코드를 ok/gone/retry/fail 로 분류한다', async () => {
  const { fake, sender } = await setupSender();
  try {
    const sub = subOf(fake.newSubscription());
    const expectations: [number, string][] = [[200, 'ok'], [201, 'ok'], [202, 'ok'], [404, 'gone'], [410, 'gone'], [429, 'retry'], [500, 'retry'], [503, 'retry'], [408, 'retry'], [400, 'fail'], [401, 'fail'], [403, 'fail'], [413, 'fail']];
    for (const [code, expected] of expectations) {
      fake.setStatus(code);
      assert.equal(await sender.send(sub, { v: 1 }), expected, String(code));
    }
    // 모르는 구독(가짜 서비스가 404)도 gone
    fake.setStatus(201);
    assert.equal(await sender.send({ ...sub, endpoint: `http://${fake.host}/push/unknown` }, { v: 1 }), 'gone');
  } finally {
    await fake.close();
  }
});

test('전송: 허용되지 않은 endpoint 에는 요청을 보내지 않고, 잘못된 구독 키는 fail, 네트워크 오류는 retry', async () => {
  const { fake, vapid } = await setupSender();
  try {
    const calls: string[] = [];
    const spy: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 201 });
    };
    const sender = createPushSender({ vapid, subject: 'https://todo.home.arpa', fetch: spy, allowHosts: [fake.host] });
    const good = fake.newSubscription();
    for (const endpoint of ['https://evil.example.com/x', 'http://169.254.169.254/x', 'http://127.0.0.1:9/x', 'https://web.push.apple.com.evil.com/x']) {
      assert.equal(await sender.send({ endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth }, { v: 1 }), 'fail', endpoint);
    }
    assert.deepEqual(calls, [], '허용되지 않은 주소로는 요청이 나가지 않는다');
    assert.equal(await sender.send({ endpoint: good.endpoint, p256dh: 'AAAA', auth: good.keys.auth }, { v: 1 }), 'fail', '잘못된 키');
    assert.deepEqual(calls, [], '키가 잘못돼도 요청하지 않는다');

    const failing = createPushSender({ vapid, subject: 'https://todo.home.arpa', allowHosts: [fake.host], fetch: async () => { throw new TypeError('network'); } });
    assert.equal(await failing.send(subOf(good), { v: 1 }), 'retry');
  } finally {
    await fake.close();
  }
});

test('상세 전송: 푸시 서비스의 HTTP 상태 코드를 함께 돌려주고, 보내지 못했으면 코드가 없다', async () => {
  const { fake, vapid } = await setupSender();
  try {
    const sender = createPushSender({ vapid, subject: 'https://todo.home.arpa', allowHosts: [fake.host] });
    const sub = subOf(fake.newSubscription());
    for (const [code, result] of [[201, 'ok'], [410, 'gone'], [503, 'retry'], [403, 'fail']] as const) {
      fake.setStatus(code);
      assert.deepEqual(await sender.sendDetailed(sub, { v: 1 }), { result, status: code });
    }
    assert.deepEqual(await sender.sendDetailed({ ...sub, endpoint: 'https://evil.example.com/x' }, { v: 1 }), { result: 'fail' });
    const down = createPushSender({ vapid, subject: 'https://todo.home.arpa', allowHosts: [fake.host], fetch: async () => { throw new TypeError('network'); } });
    assert.deepEqual(await down.sendDetailed(sub, { v: 1 }), { result: 'retry' });
  } finally {
    await fake.close();
  }
});
