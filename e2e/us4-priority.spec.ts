import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

async function setPriority(page: Page, title: string, label: string): Promise<void> {
  const dialog = await openEditor(page, title);
  await dialog.getByRole('radio', { name: label }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}
const titles = (page: Page) => page.locator('li.task .task-title').allTextContents();

test('시나리오 1·2: 우선순위를 고르면 저장되고 오늘 화면에서 우선순위 순(1, 2, 4)으로 보인다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '평범한 일'); // 고르지 않으면 4(없음)
  await quickAdd(page, '급한 일');
  await quickAdd(page, '중요한 일');
  await setPriority(page, '급한 일', '1 긴급');
  await setPriority(page, '중요한 일', '2 높음');
  await expect.poll(() => titles(page)).toEqual(['급한 일', '중요한 일', '평범한 일']);

  // 새로고침해도 유지
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(['급한 일', '중요한 일', '평범한 일']);
});

test('시나리오 1: 편집 시트의 기본 선택은 현재 우선순위이고, 고르지 않으면 4(없음)', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '기본값 확인');
  let dialog = await openEditor(page, '기본값 확인');
  await expect(dialog.getByRole('radio', { name: '4 없음' })).toBeChecked();
  await dialog.getByRole('radio', { name: '3 보통' }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  dialog = await openEditor(page, '기본값 확인');
  await expect(dialog.getByRole('radio', { name: '3 보통' })).toBeChecked();
});

test('시나리오 3: 우선순위는 색상과 함께 텍스트·아이콘으로 표시되고 화면 낭독기용 이름도 있다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '긴급한 것');
  await quickAdd(page, '없음인 것');
  await setPriority(page, '긴급한 것', '1 긴급');
  const urgent = row(page, '긴급한 것');
  await expect(urgent.locator('.badge')).toContainText('P1'); // 색 외에 텍스트(와 아이콘)
  await expect(urgent).toContainText('우선순위 1 긴급'); // 화면 낭독기용 텍스트
  await expect(row(page, '없음인 것').locator('.badge')).toHaveCount(0); // 4(없음)는 표시하지 않는다
});

test('시나리오 4: 우선순위가 같으면 먼저 만든 순서', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '먼저');
  await page.clock.fastForward(2000); // 만든 시각이 확실히 다르게
  await quickAdd(page, '나중');
  await page.clock.fastForward(2000);
  await quickAdd(page, '맨 나중');
  await expect.poll(() => titles(page)).toEqual(['먼저', '나중', '맨 나중']);
  await setPriority(page, '맨 나중', '2 높음');
  await expect.poll(() => titles(page)).toEqual(['맨 나중', '먼저', '나중']);
});

test('우선순위 표시와 선택 UI 에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  for (const [t, label] of [['하나', '1 긴급'], ['둘', '2 높음'], ['셋', '3 보통']] as const) {
    await quickAdd(page, t);
    await setPriority(page, t, label);
  }
  const check = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  };
  await check();
  await openEditor(page, '하나');
  await check();
});
