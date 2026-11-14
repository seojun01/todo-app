import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTodoDb } from '../../src/store/db.ts';
import { createCtx } from '../../src/context.ts';
import { createTaskOps } from '../../src/tasks.ts';
import { recurringGhosts, summarizeMonth } from '../../src/views.ts';

let n = 0;
async function setup() {
  const db = await openTodoDb(`day-summary-${++n}`);
  const ctx = await createCtx(db, { deviceId: 'dev-a', now: () => new Date(2026, 10, 12, 9) });
  return { db, ops: createTaskOps(ctx) };
}
type Ops = Awaited<ReturnType<typeof setup>>['ops'];
async function add(ops: Ops, title: string, dueDate: string | null) {
  const r = await ops.addTask({ title, dueDate });
  assert.equal(r.ok, true);
  return (r as { ok: true; task: { id: string } }).task;
}

test('날짜별 total·remaining·allDone 을 계산한다 (완료한 일반 할 일도 total 에 포함)', async () => {
  const { db, ops } = await setup();
  await add(ops, 'a', '2026-11-20');
  await add(ops, 'b', '2026-11-20');
  const c = await add(ops, 'c', '2026-11-20');
  await ops.toggleDone(c.id);
  const d = await add(ops, 'd', '2026-11-21');
  const e = await add(ops, 'e', '2026-11-21');
  await ops.toggleDone(d.id);
  await ops.toggleDone(e.id);

  const m = await summarizeMonth(db, 2026, 11);
  const pick = ({ total, remaining, allDone }: { total: number; remaining: number; allDone: boolean }) => ({ total, remaining, allDone });
  assert.deepEqual(pick(m.get('2026-11-20')!), { total: 3, remaining: 2, allDone: false });
  assert.deepEqual(pick(m.get('2026-11-21')!), { total: 2, remaining: 0, allDone: true });
  assert.deepEqual(m.get('2026-11-21')!.preview, [], '모두 완료한 날은 미리보기가 없다');
  assert.equal(m.get('2026-11-22'), undefined, '할 일이 없는 날은 결과에 없다');
});

test('삭제된 할 일, 기한 없는 할 일, 다른 달의 할 일은 포함하지 않는다', async () => {
  const { db, ops } = await setup();
  const gone = await add(ops, '삭제', '2026-11-25');
  await ops.deleteTask(gone.id);
  await add(ops, '기한 없음', null);
  await add(ops, '10월 말', '2026-10-31');
  await add(ops, '12월 초', '2026-12-01');
  await add(ops, '11월 첫날', '2026-11-01');
  await add(ops, '11월 말일', '2026-11-30');
  const m = await summarizeMonth(db, 2026, 11);
  assert.deepEqual([...m.keys()].sort(), ['2026-11-01', '2026-11-30']);
});

test('반복 할 일: 실제 기한은 total·remaining 에 세고, 앞으로의 회차는 repeats 에만 담고 세지 않는다', async () => {
  const { db, ops } = await setup();
  // 월요일마다, 현재 기한 11-16(월). 오늘은 11-12
  const r = await ops.addTask({ title: '매주', dueDate: '2026-11-16', recurrence: { unit: 'week', interval: 1, weekdays: [1] } });
  assert.equal(r.ok, true);
  const m = await summarizeMonth(db, 2026, 11, '2026-11-12');
  assert.deepEqual([...m.keys()], ['2026-11-16', '2026-11-23', '2026-11-30']);
  const real = m.get('2026-11-16')!;
  assert.equal(real.remaining, 1);
  assert.deepEqual(real.preview.map((p) => p.title), ['매주']);
  assert.equal(real.repeatCount, 0, '실제 기한인 날은 가상 회차가 아니다');
  const later = m.get('2026-11-23')!;
  assert.deepEqual({ total: later.total, remaining: later.remaining, allDone: later.allDone }, { total: 0, remaining: 0, allDone: false });
  assert.deepEqual(later.repeats.map((p) => p.title), ['매주']);
  assert.equal(later.repeatCount, 1);
  assert.deepEqual(later.preview, []);
});

test('반복 할 일: 완료하면 기한이 다음 회차로 넘어가고 그 날짜가 실제 할 일이 된다 (가상 회차에서 빠진다)', async () => {
  const { db, ops } = await setup();
  const r = await ops.addTask({ title: '매일', dueDate: '2026-11-12', recurrence: { unit: 'day', interval: 1, endDate: '2026-11-15' } });
  const id = (r as { ok: true; task: { id: string } }).task.id;
  let m = await summarizeMonth(db, 2026, 11, '2026-11-12');
  assert.deepEqual([...m.keys()], ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'], '종료 날짜까지만');
  await ops.toggleDone(id); // 11-12 완료 → 기한 11-13
  m = await summarizeMonth(db, 2026, 11, '2026-11-12');
  assert.deepEqual([...m.keys()], ['2026-11-13', '2026-11-14', '2026-11-15']);
  assert.equal(m.get('2026-11-13')!.remaining, 1);
  assert.equal(m.get('2026-11-14')!.repeatCount, 1);
});

test('반복 할 일: 완료·삭제된 것, 기한 없는 것, 반복 아닌 것은 가상 회차를 만들지 않는다', async () => {
  const { db, ops } = await setup();
  const rule = { unit: 'day' as const, interval: 1 };
  const mk = async (title: string, over: Record<string, unknown>) => {
    const r = await ops.addTask({ title, ...over });
    return (r as { ok: true; task: { id: string } }).task;
  };
  const done = await mk('끝', { dueDate: '2026-11-20', recurrence: { unit: 'day', interval: 1, endDate: '2026-11-20' } });
  await ops.toggleDone(done.id); // 종료 날짜라 완료 상태가 된다
  const gone = await mk('삭제', { dueDate: '2026-11-20', recurrence: rule });
  await ops.deleteTask(gone.id);
  await mk('일반', { dueDate: '2026-11-20' });
  const m = await summarizeMonth(db, 2026, 11, '2026-11-12');
  assert.deepEqual([...m.keys()], ['2026-11-20']);
  assert.equal(m.get('2026-11-20')!.repeatCount, 0);
});

test('반복 할 일: 기한이 지난 반복은 오늘 이후부터 가상 회차를 만든다', async () => {
  const { db, ops } = await setup();
  await ops.addTask({ title: '밀린 매일', dueDate: '2026-11-09', recurrence: { unit: 'day', interval: 1 } });
  const m = await summarizeMonth(db, 2026, 11, '2026-11-12');
  const withRepeats = [...m.entries()].filter(([, v]) => v.repeatCount > 0).map(([k]) => k);
  assert.equal(withRepeats[0], '2026-11-13', '완료하면 내일로 넘어가므로 내일부터');
  assert.ok(!withRepeats.some((d) => d <= '2026-11-12'));
  assert.ok(m.has('2026-11-09'), '실제 기한은 그대로 남아 있다');
});

test('달 경계(2월 윤년·12월)도 올바른 범위를 쓴다', async () => {
  const { db, ops } = await setup();
  await add(ops, '윤일', '2028-02-29');
  await add(ops, '3월 1일', '2028-03-01');
  await add(ops, '연말', '2026-12-31');
  assert.deepEqual([...(await summarizeMonth(db, 2028, 2)).keys()], ['2028-02-29']);
  assert.deepEqual([...(await summarizeMonth(db, 2026, 12)).keys()], ['2026-12-31']);
});

test('미리보기: 남은 할 일만, 최대 3개, 그날 목록과 같은 순서(우선순위 → 시각 → 만든 순서)이고 시각을 담는다', async () => {
  const { db, ops } = await setup();
  const mk = async (title: string, extra: Record<string, unknown> = {}) => {
    const r = await ops.addTask({ title, dueDate: '2026-11-20', ...extra });
    assert.equal(r.ok, true);
    return (r as { ok: true; task: { id: string } }).task;
  };
  await mk('보통 늦게', { dueTime: '18:00' });
  await mk('보통 일찍', { dueTime: '08:30' });
  await mk('긴급', { priority: 1 });
  await mk('시각 없음');
  const done = await mk('끝낸 일', { priority: 1 });
  await ops.toggleDone(done.id);

  const s = (await summarizeMonth(db, 2026, 11)).get('2026-11-20')!;
  assert.equal(s.total, 5);
  assert.equal(s.remaining, 4);
  assert.deepEqual(s.preview, [
    { title: '긴급', priority: 1, time: null },
    { title: '보통 일찍', priority: 4, time: '08:30' },
    { title: '보통 늦게', priority: 4, time: '18:00' },
  ]);
  assert.equal(s.preview.length, 3, '네 번째 "시각 없음"은 +1개로만 센다 (remaining - preview.length)');
});

test('미리보기: 할 일이 3개 이하면 전부 보이고, 하나 완료하면 빠진다', async () => {
  const { db, ops } = await setup();
  const a = await add(ops, 'a', '2026-11-22');
  await add(ops, 'b', '2026-11-22');
  assert.deepEqual((await summarizeMonth(db, 2026, 11)).get('2026-11-22')!.preview.map((p) => p.title).sort(), ['a', 'b']); // 같은 시각에 만들어 순서는 id 로 갈린다
  await ops.toggleDone(a.id);
  assert.deepEqual((await summarizeMonth(db, 2026, 11)).get('2026-11-22')!.preview.map((p) => p.title), ['b']);
});

test('recurringGhosts: 날짜별로 모으고 같은 날에는 그날 목록과 같은 순서(우선순위)로 정렬한다', async () => {
  const { db, ops } = await setup();
  const daily = { unit: 'day' as const, interval: 1 };
  await ops.addTask({ title: '보통', dueDate: '2026-11-12', recurrence: daily });
  await ops.addTask({ title: '긴급', dueDate: '2026-11-12', priority: 1, recurrence: daily });
  const g = await recurringGhosts(db, '2026-11-12', '2026-11-13', '2026-11-14');
  assert.deepEqual([...g.keys()], ['2026-11-13', '2026-11-14']);
  assert.deepEqual(g.get('2026-11-13')!.map((t) => t.title), ['긴급', '보통']);
  assert.deepEqual([...(await recurringGhosts(db, '2026-11-12', '2026-11-12', '2026-11-12')).keys()], [], '당일 범위에는 가상 회차가 없다');
});
