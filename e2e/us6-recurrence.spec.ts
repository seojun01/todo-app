import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expandCompleted, navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목)
async function edit(page: Page, title: string, fill: (dialog: Locator) => Promise<void>): Promise<void> {
  const dialog = await openEditor(page, title);
  await fill(dialog);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}
const setDate = (d: Locator, date: string): Promise<void> => d.getByLabel('기한', { exact: true }).fill(date);
const setRepeat = async (d: Locator, label: string): Promise<void> => {
  await d.getByLabel('반복', { exact: true }).selectOption({ label });
};
const toast = (page: Page) => page.getByRole('status').filter({ hasText: '다음 일정' });

test('시나리오 1: 수요일 기한에 "매주 월요일"을 지정하면 기한이 다음 월요일로 맞춰지고 반복 표시가 나타난다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '운동');
  await edit(page, '운동', async (d) => {
    await setDate(d, '2026-11-11'); // 수요일
    await setRepeat(d, '매주');
    await d.getByRole('checkbox', { name: '수' }).uncheck(); // 기본값은 기한의 요일
    await d.getByRole('checkbox', { name: '월' }).check();
  });
  await navTo(page, '수신함');
  const r = row(page, '운동');
  await expect(r).toContainText('11월 16일 (월)');
  await expect(r).toContainText('반복');
  await expect(r).toContainText('매주 월요일');
});

test('시나리오 2: 완료하면 미완료로 남은 채 다음 회차로 넘어가고 실행 취소할 수 있다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '청소');
  await edit(page, '청소', (d) => setRepeat(d, '매주')); // 오늘이 목요일 → 기본 요일 목
  await row(page, '청소').getByRole('checkbox').click();
  await expect(row(page, '청소')).toBeHidden(); // 오늘 화면에서는 사라진다
  await expect(toast(page)).toBeVisible();
  await toast(page).getByRole('button', { name: '실행 취소' }).click();
  await expect(row(page, '청소')).toBeVisible(); // 원래 기한으로 복귀

  await row(page, '청소').getByRole('checkbox').click();
  await navTo(page, '수신함');
  const r = row(page, '청소');
  await expect(r).toContainText('11월 19일 (목)');
  await expect(r.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false'); // 미완료 상태 유지
});

test('시나리오 3: 기한이 지난 매일 반복을 완료하면 오늘 이후 첫 일정일(내일)로 넘어간다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '약 먹기');
  await edit(page, '약 먹기', async (d) => {
    await setDate(d, '2026-11-09'); // 사흘 전
    await setRepeat(d, '매일');
  });
  await expect(page.locator('section.overdue').getByText('약 먹기')).toBeVisible();
  await row(page, '약 먹기').getByRole('checkbox').click();
  await expect(row(page, '약 먹기')).toBeHidden();
  await navTo(page, '예정');
  await expect(page.locator('section.day', { has: page.getByRole('heading', { name: '11월 13일 금요일' }) }).getByText('약 먹기')).toBeVisible();
});

test('시나리오 4: 매월 31일은 31일이 없는 달에 말일로 잡히고 다음 달에는 다시 31일이 된다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  await quickAdd(page, '정산');
  await edit(page, '정산', async (d) => {
    await setDate(d, '2026-01-31');
    await setRepeat(d, '매월');
  });
  await row(page, '정산').getByRole('checkbox').click();
  await expect(row(page, '정산')).toContainText('11월 30일 (월)');
  await row(page, '정산').getByRole('checkbox').click();
  await expect(row(page, '정산')).toContainText('12월 31일 (목)');
});

test('시나리오 5: 종료 날짜를 지나면 마지막 회차 완료 시 더 이상 넘어가지 않고 완료 상태가 된다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  await quickAdd(page, '단기 반복');
  await edit(page, '단기 반복', async (d) => {
    await setDate(d, '2026-11-12');
    await setRepeat(d, '매일');
    await d.getByLabel('종료 날짜').fill('2026-11-13');
  });
  await row(page, '단기 반복').getByRole('checkbox').click();
  await expect(row(page, '단기 반복')).toContainText('11월 13일 (금)');
  await row(page, '단기 반복').getByRole('checkbox').click(); // 마지막 회차
  const completed = await expandCompleted(page);
  await expect(completed.getByRole('checkbox', { name: '단기 반복', checked: true })).toBeVisible();
});

test('시나리오 6·7: 반복을 해제하면 일반 할 일이 되고, 삭제 후 실행 취소하면 반복까지 복원된다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '매일 할 일');
  await edit(page, '매일 할 일', (d) => setRepeat(d, '매일'));
  await expect(row(page, '매일 할 일')).toContainText('반복');

  await row(page, '매일 할 일').getByRole('button', { name: '매일 할 일 삭제' }).click();
  await expect(row(page, '매일 할 일')).toBeHidden();
  await page.getByRole('status').filter({ hasText: '삭제했어요' }).getByRole('button', { name: '실행 취소' }).click();
  await expect(row(page, '매일 할 일')).toContainText('반복'); // 반복 규칙까지 복원

  await edit(page, '매일 할 일', (d) => setRepeat(d, '반복 안 함'));
  await expect(row(page, '매일 할 일')).not.toContainText('반복');
  await row(page, '매일 할 일').getByRole('checkbox').click(); // 일반 할 일처럼 완료
  const completed = await expandCompleted(page);
  await expect(completed.getByText('매일 할 일')).toBeVisible();
});

test('시나리오 8: 기한이 없으면 반복을 지정할 수 없고 먼저 기한을 정하도록 안내한다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  await quickAdd(page, '기한 없는 일');
  const dialog = await openEditor(page, '기한 없는 일');
  await expect(dialog.getByLabel('반복', { exact: true })).toBeDisabled();
  await expect(dialog).toContainText('먼저 기한을 정하세요');
  await setDate(dialog, '2026-11-20');
  await expect(dialog.getByLabel('반복', { exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '취소' }).click();
});

test('종료 날짜가 기한보다 빠르면 저장되지 않고 이유가 안내된다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '종료일 오류');
  const dialog = await openEditor(page, '종료일 오류');
  await setRepeat(dialog, '매일');
  await dialog.getByLabel('종료 날짜').fill('2026-11-01');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.getByRole('alert')).toContainText('종료 날짜');
  await expect(dialog).toBeVisible();
});

test('반복 설정 UI 에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '접근성');
  const dialog = await openEditor(page, '접근성');
  await setRepeat(dialog, '매주');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
