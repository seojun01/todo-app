// 구글 캘린더에서 불러온 일정 목록 (읽기 전용: 완료·수정·삭제가 없다)
import { eventTimeLabel, safeColor, type CalendarEvent } from '../gcal-events.ts';
import { h } from './dom.ts';

/** date 하루의 일정 목록. 일정이 없으면 null */
export function renderEventList(events: CalendarEvent[], date: string): HTMLUListElement | null {
  if (events.length === 0) return null;
  return h(
    'ul',
    { class: 'events', 'aria-label': '구글 캘린더 일정' },
    ...events.map((e) => {
      const color = safeColor(e.color);
      return h(
        'li',
        { class: 'event', 'data-key': `event:${e.id}:${date}`, ...(color ? { style: `--ev: ${color}` } : {}) },
        h('span', { class: 'event-time' }, eventTimeLabel(e, date)),
        h('span', { class: 'event-title' }, e.title),
        // 어느 캘린더의 일정인지 (색만으로 구분하지 않는다)
        h('span', { class: 'sr-only' }, ` (${e.calendarName} 일정)`),
      );
    }),
  );
}
