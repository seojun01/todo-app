import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTasks, sortTasks, sortOverdue } from '../sort.ts';
import type { Task } from '../task.ts';

let n = 0;
function t(over: Partial<Task>): Task {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: `t${n}`,
    dueDate: '2026-11-20',
    dueTime: null,
    projectId: 'inbox',
    priority: 4,
    recurrence: null,
    reminders: [],
    done: false,
    createdAt: `2026-11-12T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    deleted: false,
    version: 'v',
    updatedBy: 'd',
    ...over,
  };
}
const titles = (xs: Task[]) => xs.map((x) => x.title);

test('우선순위 오름차순(1이 먼저)', () => {
  const a = t({ title: 'p4', priority: 4 });
  const b = t({ title: 'p1', priority: 1 });
  const c = t({ title: 'p2', priority: 2 });
  assert.deepEqual(titles(sortTasks([a, b, c])), ['p1', 'p2', 'p4']);
});

test('같은 우선순위면 기한 시각이 이른 순, 시각이 없는 것은 그 뒤', () => {
  const none = t({ title: 'none', priority: 2 });
  const late = t({ title: '15:00', priority: 2, dueTime: '15:00' });
  const early = t({ title: '09:30', priority: 2, dueTime: '09:30' });
  assert.deepEqual(titles(sortTasks([none, late, early])), ['09:30', '15:00', 'none']);
});

test('그래도 같으면 먼저 만든 순, 그다음 id', () => {
  const older = t({ title: 'older', createdAt: '2026-11-01T00:00:00.000Z' });
  const newer = t({ title: 'newer', createdAt: '2026-11-02T00:00:00.000Z' });
  assert.deepEqual(titles(sortTasks([newer, older])), ['older', 'newer']);
  const same1 = t({ title: 's1', createdAt: '2026-11-03T00:00:00.000Z', id: '00000000-0000-4000-8000-00000000000a' });
  const same2 = t({ title: 's2', createdAt: '2026-11-03T00:00:00.000Z', id: '00000000-0000-4000-8000-00000000000b' });
  assert.deepEqual(titles(sortTasks([same2, same1])), ['s1', 's2']);
});

test('우선순위가 시각보다 먼저다', () => {
  const urgentNoTime = t({ title: 'urgent', priority: 1 });
  const normalEarly = t({ title: 'early', priority: 3, dueTime: '06:00' });
  assert.deepEqual(titles(sortTasks([normalEarly, urgentNoTime])), ['urgent', 'early']);
});

test('기한 지남 구분은 dueDate 오름차순을 앞에 붙인 뒤 같은 규칙', () => {
  const d3 = t({ title: 'd3-p1', dueDate: '2026-11-18', priority: 1 });
  const d1 = t({ title: 'd1-p4', dueDate: '2026-11-10', priority: 4 });
  const d1b = t({ title: 'd1-p2', dueDate: '2026-11-10', priority: 2 });
  assert.deepEqual(titles(sortOverdue([d3, d1, d1b])), ['d1-p2', 'd1-p4', 'd3-p1']);
});

test('정렬은 입력 배열을 바꾸지 않고 안정적이다', () => {
  const a = t({ title: 'a' });
  const b = t({ title: 'b' });
  const input = [b, a];
  const snapshot = [...input];
  sortTasks(input);
  assert.deepEqual(input, snapshot);
  assert.equal(compareTasks(a, a), 0);
});

test('직접 정한 순서(sortKey)가 있는 할 일이 먼저, 그 순서대로 — 우선순위보다 앞선다. 키가 없는 것은 그 뒤에 자동 정렬', () => {
  const a = t({ title: 'p1-no-key', priority: 1 });
  const b = t({ title: 'p4-key-2', priority: 4, sortKey: '2' });
  const c = t({ title: 'p3-key-1', priority: 3, sortKey: '1' });
  const d = t({ title: 'p4-no-key', priority: 4 });
  assert.deepEqual(titles(sortTasks([d, a, b, c])), ['p3-key-1', 'p4-key-2', 'p1-no-key', 'p4-no-key']);
});

test('기한 지남: 직접 정한 순서가 날짜보다 먼저', () => {
  const old = t({ title: 'old', dueDate: '2026-11-01' });
  const newer = t({ title: 'newer-key', dueDate: '2026-11-10', sortKey: 'i' });
  assert.deepEqual(titles(sortOverdue([old, newer])), ['newer-key', 'old']);
});
