// Task / Project / Settings 타입과 검증 규칙. 서버와 클라이언트가 같은 코드로 검증한다.
import { isValidSortKey } from './order.ts';
import { daysInMonth } from './calendar.ts';

export type CalendarDate = string; // YYYY-MM-DD
export type ClockTime = string; // HH:MM (24시간, 그 기기의 현지 시각)
export type Priority = 1 | 2 | 3 | 4;
export type ReminderKind = 'at' | '10m' | '30m' | '1h' | '1d' | 'day';
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';

export const INBOX_ID = 'inbox';
export const DEFAULT_REMINDER_TIME: ClockTime = '09:00';
export const PROJECT_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];
/** 기한 시각이 있는 할 일에 쓸 수 있는 알림 */
export const REMINDERS_TIMED: readonly ReminderKind[] = ['at', '10m', '30m', '1h', '1d'];
/** 기한 시각이 없는 할 일에 쓸 수 있는 알림 (기본 알림 시각 기준) */
export const REMINDERS_DATE_ONLY: readonly ReminderKind[] = ['day', '1d'];

export interface Recurrence {
  unit: RecurrenceUnit;
  interval: number; // 1..99
  weekdays?: number[]; // unit == week: 0(일)~6(토), 중복 없는 비어 있지 않은 집합
  dayOfMonth?: number; // unit == month | year: 1..31
  month?: number; // unit == year: 1..12
  endDate?: CalendarDate;
}

export interface Task {
  id: string;
  title: string;
  dueDate: CalendarDate | null;
  dueTime: ClockTime | null;
  /** 시각이 있는 할 일의 길이(분). 캘린더에서 시작 시각부터 이 길이만큼의 블록으로 그린다. 옛 데이터에는 없다 — 읽을 때는 durationOf() 를 쓴다 */
  durationMin?: number | null;
  /** 장소. 옛 데이터·옛 기기에는 없다 — 읽을 때는 locationOf() 를 쓴다 */
  location?: string | null;
  projectId: string; // 'inbox' 또는 프로젝트 UUID
  priority: Priority;
  recurrence: Recurrence | null;
  reminders: ReminderKind[];
  /** 태그(라벨). 옛 기기·옛 데이터에는 없을 수 있다 — 읽을 때는 tagsOf() 를 쓴다 */
  tags?: string[];
  /** 목록에서 끌어서 정한 순서 (shared/order.ts). 없으면 자동 정렬(우선순위 → 시각 → 만든 순서)을 따른다 */
  sortKey?: string | null;
  done: boolean;
  createdAt: string;
  deleted: boolean;
  version: string;
  updatedBy: string;
}

export interface Project {
  id: string;
  name: string;
  color: ProjectColor;
  createdAt: string;
  deleted: boolean;
  version: string;
  updatedBy: string;
}

export interface Settings {
  id: 'settings';
  defaultReminderTime: ClockTime;
  version: string;
  updatedBy: string;
}

export interface FieldError {
  field: string;
  rule: string;
}

export type TitleResult = { ok: true; value: string } | { ok: false; errors: FieldError[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const MAX_TITLE = 200;
/** 소요 시간(분)의 범위. 시작 시각부터 자정을 넘기지 않는다. */
export const MIN_DURATION = 5;
export const MAX_DURATION = 1439;
/** 길이를 정하지 않은 시각 있는 할 일을 캘린더에서 그릴 때의 길이(분) */
export const DEFAULT_DURATION = 60;
export const MAX_PROJECT_NAME = 50;
/** 태그 하나의 길이(코드 포인트)와 할 일 하나에 붙일 수 있는 개수 */
export const MAX_LOCATION = 200;
export const MAX_TAG = 30;
export const MAX_TAGS = 10;

/** 태그를 같은 것으로 보는 기준: 대소문자를 무시한다 ("Home" 과 "home" 은 같은 태그) */
export const tagKey = (tag: string): string => tag.toLowerCase();

/** 태그 하나의 형식: 공백·쉼표·# 없이 1~30자 */
export const isValidTag = (tag: unknown): tag is string =>
  typeof tag === 'string' && /^[^\s,#]+$/u.test(tag) && [...tag].length <= MAX_TAG;

/** 옛 데이터에는 durationMin 이 없다 */
export const durationOf = (t: Pick<Task, 'durationMin'>): number | null => t.durationMin ?? null;

/** "HH:MM" → 자정부터의 분 */
export const toMinutes = (time: ClockTime): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** 자정부터의 분 → "HH:MM" (24:00 은 "24:00" 으로 돌려준다 — 표시용) */
export const fromMinutes = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 옛 데이터에는 location 이 없다 */
export const locationOf = (t: Pick<Task, 'location'>): string | null => t.location ?? null;

/** 장소 입력을 다듬는다: 앞뒤 공백을 떼고, 비면 null */
export const normalizeLocation = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/** 옛 데이터에는 tags 가 없다 */
export const tagsOf = (t: Pick<Task, 'tags'>): string[] => t.tags ?? [];

/** 태그 목록을 다듬는다: 앞뒤 공백과 앞의 # 를 떼고, 빈 것·대소문자만 다른 중복을 없앤다 (먼저 나온 표기를 남긴다) */
export function normalizeTags(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tag = String(raw).trim().replace(/^#+/, '');
    if (tag === '' || seen.has(tagKey(tag))) continue;
    seen.add(tagKey(tag));
    out.push(tag);
  }
  return out;
}

/**
 * 빠른 추가에 쓴 글의 "앞"이나 "끝"에 붙여 쓴 #태그를 떼어 낸다.
 *   "장보기 #집 #급함" → 제목 "장보기", 태그 [집, 급함]     "#개인 치과 예약" → 제목 "치과 예약", 태그 [개인]
 * 규칙: 글 앞과 끝의 연속된 #태그만 태그다(중간의 #는 제목의 일부). 숫자뿐인 #1·#123 은 번호로 보고 태그로 쓰지 않는다.
 * 떼어 내면 제목이 비거나(태그뿐인 글) 태그가 잘못되면(31자 초과·11개 초과) 아무것도 떼지 않는다. 제목 안의 공백은 그대로 둔다.
 */
export function splitInlineTags(input: string): { title: string; tags: string[] } {
  const text = input.trim();
  const tokens = [...text.matchAll(/\S+/gu)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const bodyOf = (t: string): string | null => {
    const m = /^#+([^\s,#]+)$/u.exec(t);
    return m && !/^\d+$/.test(m[1]!) ? m[1]! : null;
  };
  let first = 0; // 앞쪽 태그 토큰의 개수 = 제목이 시작하는 토큰
  while (first < tokens.length && bodyOf(tokens[first]!.text) !== null) first++;
  let last = tokens.length; // 끝쪽 태그 토큰이 시작하는 토큰 = 제목이 끝나는 곳 (앞쪽과 겹치지 않는다)
  while (last > first && bodyOf(tokens[last - 1]!.text) !== null) last--;
  if (first >= last || (first === 0 && last === tokens.length)) return { title: input, tags: [] }; // 제목이 안 남거나 떼낼 태그가 없다
  const raw = [...tokens.slice(0, first), ...tokens.slice(last)].map((t) => bodyOf(t.text)!);
  const tags = normalizeTags(raw);
  if (raw.length > MAX_TAGS || !tags.every(isValidTag)) return { title: input, tags: [] };
  return { title: text.slice(tokens[first]!.start, tokens[last - 1]!.end), tags };
}

/** 입력창의 문자열("집, 급함 #업무")을 태그 목록으로 바꾼다. 공백이나 쉼표로 나눈다. */
export const parseTags = (input: string): string[] => normalizeTags(input.split(/[\s,]+/u));

const cpLength = (s: string) => [...s].length;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function isValidDate(s: unknown): s is CalendarDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function isValidTime(s: unknown): s is ClockTime {
  return typeof s === 'string' && TIME_RE.test(s);
}

function isIso(s: unknown): boolean {
  return typeof s === 'string' && ISO_RE.test(s) && Number.isFinite(Date.parse(s));
}

/** 앞뒤 공백을 지운 뒤 1~200자(코드 포인트 기준) */
export function validateTitle(input: string): TitleResult {
  const value = typeof input === 'string' ? input.trim() : '';
  const len = cpLength(value);
  if (len < 1) return { ok: false, errors: [{ field: 'title', rule: 'empty' }] };
  if (len > MAX_TITLE) return { ok: false, errors: [{ field: 'title', rule: 'length' }] };
  return { ok: true, value };
}

export function validateRecurrence(r: unknown, dueDate: CalendarDate | null): FieldError[] {
  const bad = (rule: string): FieldError[] => [{ field: 'recurrence', rule }];
  if (typeof r !== 'object' || r === null) return bad('type');
  const rec = r as Record<string, unknown>;
  const unit = rec.unit;
  if (unit !== 'day' && unit !== 'week' && unit !== 'month' && unit !== 'year') return bad('unit');
  const interval = rec.interval;
  if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 99) return bad('interval');
  const has = (k: string) => rec[k] !== undefined;
  const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

  if (unit === 'week') {
    const w = rec.weekdays;
    if (!Array.isArray(w) || w.length === 0 || !w.every((x) => isInt(x, 0, 6)) || new Set(w).size !== w.length) return bad('weekdays');
    if (has('dayOfMonth') || has('month')) return bad('unexpected-field');
  } else if (unit === 'month') {
    if (!isInt(rec.dayOfMonth, 1, 31)) return bad('dayOfMonth');
    if (has('weekdays') || has('month')) return bad('unexpected-field');
  } else if (unit === 'year') {
    if (!isInt(rec.month, 1, 12)) return bad('month');
    if (!isInt(rec.dayOfMonth, 1, daysInMonth(2028, rec.month as number))) return bad('dayOfMonth');
    if (has('weekdays')) return bad('unexpected-field');
  } else {
    if (has('weekdays') || has('dayOfMonth') || has('month')) return bad('unexpected-field');
  }

  if (has('endDate')) {
    if (!isValidDate(rec.endDate)) return bad('endDate');
    if (dueDate != null && (rec.endDate as string) < dueDate) return bad('endDate-before-due'); // 현재 dueDate 보다 빠르면 거부
  }
  return [];
}

export function validateTask(t: Task): FieldError[] {
  const errs: FieldError[] = [];
  const add = (field: string, rule: string) => errs.push({ field, rule });

  if (!isUuid(t.id)) add('id', 'uuid');

  if (typeof t.title !== 'string') add('title', 'type');
  else {
    const r = validateTitle(t.title);
    if (!r.ok) add('title', r.errors[0]!.rule);
    else if (r.value !== t.title) add('title', 'trim');
  }

  if (t.dueDate !== null && !isValidDate(t.dueDate)) add('dueDate', 'format');
  if (t.dueTime !== null && !isValidTime(t.dueTime)) add('dueTime', 'format');
  if (t.dueDate === null && t.dueTime !== null) add('dueTime', 'requires-dueDate');

  if (t.durationMin !== undefined && t.durationMin !== null) {
    if (!Number.isInteger(t.durationMin) || t.durationMin < MIN_DURATION || t.durationMin > MAX_DURATION) add('durationMin', 'range');
    else if (t.dueTime === null) add('durationMin', 'requires-dueTime');
    else if (isValidTime(t.dueTime) && toMinutes(t.dueTime) + t.durationMin > 1440) add('durationMin', 'crosses-midnight');
  }

  if (t.location !== undefined && t.location !== null) {
    if (typeof t.location !== 'string') add('location', 'type');
    else if (t.location.trim() === '' || t.location.trim() !== t.location) add('location', 'trim');
    else if ([...t.location].length > MAX_LOCATION) add('location', 'length');
  }

  if (!(t.priority === 1 || t.priority === 2 || t.priority === 3 || t.priority === 4)) add('priority', 'range');

  if (t.recurrence !== null) {
    if (t.dueDate === null) add('recurrence', 'requires-dueDate');
    else errs.push(...validateRecurrence(t.recurrence, t.dueDate));
  }

  if (!Array.isArray(t.reminders)) add('reminders', 'type');
  else if (t.reminders.length > 0) {
    if (t.dueDate === null) add('reminders', 'requires-dueDate');
    else {
      const allowed = t.dueTime !== null ? REMINDERS_TIMED : REMINDERS_DATE_ONLY;
      if (!t.reminders.every((k) => allowed.includes(k))) add('reminders', 'kind');
      else if (new Set(t.reminders).size !== t.reminders.length) add('reminders', 'unique');
    }
  }

  if (t.tags !== undefined) {
    if (!Array.isArray(t.tags)) add('tags', 'type');
    else if (t.tags.length > MAX_TAGS) add('tags', 'count');
    else if (!t.tags.every(isValidTag)) add('tags', 'format');
    else if (new Set(t.tags.map(tagKey)).size !== t.tags.length) add('tags', 'unique');
  }

  if (t.sortKey !== undefined && t.sortKey !== null && !isValidSortKey(t.sortKey)) add('sortKey', 'format');

  if (t.projectId !== INBOX_ID && !isUuid(t.projectId)) add('projectId', 'format');
  if (typeof t.done !== 'boolean') add('done', 'type');
  if (typeof t.deleted !== 'boolean') add('deleted', 'type');
  if (!isIso(t.createdAt)) add('createdAt', 'format');
  if (typeof t.version !== 'string' || t.version === '') add('version', 'required');
  if (typeof t.updatedBy !== 'string' || t.updatedBy === '') add('updatedBy', 'required');
  return errs;
}

export function validateProject(p: Project): FieldError[] {
  const errs: FieldError[] = [];
  const add = (field: string, rule: string) => errs.push({ field, rule });
  if (!isUuid(p.id) || p.id === INBOX_ID) add('id', 'uuid');
  if (typeof p.name !== 'string') add('name', 'type');
  else {
    const value = p.name.trim();
    const len = cpLength(value);
    if (len < 1) add('name', 'empty');
    else if (len > MAX_PROJECT_NAME) add('name', 'length');
    else if (value !== p.name) add('name', 'trim');
  }
  if (!(PROJECT_COLORS as readonly string[]).includes(p.color)) add('color', 'palette');
  if (!isIso(p.createdAt)) add('createdAt', 'format');
  if (typeof p.deleted !== 'boolean') add('deleted', 'type');
  if (typeof p.version !== 'string' || p.version === '') add('version', 'required');
  if (typeof p.updatedBy !== 'string' || p.updatedBy === '') add('updatedBy', 'required');
  return errs;
}

export function validateSettings(s: Settings): FieldError[] {
  const errs: FieldError[] = [];
  const add = (field: string, rule: string) => errs.push({ field, rule });
  if (s.id !== 'settings') add('id', 'fixed');
  if (!isValidTime(s.defaultReminderTime)) add('defaultReminderTime', 'format');
  if (typeof s.version !== 'string' || s.version === '') add('version', 'required');
  if (typeof s.updatedBy !== 'string' || s.updatedBy === '') add('updatedBy', 'required');
  return errs;
}

/** 프로젝트가 없거나 삭제되었으면 수신함. 읽을 때 계산하므로 쓰기가 필요 없고 모든 기기가 같은 결과로 수렴한다. */
export function effectiveProjectId(task: Pick<Task, 'projectId'>, projects: readonly Project[]): string {
  if (task.projectId === INBOX_ID) return INBOX_ID;
  const p = projects.find((x) => x.id === task.projectId);
  return p && !p.deleted ? p.id : INBOX_ID;
}
