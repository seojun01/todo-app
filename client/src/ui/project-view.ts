// 수신함·프로젝트 화면: 기한 유무와 관계없이 소속된 모든 할 일
import type { ViewRenderer } from '../app.ts';
import { INBOX_ID } from '../../../shared/task.ts';
import { getProject } from '../store/projects.ts';
import { projectTasks } from '../views.ts';
import { h } from './dom.ts';
import { confirmDeleteProject, openProjectEditor } from './projects.ts';
import { renderCompleted, renderQuickAdd, renderTaskList } from './task-list.ts';

export const renderProject: ViewRenderer = async (app, root, params) => {
  const projectId = params[0] ?? INBOX_ID;
  const isInbox = projectId === INBOX_ID;
  const project = isInbox ? undefined : await getProject(app.ctx.db, projectId);

  if (!isInbox && (!project || project.deleted)) {
    root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '프로젝트를 찾을 수 없어요')));
    root.appendChild(h('p', { class: 'empty' }, '삭제되었거나 아직 이 기기로 전달되지 않은 프로젝트예요. ', h('a', { href: '#/project/inbox' }, '수신함으로 가기')));
    return;
  }

  const today = app.today();
  const { open, completed } = await projectTasks(app.ctx.db, projectId);
  const rowOpts = { today, showDate: true };

  const header = h('div', { class: 'view-header' }, h('h2', {}, project ? project.name : '수신함'));
  if (project) {
    header.prepend(h('span', { class: 'dot', 'data-color': project.color, 'aria-hidden': 'true' }));
    header.appendChild(
      h(
        'span',
        { class: 'task-actions' },
        h('button', {
          type: 'button',
          class: 'btn btn-small',
          'aria-label': '프로젝트 수정',
          onclick: (ev: Event) => openProjectEditor(app, { project, opener: ev.currentTarget as HTMLElement }),
        }, '수정'),
        h('button', {
          type: 'button',
          class: 'btn btn-small btn-danger',
          'aria-label': '프로젝트 삭제',
          onclick: (ev: Event) => void confirmDeleteProject(app, project, ev.currentTarget as HTMLElement),
        }, '삭제'),
      ),
    );
  }
  root.appendChild(header);
  root.appendChild(renderQuickAdd(app, { dueDate: null, projectId, keepKey: `project:${projectId}` }));

  if (open.length > 0) {
    root.appendChild(h('section', { class: 'section open', 'aria-label': '할 일' }, renderTaskList(app, open, rowOpts)));
  } else {
    root.appendChild(h('p', { class: 'empty' }, isInbox ? '수신함이 비어 있어요' : '이 프로젝트는 비어 있어요'));
  }
  const done = renderCompleted(app, completed, rowOpts);
  if (done) root.appendChild(done);
};
