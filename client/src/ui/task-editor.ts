// 할 일 추가·수정 시트: 제목·기한·시각·반복·알림·프로젝트·태그·우선순위.
import type { App } from '../app.ts';
import { INBOX_ID, MAX_TAG, MAX_TAGS, MAX_TITLE, durationOf, effectiveProjectId, parseTags, tagKey, tagsOf, type FieldError, type Priority } from '../../../shared/task.ts';
import { listProjects } from '../store/projects.ts';
import { tagSummaries } from '../views.ts';
import { createRecurrenceField } from './recurrence-field.ts';
import { editorNotice } from '../notify.ts';
import { createReminderField } from './reminder-field.ts';
import type { StoredTask } from '../store/tasks.ts';
import { h } from './dom.ts';

export interface EditorOptions {
  /** 있으면 수정, 없으면 추가 */
  task?: StoredTask;
  /** 추가할 때의 기본값 */
  defaults?: { dueDate?: string | null; dueTime?: string | null; durationMin?: number | null; projectId?: string };
  /** 닫을 때 포커스를 돌려줄 요소 */
  opener?: HTMLElement | null;
}

const FIELD_LABELS: Record<string, string> = { title: '제목', dueDate: '기한', dueTime: '기한 시각', durationMin: '길이', reminders: '알림', priority: '우선순위', tags: '태그' };

/** 길이 선택지(분). 이 밖의 값(캘린더에서 끌어 늘린 길이)은 그 값이 선택지에 더해진다. */
const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240];

/** 90 → "1시간 30분", 45 → "45분" */
export function formatDuration(min: number): string {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return [hh > 0 ? `${hh}시간` : '', mm > 0 ? `${mm}분` : ''].filter(Boolean).join(' ');
}

export const PRIORITY_LABELS: Record<Priority, string> = { 1: '1 긴급', 2: '2 높음', 3: '3 보통', 4: '4 없음' };

export function describeErrors(errors: FieldError[]): string {
  const e = errors[0]!;
  if (e.field === 'title' && e.rule === 'empty') return '제목을 입력해 주세요.';
  if (e.field === 'title' && e.rule === 'length') return `제목은 ${MAX_TITLE}자까지 입력할 수 있어요.`;
  if (e.field === 'dueDate') return '기한 날짜가 올바르지 않아요.';
  if (e.field === 'dueTime') return '기한 시각이 올바르지 않아요. 시각은 기한이 있어야 정할 수 있어요.';
  if (e.field === 'durationMin') {
    if (e.rule === 'crosses-midnight') return '일정이 자정을 넘을 수 없어요. 길이를 줄이거나 시작 시각을 앞당겨 주세요.';
    if (e.rule === 'requires-dueTime') return '길이는 기한 시각이 있어야 정할 수 있어요.';
    return '일정 길이가 올바르지 않아요.';
  }
  if (e.field === 'reminders') return '고른 알림을 이 기한에는 쓸 수 없어요. 시각이 있으면 정시·10분 전·30분 전·1시간 전·하루 전, 없으면 당일·하루 전이에요.';
  if (e.field === 'tags') {
    if (e.rule === 'count') return `태그는 ${MAX_TAGS}개까지 붙일 수 있어요.`;
    return `태그는 공백·쉼표 없이 ${MAX_TAG}자까지 쓸 수 있어요.`;
  }
  if (e.field === 'recurrence') {
    if (e.rule === 'requires-dueDate') return '반복에는 기한이 필요해요. 먼저 기한을 정하세요.';
    if (e.rule === 'endDate-before-due' || e.rule === 'endDate') return '종료 날짜는 기한보다 빠를 수 없어요. 종료 날짜를 먼저 바꾸세요.';
    if (e.rule === 'weekdays') return '반복할 요일을 하나 이상 골라 주세요.';
    if (e.rule === 'interval') return '반복 간격은 1~99 사이여야 해요.';
    return '반복 설정이 올바르지 않아요.';
  }
  return `${FIELD_LABELS[e.field] ?? e.field} 값이 올바르지 않아요.`;
}

/** 입력이 200자(코드 포인트)를 넘으면 잘라 내고 true 를 돌려준다 (초과 입력은 막고 안내한다) */
export function limitTitle(input: HTMLInputElement): boolean {
  const cps = [...input.value];
  if (cps.length <= MAX_TITLE) return false;
  input.value = cps.slice(0, MAX_TITLE).join('');
  return true;
}

export async function openTaskEditor(app: App, opts: EditorOptions = {}): Promise<void> {
  const { task } = opts;
  const allProjects = await listProjects(app.ctx.db);
  const liveProjects = allProjects.filter((p) => !p.deleted);
  const editing = task !== undefined;
  const heading = editing ? '할 일 수정' : '할 일 추가';

  const titleInput = h('input', { type: 'text', id: 'editor-title', autocomplete: 'off', required: false });
  titleInput.value = task?.title ?? '';
  const dateInput = h('input', { type: 'date', id: 'editor-date' });
  dateInput.value = task ? (task.dueDate ?? '') : (opts.defaults?.dueDate ?? '');
  // 소속 프로젝트: 삭제되었거나 없는 프로젝트의 할 일은 수신함으로 보인다
  const initialProject = task ? effectiveProjectId(task, allProjects) : liveProjects.some((p) => p.id === opts.defaults?.projectId) ? opts.defaults!.projectId! : INBOX_ID;
  const projectSelect = h(
    'select',
    { id: 'editor-project' },
    h('option', { value: INBOX_ID }, '수신함'),
    ...liveProjects.map((p) => h('option', { value: p.id }, p.name)),
  );
  projectSelect.value = initialProject;
  // 태그: 공백이나 쉼표로 구분해 입력하고, 이미 쓰고 있는 태그는 눌러서 넣고 뺀다
  const tagsInput = h('input', { type: 'text', id: 'editor-tags', autocomplete: 'off', placeholder: '예: 집 급함 (공백이나 쉼표로 구분)', 'aria-describedby': 'editor-tags-hint' });
  tagsInput.value = tagsOf(task ?? {}).join(' ');
  const suggestRow = h('div', { class: 'tag-suggest', role: 'group', 'aria-label': '쓰고 있는 태그' });
  const drawSuggest = (existing: { name: string }[]): void => {
    const current = new Set(parseTags(tagsInput.value).map(tagKey));
    suggestRow.replaceChildren(
      ...existing.slice(0, 20).map(({ name }) =>
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small tag-pill',
            'aria-pressed': String(current.has(tagKey(name))),
            onclick: () => {
              const list = parseTags(tagsInput.value);
              const has = list.some((x) => tagKey(x) === tagKey(name));
              tagsInput.value = (has ? list.filter((x) => tagKey(x) !== tagKey(name)) : [...list, name]).join(' ');
              drawSuggest(existing);
            },
          },
          `#${name}`,
        ),
      ),
    );
  };
  const existingTags = await tagSummaries(app.ctx.db);
  drawSuggest(existingTags);
  tagsInput.addEventListener('input', () => drawSuggest(existingTags));
  const initialPriority: Priority = task?.priority ?? 4;
  const priorityGroup = h(
    'fieldset',
    { class: 'field' },
    h('legend', {}, '우선순위'),
    h(
      'div',
      { class: 'radio-row' },
      ...([1, 2, 3, 4] as Priority[]).map((p) => {
        const radio = h('input', { type: 'radio', name: 'editor-priority', value: String(p), id: `editor-priority-${p}` });
        radio.checked = p === initialPriority;
        return h('label', { for: `editor-priority-${p}` }, radio, PRIORITY_LABELS[p]);
      }),
    ),
  );
  const repeat = createRecurrenceField(task?.recurrence ?? null, () => dateInput.value);
  // 기한 시각과 알림: 알림이 울릴 시각은 이 기기의 시간대로 계산하고, 기본 알림 시각은 설정을 따른다
  // 이 기기에서 알림이 울릴 수 있는지는 서버에 물어봐야 알 수 있다. 시트가 늦게 열리지 않도록 기다리지 않고, 알게 되면 안내를 갱신한다.
  let deviceNotice: string | null = null;
  const reminder = createReminderField({
    initialTime: task ? task.dueTime : (opts.defaults?.dueTime ?? null),
    initialReminders: task?.reminders ?? [],
    getDate: () => dateInput.value,
    settings: await app.settings.get(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: () => app.ctx.now(),
    deviceNotice: () => deviceNotice,
  });
  // 길이: 시작 시각이 있을 때만 고를 수 있다 (캘린더에서 그 길이의 블록으로 보인다)
  const durationSelect = h('select', { id: 'editor-duration' });
  const durationHint = h('p', { class: 'hint' }, '먼저 기한 시각을 정하세요. 길이에는 시각이 필요해요.');
  const durationField = h('div', { class: 'field' }, h('label', { for: 'editor-duration' }, '길이'), durationSelect, durationHint);
  const fillDurations = (current: number | null): void => {
    const values = new Set<number>([...DURATION_CHOICES, ...(current !== null ? [current] : [])]);
    durationSelect.replaceChildren(
      h('option', { value: '' }, '정하지 않음'),
      ...[...values].sort((a, b) => a - b).map((m) => h('option', { value: String(m) }, formatDuration(m))),
    );
    durationSelect.value = current !== null ? String(current) : '';
  };
  fillDurations(task ? durationOf(task) : (opts.defaults?.durationMin ?? null));
  const syncDuration = (): void => {
    const hasTime = reminder.readTime() !== null;
    durationSelect.disabled = !hasTime;
    durationHint.hidden = hasTime;
    if (!hasTime) durationSelect.value = '';
  };
  void app.notify.state().then((s) => {
    deviceNotice = editorNotice(s);
    reminder.refresh();
  });
  dateInput.addEventListener('input', () => {
    repeat.refresh();
    reminder.refresh();
    syncDuration();
  });
  const clearDate = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-small',
      onclick: () => {
        dateInput.value = '';
        repeat.refresh();
        reminder.refresh();
        syncDuration();
      },
    },
    '기한 없음',
  );
  const errorBox = h('p', { class: 'error', role: 'alert' });
  errorBox.hidden = true;
  const hint = h('p', { class: 'hint' });

  titleInput.addEventListener('input', () => {
    hint.textContent = limitTitle(titleInput) ? `제목은 ${MAX_TITLE}자까지 입력할 수 있어요.` : '';
  });

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, '저장');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, '취소');

  const form = h(
    'form',
    // 검증은 shared/task.ts 가 한다. 브라우저 검증을 끄지 않으면 WebKit 이 비워진 날짜 입력을 오류로 보고 제출을 조용히 막는다.
    { method: 'dialog', novalidate: true },
    h('h2', { id: 'editor-heading' }, heading),
    h('div', { class: 'field' }, h('label', { for: 'editor-title' }, '제목'), titleInput, hint),
    h('div', { class: 'field' }, h('label', { for: 'editor-date' }, '기한'), h('div', { class: 'row' }, dateInput, clearDate)),
    reminder.timeElement,
    durationField,
    h('div', { class: 'field' }, h('label', { for: 'editor-project' }, '프로젝트'), projectSelect),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'editor-tags' }, '태그'),
      tagsInput,
      h('p', { class: 'hint', id: 'editor-tags-hint' }, `공백이나 쉼표로 구분해요. 최대 ${MAX_TAGS}개, 하나에 ${MAX_TAG}자까지.`),
      existingTags.length > 0 ? suggestRow : null,
    ),
    priorityGroup,
    repeat.element,
    reminder.remindersElement,
    errorBox,
    h('div', { class: 'sheet-actions' }, cancelBtn, saveBtn),
  );
  // 시각 입력이 바뀌거나 "시각 없음"을 누르면 길이 선택을 맞춘다 (이벤트는 폼까지 올라온다)
  form.addEventListener('input', syncDuration);
  form.addEventListener('change', syncDuration);
  form.addEventListener('click', syncDuration);
  syncDuration();
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'editor-heading' }, form);
  document.body.appendChild(dialog);

  const close = () => {
    if (dialog.open) dialog.close();
  };
  cancelBtn.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    dialog.remove();
    opts.opener?.focus(); // 열었던 버튼으로 포커스를 돌려준다
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorBox.hidden = true;
    saveBtn.disabled = true;
    try {
      const dueDate = dateInput.value === '' ? null : dateInput.value;
      const dueTime = reminder.readTime();
      const durationMin = dueTime !== null && durationSelect.value !== '' ? Number(durationSelect.value) : null;
      const reminders = reminder.readReminders();
      const projectId = projectSelect.value;
      const recurrence = repeat.readRule();
      const tags = parseTags(tagsInput.value);
      const priority = Number(form.querySelector<HTMLInputElement>('input[name="editor-priority"]:checked')?.value ?? 4) as Priority;
      const result = editing
        ? await app.tasks.editTask(task.id, { title: titleInput.value, dueDate, dueTime, durationMin, reminders, priority, recurrence, tags, ...(projectId !== initialProject ? { projectId } : {}) })
        : await app.tasks.addTask({ title: titleInput.value, dueDate, dueTime, durationMin, reminders, projectId, priority, recurrence, tags });
      if (!result.ok) {
        errorBox.textContent = describeErrors(result.errors);
        errorBox.hidden = false;
        titleInput.focus();
        return; // 입력한 내용은 그대로 남긴다
      }
      close();
      await app.refresh();
    } catch (err) {
      console.error(err);
      errorBox.textContent = '저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요. 입력한 내용은 그대로 남아 있어요.';
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  dialog.showModal();
  titleInput.focus();
}
