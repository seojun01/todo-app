// 설정 화면의 "구글 캘린더" 영역: 연결 상태, 연결·해제, 지금 동기화
import type { App } from '../app.ts';
import { invalidateEvents, safeColor } from '../gcal-events.ts';
import { h } from './dom.ts';

interface GcalStatus {
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
}

async function call(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  return fetch(path, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'X-Todo-Client': '1', 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined });
}

async function load(): Promise<GcalStatus | null> {
  try {
    const res = await call('/api/gcal/status');
    return res.ok ? ((await res.json()) as GcalStatus) : null;
  } catch {
    return null;
  }
}

/** 기한이 있는 할 일이 구글 캘린더의 "할 일" 캘린더로 한 방향으로 복사된다는 설명 */
const EXPLAIN =
  "기한이 있는 할 일이 구글 캘린더의 '할 일' 캘린더에 일정으로 만들어져요. 수정·완료·삭제도 따라가요. 캘린더에서 고친 내용은 앱에 반영되지 않아요(한 방향). 이 연결로는 앱이 만든 캘린더만 다루고, 다른 캘린더는 볼 수도 고칠 수도 없어요. 기존 일정을 앱에서 보려면 아래에서 '일정 불러오기'를 따로 켜세요.";

interface ImportStatus {
  available: boolean;
  enabled: boolean;
  calendars: { id: string; name: string; color: string | null; selected: boolean; primary: boolean }[];
  lastImportAt: string | null;
  lastError: string | null;
}

const IMPORT_EXPLAIN =
  "구글 캘린더에 있는 일정을 읽기 전용으로 가져와 오늘·예정·캘린더 화면에 함께 보여 줘요. 제목과 시각만 가져오고(설명·참석자·장소는 가져오지 않아요) 이 홈서버에만 저장돼요. 앱에서 고치거나 지울 수는 없고, 이 앱이 만든 '할 일' 캘린더는 제외해요.";

/** "일정 불러오기" 영역. 읽기 권한이 없으면 허용하러 가는 버튼, 있으면 켜기/끄기와 불러올 캘린더 선택 */
function renderImportSection(app: App): HTMLElement {
  const body = h('div', {}, h('p', { class: 'hint' }, '불러오는 중…'));
  const box = h('div', { class: 'import-box' }, h('h4', { id: 'gcal-import-heading' }, '일정 불러오기'), body);
  box.setAttribute('role', 'group');
  box.setAttribute('aria-labelledby', 'gcal-import-heading');

  const post = async (path: string, payload: unknown = {}): Promise<ImportStatus> => {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'X-Todo-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(String(res.status));
    invalidateEvents(); // 다음에 화면을 그릴 때 새 일정을 받는다
    return (await res.json()) as ImportStatus;
  };
  const fail = (err: unknown): void => {
    console.error(err);
    app.toasts.show('요청하지 못했어요. 잠시 뒤 다시 시도해 주세요.', { duration: 6000 });
  };

  const draw = (st: ImportStatus | null): void => {
    body.replaceChildren();
    body.appendChild(h('p', { class: 'hint' }, IMPORT_EXPLAIN));
    if (!st) {
      body.appendChild(h('p', { class: 'hint' }, '불러오기 상태를 읽지 못했어요.'));
      return;
    }
    if (!st.available) {
      body.appendChild(h('p', { class: 'hint' }, '일정을 읽으려면 구글에서 읽기 권한을 한 번 더 허용해야 해요. 구글 화면으로 이동해요.'));
      const grant = h('button', { type: 'button', class: 'btn' }, '일정 불러오기 켜기') as HTMLButtonElement;
      grant.addEventListener('click', async () => {
        grant.disabled = true;
        try {
          const res = await fetch('/api/gcal/connect', { method: 'POST', credentials: 'same-origin', headers: { 'X-Todo-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ import: true }) });
          if (!res.ok) throw new Error(String(res.status));
          location.assign(((await res.json()) as { url: string }).url);
        } catch (err) {
          fail(err);
          grant.disabled = false;
        }
      });
      body.appendChild(grant);
      return;
    }

    const toggle = h('input', { type: 'checkbox', id: 'gcal-import-enabled' }) as HTMLInputElement;
    toggle.checked = st.enabled;
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        draw(await post('/api/gcal/import/settings', { enabled: toggle.checked }));
      } catch (err) {
        fail(err);
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    });
    body.appendChild(h('div', { class: 'field' }, h('label', { for: 'gcal-import-enabled' }, toggle, ' 구글 캘린더 일정을 이 앱에 표시')));
    if (!st.enabled) return;

    // 불러올 캘린더 고르기
    if (st.calendars.length === 0) {
      body.appendChild(h('p', { class: 'hint' }, '캘린더 목록을 불러오는 중이에요. 잠시 뒤 "지금 불러오기"를 눌러 주세요.'));
    } else {
      const boxes = st.calendars.map((c) => {
        const input = h('input', { type: 'checkbox', value: c.id, id: `gcal-cal-${c.id}` }) as HTMLInputElement;
        input.checked = c.selected;
        const color = safeColor(c.color);
        const dot = h('span', { class: 'dot', 'aria-hidden': 'true', ...(color ? { style: `--c: ${color}` } : {}) });
        return { input, label: h('label', { for: input.id, class: 'cal-pick' }, input, dot, ` ${c.name}`, c.primary ? ' (기본)' : '') };
      });
      for (const { input } of boxes) {
        input.addEventListener('change', async () => {
          boxes.forEach((b) => (b.input.disabled = true));
          try {
            draw(await post('/api/gcal/import/settings', { calendars: boxes.filter((b) => b.input.checked).map((b) => b.input.value) }));
          } catch (err) {
            fail(err);
            input.checked = !input.checked;
            boxes.forEach((b) => (b.input.disabled = false));
          }
        });
      }
      body.appendChild(h('fieldset', { class: 'field' }, h('legend', {}, '불러올 캘린더'), ...boxes.map((b) => b.label)));
    }

    const when = st.lastImportAt ? new Date(st.lastImportAt).toLocaleString('ko-KR') : '아직 없어요';
    body.appendChild(h('p', {}, `마지막으로 불러온 때: ${when}`));
    if (st.lastError) body.appendChild(h('p', { class: 'hint warn', role: 'status' }, st.lastError));
    const refresh = h('button', { type: 'button', class: 'btn' }, '지금 불러오기') as HTMLButtonElement;
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        const next = await post('/api/gcal/import/refresh');
        app.toasts.show(next.lastError ? '불러오지 못한 캘린더가 있어요' : '구글 캘린더 일정을 불러왔어요', { duration: 4000 });
        draw(next);
      } catch (err) {
        fail(err);
        refresh.disabled = false;
      }
    });
    body.appendChild(h('div', { class: 'sheet-actions' }, refresh));
  };

  void (async () => {
    try {
      const res = await fetch('/api/gcal/import', { credentials: 'same-origin' });
      draw(res.ok ? ((await res.json()) as ImportStatus) : null);
    } catch {
      draw(null);
    }
  })();
  return box;
}

export function renderGcalSection(app: App, paired: boolean): HTMLElement {
  const body = h('div', {});
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'gcal-heading' },
    h('div', { class: 'section-head' }, h('h3', { id: 'gcal-heading' }, '구글 캘린더')),
    body,
  );

  if (!paired) {
    body.appendChild(h('p', { class: 'hint' }, '이 기기를 홈서버에 등록하면 구글 캘린더와 연동할 수 있어요.'));
    return section;
  }
  body.appendChild(h('p', { class: 'hint' }, '불러오는 중…'));

  const draw = (st: GcalStatus | null): void => {
    body.replaceChildren();
    if (!st) {
      body.appendChild(h('p', { class: 'hint' }, '연동 상태를 불러오지 못했어요 (오프라인이에요).'));
      return;
    }
    if (!st.configured) {
      body.appendChild(
        h('p', { class: 'hint' }, '이 서버에는 구글 연동 설정이 없어요. 서버 관리자가 구글 클라이언트 ID와 시크릿을 설정해야 해요.'),
      );
      return;
    }
    body.appendChild(h('p', { class: 'hint' }, EXPLAIN));

    const run = async (btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> => {
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        console.error(err);
        app.toasts.show('요청하지 못했어요. 잠시 뒤 다시 시도해 주세요.', { duration: 6000 });
      } finally {
        btn.disabled = false;
      }
    };
    const refresh = async (): Promise<void> => draw(await load());

    const connectBtn = h('button', { type: 'button', class: 'btn btn-primary' }, st.needsReauth ? '다시 연결하기' : '구글 캘린더 연결하기') as HTMLButtonElement;
    connectBtn.addEventListener('click', () =>
      run(connectBtn, async () => {
        const res = await call('/api/gcal/connect', 'POST');
        if (!res.ok) throw new Error(String(res.status));
        location.assign(((await res.json()) as { url: string }).url);
      }),
    );

    if (!st.connected) {
      if (st.lastError) body.appendChild(h('p', { class: 'hint warn', role: 'status' }, st.lastError));
      body.appendChild(connectBtn);
      return;
    }

    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('ko-KR') : '아직 없어요';
    body.appendChild(h('p', {}, `연결됨 · 마지막 동기화: ${when}`));
    if (st.pending > 0) body.appendChild(h('p', { class: 'hint' }, `아직 반영하지 못한 변경이 ${st.pending}개 있어요.`));
    if (st.lastError) body.appendChild(h('p', { class: 'hint warn', role: 'status' }, st.lastError));

    const syncBtn = h('button', { type: 'button', class: 'btn' }, '지금 동기화') as HTMLButtonElement;
    syncBtn.addEventListener('click', () =>
      run(syncBtn, async () => {
        const res = await call('/api/gcal/sync', 'POST');
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as GcalStatus;
        app.toasts.show(next.lastError ? '동기화하지 못한 항목이 있어요' : '구글 캘린더와 동기화했어요', { duration: 4000 });
        draw(next);
      }),
    );
    const offBtn = h('button', { type: 'button', class: 'btn btn-danger' }, '연결 해제') as HTMLButtonElement;
    offBtn.addEventListener('click', () =>
      run(offBtn, async () => {
        const res = await call('/api/gcal/disconnect', 'POST');
        if (!res.ok) throw new Error(String(res.status));
        invalidateEvents(); // 불러온 일정은 서버에서 지워졌으니 이 기기의 보관본도 버린다
        app.toasts.show("연결을 해제했어요. 구글 캘린더의 '할 일' 캘린더와 일정은 그대로 남아 있어요.", { duration: 7000 });
        await refresh();
      }),
    );
    body.appendChild(h('div', { class: 'sheet-actions' }, syncBtn, offBtn));
    body.appendChild(renderImportSection(app));
  };

  void load().then(draw);
  return section;
}
