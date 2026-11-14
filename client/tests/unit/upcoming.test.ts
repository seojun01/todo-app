import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { upcomingView } from '../../src/views.ts';

let n = 0;
async function setup() {
  const db = await openTodoDb(`upcoming-test-${++n}`);
  let clock = new Date(2026, 10, 12, 9, 0, 0);
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => clock });
  return { db, ops: createTaskOps(ctx), tick: () => (clock = new Date(clock.getTime() + 1000)) };
}
const TODAY = '2026-11-12';
type Ops = Awaited<ReturnType<typeof setup>>['ops'];
async function add(ops: Ops, title: string, dueDate: string | null, priority: 1 | 2 | 3 | 4 = 4) {
  const r = await ops.addTask({ title, dueDate, priority });
  assert.equal(r.ok, true);
  return (r as { ok: true; task: { id: string } }).task;
}

test('오늘부터 그 주 토요일까지 날짜별로 묶는다 (목요일이면 목·금·토), 할 일이 없는 날도 그룹이다', async () => {
  const { db, ops } = await setup();
  await add(ops, '오늘 일', '2026-11-12');
  await add(ops, '내일 일', '2026-11-13');
  await add(ops, '닷새 뒤', '2026-11-17'); // 다음 주
  const days = await upcomingView(db, TODAY, 0);
  assert.deepEqual(days.map((d) => d.date), ['2026-11-12', '2026-11-13', '2026-11-14']);
  assert.deepEqual(days.map((d) => d.tasks.map((t) => t.title)), [['오늘 일'], ['내일 일'], []]);
});

test('오늘이 수요일이면 수~토 4일, 토요일이면 그날 하루, 일요일이면 일~토 한 주 전체가 나온다', async () => {
  const { db } = await setup();
  assert.deepEqual((await upcomingView(db, '2026-11-11', 0)).map((d) => d.date), ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  assert.deepEqual((await upcomingView(db, '2026-11-14', 0)).map((d) => d.date), ['2026-11-14']);
  assert.equal((await upcomingView(db, '2026-11-15', 0)).length, 7);
});

test('기한 지난 것·기한 없음·완료·삭제된 할 일은 포함하지 않는다 (오늘 할 일은 포함)', async () => {
  const { db, ops } = await setup();
  await add(ops, '오늘', '2026-11-12');
  await add(ops, '어제', '2026-11-11');
  await add(ops, '기한 없음', null);
  const done = await add(ops, '완료', '2026-11-14');
  await ops.toggleDone(done.id);
  const gone = await add(ops, '삭제', '2026-11-13');
  await ops.deleteTask(gone.id);
  await add(ops, '남는 것', '2026-11-13');
  const titles = (await upcomingView(db, TODAY, 0)).flatMap((d) => d.tasks.map((t) => t.title));
  assert.deepEqual(titles, ['오늘', '남는 것']);
});

test('page 를 올리면 일요일부터 토요일까지 한 주씩 이어진다', async () => {
  const { db, ops } = await setup();
  await add(ops, '다음 주 일요일', '2026-11-15');
  await add(ops, '다음 주 토요일', '2026-11-21');
  await add(ops, '다다음 주', '2026-11-22');
  const p1 = await upcomingView(db, TODAY, 1);
  assert.deepEqual(p1.map((d) => d.date), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
  assert.deepEqual(p1.flatMap((d) => d.tasks.map((t) => t.title)), ['다음 주 일요일', '다음 주 토요일']);
  const p2 = await upcomingView(db, TODAY, 2);
  assert.equal(p2[0]!.date, '2026-11-22');
  assert.equal(p2.length, 7);
  assert.deepEqual(p2.flatMap((d) => d.tasks.map((t) => t.title)), ['다다음 주']);
});

test('각 날짜 안에서는 우선순위 → 만든 순서로 정렬한다', async () => {
  const { db, ops, tick } = await setup();
  await add(ops, '보통', '2026-11-13', 4);
  tick();
  await add(ops, '긴급', '2026-11-13', 1);
  tick();
  await add(ops, '높음', '2026-11-13', 2);
  tick();
  await add(ops, '또 보통', '2026-11-13', 4);
  const day = (await upcomingView(db, TODAY, 0))[1]!; // 11/13
  assert.deepEqual(day.tasks.map((t) => t.title), ['긴급', '높음', '보통', '또 보통']);
});

test('월 경계를 넘어도 날짜가 올바르다', async () => {
  const { db } = await setup();
  const days = await upcomingView(db, '2026-11-28', 1);
  assert.deepEqual(days.map((d) => d.date), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05']);
});

test('반복 할 일의 앞으로의 회차가 ghosts 로 각 날짜에 들어간다 (실제 기한인 날은 tasks)', async () => {
  const { db, ops } = await setup();
  const r = await ops.addTask({ title: '매주 월수', dueDate: '2026-11-16', recurrence: { unit: 'week', interval: 1, weekdays: [1, 3] } });
  assert.equal(r.ok, true);
  const week2 = await upcomingView(db, TODAY, 1); // 11-15(일) ~ 11-21(토)
  const byDate = Object.fromEntries(week2.map((d) => [d.date, { tasks: d.tasks.map((t) => t.title), ghosts: d.ghosts.map((t) => t.title) }]));
  assert.deepEqual(byDate['2026-11-16'], { tasks: ['매주 월수'], ghosts: [] }, '실제 기한');
  assert.deepEqual(byDate['2026-11-18'], { tasks: [], ghosts: ['매주 월수'] }, '수요일은 가상 회차');
  assert.deepEqual(byDate['2026-11-17'], { tasks: [], ghosts: [] });
  const week3 = await upcomingView(db, TODAY, 2); // 11-22 ~ 11-28
  assert.deepEqual(week3.filter((d) => d.ghosts.length > 0).map((d) => d.date), ['2026-11-23', '2026-11-25']);
});
