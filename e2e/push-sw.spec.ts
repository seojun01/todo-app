import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { quickAdd, row } from './helpers.ts';

// 실제 서비스 워커에 push 이벤트를 직접 전달해(CDP) 시스템 알림과 앱 안 알림을 확인한다.
// 크로미엄 전용 프로젝트(chromium-push)에서만 돈다: 서비스 워커로 push 를 전달하는 CDP 는 크로미엄에만 있고,
// 기본 헤드리스 셸은 알림 권한을 허용해도 거부 상태로 남아 showNotification 이 실패하므로 전체 크로미엄 채널을 쓴다.
test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'allow' });

test.describe('실제 서비스 워커의 push 처리', () => {
  async function setupPush(page: Page, context: BrowserContext) {
    await context.grantPermissions(['notifications']);
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const cdp = await context.newCDPSession(page);
    const origin = new URL(page.url()).origin;
    const registrationId = new Promise<string>((resolve) =>
      cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => {
        const r = e.registrations.find((x) => x.scopeURL.startsWith(origin));
        if (r) resolve(r.registrationId);
      }),
    );
    await cdp.send('ServiceWorker.enable');
    const id = await registrationId;
    return {
      push: (payload: unknown) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: id, data: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
      notifications: () =>
        page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data as unknown }))),
    };
  }

  test('push 를 받으면 제목 없는 시스템 알림이 뜨고, 앱이 열려 있으면 제목이 든 앱 안 알림이 뜨며 "열기"로 그 할 일에 간다', async ({ page, context }) => {
    const sw = await setupPush(page, context);
    await quickAdd(page, '약 먹기');
    const id = ((await row(page, '약 먹기').getAttribute('data-key')) ?? '').replace('task:', '');

    await sw.push({ v: 1, taskId: id });
    await expect(page.getByText("'약 먹기' 알림이에요")).toBeVisible(); // 앱 안 알림에는 제목이 있다
    await expect.poll(sw.notifications).toEqual([{ title: '할 일 1건이 있어요', body: '눌러서 확인하세요.', tag: `task-${id}`, data: { taskId: id } }]);
    expect(JSON.stringify(await sw.notifications())).not.toContain('약 먹기'); // 시스템 알림에는 제목이 없다

    await page.getByRole('button', { name: '열기' }).click();
    await expect(page.getByRole('heading', { level: 2, name: '할 일' })).toBeVisible();
    expect(page.url()).toBe(`http://localhost:8080/#/task/${id}`);
    await expect(row(page, '약 먹기')).toBeVisible();

    // 같은 할 일의 알림이 또 오면 하나로 합쳐진다 (같은 tag)
    await sw.push({ v: 1, taskId: id });
    await expect.poll(async () => (await sw.notifications()).length).toBe(1);
  });

  test('이미 끝낸 할 일의 알림은 앱 안 알림을 띄우지 않고, 시스템 알림은 그래도 띄운다 (iOS 규칙)', async ({ page, context }) => {
    const sw = await setupPush(page, context);
    await quickAdd(page, '끝낸 일');
    const id = ((await row(page, '끝낸 일').getAttribute('data-key')) ?? '').replace('task:', '');
    await row(page, '끝낸 일').getByRole('checkbox').click();
    await expect(row(page, '끝낸 일')).toBeHidden();
    await sw.push({ v: 1, taskId: id });
    await expect.poll(async () => (await sw.notifications()).length).toBe(1);
    await expect(page.getByText("'끝낸 일' 알림이에요")).toHaveCount(0);
  });

  test('테스트 push 는 "테스트 알림이에요" 시스템 알림과 "테스트 알림이 도착했어요" 앱 안 알림이다, 깨진 페이로드여도 알림은 뜬다', async ({ page, context }) => {
    const sw = await setupPush(page, context);
    await sw.push({ v: 1, test: true });
    await expect(page.getByText('테스트 알림이 도착했어요')).toBeVisible();
    await expect.poll(sw.notifications).toEqual([{ title: '테스트 알림이에요', body: '알림이 잘 도착했어요.', tag: 'test', data: {} }]);

    await sw.push('이건 JSON 이 아니에요');
    await expect.poll(async () => (await sw.notifications()).map((n) => n.title).sort()).toEqual(['테스트 알림이에요', '할 일 1건이 있어요']);
  });
});
