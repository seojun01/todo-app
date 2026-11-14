// 구글 캘린더에서 불러온 일정 (읽기 전용). 서버가 사본을 들고 있고, 화면은 보이는 날짜 범위만 받아 온다.
// 일정은 덤이다: 연결 안 됨·서버 오류에서는 조용히 비어 있어야 하고, 할 일 화면을 막으면 안 된다.
// 오프라인에서도 보이도록, 받은 범위는 이 기기(localStorage)에도 보관했다가 서버에 닿지 못하면 마지막으로 받은 것을 보여 준다.
import type { App } from './app.ts';
import { addDays } from '../../shared/calendar.ts';

export interface CalendarEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  /** #rrggbb 또는 null */
  color: string | null;
  title: string;
  startDate: string;
  /** 그날을 포함하는 끝 날짜 */
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; events: CalendarEvent[] }>();
const inflight = new Map<string, Promise<CalendarEvent[]>>();

// ── 이 기기에 보관 (오프라인용) ──
const STORE_PREFIX = 'todo.gcal-events.v1:';
/** 보던 범위(달·주)별 사본을 이만큼만 남기고 오래된 것부터 지운다 */
export const STORE_MAX = 12;

/** localStorage 는 막혀 있거나 없을 수 있다 (사생활 보호 모드, 테스트 환경 등): 쓸 수 없으면 보관만 건너뛴다 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function storedKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(STORE_PREFIX)) keys.push(k);
  }
  return keys;
}

const looksLikeEvents = (v: unknown): v is CalendarEvent[] =>
  Array.isArray(v) && v.every((e) => e && typeof e.title === 'string' && typeof e.startDate === 'string' && typeof e.endDate === 'string' && typeof e.id === 'string');

function readStored(key: string): CalendarEvent[] | null {
  try {
    const raw = storage()?.getItem(STORE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: unknown };
    return looksLikeEvents(parsed.events) ? parsed.events : null;
  } catch {
    return null; // 깨진 보관본은 없는 것으로
  }
}

function writeStored(key: string, events: CalendarEvent[]): void {
  try {
    const s = storage();
    if (!s) return;
    s.setItem(STORE_PREFIX + key, JSON.stringify({ at: Date.now(), events }));
    const keys = storedKeys(s);
    if (keys.length > STORE_MAX) {
      const aged = keys.map((k) => {
        try {
          return { k, at: (JSON.parse(s.getItem(k) ?? '{}') as { at?: number }).at ?? 0 };
        } catch {
          return { k, at: 0 };
        }
      });
      aged.sort((a, b) => a.at - b.at);
      for (const { k } of aged.slice(0, keys.length - STORE_MAX)) s.removeItem(k);
    }
  } catch {
    /* 저장 공간이 가득 차는 등: 보관만 건너뛴다 */
  }
}

function clearStored(): void {
  try {
    const s = storage();
    if (s) for (const k of storedKeys(s)) s.removeItem(k);
  } catch {
    /* 무시 */
  }
}

/** 설정을 바꿨거나 연결을 해제했을 때 등: 받아 둔 일정을 모두 버리고 다음에는 서버에서 다시 받게 한다 */
export function invalidateEvents(): void {
  cache.clear();
  clearStored();
}

/** from ~ to (양 끝 포함) 날짜와 겹치는 일정. 실패하면 마지막으로 받은 것, 없으면 빈 목록. */
export async function loadEvents(app: App, from: string, to: string): Promise<CalendarEvent[]> {
  // 홈서버에 등록되지 않은 기기는 서버를 부르지 않는다. 등록이 풀렸다면 보관해 둔 일정도 남기지 않는다.
  if (!(await app.sync.status()).paired) {
    clearStored();
    return [];
  }
  const key = `${from}:${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.events;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(`/api/gcal/events?from=${from}&to=${to}`, { credentials: 'same-origin' });
      if (res.status === 401) {
        // 이 기기의 등록이 해제됐다: 서버의 일정을 더는 볼 수 없으니 보관본도 지운다
        cache.clear();
        clearStored();
        return [];
      }
      if (!res.ok) return hit?.events ?? readStored(key) ?? [];
      const body = (await res.json()) as { events?: unknown };
      const events = looksLikeEvents(body.events) ? body.events : [];
      cache.set(key, { at: Date.now(), events });
      writeStored(key, events);
      return events;
    } catch {
      return hit?.events ?? readStored(key) ?? []; // 오프라인: 마지막으로 받은 것을 그대로
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const isMultiDay = (e: CalendarEvent) => e.startDate !== e.endDate;

/** 그날 하루 종일 걸리는 일정인가 (종일 일정, 또는 여러 날 일정의 가운데 날) */
function wholeDay(e: CalendarEvent, date: string): boolean {
  if (e.allDay) return true;
  if (!isMultiDay(e)) return false;
  return date !== e.startDate && !(date === e.endDate && e.endTime);
}

/** 그 날짜에 보여 줄 시각 문구: "종일", "13:00–14:00", "13:00~", "~02:00" */
export function eventTimeLabel(e: CalendarEvent, date: string): string {
  if (wholeDay(e, date)) return '종일';
  if (!isMultiDay(e)) return e.endTime ? `${e.startTime}–${e.endTime}` : (e.startTime ?? '종일');
  return date === e.startDate ? `${e.startTime}~` : `~${e.endTime}`;
}

/** 칸 안에 들어가는 짧은 시각 문구: 시작 시각만 (없으면 빈 문자열) */
export function eventShortTime(e: CalendarEvent, date: string): string {
  if (wholeDay(e, date)) return '';
  return date === e.startDate ? (e.startTime ?? '') : '';
}

/** 날짜별로 묶는다 (여러 날 일정은 걸친 날마다). from~to 밖의 날짜는 만들지 않는다. 같은 날에는 종일이 먼저, 그다음 시각순 */
export function eventsByDate(events: CalendarEvent[], from: string, to: string): Map<string, CalendarEvent[]> {
  const out = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    // 아주 긴 일정도 한 번에 훑지 않도록 보이는 범위로 자른다
    const first = e.startDate < from ? from : e.startDate;
    const last = e.endDate > to ? to : e.endDate;
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const list = out.get(d) ?? [];
      list.push(e);
      out.set(d, list);
    }
  }
  for (const [date, list] of out) {
    list.sort((a, b) => {
      const wa = wholeDay(a, date) ? 0 : 1;
      const wb = wholeDay(b, date) ? 0 : 1;
      if (wa !== wb) return wa - wb;
      const ta = a.startDate === date ? (a.startTime ?? '') : '';
      const tb = b.startDate === date ? (b.startTime ?? '') : '';
      return ta < tb ? -1 : ta > tb ? 1 : a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    });
  }
  return out;
}

/** 색은 #rrggbb 만 쓴다 (스타일에 그대로 들어가므로 형식을 한 번 더 확인한다) */
export const safeColor = (c: string | null): string | null => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
