import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { getTask, listAllTasks } from '../../src/store/tasks.ts';
import { isUuid } from '../../../shared/task.ts';

let n = 0;
async function setup() {
  const db = await openTodoDb(`tasks-test-${++n}`);
  let clock = new Date(2026, 10, 12, 9, 0, 0);
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => clock });
  return { db, ctx, ops: createTaskOps(ctx), tick: (ms = 1000) => (clock = new Date(clock.getTime() + ms)) };
}
function ok<T extends { ok: boolean }>(r: T | null): Extract<T, { ok: true }> {
  assert.ok(r !== null, '결과가 null 이에요');
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

test('addTask: 제목을 trim 해 기본값으로 저장한다 (FR-006)', async () => {
  const { db, ops } = await setup();
  const r = ok(await ops.addTask({ title: '  장보기  ', dueDate: '2026-11-12' }));
  const t = r.task;
  assert.equal(t.title, '장보기');
  assert.equal(t.dueDate, '2026-11-12');
  assert.equal(t.dueTime, null);
  assert.equal(t.projectId, 'inbox');
  assert.equal(t.priority, 4);
  assert.equal(t.recurrence, null);
  assert.deepEqual(t.reminders, []);
  assert.equal(t.done, false);
  assert.equal(t.deleted, false);
  assert.equal(t.dirty, 1);
  assert.equal(t.updatedBy, 'dev-a');
  assert.ok(isUuid(t.id));
  assert.equal(t.createdAt, new Date(2026, 10, 12, 9, 0, 0).toISOString());
  assert.match(t.version, /^\d{15}-\d{6}-dev-a$/);
  assert.deepEqual(await getTask(db, t.id), t); // 저장되었다
});

test('addTask: 기한 없이도 만들 수 있다 (수신함)', async () => {
  const { ops } = await setup();
  const t = ok(await ops.addTask({ title: '언젠가' })).task;
  assert.equal(t.dueDate, null);
  assert.equal(t.projectId, 'inbox');
});

test('addTask: 빈 제목·공백뿐·201자는 저장하지 않고 이유를 돌려준다', async () => {
  const { db, ops } = await setup();
  for (const title of ['', '   ', 'a'.repeat(201)]) {
    const r = await ops.addTask({ title, dueDate: '2026-11-12' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.field, 'title');
  }
  assert.deepEqual(await listAllTasks(db), []);
});

test('addTask: 유효하지 않은 날짜는 거부한다', async () => {
  const { db, ops } = await setup();
  const r = await ops.addTask({ title: 'x', dueDate: '2026-02-30' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors[0]!.field, 'dueDate');
  assert.equal((await listAllTasks(db)).length, 0);
});

test('editTask: 제목과 기한을 바꾸고 version 을 새로 발급한다', async () => {
  const { db, ops, tick } = await setup();
  const t0 = ok(await ops.addTask({ title: '장보기', dueDate: '2026-11-12' })).task;
  tick();
  const t1 = ok(await ops.editTask(t0.id, { title: ' 장보기 (우유) ', dueDate: '2026-11-20' })).task;
  assert.equal(t1.title, '장보기 (우유)');
  assert.equal(t1.dueDate, '2026-11-20');
  assert.ok(t1.version > t0.version);
  assert.equal(t1.createdAt, t0.createdAt, 'createdAt 은 불변');
  assert.equal(t1.dirty, 1);
  assert.deepEqual(await getTask(db, t0.id), t1);
});

test('editTask: dueDate 를 null 로 바꾸면 dueTime·recurrence·reminders 도 함께 지워진다', async () => {
  const { ops } = await setup();
  const t = ok(await ops.addTask({ title: 'x', dueDate: '2026-11-12' })).task;
  const full = ok(
    await ops.editTask(t.id, { dueTime: '15:00', recurrence: { unit: 'day', interval: 1 }, reminders: ['at', '10m'] }),
  ).task;
  assert.equal(full.dueTime, '15:00');
  assert.equal(full.reminders.length, 2);
  const cleared = ok(await ops.editTask(t.id, { dueDate: null })).task;
  assert.equal(cleared.dueDate, null);
  assert.equal(cleared.dueTime, null);
  assert.equal(cleared.recurrence, null);
  assert.deepEqual(cleared.reminders, []);
});

test('editTask: 검증에 실패하면 레코드가 바뀌지 않는다', async () => {
  const { db, ops } = await setup();
  const t = ok(await ops.addTask({ title: '장보기', dueDate: '2026-11-12' })).task;
  for (const changes of [{ title: '   ' }, { title: 'a'.repeat(201) }, { dueDate: '2026-02-30' }]) {
    const r = await ops.editTask(t.id, changes);
    assert.equal(r.ok, false);
  }
  assert.deepEqual(await getTask(db, t.id), t);
});

test('toggleDone: done 만 뒤집고 version 을 새로 발급한다', async () => {
  const { ops, tick } = await setup();
  const t0 = ok(await ops.addTask({ title: 'x', dueDate: '2026-11-12' })).task;
  tick();
  const t1 = ok(await ops.toggleDone(t0.id)).task;
  assert.equal(t1.done, true);
  assert.ok(t1.version > t0.version);
  assert.deepEqual({ ...t1, done: false, version: t0.version }, t0);
  tick();
  const t2 = ok(await ops.toggleDone(t0.id)).task;
  assert.equal(t2.done, false);
  assert.ok(t2.version > t1.version);
});

test('deleteTask 는 툼스톤을 만들고 undoDelete 는 가장 최근 삭제 1건을 모든 속성 그대로 복원한다', async () => {
  const { db, ops, tick } = await setup();
  const t0 = ok(await ops.addTask({ title: '장보기', dueDate: '2026-11-12', priority: 2 })).task;
  tick();
  const full = ok(
    await ops.editTask(t0.id, { dueTime: '15:00', recurrence: { unit: 'week', interval: 1, weekdays: [1] }, reminders: ['at', '1d'] }),
  ).task;
  tick();
  const del = ok(await ops.deleteTask(t0.id)).task;
  assert.equal(del.deleted, true);
  assert.ok(del.version > full.version);
  assert.equal((await getTask(db, t0.id))!.deleted, true);

  tick();
  const back = ok(await ops.undoDelete());
  assert.equal(back.task.deleted, false);
  assert.ok(back.task.version > del.version);
  // version·updatedBy 를 제외한 모든 필드가 삭제 전과 같다 (dueTime·recurrence·reminders 포함, FR-009)
  const strip = ({ version: _v, updatedBy: _u, ...rest }: typeof full) => rest;
  assert.deepEqual(strip(back.task), strip(full));
});

test('undoDelete: 연달아 삭제하면 가장 최근 삭제만 되돌릴 수 있다', async () => {
  const { db, ops, tick } = await setup();
  const a = ok(await ops.addTask({ title: 'a' })).task;
  tick();
  const b = ok(await ops.addTask({ title: 'b' })).task;
  tick();
  ok(await ops.deleteTask(a.id));
  tick();
  ok(await ops.deleteTask(b.id));
  tick();
  const back = ok(await ops.undoDelete());
  assert.equal(back.task.id, b.id);
  assert.equal(await ops.undoDelete(), null, '두 번째 실행 취소는 없다');
  assert.equal((await getTask(db, a.id))!.deleted, true);
});

test('moveOverdueToToday: 기한이 지난 미완료만 오늘로 옮긴다', async () => {
  const { db, ops, tick } = await setup();
  const old1 = ok(await ops.addTask({ title: 'old1', dueDate: '2026-11-10' })).task;
  tick();
  const old2 = ok(await ops.addTask({ title: 'old2', dueDate: '2026-11-11' })).task;
  tick();
  const doneOld = ok(await ops.addTask({ title: 'doneOld', dueDate: '2026-11-09' })).task;
  ok(await ops.toggleDone(doneOld.id));
  const today = ok(await ops.addTask({ title: 'today', dueDate: '2026-11-12' })).task;
  const future = ok(await ops.addTask({ title: 'future', dueDate: '2026-11-20' })).task;
  const none = ok(await ops.addTask({ title: 'none' })).task;
  tick();
  const moved = await ops.moveOverdueToToday('2026-11-12');
  assert.equal(moved, 2);
  for (const id of [old1.id, old2.id]) assert.equal((await getTask(db, id))!.dueDate, '2026-11-12');
  assert.equal((await getTask(db, doneOld.id))!.dueDate, '2026-11-09');
  assert.equal((await getTask(db, today.id))!.dueDate, '2026-11-12');
  assert.equal((await getTask(db, future.id))!.dueDate, '2026-11-20');
  assert.equal((await getTask(db, none.id))!.dueDate, null);
});

test('저장소 쓰기가 실패하면 성공을 돌려주지 않는다 (FR-011)', async () => {
  const { db, ops } = await setup();
  db.close(); // 이후 트랜잭션은 InvalidStateError
  await assert.rejects(ops.addTask({ title: '실패해야 함', dueDate: '2026-11-12' }));
});

test('priority: 1(긴급)~4(없음)만 받고 기본값은 4, 범위 밖 값은 저장하지 않는다 (FR-016)', async () => {
  const { db, ops, tick } = await setup();
  assert.equal(ok(await ops.addTask({ title: '기본' })).task.priority, 4);
  for (const p of [1, 2, 3, 4] as const) assert.equal(ok(await ops.addTask({ title: `p${p}`, priority: p })).task.priority, p);
  const before = (await listAllTasks(db)).length;
  for (const bad of [0, 5, 1.5, -1]) {
    const r = await ops.addTask({ title: 'bad', priority: bad as never });
    assert.equal(r.ok, false, String(bad));
    if (!r.ok) assert.equal(r.errors[0]!.field, 'priority');
  }
  assert.equal((await listAllTasks(db)).length, before, '저장되지 않았다');

  const t0 = ok(await ops.addTask({ title: '수정 대상', dueDate: '2026-11-12' })).task;
  tick();
  const t1 = ok(await ops.editTask(t0.id, { priority: 1 })).task;
  assert.equal(t1.priority, 1);
  assert.ok(t1.version > t0.version, '우선순위만 바꿔도 version 이 새로 발급된다');
  assert.equal((await ops.editTask(t0.id, { priority: 9 as never })).ok, false);
  assert.equal((await getTask(db, t0.id))!.priority, 1, '실패하면 바뀌지 않는다');
});

test('태그: 추가할 때 다듬어(#·공백·중복 제거) 저장하고, 수정으로 바꾸거나 모두 지울 수 있다', async () => {
  const { db, ops } = await setup();
  const t = ok(await ops.addTask({ title: '병원', tags: [' #집 ', '급함', '집', 'Urgent', 'urgent'] })).task;
  assert.deepEqual(t.tags, ['집', '급함', 'Urgent']);
  assert.deepEqual((await getTask(db, t.id))!.tags, ['집', '급함', 'Urgent']);

  const edited = ok(await ops.editTask(t.id, { tags: ['업무'] })).task;
  assert.deepEqual(edited.tags, ['업무']);
  assert.equal(edited.dirty, 1);
  assert.ok(edited.version > t.version, '태그만 바꿔도 버전이 올라 동기화된다');

  assert.deepEqual(ok(await ops.editTask(t.id, { tags: [] })).task.tags, []);
  // tags 를 안 건드린 수정은 유지한다
  ok(await ops.editTask(t.id, { tags: ['유지'] }));
  assert.deepEqual(ok(await ops.editTask(t.id, { title: '제목만' })).task.tags, ['유지']);
});

test('태그: 개수·형식이 잘못되면 거부한다', async () => {
  const { ops } = await setup();
  const many = await ops.addTask({ title: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) });
  assert.equal(many.ok, false);
  assert.equal((many as { errors: { field: string; rule: string }[] }).errors[0]!.rule, 'count');
  const bad = await ops.addTask({ title: 'x', tags: ['공 백'] });
  assert.equal(bad.ok, false);
  assert.equal((bad as { errors: { field: string }[] }).errors[0]!.field, 'tags');
});

test('태그: 옛 데이터(tags 필드 없음)도 수정·완료가 된다', async () => {
  const { db, ops } = await setup();
  const t = ok(await ops.addTask({ title: '옛 할 일' })).task;
  const { tags: _t, ...old } = (await getTask(db, t.id))!;
  const tx = db.transaction('tasks', 'readwrite');
  tx.objectStore('tasks').put(old);
  await new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = () => rej(tx.error))));
  assert.equal((await getTask(db, t.id))!.tags, undefined);
  ok(await ops.toggleDone(t.id));
  assert.equal(ok(await ops.editTask(t.id, { title: '고침' })).task.title, '고침');
});
