import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

const hot = (page: Page) => page.locator('section.group-hot li.task .task-title').allTextContents();
const rest = (page: Page) => page.locator('section.group-rest li.task .task-title').allTextContents();

async function setPriority(page: Page, title: string, label: string): Promise<void> {
  const dialog = await openEditor(page, title);
  await dialog.getByRole('radio', { name: label }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

test('P1·P2는 "지금 중요", 나머지는 "나머지" 구역에 나뉘고 제목에 개수가 있다', async ({ page }) => {
  await openApp(page);
  for (const [t, label] of [['급한 일', '1 긴급'], ['중요한 일', '2 높음'], ['보통 일', '3 보통'], ['평범한 일', '4 없음']] as const) {
    await quickAdd(page, t);
    await setPriority(page, t, label);
  }
  await expect.poll(() => hot(page)).toEqual(['급한 일', '중요한 일']);
  await expect.poll(() => rest(page)).toEqual(['보통 일', '평범한 일']);
  await expect(page.getByRole('heading', { level: 3, name: '지금 중요 (2)' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: '나머지 (2)' })).toBeVisible();
});

test('P1·P2가 없으면 "지금 중요" 구역은 그리지 않는다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '평범한 일');
  await expect(page.locator('section.group-rest')).toHaveCount(1);
  await expect(page.locator('section.group-hot')).toHaveCount(0);
});

test('우선순위를 바꾸면 카드가 다른 구역으로 옮겨 가고, 되돌리면 돌아온다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '옮길 일');
  await expect.poll(() => rest(page)).toEqual(['옮길 일']);
  await setPriority(page, '옮길 일', '1 긴급');
  await expect.poll(() => hot(page)).toEqual(['옮길 일']);
  await expect(page.locator('section.group-rest')).toHaveCount(0);
  await setPriority(page, '옮길 일', '4 없음');
  await expect.poll(() => rest(page)).toEqual(['옮길 일']);
  await expect(page.locator('section.group-hot')).toHaveCount(0);
});

test('"나머지" 구역 안에서 카드를 끌면 그 구역 순서가 바뀌고 새로고침해도 유지된다', async ({ page }) => {
  await openApp(page);
  for (const t of ['하나', '둘', '셋']) await quickAdd(page, t);
  await expect.poll(() => rest(page)).toEqual(['하나', '둘', '셋']); // 배치가 자리 잡은 뒤에 위치를 잰다
  const from = (await row(page, '셋').boundingBox())!;
  const to = (await row(page, '하나').boundingBox())!;
  const x = from.x + from.width * 0.6;
  const y = to.y + 4;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + (y > from.y ? 8 : -8), { steps: 2 });
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => rest(page)).toEqual(['셋', '하나', '둘']);
  await expect(page.getByText(/순서를 바꿨어요/)).toBeVisible(); // 저장이 끝난 뒤에 새로고침한다
  await page.reload();
  await expect.poll(() => rest(page)).toEqual(['셋', '하나', '둘']);
});

test('구역이 있는 오늘 화면에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '급한 일');
  await setPriority(page, '급한 일', '1 긴급');
  await quickAdd(page, '평범한 일');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
