import { test, expect } from '@playwright/test';
import { openApp, openEditor, quickAdd } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

test('수정 창: 길이는 시각이 있을 때만 고를 수 있고, 저장하면 다시 열었을 때 그대로이며, 시각을 없애면 사라진다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '컴퓨터구조 수업');

  let dialog = await openEditor(page, '컴퓨터구조 수업');
  const duration = dialog.getByLabel('길이');
  await expect(duration).toBeDisabled(); // 기한도 시각도 없다
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-12');
  await expect(duration).toBeDisabled(); // 기한만 있고 시각이 없다
  await dialog.getByLabel('기한 시각').fill('13:00');
  await expect(duration).toBeEnabled();
  await duration.selectOption({ label: '2시간' });
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();

  dialog = await openEditor(page, '컴퓨터구조 수업');
  await expect(dialog.getByLabel('길이')).toHaveValue('120');
  await dialog.getByRole('button', { name: '시각 없음' }).click();
  await expect(dialog.getByLabel('길이')).toBeDisabled();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();

  dialog = await openEditor(page, '컴퓨터구조 수업');
  await dialog.getByLabel('기한 시각').fill('15:00');
  await expect(dialog.getByLabel('길이')).toHaveValue(''); // 시각을 없애면서 길이도 지워졌다
});

test('자정을 넘기는 길이는 저장되지 않고 안내가 나온다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '야근');
  const dialog = await openEditor(page, '야근');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-12');
  await dialog.getByLabel('기한 시각').fill('23:30');
  await dialog.getByLabel('길이').selectOption({ label: '1시간' });
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.getByRole('alert')).toContainText('자정');
  await expect(dialog).toBeVisible();
});
