// 반복 일정 엔진 (research R10). 순수 함수이며 서버와 클라이언트가 같은 결과를 낸다.
// 반복은 "정해진 일정"을 따른다: 완료한 날로부터 N일 뒤가 아니라, 규칙에 맞는 날 중 기준일 이후의 첫 날이다.
import { addDays, daysInMonth, diffDays, formatDate, parseDate, startOfWeek, weekday } from './calendar.ts';
import type { CalendarDate, Recurrence, RecurrenceUnit } from './task.ts';

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

/** anchor 를 기준으로 규칙에 맞는 날 중 ref 보다 뒤(초과)인 가장 이른 날 */
function firstAfter(rule: Recurrence, anchor: CalendarDate, ref: CalendarDate): CalendarDate {
  const n = rule.interval;
  switch (rule.unit) {
    case 'day': {
      // 일정: anchor, anchor+N, anchor+2N, …
      const k = ref < anchor ? 0 : Math.floor(diffDays(anchor, ref) / n) + 1;
      return addDays(anchor, k * n);
    }
    case 'week': {
      // 기준 주(anchor 가 속한 일요일 시작 주)에서 N주 간격의 주들 가운데 선택한 요일
      const base = startOfWeek(anchor);
      const days = rule.weekdays!;
      for (let d = addDays(ref, 1), guard = 0; guard < 7 * n + 8; d = addDays(d, 1), guard++) {
        const weeks = diffDays(base, startOfWeek(d)) / 7;
        if (weeks >= 0 && weeks % n === 0 && days.includes(weekday(d))) return d;
      }
      throw new Error('주 단위 반복을 계산하지 못했어요');
    }
    case 'month': {
      // 원래 일정(dayOfMonth)에서 매번 다시 계산한다: 31일이 없는 달은 말일로 맞추고, 다음 달에는 다시 31일
      const a = parseDate(anchor);
      for (let k = 0; ; k++) {
        const total = a.y * 12 + (a.m - 1) + k * n;
        const y = Math.floor(total / 12);
        const m = (total % 12) + 1;
        const d = formatDate(y, m, Math.min(rule.dayOfMonth!, daysInMonth(y, m)));
        if (d > ref) return d;
      }
    }
    case 'year': {
      const a = parseDate(anchor);
      for (let k = 0; ; k++) {
        const y = a.y + k * n;
        const d = formatDate(y, rule.month!, Math.min(rule.dayOfMonth!, daysInMonth(y, rule.month!)));
        if (d > ref) return d;
      }
    }
  }
}

/**
 * 반복 할 일을 완료했을 때의 다음 기한 (FR-018).
 * 다음 회차는 "원래 기한과 완료한 날 중 더 늦은 날" 이후의 첫 일정일이다.
 * 종료 날짜를 넘으면 null — 호출한 쪽은 반복 할 일을 완료 상태로 만든다 (FR-020).
 */
export function nextOccurrence(rule: Recurrence, dueDate: CalendarDate, completedOn: CalendarDate): CalendarDate | null {
  const ref = dueDate > completedOn ? dueDate : completedOn;
  const next = firstAfter(rule, dueDate, ref);
  return rule.endDate && next > rule.endDate ? null : next;
}

/**
 * 아직 오지 않은 반복 회차 날짜들 — 예정·캘린더에 미리 보여 주기 위한 계산 (저장하지 않는 "가상 회차").
 * 첫 회차는 지금 완료하면 넘어갈 날짜(nextOccurrence(rule, dueDate, today))이고, 그 뒤는 각 회차를 그날 완료한다고 보고
 * 이어서 계산한다. 그래서 실제로 하나씩 완료했을 때의 기한 이동과 항상 같은 날짜가 나온다.
 * 현재 기한(dueDate) 자체는 실제 할 일이므로 포함하지 않는다. from ~ to (양 끝 포함) 사이만 돌려주고, 종료 날짜는 넘지 않는다.
 */
export function upcomingOccurrences(rule: Recurrence, dueDate: CalendarDate, today: CalendarDate, from: CalendarDate, to: CalendarDate, limit = 400): CalendarDate[] {
  const out: CalendarDate[] = [];
  let cur = nextOccurrence(rule, dueDate, today);
  // nextOccurrence 는 항상 기준일보다 뒤의 날짜를 주므로 반드시 앞으로 나아가고, to 를 넘으면 끝난다 (limit 은 안전장치)
  for (let guard = 0; cur !== null && cur <= to && guard < limit; guard++) {
    if (cur >= from) out.push(cur);
    cur = nextOccurrence(rule, cur, cur);
  }
  return out;
}

/**
 * 반복을 처음 지정하거나 규칙을 바꿀 때 기한을 맞춘다 (FR-017):
 * 원래 기한 이후(당일 포함)에서 규칙에 맞는 첫 날짜. 기한이 이미 규칙에 맞으면 그대로다.
 * 종료 날짜를 넘을 수 있으므로 검증은 호출한 쪽(validateTask)이 한다.
 */
export function firstOccurrenceOnOrAfter(rule: Recurrence, dueDate: CalendarDate): CalendarDate {
  return firstAfter(rule, dueDate, addDays(dueDate, -1));
}

/** 처음 지정할 때 요일·날짜의 기본값은 기한에서 가져온다 (예: 11/20 → 매월 20일) */
export function defaultRuleFor(dueDate: CalendarDate, unit: RecurrenceUnit): Recurrence {
  const { m, d } = parseDate(dueDate);
  switch (unit) {
    case 'day':
      return { unit, interval: 1 };
    case 'week':
      return { unit, interval: 1, weekdays: [weekday(dueDate)] };
    case 'month':
      return { unit, interval: 1, dayOfMonth: d };
    case 'year':
      return { unit, interval: 1, month: m, dayOfMonth: d };
  }
}

/** 화면에 보여 줄 한국어 설명 */
export function describeRecurrence(rule: Recurrence): string {
  const n = rule.interval;
  let text: string;
  switch (rule.unit) {
    case 'day':
      text = n === 1 ? '매일' : `${n}일마다`;
      break;
    case 'week': {
      const days = [...rule.weekdays!].sort((a, b) => a - b);
      const names = days.length === 1 ? `${DAY_NAMES[days[0]!]}요일` : days.map((d) => DAY_NAMES[d]).join('·');
      text = n === 1 ? `매주 ${names}` : `${n}주마다 ${names}`;
      break;
    }
    case 'month':
      text = n === 1 ? `매월 ${rule.dayOfMonth}일` : `${n}개월마다 ${rule.dayOfMonth}일`;
      break;
    case 'year':
      text = n === 1 ? `매년 ${rule.month}월 ${rule.dayOfMonth}일` : `${n}년마다 ${rule.month}월 ${rule.dayOfMonth}일`;
      break;
  }
  return rule.endDate ? `${text} (${rule.endDate}까지)` : text;
}

/** 키 순서나 요일 정렬에 관계없이 같은 규칙이면 같은 문자열 */
export function canonicalRule(rule: Recurrence | null | undefined): string {
  if (!rule) return 'null';
  return JSON.stringify([rule.unit, rule.interval, rule.weekdays ? [...rule.weekdays].sort((a, b) => a - b) : null, rule.dayOfMonth ?? null, rule.month ?? null, rule.endDate ?? null]);
}
