// 할 일 조회·변경 연산. 앱(client/src/tasks.ts)과 같은 규칙을 shared/ 코드로 그대로 쓴다:
// 검증(validateTask), 반복 완료(nextOccurrence), 버전(HLC). 그래서 앱에서 한 것과 똑같이 동기화된다.
import { randomUUID } from 'node:crypto';
import { addDays } from '../../shared/calendar.ts';
import { createHlc } from '../../shared/hlc.ts';
import { canonicalRule, describeRecurrence, firstOccurrenceOnOrAfter, nextOccurrence } from '../../shared/recurrence.ts';
import { remapReminders } from '../../shared/reminders.ts';
import { compareTasks, sortOverdue } from '../../shared/sort.ts';
import {
  INBOX_ID,
  effectiveProjectId,
  normalizeTags,
  tagKey,
  tagsOf,
  validateTask,
  validateTitle,
  type FieldError,
  type Priority,
  type Project,
  type Recurrence,
  type ReminderKind,
  type Task,
} from '../../shared/task.ts';
import { ApiError, type Snapshot, type TodoClient } from './client.ts';

export interface Ctx {
  client: TodoClient;
  deviceId: string;
  now: () => Date;
  /** "오늘"을 계산할 시간대 (IANA) */
  tz: string;
}

export type Args = Record<string, unknown>;

/** 사용자(모델)에게 그대로 보여 줄 수 있는 오류 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// ── 입력 읽기 ───────────────────────────────────────────────────────

const has = (a: Args, k: string) => Object.prototype.hasOwnProperty.call(a, k);

function reqString(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== 'string' || v.trim() === '') throw new ToolError(`${k} 는 비어 있지 않은 문자열이어야 해요`);
  return v;
}

/** 없으면 undefined, null 이면 null (값을 지우는 뜻). 빈 문자열도 null 로 본다 */
function optNullableString(a: Args, k: string): string | null | undefined {
  if (!has(a, k) || a[k] === undefined) return undefined;
  const v = a[k];
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new ToolError(`${k} 는 문자열이거나 null 이어야 해요`);
  return v;
}

function optString(a: Args, k: string): string | undefined {
  if (!has(a, k) || a[k] === undefined || a[k] === null) return undefined;
  if (typeof a[k] !== 'string') throw new ToolError(`${k} 는 문자열이어야 해요`);
  return a[k];
}

function optInt(a: Args, k: string, lo: number, hi: number): number | undefined {
  if (!has(a, k) || a[k] === undefined || a[k] === null) return undefined;
  const v = a[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new ToolError(`${k} 는 ${lo}~${hi} 사이의 정수여야 해요`);
  return v;
}

function optStringList(a: Args, k: string): string[] | undefined {
  if (!has(a, k) || a[k] === undefined) return undefined;
  const v = a[k];
  if (v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ToolError(`${k} 는 문자열 목록이어야 해요`);
  return v as string[];
}

function parseRecurrence(v: unknown): Recurrence | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError('recurrence 는 객체이거나 null 이어야 해요');
  const r = v as Record<string, unknown>;
  const out = { unit: r.unit, interval: r.interval ?? 1 } as Recurrence;
  if (r.weekdays !== undefined) out.weekdays = r.weekdays as number[];
  if (r.day_of_month !== undefined) out.dayOfMonth = r.day_of_month as number;
  if (r.month !== undefined) out.month = r.month as number;
  if (r.end_date !== undefined) out.endDate = r.end_date as string;
  return out;
}

const FIELD_NAMES: Record<string, string> = {
  dueDate: 'due_date',
  dueTime: 'due_time',
  projectId: 'project',
  createdAt: 'created_at',
};

function invalid(errors: readonly FieldError[]): ToolError {
  const list = errors.map((e) => `${FIELD_NAMES[e.field] ?? e.field}: ${e.rule}`).join(', ');
  return new ToolError(`입력값이 올바르지 않아요 → ${list}`);
}

// ── 읽기 모델 ───────────────────────────────────────────────────────

/** 시간대 기준의 오늘 날짜 (YYYY-MM-DD) */
export function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

interface Loaded {
  snap: Snapshot;
  projects: Project[];
  today: string;
}

async function load(ctx: Ctx): Promise<Loaded> {
  const snap = await ctx.client.pullAll();
  return { snap, projects: [...snap.projects.values()], today: todayIn(ctx.tz, ctx.now()) };
}

const projectName = (t: Task, projects: Project[]): string => {
  const id = effectiveProjectId(t, projects);
  return id === INBOX_ID ? '수신함' : (projects.find((p) => p.id === id)?.name ?? '수신함');
};

function view(t: Task, L: Loaded) {
  return {
    id: t.id,
    title: t.title,
    due: t.dueDate ? (t.dueTime ? `${t.dueDate} ${t.dueTime}` : t.dueDate) : null,
    priority: t.priority,
    project: projectName(t, L.projects),
    tags: tagsOf(t),
    done: t.done,
    ...(t.recurrence ? { repeat: describeRecurrence(t.recurrence) } : {}),
    ...(t.reminders.length > 0 ? { reminders: t.reminders } : {}),
    ...(!t.done && t.dueDate !== null && t.dueDate < L.today ? { overdue: true } : {}),
  };
}

function liveTasks(L: Loaded): Task[] {
  return [...L.snap.tasks.values()].filter((t) => !t.deleted);
}

/** "inbox"·"수신함"·프로젝트 이름(대소문자 무시)·id 로 프로젝트를 찾는다 */
function resolveProject(name: string, projects: Project[]): string {
  const key = name.trim().toLowerCase();
  if (key === INBOX_ID || key === '수신함') return INBOX_ID;
  const active = projects.filter((p) => !p.deleted);
  const hit = active.find((p) => p.id.toLowerCase() === key) ?? active.find((p) => p.name.toLowerCase() === key);
  if (hit) return hit.id;
  const names = ['수신함', ...active.map((p) => p.name)].join(', ');
  throw new ToolError(`없는 프로젝트예요: "${name}". 사용할 수 있는 프로젝트: ${names}`);
}

function findTask(L: Loaded, key: string): Task {
  const k = key.trim().toLowerCase();
  const live = liveTasks(L);
  const exact = live.find((t) => t.id.toLowerCase() === k);
  if (exact) return exact;
  if (k.length >= 8) {
    const m = live.filter((t) => t.id.toLowerCase().startsWith(k));
    if (m.length === 1) return m[0]!;
    if (m.length > 1) throw new ToolError('id 앞부분이 여러 할 일과 겹쳐요. 전체 id 를 쓰세요');
  }
  throw new ToolError(`그런 할 일이 없어요: ${key}`);
}

// ── 조회 도구 ───────────────────────────────────────────────────────

const SCOPES = ['today', 'upcoming', 'overdue', 'no_date', 'all'] as const;

export async function listTasks(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const scope = optString(a, 'scope') ?? 'today';
  if (!(SCOPES as readonly string[]).includes(scope)) throw new ToolError(`scope 는 ${SCOPES.join(' | ')} 중 하나여야 해요`);
  const includeDone = a.include_completed === true;
  const days = optInt(a, 'days', 1, 90) ?? 7;
  const limit = optInt(a, 'limit', 1, 200) ?? 50;
  const projectArg = optString(a, 'project');
  const tagArg = optString(a, 'tag');

  let tasks = liveTasks(L).filter((t) => includeDone || !t.done);
  if (projectArg !== undefined) {
    const pid = resolveProject(projectArg, L.projects);
    tasks = tasks.filter((t) => effectiveProjectId(t, L.projects) === pid);
  }
  if (tagArg !== undefined) {
    const key = tagKey(tagArg.replace(/^#+/, ''));
    tasks = tasks.filter((t) => tagsOf(t).some((x) => tagKey(x) === key));
  }

  const due = (t: Task) => t.dueDate;
  let sorted: Task[];
  switch (scope) {
    case 'today': {
      const overdue = sortOverdue(tasks.filter((t) => due(t) !== null && due(t)! < L.today));
      const todays = tasks.filter((t) => due(t) === L.today).sort(compareTasks);
      sorted = [...overdue, ...todays];
      break;
    }
    case 'upcoming': {
      const end = addDays(L.today, days);
      sorted = tasks
        .filter((t) => due(t) !== null && due(t)! > L.today && due(t)! <= end)
        .sort((x, y) => (x.dueDate! < y.dueDate! ? -1 : x.dueDate! > y.dueDate! ? 1 : compareTasks(x, y)));
      break;
    }
    case 'overdue':
      sorted = sortOverdue(tasks.filter((t) => due(t) !== null && due(t)! < L.today));
      break;
    case 'no_date':
      sorted = tasks.filter((t) => due(t) === null).sort(compareTasks);
      break;
    default:
      sorted = [...tasks].sort((x, y) => {
        const dx = x.dueDate ?? '9999-99-99';
        const dy = y.dueDate ?? '9999-99-99';
        return dx < dy ? -1 : dx > dy ? 1 : compareTasks(x, y);
      });
  }
  return { today: L.today, scope, total: sorted.length, shown: Math.min(sorted.length, limit), tasks: sorted.slice(0, limit).map((t) => view(t, L)) };
}

export async function searchTasks(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const query = reqString(a, 'query').trim().toLowerCase();
  const includeDone = a.include_completed === true;
  const limit = optInt(a, 'limit', 1, 200) ?? 50;
  const hits = liveTasks(L)
    .filter((t) => (includeDone || !t.done) && (t.title.toLowerCase().includes(query) || tagsOf(t).some((x) => tagKey(x) === tagKey(query.replace(/^#+/, '')))))
    .sort((x, y) => {
      const dx = x.dueDate ?? '9999-99-99';
      const dy = y.dueDate ?? '9999-99-99';
      return dx < dy ? -1 : dx > dy ? 1 : compareTasks(x, y);
    });
  return { today: L.today, total: hits.length, shown: Math.min(hits.length, limit), tasks: hits.slice(0, limit).map((t) => view(t, L)) };
}

export async function listProjects(ctx: Ctx): Promise<unknown> {
  const L = await load(ctx);
  const open = liveTasks(L).filter((t) => !t.done);
  const count = (pid: string) => open.filter((t) => effectiveProjectId(t, L.projects) === pid).length;
  return {
    projects: [
      { name: '수신함', id: INBOX_ID, open_tasks: count(INBOX_ID) },
      ...L.projects.filter((p) => !p.deleted).map((p) => ({ name: p.name, id: p.id, color: p.color, open_tasks: count(p.id) })),
    ],
  };
}

// ── 변경 도구 ───────────────────────────────────────────────────────

async function pushOne(ctx: Ctx, record: Task): Promise<void> {
  let result;
  try {
    result = await ctx.client.push([{ type: 'task', record }]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && Array.isArray(err.details)) {
      throw invalid((err.details as { field: string; rule: string }[]).map((d) => ({ field: d.field, rule: d.rule })));
    }
    throw err;
  }
  if (result.applied !== 1) {
    throw new ToolError('다른 기기에서 그 사이에 먼저 바뀌어서 반영되지 않았어요. 목록을 다시 확인하고 다시 시도해 주세요.');
  }
}

export async function addTask(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const title = validateTitle(reqString(a, 'title'));
  if (!title.ok) throw invalid(title.errors);
  const dueDate = optNullableString(a, 'due_date') ?? null;
  const dueTime = optNullableString(a, 'due_time') ?? null;
  const projectArg = optString(a, 'project');
  const recurrence = has(a, 'recurrence') ? parseRecurrence(a.recurrence ?? null) : null;
  const hlc = createHlc(ctx.deviceId);
  const task: Task = {
    id: randomUUID(),
    title: title.value,
    dueDate,
    dueTime,
    projectId: projectArg !== undefined ? resolveProject(projectArg, L.projects) : INBOX_ID,
    priority: (optInt(a, 'priority', 1, 4) ?? 4) as Priority,
    recurrence,
    reminders: (optStringList(a, 'reminders') ?? []) as ReminderKind[],
    tags: normalizeTags(optStringList(a, 'tags') ?? []),
    done: false,
    createdAt: ctx.now().toISOString(),
    deleted: false,
    version: hlc.next(),
    updatedBy: ctx.deviceId,
  };
  const errors = validateTask(task);
  if (errors.length) throw invalid(errors);
  await pushOne(ctx, task);
  return { added: view(task, L) };
}

export async function updateTask(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const current = findTask(L, reqString(a, 'id'));
  const candidate: Task = { ...current };

  const title = optNullableString(a, 'title');
  if (title !== undefined) {
    if (title === null) throw new ToolError('title 은 비울 수 없어요');
    const t = validateTitle(title);
    if (!t.ok) throw invalid(t.errors);
    candidate.title = t.value;
  }
  const dueDate = optNullableString(a, 'due_date');
  if (dueDate !== undefined) candidate.dueDate = dueDate;
  const dueTime = optNullableString(a, 'due_time');
  if (dueTime !== undefined) candidate.dueTime = dueTime;
  const priority = optInt(a, 'priority', 1, 4);
  if (priority !== undefined) candidate.priority = priority as Priority;
  const projectArg = optString(a, 'project');
  if (projectArg !== undefined) candidate.projectId = resolveProject(projectArg, L.projects);
  const tags = optStringList(a, 'tags');
  if (tags !== undefined) candidate.tags = normalizeTags(tags);
  const reminders = optStringList(a, 'reminders');
  if (reminders !== undefined) candidate.reminders = reminders as ReminderKind[];
  if (has(a, 'recurrence')) candidate.recurrence = parseRecurrence(a.recurrence ?? null);

  const changed = ['title', 'due_date', 'due_time', 'priority', 'project', 'tags', 'reminders', 'recurrence'].some((k) => has(a, k));
  if (!changed) throw new ToolError('바꿀 항목이 없어요 (title, due_date, due_time, priority, project, tags, reminders, recurrence 중 하나 이상)');

  if (dueDate === null) {
    // 기한을 없애면 기한에 딸린 시각·반복·알림도 함께 없앤다 (앱과 같은 규칙)
    candidate.dueTime = null;
    candidate.recurrence = null;
    candidate.reminders = [];
  }
  // 시각을 더하거나 없애면 알림 종류를 맞춘다 (앱의 편집 화면과 같은 규칙)
  if (reminders === undefined && dueDate !== null && (current.dueTime !== null) !== (candidate.dueTime !== null)) {
    candidate.reminders = remapReminders(current.reminders, current.dueTime !== null, candidate.dueTime !== null).reminders;
  }
  // 반복 규칙을 바꾸면 기한을 규칙에 맞는 첫 날짜로 맞춘다
  if (has(a, 'recurrence') && canonicalRule(candidate.recurrence) !== canonicalRule(current.recurrence) && candidate.recurrence && candidate.dueDate) {
    candidate.dueDate = firstOccurrenceOnOrAfter(candidate.recurrence, candidate.dueDate);
  }

  // 서버에 저장된 버전보다 항상 큰 버전을 만든다 (다른 기기의 시계가 앞서 있어도 이긴다)
  const stamped: Task = { ...candidate, version: createHlc(ctx.deviceId).receive(current.version), updatedBy: ctx.deviceId };
  const errors = validateTask(stamped);
  if (errors.length) throw invalid(errors);
  await pushOne(ctx, stamped);
  return { updated: view(stamped, L) };
}

export async function completeTask(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const current = findTask(L, reqString(a, 'id'));
  if (current.done) return { message: '이미 완료된 할 일이에요', task: view(current, L) };
  const stamp = { version: createHlc(ctx.deviceId).receive(current.version), updatedBy: ctx.deviceId };
  let next: Task;
  let message: string;
  if (current.recurrence && current.dueDate) {
    // 반복 할 일: 완료하면 미완료로 남은 채 기한이 다음 회차로 넘어간다 (앱과 같다)
    const nd = nextOccurrence(current.recurrence, current.dueDate, L.today);
    next = nd ? { ...current, dueDate: nd, ...stamp } : { ...current, done: true, ...stamp };
    message = nd ? `반복 할 일이라 이번 회차를 완료하고 다음 기한(${nd})으로 넘겼어요` : '반복이 끝나서 완료 처리했어요';
  } else {
    next = { ...current, done: true, ...stamp };
    message = '완료했어요';
  }
  const errors = validateTask(next);
  if (errors.length) throw invalid(errors);
  await pushOne(ctx, next);
  return { message, task: view(next, L) };
}

export async function reopenTask(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const current = findTask(L, reqString(a, 'id'));
  if (!current.done) return { message: '이미 완료되지 않은 할 일이에요', task: view(current, L) };
  const next: Task = { ...current, done: false, version: createHlc(ctx.deviceId).receive(current.version), updatedBy: ctx.deviceId };
  const errors = validateTask(next);
  if (errors.length) throw invalid(errors);
  await pushOne(ctx, next);
  return { message: '다시 미완료로 돌렸어요', task: view(next, L) };
}

export async function deleteTask(ctx: Ctx, a: Args): Promise<unknown> {
  const L = await load(ctx);
  const current = findTask(L, reqString(a, 'id'));
  const next: Task = { ...current, deleted: true, version: createHlc(ctx.deviceId).receive(current.version), updatedBy: ctx.deviceId };
  await pushOne(ctx, next);
  return { message: '삭제했어요', task: view(current, L) };
}
