// 설정 화면의 "알림" 영역: 이 기기에서 알림 받기(켜기/끄기·테스트)와 기본 알림 시각 (시각이 없는 할 일의 "당일"·"하루 전" 알림이 울리는 시각)
import type { App } from '../app.ts';
import { DEFAULT_REMINDER_TIME } from '../../../shared/task.ts';
import type { EnableResult, NotifyState, TestResult } from '../notify.ts';
import { h } from './dom.ts';

const STATE_HINT: Record<NotifyState['kind'], string> = {
  on: '',
  off: '켜면 알림 시각에 이 기기로 알림이 와요. 앱이 닫혀 있어도 와요. 알림 문구에는 할 일 제목이 들어가지 않아요.',
  denied: '이 기기는 알림이 차단돼 있어요. 브라우저(또는 기기 설정)에서 이 사이트의 알림을 허용한 뒤 다시 켜세요.',
  'needs-install': "iPhone·iPad에서는 Safari의 공유 버튼에서 '홈 화면에 추가'로 설치한 뒤, 설치한 앱에서 알림을 켤 수 있어요.",
  unsupported: '이 브라우저는 푸시 알림을 지원하지 않아요.',
  unpaired: '알림은 홈서버가 보내요. 먼저 이 기기를 홈서버에 등록해 주세요.',
  offline: '홈서버에 닿지 못해 알림 상태를 확인하지 못했어요.',
};
const ENABLE_FAIL: Record<Extract<EnableResult, { ok: false }>['reason'], string> = {
  denied: '알림 권한이 허용되지 않았어요. 브라우저(또는 기기 설정)에서 알림을 허용한 뒤 다시 켜 주세요.',
  unsupported: '이 브라우저는 푸시 알림을 지원하지 않아요.',
  'needs-install': "iPhone·iPad에서는 '홈 화면에 추가'로 설치한 앱에서 알림을 켤 수 있어요.",
  unpaired: '먼저 이 기기를 홈서버에 등록해 주세요.',
  offline: '홈서버에 닿지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.',
  server: '서버가 알림을 준비하지 못했어요. 서버의 알림 설정(키 파일)을 확인해 주세요.',
};
const TEST_FAIL: Record<Extract<TestResult, { ok: false }>['reason'], string> = {
  'not-subscribed': '이 기기는 알림을 구독하지 않았어요. 알림을 다시 켜 주세요.',
  disabled: '이 기기의 알림이 꺼져 있어요.',
  unavailable: '서버가 알림을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.',
  offline: '홈서버에 닿지 못했어요.',
};

/** 마지막으로 확인한 상태: 설정 화면을 다시 그릴 때 기다리지 않고 바로 보여 주기 위해 남겨 둔다 */
let lastState: NotifyState | null = null;
type ShownState = NotifyState | { kind: 'checking' };
const sameState = (a: ShownState, b: ShownState) => a.kind === b.kind && (a.kind !== 'on' || (b.kind === 'on' && a.timezone === b.timezone));

/**
 * "이 기기에서 알림 받기": 상태에 맞는 안내와 스위치, 켜져 있으면 테스트 알림 버튼.
 * 상태는 서버에 물어봐야 알 수 있어 느릴 수 있으므로 화면을 막지 않는다: 마지막으로 안 상태(없으면 "확인하는 중")로 먼저 그리고,
 * 확인이 끝나 달라졌을 때만 이 영역을 바꾼다 (설정 화면 전체를 다시 그리게 하지 않으므로 끝없이 반복되지 않는다).
 */
function renderDeviceNotify(app: App): HTMLElement {
  const box = h('div', { class: 'field' });
  let shown: ShownState = lastState ?? { kind: 'checking' };

  const draw = (state: ShownState): void => {
    shown = state;
    const usable = state.kind === 'on' || state.kind === 'off';
    const toggle = h('input', { type: 'checkbox', id: 'notify-enabled', 'aria-describedby': 'notify-enabled-hint' });
    toggle.defaultChecked = state.kind === 'on'; // 속성에도 넣어야 다른 기기의 변경이 반영된다 (기본 알림 시각과 같은 이유)
    toggle.checked = state.kind === 'on';
    toggle.disabled = !usable;
    const hintText = state.kind === 'checking' ? '알림 상태를 확인하는 중이에요…' : state.kind === 'on' ? `알림이 켜져 있어요. 시간대는 ${state.timezone}예요.` : STATE_HINT[state.kind];
    box.replaceChildren(
      h('label', { for: 'notify-enabled' }, toggle, ' 이 기기에서 알림 받기'),
      h('p', { class: 'hint', id: 'notify-enabled-hint', role: 'status' }, hintText),
    );
    if (state.kind === 'unpaired') box.appendChild(h('a', { class: 'btn btn-small', href: '#/pair' }, '이 기기 등록하기'));

    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      if (toggle.checked) {
        const r = await app.notify.enable();
        if (r.ok) app.toasts.show('이 기기의 알림을 켰어요', { duration: 3000 });
        else app.toasts.show(ENABLE_FAIL[r.reason], { duration: 8000 });
      } else {
        const ok = await app.notify.disable();
        app.toasts.show(ok ? '이 기기의 알림을 껐어요' : '홈서버에 닿지 못해 알림을 끄지 못했어요', { duration: 4000 });
      }
      await refresh();
    });

    if (state.kind === 'on') {
      const testBtn = h('button', { type: 'button', class: 'btn btn-small' }, '테스트 알림 보내기') as HTMLButtonElement;
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        const r = await app.notify.sendTest();
        app.toasts.show(r.ok ? '테스트 알림을 보냈어요. 잠시 뒤 알림이 와요.' : TEST_FAIL[r.reason], { duration: 6000 });
        testBtn.disabled = false;
      });
      box.appendChild(testBtn);
    }
  };

  async function refresh(): Promise<void> {
    const fresh = await app.notify.state();
    lastState = fresh;
    if (!sameState(shown, fresh) || !box.isConnected) draw(fresh);
  }

  draw(shown);
  void refresh();
  return box;
}

export async function renderNotifySection(app: App): Promise<HTMLElement> {
  const settings = await app.settings.get();
  const input = h('input', { type: 'time', id: 'default-reminder-time', 'aria-describedby': 'default-reminder-hint' });
  // value 프로퍼티만 바꾸면 다시 그릴 때 "화면이 같다"고 판단해 다른 기기에서 바꾼 값이 반영되지 않는다.
  // 속성(defaultValue)에도 넣어 저장된 값이 바뀌면 화면이 갱신되게 한다.
  input.defaultValue = settings.defaultReminderTime;
  input.value = settings.defaultReminderTime;
  const error = h('p', { class: 'error', role: 'alert' });
  error.hidden = true;

  input.addEventListener('change', async () => {
    error.hidden = true;
    const r = await app.settings.setDefaultReminderTime(input.value);
    if (!r.ok) {
      error.textContent = '시각을 입력해 주세요 (예: 09:00).';
      error.hidden = false;
      input.value = (await app.settings.get()).defaultReminderTime; // 이전 값으로 되돌린다
      return;
    }
    app.toasts.show(`기본 알림 시각을 ${r.settings.defaultReminderTime}로 바꿨어요`, { duration: 3000 });
  });

  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'notify-heading' },
    h('div', { class: 'section-head' }, h('h3', { id: 'notify-heading' }, '알림')),
    renderDeviceNotify(app),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'default-reminder-time' }, '기본 알림 시각'),
      input,
      h('p', { class: 'hint', id: 'default-reminder-hint' }, `기한 시각이 없는 할 일의 "당일"·"하루 전" 알림이 울리는 시각이에요. 기본값은 ${DEFAULT_REMINDER_TIME}이고, 모든 기기에 적용돼요.`),
      error,
    ),
  );
}
