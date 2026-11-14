// 태그 화면: 그 태그가 붙은 모든 할 일 (기한 유무와 관계없이, 프로젝트를 가로질러)
import type { ViewRenderer } from '../app.ts';
import { projectLabels, tagTasks } from '../views.ts';
import { h } from './dom.ts';
import { confirmDeleteTag, openTagRename } from './tags.ts';
import { renderCompleted, renderTaskList } from './task-list.ts';

export const renderTag: ViewRenderer = async (app, root, params) => {
  const tag = params[0] ?? '';
  const { open, completed } = await tagTasks(app.ctx.db, tag);
  const rowOpts = { today: app.today(), showDate: true, projects: await projectLabels(app.ctx.db) };

  root.appendChild(
    h(
      'div',
      { class: 'view-header' },
      h('h2', {}, `#${tag}`),
      h('p', { class: 'view-sub' }, '이 태그가 붙은 할 일'),
      // 이 태그를 모든 할 일에서 한꺼번에 바꾸거나 뗀다 (할 일 자체는 그대로)
      h(
        'span',
        { class: 'task-actions' },
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '태그 이름 바꾸기', onclick: (ev: Event) => openTagRename(app, tag, ev.currentTarget as HTMLElement) }, '이름 바꾸기'),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': '태그 지우기', onclick: (ev: Event) => void confirmDeleteTag(app, tag, ev.currentTarget as HTMLElement) }, '지우기'),
      ),
    ),
  );
  if (open.length > 0) {
    root.appendChild(h('section', { class: 'section open', 'aria-label': '할 일' }, renderTaskList(app, open, rowOpts)));
  } else {
    root.appendChild(h('p', { class: 'empty' }, completed.length > 0 ? '남은 할 일이 없어요' : '이 태그가 붙은 할 일이 없어요'));
  }
  const done = renderCompleted(app, completed, rowOpts);
  if (done) root.appendChild(done);
};
