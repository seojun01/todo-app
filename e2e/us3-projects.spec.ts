import { test, expect, type Page } from '@playwright/test';
import { expandCompleted, navTo, newDevice, openApp, openEditor, quickAdd, row, syncStatus } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

const nav = (page: Page) => page.getByRole('navigation', { name: '주 메뉴' });

async function createProject(page: Page, name: string, color?: string): Promise<void> {
  await page.getByRole('button', { name: '프로젝트 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '프로젝트 추가' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('이름').fill(name);
  if (color) await dialog.getByRole('radio', { name: color }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

async function openProject(page: Page, name: string): Promise<void> {
  await nav(page).getByRole('link', { name }).first().click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
}

test('시나리오 1: 프로젝트를 이름과 색상으로 만들면 목록에 나타나고 빈 프로젝트 화면이 열린다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '업무', '파랑');
  await expect(nav(page).getByRole('link', { name: '업무' })).toBeVisible();
  await openProject(page, '업무');
  await expect(page.getByText('이 프로젝트는 비어 있어요')).toBeVisible();
});

test('시나리오 2: 프로젝트 화면에서 추가한 할 일은 그 프로젝트 소속이고, 오늘 화면에는 프로젝트 이름이 함께 보인다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '업무');
  await openProject(page, '업무');
  await quickAdd(page, '보고서 쓰기'); // 기한 없이도 프로젝트 화면에 보인다
  await navTo(page, '수신함');
  await expect(row(page, '보고서 쓰기')).toBeHidden();
  await navTo(page, '오늘');
  await expect(row(page, '보고서 쓰기')).toBeHidden(); // 기한이 없으므로 오늘 화면에는 없다

  await openProject(page, '업무');
  const dialog = await openEditor(page, '보고서 쓰기');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-12');
  await dialog.getByRole('button', { name: '저장' }).click();
  await navTo(page, '오늘');
  await expect(row(page, '보고서 쓰기')).toBeVisible();
  await expect(row(page, '보고서 쓰기').getByText('업무', { exact: true })).toBeVisible(); // 소속 프로젝트 표시
});

test('시나리오 3: 수신함의 할 일을 다른 프로젝트로 옮기면 이동한다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '업무');
  await navTo(page, '수신함');
  await quickAdd(page, '장보기');
  const dialog = await openEditor(page, '장보기');
  await dialog.getByLabel('프로젝트').selectOption({ label: '업무' });
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(row(page, '장보기')).toBeHidden(); // 수신함에서 사라짐
  await openProject(page, '업무');
  await expect(row(page, '장보기')).toBeVisible();
});

test('시나리오 4: 이름과 색상을 바꾸면 모든 표시에 반영된다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '업무', '파랑');
  await openProject(page, '업무');
  await quickAdd(page, '메일 답장');
  const editor = await openEditor(page, '메일 답장');
  await editor.getByLabel('기한', { exact: true }).fill('2026-11-12');
  await editor.getByRole('button', { name: '저장' }).click();

  await page.getByRole('button', { name: '프로젝트 수정' }).click();
  const dialog = page.getByRole('dialog', { name: '프로젝트 수정' });
  await dialog.getByLabel('이름').fill('직장');
  await dialog.getByRole('radio', { name: '빨강' }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '직장' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '직장' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '업무' })).toHaveCount(0);
  await navTo(page, '오늘');
  await expect(row(page, '메일 답장').getByText('직장', { exact: true })).toBeVisible();
});

test('시나리오 5: 할 일이 3개 있는 프로젝트를 삭제하면 개수를 알리는 확인을 거친 뒤에만 삭제된다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '지울 프로젝트');
  await openProject(page, '지울 프로젝트');
  for (const t of ['하나', '둘', '셋']) await quickAdd(page, t);

  await page.getByRole('button', { name: '프로젝트 삭제' }).click();
  const confirm = page.getByRole('alertdialog', { name: '프로젝트 삭제' });
  await expect(confirm).toContainText('할 일 3개도 함께 삭제됩니다');
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(confirm).toBeHidden();
  await expect(row(page, '하나')).toBeVisible(); // 취소하면 그대로

  await page.getByRole('button', { name: '프로젝트 삭제' }).click();
  await page.getByRole('alertdialog', { name: '프로젝트 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(nav(page).getByRole('link', { name: '지울 프로젝트' })).toHaveCount(0);
  await navTo(page, '수신함');
  for (const t of ['하나', '둘', '셋']) await expect(row(page, t)).toBeHidden(); // 소속 할 일도 함께 삭제됨
});

test('시나리오 6: 수신함은 이름을 바꾸거나 삭제할 수 없다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  await expect(page.getByRole('heading', { level: 2, name: '수신함' })).toBeVisible();
  await expect(page.getByRole('button', { name: '프로젝트 수정' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '프로젝트 삭제' })).toHaveCount(0);
});

test('시나리오 7: "완료됨" 영역에서 완료한 할 일을 보고 해제할 수 있다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '업무');
  await openProject(page, '업무');
  await quickAdd(page, '끝낸 일');
  await row(page, '끝낸 일').getByRole('checkbox').click();
  const completed = await expandCompleted(page);
  await completed.getByRole('checkbox', { name: '끝낸 일' }).click(); // 완료 해제
  await expect(page.locator('section.open').getByText('끝낸 일')).toBeVisible();
});

test('이름이 같은 프로젝트도 여러 개 만들 수 있다', async ({ page }) => {
  await openApp(page);
  await createProject(page, '중복');
  await createProject(page, '중복');
  await expect(nav(page).getByRole('link', { name: '중복' })).toHaveCount(2);
});

test('프로젝트 시트에서 빈 이름은 저장되지 않고 이유가 안내된다', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '프로젝트 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '프로젝트 추가' });
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.getByRole('alert')).toContainText('이름');
  await expect(dialog).toBeVisible();
});

test('다른 기기가 삭제한 프로젝트에 오프라인으로 추가한 할 일은 사라지지 않고 수신함에 남는다 (FR-014)', async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const name = `공유-${Math.random().toString(36).slice(2, 6)}`;
  await createProject(a.page, name);
  await expect(nav(b.page).getByRole('link', { name })).toBeVisible({ timeout: 8000 });

  await b.context.setOffline(true);
  await openProject(a.page, name);
  await a.page.getByRole('button', { name: '프로젝트 삭제' }).click();
  await a.page.getByRole('alertdialog', { name: '프로젝트 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(nav(a.page).getByRole('link', { name })).toHaveCount(0);

  await openProject(b.page, name);
  const orphan = `고아-${Math.random().toString(36).slice(2, 6)}`;
  await quickAdd(b.page, orphan); // B 는 아직 삭제를 모른다
  await b.context.setOffline(false);
  await expect(syncStatus(b.page)).toContainText('동기화됨', { timeout: 30_000 });

  for (const p of [a.page, b.page]) {
    await navTo(p, '수신함');
    await expect(row(p, orphan)).toBeVisible({ timeout: 30_000 });
    await expect(nav(p).getByRole('link', { name })).toHaveCount(0);
  }
  await a.context.close();
  await b.context.close();
});
