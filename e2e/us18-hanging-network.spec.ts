import { test, expect } from '@playwright/test';
import { openApp, pairThisDevice } from './helpers.ts';

// 다른 네트워크에서 WireGuard 터널이 멈추면 서버 요청이 응답 없이 매달린다 (끊기지도 않는다).
// 그래도 화면은 이 기기에 저장된 할 일로 바로 떠야 한다.
test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block' });
test.setTimeout(60_000);

test('서버 요청이 응답 없이 매달려도 오늘 화면이 바로 보인다', async ({ page }) => {
  await page.route('**/api/changes**', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { changes: [], cursor: 0, hasMore: false } }) : route.fulfill({ json: { applied: 0, ignored: 0, cursor: 0 } })));
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ json: { events: [] } }));
  await openApp(page);
  await pairThisDevice(page, '매달림 확인');

  await page.unroute('**/api/gcal/events**');
  await page.route('**/api/gcal/events**', () => {
    /* 응답도 오류도 주지 않고 그대로 둔다 */
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: '오늘' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
});
