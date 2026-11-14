import { test, expect } from '@playwright/test';
import { expandCompleted, navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

test('시나리오 1: 처음 열면 오늘 화면이 보이고 빈 상태 안내가 나온다', async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveURL(/#\/today$|\/$/);
  await expect(page.getByRole('heading', { level: 2, name: '오늘' })).toBeVisible();
  await expect(page.getByText('11월 12일')).toBeVisible(); // 오늘 날짜 표시
  await expect(page.getByText('오늘 할 일이 없어요')).toBeVisible();
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  for (const name of ['오늘', '예정', '수신함', '캘린더', '설정']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
});

test('시나리오 2: 오늘 화면에서 추가하면 기한이 오늘인 수신함 할 일이 된다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '장보기');
  await expect(page.getByText('오늘 할 일이 없어요')).toBeHidden();
  await navTo(page, '수신함');
  await expect(row(page, '장보기')).toBeVisible(); // 프로젝트는 수신함
});

test('시나리오 3: 완료하면 "완료됨" 영역으로 가고 해제하면 돌아온다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '장보기');
  const check = row(page, '장보기').getByRole('checkbox', { name: '장보기' });
  await expect(check).toHaveAttribute('aria-checked', 'false');
  await check.click();
  const completed = await expandCompleted(page);
  const doneCheck = completed.getByRole('checkbox', { name: '장보기' });
  await expect(doneCheck).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('section.open').getByText('장보기')).toBeHidden(); // 미완료 목록에서는 빠짐
  await doneCheck.click();
  await expect(page.getByRole('checkbox', { name: '장보기' })).toHaveAttribute('aria-checked', 'false');
});

test('시나리오 4·5: 기한 지난 할 일은 "기한 지남" 맨 위에 보이고, "모두 오늘로"로 한 번에 옮긴다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '어제 할 일');
  await quickAdd(page, '그제 할 일');
  await quickAdd(page, '오늘 할 일');
  for (const [title, date] of [['어제 할 일', '2026-11-11'], ['그제 할 일', '2026-11-10']] as const) {
    const dialog = await openEditor(page, title);
    await dialog.getByLabel('기한', { exact: true }).fill(date);
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog).toBeHidden();
  }
  const overdue = page.getByRole('heading', { level: 3, name: /기한 지남/ });
  await expect(overdue).toBeVisible();
  const overdueSection = page.locator('section.overdue');
  await expect(overdueSection.getByText('어제 할 일')).toBeVisible();
  await expect(overdueSection.getByText('11월 11일')).toBeVisible(); // 기한 날짜 표시
  // 가장 오래된 기한이 먼저, 그리고 "기한 지남"이 오늘 구분보다 위에 있다
  const titles = await page.locator('li.task .task-title').allTextContents();
  assert_order(titles, ['그제 할 일', '어제 할 일', '오늘 할 일']);
  // 자동으로 옮겨지지 않는다: 새로고침해도 그대로
  await page.reload();
  await expect(page.locator('section.overdue').getByText('어제 할 일')).toBeVisible();

  await page.getByRole('button', { name: '모두 오늘로' }).click();
  await expect(page.locator('section.overdue')).toHaveCount(0);
  await expect(row(page, '어제 할 일')).toBeVisible();
  await expect(row(page, '그제 할 일')).toBeVisible();
});

test('시나리오 6: 제목·기한 수정, 취소, 기한 없음', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '장보기');

  // 제목 수정
  let dialog = await openEditor(page, '장보기');
  await dialog.getByLabel('제목').fill('장보기 (우유, 계란)');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(row(page, '장보기 (우유, 계란)')).toBeVisible();

  // 취소하면 그대로
  dialog = await openEditor(page, '장보기 (우유, 계란)');
  await dialog.getByLabel('제목').fill('바뀌면 안 됨');
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(row(page, '장보기 (우유, 계란)')).toBeVisible();
  await expect(page.getByText('바뀌면 안 됨')).toBeHidden();

  // Esc 로도 취소된다
  dialog = await openEditor(page, '장보기 (우유, 계란)');
  await dialog.getByLabel('제목').fill('바뀌면 안 됨');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row(page, '장보기 (우유, 계란)')).toBeVisible();

  // 빈 제목은 저장되지 않고 이유가 안내된다
  dialog = await openEditor(page, '장보기 (우유, 계란)');
  await dialog.getByLabel('제목').fill('   ');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.getByRole('alert')).toContainText('제목');
  await dialog.getByRole('button', { name: '취소' }).click();

  // 기한 없음으로 바꾸면 오늘 화면에서 사라지고 수신함에서 보인다
  dialog = await openEditor(page, '장보기 (우유, 계란)');
  await dialog.getByRole('button', { name: '기한 없음' }).click();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(row(page, '장보기 (우유, 계란)')).toBeHidden();
  await navTo(page, '수신함');
  await expect(row(page, '장보기 (우유, 계란)')).toBeVisible();
});

test('시나리오 7: 삭제 후 5초 이상 실행 취소할 수 있고 모든 내용이 복원된다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '장보기');
  const dialog = await openEditor(page, '장보기');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-12');
  await dialog.getByRole('button', { name: '저장' }).click();
  await row(page, '장보기').getByRole('checkbox', { name: '장보기' }).click(); // 완료 상태

  await expandCompleted(page);
  await page.locator('details.completed').getByRole('button', { name: '삭제' }).click();
  await expect(row(page, '장보기')).toBeHidden();
  const toast = page.getByRole('status').filter({ hasText: '삭제했어요' });
  await expect(toast).toBeVisible();

  await page.clock.fastForward(5000); // 5초가 지나도
  await expect(toast).toBeVisible(); // 아직 남아 있다
  await toast.getByRole('button', { name: '실행 취소' }).click();
  await expandCompleted(page);
  await expect(page.locator('details.completed').getByRole('checkbox', { name: '장보기', checked: true })).toBeVisible(); // 완료 상태 그대로

  // 취소하지 않으면 사라진 채로 남는다
  await page.locator('details.completed').getByRole('button', { name: '삭제' }).click();
  await expect(toast).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(toast).toBeHidden();
  await page.reload();
  await expect(page.getByText('장보기')).toBeHidden();
});

test('시나리오 8: 앱을 닫았다 다시 열어도 변경이 그대로 남는다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '장보기');
  await quickAdd(page, '운동');
  await row(page, '운동').getByRole('checkbox', { name: '운동' }).click();
  await expect(page.locator('details.completed')).toBeVisible(); // 저장이 끝나 화면에 반영된 뒤에 닫는다
  await page.reload();
  await expect(row(page, '장보기').getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
  await expandCompleted(page);
  await expect(page.locator('details.completed').getByRole('checkbox', { name: '운동' })).toHaveAttribute('aria-checked', 'true');
});

test('자정을 넘기면 오늘/기한 지남 구분이 다시 계산된다', async ({ page }) => {
  await openApp(page, '2026-11-12T23:59:50+09:00');
  await quickAdd(page, '자정 전에 한 일');
  await expect(page.locator('section.overdue')).toHaveCount(0);
  await page.clock.fastForward(20_000); // 2026-11-13 00:00:10
  await expect(page.getByText('11월 13일')).toBeVisible();
  await expect(page.locator('section.overdue').getByText('자정 전에 한 일')).toBeVisible();
});

function assert_order(actual: string[], expected: string[]): void {
  const idx = expected.map((t) => actual.indexOf(t));
  expect(idx.every((i) => i >= 0)).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
}
