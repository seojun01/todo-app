import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb, commit, runTx } from '../../src/store/db.ts';
import { getTask, listTasksByDueRange, listTasksByProject, listDirtyTasks, listAllTasks } from '../../src/store/tasks.ts';
import { getProject, listProjects, listDirtyProjects } from '../../src/store/projects.ts';
import { getMeta } from '../../src/store/meta.ts';
import type { StoredTask } from '../../src/store/tasks.ts';
import type { StoredProject } from '../../src/store/projects.ts';

let n = 0;
let dbName = '';
beforeEach(() => {
  dbName = `todo-test-${++n}`;
});

function task(over: Partial<StoredTask> = {}): StoredTask {
  const id = over.id ?? `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return {
    id,
    title: 't',
    dueDate: '2026-11-20',
    dueTime: null,
    projectId: 'inbox',
    priority: 4,
    recurrence: null,
    reminders: [],
    done: false,
    createdAt: '2026-11-12T00:00:00.000Z',
    deleted: false,
    version: 'v1',
    updatedBy: 'd',
    dirty: 1,
    ...over,
  };
}
function project(over: Partial<StoredProject> = {}): StoredProject {
  return {
    id: `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    name: 'p',
    color: 'gray',
    createdAt: '2026-11-12T00:00:00.000Z',
    deleted: false,
    version: 'v1',
    updatedBy: 'd',
    dirty: 1,
    ...over,
  };
}

test('object store 와 인덱스가 있다', async () => {
  const db = await openTodoDb(dbName);
  assert.deepEqual([...db.objectStoreNames].sort(), ['meta', 'projects', 'tasks']);
  const tx = db.transaction(['tasks', 'projects'], 'readonly');
  assert.deepEqual([...tx.objectStore('tasks').indexNames].sort(), ['byDirty', 'byDue', 'byProject']);
  assert.deepEqual([...tx.objectStore('projects').indexNames].sort(), ['byDirty']);
  assert.equal(tx.objectStore('tasks').keyPath, 'id');
  db.close();
});

test('commit 은 트랜잭션이 complete 된 뒤에 resolve 된다', async () => {
  const db = await openTodoDb(dbName);
  const t = task();
  await commit(db, { tasks: [t] });
  // 다른 연결에서도 보인다 = 이미 커밋됨
  const db2 = await openTodoDb(dbName);
  assert.deepEqual(await getTask(db2, t.id), t);
  db.close();
  db2.close();
});

test('트랜잭션이 abort 되면 reject 되고 같은 배치의 앞선 쓰기도 저장되지 않는다', async () => {
  const db = await openTodoDb(dbName);
  const ok = task();
  const bad = { ...task(), id: undefined as unknown as string }; // keyPath 누락 → DataError
  await assert.rejects(commit(db, { tasks: [ok, bad] }));
  assert.equal(await getTask(db, ok.id), undefined);
  // 여러 object store 를 한 트랜잭션으로 쓰다 실패해도 전부 취소된다
  const proj = project();
  await assert.rejects(commit(db, { projects: [proj], tasks: [bad], meta: { cursor: 5 } }));
  assert.equal(await getProject(db, proj.id), undefined);
  assert.equal(await getMeta(db, 'cursor'), undefined);
  db.close();
});

test('runTx: 콜백이 throw 하면 abort 하고 reject', async () => {
  const db = await openTodoDb(dbName);
  await assert.rejects(
    runTx(db, ['tasks'], 'readwrite', (tx) => {
      tx.objectStore('tasks').put(task());
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(await listAllTasks(db), []);
  db.close();
});

test('byDue: dueDate 가 없는 할 일은 기한 조회에 나오지 않는다', async () => {
  const db = await openTodoDb(dbName);
  const a = task({ dueDate: '2026-11-20' });
  const b = task({ dueDate: '2026-11-21' });
  const none = task({ dueDate: null });
  const out = task({ dueDate: '2026-12-25' });
  await commit(db, { tasks: [a, b, none, out] });
  const got = await listTasksByDueRange(db, '2026-11-01', '2026-11-30');
  assert.deepEqual(got.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.equal((await listAllTasks(db)).length, 4);
  db.close();
});

test('byProject / byDirty (dirty 는 0|1 정수)', async () => {
  const db = await openTodoDb(dbName);
  const proj = project();
  const a = task({ projectId: proj.id, dirty: 1 });
  const b = task({ projectId: 'inbox', dirty: 0 });
  const c = task({ projectId: proj.id, dirty: 0 });
  await commit(db, { tasks: [a, b, c], projects: [proj] });
  assert.deepEqual((await listTasksByProject(db, proj.id)).map((x) => x.id).sort(), [a.id, c.id].sort());
  assert.deepEqual((await listDirtyTasks(db)).map((x) => x.id), [a.id]);
  assert.equal(typeof (await getTask(db, a.id))!.dirty, 'number');
  assert.deepEqual((await listDirtyProjects(db)).map((x) => x.id), [proj.id]);
  db.close();
});

test('projects: 만든 순서(createdAt 오름차순)로 나온다', async () => {
  const db = await openTodoDb(dbName);
  const late = project({ createdAt: '2026-11-03T00:00:00.000Z', name: 'late' });
  const early = project({ createdAt: '2026-11-01T00:00:00.000Z', name: 'early' });
  await commit(db, { projects: [late, early] });
  assert.deepEqual((await listProjects(db)).map((p) => p.name), ['early', 'late']);
  db.close();
});

test('meta: deviceId, cursor, hlc, lastSyncAt, settings, notifyEnabled 읽기·쓰기', async () => {
  const db = await openTodoDb(dbName);
  const settings = { id: 'settings', defaultReminderTime: '09:00', version: 'v', updatedBy: 'd', dirty: 1 };
  await commit(db, {
    meta: {
      deviceId: 'abc',
      cursor: 42,
      hlc: { wallMs: 1, counter: 2 },
      lastSyncAt: '2026-11-12T00:00:00.000Z',
      settings,
      notifyEnabled: true,
    },
  });
  assert.equal(await getMeta(db, 'deviceId'), 'abc');
  assert.equal(await getMeta(db, 'cursor'), 42);
  assert.deepEqual(await getMeta(db, 'hlc'), { wallMs: 1, counter: 2 });
  assert.equal(await getMeta(db, 'lastSyncAt'), '2026-11-12T00:00:00.000Z');
  assert.deepEqual(await getMeta(db, 'settings'), settings);
  assert.equal(await getMeta(db, 'notifyEnabled'), true);
  assert.equal(await getMeta(db, 'nothing'), undefined);
  db.close();
});

test('commit 이후 변경 알림이 한 번 온다', async () => {
  const { onStoreChange } = await import('../../src/store/db.ts');
  const db = await openTodoDb(dbName);
  let count = 0;
  const off = onStoreChange(() => count++);
  await commit(db, { tasks: [task()] });
  assert.equal(count, 1);
  await commit(db, { meta: { cursor: 1 } }, { silent: true });
  assert.equal(count, 1, 'silent 쓰기는 알리지 않는다');
  off();
  await commit(db, { tasks: [task()] });
  assert.equal(count, 1);
  db.close();
});
