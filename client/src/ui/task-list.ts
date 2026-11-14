// 할 일 목록 컴포넌트: 한 줄(완료 토글·제목·메타·수정/삭제), 접힌 "완료됨", 빠른 추가
import type { App } from '../app.ts';
import { formatShort, formatTime } from '../format.ts';
import { describeRecurrence } from '../../../shared/recurrence.ts';
import { REMINDER_LABELS } from '../../../shared/reminders.ts';
import { INBOX_ID, MAX_TITLE, splitInlineTags, tagsOf } from '../../../shared/task.ts';
import type { ProjectLabel } from '../views.ts';
import type { StoredTask } from '../store/tasks.ts';
import { h } from './dom.ts';
import { PRIORITY_LABELS, describeErrors, limitTitle, openTaskEditor } from './task-editor.ts';

export interface RowOptions {
  /** 기한 날짜를 항상 보여 준다 (기한 지남 구분, 프로젝트 화면) */
  showDate?: boolean;
  /** 오늘 날짜 — 기한 지남 강조에 쓴다 */
  today: string;
  /** 있으면 각 할 일에 소속 프로젝트(색상 점 + 이름)를 보여 준다 (오늘·예정 화면, FR-015) */
  projects?: Map<string, ProjectLabel>;
  /** 지금 시각 — 오늘 기한인 할 일의 시각이 지났는지 강조하는 데 쓴다 (renderRow 가 채운다) */
  now?: Date;
  /** 카드를 끌어 다른 날짜 칸으로 옮길 수 있게 한다 (예정 화면) */
  draggable?: boolean;
}

/** 끌고 있는 카드의 id 를 dataTransfer 에 싣는 형식 */
export const TASK_DRAG_TYPE = 'application/x-todo-task-id';

/** 완료됨 영역의 펼침 상태는 다시 그려도 유지한다 */
let completedOpen = false;

async function guarded(app: App, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(err);
    app.toasts.show('저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.', { duration: 8000 });
  }
}

/** 카드의 메타 줄: 우선순위·기한·시각·반복·프로젝트·태그. 앞으로의 회차(withDate=false)에는 날짜를 붙이지 않는다 (칸의 날짜가 곧 그 날짜). */
function buildMeta(t: StoredTask, opts: RowOptions, withDate = true): (Node | string)[] {
  const meta: (Node | string)[] = [];
  if (t.priority < 4) {
    // 색상만으로 구분하지 않는다: 아이콘(⚑) + 텍스트(P1) + 화면 낭독기용 텍스트
    meta.push(
      h(
        'span',
        { class: `badge badge-p${t.priority}` },
        h('span', { 'aria-hidden': 'true' }, `⚑ P${t.priority}`),
        h('span', { class: 'sr-only' }, `우선순위 ${PRIORITY_LABELS[t.priority]}`),
      ),
    );
  }
  const overdue = t.dueDate !== null && !t.done && t.dueDate < opts.today;
  if (withDate && t.dueDate && (opts.showDate || overdue)) {
    meta.push(h('span', { class: `chip${overdue ? ' overdue' : ''}` }, formatShort(t.dueDate)));
  }
  if (t.dueTime) {
    // 오늘 기한인데 시각이 이미 지난 미완료 할 일은 강조한다 (색만으로 구분하지 않도록 글도 덧붙인다)
    const nowHm = opts.now ? `${String(opts.now.getHours()).padStart(2, '0')}:${String(opts.now.getMinutes()).padStart(2, '0')}` : null;
    const timePassed = !t.done && nowHm !== null && t.dueDate === opts.today && t.dueTime < nowHm;
    meta.push(h('span', { class: `chip${timePassed ? ' past-time' : ''}` }, formatTime(t.dueTime), timePassed ? h('span', { class: 'sr-only' }, ' (시각이 지났어요)') : null));
  }
  if (t.recurrence) {
    meta.push(h('span', { class: 'chip' }, h('span', { 'aria-hidden': 'true' }, '↻'), `반복: ${describeRecurrence(t.recurrence)}`));
  }
  if (t.reminders.length > 0 && !t.done) {
    // 알림이 걸려 있음을 아이콘 + 글로 보인다 (색만으로 구분하지 않는다)
    meta.push(h('span', { class: 'chip' }, h('span', { 'aria-hidden': 'true' }, '🔔'), `알림: ${t.reminders.map((k) => REMINDER_LABELS[k]).join('·')}`));
  }
  if (opts.projects) {
    // 삭제되었거나 없는 프로젝트의 할 일은 수신함으로 보인다
    const label = opts.projects.get(t.projectId) ?? opts.projects.get(INBOX_ID);
    if (label) meta.push(h('span', { class: 'chip' }, h('span', { class: 'dot', 'data-color': label.color, 'aria-hidden': 'true' }), h('span', {}, label.name)));
  }

  for (const tag of tagsOf(t)) {
    meta.push(h('a', { class: 'chip tag', href: `#/tag/${encodeURIComponent(tag)}`, 'aria-label': `태그 ${tag}` }, `#${tag}`));
  }
  return meta;
}

function renderRow(app: App, t: StoredTask, opts: RowOptions): HTMLLIElement {
  const titleId = `t-${t.id}`;
  const check = h(
    'button',
    {
      type: 'button',
      class: 'task-check',
      role: 'checkbox',
      'aria-checked': String(t.done),
      'aria-labelledby': titleId,
      'data-key': `check:${t.id}`,
      'data-priority': String(t.priority),
      onclick: () =>
        guarded(app, async () => {
          const r = await app.tasks.toggleDone(t.id);
          await app.refresh();
          // 반복 할 일은 미완료로 남은 채 다음 회차로 넘어간다 — 알리고 되돌릴 수 있게 한다 (FR-018)
          if (r.ok && t.recurrence && !t.done && !r.task.done && r.task.dueDate) {
            app.toasts.show(`다음 일정으로 넘겼어요 · ${formatShort(r.task.dueDate)}`, {
              actionLabel: '실행 취소',
              onAction: async () => {
                await guarded(app, async () => {
                  await app.tasks.undoComplete();
                  await app.refresh();
                });
              },
            });
          }
        }),
    },
    t.done ? '✓' : '',
  );

  const meta = buildMeta(t, { ...opts, now: app.ctx.now() });

  const edit = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      'aria-label': `${t.title} 수정`,
      'data-key': `edit:${t.id}`,
      onclick: (ev: Event) => openTaskEditor(app, { task: t, opener: ev.currentTarget as HTMLElement }),
    },
    '수정',
  );
  const del = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-small btn-danger',
      'aria-label': `${t.title} 삭제`,
      'data-key': `del:${t.id}`,
      onclick: () =>
        guarded(app, async () => {
          const r = await app.tasks.deleteTask(t.id);
          if (!r.ok) return;
          await app.refresh();
          app.toasts.show('삭제했어요', {
            actionLabel: '실행 취소',
            onAction: async () => {
              await guarded(app, async () => {
                await app.tasks.undoDelete();
                await app.refresh();
              });
            },
          });
        }),
    },
    '삭제',
  );

  const li = h(
    'li',
    { class: `task${t.done ? ' done' : ''}`, 'data-key': `task:${t.id}`, draggable: opts.draggable && !t.done ? 'true' : null },
    check,
    h('div', { class: 'task-main' }, h('p', { class: 'task-title', id: titleId }, t.title), meta.length ? h('div', { class: 'task-meta' }, ...meta) : null),
    h('div', { class: 'task-actions' }, edit, del),
  );
  if (opts.draggable && !t.done) {
    li.addEventListener('dragstart', (ev) => {
      ev.dataTransfer?.setData(TASK_DRAG_TYPE, t.id);
      ev.dataTransfer?.setData('text/plain', t.title);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
  }
  return li;
}

/** 반복 할 일의 앞으로의 회차(가상) 한 장. 아직 오지 않은 회차라 완료·삭제는 없고, 시리즈를 고치는 버튼만 있다. */
function renderGhost(app: App, t: StoredTask, opts: RowOptions): HTMLLIElement {
  const edit = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      'aria-label': `${t.title} 반복 일정 수정`,
      'data-key': `edit-ghost:${t.id}`,
      onclick: (ev: Event) => openTaskEditor(app, { task: t, opener: ev.currentTarget as HTMLElement }),
    },
    '수정',
  );
  const meta = buildMeta(t, opts, false);
  return h(
    'li',
    { class: 'task-ghost', 'data-key': `ghost:${t.id}` },
    h('span', { class: 'ghost-mark', 'aria-hidden': 'true' }, '↻'),
    h('div', { class: 'task-main' }, h('p', { class: 'task-title' }, t.title), meta.length ? h('div', { class: 'task-meta' }, ...meta) : null),
    h('div', { class: 'task-actions' }, edit),
  );
}

/** 앞으로 반복되는 회차들. 라벨로 일반 할 일과 구분한다 (예정된 일이지 지금 할 일이 아니다). */
export function renderGhostList(app: App, tasks: StoredTask[], opts: RowOptions): HTMLUListElement {
  return h('ul', { class: 'tasks ghosts', 'aria-label': '반복 예정' }, ...tasks.map((t) => renderGhost(app, t, opts)));
}

export function renderTaskList(app: App, tasks: StoredTask[], opts: RowOptions): HTMLUListElement {
  return h('ul', { class: 'tasks' }, ...tasks.map((t) => renderRow(app, t, opts)));
}

/** 접힌 "완료됨" 영역. 완료한 할 일이 없으면 null */
export function renderCompleted(app: App, tasks: StoredTask[], opts: RowOptions): HTMLElement | null {
  if (tasks.length === 0) return null;
  const details = h('details', { class: 'completed' }, h('summary', { 'data-key': 'completed-summary' }, `완료됨 (${tasks.length})`), renderTaskList(app, tasks, opts));
  // 지금 화면에 이미 펼쳐진 영역이 있으면 그 실제 상태를 따른다. 사용자가 펼치면 브라우저가 open 속성을 바로 바꾸지만
  // toggle 이벤트(비동기)가 오기 전에 다시 그리면 접힌 모습으로 되돌려 버리기 때문이다.
  const live = document.querySelector<HTMLDetailsElement>('details.completed');
  details.open = live ? live.open : completedOpen;
  details.addEventListener('toggle', () => (completedOpen = details.open));
  return details;
}

export interface QuickAddOptions {
  /** 새 할 일의 기본 기한 */
  dueDate: string | null;
  projectId?: string;
  /** 다시 그려도 입력 중인 값을 유지하기 위한 키 */
  keepKey: string;
}

export function renderQuickAdd(app: App, opts: QuickAddOptions): HTMLElement {
  const input = h('input', {
    type: 'text',
    placeholder: '할 일 추가 (#태그 가능)',
    'aria-label': '할 일 추가',
    autocomplete: 'off',
    'data-keep': opts.keepKey,
    'data-key': `quick-add:${opts.keepKey}`,
  });
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;

  input.addEventListener('input', () => {
    if (limitTitle(input)) {
      error.textContent = `제목은 ${MAX_TITLE}자까지 입력할 수 있어요.`;
      error.hidden = false;
    } else error.hidden = true;
  });

  const form = h(
    'form',
    { class: 'quick-add', novalidate: true },
    input,
    h('button', { type: 'submit', class: 'btn btn-primary' }, '추가'),
  );
  const box = h('div', {}, form, error);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    try {
      // 글 앞이나 끝에 붙여 쓴 #태그는 태그가 된다 ("장보기 #집", "#집 장보기" → 제목 "장보기", 태그 집)
      const { title, tags } = splitInlineTags(input.value);
      const r = await app.tasks.addTask({ title, tags, dueDate: opts.dueDate, projectId: opts.projectId });
      if (!r.ok) {
        error.textContent = describeErrors(r.errors);
        error.hidden = false;
        input.focus();
        return; // 입력한 내용은 그대로 남긴다
      }
      input.value = '';
      await app.refresh();
      focusByKey(input.getAttribute('data-key'));
    } catch (err) {
      console.error(err);
      error.textContent = '저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요. 입력한 내용은 그대로 남아 있어요.';
      error.hidden = false;
    }
  });
  return box;
}

/** 추가 후 빠른 추가 입력에 포커스를 돌려 연속으로 입력할 수 있게 한다 */
function focusByKey(key: string | null): void {
  if (!key) return;
  document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
}
