// 한국어 날짜·시각 표시
import { parseDate, weekday } from '../../shared/calendar.ts';

const DAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_LONG = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/** 11월 12일 목요일 */
export function formatLong(date: string): string {
  const { m, d } = parseDate(date);
  return `${m}월 ${d}일 ${DAY_LONG[weekday(date)]}`;
}

/** 11월 12일 (목) */
export function formatShort(date: string): string {
  const { m, d } = parseDate(date);
  return `${m}월 ${d}일 (${DAY_SHORT[weekday(date)]})`;
}

/** 15:00 → 오후 3:00 */
export function formatTime(time: string): string {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const period = hh < 12 ? '오전' : '오후';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${period} ${h12}:${String(mm).padStart(2, '0')}`;
}

export function dayName(date: string): string {
  return DAY_LONG[weekday(date)]!;
}

/** 자정부터의 분 두 개를 "오후 1:00 ~ 오후 3:00" 로 (자정에 끝나면 "자정") */
export function formatRange(start: number, end: number): string {
  const t = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${formatTime(t(start))} ~ ${end >= 1440 ? '자정' : formatTime(t(end))}`;
}
