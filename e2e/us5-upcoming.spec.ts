import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목). 주는 일요일에 시작한다 → 첫 화면은 오늘 11/12(목)부터 11/14(토)까지 세 날,
// 다음 주는 11/15(일) ~ 11/21(토), 그다음은 11/22(일) ~ 11/28(토)
const DAYS = ['11월 12일 목요일', '11월 13일 금요일', '11월 14일 토요일'];
const WEEK2 = ['11월 15일 일요일', '11월 16일 월요일', '11월 17일 화요일', '11월 18일 수요일', '11월 19일 목요일', '11월 20일 금요일', '11월 21일 토요일'];

const day = (page: Page, heading: string): Locator => page.locator('section.day', { has: page.getByRole('heading', { level: 3, name: heading }) });

async function setDue(page: Page, title: string, date: string): Promise<void> {
  const dialog = await openEditor(page, title);
  await dialog.getByLabel('기한', { exact: true }).fill(date);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

async function seed(page: Page): Promise<void> {
  await quickAdd(page, '내일 일');
  await quickAdd(page, '모레 일');
  await quickAdd(page, '닷새 뒤 일');
  await setDue(page, '내일 일', '2026-11-13');
  await setDue(page, '모레 일', '2026-11-14');
  await setDue(page, '닷새 뒤 일', '2026-11-17');
}

test('시나리오 1: 오늘부터 그 주 토요일까지만 요일 포함 날짜별로 보이고, 다음 주는 일~토 7일이다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '예정');
  await expect(page.getByRole('heading', { level: 2, name: '예정' })).toBeVisible();
  const headings = await page.locator('section.day h3').allTextContents();
  expect(headings.map((h) => h.trim())).toEqual(DAYS); // 목요일이므로 목(오늘)·금·토
  await expect(day(page, DAYS[1]!).getByText('내일 일')).toBeVisible();
  await expect(day(page, DAYS[2]!).getByText('모레 일')).toBeVisible();
  await expect(page.locator('section.day li.task')).toHaveCount(2);
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(page.locator('section.day')).toHaveCount(7);
  expect((await page.locator('section.day h3').allTextContents()).map((h) => h.trim())).toEqual(WEEK2);
  await expect(day(page, WEEK2[2]!).getByText('닷새 뒤 일')).toBeVisible();
  await expect(day(page, WEEK2[0]!).getByText('할 일 없음')).toBeVisible(); // 빈 날
});

test('시나리오 2: 날짜 머리글의 "추가"로 만든 할 일은 기한이 그 날짜이다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '예정');
  await day(page, DAYS[2]!).getByRole('button', { name: /에 할 일 추가/ }).click();
  const group = day(page, DAYS[2]!);
  await group.getByRole('textbox', { name: '할 일 추가' }).fill('토요일 약속');
  await group.getByRole('button', { name: '추가', exact: true }).click();
  await expect(group.getByText('토요일 약속')).toBeVisible();
  await page.reload();
  await expect(day(page, DAYS[2]!).getByText('토요일 약속')).toBeVisible();
  // 오늘 화면에는 나오지 않는다
  await navTo(page, '오늘');
  await expect(row(page, '토요일 약속')).toBeHidden();
});

test('시나리오 3: 기한을 바꾸면 날짜 묶음 사이를 이동하고, 이번 주 밖이면 화면에서 사라진다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '예정');
  await setDue(page, '내일 일', '2026-11-14');
  await expect(day(page, DAYS[1]!).getByText('내일 일')).toBeHidden();
  await expect(day(page, DAYS[2]!).getByText('내일 일')).toBeVisible();
  await setDue(page, '내일 일', '2026-11-25'); // 이번 주 밖
  await expect(page.getByText('내일 일')).toBeHidden();
});

test('시나리오 4: 한 주만 보이고 "다음 주"로 일~토 한 주씩 이어서 표시된다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '열흘 뒤');
  await setDue(page, '열흘 뒤', '2026-11-22');
  await navTo(page, '예정');
  await expect(page.locator('section.day')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '더 보기' })).toHaveCount(0);
  await expect(page.getByText('열흘 뒤')).toBeHidden();
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(page.locator('section.day')).toHaveCount(7);
  await expect(page.getByRole('heading', { level: 3, name: '11월 21일 토요일' })).toBeVisible();
  await expect(page.getByText('열흘 뒤')).toBeHidden();
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(page.locator('section.day h3').first()).toHaveText('11월 22일 일요일');
  await expect(page.locator('section.day')).toHaveCount(7);
  await expect(day(page, '11월 22일 일요일').getByText('열흘 뒤')).toBeVisible();
});

test('시나리오 5: 오늘 할 일은 오늘 묶음에 나오고, 기한이 지난 할 일·기한 없는 할 일은 나오지 않는다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '어제 일');
  await setDue(page, '어제 일', '2026-11-11');
  await quickAdd(page, '오늘 일');
  await navTo(page, '수신함');
  await quickAdd(page, '언젠가 일');
  await navTo(page, '예정');
  await expect(day(page, DAYS[0]!).getByText('오늘 일')).toBeVisible();
  for (const t of ['어제 일', '언젠가 일']) await expect(page.getByText(t)).toBeHidden();
});

test('예정 화면에 WCAG 2.1 AA 위반이 없다 (할 일·빈 날·추가 입력이 열린 상태)', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '예정');
  await day(page, DAYS[1]!).getByRole('button', { name: /에 할 일 추가/ }).click();
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test('보드: 월 표시가 있고, "다음 주"·"이전 주"·"오늘"로 한 주씩 이동한다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '열흘 뒤');
  await setDue(page, '열흘 뒤', '2026-11-22');
  await navTo(page, '예정');
  await expect(page.locator('.board-month')).toHaveText('11월 2026');
  await expect(page.getByRole('button', { name: '이전 주' })).toBeDisabled();
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(page.locator('section.day h3').first()).toHaveText('11월 15일 일요일');
  await expect(page.locator('section.day')).toHaveCount(7);
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(page.locator('section.day h3').first()).toHaveText('11월 22일 일요일');
  await expect(day(page, '11월 22일 일요일').getByText('열흘 뒤')).toBeVisible();
  await expect(day(page, '11월 22일 일요일').locator('.day-count')).toHaveText('1');
  await page.getByRole('button', { name: '이전 주' }).click();
  await expect(page.locator('section.day h3').first()).toHaveText('11월 15일 일요일');
  await page.getByRole('button', { name: '다음 주' }).click();
  await page.getByRole('button', { name: '오늘', exact: true }).click();
  await expect(page.locator('section.day h3').first()).toHaveText(DAYS[0]!);
  await expect(page.locator('section.day')).toHaveCount(3);
});

test('다른 화면에 갔다 오면 이번 주부터 다시 보이고, 같은 화면에서 다시 그려질 때는 보던 주를 유지한다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '예정');
  const first = page.locator('section.day h3').first();
  await expect(first).toHaveText(DAYS[0]!);
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(first).toHaveText('11월 15일 일요일');

  // 같은 화면에서 다시 그려지는 동작(할 일 추가 입력 열기)에서는 보던 주를 그대로 둔다
  await day(page, '11월 16일 월요일').getByRole('button', { name: /에 할 일 추가/ }).click();
  await expect(day(page, '11월 16일 월요일').getByRole('textbox', { name: '할 일 추가' })).toBeVisible();
  await expect(first).toHaveText('11월 15일 일요일');

  // 다른 화면에 갔다 오면 이번 주부터, 열어 둔 추가 입력도 닫혀 있다
  await navTo(page, '오늘');
  await navTo(page, '예정');
  await expect(first).toHaveText(DAYS[0]!);
  await expect(page.getByRole('button', { name: '이전 주' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '할 일 추가' })).toHaveCount(0);
});

test('카드를 끌어 다른 날짜 칸에 놓으면 기한이 그 날짜로 옮겨지고, 실행 취소로 되돌린다', async ({ page }) => {
  await openApp(page);
  await seed(page);
  await navTo(page, '예정');
  await day(page, DAYS[1]!).locator('li.task', { hasText: '내일 일' }).dragTo(day(page, DAYS[2]!));
  await expect(day(page, DAYS[2]!).getByText('내일 일')).toBeVisible();
  await expect(day(page, DAYS[1]!).getByText('내일 일')).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(day(page, DAYS[1]!).getByText('내일 일')).toBeVisible();
});
