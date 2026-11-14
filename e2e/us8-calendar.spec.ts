import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expandCompleted, navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목)
const cell = (page: Page, d: number): Locator => page.locator(`button[data-date="2026-11-${String(d).padStart(2, '0')}"]`);
const monthLabel = (page: Page, text: string) => page.getByRole('heading', { level: 3, name: text });

async function addOn(page: Page, title: string, date: string): Promise<void> {
  await quickAdd(page, title);
  const dialog = await openEditor(page, title);
  await dialog.getByLabel('기한', { exact: true }).fill(date);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

test('시나리오 1·2: 이번 달과 선택된 오늘이 보이고, 달 이동과 "오늘" 버튼이 동작한다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '캘린더');
  await expect(monthLabel(page, '2026년 11월')).toBeVisible();
  await expect(cell(page, 12)).toHaveAttribute('aria-current', 'date');
  await expect(cell(page, 12)).toHaveAttribute('aria-pressed', 'true'); // 선택됨
  await expect(page.getByRole('heading', { level: 3, name: '11월 12일 목요일' })).toBeVisible();

  await page.getByRole('button', { name: '다음 달' }).click();
  await expect(monthLabel(page, '2026년 12월')).toBeVisible();
  await page.getByRole('button', { name: '이전 달' }).click();
  await page.getByRole('button', { name: '이전 달' }).click();
  await expect(monthLabel(page, '2026년 10월')).toBeVisible();
  await page.getByRole('button', { name: '오늘' }).click();
  await expect(monthLabel(page, '2026년 11월')).toBeVisible();
  await expect(cell(page, 12)).toHaveAttribute('aria-pressed', 'true');
});

test('시나리오 3·4: 남은 개수와 "모두 완료"가 칸에 표시되고, 할 일이 없는 날은 표시가 없다', async ({ page }) => {
  await openApp(page);
  for (const t of ['하나', '둘', '셋']) await addOn(page, t, '2026-11-20');
  await addOn(page, '끝낼 일', '2026-11-21');
  await navTo(page, '캘린더');
  await cell(page, 20).click();
  await row(page, '셋').getByRole('checkbox').click(); // 1개 완료
  await cell(page, 21).click();
  await row(page, '끝낼 일').getByRole('checkbox').click(); // 그날 할 일을 모두 완료

  await expect(cell(page, 20)).toHaveAccessibleName(/남은 할 일 2개/);
  await expect(cell(page, 20)).toContainText('2');
  await expect(cell(page, 21)).toHaveAccessibleName(/모두 완료/);
  await expect(cell(page, 22)).toHaveAccessibleName('22 일'); // 표시 없음
});

test('시나리오 5: 선택한 날짜에서 추가하면 기한이 그 날짜이고 그 날짜 목록에 나타난다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '캘린더');
  await cell(page, 25).click();
  await expect(page.getByRole('heading', { level: 3, name: '11월 25일 수요일' })).toBeVisible();
  await quickAdd(page, '캘린더에서 추가');
  await expect(cell(page, 25)).toHaveAccessibleName(/남은 할 일 1개/);
  await cell(page, 26).click();
  await expect(row(page, '캘린더에서 추가')).toBeHidden(); // 다른 날짜에는 없다
  await navTo(page, '오늘');
  await expect(row(page, '캘린더에서 추가')).toBeHidden();
});

test('시나리오 6: 기한이 없는 할 일은 어느 날짜에도 나타나지 않는다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '수신함');
  await quickAdd(page, '기한 없음');
  await navTo(page, '캘린더');
  const names = await page.locator('button[data-date^="2026-11"]').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  expect(names.length).toBe(30);
  expect(names.every((t) => !t.includes('남은 할 일') && !t.includes('모두 완료'))).toBe(true);
});

test('키보드: 방향키로 날짜를 옮기고 PageDown 으로 다음 달로 간다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '캘린더');
  await cell(page, 12).focus();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 13)).toBeFocused();
  await page.keyboard.press('ArrowDown'); // +7일
  await expect(cell(page, 20)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, 19)).toBeFocused();
  await expect(page.getByRole('heading', { level: 3, name: '11월 19일 목요일' })).toBeVisible();
  await page.keyboard.press('PageDown');
  await expect(monthLabel(page, '2026년 12월')).toBeVisible();
  await page.keyboard.press('PageUp');
  await expect(monthLabel(page, '2026년 11월')).toBeVisible();
});

test('할 일이 100개인 날도 목록이 스크롤되고 캘린더에는 개수로 요약된다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '캘린더');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('todo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('tasks', 'readwrite');
          const store = tx.objectStore('tasks');
          for (let i = 0; i < 100; i++) {
            store.put({
              id: crypto.randomUUID(), title: `대량 ${i}`, dueDate: '2026-11-18', dueTime: null, projectId: 'inbox', priority: 4,
              recurrence: null, reminders: [], done: false, createdAt: new Date(2026, 10, 12, 9, 0, i).toISOString(), deleted: false,
              version: `001762950896789-${String(i).padStart(6, '0')}-bulk`, updatedBy: 'bulk', dirty: 1,
            });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await expect(cell(page, 18)).toHaveAccessibleName(/남은 할 일 100개/);
  await cell(page, 18).click();
  await expect(page.locator('li.task')).toHaveCount(100);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('캘린더 화면에 WCAG 2.1 AA 위반이 없고 폭 320px 에서 가로 스크롤이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await addOn(page, '표시용', '2026-11-20');
  await navTo(page, '캘린더');
  await cell(page, 20).click();
  await row(page, '표시용').getByRole('checkbox').click();
  await expandCompleted(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// ── 날짜 칸 안의 할 일 미리보기 ──

async function setPriority(page: Page, title: string, label: string): Promise<void> {
  const dialog = await openEditor(page, title);
  await dialog.getByRole('radio', { name: label }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

test('미리보기: 칸 안에 남은 할 일 제목이 최대 3개 보이고 나머지는 "+N개"로 센다 (우선순위 순)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  for (const t of ['가나다', '라마바', '사아자', '차카타', '파하']) await addOn(page, t, '2026-11-20');
  await navTo(page, '캘린더');
  await cell(page, 20).click(); // 그날 목록에서 우선순위를 바꾼다
  await setPriority(page, '파하', '1 긴급'); // 가장 늦게 만들었지만 우선순위가 높아 맨 위

  const items = cell(page, 20).locator('.cal-item');
  await expect(items).toHaveCount(3);
  await expect(items.first()).toHaveText('파하');
  await expect(items.first()).toHaveAttribute('data-priority', '1');
  await expect(cell(page, 20).locator('.cal-more')).toHaveText('+2개');
  await expect(cell(page, 20).locator('.cal-item', { hasText: '차카타' })).toBeHidden(); // 4번째는 안 보인다
  await expect(cell(page, 20)).toHaveAccessibleName(/^20 일, 남은 할 일 5개: 파하, .+ 외 2개$/);

  // 할 일이 없는 날에는 미리보기가 없다
  await expect(cell(page, 22).locator('.cal-preview')).toHaveCount(0);
});

test('미리보기: 하나를 완료하면 칸에서 빠지고, 모두 완료하면 ✓ 만 남는다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await addOn(page, '첫째 일', '2026-11-20');
  await addOn(page, '둘째 일', '2026-11-20');
  await navTo(page, '캘린더');
  await cell(page, 20).click();
  await expect(cell(page, 20).locator('.cal-item')).toHaveCount(2);

  await row(page, '첫째 일').getByRole('checkbox').click();
  await expect(cell(page, 20).locator('.cal-item')).toHaveCount(1);
  await expect(cell(page, 20).locator('.cal-item')).toHaveText('둘째 일');

  await row(page, '둘째 일').getByRole('checkbox').click();
  await expect(cell(page, 20).locator('.cal-preview')).toHaveCount(0);
  await expect(cell(page, 20)).toHaveAccessibleName(/모두 완료/);
});

test('미리보기: 긴 제목은 칸 안에서 잘리고 칸을 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await addOn(page, '아주아주아주아주아주아주아주아주 긴 제목의 할 일입니다 정말로 길어요', '2026-11-20');
  await navTo(page, '캘린더');
  const box = await cell(page, 20).boundingBox();
  const item = await cell(page, 20).locator('.cal-item').boundingBox();
  expect(item!.x + item!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('미리보기: 좁은 화면(폭 320px)에서는 숨기고 개수 배지만 보이며, 이름에는 제목이 들어 있다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await addOn(page, '좁은 화면 일', '2026-11-20');
  await navTo(page, '캘린더');
  await expect(cell(page, 20).locator('.cal-item')).toBeHidden();
  await expect(cell(page, 20).locator('.cal-badge')).toHaveText('1');
  await expect(cell(page, 20)).toHaveAccessibleName(/남은 할 일 1개: 좁은 화면 일/);
});

test('미리보기가 있는 넓은 화면의 캘린더에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  for (const t of ['접근성 하나', '접근성 둘', '접근성 셋', '접근성 넷']) await addOn(page, t, '2026-11-20');
  await navTo(page, '캘린더');
  await cell(page, 20).click();
  await setPriority(page, '접근성 둘', '2 높음');
  await expect(cell(page, 20).locator('.cal-item')).toHaveCount(3);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test('사이드바: 캘린더를 아래로 스크롤해도 왼쪽 메뉴가 처음부터 끝까지 다 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openApp(page);
  await navTo(page, '캘린더');
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  const first = nav.getByRole('link', { name: '오늘', exact: true });
  const last = nav.getByRole('link', { name: '설정', exact: true });
  await expect(first).toBeInViewport();

  // 페이지가 실제로 스크롤될 만큼 길어야 의미 있는 검사다
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(scrollable).toBeGreaterThan(200);

  await page.mouse.wheel(0, 5000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  await expect(first).toBeInViewport(); // 위쪽 항목이 사라지지 않는다
  await expect(last).toBeInViewport(); // 아래쪽 항목도 보인다
  const top = await nav.locator('ul').evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(2); // 화면 맨 위에 붙어 있다
});

test('사이드바: 붙이기(sticky)는 사이드바가 있는 넓은 화면에만 적용되고 좁은 화면 배치는 그대로다', async ({ page }) => {
  const position = () => page.getByRole('navigation', { name: '주 메뉴' }).locator('ul').evaluate((el) => getComputedStyle(el).position);
  await page.setViewportSize({ width: 600, height: 640 });
  await openApp(page);
  expect(await position()).toBe('static');
  await page.setViewportSize({ width: 1024, height: 640 });
  await expect.poll(position).toBe('sticky');
});
