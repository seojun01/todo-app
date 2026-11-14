import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목). 예정 첫 화면은 11/12(오늘)~11/14(토), 다음 주는 11/15(일)~11/21(토)
const section = (page: Page, heading: string): Locator => page.locator('section.day', { has: page.getByRole('heading', { level: 3, name: heading }) });
const ghosts = (page: Page, heading: string): Locator => section(page, heading).locator('li.task-ghost');
const reals = (page: Page, heading: string): Locator => section(page, heading).locator('li.task');
const cell = (page: Page, d: number): Locator => page.locator(`button[data-date="2026-11-${String(d).padStart(2, '0')}"]`);

/** 오늘 화면에서 추가한 할 일에 기한과 반복을 지정한다 */
async function makeRecurring(page: Page, title: string, date: string, repeat: string, extra?: (d: Locator) => Promise<void>): Promise<void> {
  await quickAdd(page, title);
  const d = await openEditor(page, title);
  await d.getByLabel('기한', { exact: true }).fill(date);
  await d.getByLabel('반복', { exact: true }).selectOption({ label: repeat });
  if (extra) await extra(d);
  await d.getByRole('button', { name: '저장' }).click();
  await expect(d).toBeHidden();
}
const nextWeek = (page: Page) => page.getByRole('button', { name: '다음 주' }).click();

test('시나리오 1: 매일 반복은 예정에서 오늘은 실제 카드, 이후 날짜마다 점선 카드로 보인다', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '매일 운동', '2026-11-12', '매일');
  await navTo(page, '예정');

  await expect(reals(page, '11월 12일 목요일')).toHaveCount(1);
  await expect(ghosts(page, '11월 12일 목요일')).toHaveCount(0);
  for (const d of ['11월 13일 금요일', '11월 14일 토요일']) {
    await expect(reals(page, d)).toHaveCount(0);
    await expect(ghosts(page, d).filter({ hasText: '매일 운동' })).toHaveCount(1);
    await expect(section(page, d).getByText('할 일 없음')).toBeHidden();
  }
  // 점선 카드에는 완료 체크가 없고 시리즈 수정만 있다
  await expect(ghosts(page, '11월 13일 금요일').getByRole('checkbox')).toHaveCount(0);
  await expect(ghosts(page, '11월 13일 금요일').getByRole('button', { name: '매일 운동 반복 일정 수정' })).toBeVisible();
  await expect(section(page, '11월 13일 금요일').locator('.day-count')).toHaveText('1');

  await nextWeek(page);
  await expect(page.locator('section.day li.task-ghost')).toHaveCount(7); // 다음 주 7일 모두
  await expect(page.locator('section.day li.task')).toHaveCount(0);
});

test('시나리오 2: 매주 월·수는 그 요일마다만 나타나고, 그다음 주에도 이어진다', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '주간 회의', '2026-11-16', '매주', async (d) => {
    await d.getByLabel('월', { exact: true }).check(); // 기한(월요일)의 요일은 기본으로 체크돼 있다
    await d.getByLabel('수', { exact: true }).check();
  });
  await navTo(page, '예정');
  await nextWeek(page); // 11/15 ~ 11/21
  await expect(reals(page, '11월 16일 월요일')).toHaveCount(1); // 실제 기한
  await expect(ghosts(page, '11월 18일 수요일')).toHaveCount(1); // 가상 회차
  for (const d of ['11월 15일 일요일', '11월 17일 화요일', '11월 19일 목요일', '11월 20일 금요일', '11월 21일 토요일']) {
    await expect(section(page, d).locator('li.task, li.task-ghost')).toHaveCount(0);
  }
  await nextWeek(page); // 11/22 ~ 11/28
  await expect(ghosts(page, '11월 23일 월요일')).toHaveCount(1);
  await expect(ghosts(page, '11월 25일 수요일')).toHaveCount(1);
  await expect(page.locator('section.day li.task-ghost')).toHaveCount(2);
});

test('시나리오 3: 완료하면 다음 날짜가 실제 카드가 되고 점선 카드는 그 뒤 날짜로 이어진다', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '매일 운동', '2026-11-12', '매일');
  await row(page, '매일 운동').getByRole('checkbox').click(); // 오늘 회차 완료 → 기한 11/13
  await expect(row(page, '매일 운동')).toBeHidden();
  await navTo(page, '예정');
  await expect(section(page, '11월 12일 목요일').getByText('할 일 없음')).toBeVisible(); // 완료한 날은 비었다
  await expect(reals(page, '11월 13일 금요일')).toHaveCount(1);
  await expect(ghosts(page, '11월 13일 금요일')).toHaveCount(0);
  await expect(ghosts(page, '11월 14일 토요일')).toHaveCount(1);
});

test('시나리오 4: 종료 날짜까지만 점선 카드가 나온다', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '기간 한정', '2026-11-12', '매일', async (d) => {
    await d.getByLabel('종료 날짜').fill('2026-11-14');
  });
  await navTo(page, '예정');
  await expect(ghosts(page, '11월 13일 금요일')).toHaveCount(1);
  await expect(ghosts(page, '11월 14일 토요일')).toHaveCount(1);
  await nextWeek(page);
  await expect(page.locator('section.day li.task-ghost')).toHaveCount(0); // 종료 날짜 뒤에는 없다
});

test('시나리오 5: 기한이 지난 반복은 오늘 이후(내일)부터 점선 카드가 나온다', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '밀린 매일', '2026-11-09', '매일');
  await navTo(page, '예정');
  await expect(section(page, '11월 12일 목요일').locator('li.task, li.task-ghost')).toHaveCount(0); // 오늘 칸에는 점선이 없다
  await expect(ghosts(page, '11월 13일 금요일')).toHaveCount(1);
  await expect(ghosts(page, '11월 14일 토요일')).toHaveCount(1);
});

test('시나리오 6: 삭제하거나 반복을 해제하면 점선 카드가 사라진다', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '지울 반복', '2026-11-12', '매일');
  await makeRecurring(page, '해제할 반복', '2026-11-12', '매일');
  await navTo(page, '예정');
  await expect(ghosts(page, '11월 13일 금요일')).toHaveCount(2);

  await navTo(page, '오늘');
  await row(page, '지울 반복').getByRole('button', { name: '지울 반복 삭제' }).click();
  const d = await openEditor(page, '해제할 반복');
  await d.getByLabel('반복', { exact: true }).selectOption({ label: '반복 안 함' });
  await d.getByRole('button', { name: '저장' }).click();
  await expect(d).toBeHidden();
  await navTo(page, '예정');
  await expect(page.locator('section.day li.task-ghost')).toHaveCount(0);
  await expect(reals(page, '11월 12일 목요일')).toHaveCount(1); // 해제한 것은 일반 할 일로 남는다
});

test('시나리오 7: 점선 카드의 "수정"은 시리즈의 실제 할 일을 연다 (제목을 고치면 모든 카드가 바뀐다)', async ({ page }) => {
  await openApp(page);
  await makeRecurring(page, '매일 운동', '2026-11-12', '매일');
  await navTo(page, '예정');
  await ghosts(page, '11월 14일 토요일').getByRole('button', { name: '매일 운동 반복 일정 수정' }).click();
  const dialog = page.getByRole('dialog', { name: '할 일 수정' });
  await expect(dialog.getByLabel('기한', { exact: true })).toHaveValue('2026-11-12'); // 가상 회차(14일)가 아니라 실제 기한
  await expect(dialog.getByLabel('반복', { exact: true })).toHaveValue('day');
  await dialog.getByLabel('제목').fill('아침 운동');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await expect(reals(page, '11월 12일 목요일').filter({ hasText: '아침 운동' })).toHaveCount(1);
  await expect(ghosts(page, '11월 14일 토요일').filter({ hasText: '아침 운동' })).toHaveCount(1);
  await expect(page.getByText('매일 운동')).toHaveCount(0);
});

test('시나리오 8: 캘린더 칸에 점선 미리보기, 이름에 "반복 예정", 날짜를 고르면 "반복 예정" 목록이 나온다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await makeRecurring(page, '매일 운동', '2026-11-12', '매일');
  await navTo(page, '캘린더');

  const preview = cell(page, 13).locator('.cal-item.cal-ghost');
  await expect(preview).toHaveCount(1);
  await expect(preview).toHaveText('↻ 매일 운동');
  await expect(cell(page, 13)).toHaveAccessibleName(/^13 일, 반복 예정 1개: 매일 운동$/);
  await expect(cell(page, 13).locator('.cal-badge')).toHaveCount(0); // 남은 개수에는 세지 않는다
  await expect(cell(page, 12)).toHaveAccessibleName(/^12 일, 남은 할 일 1개: 매일 운동$/); // 실제 기한인 날
  await expect(cell(page, 12).locator('.cal-ghost')).toHaveCount(0);

  await cell(page, 13).click();
  const group = page.locator('.ghost-group');
  await expect(group.getByRole('heading', { level: 4, name: '반복 예정' })).toBeVisible();
  await expect(group.locator('li.task-ghost')).toHaveCount(1);
  await expect(group.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText('이 날은 할 일이 없어요')).toBeHidden();

  await cell(page, 12).click(); // 실제 기한인 날에는 반복 예정 구역이 없다
  await expect(page.locator('.ghost-group')).toHaveCount(0);
  await expect(row(page, '매일 운동')).toBeVisible();
});

test('시나리오 9: 한 날의 반복 회차가 4개면 칸에는 3개만 보이고 나머지는 +1개로 센다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await makeRecurring(page, '반복 가', '2026-11-12', '매일');
  await makeRecurring(page, '반복 나', '2026-11-12', '매일');
  await makeRecurring(page, '반복 다', '2026-11-12', '매일');
  await makeRecurring(page, '반복 라', '2026-11-12', '매일');
  await navTo(page, '캘린더');
  // 13일: 가상 회차 4개 → 3개만 보이고 +1개
  await expect(cell(page, 13).locator('.cal-item')).toHaveCount(3);
  await expect(cell(page, 13).locator('.cal-more')).toHaveText('+1개');
  await expect(cell(page, 13)).toHaveAccessibleName(/반복 예정 4개: .+ 외 1개$/);
});

test('점선 카드가 있는 예정 화면과 캘린더에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await makeRecurring(page, '접근성 반복', '2026-11-12', '매일');
  const check = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  };
  await navTo(page, '예정');
  await expect(ghosts(page, '11월 13일 금요일')).toHaveCount(1);
  await check();
  await navTo(page, '캘린더');
  await cell(page, 13).click();
  await expect(page.locator('.ghost-group li.task-ghost')).toHaveCount(1);
  await check();
});
