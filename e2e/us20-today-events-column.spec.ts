import { test, expect, type Page } from '@playwright/test';
import { navTo, openApp, openEditor, pairThisDevice, quickAdd } from './helpers.ts';

// WebKit 은 서비스워커가 켜져 있으면 page.route 로 가로챈 응답이 앱에 닿지 않아 us12 처럼 서비스워커를 막는다.
test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block' });
test.setTimeout(60_000);

const TODAY_EVENT = {
  id: 'cal:1', calendarId: 'cal', calendarName: '내 일정', color: '#1a73e8', title: '아침 회의',
  startDate: '2026-11-12', endDate: '2026-11-12', startTime: '09:30', endTime: '10:00', allDay: false,
};

async function paired(page: Page, events: unknown[]): Promise<void> {
  await page.route('**/api/changes**', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { changes: [], cursor: 0, hasMore: false } }) : route.fulfill({ json: { applied: 0, ignored: 0, cursor: 0 } }),
  );
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ json: { events } }));
  await openApp(page);
  await pairThisDevice(page, '일정 칸 확인');
  await navTo(page, '오늘');
  await quickAdd(page, '할 일 하나');
}
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

test('넓은 화면(1280): 구글 일정이 할 일 목록의 오른쪽 칸에 있다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await paired(page, [TODAY_EVENT]);
  await expect(page.locator('ul.events li.event')).toHaveCount(1);
  const events = await box(page, 'ul.events');
  const tasks = await box(page, 'ul.tasks');
  expect(events.x).toBeGreaterThanOrEqual(tasks.x + tasks.width);
});

test('좁은 화면(390): 일정이 입력줄 위에 쌓인다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await paired(page, [TODAY_EVENT]);
  await expect(page.locator('ul.events li.event')).toHaveCount(1);
  const events = await box(page, 'ul.events');
  const add = await box(page, 'form.quick-add');
  expect(events.y).toBeLessThan(add.y);
});

test('경계 폭 1099·1100 에서 가로 스크롤이 없다', async ({ page }) => {
  await paired(page, [TODAY_EVENT]);
  for (const width of [1099, 1100]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('일정이 없으면 오른쪽 칸이 만들어지지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await paired(page, []);
  await expect(page.locator('ul.events')).toHaveCount(0);
});

test('일정이 아주 많아도 왼쪽 칸의 위치가 달라지지 않는다 (행 높이가 늘어나지 않는다)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await paired(page, [TODAY_EVENT]);
  await expect(page.locator('ul.events li.event')).toHaveCount(1);
  const before = (await box(page, 'form.quick-add')).y;
  const many = Array.from({ length: 40 }, (_, i) => ({ ...TODAY_EVENT, id: `cal:${i}`, title: `일정 ${i}`, startTime: `${String(8 + (i % 10)).padStart(2, '0')}:00`, endTime: `${String(9 + (i % 10)).padStart(2, '0')}:00` }));
  await page.unroute('**/api/gcal/events**');
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ json: { events: many } }));
  await page.reload();
  await expect(page.locator('ul.events li.event')).toHaveCount(40);
  expect((await box(page, 'ul.events')).height).toBeGreaterThan(800); // 일정 칸이 왼쪽 칸보다 훨씬 높은 상황이어야 이 검사가 의미 있다
  expect(Math.abs((await box(page, 'form.quick-add')).y - before)).toBeLessThan(1);
});

test('넓은 화면에서도 구역 사이 간격이 두 배로 벌어지지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await paired(page, []);
  const d = await openEditor(page, '할 일 하나');
  await d.getByRole('radio', { name: '1 긴급' }).check();
  await d.getByRole('button', { name: '저장' }).click();
  await expect(d).toBeHidden();
  await quickAdd(page, '평범한 일');
  const hotBox = await box(page, 'section.group-hot');
  const restBox = await box(page, 'section.group-rest');
  expect(restBox.y - (hotBox.y + hotBox.height)).toBeLessThanOrEqual(24); // section 의 margin 20px 이 합쳐지지 않고 한 번만
});
