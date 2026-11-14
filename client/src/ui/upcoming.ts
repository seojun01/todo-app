// 예정 화면: 일요일~토요일 한 주씩 날짜별 카드 열로 보여 주고, 이전 주/다음 주로 넘기며, 날짜 머리글에서 바로 추가한다
import type { ViewRenderer } from '../app.ts';
import { formatLong } from '../format.ts';
import { parseDate } from '../../../shared/calendar.ts';
import { eventsByDate, loadEvents } from '../gcal-events.ts';
import { projectLabels, upcomingView } from '../views.ts';
import { h } from './dom.ts';
import { renderEventList } from './event-list.ts';
import { renderGhostList, renderQuickAdd, renderTaskList } from './task-list.ts';

/** 추가 입력이 열려 있는 날짜 */
let adding: string | null = null;
/** "이전 주/다음 주"로 넘긴 주 수 (0 이면 오늘부터 이번 주 토요일까지) */
let page = 0;

/** 다른 화면으로 이동했다가 돌아오면 이번 주부터 다시 보인다 (다시 그리기에서는 보던 주를 유지한다) */
export function resetUpcoming(): void {
  page = 0;
  adding = null;
}

export const renderUpcoming: ViewRenderer = async (app, root) => {
  const today = app.today();
  const days = await upcomingView(app.ctx.db, today, page);
  const rowOpts = { today, projects: await projectLabels(app.ctx.db) };
  // 구글 캘린더에서 불러온 일정 (불러오기를 켜지 않았거나 실패하면 비어 있다)
  const events = eventsByDate(await loadEvents(app, days[0]!.date, days[days.length - 1]!.date), days[0]!.date, days[days.length - 1]!.date);

  root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '예정'), h('p', { class: 'view-sub' }, '오늘부터 앞으로의 할 일')));

  // 보이는 첫 날짜의 달 + 이전 주/오늘/다음 주
  const { y, m } = parseDate(days[0]!.date);
  const move = (to: number) => async (): Promise<void> => {
    page = Math.max(0, to);
    await app.refresh();
  };
  root.appendChild(
    h(
      'div',
      { class: 'board-nav' },
      h('span', { class: 'board-month' }, `${m}월 ${y}`),
      h(
        'div',
        { class: 'board-nav-btns', role: 'group', 'aria-label': '주 이동' },
        h('button', { type: 'button', class: 'btn btn-small', disabled: page === 0, onclick: move(page - 1) }, '이전 주'),
        h('button', { type: 'button', class: 'btn btn-small', disabled: page === 0, onclick: move(0) }, '오늘'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: move(page + 1) }, '다음 주'),
      ),
    ),
  );

  const board = h('div', { class: 'board' });
  root.appendChild(board);

  for (const day of days) {
    const label = formatLong(day.date);
    const headingId = `day-${day.date}`;
    const addBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-small',
        'aria-label': `${label}에 할 일 추가`,
        'aria-expanded': String(adding === day.date),
        'data-key': `add-day:${day.date}`,
        onclick: async () => {
          adding = adding === day.date ? null : day.date;
          await app.refresh();
          if (adding) document.querySelector<HTMLElement>(`[data-key="quick-add:upcoming:${day.date}"]`)?.focus();
        },
      },
      '+ 할 일 추가',
    );
    const section = h(
      'section',
      { class: 'section day', 'aria-labelledby': headingId },
      h('div', { class: 'section-head' }, h('h3', { id: headingId }, label), h('span', { class: 'day-count', 'aria-hidden': 'true' }, String(day.tasks.length + day.ghosts.length))),
    );
    // 그날의 구글 캘린더 일정: 할 일 카드 위에 읽기 전용 줄로 (시각이 정해진 약속을 먼저 보게)
    const dayEvents = events.get(day.date) ?? [];
    const eventList = renderEventList(dayEvents, day.date);
    if (eventList) section.appendChild(eventList);
    if (adding === day.date) section.appendChild(renderQuickAdd(app, { dueDate: day.date, keepKey: `upcoming:${day.date}` }));
    if (day.tasks.length > 0) section.appendChild(renderTaskList(app, day.tasks, rowOpts));
    // 반복 할 일의 앞으로의 회차: 실제 할 일 아래에 점선 카드로
    if (day.ghosts.length > 0) section.appendChild(renderGhostList(app, day.ghosts, rowOpts));
    if (day.tasks.length === 0 && day.ghosts.length === 0 && dayEvents.length === 0) section.appendChild(h('p', { class: 'hint' }, '할 일 없음'));
    section.appendChild(addBtn);
    board.appendChild(section);
  }
};
