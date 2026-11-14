// 화면별 조회. 모두 기기 로컬 저장소에서 계산한다 (오프라인 우선).
import { addDays, daysInMonth, formatDate, startOfWeek } from '../../shared/calendar.ts';
import { upcomingOccurrences } from '../../shared/recurrence.ts';
import { sortOverdue, sortTasks } from '../../shared/sort.ts';
import { INBOX_ID, effectiveProjectId, tagKey, tagsOf, type Task } from '../../shared/task.ts';
import { listProjects, type StoredProject } from './store/projects.ts';
import { listAllTasks, listTasksByDueRange, listTasksByProject, type StoredTask } from './store/tasks.ts';

export interface TodayView {
  /** 기한이 지난 미완료 (기한 날짜가 오래된 순) */
  overdue: StoredTask[];
  /** 기한이 오늘인 미완료 */
  today: StoredTask[];
  /** 기한이 오늘인 완료 항목. 기한이 지난 항목을 완료하면 이 화면에서는 사라진다 (spec US1-3) */
  completed: StoredTask[];
}

const live = (t: Task) => !t.deleted;

export async function todayView(db: IDBDatabase, today: string): Promise<TodayView> {
  const all = (await listTasksByDueRange(db, '0001-01-01', today)).filter(live);
  return {
    overdue: sortOverdue(all.filter((t) => !t.done && t.dueDate! < today)) as StoredTask[],
    today: sortTasks(all.filter((t) => !t.done && t.dueDate === today)) as StoredTask[],
    completed: sortTasks(all.filter((t) => t.done && t.dueDate === today)) as StoredTask[],
  };
}

export interface ProjectTasks {
  open: StoredTask[];
  completed: StoredTask[];
}

/**
 * 수신함·프로젝트 화면: 기한 유무와 관계없이 소속된 모든 할 일.
 * 삭제되었거나 없는 프로젝트를 가리키는 할 일(다른 기기가 오프라인에서 추가)은 읽을 때 수신함으로 계산한다 (research R11).
 */
export async function projectTasks(db: IDBDatabase, projectId: string): Promise<ProjectTasks> {
  const projects = await listProjects(db);
  let all: StoredTask[];
  if (projectId === INBOX_ID) {
    all = (await listAllTasks(db)).filter((t) => effectiveProjectId(t, projects) === INBOX_ID);
  } else {
    const p = projects.find((x) => x.id === projectId && !x.deleted);
    all = p ? await listTasksByProject(db, projectId) : [];
  }
  all = all.filter(live);
  return {
    open: sortTasks(all.filter((t) => !t.done)) as StoredTask[],
    completed: sortTasks(all.filter((t) => t.done)) as StoredTask[],
  };
}

export interface ProjectSummary {
  project: StoredProject;
  /** 미완료 할 일 수 */
  open: number;
}

/** 살아 있는 프로젝트를 만든 순서로, 미완료 개수와 함께 */
export async function projectSummaries(db: IDBDatabase): Promise<ProjectSummary[]> {
  const out: ProjectSummary[] = [];
  for (const project of (await listProjects(db)).filter((p) => !p.deleted)) {
    const open = (await listTasksByProject(db, project.id)).filter((t) => !t.deleted && !t.done).length;
    out.push({ project, open });
  }
  return out;
}

export interface ProjectLabel {
  name: string;
  color: string;
}

/** 오늘·예정 화면에서 할 일의 소속 프로젝트를 보여 주기 위한 맵 (수신함 포함, 삭제된 프로젝트는 없음) */
export async function projectLabels(db: IDBDatabase): Promise<Map<string, ProjectLabel>> {
  const map = new Map<string, ProjectLabel>([[INBOX_ID, { name: '수신함', color: 'gray' }]]);
  for (const p of (await listProjects(db)).filter((x) => !x.deleted)) map.set(p.id, { name: p.name, color: p.color });
  return map;
}

export interface UpcomingDay {
  date: string;
  tasks: StoredTask[];
  /** 그 날에 오는 반복 할 일의 앞으로의 회차 (가상 회차: 저장되지 않고 읽을 때 계산한다). 실제 기한인 날은 tasks 에 있다. */
  ghosts: StoredTask[];
}

/**
 * 반복 할 일의 앞으로의 회차를 날짜별로 모은다 (from ~ to, 양 끝 포함). 미완료 반복 할 일만, 현재 기한 이후의 회차만 나온다.
 * 지금 기한(실제 할 일)은 포함하지 않는다. 완료하면 기한이 다음 회차로 넘어가므로 이 회차들이 차례로 실제 할 일이 된다.
 */
export async function recurringGhosts(db: IDBDatabase, today: string, from: string, to: string): Promise<Map<string, StoredTask[]>> {
  const out = new Map<string, StoredTask[]>();
  for (const t of await listAllTasks(db)) {
    if (t.deleted || t.done || !t.recurrence || !t.dueDate || t.dueDate >= to) continue;
    for (const date of upcomingOccurrences(t.recurrence, t.dueDate, today, from, to)) {
      const list = out.get(date) ?? [];
      list.push(t);
      out.set(date, list);
    }
  }
  for (const [date, list] of out) out.set(date, sortTasks(list) as StoredTask[]);
  return out;
}

/**
 * 예정 화면: 일요일에 시작하는 주 단위로 날짜별로 묶는다. 할 일이 없는 날도 그룹으로 포함한다.
 * page 0 은 오늘부터 그 주의 토요일까지(오늘이 수요일이면 수·목·금·토), page 1 부터는 일~토 7일씩 이어진다.
 * 기한이 지난 것·기한 없는 것·완료·삭제된 할 일은 포함하지 않는다 (기한 지난 것은 오늘 화면에 있다).
 */
export async function upcomingView(db: IDBDatabase, today: string, page = 0): Promise<UpcomingDay[]> {
  const p = Math.max(0, page);
  const weekStart = addDays(startOfWeek(today), 7 * p);
  const first = p === 0 ? today : weekStart;
  const last = addDays(weekStart, 6);
  const all = (await listTasksByDueRange(db, first, last)).filter((t) => !t.deleted && !t.done);
  const ghosts = await recurringGhosts(db, today, first, last);
  const days: UpcomingDay[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    days.push({ date, tasks: sortTasks(all.filter((t) => t.dueDate === date)) as StoredTask[], ghosts: ghosts.get(date) ?? [] });
  }
  return days;
}

/** 캘린더 칸 안에 보여 줄 할 일 미리보기의 최대 개수 */
export const DAY_PREVIEW_MAX = 3;

export interface DayPreviewItem {
  title: string;
  priority: number;
  /** HH:MM, 시각이 없으면 null */
  time: string | null;
}

export interface DaySummary {
  total: number;
  remaining: number;
  allDone: boolean;
  /** 남은(미완료) 할 일 중 앞쪽 DAY_PREVIEW_MAX 개. 그날 목록과 같은 순서(우선순위 → 시각 → 만든 순서) */
  preview: DayPreviewItem[];
  /** 그 날에 오는 반복 할 일의 앞으로의 회차(가상) 중 앞쪽 DAY_PREVIEW_MAX 개. total·remaining 에는 세지 않는다 */
  repeats: DayPreviewItem[];
  /** 그 날의 반복 회차 전체 개수 */
  repeatCount: number;
}

/**
 * 캘린더 칸에 보여 줄 날짜별 현황 (FR-005). 그 달에 기한이 있는 할 일만 센다.
 * 완료한 일반 할 일도 total 에 들어가고, 할 일이 없는 날은 결과에 없다. 반복 할 일은 다음 회차의 날짜에만 나타난다.
 */
export async function summarizeMonth(db: IDBDatabase, year: number, month: number, today = ''): Promise<Map<string, DaySummary>> {
  const from = formatDate(year, month, 1);
  const to = formatDate(year, month, daysInMonth(year, month));
  const byDate = new Map<string, StoredTask[]>();
  for (const t of (await listTasksByDueRange(db, from, to)).filter((x) => !x.deleted)) {
    const list = byDate.get(t.dueDate!) ?? [];
    list.push(t);
    byDate.set(t.dueDate!, list);
  }
  const out = new Map<string, DaySummary>();
  for (const [date, tasks] of byDate) {
    const open = sortTasks(tasks.filter((t) => !t.done));
    out.set(date, {
      total: tasks.length,
      remaining: open.length,
      allDone: tasks.length > 0 && open.length === 0,
      preview: open.slice(0, DAY_PREVIEW_MAX).map((t) => ({ title: t.title, priority: t.priority, time: t.dueTime })),
      repeats: [],
      repeatCount: 0,
    });
  }
  // 반복 할 일의 앞으로의 회차 (today 를 모르면 각 할 일의 기한 기준으로 센다)
  for (const [date, list] of await recurringGhosts(db, today, from, to)) {
    const s = out.get(date) ?? { total: 0, remaining: 0, allDone: false, preview: [], repeats: [], repeatCount: 0 };
    s.repeats = list.slice(0, DAY_PREVIEW_MAX).map((t) => ({ title: t.title, priority: t.priority, time: t.dueTime }));
    s.repeatCount = list.length;
    out.set(date, s);
  }
  return out;
}

/** 한 날짜의 할 일: 미완료와 완료 */
export async function dayTasks(db: IDBDatabase, date: string): Promise<{ open: StoredTask[]; completed: StoredTask[] }> {
  const all = (await listTasksByDueRange(db, date, date)).filter((t) => !t.deleted);
  return {
    open: sortTasks(all.filter((t) => !t.done)) as StoredTask[],
    completed: sortTasks(all.filter((t) => t.done)) as StoredTask[],
  };
}

export interface TagSummary {
  /** 화면에 보여 줄 표기 (가장 먼저 쓴 표기) */
  name: string;
  /** 미완료 할 일 수 */
  open: number;
}

/** 쓰이고 있는 모든 태그 (삭제된 할 일은 제외, 대소문자는 같은 태그로 묶는다). 이름순 */
export async function tagSummaries(db: IDBDatabase): Promise<TagSummary[]> {
  const byKey = new Map<string, TagSummary>();
  // 먼저 만든 할 일의 표기를 남긴다. 저장소 순서(id)에 맡기면 기기마다 표기가 달라질 수 있어 만든 순서로 고정한다.
  const live = (await listAllTasks(db)).filter((x) => !x.deleted).sort((x, y) => (x.createdAt === y.createdAt ? (x.id < y.id ? -1 : 1) : x.createdAt < y.createdAt ? -1 : 1));
  for (const t of live) {
    for (const tag of tagsOf(t)) {
      const s = byKey.get(tagKey(tag)) ?? { name: tag, open: 0 };
      if (!t.done) s.open += 1;
      byKey.set(tagKey(tag), s);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 한 태그가 붙은 할 일: 미완료와 완료 (기한 유무와 관계없이) */
export async function tagTasks(db: IDBDatabase, tag: string): Promise<{ open: StoredTask[]; completed: StoredTask[] }> {
  const key = tagKey(tag);
  const all = (await listAllTasks(db)).filter((t) => !t.deleted && tagsOf(t).some((x) => tagKey(x) === key));
  return {
    open: sortTasks(all.filter((t) => !t.done)) as StoredTask[],
    completed: sortTasks(all.filter((t) => t.done)) as StoredTask[],
  };
}
