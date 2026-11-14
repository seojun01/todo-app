// 서비스 워커의 알림 처리 (sw.ts 가 이벤트에 연결한다). 브라우저 없이 테스트할 수 있도록 서비스 워커 전역(sw)을 받아서 쓴다.

export interface SwWindowClient {
  url: string;
  focused: boolean;
  visibilityState: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
export interface NotifySw {
  clients: { matchAll(opts: { type: 'window'; includeUncontrolled: boolean }): Promise<SwWindowClient[]>; openWindow(url: string): Promise<unknown> };
  registration: { showNotification(title: string, options: Record<string, unknown>): Promise<void> };
}

/** 알림 문구에는 할 일 제목을 넣지 않는다 (잠금 화면·푸시 서비스에 내용이 드러나지 않게). 앱이 열려 있으면 앱 안 알림에는 제목이 들어간다 (SC-014). */
export const GENERIC_TITLE = '할 일 1건이 있어요';
export const GENERIC_BODY = '눌러서 확인하세요.';
export const TEST_TITLE = '테스트 알림이에요';
export const TEST_BODY = '알림이 잘 도착했어요.';

/**
 * 푸시를 받았을 때: 열려 있는 창에는 알려서(앱 안 알림) 제목을 보여 주게 하고, 시스템 알림은 항상 띄운다.
 * 해석할 수 없는 페이로드여도 띄운다 — iOS 는 push 를 받고 알림을 띄우지 않으면 구독을 취소한다.
 */
export async function handlePush(sw: NotifySw, readJson: () => unknown): Promise<void> {
  let data: { taskId?: unknown; test?: unknown } = {};
  try {
    const parsed = readJson();
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {
    /* 해석할 수 없는 페이로드 */
  }
  const taskId = typeof data.taskId === 'string' ? data.taskId : undefined;
  const test = data.test === true;
  for (const w of await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage({ type: 'reminder', taskId, test });
  await sw.registration.showNotification(test ? TEST_TITLE : GENERIC_TITLE, {
    body: test ? TEST_BODY : GENERIC_BODY,
    tag: test ? 'test' : `task-${taskId ?? 'unknown'}`, // 같은 할 일의 알림은 하나로 합친다
    data: { taskId },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  });
}

/** 알림을 눌렀을 때: 열려 있는 창이 있으면 앞으로 가져와 그 할 일로 보내고, 없으면 새 창을 /?task=<id> 로 연다 */
export async function handleNotificationClick(sw: NotifySw, taskId: string | undefined): Promise<void> {
  const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.length > 0) {
    await wins[0]!.focus();
    wins[0]!.postMessage({ type: 'open-task', taskId });
    return;
  }
  await sw.clients.openWindow(taskId ? `/?task=${encodeURIComponent(taskId)}` : '/');
}
