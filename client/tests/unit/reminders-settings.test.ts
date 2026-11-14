import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { createSettingsOps } from '../../src/settings.ts';
import { getStoredSettings } from '../../src/store/meta.ts';
import { getTask } from '../../src/store/tasks.ts';

let n = 0;
async function setup() {
  const db = await openTodoDb(`reminders-test-${++n}`);
  let clock = new Date(2026, 10, 12, 9, 0, 0);
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => (clock = new Date(clock.getTime() + 1000)) });
  return { db, ops: createTaskOps(ctx), settings: createSettingsOps(ctx) };
}
const ok = <T extends { ok: boolean }>(r: T | null) => {
  assert.equal(r?.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

test('설정: 바꾼 적이 없으면 기본 알림 시각 09:00, 바꾸면 저장되고 동기화 대기(dirty) 상태가 된다', async () => {
  const { db, settings } = await setup();
  const first = await settings.get();
  assert.equal(first.defaultReminderTime, '09:00');
  assert.equal(await getStoredSettings(db), undefined, '읽기만 해서는 저장하지 않는다');

  const r = ok(await settings.setDefaultReminderTime('07:45'));
  assert.equal(r.settings.defaultReminderTime, '07:45');
  assert.equal((await settings.get()).defaultReminderTime, '07:45');
  const stored = (await getStoredSettings(db))!;
  assert.equal(stored.dirty, 1);
  assert.equal(stored.updatedBy, 'dev-a');
  assert.equal(stored.id, 'settings');
  assert.ok(stored.version.length > 0);

  const again = ok(await settings.setDefaultReminderTime('20:00'));
  assert.ok(again.settings.version > r.settings.version, '바꿀 때마다 버전이 올라 가장 나중 변경이 이긴다');
  assert.equal((await settings.get()).defaultReminderTime, '20:00');
});

test('설정: 잘못된 시각은 거부하고 이전 값을 그대로 둔다', async () => {
  const { settings } = await setup();
  ok(await settings.setDefaultReminderTime('08:30'));
  for (const bad of ['', '8:30', '25:00', '09:60', 'abc', '09:00:00']) {
    const r = await settings.setDefaultReminderTime(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal((r as { errors: { field: string }[] }).errors[0]!.field, 'defaultReminderTime');
  }
  assert.equal((await settings.get()).defaultReminderTime, '08:30');
});

test('할 일: 기한 시각과 알림을 저장하고, 시각 유무에 맞지 않는 알림은 거부한다', async () => {
  const { db, ops } = await setup();
  const t = ok(await ops.addTask({ title: '회의', dueDate: '2026-11-20', dueTime: '15:00', reminders: ['at', '30m'] })).task;
  assert.equal(t.dueTime, '15:00');
  assert.deepEqual(t.reminders, ['at', '30m']);
  assert.deepEqual((await getTask(db, t.id))!.reminders, ['at', '30m']);

  const dateOnly = ok(await ops.addTask({ title: '제출', dueDate: '2026-11-20', reminders: ['day', '1d'] })).task;
  assert.deepEqual(dateOnly.reminders, ['day', '1d']);

  for (const [label, input] of [
    ['시각 없는데 정시', { dueDate: '2026-11-20', reminders: ['at'] }],
    ['시각 있는데 당일', { dueDate: '2026-11-20', dueTime: '15:00', reminders: ['day'] }],
    ['중복', { dueDate: '2026-11-20', dueTime: '15:00', reminders: ['at', 'at'] }],
    ['기한 없는데 알림', { reminders: ['1d'] }],
    ['기한 없는데 시각', { dueTime: '15:00' }],
    ['잘못된 시각', { dueDate: '2026-11-20', dueTime: '25:00' }],
  ] as const) {
    const r = await ops.addTask({ title: label, ...(input as object) });
    assert.equal(r.ok, false, label);
  }
});

test('할 일: 기한을 없애면 시각·알림·반복도 없어지고, 시각만 없애려면 알림을 함께 맞춰 보내야 한다', async () => {
  const { ops } = await setup();
  const t = ok(await ops.addTask({ title: '회의', dueDate: '2026-11-20', dueTime: '15:00', reminders: ['at', '1d'] })).task;
  // 알림을 맞추지 않고 시각만 없애면 검증이 거부한다 (화면이 remapReminders 로 먼저 맞춘다)
  assert.equal((await ops.editTask(t.id, { dueTime: null })).ok, false);
  const fixed = ok(await ops.editTask(t.id, { dueTime: null, reminders: ['1d'] })).task;
  assert.deepEqual([fixed.dueTime, fixed.reminders], [null, ['1d']]);
  const cleared = ok(await ops.editTask(t.id, { dueDate: null })).task;
  assert.deepEqual([cleared.dueDate, cleared.dueTime, cleared.reminders], [null, null, []]);
});

test('할 일: 알림이 있는 할 일의 기한이나 시각을 바꾸면 새 버전이 되어 서버가 알림을 다시 예약한다', async () => {
  const { ops } = await setup();
  const t = ok(await ops.addTask({ title: '회의', dueDate: '2026-11-20', dueTime: '15:00', reminders: ['at'] })).task;
  const moved = ok(await ops.editTask(t.id, { dueTime: '16:30' })).task;
  assert.ok(moved.version > t.version);
  assert.equal(moved.dueTime, '16:30');
  assert.deepEqual(moved.reminders, ['at'], '알림 종류는 그대로');
});
