// 알림 규칙 (research R13): 발화 시각 계산, 발화 조건, 시각을 더하거나 뺄 때의 알림 종류 정리. 서버와 클라이언트가 같은 코드를 쓴다.
import { addDays } from './calendar.ts';
import { wallTimeToInstant } from './tz.ts';
import { DEFAULT_REMINDER_TIME, REMINDERS_DATE_ONLY, REMINDERS_TIMED, type ClockTime, type ReminderKind, type Settings, type Task } from './task.ts';

/** 알림을 늦게라도 보내 주는 한도. 이보다 늦은 것은 건너뛴다 (푸시 TTL 도 같다) */
export const LATE_LIMIT_MS = 15 * 60_000;

const LEAD_MS: Partial<Record<ReminderKind, number>> = { at: 0, '10m': 10 * 60_000, '30m': 30 * 60_000, '1h': 60 * 60_000 };

export const REMINDER_LABELS: Record<ReminderKind, string> = { at: '정시', '10m': '10분 전', '30m': '30분 전', '1h': '1시간 전', '1d': '하루 전', day: '당일' };

type DueFields = Pick<Task, 'dueDate' | 'dueTime'>;
type ReminderSettings = Pick<Settings, 'defaultReminderTime'> | { defaultReminderTime?: ClockTime } | null | undefined;

/** 같은 회차인지 구분하는 키. 반복 할 일이 다음 회차로 넘어가면 달라져 새 회차의 알림이 다시 울릴 수 있다 (FR-025) */
export const dueKey = (t: DueFields): string => (t.dueDate ? `${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''}` : '');

/** 이 알림 종류를 이 할 일에 쓸 수 있는가 (기한 시각이 있으면 시각 기준 알림, 없으면 당일·하루 전) */
export const isKindAllowed = (kind: ReminderKind, hasTime: boolean): boolean => (hasTime ? REMINDERS_TIMED : REMINDERS_DATE_ONLY).includes(kind);

/**
 * 알림이 울릴 순간. 기한이 없거나 이 할 일에 쓸 수 없는 종류면 null.
 *  at: 기한 시각, 10m/30m/1h: 그만큼 앞, 1d: 하루 전 같은 시각(시각이 없으면 하루 전 기본 알림 시각), day: 당일 기본 알림 시각.
 * 시각은 tz(알림을 받을 기기의 시간대)의 벽시계 시각이다.
 */
export function reminderInstant(task: DueFields, kind: ReminderKind, settings: ReminderSettings, tz: string): Date | null {
  if (!task.dueDate) return null;
  const def = settings?.defaultReminderTime ?? DEFAULT_REMINDER_TIME;
  if (kind === 'day') return task.dueTime ? null : wallTimeToInstant(task.dueDate, def, tz);
  if (kind === '1d') return wallTimeToInstant(addDays(task.dueDate, -1), task.dueTime ?? def, tz);
  const lead = LEAD_MS[kind];
  if (lead === undefined || !task.dueTime) return null;
  return new Date(wallTimeToInstant(task.dueDate, task.dueTime, tz).getTime() - lead);
}

/**
 * 지금 보내야 하는가: 알림을 설정한 뒤의 시각이고(armedAt < 발화 시각), 이미 지났고(발화 시각 <= now),
 * 너무 늦지 않았을 때(15분 이내)만 참이다. 설정할 때 이미 지난 시각이었던 알림은 뒤늦게 울리지 않는다 (FR-026).
 */
export function shouldFire(fireAt: Date, armedAt: Date, now: Date): boolean {
  const f = fireAt.getTime();
  return armedAt.getTime() < f && f <= now.getTime() && now.getTime() - f <= LATE_LIMIT_MS;
}

/** 편집 중 "이미 지난 알림이에요" 안내용: 발화 시각이 지금 이전인가 */
export function isReminderInPast(task: DueFields, kind: ReminderKind, settings: ReminderSettings, tz: string, now: Date): boolean {
  const at = reminderInstant(task, kind, settings, tz);
  return at !== null && at.getTime() <= now.getTime();
}

/**
 * 기한 시각을 더하거나 없앨 때 알림 종류를 맞춘다 (FR-022).
 *  시각을 더하면 "당일" 은 "정시" 로 바뀌고("하루 전" 은 유지), 시각을 없애면 시각 기준 알림(정시·10분 전·30분 전·1시간 전)은 빠진다.
 * removed 는 빠진 알림 개수다 (사용자에게 알리기 위해).
 */
export function remapReminders(reminders: readonly ReminderKind[], hadTime: boolean, hasTime: boolean): { reminders: ReminderKind[]; removed: number } {
  if (hadTime === hasTime) return { reminders: [...reminders], removed: 0 };
  if (hasTime) {
    const mapped = reminders.map((k) => (k === 'day' ? 'at' : k) as ReminderKind);
    return { reminders: [...new Set(mapped)], removed: 0 };
  }
  const kept = reminders.filter((k) => !(k in LEAD_MS));
  return { reminders: kept, removed: reminders.length - kept.length };
}
