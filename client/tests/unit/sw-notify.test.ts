import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_BODY, GENERIC_TITLE, TEST_BODY, TEST_TITLE, handleNotificationClick, handlePush, type NotifySw, type SwWindowClient } from '../../src/sw-notify.ts';

const ID = '3f2c1d7e-8a4b-4c1e-9d3a-0123456789ab';

function makeSw(windows: Partial<SwWindowClient>[] = []) {
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const messages: unknown[] = [];
  const focused: number[] = [];
  const clients: SwWindowClient[] = windows.map((w, i) => ({
    url: 'http://localhost/',
    focused: false,
    visibilityState: 'visible',
    focus: async () => void focused.push(i),
    postMessage: (m: unknown) => void messages.push({ to: i, ...(m as object) }),
    ...w,
  }));
  const sw: NotifySw = {
    clients: { matchAll: async () => clients, openWindow: async (url) => void opened.push(url) },
    registration: { showNotification: async (title, options) => void shown.push({ title, options }) },
  };
  return { sw, shown, opened, messages, focused };
}

test('푸시: 시스템 알림에는 제목이 없는 일반 문구가 들어가고, 같은 할 일은 같은 tag 로 합쳐진다', async () => {
  const m = makeSw();
  await handlePush(m.sw, () => ({ v: 1, taskId: ID }));
  assert.equal(m.shown.length, 1);
  assert.equal(m.shown[0]!.title, GENERIC_TITLE);
  assert.equal(GENERIC_TITLE, '할 일 1건이 있어요');
  assert.equal(m.shown[0]!.options.body, GENERIC_BODY);
  assert.equal(m.shown[0]!.options.tag, `task-${ID}`);
  assert.deepEqual(m.shown[0]!.options.data, { taskId: ID });
  assert.equal(JSON.stringify(m.shown[0]).includes('치과'), false, '알림 내용에 할 일 제목이 없다');
});

test('푸시: 열려 있는 모든 창에 알려서 앱 안 알림을 띄우게 하고, 시스템 알림도 함께 띄운다', async () => {
  const m = makeSw([{}, { visibilityState: 'hidden' }]);
  await handlePush(m.sw, () => ({ v: 1, taskId: ID }));
  assert.deepEqual(m.messages, [
    { to: 0, type: 'reminder', taskId: ID, test: false },
    { to: 1, type: 'reminder', taskId: ID, test: false },
  ]);
  assert.equal(m.shown.length, 1, '창이 열려 있어도 시스템 알림은 항상 띄운다 (iOS 규칙)');
});

test('푸시: 테스트 푸시는 테스트 문구와 tag=test, 앱 안 알림에는 test 표시', async () => {
  const m = makeSw([{}]);
  await handlePush(m.sw, () => ({ v: 1, test: true }));
  assert.equal(m.shown[0]!.title, TEST_TITLE);
  assert.equal(m.shown[0]!.options.body, TEST_BODY);
  assert.equal(m.shown[0]!.options.tag, 'test');
  assert.deepEqual(m.messages, [{ to: 0, type: 'reminder', taskId: undefined, test: true }]);
});

test('푸시: 해석할 수 없거나 비어 있거나 엉뚱한 페이로드여도 시스템 알림은 반드시 띄운다 (iOS 는 안 띄우면 구독을 취소한다)', async () => {
  for (const read of [
    () => {
      throw new SyntaxError('bad json');
    },
    () => undefined,
    () => null,
    () => 'text',
    () => 42,
    () => ({ taskId: 123 }),
    () => ({ taskId: { evil: true } }),
    () => ({}),
  ]) {
    const m = makeSw([{}]);
    await handlePush(m.sw, read);
    assert.equal(m.shown.length, 1);
    assert.equal(m.shown[0]!.title, GENERIC_TITLE);
    assert.equal(m.shown[0]!.options.tag, 'task-unknown');
    assert.equal((m.messages[0] as { taskId: unknown }).taskId, undefined, '문자열이 아닌 taskId 는 버린다');
  }
});

test('알림 누르기: 열려 있는 창이 있으면 앞으로 가져와 그 할 일로 보낸다 (새 창을 열지 않는다)', async () => {
  const m = makeSw([{}, {}]);
  await handleNotificationClick(m.sw, ID);
  assert.deepEqual(m.focused, [0]);
  assert.deepEqual(m.messages, [{ to: 0, type: 'open-task', taskId: ID }]);
  assert.deepEqual(m.opened, []);
});

test('알림 누르기: 열려 있는 창이 없으면 /?task=<id> 로 새 창을 연다 (id 는 주소에 안전하게 넣는다)', async () => {
  const m = makeSw([]);
  await handleNotificationClick(m.sw, ID);
  assert.deepEqual(m.opened, [`/?task=${ID}`]);
  const odd = makeSw([]);
  await handleNotificationClick(odd.sw, 'a b&c=d/e?f');
  assert.deepEqual(odd.opened, ['/?task=a%20b%26c%3Dd%2Fe%3Ff']);
  const none = makeSw([]);
  await handleNotificationClick(none.sw, undefined);
  assert.deepEqual(none.opened, ['/']);
});
