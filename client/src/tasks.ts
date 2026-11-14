// 할 일 도메인 연산. 검증은 shared/task.ts, 버전은 HLC, 저장은 IndexedDB.
// 저장 트랜잭션이 complete 되기 전에는 성공을 돌려주지 않는다 (FR-011). 저장 실패는 reject 한다.
import { addDays, toDateString } from '../../shared/calendar.ts';
import { canonicalRule, firstOccurrenceOnOrAfter, nextOccurrence } from '../../shared/recurrence.ts';
import {
  INBOX_ID,
  isValidTag,
  normalizeTags,
  tagKey,
  tagsOf,
  validateTask,
  validateTitle,
  type CalendarDate,
  type ClockTime,
  type FieldError,
  type Priority,
  type Recurrence,
  type ReminderKind,
  type Task,
} from '../../shared/task.ts';
import type { Ctx } from './context.ts';
import { commit } from './store/db.ts';
import { getTask, listAllTasks, listTasksByDueRange, type StoredTask } from './store/tasks.ts';

export type OpResult = { ok: true; task: StoredTask } | { ok: false; errors: FieldError[] };

export interface AddInput {
  title: string;
  dueDate?: CalendarDate | null;
  dueTime?: ClockTime | null;
  projectId?: string;
  priority?: Priority;
  recurrence?: Recurrence | null;
  reminders?: ReminderKind[];
  tags?: string[];
}

export type EditChanges = Partial<
  Pick<Task, 'title' | 'dueDate' | 'dueTime' | 'projectId' | 'priority' | 'recurrence' | 'reminders' | 'tags'>
>;

/** 태그를 일괄로 바꾸기 전의 한 할 일의 태그 (되돌리기용) */
export interface TagSnapshot {
  id: string;
  tags: string[];
}

export type ReplaceTagResult = { ok: true; count: number; previous: TagSnapshot[] } | { ok: false; errors: FieldError[] };

export interface TaskOps {
  addTask(input: AddInput): Promise<OpResult>;
  editTask(id: string, changes: EditChanges): Promise<OpResult>;
  toggleDone(id: string): Promise<OpResult>;
  deleteTask(id: string): Promise<OpResult>;
  /** 가장 최근에 삭제한 1건을 되돌린다. 되돌릴 것이 없으면 null */
  undoDelete(): Promise<OpResult | null>;
  /** 가장 최근에 완료한 반복 할 일의 기한을 완료 전으로 되돌린다. 되돌릴 것이 없으면 null (FR-018) */
  undoComplete(): Promise<OpResult | null>;
  /** 기한이 지난 미완료 할 일의 기한을 오늘로 옮기고, 옮긴 개수를 돌려준다 (FR-002) */
  moveOverdueToToday(today: CalendarDate): Promise<number>;
  /**
   * 모든 할 일(완료 포함, 삭제된 것 제외)에서 태그 from(대소문자 무시)을 to 로 바꾼다. to 가 null 이면 태그를 뗀다.
   * 이미 to 가 붙어 있는 할 일은 하나로 합쳐진다. 바뀐 할 일마다 새 버전이 되어 동기화된다.
   */
  replaceTag(from: string, to: string | null): Promise<ReplaceTagResult>;
  /** replaceTag 가 돌려준 previous 대로 태그를 되돌리고, 되돌린 개수를 돌려준다 (그 사이 삭제된 할 일은 건너뛴다) */
  restoreTags(previous: TagSnapshot[]): Promise<number>;
}

const notFound = (): OpResult => ({ ok: false, errors: [{ field: 'id', rule: 'not-found' }] });

export function createTaskOps(ctx: Ctx): TaskOps {
  /** 삭제 직전 상태. 메모리에만 두며 가장 최근 1건이다 (삭제한 그 기기에서만 되돌릴 수 있다). */
  let lastDeleted: StoredTask | null = null;
  /** 반복 할 일을 완료하기 직전 상태 (실행 취소용) */
  let lastCompleted: StoredTask | null = null;

  const stamp = () => ({ version: ctx.hlc.next(), updatedBy: ctx.deviceId });

  async function save(task: Task): Promise<StoredTask> {
    const stored: StoredTask = { ...task, dirty: 1 };
    await commit(ctx.db, { tasks: [stored], meta: { hlc: ctx.hlc.state() } });
    return stored;
  }

  async function load(id: string): Promise<StoredTask | undefined> {
    const t = await getTask(ctx.db, id);
    return t && !t.deleted ? t : undefined;
  }

  return {
    async addTask(input) {
      const title = validateTitle(input.title);
      if (!title.ok) return title;
      const dueDate = input.dueDate ?? null;
      const candidate: Task = {
        id: crypto.randomUUID(),
        title: title.value,
        dueDate,
        dueTime: input.dueTime ?? null,
        projectId: input.projectId ?? INBOX_ID,
        priority: input.priority ?? 4,
        recurrence: input.recurrence ?? null,
        reminders: [...(input.reminders ?? [])],
        tags: normalizeTags(input.tags ?? []),
        done: false,
        createdAt: ctx.now().toISOString(),
        deleted: false,
        ...stamp(),
      };
      const errors = validateTask(candidate);
      if (errors.length) return { ok: false, errors };
      return { ok: true, task: await save(candidate) };
    },

    async editTask(id, changes) {
      const current = await load(id);
      if (!current) return notFound();
      const { dirty: _dirty, ...base } = current;
      const candidate: Task = { ...base, ...changes };
      if (changes.title !== undefined) {
        const t = validateTitle(changes.title);
        if (!t.ok) return t;
        candidate.title = t.value;
      }
      if (changes.tags !== undefined) candidate.tags = normalizeTags(changes.tags);
      if (changes.dueDate === null) {
        // 기한을 없애면 기한에 딸린 시각·반복·알림도 함께 없앤다
        candidate.dueTime = null;
        candidate.recurrence = null;
        candidate.reminders = [];
      }
      // 반복을 지정하거나 규칙을 바꾸면 기한을 규칙에 맞는 첫 날짜로 맞춘다 (FR-017).
      // 기한만 직접 바꾼 경우에는 그대로 둔다 — 그 날짜가 새 기준이 된다 (FR-021).
      const ruleChanged = 'recurrence' in changes && canonicalRule(changes.recurrence) !== canonicalRule(current.recurrence);
      if (ruleChanged && candidate.recurrence && candidate.dueDate) {
        candidate.dueDate = firstOccurrenceOnOrAfter(candidate.recurrence, candidate.dueDate);
      }
      const errors = validateTask({ ...candidate, ...stamp() });
      if (errors.length) return { ok: false, errors };
      return { ok: true, task: await save({ ...candidate, ...stamp() }) };
    },

    async toggleDone(id) {
      const current = await load(id);
      if (!current) return notFound();
      const { dirty: _dirty, ...base } = current;
      if (current.recurrence && current.dueDate && !current.done) {
        // 반복 할 일: 완료하면 미완료로 남은 채 기한이 다음 회차로 넘어간다. 완료는 레코드 전체의 교체이므로
        // 두 기기가 같은 회차를 완료해도 레코드 하나만 남아 한 회차만 넘어간다 (FR-033).
        const next = nextOccurrence(current.recurrence, current.dueDate, toDateString(ctx.now()));
        lastCompleted = current;
        return { ok: true, task: await save(next ? { ...base, dueDate: next, ...stamp() } : { ...base, done: true, ...stamp() }) };
      }
      return { ok: true, task: await save({ ...base, done: !current.done, ...stamp() }) };
    },

    async deleteTask(id) {
      const current = await load(id);
      if (!current) return notFound();
      const { dirty: _dirty, ...base } = current;
      lastDeleted = current;
      return { ok: true, task: await save({ ...base, deleted: true, ...stamp() }) };
    },

    async undoDelete() {
      if (!lastDeleted) return null;
      const { dirty: _dirty, ...base } = lastDeleted;
      lastDeleted = null;
      return { ok: true, task: await save({ ...base, deleted: false, ...stamp() }) };
    },

    async undoComplete() {
      if (!lastCompleted) return null;
      const { dirty: _dirty, ...base } = lastCompleted;
      lastCompleted = null;
      return { ok: true, task: await save({ ...base, ...stamp() }) };
    },

    async replaceTag(from, to) {
      const [target] = to === null ? [null] : normalizeTags([to]);
      if (target !== null && !isValidTag(target)) return { ok: false, errors: [{ field: 'tags', rule: 'format' }] };
      const key = tagKey(from);
      const changed: StoredTask[] = [];
      const previous: TagSnapshot[] = [];
      for (const t of await listAllTasks(ctx.db)) {
        const have = tagsOf(t);
        if (t.deleted || !have.some((x) => tagKey(x) === key)) continue;
        const next = target === null ? have.filter((x) => tagKey(x) !== key) : normalizeTags(have.map((x) => (tagKey(x) === key ? target : x)));
        if (next.length === have.length && next.every((x, i) => x === have[i])) continue; // 바뀌지 않는다 (이름이 같다)
        const { dirty: _dirty, ...base } = t;
        const candidate: Task = { ...base, tags: next, ...stamp() };
        const errors = validateTask(candidate);
        if (errors.length) return { ok: false, errors };
        previous.push({ id: t.id, tags: have });
        changed.push({ ...candidate, dirty: 1 });
      }
      if (changed.length > 0) await commit(ctx.db, { tasks: changed, meta: { hlc: ctx.hlc.state() } });
      return { ok: true, count: changed.length, previous };
    },

    async restoreTags(previous) {
      const restored: StoredTask[] = [];
      for (const { id, tags } of previous) {
        const cur = await load(id);
        if (!cur) continue;
        const { dirty: _dirty, ...base } = cur;
        restored.push({ ...base, tags: [...tags], ...stamp(), dirty: 1 });
      }
      if (restored.length > 0) await commit(ctx.db, { tasks: restored, meta: { hlc: ctx.hlc.state() } });
      return restored.length;
    },

    async moveOverdueToToday(today) {
      const overdue = (await listTasksByDueRange(ctx.db, '0001-01-01', addDays(today, -1))).filter((t) => !t.done && !t.deleted);
      if (overdue.length === 0) return 0;
      const moved: StoredTask[] = overdue.map((t) => {
        const { dirty: _dirty, ...base } = t;
        // 반복의 종료 날짜가 오늘보다 앞이면 종료 날짜도 오늘로 맞춘다 (종료 날짜는 기한보다 빠를 수 없다)
        const recurrence =
          base.recurrence?.endDate && base.recurrence.endDate < today ? { ...base.recurrence, endDate: today } : base.recurrence;
        return { ...base, dueDate: today, recurrence, ...stamp(), dirty: 1 };
      });
      for (const t of moved) {
        const errors = validateTask(t);
        if (errors.length) throw new Error(`기한 이동 검증 실패: ${JSON.stringify(errors)}`);
      }
      await commit(ctx.db, { tasks: moved, meta: { hlc: ctx.hlc.state() } });
      return moved.length;
    },
  };
}
