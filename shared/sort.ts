import type { Task } from './task.ts';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 끌어서 순서를 정한 할 일(순서 키가 있는 것)이 먼저, 그 순서대로. 둘 다 키가 없으면 0 */
function compareManual(a: Task, b: Task): number {
  const ka = a.sortKey ?? null;
  const kb = b.sortKey ?? null;
  if (ka === kb) return 0;
  if (ka === null) return 1;
  if (kb === null) return -1;
  return cmp(ka, kb);
}

/**
 * 직접 정한 순서(순서 키)가 있으면 그것이 먼저, 그 뒤에 나머지를
 * FR-012: 우선순위(1이 먼저) → 기한 시각(있는 것이 이른 순, 없는 것은 뒤) → 만든 순서 → id
 */
export function compareTasks(a: Task, b: Task): number {
  const m = compareManual(a, b);
  if (m !== 0) return m;
  return compareAuto(a, b);
}

function compareAuto(a: Task, b: Task): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.dueTime !== b.dueTime) {
    if (a.dueTime == null) return 1;
    if (b.dueTime == null) return -1;
    return cmp(a.dueTime, b.dueTime);
  }
  if (a.createdAt !== b.createdAt) return cmp(a.createdAt, b.createdAt);
  return cmp(a.id, b.id);
}

export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}

/** "기한 지남" 구분: 직접 정한 순서가 먼저, 나머지는 기한 날짜가 오래된 것이 먼저, 같으면 위 규칙 */
export function sortOverdue(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const m = compareManual(a, b);
    if (m !== 0) return m;
    const da = a.dueDate ?? '9999-99-99';
    const db = b.dueDate ?? '9999-99-99';
    return da !== db ? cmp(da, db) : compareAuto(a, b);
  });
}
