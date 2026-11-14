import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb, commit } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { createProjectOps } from '../../src/projects.ts';
import { getTask, listAllTasks, type StoredTask } from '../../src/store/tasks.ts';
import { getProject, listProjects } from '../../src/store/projects.ts';
import { projectTasks, projectSummaries } from '../../src/views.ts';
import { effectiveProjectId, isUuid } from '../../../shared/task.ts';

let n = 0;
async function setup() {
  const db = await openTodoDb(`projects-test-${++n}`);
  let clock = new Date(2026, 10, 12, 9, 0, 0);
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => clock });
  const tasks = createTaskOps(ctx);
  return { db, ctx, tasks, projects: createProjectOps(ctx, tasks), tick: (ms = 1000) => (clock = new Date(clock.getTime() + ms)) };
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
const addTask = async (t: Awaited<ReturnType<typeof setup>>['tasks'], title: string, projectId?: string) =>
  ok(await t.addTask({ title, dueDate: '2026-11-12', projectId })).task;

test('createProject: 이름은 앞뒤 공백을 지우고, 색상 기본값은 gray 이며, 저장된다', async () => {
  const { db, projects } = await setup();
  const p = ok(await projects.createProject({ name: '  업무  ' })).project;
  assert.equal(p.name, '업무');
  assert.equal(p.color, 'gray');
  assert.equal(p.deleted, false);
  assert.equal(p.dirty, 1);
  assert.equal(p.updatedBy, 'dev-a');
  assert.ok(isUuid(p.id));
  assert.match(p.version, /^\d{15}-\d{6}-dev-a$/);
  assert.deepEqual(await getProject(db, p.id), p);
  const blue = ok(await projects.createProject({ name: '집안일', color: 'blue' })).project;
  assert.equal(blue.color, 'blue');
});

test('createProject: 이름 1~50자(코드 포인트), 팔레트 색상만 — 실패하면 저장하지 않는다', async () => {
  const { db, projects } = await setup();
  for (const name of ['', '   ', 'a'.repeat(51), '😀'.repeat(51)]) assert.equal((await projects.createProject({ name })).ok, false, name.slice(0, 5));
  assert.equal((await projects.createProject({ name: 'x', color: 'pink' as never })).ok, false);
  assert.deepEqual(await listProjects(db), []);
  assert.equal((await projects.createProject({ name: '😀'.repeat(50) })).ok, true);
  assert.equal((await projects.createProject({ name: 'a'.repeat(50) })).ok, true);
});

test('createProject: 이름이 같은 프로젝트를 여러 개 만들 수 있다 (FR-013)', async () => {
  const { db, projects } = await setup();
  ok(await projects.createProject({ name: '같은 이름' }));
  ok(await projects.createProject({ name: '같은 이름' }));
  assert.equal((await listProjects(db)).length, 2);
});

test('updateProject: 이름·색상을 바꾸고 version 을 새로 발급한다. 잘못된 값이나 inbox 는 거부', async () => {
  const { db, projects, tick } = await setup();
  const p0 = ok(await projects.createProject({ name: '업무' })).project;
  tick();
  const p1 = ok(await projects.updateProject(p0.id, { name: ' 직장 ', color: 'red' })).project;
  assert.equal(p1.name, '직장');
  assert.equal(p1.color, 'red');
  assert.ok(p1.version > p0.version);
  assert.equal(p1.createdAt, p0.createdAt);
  assert.equal(p1.dirty, 1);

  assert.equal((await projects.updateProject(p0.id, { name: '' })).ok, false);
  assert.equal((await projects.updateProject(p0.id, { color: 'pink' as never })).ok, false);
  assert.deepEqual(await getProject(db, p0.id), p1, '실패하면 바뀌지 않는다');
  assert.equal((await projects.updateProject('inbox', { name: '다른 이름' })).ok, false);
  assert.equal((await projects.updateProject(crypto.randomUUID(), { name: 'x' })).ok, false);
});

test('countTasks: 삭제되지 않은 할 일 수 (완료한 것 포함)', async () => {
  const { projects, tasks } = await setup();
  const p = ok(await projects.createProject({ name: '업무' })).project;
  const a = await addTask(tasks, 'a', p.id);
  await addTask(tasks, 'b', p.id);
  const c = await addTask(tasks, 'c', p.id);
  await addTask(tasks, 'other'); // 수신함
  ok(await tasks.toggleDone(a.id));
  ok(await tasks.deleteTask(c.id));
  assert.equal(await projects.countTasks(p.id), 2);
});

test('deleteProject: 프로젝트와 소속 할 일의 툼스톤을 함께 만든다', async () => {
  const { db, projects, tasks, tick } = await setup();
  const p = ok(await projects.createProject({ name: '업무' })).project;
  const other = ok(await projects.createProject({ name: '집안일' })).project;
  const a = await addTask(tasks, 'a', p.id);
  const b = await addTask(tasks, 'b', p.id);
  ok(await tasks.toggleDone(b.id)); // 완료한 것도 함께 삭제
  const gone = await addTask(tasks, 'gone', p.id);
  ok(await tasks.deleteTask(gone.id)); // 이미 삭제된 것은 건드리지 않는다
  const keep = await addTask(tasks, 'keep', other.id);
  const inbox = await addTask(tasks, 'inbox');
  const goneVersion = (await getTask(db, gone.id))!.version;
  tick();

  const r = ok(await projects.deleteProject(p.id));
  assert.equal(r.deletedTasks, 2);
  assert.equal((await getProject(db, p.id))!.deleted, true);
  assert.equal((await getProject(db, p.id))!.dirty, 1);
  for (const t of [a, b]) {
    const stored = (await getTask(db, t.id))!;
    assert.equal(stored.deleted, true);
    assert.equal(stored.dirty, 1);
    assert.ok(stored.version > t.version);
  }
  assert.equal((await getTask(db, gone.id))!.version, goneVersion);
  assert.equal((await getTask(db, keep.id))!.deleted, false);
  assert.equal((await getTask(db, inbox.id))!.deleted, false);
  assert.equal((await getProject(db, other.id))!.deleted, false);
});

test('deleteProject: 수신함은 삭제할 수 없고 없는 프로젝트는 거부', async () => {
  const { projects } = await setup();
  const r = await projects.deleteProject('inbox');
  assert.equal(r.ok, false);
  assert.equal((await projects.deleteProject(crypto.randomUUID())).ok, false);
});

test('moveTask: 프로젝트만 바꾸고 version 을 새로 발급한다. 없는/삭제된 프로젝트로는 못 옮긴다', async () => {
  const { db, projects, tasks, tick } = await setup();
  const p = ok(await projects.createProject({ name: '업무' })).project;
  const t0 = await addTask(tasks, '장보기');
  tick();
  const t1 = ok(await projects.moveTask(t0.id, p.id)).task;
  assert.equal(t1.projectId, p.id);
  assert.ok(t1.version > t0.version);
  assert.deepEqual({ ...t1, projectId: 'inbox', version: t0.version }, t0);
  assert.equal(ok(await projects.moveTask(t0.id, 'inbox')).task.projectId, 'inbox');

  assert.equal((await projects.moveTask(t0.id, crypto.randomUUID())).ok, false);
  ok(await projects.deleteProject(p.id));
  assert.equal((await projects.moveTask(t0.id, p.id)).ok, false);
  assert.equal((await getTask(db, t0.id))!.projectId, 'inbox');
});

test('projectTasks: 프로젝트별로 나뉘고, 삭제된/없는 프로젝트의 할 일은 수신함에 나타난다 (고아 처리)', async () => {
  const { db, ctx, projects, tasks } = await setup();
  const live = ok(await projects.createProject({ name: '업무' })).project;
  const dead = ok(await projects.createProject({ name: '지울 것' })).project;
  const inboxTask = await addTask(tasks, '수신함');
  const liveTask = await addTask(tasks, '업무 일', live.id);
  ok(await projects.deleteProject(dead.id));

  // 다른 기기가 오프라인에서 삭제된 프로젝트에 할 일을 추가했고 동기화로 도착한 상황
  const orphan: StoredTask = {
    ...(await getTask(db, inboxTask.id))!,
    id: crypto.randomUUID(),
    title: '고아',
    projectId: dead.id,
    version: ctx.hlc.next(),
  };
  const missing: StoredTask = { ...orphan, id: crypto.randomUUID(), title: '프로젝트 없음', projectId: crypto.randomUUID() };
  await commit(db, { tasks: [orphan, missing] });

  const inbox = await projectTasks(db, 'inbox');
  assert.deepEqual(inbox.open.map((t) => t.title).sort(), ['고아', '수신함', '프로젝트 없음']);
  assert.deepEqual((await projectTasks(db, live.id)).open.map((t) => t.title), ['업무 일']);
  assert.deepEqual((await projectTasks(db, dead.id)).open, [], '삭제된 프로젝트 화면은 비어 있다');
  assert.equal(liveTask.projectId, live.id);
  assert.equal(effectiveProjectId(orphan, await listProjects(db)), 'inbox');
  // 완료한 것은 completed 로
  const done = ok(await tasks.toggleDone(inboxTask.id)).task;
  const after = await projectTasks(db, 'inbox');
  assert.deepEqual(after.completed.map((t) => t.id), [done.id]);
  assert.equal((await listAllTasks(db)).length, 4); // 수신함, 업무, 고아, 프로젝트 없음
});

test('projectSummaries: 살아 있는 프로젝트를 만든 순서로, 미완료 개수와 함께', async () => {
  const { db, projects, tasks, tick } = await setup();
  const a = ok(await projects.createProject({ name: 'A', color: 'red' })).project;
  tick();
  const b = ok(await projects.createProject({ name: 'B' })).project;
  tick();
  const dead = ok(await projects.createProject({ name: 'dead' })).project;
  const t1 = await addTask(tasks, '1', a.id);
  await addTask(tasks, '2', a.id);
  ok(await tasks.toggleDone(t1.id));
  await addTask(tasks, '3', b.id);
  ok(await projects.deleteProject(dead.id));

  const s = await projectSummaries(db);
  assert.deepEqual(s.map((x) => [x.project.name, x.open]), [['A', 1], ['B', 1]]);
  assert.equal(s[0]!.project.color, 'red');
});
