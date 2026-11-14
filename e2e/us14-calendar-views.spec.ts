import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navTo, openApp, openEditor, quickAdd } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목) 09:00. 한 시간 = 52px
async function addTimed(page: Page, title: string, time: string | null, duration: string | null, date = '2026-11-12'): Promise<void> {
  await quickAdd(page, title);
  const dialog = await openEditor(page, title);
  await dialog.getByLabel('기한', { exact: true }).fill(date);
  if (time) await dialog.getByLabel('기한 시각').fill(time);
  if (duration) await dialog.getByLabel('길이').selectOption({ label: duration });
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

async function seed(page: Page): Promise<void> {
  await addTimed(page, '컴퓨터구조', '13:00', '2시간'); // 13~15시
  await addTimed(page, '운동 약속', '14:00', '1시간'); // 14~15시: 위와 겹친다
  await addTimed(page, '일정 정리', null, null); // 하루 종일
  await addTimed(page, '다른 날 수업', '09:30', '30분', '2026-11-13');
}

const mode = (page: Page, name: string) => page.getByRole('group', { name: '보기 방식' }).getByRole('button', { name, exact: true });

test('주 보기: 요일 머리글·하루 종일 줄·시각 블록이 시작 시각과 길이대로 놓인다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '캘린더');
  await expect(page.getByRole('heading', { level: 3, name: '2026년 11월' })).toBeVisible(); // 처음은 월 보기
  await mode(page, '주').click();
  await expect(mode(page, '주')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tg-col')).toHaveCount(7);

  const study = page.locator('.tg-block', { hasText: '컴퓨터구조' });
  await expect(study).toHaveCSS('top', `${13 * 52}px`); // 13:00
  await expect(study).toHaveCSS('height', `${2 * 52 - 1}px`); // 2시간
  await expect(page.locator('.tg-allday').getByText('일정 정리')).toBeVisible();
  await expect(page.locator('.tg-block', { hasText: '일정 정리' })).toHaveCount(0); // 시각 없는 일은 블록이 아니다
  // 다음 날 열에 놓인다 (같은 열이 아니다)
  const nextDay = page.locator('.tg-col[data-date="2026-11-13"] .tg-block', { hasText: '다른 날 수업' });
  await expect(nextDay).toHaveCSS('top', `${9.5 * 52}px`);
  await expect(page.locator('.tg-col[data-date="2026-11-12"] .tg-block', { hasText: '다른 날 수업' })).toHaveCount(0);
  await expect(page.locator('.tg-now')).toHaveCount(1); // 오늘 열의 현재 시각 선
});

test('겹치는 일정은 나란히 놓이고, 겹치지 않는 일정은 열을 다 쓴다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '캘린더');
  await mode(page, '일').click();
  const a = await page.locator('.tg-block', { hasText: '컴퓨터구조' }).boundingBox();
  const b = await page.locator('.tg-block', { hasText: '운동 약속' }).boundingBox();
  const col = await page.locator('.tg-col').boundingBox();
  expect(a && b && col).toBeTruthy();
  expect(a!.width).toBeLessThan(col!.width * 0.6);
  expect(b!.width).toBeLessThan(col!.width * 0.6);
  expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(col!.width * 0.4); // 서로 다른 줄
  // 다른 날의 일정은 이 열에 없다
  await expect(page.locator('.tg-block', { hasText: '다른 날 수업' })).toHaveCount(0);
});

test('일 보기: 이전/다음 날과 오늘로 움직이고, 주 보기에서 날짜 머리글을 누르면 그날의 일 보기가 된다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '캘린더');
  await mode(page, '일').click();
  await expect(page.getByRole('heading', { level: 3, name: '11월 12일 목요일' })).toBeVisible();
  await page.getByRole('button', { name: '다음 날' }).click();
  await expect(page.getByRole('heading', { level: 3, name: '11월 13일 금요일' })).toBeVisible();
  await expect(page.locator('.tg-block', { hasText: '다른 날 수업' })).toBeVisible();
  await page.getByRole('button', { name: '오늘' }).click();
  await expect(page.getByRole('heading', { level: 3, name: '11월 12일 목요일' })).toBeVisible();

  await mode(page, '주').click();
  await page.getByRole('button', { name: /11월 13일 금요일/ }).click();
  await expect(mode(page, '일')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { level: 3, name: '11월 13일 금요일' })).toBeVisible();
});

test('블록을 누르면 수정 창이 열린다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '캘린더');
  await mode(page, '주').click();
  await page.locator('.tg-block', { hasText: '컴퓨터구조' }).click();
  const dialog = page.getByRole('dialog', { name: '할 일 수정' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('제목')).toHaveValue('컴퓨터구조');
  await expect(dialog.getByLabel('길이')).toHaveValue('120');
});

test('"+ 일정 추가"는 보고 있는 날짜를 기한으로 한 편집 창을 연다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '캘린더');
  await mode(page, '일').click();
  await page.getByRole('button', { name: '다음 날' }).click();
  await page.getByRole('button', { name: '+ 일정 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '할 일 추가' });
  await expect(dialog.getByLabel('기한', { exact: true })).toHaveValue('2026-11-13');
});

test('년 보기: 12개월이 보이고 할 일 있는 날은 읽을 수 있고, 날짜는 일 보기로·달 이름은 월 보기로 간다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '캘린더');
  await mode(page, '년').click();
  await expect(page.getByRole('heading', { level: 3, name: '2026년' })).toBeVisible();
  await expect(page.locator('.year-month')).toHaveCount(12);
  await expect(page.getByRole('button', { name: '12 일, 2026년 11월, 남은 할 일 3개' })).toBeVisible();
  await page.getByRole('button', { name: '다음 해' }).click();
  await expect(page.getByRole('heading', { level: 3, name: '2027년' })).toBeVisible();
  await page.getByRole('button', { name: '오늘' }).click();
  await page.getByRole('button', { name: '12 일, 2026년 11월, 남은 할 일 3개' }).click();
  await expect(mode(page, '일')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { level: 3, name: '11월 12일 목요일' })).toBeVisible();

  await mode(page, '년').click();
  await page.locator('.year-month-btn', { hasText: '12월' }).click();
  await expect(mode(page, '월')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { level: 3, name: '2026년 12월' })).toBeVisible();
});

test('보기 방식은 다시 열어도 기억된다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '캘린더');
  await mode(page, '주').click();
  await page.reload();
  await navTo(page, '캘린더');
  await expect(mode(page, '주')).toHaveAttribute('aria-pressed', 'true');
});

for (const m of ['일', '주', '년']) {
  test(`${m} 보기에 WCAG 2.1 AA 위반이 없다`, async ({ page }) => {
    await openApp(page);
    await seed(page);
    await navTo(page, '캘린더');
    await mode(page, m).click();
    await expect(mode(page, m)).toHaveAttribute('aria-pressed', 'true');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}
