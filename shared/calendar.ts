// 시간대와 무관한 달력 날짜(YYYY-MM-DD) 계산. 모든 계산은 UTC 기반 "일 번호"로 하므로 서머타임의 영향을 받지 않는다.

export type CalendarDate = string;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function parseDate(s: CalendarDate): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date: ${s}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function formatDate(y: number, m: number, d: number): CalendarDate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function toEpochDay(s: CalendarDate): number {
  const { y, m, d } = parseDate(s);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d); // Date.UTC 는 0~99년을 1900년대로 바꾸므로 setUTCFullYear 를 쓴다
  return Math.round(dt.getTime() / 86_400_000);
}

function fromEpochDay(n: number): CalendarDate {
  const dt = new Date(n * 86_400_000);
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 0 = 일요일 … 6 = 토요일 */
export function weekday(s: CalendarDate): number {
  return (((toEpochDay(s) + 4) % 7) + 7) % 7; // 1970-01-01 은 목요일(4)
}

export function addDays(s: CalendarDate, n: number): CalendarDate {
  return fromEpochDay(toEpochDay(s) + n);
}

/** 그 달에 같은 날이 없으면 마지막 날로 맞춘다 (1/31 + 1개월 = 2/28) */
export function addMonths(s: CalendarDate, n: number): CalendarDate {
  const { y, m, d } = parseDate(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (((total % 12) + 12) % 12) + 1;
  return formatDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** a 에서 b 까지의 일수 (b - a) */
export function diffDays(a: CalendarDate, b: CalendarDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function startOfWeek(s: CalendarDate): CalendarDate {
  return addDays(s, -weekday(s));
}

/** 일요일에 시작하고 7의 배수 칸으로 끝나는 월 격자 */
export function monthGrid(y: number, m: number): CalendarDate[] {
  const first = formatDate(y, m, 1);
  const last = formatDate(y, m, daysInMonth(y, m));
  const start = addDays(first, -weekday(first));
  const end = addDays(last, 6 - weekday(last));
  const out: CalendarDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 기기의 로컬 날짜 (FR-028) */
export function toDateString(d: Date): CalendarDate {
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function today(now: Date = new Date()): CalendarDate {
  return toDateString(now);
}
