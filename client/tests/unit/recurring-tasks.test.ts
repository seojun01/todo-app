import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { getTask, type StoredTask } from '../../src/store/tasks.ts';
import type { Recurrence } from '../../../shared/task.ts';

let n = 0;
/** 기기의 오늘 = 2026-11-12 (목) */
async function setup(today = new Date(2026, 10, 12, 9, 0, 0)) {
  const db = await openTodoDb(`recurring-test-${++n}`);
  let clock = today;
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => clock });
  return { db, ops: createTaskOps(ctx), tick: (ms = 1000) => (clock = new Date(clock.getTime() + ms)) };
}
function ok<T extends { ok: boolean }>(r: T | null): Extract<T, { ok: true }> {
  assert.ok(r !== null);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
type Ops = Awaited<ReturnType<typeof setup>>['ops'];
async function addRecurring(ops: Ops, title: string, dueDate: string, recurrence: Recurrence, extra: object = {}) {
  return ok(await ops.addTask({ title, dueDate, recurrence, ...extra })).task;
}
const daily: Recurrence = { unit: 'day', interval: 1 };
const mondays: Recurrence = { unit: 'week', interval: 1, weekdays: [1] };

test('반복 할 일을 완료하면 미완료로 남은 채 기한이 다음 회차로 넘어가고 시각·알림·반복은 유지된다', async () => {
  const { db, ops, tick } = await setup();
  const t0 = await addRecurring(ops, '약 먹기', '2026-11-12', daily);
  const timed = ok(await ops.editTask(t0.id, { dueTime: '08:30', reminders: ['at', '10m'] })).task;
  tick();
  const t1 = ok(await ops.toggleDone(t0.id)).task;
  assert.equal(t1.done, false);
  assert.equal(t1.dueDate, '2026-11-13');
  assert.equal(t1.dueTime, '08:30', '기한 시각 유지');
  assert.deepEqual(t1.reminders, ['at', '10m'], '알림 유지');
  assert.deepEqual(t1.recurrence, daily);
  assert.ok(t1.version > timed.version);
  assert.equal(t1.dirty, 1);
  assert.deepEqual(await getTask(db, t0.id), t1);
});

test('기한이 지난 상태에서 완료하면 오늘 이후의 첫 일정일로 넘어간다 (지난 회차를 하나씩 거치지 않는다)', async () => {
  const { ops } = await setup();
  const t = await addRecurring(ops, '밀린 일', '2026-11-09', daily); // 사흘 전이 기한
  assert.equal(ok(await ops.toggleDone(t.id)).task.dueDate, '2026-11-13');
  const weekly = await addRecurring(ops, '월요 회의', '2026-11-02', mondays); // 이틀 전이 월요일이었다
  assert.equal(ok(await ops.toggleDone(weekly.id)).task.dueDate, '2026-11-16');
});

test('undoComplete: 완료 직후 이전 기한으로 되돌린다 (가장 최근 1건만)', async () => {
  const { db, ops, tick } = await setup();
  const t0 = await addRecurring(ops, '약 먹기', '2026-11-12', daily);
  tick();
  ok(await ops.toggleDone(t0.id));
  tick();
  const back = ok(await ops.undoComplete()).task;
  assert.equal(back.dueDate, '2026-11-12');
  assert.equal(back.done, false);
  assert.ok(back.version > t0.version);
  assert.equal(await ops.undoComplete(), null, '되돌릴 것이 더 없다');
  assert.equal((await getTask(db, t0.id))!.dueDate, '2026-11-12');
});

test('종료 날짜 때문에 다음 회차가 없으면 완료 상태가 된다 (FR-020)', async () => {
  const { ops, tick } = await setup();
  const t = await addRecurring(ops, '단기 반복', '2026-11-12', { unit: 'day', interval: 1, endDate: '2026-11-13' });
  const second = ok(await ops.toggleDone(t.id)).task;
  assert.equal(second.dueDate, '2026-11-13');
  assert.equal(second.done, false);
  tick();
  const last = ok(await ops.toggleDone(t.id)).task; // 마지막 회차
  assert.equal(last.done, true);
  assert.equal(last.dueDate, '2026-11-13', '기한은 그대로');
  tick();
  assert.equal(ok(await ops.toggleDone(t.id)).task.done, false, '완료를 해제하면 다시 미완료');
});

test('반복을 해제하면 현재 기한을 가진 일반 할 일이 된다', async () => {
  const { ops } = await setup();
  const t = await addRecurring(ops, '매일', '2026-11-12', daily);
  const plain = ok(await ops.editTask(t.id, { recurrence: null })).task;
  assert.equal(plain.recurrence, null);
  assert.equal(plain.dueDate, '2026-11-12');
  const done = ok(await ops.toggleDone(t.id)).task;
  assert.equal(done.done, true, '일반 할 일처럼 완료된다');
  assert.equal(done.dueDate, '2026-11-12');
});

test('반복 할 일을 삭제하면 툼스톤이 되고 실행 취소하면 반복 규칙까지 복원된다', async () => {
  const { ops } = await setup();
  const rule: Recurrence = { unit: 'week', interval: 2, weekdays: [1, 3], endDate: '2027-01-01' };
  const t = await addRecurring(ops, '격주', '2026-11-16', rule);
  assert.equal(ok(await ops.deleteTask(t.id)).task.deleted, true);
  const back = ok(await ops.undoDelete()).task;
  assert.deepEqual(back.recurrence, rule);
  assert.equal(back.dueDate, '2026-11-16');
});

test('기한이 없는 할 일에 반복을 지정하면 거부된다', async () => {
  const { db, ops } = await setup();
  const r = await ops.addTask({ title: '기한 없음', recurrence: daily });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors[0]!.field, 'recurrence');
  const plain = ok(await ops.addTask({ title: '일반' })).task;
  const e = await ops.editTask(plain.id, { recurrence: daily });
  assert.equal(e.ok, false);
  assert.equal((await getTask(db, plain.id))!.recurrence, null);
});

test('반복을 지정하거나 규칙을 바꾸면 기한이 규칙에 맞는 첫 날짜로 맞춰진다 (FR-017)', async () => {
  const { ops } = await setup();
  const t = ok(await ops.addTask({ title: '운동', dueDate: '2026-11-11' })).task; // 수요일
  const set = ok(await ops.editTask(t.id, { recurrence: mondays })).task;
  assert.equal(set.dueDate, '2026-11-16', '수요일 기한 + 매주 월요일 → 다음 월요일');

  const sameDay = ok(await ops.addTask({ title: '월요일 기한', dueDate: '2026-11-09' })).task;
  assert.equal(ok(await ops.editTask(sameDay.id, { recurrence: mondays })).task.dueDate, '2026-11-09', '이미 월요일이면 그대로');

  const changed = ok(await ops.editTask(set.id, { recurrence: { unit: 'week', interval: 1, weekdays: [5] } })).task;
  assert.equal(changed.dueDate, '2026-11-20', '규칙을 바꾸면 다시 맞춘다 (금요일)');

  const dayRule = ok(await ops.addTask({ title: '일 단위', dueDate: '2026-11-12' })).task;
  assert.equal(ok(await ops.editTask(dayRule.id, { recurrence: { unit: 'day', interval: 3 } })).task.dueDate, '2026-11-12');
});

test('규칙을 바꾸지 않고 기한만 직접 바꾸면 그 날짜가 새 기준이 된다 (FR-021)', async () => {
  const { ops } = await setup();
  const t = await addRecurring(ops, '월요 회의', '2026-11-16', mondays);
  const moved = ok(await ops.editTask(t.id, { dueDate: '2026-11-18' })).task; // 수요일로 직접 옮김
  assert.equal(moved.dueDate, '2026-11-18', '규칙에 맞추지 않고 그대로 둔다');
  assert.equal(ok(await ops.toggleDone(t.id)).task.dueDate, '2026-11-23', '그 주를 기준으로 다음 월요일');
});

test('기한을 종료 날짜 뒤로 옮기려 하면 거부되고 레코드가 바뀌지 않는다', async () => {
  const { db, ops } = await setup();
  const t = await addRecurring(ops, '종료 있음', '2026-11-12', { unit: 'day', interval: 1, endDate: '2026-11-20' });
  const r = await ops.editTask(t.id, { dueDate: '2026-11-25' });
  assert.equal(r.ok, false);
  assert.deepEqual(await getTask(db, t.id), t);
  // 종료 날짜를 먼저 바꾸면 옮길 수 있다
  ok(await ops.editTask(t.id, { recurrence: { unit: 'day', interval: 1, endDate: '2026-12-31' } }));
  assert.equal(ok(await ops.editTask(t.id, { dueDate: '2026-11-25' })).task.dueDate, '2026-11-25');
});

test('매월 31일 반복: 31일이 없는 달은 말일로, 연체 후 완료해도 오늘 이후 첫 일정일', async () => {
  const { ops } = await setup();
  const t = await addRecurring(ops, '정산', '2026-01-31', { unit: 'month', interval: 1, dayOfMonth: 31 });
  assert.equal(ok(await ops.toggleDone(t.id)).task.dueDate, '2026-11-30');
  assert.equal(ok(await ops.toggleDone(t.id)).task.dueDate, '2026-12-31', '다음 달에는 다시 31일');
});

test('moveOverdueToToday: 반복 할 일의 종료 날짜가 오늘보다 앞이어도 검증을 통과한다', async () => {
  const { db, ops } = await setup();
  const t = await addRecurring(ops, '끝난 반복', '2026-11-01', { unit: 'day', interval: 1, endDate: '2026-11-05' });
  assert.equal(await ops.moveOverdueToToday('2026-11-12'), 1);
  const moved = (await getTask(db, t.id)) as StoredTask;
  assert.equal(moved.dueDate, '2026-11-12');
  assert.equal(moved.recurrence!.endDate, '2026-11-12');
});
