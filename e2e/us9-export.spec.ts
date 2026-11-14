import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR', acceptDownloads: true });

async function edit(page: Page, title: string, fn: (d: import('@playwright/test').Locator) => Promise<void>): Promise<void> {
  const dialog = await openEditor(page, title);
  await fn(dialog);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

test('시나리오 1: 내보내기로 받은 파일은 올바른 JSON 이고 만든 프로젝트·할 일이 모두 들어 있다', async ({ page }) => {
  await openApp(page);
  // 프로젝트 하나와 속성이 다양한 할 일들
  await page.getByRole('button', { name: '프로젝트 추가' }).click();
  const pd = page.getByRole('dialog', { name: '프로젝트 추가' });
  await pd.getByLabel('이름').fill('업무');
  await pd.getByRole('radio', { name: '파랑' }).check();
  await pd.getByRole('button', { name: '저장' }).click();
  await expect(pd).toBeHidden(); // 모달이 닫힌 뒤에 조작한다 (닫히는 중에는 뒤의 입력창이 포커스를 받지 못한다)

  await quickAdd(page, '공과금 납부');
  await edit(page, '공과금 납부', async (d) => {
    await d.getByLabel('프로젝트').selectOption({ label: '업무' });
    await d.getByLabel('기한', { exact: true }).fill('2026-11-25');
    await d.getByRole('radio', { name: '2 높음' }).check();
    await d.getByLabel('반복', { exact: true }).selectOption({ label: '매월' });
  });
  await quickAdd(page, '장보기');
  await quickAdd(page, '끝낸 일');
  await row(page, '끝낸 일').getByRole('checkbox').click();
  await quickAdd(page, '지울 일');
  await row(page, '지울 일').getByRole('button', { name: '지울 일 삭제' }).click();
  await expect(row(page, '지울 일')).toBeHidden();

  await navTo(page, '설정');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '내보내기' }).click()]);
  expect(download.suggestedFilename()).toBe('todo-export-2026-11-12.json');
  const data = JSON.parse(readFileSync((await download.path())!, 'utf8'));

  expect(data.format).toBe('todo-export');
  expect(data.schemaVersion).toBe(1);
  expect(Date.parse(data.exportedAt)).toBeGreaterThan(0);
  expect(data.projects).toHaveLength(1);
  expect(data.projects[0]).toMatchObject({ name: '업무', color: 'blue' });
  expect(data.settings).toEqual({ defaultReminderTime: '09:00' });

  const byTitle = Object.fromEntries(data.tasks.map((t: { title: string }) => [t.title, t]));
  expect(Object.keys(byTitle).sort()).toEqual(['공과금 납부', '끝낸 일', '장보기']); // 삭제한 일은 없다
  expect(byTitle['공과금 납부']).toMatchObject({
    dueDate: '2026-11-25', dueTime: null, priority: 2, done: false, reminders: [],
    projectId: data.projects[0].id, recurrence: { unit: 'month', interval: 1, dayOfMonth: 25 },
  });
  expect(byTitle['끝낸 일'].done).toBe(true);
  expect(byTitle['장보기']).toMatchObject({ projectId: 'inbox', priority: 4, recurrence: null });
  for (const t of data.tasks) for (const k of ['version', 'updatedBy', 'dirty', 'deleted']) expect(t).not.toHaveProperty(k);
  for (const t of data.tasks) expect(Date.parse(t.createdAt)).toBeGreaterThan(0);
});

test('설정 화면에 내보내기 안내와 버튼이 있다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '설정');
  await expect(page.getByRole('heading', { level: 3, name: '내 데이터' })).toBeVisible();
  await expect(page.getByRole('button', { name: '내보내기' })).toBeEnabled();
});
