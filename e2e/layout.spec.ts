import { test, expect, type Page } from '@playwright/test';
import { navTo, openApp } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

const nav = (page: Page) => page.getByRole('navigation', { name: '주 메뉴' });
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

test('좁은 화면(폭 390px): 상단바 → 본문 → 하단 탭 순으로 쌓이고, 스크롤해도 하단 탭이 화면 맨 아래에 붙어 있다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await openApp(page);
  await navTo(page, '캘린더'); // 세로로 긴 화면

  const top = await box(page, '.topbar');
  const main = await box(page, '.main');
  const tabs = (await nav(page).boundingBox())!;
  expect(top.y).toBeLessThan(2);
  expect(main.y).toBeGreaterThanOrEqual(top.y + top.height - 1); // 본문은 상단바 아래
  expect(tabs.y).toBeGreaterThan(main.y); // 하단 탭은 본문 뒤(아래)
  expect(Math.abs(tabs.y + tabs.height - 500)).toBeLessThan(2); // 스크롤하기 전에도 화면 맨 아래

  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(scrollable).toBeGreaterThan(100); // 실제로 스크롤되는 화면이어야 의미가 있다
  await page.mouse.wheel(0, 5000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  const after = (await nav(page).boundingBox())!;
  expect(Math.abs(after.y + after.height - 500)).toBeLessThan(2); // 스크롤한 뒤에도 그대로
  // 본문 마지막이 하단 탭에 가려지지 않는다
  const lastBottom = await page.evaluate(() => document.querySelector('.main')!.getBoundingClientRect().bottom);
  expect(lastBottom).toBeLessThanOrEqual(after.y + 1);
});

test('좁은 화면: 가로로 스크롤되는 하단 탭에서도 지금 보고 있는 탭이 화면 안에 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await openApp(page);
  for (const name of ['설정', '캘린더', '예정', '오늘']) {
    await navTo(page, name);
    await expect(nav(page).getByRole('link', { name, exact: true })).toBeInViewport();
  }
  // 새로고침해서 다시 그려져도 (설정은 맨 끝 탭) 가려지지 않는다
  await navTo(page, '설정');
  await page.reload();
  await expect(nav(page).getByRole('link', { name: '설정', exact: true })).toBeInViewport();
});

test('경계: 폭 767px 은 하단 탭, 768px 부터는 왼쪽 사이드바', async ({ page }) => {
  await openApp(page);
  await page.setViewportSize({ width: 767, height: 700 });
  await expect.poll(async () => (await nav(page).boundingBox())!.y).toBeGreaterThan(300); // 아래
  expect((await nav(page).boundingBox())!.width).toBeGreaterThan(700); // 가로로 넓게
  await page.setViewportSize({ width: 768, height: 700 });
  await expect.poll(async () => (await nav(page).boundingBox())!.x).toBeLessThan(2); // 왼쪽
  expect((await nav(page).boundingBox())!.width).toBeLessThan(300);
});

test('넓은 화면: 사이드바가 왼쪽 열이고 본문은 오른쪽 열이다 (좁은 화면 규칙이 새지 않는다)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openApp(page);
  const side = (await nav(page).boundingBox())!;
  const main = await box(page, '.main');
  expect(side.x).toBeLessThan(2);
  expect(side.width).toBeLessThan(300);
  expect(main.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
});
