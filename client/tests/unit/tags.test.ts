import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { tagSummaries, tagTasks } from '../../src/views.ts';

let n = 0;
async function setup() {
  const db = await openTodoDb(`tags-test-${++n}`);
  let clock = new Date(2026, 10, 12, 9, 0, 0);
  // 만든 시각이 달라야 "먼저 쓴 표기"가 정해진다: 호출할 때마다 1초씩 흐른다
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => (clock = new Date(clock.getTime() + 1000)) });
  return { db, ops: createTaskOps(ctx) };
}

test('tagSummaries: 대소문자만 다른 태그는 먼저 쓴 표기로 묶고, 미완료 개수를 센다. 삭제된 할 일은 빼고 이름순', async () => {
  const { db, ops } = await setup();
  await ops.addTask({ title: 'a', tags: ['집', 'Home'] });
  await ops.addTask({ title: 'b', tags: ['home', '업무'] });
  const done = await ops.addTask({ title: 'c', tags: ['집'] });
  const gone = await ops.addTask({ title: 'd', tags: ['삭제만'] });
  if (done.ok) await ops.toggleDone(done.task.id);
  if (gone.ok) await ops.deleteTask(gone.task.id);
  await ops.addTask({ title: '태그 없음' });

  const s = await tagSummaries(db);
  // 이름순(한국어 정렬: 한글이 영문보다 앞). 'Home' 은 먼저 만든 할 일의 표기, 완료된 '집' 하나는 개수에서 빠진다
  assert.deepEqual(s, [
    { name: '업무', open: 1 },
    { name: '집', open: 1 },
    { name: 'Home', open: 2 },
  ]);
});

test('tagTasks: 그 태그의 미완료·완료 할 일을 프로젝트·기한과 관계없이 모은다 (대소문자 무시)', async () => {
  const { db, ops } = await setup();
  await ops.addTask({ title: '기한 있음', dueDate: '2026-11-20', tags: ['Home'] });
  await ops.addTask({ title: '기한 없음', tags: ['home'] });
  const c = await ops.addTask({ title: '끝낸 일', tags: ['HOME'] });
  await ops.addTask({ title: '딴 태그', tags: ['업무'] });
  const gone = await ops.addTask({ title: '삭제됨', tags: ['home'] });
  if (c.ok) await ops.toggleDone(c.task.id);
  if (gone.ok) await ops.deleteTask(gone.task.id);

  const r = await tagTasks(db, 'hOmE');
  assert.deepEqual(r.open.map((t) => t.title).sort(), ['기한 없음', '기한 있음']);
  assert.deepEqual(r.completed.map((t) => t.title), ['끝낸 일']);
  assert.deepEqual((await tagTasks(db, '없는태그')).open, []);
});

// ── 태그 일괄 변경 (이름 바꾸기·지우기·되돌리기) ──

import { getTask, listAllTasks } from '../../src/store/tasks.ts';

async function seedTags() {
  const { db, ops } = await setup();
  const mk = async (title: string, tags: string[], extra: Record<string, unknown> = {}) => {
    const r = await ops.addTask({ title, tags, ...extra });
    assert.equal(r.ok, true);
    return (r as { ok: true; task: { id: string } }).task.id;
  };
  return { db, ops, mk };
}
const tagsOfId = async (db: IDBDatabase, id: string) => (await getTask(db, id))!.tags;

test('태그 이름 바꾸기: 모든 할 일(완료 포함)의 그 태그가 새 이름이 되고, 대소문자·다른 태그·삭제된 할 일은 건드리지 않는다', async () => {
  const { db, ops, mk } = await seedTags();
  const a = await mk('가', ['집', '급함']);
  const b = await mk('나', ['HOME', '업무']);
  const c = await mk('다', ['집']);
  await ops.toggleDone(c); // 완료된 것도 바뀐다
  const d = await mk('라', ['집']);
  await ops.deleteTask(d); // 삭제된 것은 그대로
  const e = await mk('마', ['업무']);

  const before = (await getTask(db, a))!;
  const r = await ops.replaceTag('home', '집'); // 대소문자 무시
  assert.equal(r.ok, true);
  assert.equal((r as { count: number }).count, 1, 'b 만 HOME 을 가졌다 (a·c 는 이미 집)');
  assert.deepEqual(await tagsOfId(db, b), ['집', '업무']);
  assert.deepEqual(await tagsOfId(db, a), ['집', '급함'], '바뀌지 않은 것은 그대로');

  const r2 = await ops.replaceTag('집', '우리집');
  assert.equal((r2 as { count: number }).count, 3, 'a, b, 완료된 c');
  assert.deepEqual(await tagsOfId(db, a), ['우리집', '급함']);
  assert.deepEqual(await tagsOfId(db, b), ['우리집', '업무']);
  assert.deepEqual(await tagsOfId(db, c), ['우리집']);
  assert.deepEqual(await tagsOfId(db, d), ['집'], '삭제된 할 일은 건드리지 않는다');
  assert.deepEqual(await tagsOfId(db, e), ['업무']);

  const after = (await getTask(db, a))!;
  assert.ok(after.version > before.version, '바뀐 할 일은 새 버전이 되어 동기화된다');
  assert.equal(after.dirty, 1);
});

test('태그 이름 바꾸기: 이미 새 이름이 붙어 있으면 하나로 합치고, 대소문자만 바꾸는 것도 된다', async () => {
  const { db, ops, mk } = await seedTags();
  const a = await mk('가', ['a', 'b', 'c']);
  const r = await ops.replaceTag('a', 'B'); // a → B, 이미 b 가 있다 → 합쳐진다 (먼저 나온 표기를 남긴다: B)
  assert.equal((r as { count: number }).count, 1);
  assert.deepEqual(await tagsOfId(db, a), ['B', 'c']);

  const x = await mk('나', ['home']);
  assert.equal(((await ops.replaceTag('home', 'Home')) as { count: number }).count, 1, '대소문자만 달라도 바뀐다');
  assert.deepEqual(await tagsOfId(db, x), ['Home']);
  assert.equal(((await ops.replaceTag('Home', 'Home')) as { count: number }).count, 0, '같은 이름이면 아무것도 바꾸지 않는다');
});

test('태그 이름 바꾸기: 새 이름이 잘못되면 거부하고 아무것도 바꾸지 않는다', async () => {
  const { db, ops, mk } = await seedTags();
  const a = await mk('가', ['집']);
  for (const bad of ['', '  ', '#', '두 단어', 'a,b', '가'.repeat(31)]) {
    const r = await ops.replaceTag('집', bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal((r as { errors: { field: string }[] }).errors[0]!.field, 'tags');
  }
  assert.deepEqual(await tagsOfId(db, a), ['집']);
  assert.equal(((await ops.replaceTag('집', '#새이름')) as { ok: true }).ok, true, '앞의 # 는 떼고 받는다');
  assert.deepEqual(await tagsOfId(db, a), ['새이름']);
});

test('태그 지우기: 모든 할 일에서 그 태그만 빠지고 할 일은 남는다, 없는 태그는 0개', async () => {
  const { db, ops, mk } = await seedTags();
  const a = await mk('가', ['집', '급함']);
  const b = await mk('나', ['HOME']);
  const c = await mk('다', ['업무']);
  const r = await ops.replaceTag('home', null);
  assert.equal((r as { count: number }).count, 1);
  assert.deepEqual(await tagsOfId(db, b), []);
  assert.equal(((await ops.replaceTag('집', null)) as { count: number }).count, 1);
  assert.deepEqual(await tagsOfId(db, a), ['급함']);
  assert.deepEqual(await tagsOfId(db, c), ['업무']);
  assert.equal((await listAllTasks(db)).filter((t) => !t.deleted).length, 3, '할 일은 하나도 사라지지 않는다');
  assert.equal(((await ops.replaceTag('없는태그', null)) as { count: number }).count, 0);
  assert.deepEqual(await tagSummaries(db), [{ name: '급함', open: 1 }, { name: '업무', open: 1 }]);
});

test('태그 되돌리기: 이름 바꾸기·지우기를 이전 태그 그대로 되돌리고, 그 사이 삭제된 할 일은 건너뛴다', async () => {
  const { db, ops, mk } = await seedTags();
  const a = await mk('가', ['집', '급함']);
  const b = await mk('나', ['집']);
  const del = (await ops.replaceTag('집', null)) as { ok: true; count: number; previous: { id: string; tags: string[] }[] };
  assert.equal(del.count, 2);
  assert.deepEqual(await tagsOfId(db, a), ['급함']);
  assert.equal(await ops.restoreTags(del.previous), 2);
  assert.deepEqual(await tagsOfId(db, a), ['집', '급함'], '순서까지 그대로');
  assert.deepEqual(await tagsOfId(db, b), ['집']);

  const ren = (await ops.replaceTag('집', '새집')) as { ok: true; previous: { id: string; tags: string[] }[] };
  await ops.deleteTask(b);
  assert.equal(await ops.restoreTags(ren.previous), 1, '삭제된 b 는 되살리지 않는다');
  assert.deepEqual(await tagsOfId(db, a), ['집', '급함']);
  assert.equal((await getTask(db, b))!.deleted, true);
});

test('태그 일괄 변경: 옛 데이터(tags 필드 없음)가 섞여 있어도 동작한다', async () => {
  const { db, ops, mk } = await seedTags();
  const a = await mk('가', ['집']);
  const old = await mk('옛 할 일', []);
  const { tags: _t, ...legacy } = (await getTask(db, old))!;
  const tx = db.transaction('tasks', 'readwrite');
  tx.objectStore('tasks').put(legacy);
  await new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = () => rej(tx.error))));
  assert.equal(((await ops.replaceTag('집', '새집')) as { count: number }).count, 1);
  assert.deepEqual(await tagsOfId(db, a), ['새집']);
  assert.equal((await getTask(db, old))!.tags, undefined, '태그가 없던 할 일은 그대로');
});
