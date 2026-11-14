import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueKey, isKindAllowed, isReminderInPast, reminderInstant, remapReminders, shouldFire, LATE_LIMIT_MS } from '../reminders.ts';
import type { ReminderKind } from '../task.ts';

const SEOUL = 'Asia/Seoul';
const settings = { defaultReminderTime: '09:00' };
const iso = (d: Date | null) => d?.toISOString() ?? null;
const timed = { dueDate: '2026-11-20', dueTime: '15:00' };
const dateOnly = { dueDate: '2026-11-20', dueTime: null };

test('발화 시각: 시각이 있는 할 일 (정시·10분·30분·1시간·하루 전)', () => {
  // 서울 15:00 = 06:00Z
  assert.equal(iso(reminderInstant(timed, 'at', settings, SEOUL)), '2026-11-20T06:00:00.000Z');
  assert.equal(iso(reminderInstant(timed, '10m', settings, SEOUL)), '2026-11-20T05:50:00.000Z');
  assert.equal(iso(reminderInstant(timed, '30m', settings, SEOUL)), '2026-11-20T05:30:00.000Z');
  assert.equal(iso(reminderInstant(timed, '1h', settings, SEOUL)), '2026-11-20T05:00:00.000Z');
  assert.equal(iso(reminderInstant(timed, '1d', settings, SEOUL)), '2026-11-19T06:00:00.000Z', '하루 전 같은 시각');
});

test('발화 시각: 시각이 없는 할 일은 기본 알림 시각을 쓴다 (당일·하루 전)', () => {
  assert.equal(iso(reminderInstant(dateOnly, 'day', settings, SEOUL)), '2026-11-20T00:00:00.000Z', '당일 09:00 서울');
  assert.equal(iso(reminderInstant(dateOnly, '1d', settings, SEOUL)), '2026-11-19T00:00:00.000Z', '하루 전 09:00');
  assert.equal(iso(reminderInstant(dateOnly, 'day', { defaultReminderTime: '07:45' }, SEOUL)), '2026-11-19T22:45:00.000Z', '설정에서 바꾼 기본 시각');
  assert.equal(iso(reminderInstant(dateOnly, 'day', null, SEOUL)), '2026-11-20T00:00:00.000Z', '설정이 없으면 09:00');
  assert.equal(iso(reminderInstant(dateOnly, 'day', {}, SEOUL)), '2026-11-20T00:00:00.000Z');
});

test('발화 시각: 쓸 수 없는 종류나 기한 없음은 null', () => {
  for (const k of ['at', '10m', '30m', '1h'] as ReminderKind[]) assert.equal(reminderInstant(dateOnly, k, settings, SEOUL), null, `시각 없는데 ${k}`);
  assert.equal(reminderInstant(timed, 'day', settings, SEOUL), null, '시각 있는데 당일');
  for (const k of ['at', '1d', 'day'] as ReminderKind[]) assert.equal(reminderInstant({ dueDate: null, dueTime: null }, k, settings, SEOUL), null, `기한 없는데 ${k}`);
});

test('발화 시각은 기기 시간대를 따른다 (같은 할 일이 시간대마다 다른 순간)', () => {
  assert.equal(iso(reminderInstant(timed, 'at', settings, 'America/New_York')), '2026-11-20T20:00:00.000Z');
  assert.equal(iso(reminderInstant(timed, 'at', settings, 'UTC')), '2026-11-20T15:00:00.000Z');
});

test('shouldFire: 설정한 뒤의 시각이고, 이미 지났고, 15분 이내일 때만 참', () => {
  const fire = new Date('2026-11-20T06:00:00Z');
  const armed = new Date('2026-11-20T00:00:00Z');
  const at = (min: number) => new Date(fire.getTime() + min * 60_000);
  assert.equal(shouldFire(fire, armed, at(-1)), false, '아직 안 됐다');
  assert.equal(shouldFire(fire, armed, at(0)), true, '정각');
  assert.equal(shouldFire(fire, armed, at(10)), true);
  assert.equal(shouldFire(fire, armed, at(15)), true, '15분 딱');
  assert.equal(shouldFire(fire, armed, new Date(fire.getTime() + LATE_LIMIT_MS + 1)), false, '15분을 넘기면 건너뛴다');
  // 이미 지난 시각이었던 알림(설정한 뒤에 정한 것): armedAt >= fire
  assert.equal(shouldFire(fire, at(1), at(2)), false, '설정할 때 이미 지난 시각');
  assert.equal(shouldFire(fire, fire, at(2)), false, '같은 순간에 설정한 것도 울리지 않는다');
  assert.equal(shouldFire(fire, new Date(fire.getTime() - 1), at(2)), true, '바로 직전에 설정했다면 울린다');
});

test('isReminderInPast: 편집 중 "이미 지난 알림" 판정', () => {
  const now = new Date('2026-11-20T05:40:00Z'); // 서울 14:40
  assert.equal(isReminderInPast(timed, 'at', settings, SEOUL, now), false, '정시 15:00 은 아직');
  assert.equal(isReminderInPast(timed, '30m', settings, SEOUL, now), true, '30분 전 14:30 은 지났다');
  assert.equal(isReminderInPast(timed, '1h', settings, SEOUL, now), true);
  assert.equal(isReminderInPast(dateOnly, 'day', settings, SEOUL, now), true, '당일 09:00 은 지났다');
  assert.equal(isReminderInPast({ dueDate: '2026-11-21', dueTime: null }, 'day', settings, SEOUL, now), false);
  assert.equal(isReminderInPast(dateOnly, 'at', settings, SEOUL, now), false, '쓸 수 없는 종류는 지난 것이 아니다');
});

test('remapReminders: 시각을 더하면 당일→정시(하루 전 유지), 없애면 시각 기준 알림이 빠진다 (빠진 개수 포함)', () => {
  assert.deepEqual(remapReminders(['day'], false, true), { reminders: ['at'], removed: 0 });
  assert.deepEqual(remapReminders(['day', '1d'], false, true), { reminders: ['at', '1d'], removed: 0 });
  assert.deepEqual(remapReminders(['at', 'day'], false, true), { reminders: ['at'], removed: 0 }, '정시와 합쳐도 중복 없이');
  assert.deepEqual(remapReminders(['at', '10m', '30m', '1h', '1d'], true, false), { reminders: ['1d'], removed: 4 });
  assert.deepEqual(remapReminders(['1d'], true, false), { reminders: ['1d'], removed: 0 });
  assert.deepEqual(remapReminders([], true, false), { reminders: [], removed: 0 });
  // 시각 유무가 안 바뀌면 그대로
  assert.deepEqual(remapReminders(['at', '30m'], true, true), { reminders: ['at', '30m'], removed: 0 });
  assert.deepEqual(remapReminders(['day'], false, false), { reminders: ['day'], removed: 0 });
  // 원본을 바꾸지 않는다
  const orig: ReminderKind[] = ['at', '1d'];
  remapReminders(orig, true, false);
  assert.deepEqual(orig, ['at', '1d']);
});

test('dueKey: 날짜(+시각)가 곧 회차 키이고, isKindAllowed 는 시각 유무에 맞는 종류만 허용', () => {
  assert.equal(dueKey({ dueDate: '2026-11-20', dueTime: '15:00' }), '2026-11-20 15:00');
  assert.equal(dueKey({ dueDate: '2026-11-20', dueTime: null }), '2026-11-20');
  assert.equal(dueKey({ dueDate: null, dueTime: null }), '');
  assert.notEqual(dueKey({ dueDate: '2026-11-20', dueTime: null }), dueKey({ dueDate: '2026-11-21', dueTime: null }), '다음 회차는 키가 다르다');
  assert.equal(isKindAllowed('at', true), true);
  assert.equal(isKindAllowed('day', true), false);
  assert.equal(isKindAllowed('day', false), true);
  assert.equal(isKindAllowed('30m', false), false);
  assert.equal(isKindAllowed('1d', true) && isKindAllowed('1d', false), true);
});
