// 편집 시트의 반복 설정: 없음/매일/매주/매월/매년 + 간격 + (매주) 요일 + 종료 날짜. 기한이 있어야 쓸 수 있다 (FR-017).
import { defaultRuleFor } from '../../../shared/recurrence.ts';
import { weekday } from '../../../shared/calendar.ts';
import type { Recurrence, RecurrenceUnit } from '../../../shared/task.ts';
import { h } from './dom.ts';

type Choice = 'none' | RecurrenceUnit;

const OPTIONS: [Choice, string][] = [
  ['none', '반복 안 함'],
  ['day', '매일'],
  ['week', '매주'],
  ['month', '매월'],
  ['year', '매년'],
];
const UNIT_SUFFIX: Record<RecurrenceUnit, string> = { day: '일마다', week: '주마다', month: '개월마다', year: '년마다' };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

export interface RecurrenceField {
  element: HTMLElement;
  /** 기한이 바뀌었을 때(없어졌을 때 포함) 사용 가능 여부와 안내를 갱신한다 */
  refresh(): void;
  /** 지금 입력된 반복 규칙. "반복 안 함"이거나 기한이 없으면 null */
  readRule(): Recurrence | null;
}

export function createRecurrenceField(initial: Recurrence | null, getDate: () => string): RecurrenceField {
  const select = h('select', { id: 'editor-repeat' }, ...OPTIONS.map(([v, label]) => h('option', { value: v }, label)));
  select.value = initial?.unit ?? 'none';

  const hint = h('p', { class: 'hint' }, '먼저 기한을 정하세요. 반복에는 기한이 필요해요.');
  const interval = h('input', { type: 'number', id: 'editor-interval', min: '1', max: '99', step: '1', inputmode: 'numeric' });
  interval.value = String(initial?.interval ?? 1);
  const suffix = h('span', {}, '');
  const monthYearHint = h('p', { class: 'hint' });

  const weekdayBoxes = DAY_NAMES.map((name, i) => {
    const box = h('input', { type: 'checkbox', value: String(i), id: `editor-weekday-${i}` });
    box.checked = initial?.weekdays?.includes(i) ?? false;
    return { box, label: h('label', { for: `editor-weekday-${i}` }, box, name) };
  });
  const weekdays = h('fieldset', { class: 'field' }, h('legend', {}, '요일'), h('div', { class: 'radio-row' }, ...weekdayBoxes.map((w) => w.label)));

  const end = h('input', { type: 'date', id: 'editor-repeat-end' });
  end.value = initial?.endDate ?? '';

  const detail = h(
    'div',
    {},
    h('div', { class: 'field' }, h('label', { for: 'editor-interval' }, '간격'), h('div', { class: 'row' }, interval, suffix)),
    weekdays,
    monthYearHint,
    h('div', { class: 'field' }, h('label', { for: 'editor-repeat-end' }, '종료 날짜'), end),
  );

  const element = h('div', {}, h('div', { class: 'field' }, h('label', { for: 'editor-repeat' }, '반복'), select, hint), detail);

  function refresh(): void {
    const date = getDate();
    const hasDate = date !== '';
    const unit = select.value as Choice;
    select.disabled = !hasDate;
    hint.hidden = hasDate;
    detail.hidden = !hasDate || unit === 'none';
    if (unit !== 'none') suffix.textContent = UNIT_SUFFIX[unit];
    weekdays.hidden = unit !== 'week';
    if (hasDate && (unit === 'month' || unit === 'year')) {
      const base = initial?.unit === unit ? initial : defaultRuleFor(date, unit);
      monthYearHint.textContent = unit === 'month' ? `매월 ${base.dayOfMonth}일에 반복해요.` : `매년 ${base.month}월 ${base.dayOfMonth}일에 반복해요.`;
      monthYearHint.hidden = false;
    } else {
      monthYearHint.hidden = true;
    }
  }

  select.addEventListener('change', () => {
    const date = getDate();
    if (select.value === 'week' && date && !weekdayBoxes.some((w) => w.box.checked)) {
      weekdayBoxes[weekday(date)]!.box.checked = true; // 처음 지정할 때 요일의 기본값은 기한의 요일
    }
    refresh();
  });
  refresh();

  return {
    element,
    refresh,
    readRule() {
      const date = getDate();
      const unit = select.value as Choice;
      if (unit === 'none' || date === '') return null;
      // 같은 단위를 유지하면 기존 규칙의 날짜(예: 매월 31일)를 그대로 쓴다. 단위를 새로 고르면 기한에서 기본값을 가져온다.
      const base = initial?.unit === unit ? initial : defaultRuleFor(date, unit);
      const rule: Recurrence = { unit, interval: Number(interval.value) };
      if (unit === 'week') rule.weekdays = weekdayBoxes.filter((w) => w.box.checked).map((w) => Number(w.box.value));
      if (unit === 'month' || unit === 'year') rule.dayOfMonth = base.dayOfMonth;
      if (unit === 'year') rule.month = base.month;
      if (end.value !== '') rule.endDate = end.value;
      return rule;
    },
  };
}
