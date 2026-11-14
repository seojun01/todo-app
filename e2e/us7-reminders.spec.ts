import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navTo, newDevice, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목) 09:00 (서울)
const reminders = (dialog: Locator) => dialog.getByRole('group', { name: '알림' });
// 이미 지난 알림이면 이름 뒤에 " · 이미 지난 알림이에요" 가 붙으므로 앞부분으로 찾는다
const box = (dialog: Locator, label: string) => reminders(dialog).getByRole('checkbox', { name: new RegExp(`^${label}( · 이미 지난 알림이에요)?$`) });
/** 그 알림 옆의 "이미 지난 알림이에요" 표시 (숨겨진 글자는 textContent 에 들어가므로 표시 여부로 판정한다) */
const pastNote = (dialog: Locator, label: string) => reminders(dialog).locator('label', { hasText: new RegExp(`^${label}`) }).locator('.reminder-past');
const status = (dialog: Locator) => reminders(dialog).getByRole('status');

/** 설정 화면으로 가서 알림 상태 확인이 끝날 때까지 기다린다 (끝나는 순간 영역이 한 번 갱신되므로 그 전에 입력하면 사라질 수 있다) */
async function openSettings(page: Page): Promise<void> {
  await navTo(page, '설정');
  await expect(page.getByLabel('기본 알림 시각')).toBeVisible();
  await expect(page.getByText('알림 상태를 확인하는 중이에요…')).toBeHidden();
}

async function save(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

test('시나리오 1: 기한 시각과 시각 기준 알림(정시·30분 전)을 정하면 카드에 시각과 알림이 보이고 다시 열어도 그대로다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '회의');
  const dialog = await openEditor(page, '회의');
  await expect(dialog.getByLabel('기한 시각')).toHaveValue('');
  // 시각이 없으면 날짜 기준 알림만 보인다
  for (const label of ['당일', '하루 전']) await expect(box(dialog, label)).toBeVisible();
  for (const label of ['정시', '10분 전', '30분 전', '1시간 전']) await expect(box(dialog, label)).toBeHidden();

  await dialog.getByLabel('기한 시각').fill('15:00');
  for (const label of ['정시', '10분 전', '30분 전', '1시간 전', '하루 전']) await expect(box(dialog, label)).toBeVisible();
  await expect(box(dialog, '당일')).toBeHidden(); // 시각이 있으면 당일 알림은 없다
  await box(dialog, '정시').check();
  await box(dialog, '30분 전').check();
  await save(dialog);

  await expect(row(page, '회의')).toContainText('오후 3:00');
  await expect(row(page, '회의')).toContainText('알림: 정시·30분 전');

  await page.reload();
  const again = await openEditor(page, '회의');
  await expect(again.getByLabel('기한 시각')).toHaveValue('15:00');
  await expect(box(again, '정시')).toBeChecked();
  await expect(box(again, '30분 전')).toBeChecked();
  await expect(box(again, '10분 전')).not.toBeChecked();
});

test('시나리오 2: 시각이 없는 할 일은 당일·하루 전 알림을 고른다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '서류 제출');
  const dialog = await openEditor(page, '서류 제출');
  await box(dialog, '하루 전').check();
  await box(dialog, '당일').check();
  await save(dialog);
  await expect(row(page, '서류 제출')).toContainText('알림: 하루 전·당일');
  await expect(row(page, '서류 제출')).not.toContainText('오후'); // 시각 표시 없음
});

test('시나리오 3: 시각을 정하면 "당일"이 "정시"로 바뀌고, 시각을 없애면 시각 기준 알림이 빠지며 그 사실이 안내된다 (하루 전은 유지)', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '발표');
  const dialog = await openEditor(page, '발표');
  await box(dialog, '당일').check();
  await box(dialog, '하루 전').check();

  await dialog.getByLabel('기한 시각').fill('14:00');
  await expect(box(dialog, '정시')).toBeChecked(); // 당일 → 정시
  await expect(box(dialog, '하루 전')).toBeChecked(); // 유지
  await expect(status(dialog)).toContainText("'당일' 알림을 '정시'로 바꿨어요");

  await box(dialog, '30분 전').check();
  await dialog.getByRole('button', { name: '시각 없음' }).click();
  await expect(dialog.getByLabel('기한 시각')).toHaveValue('');
  await expect(box(dialog, '하루 전')).toBeChecked(); // 유지
  await expect(box(dialog, '당일')).not.toBeChecked();
  await expect(status(dialog)).toContainText("시각 기준 알림 2개(정시·10분 전·30분 전·1시간 전)를 뺐어요. '하루 전'은 그대로예요.");
  await save(dialog);
  await expect(row(page, '발표')).toContainText('알림: 하루 전');
  await expect(row(page, '발표')).not.toContainText('정시');
});

test('시나리오 4: 이미 지난 시각의 알림은 "이미 지난 알림이에요"로 안내되고, 지나지 않은 알림에는 안내가 없다', async ({ page }) => {
  await openApp(page); // 지금 09:00
  await quickAdd(page, '아침 통화');
  const dialog = await openEditor(page, '아침 통화');
  await dialog.getByLabel('기한 시각').fill('09:20');
  await box(dialog, '30분 전').check(); // 08:50 → 이미 지났다
  await box(dialog, '정시').check(); // 09:20 → 아직
  await expect(pastNote(dialog, '30분 전')).toBeVisible();
  await expect(pastNote(dialog, '정시')).toBeHidden();
  await expect(status(dialog)).toContainText('이미 지난 시각의 알림은 울리지 않아요.');

  await box(dialog, '30분 전').uncheck();
  await expect(pastNote(dialog, '정시')).toBeHidden();
  await expect(pastNote(dialog, '30분 전')).toBeHidden();
  // 지난 알림 안내는 사라진다 (이 기기의 알림 상태에 대한 안내는 별개라서 남을 수 있다)
  await expect(status(dialog)).not.toContainText('이미 지난 시각의 알림은 울리지 않아요.');
  await save(dialog); // 안내만 하고 저장은 막지 않는다
  await expect(row(page, '아침 통화')).toContainText('알림: 정시');
});

test('시나리오 5: 기한이 없으면 시각과 알림을 고를 수 없고 기한을 정하면 열린다. 기한을 지우면 시각·알림도 사라진다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  await quickAdd(page, '언젠가');
  const dialog = await openEditor(page, '언젠가');
  await expect(dialog.getByLabel('기한 시각')).toBeDisabled();
  await expect(dialog.getByText('먼저 기한을 정하세요. 시각에는 기한이 필요해요.')).toBeVisible();
  await expect(dialog.getByText('먼저 기한을 정하세요. 알림에는 기한이 필요해요.')).toBeVisible();
  await expect(box(dialog, '하루 전')).toBeDisabled();

  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-20');
  await expect(dialog.getByLabel('기한 시각')).toBeEnabled();
  await expect(box(dialog, '하루 전')).toBeEnabled();
  await dialog.getByLabel('기한 시각').fill('10:00');
  await box(dialog, '1시간 전').check();

  await dialog.getByRole('button', { name: '기한 없음' }).click();
  await expect(dialog.getByLabel('기한 시각')).toHaveValue('');
  await expect(dialog.getByLabel('기한 시각')).toBeDisabled();
  await expect(box(dialog, '하루 전')).toBeDisabled();
  await expect(box(dialog, '하루 전')).not.toBeChecked();
  await save(dialog);
  await expect(row(page, '언젠가')).not.toContainText('알림');
});

test('시나리오 6: 설정의 기본 알림 시각은 시각 없는 할 일의 알림 시각이고, 바꾸면 저장되어 지난 알림 안내에도 반영된다', async ({ page }) => {
  await openApp(page); // 지금 09:00, 기본 알림 시각 09:00
  await openSettings(page);
  const input = page.getByLabel('기본 알림 시각');
  await expect(input).toHaveValue('09:00');
  await input.fill('07:45');
  await expect(page.getByText('기본 알림 시각을 07:45로 바꿨어요')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('기본 알림 시각')).toHaveValue('07:45');

  await navTo(page, '오늘');
  await quickAdd(page, '약 먹기');
  let dialog = await openEditor(page, '약 먹기');
  await box(dialog, '당일').check(); // 오늘 07:45 → 이미 지났다 (지금 09:00)
  await expect(pastNote(dialog, '당일')).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();

  await openSettings(page);
  await page.getByLabel('기본 알림 시각').fill('20:00');
  await expect(page.getByText('기본 알림 시각을 20:00로 바꿨어요')).toBeVisible();
  await navTo(page, '오늘');
  dialog = await openEditor(page, '약 먹기');
  await box(dialog, '당일').check(); // 오늘 20:00 → 아직
  await expect(pastNote(dialog, '당일')).toBeHidden();
});

test('시나리오 7: 기본 알림 시각을 비우면 안내하고 이전 값으로 되돌린다', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const input = page.getByLabel('기본 알림 시각');
  await input.fill('08:30');
  await expect(page.getByText('기본 알림 시각을 08:30로 바꿨어요')).toBeVisible();
  // 저장하면 화면이 새 값으로 다시 그려진다. 그것이 끝난 뒤에 다음 입력을 한다.
  await expect(page.locator('#default-reminder-time')).toHaveAttribute('value', '08:30');
  await input.fill('');
  await expect(page.getByRole('alert').filter({ hasText: '시각을 입력해 주세요' })).toBeVisible();
  await expect(input).toHaveValue('08:30');
});

test('시나리오 8: 시각이 있는 할 일은 캘린더 칸에 시각과 함께 보이고, 알림 설정은 완료하면 카드에서 사라진다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await quickAdd(page, '병원');
  const dialog = await openEditor(page, '병원');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-13');
  await dialog.getByLabel('기한 시각').fill('15:00');
  await box(dialog, '1시간 전').check();
  await save(dialog);
  await navTo(page, '캘린더');
  await expect(page.locator('button[data-date="2026-11-13"] .cal-item')).toHaveText('15:00 병원');
  await page.locator('button[data-date="2026-11-13"]').click();
  await expect(row(page, '병원')).toContainText('알림: 1시간 전');
  await row(page, '병원').getByRole('checkbox').click();
  await expect(row(page, '병원')).toBeHidden(); // 완료됨으로 접힌다
});

test('시나리오 9: 기본 알림 시각은 다른 기기에도 동기화된다 (가장 나중 변경이 이긴다)', async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  await openSettings(b.page);
  await openSettings(a.page);
  await a.page.getByLabel('기본 알림 시각').fill('06:30');
  await expect(a.page.getByText('기본 알림 시각을 06:30로 바꿨어요')).toBeVisible();
  await expect(b.page.getByLabel('기본 알림 시각')).toHaveValue('06:30', { timeout: 10_000 });
  // B 가 나중에 바꾸면 A 에도 B 의 값이 반영된다
  await b.page.getByLabel('기본 알림 시각').fill('21:15');
  await expect(a.page.getByLabel('기본 알림 시각')).toHaveValue('21:15', { timeout: 10_000 });
  await a.context.close();
  await b.context.close();
});

test('기한 시각·알림이 있는 편집 시트와 설정 화면에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '접근성');
  const dialog = await openEditor(page, '접근성');
  await dialog.getByLabel('기한 시각').fill('09:20');
  await box(dialog, '30분 전').check(); // 이미 지난 알림 안내도 함께 검사
  await box(dialog, '정시').check();
  const check = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  };
  await check();
  await dialog.getByRole('button', { name: '취소' }).click();
  await openSettings(page);
  await expect(page.getByLabel('기본 알림 시각')).toBeVisible();
  await check();
});

test('시각 표시: 카드에 시각이 보이고, 오늘 기한인데 시각이 이미 지난 미완료 할 일만 강조된다 (색 외에 글로도 알린다)', async ({ page }) => {
  await openApp(page); // 지금 09:00
  for (const [title, time] of [['지난 시각', '08:00'], ['앞으로 시각', '15:00']] as const) {
    await quickAdd(page, title);
    const dialog = await openEditor(page, title);
    await dialog.getByLabel('기한 시각').fill(time);
    await save(dialog);
  }
  const chip = (title: string) => row(page, title).locator('.chip', { hasText: /오[전후] \d+:\d\d/ });
  await expect(chip('지난 시각')).toHaveText(/오전 8:00 \(시각이 지났어요\)/);
  await expect(chip('지난 시각')).toHaveClass(/past-time/);
  await expect(chip('앞으로 시각')).toHaveText('오후 3:00');
  await expect(chip('앞으로 시각')).not.toHaveClass(/past-time/);

  // 내일 08:00 은 오늘이 아니므로 강조하지 않는다 (예정 화면)
  await quickAdd(page, '내일 아침');
  const dialog = await openEditor(page, '내일 아침');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-13');
  await dialog.getByLabel('기한 시각').fill('08:00');
  await save(dialog);
  await navTo(page, '예정');
  await expect(chip('내일 아침')).toHaveText('오전 8:00');
  await expect(chip('내일 아침')).not.toHaveClass(/past-time/);

  // 완료한 할 일은 강조하지 않는다
  await navTo(page, '오늘');
  await row(page, '지난 시각').getByRole('checkbox').click();
  await expect(page.locator('details.completed')).toBeVisible();
  await page.locator('details.completed summary').click();
  await expect(page.locator('details.completed .chip', { hasText: '오전 8:00' })).not.toHaveClass(/past-time/);
});
