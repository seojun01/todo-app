// 할 일 하나를 보여 주는 화면 (#/task/<id>): 알림을 누르면 여기로 온다. 이 기기에 있는 데이터로 보여 주므로 홈서버에 닿지 않아도 열린다.
import type { ViewRenderer } from '../app.ts';
import { getTask, type StoredTask } from '../store/tasks.ts';
import { projectLabels } from '../views.ts';
import { h } from './dom.ts';
import { renderTaskList } from './task-list.ts';

/** 이 실행에서 이미 동기화로 찾아 본 할 일 번호 (그리는 중에 동기화를 부르면 다시 그리기가 동기화를 또 불러 끝없이 반복되므로 한 번만 한다) */
const searched = new Set<string>();

export const renderTaskPage: ViewRenderer = async (app, root, params) => {
  const id = params[0] ?? '';
  const task: StoredTask | undefined = await getTask(app.ctx.db, id);
  let searching = false;
  if (!task && !searched.has(id)) {
    // 알림이 다른 기기에서 만든 할 일이면 아직 이 기기에 없을 수 있다: 그리기와 상관없이 뒤에서 한 번 동기화한다.
    // 끝나면 동기화 상태·저장소가 바뀌어 화면이 저절로 다시 그려진다.
    searched.add(id);
    searching = true;
    void app.sync.syncNow().catch(() => undefined);
  }
  if (!task || task.deleted) {
    root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '할 일을 찾을 수 없어요')));
    root.appendChild(
      h(
        'p',
        { class: 'empty' },
        searching ? '다른 기기에서 만든 할 일인지 찾고 있어요…' : '삭제되었거나 아직 이 기기로 전달되지 않은 할 일이에요. ',
        searching ? null : h('a', { href: '#/today' }, '오늘 화면으로 가기'),
      ),
    );
    return;
  }
  root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '할 일'), h('p', { class: 'view-sub' }, task.done ? '이미 끝낸 할 일이에요' : '알림이 온 할 일')));
  const rowOpts = { today: app.today(), showDate: true, projects: await projectLabels(app.ctx.db) };
  root.appendChild(h('section', { class: 'section open', 'aria-label': '할 일' }, renderTaskList(app, [task], rowOpts)));
  root.appendChild(h('p', {}, h('a', { href: '#/today' }, '오늘 화면으로 가기')));
};
