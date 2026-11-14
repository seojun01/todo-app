import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb, commit } from '../../src/store/db.ts';
import { createCtx, type Ctx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { createSyncEngine, type SyncEngine } from '../../src/sync/engine.ts';
import { getTask, listAllTasks, listDirtyTasks, type StoredTask } from '../../src/store/tasks.ts';
import { getProject, listDirtyProjects, listProjects, type StoredProject } from '../../src/store/projects.ts';
import { getMeta } from '../../src/store/meta.ts';
import { effectiveProjectId } from '../../../shared/task.ts';
import { createFakeServer, type FakeServer } from '../helpers/fake-server.ts';
import { openDb } from '../../../server/src/db.ts';
import { applyChanges } from '../../../server/src/sync.ts';

let n = 0;
const T0 = new Date('2026-11-12T09:00:00.000Z');

async function device(server: FakeServer, deviceId: string, opts: { paired?: boolean; clock?: () => Date } = {}) {
  const db = await openTodoDb(`sync-test-${++n}`);
  const clock = opts.clock ?? (() => T0);
  const ctx: Ctx = await createCtx(db, { deviceId, now: clock });
  if (opts.paired !== false) await commit(db, { meta: { paired: true } }, { silent: true });
  const engine: SyncEngine = createSyncEngine(ctx, { fetch: server.fetch, now: clock, debounceMs: 0 });
  return { db, ctx, engine, ops: createTaskOps(ctx) };
}

function rec(id: string, over: Partial<StoredTask> = {}): StoredTask {
  return {
    id,
    title: id,
    dueDate: '2026-11-12',
    dueTime: null,
    projectId: 'inbox',
    priority: 4,
    recurrence: null,
    reminders: [],
    done: false,
    createdAt: '2026-11-12T00:00:00.000Z',
    deleted: false,
    version: '001762950896789-000001-x',
    updatedBy: 'x',
    dirty: 0,
    ...over,
  };
}
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const proj = (id: string, over: Partial<StoredProject> = {}): StoredProject => ({
  id,
  name: 'p',
  color: 'gray',
  createdAt: '2026-11-12T00:00:00.000Z',
  deleted: false,
  version: '001762950896789-000001-x',
  updatedBy: 'x',
  dirty: 0,
  ...over,
});

test('dirty 레코드만 push 한다 (task·project·settings) 그리고 성공하면 dirty 가 풀린다', async () => {
  const server = createFakeServer();
  const a = await device(server, 'dev-a');
  await commit(a.db, {
    tasks: [rec(uuid(1), { dirty: 1 }), rec(uuid(2), { dirty: 0 }), rec(uuid(3), { dirty: 1 })],
    projects: [proj(uuid(10), { dirty: 1 }), proj(uuid(11), { dirty: 0 })],
    meta: { settings: { id: 'settings', defaultReminderTime: '08:00', version: '001762950896789-000002-x', updatedBy: 'x', dirty: 1 } },
  });
  const status = await a.engine.syncNow();
  assert.equal(status.state, 'synced');
  const push = server.calls.find((c) => c.method === 'POST')!;
  const pushed = (push.body.changes as { type: string; record: { id: string } }[]).map((c) => `${c.type}:${c.record.id}`).sort();
  assert.deepEqual(pushed, [`project:${uuid(10)}`, `settings:settings`, `task:${uuid(1)}`, `task:${uuid(3)}`].sort());
  assert.deepEqual(await listDirtyTasks(a.db), []);
  assert.deepEqual(await listDirtyProjects(a.db), []);
  assert.equal(((await getMeta(a.db, 'settings')) as { dirty: number }).dirty, 0);
  assert.ok(await getMeta(a.db, 'lastSyncAt'));
  // 서버에도 들어갔다
  assert.equal((server.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 2);
});

test('push 하는 사이에 다시 수정된 레코드는 dirty 를 유지한다', async () => {
  const server = createFakeServer();
  const a = await device(server, 'dev-a');
  const t = (await a.ops.addTask({ title: '장보기', dueDate: '2026-11-12' })) as { ok: true; task: StoredTask };
  server.hooks.afterPush = async () => {
    server.hooks.afterPush = undefined;
    await a.ops.editTask(t.task.id, { title: '장보기 (수정)' }); // 응답을 받기 전에 다시 수정
  };
  await a.engine.syncNow();
  const stored = (await getTask(a.db, t.task.id))!;
  assert.equal(stored.title, '장보기 (수정)');
  assert.equal(stored.dirty, 1, '새 변경은 아직 서버에 없다');
  await a.engine.syncNow();
  assert.equal((await getTask(a.db, t.task.id))!.dirty, 0);
  assert.equal((server.db.prepare('SELECT title FROM tasks').get() as { title: string }).title, '장보기 (수정)');
});

test('pull 한 레코드의 저장과 cursor 갱신은 한 트랜잭션 — 중간에 실패하면 아무것도 바뀌지 않는다', async () => {
  const server = createFakeServer();
  applyChanges(server.db, { changes: [{ type: 'task', record: rec(uuid(1), { title: '정상' }) }] }, T0);
  server.hooks.mutatePull = (page) => {
    page.changes.push({ type: 'task', record: { title: 'id 없는 깨진 레코드' } });
  };
  const a = await device(server, 'dev-a');
  const status = await a.engine.syncNow();
  assert.notEqual(status.state, 'synced');
  assert.deepEqual(await listAllTasks(a.db), [], '정상 레코드도 저장되지 않았다');
  assert.equal(await getMeta(a.db, 'cursor'), undefined);

  server.hooks.mutatePull = undefined;
  assert.equal((await a.engine.syncNow()).state, 'synced');
  assert.equal((await listAllTasks(a.db)).length, 1);
});

test('응답을 받지 못한 push 를 그대로 다시 보내도 결과가 같다 (멱등)', async () => {
  const server = createFakeServer();
  const a = await device(server, 'dev-a');
  await a.ops.addTask({ title: '한 번만', dueDate: '2026-11-12' });
  server.hooks.loseNextPushResponse = true;
  const first = await a.engine.syncNow();
  assert.equal(first.state, 'offline');
  assert.equal(first.pending, 1);
  assert.equal((server.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1, '서버는 이미 반영했다');
  const seqBefore = (server.db.prepare(`SELECT value FROM server_meta WHERE key='last_seq'`).get() as { value: string }).value;

  const second = await a.engine.syncNow();
  assert.equal(second.state, 'synced');
  assert.equal((server.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1, '중복되지 않는다');
  assert.equal((server.db.prepare(`SELECT value FROM server_meta WHERE key='last_seq'`).get() as { value: string }).value, seqBefore);
  assert.deepEqual(await listDirtyTasks(a.db), []);
});

test('hasMore=true 이면 이어서 pull 한다', async () => {
  const server = createFakeServer();
  applyChanges(server.db, { changes: Array.from({ length: 5 }, (_, i) => ({ type: 'task', record: rec(uuid(i + 1)) })) }, T0);
  server.hooks.maxLimit = 2;
  const a = await device(server, 'dev-a');
  assert.equal((await a.engine.syncNow()).state, 'synced');
  assert.equal((await listAllTasks(a.db)).length, 5);
  assert.equal(await getMeta(a.db, 'cursor'), 5);
  assert.ok(server.calls.filter((c) => c.method === 'GET').length >= 3, '페이지를 나눠서 받았다');
});

test('서버 cursor 가 저장된 cursor 보다 작으면(서버 복원) 모든 로컬 레코드를 다시 push 하고 처음부터 pull 한다', async () => {
  const server = createFakeServer(); // 비어 있는 서버 = 백업에서 복원된 서버
  const a = await device(server, 'dev-a');
  await commit(a.db, {
    tasks: [rec(uuid(1), { title: '기기에만 있음', dirty: 0 }), rec(uuid(2), { title: '이것도', dirty: 0 })],
    projects: [proj(uuid(10), { dirty: 0 })],
    meta: { cursor: 50 },
  });
  // 서버에는 다른 기기가 올린 레코드가 하나 있다
  applyChanges(server.db, { changes: [{ type: 'task', record: rec(uuid(3), { title: '서버에만 있음' }) }] }, T0);
  const status = await a.engine.syncNow();
  assert.equal(status.state, 'synced');
  const ids = (server.db.prepare('SELECT id FROM tasks').all() as { id: string }[]).map((r) => r.id).sort();
  assert.deepEqual(ids, [uuid(1), uuid(2), uuid(3)], '로컬 레코드가 서버로 되돌아왔다');
  assert.equal((server.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, 1);
  assert.equal((await listAllTasks(a.db)).length, 3, '서버에만 있던 레코드도 받았다');
  const serverCursor = Number((server.db.prepare(`SELECT value FROM server_meta WHERE key='last_seq'`).get() as { value: string }).value);
  assert.equal(await getMeta(a.db, 'cursor'), serverCursor);
  assert.deepEqual(await listDirtyTasks(a.db), []);
});

test('같은 날 두 기기에서 반복 할 일을 같은 회차로 완료해도 레코드 하나만 남고 다음 기한이 한 회차만 넘어간다 (SC-009)', async () => {
  const server = createFakeServer();
  const clockA = () => new Date('2026-11-12T09:00:00.000Z');
  const clockB = () => new Date('2026-11-12T20:00:00.000Z');
  const a = await device(server, 'dev-a', { clock: clockA });
  const b = await device(server, 'dev-b', { clock: clockB });

  const created = (await a.ops.addTask({ title: '약 먹기', dueDate: '2026-11-12', recurrence: { unit: 'day', interval: 1 } })) as { ok: true; task: StoredTask };
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal((await getTask(b.db, created.task.id))!.title, '약 먹기');

  // 두 기기가 오프라인에서 같은 회차를 완료 → 둘 다 다음 기한 11/13 (완료 = 레코드 교체)
  const doneA = (await a.ops.editTask(created.task.id, { dueDate: '2026-11-13' })) as { ok: true; task: StoredTask };
  const doneB = (await b.ops.editTask(created.task.id, { dueDate: '2026-11-13' })) as { ok: true; task: StoredTask };
  assert.ok(doneB.task.version > doneA.task.version, 'B 가 나중');

  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();

  assert.equal((server.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
  const finalA = (await getTask(a.db, created.task.id))!;
  const finalB = (await getTask(b.db, created.task.id))!;
  assert.equal(finalA.dueDate, '2026-11-13');
  assert.deepEqual(finalA, finalB, '두 기기가 같은 최종 상태로 수렴');
  assert.equal(finalA.version, doneB.task.version);
  assert.equal(finalA.dirty, 0);
});

test('삭제된 프로젝트를 가리키는 할 일도 유실되지 않고 읽을 때 수신함으로 계산된다', async () => {
  const server = createFakeServer();
  const dead = uuid(10);
  applyChanges(
    server.db,
    {
      changes: [
        { type: 'project', record: proj(dead, { deleted: true, version: '001762950896789-000005-x' }) },
        { type: 'task', record: rec(uuid(1), { projectId: dead, title: '고아' }) },
      ],
    },
    T0,
  );
  const a = await device(server, 'dev-a');
  await a.engine.syncNow();
  const t = (await getTask(a.db, uuid(1)))!;
  assert.equal(t.projectId, dead, '레코드는 그대로 남는다');
  assert.equal(effectiveProjectId(t, await listProjects(a.db)), 'inbox');
  assert.ok(await getProject(a.db, dead));
});

test('상태: 네트워크 오류는 offline, 401 은 unauthorized, 성공하면 synced, 연결 중 dirty 가 있으면 pending', async () => {
  const server = createFakeServer();
  const a = await device(server, 'dev-a');
  assert.deepEqual({ ...(await a.engine.status()), lastSyncAt: null }, { state: 'synced', pending: 0, lastSyncAt: null, paired: true });

  await a.ops.addTask({ title: '대기', dueDate: '2026-11-12' });
  assert.equal((await a.engine.status()).state, 'pending');
  assert.equal((await a.engine.status()).pending, 1);

  server.hooks.offline = true;
  const off = await a.engine.syncNow();
  assert.equal(off.state, 'offline');
  assert.equal(off.pending, 1);

  server.hooks.offline = false;
  server.hooks.unauthorized = true;
  assert.equal((await a.engine.syncNow()).state, 'unauthorized');

  server.hooks.unauthorized = false;
  const ok = await a.engine.syncNow();
  assert.equal(ok.state, 'synced');
  assert.equal(ok.pending, 0);
  assert.ok(ok.lastSyncAt);
});

test('상태 변화를 구독할 수 있다', async () => {
  const server = createFakeServer();
  const a = await device(server, 'dev-a');
  const seen: string[] = [];
  const off = a.engine.onStatus((s) => seen.push(s.state));
  server.hooks.offline = true;
  await a.engine.syncNow();
  server.hooks.offline = false;
  await a.engine.syncNow();
  off();
  assert.ok(seen.includes('offline') && seen.at(-1) === 'synced', seen.join());
});

test('등록되지 않은 기기는 서버에 요청하지 않고 unauthorized(paired=false)', async () => {
  const server = createFakeServer();
  const a = await device(server, 'dev-a', { paired: false });
  await a.ops.addTask({ title: '로컬 전용', dueDate: '2026-11-12' });
  const s = await a.engine.syncNow();
  assert.equal(s.state, 'unauthorized');
  assert.equal(s.paired, false);
  assert.equal(server.calls.length, 0);
  assert.equal(s.pending, 1);
});

test('pull 한 원격 버전보다 이후 로컬 버전이 항상 크다 (HLC receive)', async () => {
  const server = createFakeServer();
  const future = '001999999999999-000000-x'; // 시계가 크게 앞선 다른 기기
  applyChanges(server.db, { changes: [{ type: 'task', record: rec(uuid(1), { version: future }) }] }, T0);
  const a = await device(server, 'dev-a');
  await a.engine.syncNow();
  const edit = (await a.ops.editTask(uuid(1), { title: '내가 나중에 고침' })) as { ok: true; task: StoredTask };
  assert.ok(edit.task.version > future);
});

test('서로 다른 서버 DB 를 쓰는 엔진은 서로 영향이 없다 (테스트 격리 확인)', async () => {
  const s1 = createFakeServer(openDb(':memory:'));
  const s2 = createFakeServer(openDb(':memory:'));
  const a = await device(s1, 'dev-a');
  await a.ops.addTask({ title: '격리', dueDate: '2026-11-12' });
  await a.engine.syncNow();
  assert.equal((s1.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
  assert.equal((s2.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
});
