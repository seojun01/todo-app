// 오늘 화면: 기한 지남 + 오늘 + 완료됨
import type { ViewRenderer } from '../app.ts';
import { formatLong } from '../format.ts';
import { eventsByDate, loadEvents } from '../gcal-events.ts';
import { projectLabels, splitByUrgency, todayProgress, todayView } from '../views.ts';
import { h } from './dom.ts';
import { renderEventList } from './event-list.ts';
import { renderCompleted, renderQuickAdd, renderTaskList } from './task-list.ts';

export const renderToday: ViewRenderer = async (app, root) => {
  const today = app.today();
  const v = await todayView(app.ctx.db, today);
  const rowOpts = { today, projects: await projectLabels(app.ctx.db), reorderable: true };
  root.classList.add('today-layout'); // 넓은 화면에서 구글 일정을 오른쪽 칸으로 (CSS)

  root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '오늘'), h('p', { class: 'view-sub' }, formatLong(today))));
  const { done, total, left } = todayProgress(v);
  if (left > 0 || v.completed.length > 0) {
    root.appendChild(
      h(
        'div',
        { class: 'today-summary' },
        total > 0 ? h('span', { class: 'ring', style: `--pct:${Math.round((done / total) * 100)}`, 'aria-hidden': 'true' }, h('span', { class: 'ring-num' }, `${done}/${total}`)) : null,
        h('p', { class: 'today-summary-text' }, left > 0 ? `오늘 ${left}개 남았어요` : '오늘 할 일을 모두 끝냈어요'),
        total > 0 ? h('span', { class: 'sr-only' }, `오늘 ${total}개 중 ${done}개 완료`) : null,
      ),
    );
  }
  // 오늘의 구글 캘린더 일정 (불러오기를 켜지 않았거나 실패하면 없다)
  const todayEvents = renderEventList(eventsByDate(await loadEvents(app, today, today), today, today).get(today) ?? [], today);
  if (todayEvents) root.appendChild(todayEvents);
  root.appendChild(renderQuickAdd(app, { dueDate: today, keepKey: 'today' }));

  if (v.overdue.length > 0) {
    root.appendChild(
      h(
        'section',
        { class: 'section overdue', 'aria-labelledby': 'overdue-heading' },
        h(
          'div',
          { class: 'section-head' },
          h('h3', { id: 'overdue-heading' }, `기한 지남 (${v.overdue.length})`),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: async () => {
                try {
                  await app.tasks.moveOverdueToToday(today);
                  await app.refresh();
                } catch (err) {
                  console.error(err);
                  app.toasts.show('저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.', { duration: 8000 });
                }
              },
            },
            '모두 오늘로',
          ),
        ),
        renderTaskList(app, v.overdue, rowOpts),
      ),
    );
  }

  // 오늘 몫은 우선순위로 두 구역으로 나눈다. 직접 정한 순서(드래그)는 구역 안에서만 의미가 있다.
  const { hot, rest } = splitByUrgency(v.today);
  for (const [id, cls, title, group] of [['hot-heading', 'group-hot', '지금 중요', hot], ['rest-heading', 'group-rest', '나머지', rest]] as const) {
    if (group.length === 0) continue;
    root.appendChild(
      h(
        'section',
        { class: `section open ${cls}`, 'aria-labelledby': id },
        h('div', { class: 'section-head' }, h('h3', { id }, `${title} (${group.length})`)),
        renderTaskList(app, group, rowOpts),
      ),
    );
  }

  if (v.overdue.length === 0 && v.today.length === 0) {
    root.appendChild(
      h('p', { class: 'empty' }, v.completed.length > 0 ? '오늘 할 일을 모두 끝냈어요 🎉' : '오늘 할 일이 없어요'),
    );
  }

  const completed = renderCompleted(app, v.completed, rowOpts);
  if (completed) root.appendChild(completed);
};
