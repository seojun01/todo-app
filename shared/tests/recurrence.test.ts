import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, firstOccurrenceOnOrAfter, defaultRuleFor, describeRecurrence, upcomingOccurrences } from '../recurrence.ts';
import { addDays, daysInMonth, diffDays, parseDate, startOfWeek, weekday } from '../calendar.ts';
import type { Recurrence } from '../task.ts';

// 달력 기준: 2026-11-12 는 목요일. 월요일은 11-09, 11-16, 11-23 / 수 11-11, 11-18 / 금 11-13, 11-20 / 일 11-08, 11-15, 11-22
const day = (interval: number, endDate?: string): Recurrence => ({ unit: 'day', interval, ...(endDate ? { endDate } : {}) });
const week = (weekdays: number[], interval = 1, endDate?: string): Recurrence => ({ unit: 'week', interval, weekdays, ...(endDate ? { endDate } : {}) });
const month = (dayOfMonth: number, interval = 1): Recurrence => ({ unit: 'month', interval, dayOfMonth });
const year = (m: number, dayOfMonth: number, interval = 1): Recurrence => ({ unit: 'year', interval, month: m, dayOfMonth });

test('일 단위: 기한 + N일, 완료한 날이 기한보다 늦으면 오늘 이후의 첫 일정일 (FR-018)', () => {
  assert.equal(nextOccurrence(day(1), '2026-11-12', '2026-11-12'), '2026-11-13');
  assert.equal(nextOccurrence(day(3), '2026-11-12', '2026-11-12'), '2026-11-15');
  assert.equal(nextOccurrence(day(3), '2026-11-12', '2026-11-10'), '2026-11-15', '일찍 완료해도 기한 기준');
  // 사흘 전이 기한인 매일 반복을 오늘 완료하면 내일 (지난 회차를 하나씩 거치지 않는다)
  assert.equal(nextOccurrence(day(1), '2026-11-09', '2026-11-12'), '2026-11-13');
  // 2일마다: 일정은 11-01, 03, 05, 07, 09, 11, 13 → 11-12 이후 첫 일정일은 11-13
  assert.equal(nextOccurrence(day(2), '2026-11-01', '2026-11-12'), '2026-11-13');
  // 일정일 당일에 완료하면 그다음
  assert.equal(nextOccurrence(day(2), '2026-11-01', '2026-11-13'), '2026-11-15');
});

test('주 단위: 선택한 요일 중 기준일 이후 첫 날', () => {
  const mon = week([1]);
  assert.equal(nextOccurrence(mon, '2026-11-09', '2026-11-09'), '2026-11-16', '매주 월요일을 월요일에 완료');
  assert.equal(nextOccurrence(mon, '2026-11-09', '2026-11-11'), '2026-11-16', '수요일에 완료해도 다음 월요일');
  assert.equal(nextOccurrence(mon, '2026-11-16', '2026-11-12'), '2026-11-23', '미리 완료해도 기한(다음 월요일) 다음 회차로 넘어간다');
  const mwf = week([1, 3, 5]);
  assert.equal(nextOccurrence(mwf, '2026-11-09', '2026-11-09'), '2026-11-11');
  assert.equal(nextOccurrence(mwf, '2026-11-11', '2026-11-11'), '2026-11-13');
  assert.equal(nextOccurrence(mwf, '2026-11-13', '2026-11-13'), '2026-11-16');
  assert.equal(nextOccurrence(week([0]), '2026-11-15', '2026-11-15'), '2026-11-22', '일요일');
  assert.equal(nextOccurrence(week([6]), '2026-11-14', '2026-11-14'), '2026-11-21', '토요일(주의 경계)');
});

test('주 단위 N>1: 기준 주(기한이 속한 일요일 시작 주)에서 N주 간격', () => {
  const biweekly = week([1, 3], 2);
  assert.equal(nextOccurrence(biweekly, '2026-11-09', '2026-11-09'), '2026-11-11', '같은 주의 수요일');
  assert.equal(nextOccurrence(biweekly, '2026-11-11', '2026-11-11'), '2026-11-23', '2주 뒤 월요일');
  assert.equal(nextOccurrence(biweekly, '2026-11-23', '2026-11-23'), '2026-11-25');
  assert.equal(nextOccurrence(week([1], 3), '2026-11-09', '2026-11-09'), '2026-11-30', '3주마다 월요일');
});

test('월 단위: 말일 보정과 원래 일정(dayOfMonth)에서 재계산 (FR-019)', () => {
  assert.equal(nextOccurrence(month(15), '2026-11-15', '2026-11-15'), '2026-12-15');
  assert.equal(nextOccurrence(month(15), '2026-12-15', '2026-12-15'), '2027-01-15', '연 경계');
  assert.equal(nextOccurrence(month(31), '2026-01-31', '2026-01-31'), '2026-02-28', '31일이 없는 달은 마지막 날');
  assert.equal(nextOccurrence(month(31), '2026-02-28', '2026-02-28'), '2026-03-31', '다음 달에는 다시 31일');
  assert.equal(nextOccurrence(month(31), '2026-03-31', '2026-03-31'), '2026-04-30');
  assert.equal(nextOccurrence(month(31), '2028-01-31', '2028-01-31'), '2028-02-29', '윤년 2월');
  assert.equal(nextOccurrence(month(20, 2), '2026-11-20', '2026-11-20'), '2027-01-20', '2개월마다');
  assert.equal(nextOccurrence(month(15), '2026-09-15', '2026-11-12'), '2026-11-15', '연체 후 완료: 오늘 이후 첫 일정일');
  assert.equal(nextOccurrence(month(31), '2026-01-31', '2026-11-12'), '2026-11-30', '말일 보정 + 연체');
});

test('연 단위: 평년의 2/29 는 2/28', () => {
  assert.equal(nextOccurrence(year(11, 20), '2026-11-20', '2026-11-20'), '2027-11-20');
  assert.equal(nextOccurrence(year(2, 29), '2028-02-29', '2028-02-29'), '2029-02-28');
  assert.equal(nextOccurrence(year(2, 29), '2029-02-28', '2029-02-28'), '2030-02-28');
  assert.equal(nextOccurrence(year(2, 29, 4), '2028-02-29', '2028-02-29'), '2032-02-29', '4년마다는 윤년으로 돌아온다');
  assert.equal(nextOccurrence(year(11, 20, 2), '2026-11-20', '2026-11-20'), '2028-11-20');
});

test('종료 날짜를 넘기는 결과는 null (마지막 회차)', () => {
  assert.equal(nextOccurrence(day(1, '2026-11-13'), '2026-11-12', '2026-11-12'), '2026-11-13', '종료 날짜 당일은 포함');
  assert.equal(nextOccurrence(day(1, '2026-11-13'), '2026-11-13', '2026-11-13'), null);
  assert.equal(nextOccurrence(week([1], 1, '2026-11-20'), '2026-11-16', '2026-11-16'), null);
  assert.equal(nextOccurrence(day(1, '2026-11-13'), '2026-11-12', '2026-11-20'), null, '완료가 종료 날짜 뒤여도 null');
});

// ── 속성 기반: 독립적인 판정 함수로 결과가 "규칙에 맞는 가장 이른 날"인지 확인 ──
function matches(rule: Recurrence, anchor: string, d: string): boolean {
  const a = parseDate(anchor);
  const x = parseDate(d);
  switch (rule.unit) {
    case 'day':
      return diffDays(anchor, d) >= 0 && diffDays(anchor, d) % rule.interval === 0;
    case 'week': {
      const weeks = diffDays(startOfWeek(anchor), startOfWeek(d)) / 7;
      return weeks >= 0 && weeks % rule.interval === 0 && rule.weekdays!.includes(weekday(d));
    }
    case 'month': {
      const months = (x.y - a.y) * 12 + (x.m - a.m);
      return months >= 0 && months % rule.interval === 0 && x.d === Math.min(rule.dayOfMonth!, daysInMonth(x.y, x.m));
    }
    case 'year': {
      const years = x.y - a.y;
      return years >= 0 && years % rule.interval === 0 && x.m === rule.month && x.d === Math.min(rule.dayOfMonth!, daysInMonth(x.y, x.m));
    }
  }
}

test('속성: 결과는 ref 보다 뒤이고 규칙에 맞는 가장 이른 날이며 같은 입력엔 같은 출력', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (let i = 0; i < 400; i++) {
    const due = addDays('2026-01-01', rnd(900));
    const completed = addDays(due, rnd(60) - 20);
    const unit = (['day', 'week', 'month', 'year'] as const)[rnd(4)]!;
    const interval = 1 + rnd(unit === 'day' ? 10 : unit === 'week' ? 4 : unit === 'month' ? 6 : 3);
    let rule: Recurrence;
    if (unit === 'day') rule = day(interval);
    else if (unit === 'week') rule = week([...new Set([rnd(7), rnd(7)])].sort(), interval);
    else if (unit === 'month') rule = month(1 + rnd(31), interval);
    else rule = year(1 + rnd(12), 1 + rnd(28), interval);

    // 기준일(anchor)이 규칙에 맞지 않으면 의미가 다르므로, 규칙에 맞는 날로 맞춘 뒤 검사한다
    const anchor = firstOccurrenceOnOrAfter(rule, due);
    const ref = anchor > completed ? anchor : completed;
    const next = nextOccurrence(rule, anchor, completed)!;
    assert.ok(next > ref, `${JSON.stringify(rule)} ${anchor} ${completed}: 결과가 ref 보다 뒤여야 한다`);
    assert.ok(matches(rule, anchor, next), `${JSON.stringify(rule)} ${anchor} → ${next} 가 규칙에 맞아야 한다`);
    for (let d = addDays(ref, 1); d < next; d = addDays(d, 1)) assert.ok(!matches(rule, anchor, d), `${JSON.stringify(rule)} ${anchor}: ${d} 가 더 이른 일정일이다 (결과 ${next})`);
    assert.equal(nextOccurrence(rule, anchor, completed), next);
  }
});

test('firstOccurrenceOnOrAfter: 기한이 이미 규칙에 맞으면 그대로, 아니면 기한 이후 첫 일정일 (FR-017)', () => {
  assert.equal(firstOccurrenceOnOrAfter(day(3), '2026-11-12'), '2026-11-12', '일 단위는 기한이 곧 기준');
  assert.equal(firstOccurrenceOnOrAfter(week([1]), '2026-11-09'), '2026-11-09', '이미 월요일');
  assert.equal(firstOccurrenceOnOrAfter(week([1]), '2026-11-11'), '2026-11-16', '수요일이면 다음 월요일');
  assert.equal(firstOccurrenceOnOrAfter(week([1]), '2026-11-15'), '2026-11-16', '일요일이면 바로 다음 날');
  assert.equal(firstOccurrenceOnOrAfter(week([1, 3, 5]), '2026-11-12'), '2026-11-13', '목요일이면 금요일');
  assert.equal(firstOccurrenceOnOrAfter(week([1], 2), '2026-11-11'), '2026-11-23', '2주마다: 기준 주의 월요일은 이미 지났으므로 2주 뒤');
  assert.equal(firstOccurrenceOnOrAfter(month(31), '2026-11-20'), '2026-11-30', '말일 보정');
  assert.equal(firstOccurrenceOnOrAfter(month(15), '2026-11-20'), '2026-12-15');
  assert.equal(firstOccurrenceOnOrAfter(month(20), '2026-11-20'), '2026-11-20');
  assert.equal(firstOccurrenceOnOrAfter(year(11, 20), '2026-11-20'), '2026-11-20');
  assert.equal(firstOccurrenceOnOrAfter(year(11, 20), '2026-11-21'), '2027-11-20');
  assert.equal(firstOccurrenceOnOrAfter(year(2, 29), '2026-03-01'), '2027-02-28');
});

test('defaultRuleFor: 처음 지정할 때 기한에서 기본값을 가져온다', () => {
  assert.deepEqual(defaultRuleFor('2026-11-12', 'day'), { unit: 'day', interval: 1 });
  assert.deepEqual(defaultRuleFor('2026-11-12', 'week'), { unit: 'week', interval: 1, weekdays: [4] }); // 목요일
  assert.deepEqual(defaultRuleFor('2026-11-20', 'month'), { unit: 'month', interval: 1, dayOfMonth: 20 });
  assert.deepEqual(defaultRuleFor('2026-11-20', 'year'), { unit: 'year', interval: 1, month: 11, dayOfMonth: 20 });
});

test('describeRecurrence: 한국어로 규칙을 설명한다', () => {
  assert.equal(describeRecurrence(day(1)), '매일');
  assert.equal(describeRecurrence(day(3)), '3일마다');
  assert.equal(describeRecurrence(week([1])), '매주 월요일');
  assert.equal(describeRecurrence(week([1, 3, 5])), '매주 월·수·금');
  assert.equal(describeRecurrence(week([1], 2)), '2주마다 월요일');
  assert.equal(describeRecurrence(month(15)), '매월 15일');
  assert.equal(describeRecurrence(month(31, 2)), '2개월마다 31일');
  assert.equal(describeRecurrence(year(11, 20)), '매년 11월 20일');
  assert.equal(describeRecurrence(day(1, '2026-11-30')), '매일 (2026-11-30까지)');
});

// ── 미리 보여 주는 앞으로의 회차 (가상 회차) ──

test('앞으로의 회차: 매일은 기한 다음 날부터 범위 끝까지, 기한 자체는 포함하지 않는다', () => {
  assert.deepEqual(upcomingOccurrences(day(1), '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-16'), ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
  assert.deepEqual(upcomingOccurrences(day(3), '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-25'), ['2026-11-15', '2026-11-18', '2026-11-21', '2026-11-24']);
});

test('앞으로의 회차: from 보다 앞은 버리고, to 를 넘으면 멈춘다', () => {
  assert.deepEqual(upcomingOccurrences(day(1), '2026-11-12', '2026-11-12', '2026-11-15', '2026-11-16'), ['2026-11-15', '2026-11-16']);
  assert.deepEqual(upcomingOccurrences(day(1), '2026-11-12', '2026-11-12', '2026-12-01', '2026-11-30'), []);
  assert.deepEqual(upcomingOccurrences(day(1), '2026-11-20', '2026-11-12', '2026-11-12', '2026-11-19'), [], '기한이 범위보다 뒤면 회차도 없다');
});

test('앞으로의 회차: 주 단위는 선택한 요일마다, N주마다는 건너뛴다', () => {
  // 목요일(11-12) 기한, 매주 월·수·목 → 다음은 월 11-16, 수 11-18, 목 11-19, 월 11-23 …
  assert.deepEqual(upcomingOccurrences(week([1, 3, 4]), '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-24'), ['2026-11-16', '2026-11-18', '2026-11-19', '2026-11-23']);
  // 2주마다 월·수·목: 같은 주에 남은 요일이 없으면 2주 뒤 월요일부터
  assert.deepEqual(upcomingOccurrences(week([1, 3, 4], 2), '2026-11-12', '2026-11-12', '2026-11-12', '2026-12-05'), ['2026-11-23', '2026-11-25', '2026-11-26', '2026-12-07'].filter((d) => d <= '2026-12-05'));
});

test('앞으로의 회차: 매월 31일은 말일로 맞추고 다음 달에는 다시 31일, 종료 날짜를 넘지 않는다', () => {
  assert.deepEqual(upcomingOccurrences(month(31), '2026-10-31', '2026-10-31', '2026-10-31', '2027-02-28'), ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  assert.deepEqual(upcomingOccurrences(day(1, '2026-11-14'), '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-30'), ['2026-11-13', '2026-11-14'], '종료 날짜까지만');
  assert.deepEqual(upcomingOccurrences(day(1, '2026-11-12'), '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-30'), [], '종료 날짜가 기한이면 더 없다');
});

test('앞으로의 회차: 기한이 지난 반복은 오늘 이후부터 센다 (완료하면 오늘 이후 첫 일정일로 넘어가므로)', () => {
  // 사흘 전(11-09) 기한의 매일 반복, 오늘 11-12 → 완료하면 11-13
  assert.deepEqual(upcomingOccurrences(day(1), '2026-11-09', '2026-11-12', '2026-11-01', '2026-11-15'), ['2026-11-13', '2026-11-14', '2026-11-15']);
});

test('앞으로의 회차: 하나씩 실제로 완료했을 때의 기한 이동과 항상 같은 날짜열이다 (모든 단위)', () => {
  const cases: [string, Recurrence, string][] = [
    ['매일', day(1), '2026-11-12'],
    ['3일마다', day(3), '2026-11-12'],
    ['매주 월수목', week([1, 3, 4]), '2026-11-12'],
    ['2주마다 월수목', week([1, 3, 4], 2), '2026-11-12'],
    ['3주마다 일', week([0], 3), '2026-11-15'],
    ['매월 31일', month(31), '2026-10-31'],
    ['2개월마다 15일', month(15, 2), '2026-11-15'],
    ['매년 2월 29일', year(2, 29), '2028-02-29'],
    ['매년 11월 12일', year(11, 12), '2026-11-12'],
  ];
  for (const [name, rule, due] of cases) {
    const to = addDays(due, 900);
    const predicted = upcomingOccurrences(rule, due, due, due, to);
    // 실제 흐름: 기한 당일에 완료 → 다음 기한 → 또 그날 완료 …
    const actual: string[] = [];
    for (let cur = nextOccurrence(rule, due, due); cur !== null && cur <= to; cur = nextOccurrence(rule, cur, cur)) actual.push(cur);
    assert.equal(predicted.length, Math.min(actual.length, 400), `${name}: 안전 한도(400)까지는 빠짐없이`);
    assert.deepEqual(predicted, actual.slice(0, predicted.length), name);
    assert.ok(predicted.length > 0, `${name}: 회차가 있어야 한다`);
    assert.ok(predicted.every((d, i) => i === 0 || d > predicted[i - 1]!), `${name}: 항상 앞으로 나아간다`);
  }
});

test('앞으로의 회차: 매일 반복을 10년 범위로 불러도 빠르게 끝나고 개수 한도를 넘지 않는다', () => {
  const t = Date.now();
  const out = upcomingOccurrences(day(1), '2026-11-12', '2026-11-12', '2026-11-12', '2036-11-12');
  assert.equal(out.length, 400, '안전 한도');
  assert.ok(Date.now() - t < 500);
});
