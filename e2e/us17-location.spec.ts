import { test, expect } from '@playwright/test';
import { openApp, openEditor, quickAdd } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

test('장소: 수정 창에서 정하면 목록에 📍 칩으로 보이고, 다시 열면 그대로이며, 비우면 사라진다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '팀 미팅');

  let dialog = await openEditor(page, '팀 미팅');
  await dialog.getByLabel('장소').fill('  강남역 2번 출구 ');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('listitem').filter({ hasText: '팀 미팅' });
  await expect(row).toContainText('강남역 2번 출구');
  await expect(row.getByText('팀 미팅', { exact: true })).toBeVisible(); // 제목에는 장소가 붙지 않는다

  dialog = await openEditor(page, '팀 미팅');
  await expect(dialog.getByLabel('장소')).toHaveValue('강남역 2번 출구');
  await dialog.getByLabel('장소').fill('');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).not.toContainText('강남역');
});
