import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, daysInMonth, diffDays, isLeapYear, monthGrid, toDateString, weekday, startOfWeek, compareDates } from '../calendar.ts';

test('윤년과 월별 일수', () => {
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2100), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2026, 1), 31);
  assert.equal(daysInMonth(2026, 11), 30);
});

test('weekday: 0=일요일', () => {
  assert.equal(weekday('2026-11-12'), 4); // 2026-11-12 는 목요일
  assert.equal(weekday('2026-11-15'), 0); // 일요일
  assert.equal(weekday('2026-11-14'), 6); // 토요일
});

test('월 격자는 일요일에 시작하고 항상 7의 배수 칸이다', () => {
  const cases: [number, number][] = [
    [2026, 11], // 1일이 일요일
    [2026, 8], // 1일이 토요일
    [2028, 2], // 윤년 2월
    [2026, 2], // 평년 2월 (1일 일요일, 28일 → 4주)
    [2026, 12],
    [2027, 1],
  ];
  for (const [y, m] of cases) {
    const grid = monthGrid(y, m);
    assert.equal(grid.length % 7, 0, `${y}-${m}`);
    assert.equal(weekday(grid[0]!), 0, `${y}-${m} 첫 칸은 일요일`);
    assert.ok(grid.length >= 28 && grid.length <= 42);
    // 해당 월의 모든 날이 들어 있다
    const inMonth = grid.filter((d) => d.startsWith(`${y}-${String(m).padStart(2, '0')}-`));
    assert.equal(inMonth.length, daysInMonth(y, m));
  }
  assert.equal(monthGrid(2026, 11)[0], '2026-11-01'); // 1일이 일요일이면 그날부터
  assert.equal(monthGrid(2026, 8)[0], '2026-07-26'); // 1일이 토요일이면 앞 달 일요일부터
  assert.equal(monthGrid(2026, 2).length, 28);
});

test('addDays: 월·연 경계', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-11-20', 0), '2026-11-20');
  assert.equal(addDays('2026-11-20', 400), '2027-12-25');
});

test('addMonths: 말일은 그 달 마지막 날로 맞춘다', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-20', 1), '2026-12-20');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-11-20', 12), '2027-11-20');
});

test('diffDays: 서머타임과 무관하게 정수 일수', () => {
  assert.equal(diffDays('2026-11-20', '2026-11-27'), 7);
  assert.equal(diffDays('2026-11-27', '2026-11-20'), -7);
  assert.equal(diffDays('2026-03-07', '2026-03-09'), 2); // 미국 서머타임 시작 주
  assert.equal(diffDays('2026-10-30', '2026-11-02'), 3);
  assert.equal(diffDays('2026-11-20', '2026-11-20'), 0);
});

test('toDateString: Date 의 로컬 날짜를 쓴다', () => {
  assert.equal(toDateString(new Date(2026, 10, 20, 23, 59, 59)), '2026-11-20');
  assert.equal(toDateString(new Date(2026, 10, 21, 0, 0, 0)), '2026-11-21');
  assert.equal(toDateString(new Date(2026, 0, 5, 12)), '2026-01-05');
});

test('startOfWeek / compareDates', () => {
  assert.equal(startOfWeek('2026-11-12'), '2026-11-08'); // 목요일 → 그 주 일요일
  assert.equal(startOfWeek('2026-11-08'), '2026-11-08');
  assert.ok(compareDates('2026-11-01', '2026-11-02') < 0);
  assert.equal(compareDates('2026-11-01', '2026-11-01'), 0);
});
