import { test, expect, type Page } from '@playwright/test';
import { navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

const titles = (page: Page) => page.locator('section.open li.task .task-title').allTextContents();

/** 제목 title 의 카드를 집어 target 카드의 위(above) 또는 아래로 끈다 */
async function dragRow(page: Page, title: string, target: string, where: 'above' | 'below'): Promise<void> {
  const from = (await row(page, title).boundingBox())!;
  const to = (await row(page, target).boundingBox())!;
  const x = from.x + from.width * 0.6;
  const y = where === 'above' ? to.y + 4 : to.y + to.height - 4;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + (y > from.y ? 8 : -8), { steps: 2 });
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

test('오늘: 카드를 끌어 놓으면 순서가 바뀌고, 새로고침해도 유지된다. 실행 취소로 되돌린다', async ({ page }) => {
  await openApp(page);
  for (const t of ['하나', '둘', '셋']) await quickAdd(page, t);
  await expect.poll(() => titles(page)).toEqual(['하나', '둘', '셋']);
  await dragRow(page, '셋', '하나', 'above');
  await expect.poll(() => titles(page)).toEqual(['셋', '하나', '둘']);
  await expect(page.getByText(/순서를 바꿨어요/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); // 끈 뒤에 수정 창이 열리지 않는다
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(['셋', '하나', '둘']);

  await dragRow(page, '하나', '둘', 'below');
  await expect.poll(() => titles(page)).toEqual(['셋', '둘', '하나']);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect.poll(() => titles(page)).toEqual(['셋', '하나', '둘']);
});

test('직접 정한 순서는 우선순위를 바꿔도 유지되고, 새로 추가한 할 일은 맨 아래로 간다', async ({ page }) => {
  await openApp(page);
  for (const t of ['A', 'B']) await quickAdd(page, t);
  await dragRow(page, 'B', 'A', 'above');
  await expect.poll(() => titles(page)).toEqual(['B', 'A']);
  const dialog = await openEditor(page, 'A');
  await dialog.getByRole('radio', { name: '1 긴급' }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => titles(page)).toEqual(['B', 'A']);
  await quickAdd(page, 'C');
  await expect.poll(() => titles(page)).toEqual(['B', 'A', 'C']);
});

test('수신함: 키보드로 카드 안에 포커스를 두고 Alt+↑/↓ 로 옮긴다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  for (const t of ['첫째', '둘째', '셋째']) await quickAdd(page, t);
  await expect.poll(() => titles(page)).toEqual(['첫째', '둘째', '셋째']);
  await row(page, '셋째').getByRole('button', { name: '셋째 수정', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => titles(page)).toEqual(['첫째', '셋째', '둘째']);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => titles(page)).toEqual(['셋째', '첫째', '둘째']);
  await expect(row(page, '셋째').getByRole('button', { name: '셋째 수정', exact: true })).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => titles(page)).toEqual(['첫째', '셋째', '둘째']);
});

test('끄는 도중 Esc 를 누르면 원래 순서로 돌아가고 아무것도 저장하지 않는다. 그냥 누르면 체크는 그대로 동작한다', async ({ page }) => {
  await openApp(page);
  for (const t of ['사과', '포도']) await quickAdd(page, t);
  const from = (await row(page, '포도').boundingBox())!;
  const to = (await row(page, '사과').boundingBox())!;
  await page.mouse.move(from.x + from.width * 0.6, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width * 0.6, to.y + 4, { steps: 10 });
  await expect.poll(() => titles(page)).toEqual(['포도', '사과']);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => titles(page)).toEqual(['사과', '포도']);
  await expect(page.getByText(/순서를 바꿨어요/)).toHaveCount(0);
  // 끌지 않은 클릭은 평소대로
  await row(page, '사과').getByRole('checkbox').click();
  await expect(row(page, '사과').getByRole('checkbox')).toHaveCount(0); // 완료되어 목록에서 빠진다
});
