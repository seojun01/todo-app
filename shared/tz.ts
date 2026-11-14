// 시간대 변환: "그 시간대의 벽시계 시각"(날짜 + HH:MM)을 UTC 순간으로 바꾼다. 서버(알림)와 클라이언트(지난 알림 안내)가 같은 결과를 낸다.
// 서머타임 경계 규칙: 봄에 건너뛰어 존재하지 않는 시각은 건너뛴 "직후"(전환이 일어나는 순간)로, 가을에 두 번 있는 시각은 이른 쪽으로 정한다.
import type { CalendarDate, ClockTime } from './task.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // 잘못된 시간대면 여기서 RangeError 를 던진다
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** 그 순간 tz 의 UTC 오프셋(분). 동쪽이 +. */
export function offsetMinutes(utcMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wallAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((wallAsUtc - Math.floor(utcMs / 1000) * 1000) / MIN);
}

/** tz 가 올바른 IANA 시간대인가 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '' || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** 오프셋이 바뀌는 순간(분 단위)을 [lo, hi] 사이에서 이분 탐색으로 찾는다. lo 와 hi 의 오프셋은 달라야 한다. */
function transitionBetween(lo: number, hi: number, tz: string): number {
  const oLo = offsetMinutes(lo, tz);
  let a = lo;
  let b = hi;
  while (b - a > MIN) {
    const mid = a + Math.floor((b - a) / 2 / MIN) * MIN;
    if (mid === a) break;
    if (offsetMinutes(mid, tz) === oLo) a = mid;
    else b = mid;
  }
  return b;
}

/** 같은 날 tz 의 벽시계 date time 에 해당하는 UTC 순간. 서머타임 경계 규칙은 파일 머리말 참고. */
export function wallTimeToInstant(date: CalendarDate, time: ClockTime, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi); // 벽시계 값을 UTC 인 것처럼 본 값
  const before = offsetMinutes(wall - DAY, tz);
  const after = offsetMinutes(wall + DAY, tz);
  // 전후의 오프셋 각각으로 후보 순간을 만들고, 그 순간의 실제 오프셋이 후보를 만든 오프셋과 같은 것만 남긴다
  const valid = [...new Set([before, after])].map((o) => wall - o * MIN).filter((c) => offsetMinutes(c, tz) * MIN === wall - c);
  if (valid.length > 0) return new Date(Math.min(...valid)); // 두 개면(가을에 두 번 있는 시각) 이른 쪽
  // 봄에 건너뛴 시각: 전환이 일어나는 순간(건너뛴 직후)
  return new Date(transitionBetween(wall - DAY - before * MIN, wall + DAY - after * MIN, tz));
}
