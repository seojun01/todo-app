import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expandCompleted, navTo, newDevice, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

async function seed(page: Page): Promise<void> {
  await quickAdd(page, '장보기');
  await quickAdd(page, '운동');
  await quickAdd(page, '어제 일');
  const dialog = await openEditor(page, '어제 일');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-11');
  await dialog.getByRole('button', { name: '저장' }).click();
  await row(page, '운동').getByRole('checkbox', { name: '운동' }).click();
}

test('오늘 화면과 수신함에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await expectNoViolations(page); // 빈 상태
  await seed(page);
  await expandCompleted(page);
  await expectNoViolations(page);
  await navTo(page, '수신함');
  await expectNoViolations(page);
});

test('편집 시트에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '장보기');
  await openEditor(page, '장보기');
  await expectNoViolations(page);
});

test('키보드만으로 추가·완료·수정·삭제가 된다', async ({ page }) => {
  await openApp(page);
  const input = page.getByRole('textbox', { name: '할 일 추가' });
  await input.focus();
  await page.keyboard.type('키보드로 추가');
  await page.keyboard.press('Enter');
  await expect(row(page, '키보드로 추가')).toBeVisible();

  const check = row(page, '키보드로 추가').getByRole('checkbox');
  await check.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('details.completed')).toBeVisible();

  await page.locator('details.completed summary').focus();
  await page.keyboard.press('Enter');
  const edit = page.locator('details.completed').getByRole('button', { name: '수정' });
  await edit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '할 일 수정' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('제목')).toBeFocused(); // 시트가 열리면 제목에 포커스
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(edit).toBeFocused(); // 닫으면 열었던 버튼으로 돌아간다

  const del = page.locator('details.completed').getByRole('button', { name: '삭제' });
  await del.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '삭제했어요' })).toBeVisible();
});

test('폭 320px 에서 가로 스크롤이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await seed(page);
  await quickAdd(page, '아주 긴 제목 '.repeat(15).trim().slice(0, 190));
  for (const name of ['오늘', '수신함']) {
    await navTo(page, name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name} 화면의 가로 넘침`).toBeLessThanOrEqual(0);
  }
});

test('등록 화면과 설정 화면(등록 전)에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page, undefined, '#/pair');
  await expect(page.getByRole('heading', { level: 2, name: '기기 등록' })).toBeVisible();
  await expectNoViolations(page);
  await page.getByLabel('페어링 코드').fill('AAAA-AAAA');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('코드'); // 오류 안내가 보이는 상태
  await expectNoViolations(page);
  await navTo(page, '설정');
  await expect(page.getByRole('heading', { level: 2, name: '설정' })).toBeVisible();
  await expectNoViolations(page);
});

test('설정 화면(등록 후)에 WCAG 2.1 AA 위반이 없다', async ({ browser }) => {
  const { context, page } = await newDevice(browser, 'a11y-기기');
  await navTo(page, '설정');
  await expect(page.getByRole('button', { name: '지금 동기화' })).toBeVisible();
  await expectNoViolations(page);
  await context.close();
});

test('화면 언어는 한국어이다 (FR-038): lang=ko 이고 주요 화면의 제목·버튼 문구가 한국어', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  const hangul = /[가-힣]/;
  for (const hash of ['#/today', '#/upcoming', '#/project/inbox', '#/calendar', '#/settings', '#/pair']) {
    await page.goto('/' + hash);
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
    const texts = await page.locator('main h2, main h3, main button, main label, nav a, nav button').allTextContents();
    const labels = texts.map((t) => t.trim()).filter((t) => t && !/^[\d\s✓↻⚑P]+$/.test(t)); // 숫자·아이콘만 있는 것은 제외
    expect(labels.length, hash).toBeGreaterThan(0);
    const nonKorean = labels.filter((t) => !hangul.test(t));
    expect(nonKorean, `${hash} 에 한국어가 아닌 문구가 있어요`).toEqual([]);
  }
});

test('프로젝트 시트·삭제 확인·실행 취소 안내가 떠 있는 상태에도 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '프로젝트 추가' }).click();
  const sheet = page.getByRole('dialog', { name: '프로젝트 추가' });
  await expect(sheet).toBeVisible();
  await expectNoViolations(page); // 프로젝트 시트
  await sheet.getByLabel('이름').fill('접근성');
  await sheet.getByRole('button', { name: '저장' }).click();
  await expect(sheet).toBeHidden();

  await nav(page, '접근성').click();
  await expect(page.getByRole('heading', { level: 2, name: '접근성' })).toBeVisible();
  await page.getByRole('button', { name: '프로젝트 삭제' }).click();
  await expect(page.getByRole('alertdialog', { name: '프로젝트 삭제' })).toBeVisible();
  await expectNoViolations(page); // 삭제 확인
  await page.getByRole('alertdialog').getByRole('button', { name: '취소' }).click();

  await quickAdd(page, '토스트 확인');
  await row(page, '토스트 확인').getByRole('button', { name: '토스트 확인 삭제' }).click();
  await expect(page.getByRole('status').filter({ hasText: '삭제했어요' })).toBeVisible();
  await expectNoViolations(page); // 실행 취소 안내가 떠 있는 상태
});

function nav(page: Page, name: string) {
  return page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name });
}
