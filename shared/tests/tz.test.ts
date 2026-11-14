import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimeZone, offsetMinutes, wallTimeToInstant } from '../tz.ts';

const iso = (d: Date) => d.toISOString();

test('서울(서머타임 없음): 벽시계 시각 − 9시간', () => {
  assert.equal(iso(wallTimeToInstant('2026-11-12', '15:00', 'Asia/Seoul')), '2026-11-12T06:00:00.000Z');
  assert.equal(iso(wallTimeToInstant('2026-11-12', '00:00', 'Asia/Seoul')), '2026-11-11T15:00:00.000Z', '날짜가 하루 앞으로 넘어간다');
  assert.equal(iso(wallTimeToInstant('2026-12-31', '23:59', 'Asia/Seoul')), '2026-12-31T14:59:00.000Z');
  assert.equal(offsetMinutes(Date.UTC(2026, 10, 12), 'Asia/Seoul'), 540);
});

test('30분 단위 오프셋(인도) 과 UTC', () => {
  assert.equal(iso(wallTimeToInstant('2026-11-12', '10:00', 'Asia/Kolkata')), '2026-11-12T04:30:00.000Z');
  assert.equal(iso(wallTimeToInstant('2026-11-12', '10:00', 'UTC')), '2026-11-12T10:00:00.000Z');
});

test('뉴욕: 서머타임 전후의 평범한 시각', () => {
  assert.equal(iso(wallTimeToInstant('2026-01-15', '09:00', 'America/New_York')), '2026-01-15T14:00:00.000Z', '겨울 EST(-5)');
  assert.equal(iso(wallTimeToInstant('2026-07-15', '09:00', 'America/New_York')), '2026-07-15T13:00:00.000Z', '여름 EDT(-4)');
  // 2026-03-08 02:00 에 서머타임 시작
  assert.equal(iso(wallTimeToInstant('2026-03-08', '01:30', 'America/New_York')), '2026-03-08T06:30:00.000Z', '전환 직전 EST');
  assert.equal(iso(wallTimeToInstant('2026-03-08', '03:30', 'America/New_York')), '2026-03-08T07:30:00.000Z', '전환 직후 EDT');
  // 2026-11-01 02:00 에 서머타임 끝
  assert.equal(iso(wallTimeToInstant('2026-11-01', '00:30', 'America/New_York')), '2026-11-01T04:30:00.000Z', 'EDT');
  assert.equal(iso(wallTimeToInstant('2026-11-01', '02:30', 'America/New_York')), '2026-11-01T07:30:00.000Z', 'EST');
});

test('봄에 건너뛴 시각은 건너뛴 직후(전환이 일어나는 순간)로 정한다', () => {
  // 2026-03-08 02:00~03:00 은 존재하지 않는다 → 03:00 EDT = 07:00Z
  for (const t of ['02:00', '02:15', '02:30', '02:59']) {
    assert.equal(iso(wallTimeToInstant('2026-03-08', t, 'America/New_York')), '2026-03-08T07:00:00.000Z', t);
  }
  // 유럽: 2026-03-29 01:00 UTC 에 전환 (런던 01:00→02:00)
  assert.equal(iso(wallTimeToInstant('2026-03-29', '01:30', 'Europe/London')), '2026-03-29T01:00:00.000Z');
});

test('가을에 두 번 있는 시각은 이른 쪽으로 정한다', () => {
  // 2026-11-01 01:00~02:00 이 두 번(EDT 먼저, EST 나중): 이른 쪽 = EDT
  assert.equal(iso(wallTimeToInstant('2026-11-01', '01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(wallTimeToInstant('2026-11-01', '01:00', 'America/New_York')), '2026-11-01T05:00:00.000Z');
  // 런던: 2026-10-25 02:00 BST → 01:00 GMT, 01:30 이 두 번
  assert.equal(iso(wallTimeToInstant('2026-10-25', '01:30', 'Europe/London')), '2026-10-25T00:30:00.000Z');
});

test('결과를 다시 그 시간대의 벽시계로 보면 입력과 같다 (존재하는 시각에 한해, 여러 시간대·날짜)', () => {
  const fmt = (d: Date, tz: string) =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(',', '');
  for (const tz of ['Asia/Seoul', 'America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'Pacific/Auckland']) {
    for (const date of ['2026-01-10', '2026-04-05', '2026-07-20', '2026-10-04', '2026-11-12', '2026-12-25']) {
      for (const time of ['00:00', '05:45', '09:00', '12:30', '18:15', '23:59']) {
        assert.equal(fmt(wallTimeToInstant(date, time, tz), tz), `${date} ${time}`, `${tz} ${date} ${time}`);
      }
    }
  }
});

test('잘못된 시간대는 오류, isValidTimeZone 은 IANA 이름만 통과시킨다', () => {
  assert.throws(() => wallTimeToInstant('2026-11-12', '15:00', 'Not/AZone'), RangeError);
  for (const ok of ['Asia/Seoul', 'UTC', 'America/New_York', 'Europe/London']) assert.equal(isValidTimeZone(ok), true, ok);
  for (const bad of ['', 'Seoul', 'Not/AZone', 'x'.repeat(100), 5, null, undefined, {}]) assert.equal(isValidTimeZone(bad), false, String(bad));
});

test('같은 입력은 항상 같은 출력이다', () => {
  const a = wallTimeToInstant('2026-03-08', '02:30', 'America/New_York').getTime();
  for (let i = 0; i < 20; i++) assert.equal(wallTimeToInstant('2026-03-08', '02:30', 'America/New_York').getTime(), a);
});
