import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc, parseHlc } from '../hlc.ts';

const FORMAT = /^\d{15}-\d{6}-.+$/;

test('Hlc 형식은 <wallMs 15자리>-<counter 6자리>-<deviceId>', () => {
  const h = createHlc('dev-a', { now: () => 1762950896789 });
  const v = h.next();
  assert.match(v, FORMAT);
  assert.equal(v, '001762950896789-000000-dev-a');
  assert.deepEqual(parseHlc(v), { wallMs: 1762950896789, counter: 0, deviceId: 'dev-a' });
});

test('문자열 비교 순서가 발급 순서와 같다', () => {
  let t = 1000;
  const h = createHlc('dev-a', { now: () => t });
  const out: string[] = [];
  for (let i = 0; i < 30; i++) {
    if (i % 7 === 0) t += 5; // 가끔 시간이 흐르고
    out.push(h.next()); // 대부분은 같은 밀리초
  }
  const sorted = [...out].sort();
  assert.deepEqual(out, sorted);
  assert.equal(new Set(out).size, out.length);
});

test('같은 밀리초에 여러 번 발급하면 counter 가 증가한다', () => {
  const h = createHlc('d', { now: () => 5000 });
  assert.equal(parseHlc(h.next())!.counter, 0);
  assert.equal(parseHlc(h.next())!.counter, 1);
  assert.equal(parseHlc(h.next())!.counter, 2);
});

test('시계가 뒤로 가도 값이 줄지 않는다', () => {
  let t = 9000;
  const h = createHlc('d', { now: () => t });
  const a = h.next();
  t = 1000; // 시계가 크게 뒤로 감
  const b = h.next();
  const c = h.next();
  assert.ok(a < b && b < c);
  assert.equal(parseHlc(b)!.wallMs, 9000);
});

test('receive: 원격 값을 받으면 로컬 값이 그보다 커진다', () => {
  const h = createHlc('local', { now: () => 1000 });
  const remote = '000000000005000-000003-remote';
  const r = h.receive(remote);
  assert.ok(r > remote);
  const next = h.next();
  assert.ok(next > r);
  assert.ok(next > remote);
});

test('receive: 원격이 과거여도 로컬 값은 줄지 않는다', () => {
  const h = createHlc('local', { now: () => 5000 });
  const before = h.next();
  const r = h.receive('000000000001000-000000-remote');
  assert.ok(r > before);
});

test('서로 다른 deviceId 로 발급한 값은 절대 같지 않다', () => {
  const a = createHlc('device-a', { now: () => 7000 });
  const b = createHlc('device-b', { now: () => 7000 });
  for (let i = 0; i < 20; i++) assert.notEqual(a.next(), b.next());
});

test('상태를 저장했다가 복원하면 이어서 증가한다', () => {
  const h1 = createHlc('d', { now: () => 3000 });
  h1.next();
  const last = h1.next();
  const h2 = createHlc('d', { now: () => 3000, state: h1.state() });
  assert.ok(h2.next() > last);
});

test('parseHlc: 잘못된 값은 null', () => {
  assert.equal(parseHlc('nope'), null);
  assert.equal(parseHlc('123-1-x'), null);
});
