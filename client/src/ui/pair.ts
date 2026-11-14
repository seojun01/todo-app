// 기기 등록 화면: 서버에서 받은 일회용 페어링 코드로 이 기기를 등록한다 (FR-035)
import type { ViewRenderer } from '../app.ts';
import { commit } from '../store/db.ts';
import { h } from './dom.ts';

const MESSAGES: Record<string, string> = {
  invalid_code: '코드가 틀렸거나 만료되었어요. 서버에서 새 코드를 받아 주세요.',
  rate_limited: '시도가 너무 많아요. 1분 뒤에 다시 시도해 주세요.',
};

export const renderPair: ViewRenderer = (app, root) => {
  const input = h('input', { type: 'text', id: 'pair-code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text' });
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '등록');

  const form = h(
    'form',
    { novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'pair-code' }, '페어링 코드'), input),
    error,
    h('div', { class: 'sheet-actions' }, submit),
  );

  async function register(deviceId: string): Promise<Response> {
    return fetch('/api/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Todo-Client': '1' },
      body: JSON.stringify({ code: input.value, deviceId }),
    });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      let res = await register(app.ctx.deviceId);
      let body = (await res.json()) as { error?: string };
      if (res.status === 400 && body.error === 'invalid_device_id') {
        // 해제된 기기를 다시 등록하는 경우: 서버에 남아 있는 이전 기기 ID 와 겹치므로 새 ID 를 쓴다
        const fresh = crypto.randomUUID();
        res = await register(fresh);
        body = (await res.json()) as { error?: string };
        if (res.status === 201) {
          app.ctx.deviceId = fresh;
          await commit(app.ctx.db, { meta: { deviceId: fresh } }, { silent: true });
        }
      }
      if (res.status !== 201) {
        error.textContent = MESSAGES[body.error ?? ''] ?? '등록하지 못했어요. 코드를 다시 확인해 주세요.';
        error.hidden = false;
        input.focus();
        return;
      }
      await app.sync.markPaired(); // 등록 전에 만든 로컬 데이터를 모두 올릴 대상으로 만든다
      app.realtime?.restart();
      await app.sync.syncNow();
      app.navigate('#/today');
    } catch (err) {
      console.error(err);
      error.textContent = '홈서버에 연결할 수 없어요. 같은 네트워크(또는 VPN)에 연결되어 있는지 확인해 주세요.';
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '기기 등록')));
  root.appendChild(
    h('p', { class: 'view-sub' }, '홈서버에서 todo-admin pair --name "기기 이름" 을 실행해 받은 코드를 입력하세요. 코드는 10분 동안 한 번만 쓸 수 있어요.'),
  );
  root.appendChild(form);
  queueMicrotask(() => input.focus());
};
