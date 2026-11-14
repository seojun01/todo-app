import { test, expect, type Page } from '@playwright/test';

// (서비스 워커 파일이 실제로 바뀌는 흐름은 Playwright 가 서비스 워커 스크립트 요청을 가로채지 못해 자동으로 흉내 낼 수 없다.
//  그 흐름은 새로 빌드한 뒤 registration.update() 를 불러 브라우저에서 직접 확인한다.)

// 서비스 워커가 캐시를 먼저 보여 주므로, 새 버전이 받아져도 열려 있는 화면은 옛 코드로 돈다.
// 새 버전이 적용되면 "새로고침" 안내가 떠야 한다 (처음 설치될 때는 새 버전이 아니니 뜨지 않는다).
test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'allow' });

const toast = (page: Page) => page.getByText('앱이 새 버전으로 업데이트됐어요. 새로고침하면 바로 쓸 수 있어요.');
const controlled = (page: Page) => page.evaluate(() => !!navigator.serviceWorker.controller);

async function openControlled(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // 두 번째 로드부터 서비스 워커가 페이지를 맡는다
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
  await expect.poll(() => controlled(page)).toBe(true);
}

test('처음 설치되는 서비스 워커는 "새 버전" 안내를 띄우지 않는다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
  // 처음 설치 후 서비스 워커가 페이지를 맡을 때까지 기다린다 (이때 controllerchange 가 한 번 발생한다)
  await expect.poll(() => controlled(page), { timeout: 15_000 }).toBe(true);
  await expect(toast(page)).toHaveCount(0);
});

test('이미 서비스 워커가 맡고 있던 페이지에서 서비스 워커가 바뀌면 새로고침 안내가 뜬다', async ({ page }) => {
  await openControlled(page);
  await expect(toast(page)).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await expect(toast(page)).toBeVisible();
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: '새로고침' }).click();
  await reloaded;
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
  await expect(toast(page)).toHaveCount(0); // 새로 열린 화면에는 안내가 없다
});
