// 태그 이름 바꾸기 시트와 태그 지우기 확인 대화상자 (태그 화면에서 연다)
import type { App } from '../app.ts';
import { MAX_TAG } from '../../../shared/task.ts';
import { tagTasks } from '../views.ts';
import { h } from './dom.ts';

const tagHash = (tag: string) => `#/tag/${encodeURIComponent(tag)}`;

/** 바꾸거나 지운 직후 "실행 취소": 태그가 붙어 있던 할 일의 이전 태그로 되돌린다 */
function offerUndo(app: App, message: string, previous: { id: string; tags: string[] }[], backTo: string): void {
  app.toasts.show(message, {
    duration: 8000,
    actionLabel: '실행 취소',
    onAction: async () => {
      try {
        await app.tasks.restoreTags(previous);
        app.navigate(backTo);
        await app.refresh();
      } catch (err) {
        console.error(err);
        app.toasts.show('되돌리지 못했어요. 다시 시도해 주세요.', { duration: 6000 });
      }
    },
  });
}

export function openTagRename(app: App, tag: string, opener?: HTMLElement | null): void {
  const input = h('input', { type: 'text', id: 'tag-name', autocomplete: 'off', 'aria-describedby': 'tag-name-hint' });
  input.value = tag;
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, '바꾸기');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, '취소');
  const form = h(
    'form',
    { method: 'dialog', novalidate: true },
    h('h2', { id: 'tag-rename-heading' }, '태그 이름 바꾸기'),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'tag-name' }, '새 이름'),
      input,
      h('p', { class: 'hint', id: 'tag-name-hint' }, `공백·쉼표 없이 ${MAX_TAG}자까지. 이미 있는 태그 이름이면 두 태그가 하나로 합쳐져요.`),
    ),
    error,
    h('div', { class: 'sheet-actions' }, cancelBtn, saveBtn),
  );
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'tag-rename-heading' }, form);
  document.body.appendChild(dialog);
  const close = () => {
    if (dialog.open) dialog.close();
  };
  cancelBtn.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    dialog.remove();
    opener?.focus();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    saveBtn.disabled = true;
    try {
      const r = await app.tasks.replaceTag(tag, input.value);
      if (!r.ok) {
        error.textContent = `태그 이름은 공백·쉼표 없이 1~${MAX_TAG}자여야 해요.`;
        error.hidden = false;
        input.focus();
        return;
      }
      const next = input.value.trim().replace(/^#+/, '');
      close();
      if (r.count === 0) {
        await app.refresh();
        return;
      }
      app.navigate(tagHash(next)); // 지금 보던 태그 주소가 바뀌었으니 새 이름의 화면으로 간다
      await app.refresh();
      offerUndo(app, `태그를 '#${next}'(으)로 바꿨어요 (할 일 ${r.count}개)`, r.previous, tagHash(tag));
    } catch (err) {
      console.error(err);
      error.textContent = '저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.';
      error.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });
  dialog.showModal();
  input.focus();
  input.select();
}

/** 몇 개의 할 일에서 태그가 빠지는지 알리고 확인을 받은 뒤에만 지운다. 할 일 자체는 지워지지 않는다. */
export async function confirmDeleteTag(app: App, tag: string, opener?: HTMLElement | null): Promise<void> {
  const { open, completed } = await tagTasks(app.ctx.db, tag);
  const count = open.length + completed.length;
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, '취소');
  const deleteBtn = h('button', { type: 'button', class: 'btn btn-danger' }, '태그 지우기');
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;
  const dialog = h(
    'dialog',
    { class: 'sheet', role: 'alertdialog', 'aria-labelledby': 'tag-del-heading', 'aria-describedby': 'tag-del-desc' },
    h('h2', { id: 'tag-del-heading' }, '태그 지우기'),
    h('p', { id: 'tag-del-desc' }, count > 0 ? `'#${tag}' 태그를 지울까요? 할 일 ${count}개에서 태그만 빠지고, 할 일은 그대로 남아요.` : `'#${tag}' 태그가 붙은 할 일이 없어요.`),
    error,
    h('div', { class: 'sheet-actions' }, cancelBtn, count > 0 ? deleteBtn : null),
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
      const r = await app.tasks.replaceTag(tag, null);
      if (!r.ok) throw new Error('태그 지우기 실패');
      close();
      app.navigate('#/today');
      await app.refresh();
      offerUndo(app, `'#${tag}' 태그를 지웠어요 (할 일 ${r.count}개)`, r.previous, tagHash(tag));
    } catch (err) {
      console.error(err);
      error.textContent = '지우지 못했어요. 다시 시도해 주세요.';
      error.hidden = false;
    } finally {
      deleteBtn.disabled = false;
    }
  });
  dialog.showModal();
  cancelBtn.focus(); // 일괄로 바뀌는 동작이므로 기본 포커스는 "취소"
}
