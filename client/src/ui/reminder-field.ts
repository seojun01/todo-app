// 편집 시트의 "기한 시각"과 "알림" 입력. 시각이 있으면 시각 기준 알림(정시·10분 전·30분 전·1시간 전·하루 전),
// 없으면 날짜 기준 알림(당일·하루 전)을 고른다. 시각을 더하거나 없애면 알림 종류를 맞추고 그 사실을 알린다 (FR-022).
import { REMINDER_LABELS, isKindAllowed, isReminderInPast, remapReminders } from '../../../shared/reminders.ts';
import { REMINDERS_DATE_ONLY, REMINDERS_TIMED, type ClockTime, type ReminderKind, type Settings } from '../../../shared/task.ts';
import { h } from './dom.ts';

const ALL_KINDS: ReminderKind[] = ['at', '10m', '30m', '1h', '1d', 'day'];
const TIME_BASED = ['정시', '10분 전', '30분 전', '1시간 전'];

export interface ReminderFieldOptions {
  initialTime: ClockTime | null;
  initialReminders: readonly ReminderKind[];
  /** 지금 입력된 기한 날짜 ("" 이면 없음) */
  getDate: () => string;
  settings: Pick<Settings, 'defaultReminderTime'>;
  /** 알림을 받을 이 기기의 시간대 */
  tz: string;
  now: () => Date;
  /** 알림을 하나라도 골랐는데 이 기기에서 알림을 받을 수 없을 때 보여 줄 안내 (없으면 null) */
  deviceNotice?: () => string | null;
}

export interface ReminderField {
  /** "기한 시각" 입력 영역 */
  timeElement: HTMLElement;
  /** "알림" 선택 영역 */
  remindersElement: HTMLElement;
  /** 기한 날짜나 시각이 바뀌었을 때 호출한다 */
  refresh(): void;
  /** 지금 입력된 기한 시각. 기한이 없거나 비워 두면 null */
  readTime(): ClockTime | null;
  /** 지금 고른 알림 (쓸 수 없는 종류는 제외) */
  readReminders(): ReminderKind[];
}

export function createReminderField(opts: ReminderFieldOptions): ReminderField {
  const timeInput = h('input', { type: 'time', id: 'editor-time' });
  timeInput.value = opts.initialTime ?? '';
  const clearTime = h('button', { type: 'button', class: 'btn btn-small' }, '시각 없음');
  const timeHint = h('p', { class: 'hint' }, '먼저 기한을 정하세요. 시각에는 기한이 필요해요.');
  const timeElement = h('div', { class: 'field' }, h('label', { for: 'editor-time' }, '기한 시각'), h('div', { class: 'row' }, timeInput, clearTime), timeHint);

  const boxes = new Map<ReminderKind, { box: HTMLInputElement; label: HTMLElement; past: HTMLElement }>();
  for (const kind of ALL_KINDS) {
    const box = h('input', { type: 'checkbox', value: kind, id: `editor-reminder-${kind}` });
    box.checked = opts.initialReminders.includes(kind);
    const past = h('span', { class: 'reminder-past' }, ' · 이미 지난 알림이에요');
    past.hidden = true;
    boxes.set(kind, { box, label: h('label', { for: box.id }, box, REMINDER_LABELS[kind], past), past });
  }
  const noDateHint = h('p', { class: 'hint' }, '먼저 기한을 정하세요. 알림에는 기한이 필요해요.');
  const status = h('p', { class: 'hint', role: 'status' });
  const remindersElement = h(
    'fieldset',
    { class: 'field' },
    h('legend', {}, '알림'),
    h('div', { class: 'radio-row' }, ...[...boxes.values()].map((b) => b.label)),
    noDateHint,
    status,
  );

  let prevHasTime = opts.initialTime !== null && opts.getDate() !== '';
  /** 시각을 더하거나 없애며 알림을 맞출 때의 안내 (다음에 바뀔 때까지 남긴다) */
  let remapNote = '';

  const hasDate = () => opts.getDate() !== '';
  const hasTime = () => hasDate() && timeInput.value !== '';
  const checkedVisible = (): ReminderKind[] => ALL_KINDS.filter((k) => boxes.get(k)!.box.checked && !boxes.get(k)!.label.hidden);

  function refresh(): void {
    const date = hasDate();
    if (!date) {
      timeInput.value = ''; // 기한이 없으면 시각도 알림도 없다
      for (const { box } of boxes.values()) box.checked = false;
      remapNote = '';
    }
    timeInput.disabled = !date;
    clearTime.disabled = !date;
    timeHint.hidden = date;
    noDateHint.hidden = date;

    const time = hasTime();
    if (time !== prevHasTime && date) {
      const before = checkedVisible();
      const r = remapReminders(before, prevHasTime, time);
      for (const { box } of boxes.values()) box.checked = false;
      for (const k of r.reminders) boxes.get(k)!.box.checked = true;
      if (r.removed > 0) remapNote = `시각을 없애서 시각 기준 알림 ${r.removed}개(${TIME_BASED.join('·')})를 뺐어요. '하루 전'은 그대로예요.`;
      else if (time && before.includes('day')) remapNote = "시각을 정해서 '당일' 알림을 '정시'로 바꿨어요.";
      else remapNote = '';
    }
    prevHasTime = time;

    for (const kind of ALL_KINDS) {
      const { box, label } = boxes.get(kind)!;
      const allowed = (time ? REMINDERS_TIMED : REMINDERS_DATE_ONLY).includes(kind);
      label.hidden = !allowed;
      box.disabled = !date;
    }

    // 이미 지난 알림 안내: 고른 알림 가운데 울릴 시각이 지금보다 앞인 것
    const due = { dueDate: opts.getDate() || null, dueTime: time ? timeInput.value : null };
    let anyPast = false;
    for (const kind of ALL_KINDS) {
      const { box, label, past } = boxes.get(kind)!;
      const isPast = date && !label.hidden && box.checked && isReminderInPast(due, kind, opts.settings, opts.tz, opts.now());
      past.hidden = !isPast;
      if (isPast) anyPast = true;
    }
    const notes: string[] = [];
    if (remapNote) notes.push(remapNote);
    if (anyPast) notes.push('이미 지난 시각의 알림은 울리지 않아요.');
    const notice = checkedVisible().length > 0 ? opts.deviceNotice?.() : null;
    if (notice) notes.push(notice);
    status.textContent = notes.join(' ');
    status.hidden = notes.length === 0;
  }

  timeInput.addEventListener('input', refresh);
  clearTime.addEventListener('click', () => {
    timeInput.value = '';
    refresh();
  });
  for (const { box } of boxes.values()) box.addEventListener('change', refresh);
  refresh();

  return {
    timeElement,
    remindersElement,
    refresh,
    readTime: () => (hasTime() ? timeInput.value : null),
    readReminders: () => (hasDate() ? checkedVisible().filter((k) => isKindAllowed(k, hasTime())) : []),
  };
}
