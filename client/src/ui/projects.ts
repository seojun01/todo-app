// 프로젝트 생성·수정 시트와 삭제 확인 대화상자
import type { App } from '../app.ts';
import { MAX_PROJECT_NAME, PROJECT_COLORS, type ProjectColor, type FieldError } from '../../../shared/task.ts';
import type { StoredProject } from '../store/projects.ts';
import { h } from './dom.ts';

/** 색상 이름도 글로 제공해 색을 구분하지 못해도 고를 수 있게 한다 */
export const COLOR_NAMES: Record<ProjectColor, string> = {
  red: '빨강',
  orange: '주황',
  yellow: '노랑',
  green: '초록',
  teal: '청록',
  blue: '파랑',
  purple: '보라',
  gray: '회색',
};

function describe(errors: FieldError[]): string {
  const e = errors[0]!;
  if (e.field === 'name' && e.rule === 'empty') return '이름을 입력해 주세요.';
  if (e.field === 'name' && e.rule === 'length') return `이름은 ${MAX_PROJECT_NAME}자까지 입력할 수 있어요.`;
  if (e.field === 'color') return '색상을 골라 주세요.';
  return '프로젝트를 저장하지 못했어요.';
}

export function openProjectEditor(app: App, opts: { project?: StoredProject; opener?: HTMLElement | null } = {}): void {
  const { project } = opts;
  const heading = project ? '프로젝트 수정' : '프로젝트 추가';

  const nameInput = h('input', { type: 'text', id: 'project-name', autocomplete: 'off' });
  nameInput.value = project?.name ?? '';
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;
  nameInput.addEventListener('input', () => {
    const cps = [...nameInput.value];
    if (cps.length > MAX_PROJECT_NAME) {
      nameInput.value = cps.slice(0, MAX_PROJECT_NAME).join('');
      error.textContent = `이름은 ${MAX_PROJECT_NAME}자까지 입력할 수 있어요.`;
      error.hidden = false;
    }
  });

  const selected = project?.color ?? 'gray';
  const colors = h(
    'fieldset',
    { class: 'field' },
    h('legend', {}, '색상'),
    h(
      'div',
      { class: 'radio-row' },
      ...PROJECT_COLORS.map((c) => {
        const radio = h('input', { type: 'radio', name: 'project-color', value: c, id: `color-${c}` });
        radio.checked = c === selected;
        return h('label', { for: `color-${c}` }, radio, h('span', { class: 'dot', 'data-color': c }), COLOR_NAMES[c]);
      }),
    ),
  );

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, '저장');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, '취소');
  const form = h(
    'form',
    { method: 'dialog', novalidate: true },
    h('h2', { id: 'project-heading' }, heading),
    h('div', { class: 'field' }, h('label', { for: 'project-name' }, '이름'), nameInput),
    colors,
    error,
    h('div', { class: 'sheet-actions' }, cancelBtn, saveBtn),
  );
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'project-heading' }, form);
  document.body.appendChild(dialog);

  const close = () => {
    if (dialog.open) dialog.close();
  };
  cancelBtn.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    dialog.remove();
    opts.opener?.focus();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    saveBtn.disabled = true;
    try {
      const color = (form.querySelector<HTMLInputElement>('input[name="project-color"]:checked')?.value ?? 'gray') as ProjectColor;
      const r = project
        ? await app.projects.updateProject(project.id, { name: nameInput.value, color })
        : await app.projects.createProject({ name: nameInput.value, color });
      if (!r.ok) {
        error.textContent = describe(r.errors);
        error.hidden = false;
        nameInput.focus();
        return;
      }
      close();
      await app.refresh();
    } catch (err) {
      console.error(err);
      error.textContent = '저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요. 입력한 내용은 그대로 남아 있어요.';
      error.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  dialog.showModal();
  nameInput.focus();
}

/** 소속 할 일 개수를 알리는 확인을 거친 뒤에만 삭제한다 (FR-014, 헌법 II) */
export async function confirmDeleteProject(app: App, project: StoredProject, opener?: HTMLElement | null): Promise<void> {
  const count = await app.projects.countTasks(project.id);
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, '취소');
  const deleteBtn = h('button', { type: 'button', class: 'btn btn-danger' }, '삭제');
  const message = h(
    'p',
    {},
    count > 0 ? `'${project.name}' 프로젝트를 삭제할까요? 할 일 ${count}개도 함께 삭제됩니다.` : `'${project.name}' 프로젝트를 삭제할까요? 이 프로젝트에는 할 일이 없어요.`,
  );
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;
  const dialog = h(
    'dialog',
    { class: 'sheet', role: 'alertdialog', 'aria-labelledby': 'del-heading', 'aria-describedby': 'del-desc' },
    h('h2', { id: 'del-heading' }, '프로젝트 삭제'),
    h('div', { id: 'del-desc' }, message),
    error,
    h('div', { class: 'sheet-actions' }, cancelBtn, deleteBtn),
  );
  document.body.appendChild(dialog);
  const close = () => {
    if (dialog.open) dialog.close();
  };
  cancelBtn.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    dialog.remove();
    opener?.focus();
  });
  deleteBtn.addEventListener('click', async () => {
    deleteBtn.disabled = true;
    try {
      const r = await app.projects.deleteProject(project.id);
      if (!r.ok) throw new Error('삭제 실패');
      close();
      app.navigate('#/today');
      await app.refresh();
      app.toasts.show(`프로젝트를 삭제했어요 (할 일 ${r.deletedTasks}개 포함)`, { duration: 5000 });
    } catch (err) {
      console.error(err);
      error.textContent = '삭제하지 못했어요. 다시 시도해 주세요.';
      error.hidden = false;
    } finally {
      deleteBtn.disabled = false;
    }
  });
  dialog.showModal();
  cancelBtn.focus(); // 파괴적인 동작이므로 기본 포커스는 "취소"
}
