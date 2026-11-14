import { test, expect, type Locator, type Page } from '@playwright/test';
import { navTo, openApp, openEditor, quickAdd } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 고정 시계: 2026-11-12(목) 09:00. 한 시간 = 52px
const HOUR = 52;
const mode = (page: Page, name: string) => page.getByRole('group', { name: '보기 방식' }).getByRole('button', { name, exact: true });
const col = (page: Page, date: string) => page.locator(`.tg-col[data-date="${date}"]`);
const block = (page: Page, title: string) => page.locator('.tg-block', { hasText: title }).first();

async function addTimed(page: Page, title: string, time: string | null, duration: string | null, date = '2026-11-12'): Promise<void> {
  await quickAdd(page, title);
  const dialog = await openEditor(page, title);
  await dialog.getByLabel('기한', { exact: true }).fill(date);
  if (time) await dialog.getByLabel('기한 시각').fill(time);
  if (duration) await dialog.getByLabel('길이').selectOption({ label: duration });
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

async function openCalendar(page: Page, m: '일' | '주'): Promise<void> {
  await navTo(page, '캘린더');
  await mode(page, m).click();
  await expect(page.locator('.tg-col').first()).toBeVisible();
  // 처음 보이는 시각으로 스크롤이 자리 잡은 뒤에 좌표를 읽는다
  await expect.poll(() => page.locator('.tg-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
}

/** 마우스로 (x1,y1) 에서 (x2,y2) 까지 끈다 */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** 열의 위에서 minutes 분 위치의 화면 좌표 */
async function at(loc: Locator, minutes: number, xFrac = 0.5): Promise<{ x: number; y: number }> {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width * xFrac, y: b.y + (minutes * HOUR) / 60 };
}

test('빈 곳을 한 번 누르면 그 시각(30분 칸)에서 한 시간짜리 일정 만들기 창이 열린다', async ({ page }) => {
  await openApp(page);
  await openCalendar(page, '일');
  const p = await at(col(page, '2026-11-12'), 10 * 60 + 10);
  await page.mouse.click(p.x, p.y);
  const dialog = page.getByRole('dialog', { name: '할 일 추가' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('기한', { exact: true })).toHaveValue('2026-11-12');
  await expect(dialog.getByLabel('기한 시각')).toHaveValue('10:00');
  await expect(dialog.getByLabel('길이')).toHaveValue('60');
  await dialog.getByLabel('제목').fill('치과');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await expect(block(page, '치과')).toHaveCSS('top', `${10 * HOUR}px`);
  await expect(block(page, '치과')).toHaveCSS('height', `${HOUR - 1}px`);
});

test('빈 곳을 끌면 끈 구간(15분 단위)으로 만들기 창이 열린다', async ({ page }) => {
  await openApp(page);
  await openCalendar(page, '일');
  const c = col(page, '2026-11-12');
  await drag(page, await at(c, 14 * 60), await at(c, 16 * 60 + 30));
  const dialog = page.getByRole('dialog', { name: '할 일 추가' });
  await expect(dialog.getByLabel('기한 시각')).toHaveValue('14:00');
  await expect(dialog.getByLabel('길이')).toHaveValue('150');
});

test('블록을 아래로 끌면 시각이 바뀌고(15분 단위), 실행 취소로 되돌린다. 끌고 난 뒤에는 수정 창이 열리지 않는다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '컴퓨터구조', '13:00', '2시간');
  await openCalendar(page, '일');
  const b = block(page, '컴퓨터구조');
  const box = (await b.boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: box.x + box.width / 2, y: box.y + 20 + HOUR }); // 한 시간 아래
  await expect(block(page, '컴퓨터구조')).toHaveCSS('top', `${14 * HOUR}px`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/로 옮겼어요/)).toBeVisible();
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(block(page, '컴퓨터구조')).toHaveCSS('top', `${13 * HOUR}px`);
});

test('주 보기에서 블록을 옆 열로 끌면 날짜가 바뀐다 (시각은 그대로)', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '블록체인', '13:00', '2시간');
  await openCalendar(page, '주');
  const box = (await block(page, '블록체인').boundingBox())!;
  const next = (await col(page, '2026-11-13').boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: next.x + next.width / 2, y: box.y + 20 });
  await expect(col(page, '2026-11-13').locator('.tg-block', { hasText: '블록체인' })).toHaveCSS('top', `${13 * HOUR}px`);
  await expect(col(page, '2026-11-12').locator('.tg-block', { hasText: '블록체인' })).toHaveCount(0);
});

test('블록 아래쪽 끝을 끌면 길이가 바뀐다 (최소 15분, 15분 단위)', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '운동', '13:00', '1시간');
  await openCalendar(page, '일');
  const box = (await block(page, '운동').boundingBox())!;
  const handle = { x: box.x + box.width / 2, y: box.y + box.height - 3 };
  await drag(page, handle, { x: handle.x, y: handle.y + HOUR }); // 한 시간 늘림 → 2시간
  await expect(block(page, '운동')).toHaveCSS('height', `${2 * HOUR - 1}px`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const box2 = (await block(page, '운동').boundingBox())!;
  const h2 = { x: box2.x + box2.width / 2, y: box2.y + box2.height - 3 };
  await drag(page, h2, { x: h2.x, y: h2.y - 5 * HOUR }); // 한참 줄여도 최소 15분
  await expect(block(page, '운동')).toHaveCSS('height', `${HOUR / 4 - 1 < 20 ? 20 : HOUR / 4 - 1}px`);
  // 열어 보면 길이가 15분이다
  await block(page, '운동').click();
  await expect(page.getByRole('dialog', { name: '할 일 수정' }).getByLabel('길이')).toHaveValue('15');
});

test('블록을 하루 종일 줄로 끌면 시각이 없어지고, 칩을 시간 열로 끌면 그 시각이 정해진다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '약속', '13:00', '1시간');
  await openCalendar(page, '일');
  const box = (await block(page, '약속').boundingBox())!;
  const allday = (await page.locator('.tg-allday-cell').boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 15 }, { x: allday.x + allday.width / 2, y: allday.y + allday.height / 2 });
  await expect(page.locator('.tg-block', { hasText: '약속' })).toHaveCount(0);
  const chip = page.locator('.tg-chip', { hasText: '약속' });
  await expect(chip).toBeVisible();

  // 칩 → 시간 열 (HTML5 끌기): 11:10 에 놓으면 11:00 부터 한 시간 (아래쪽의 토스트가 가리지 않는 위치)
  const c = (await col(page, '2026-11-12').boundingBox())!;
  await chip.dragTo(col(page, '2026-11-12'), { targetPosition: { x: c.width / 2, y: ((11 * 60 + 10) * HOUR) / 60 } });
  await expect(block(page, '약속')).toHaveCSS('top', `${11 * HOUR}px`);
  await expect(block(page, '약속')).toHaveCSS('height', `${HOUR - 1}px`);
});

test('주 보기에서 하루 종일 칩을 다른 날 칸으로 끌면 날짜가 바뀐다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '일정 정리', null, null);
  await openCalendar(page, '주');
  await page.locator('.tg-chip', { hasText: '일정 정리' }).dragTo(page.locator('.tg-allday-cell[data-date="2026-11-14"]'));
  await expect(page.locator('.tg-allday-cell[data-date="2026-11-14"]').getByText('일정 정리')).toBeVisible();
  await expect(page.locator('.tg-allday-cell[data-date="2026-11-12"]').getByText('일정 정리')).toHaveCount(0);
});

test('끄는 도중 Esc 를 누르면 취소되어 아무것도 바뀌지 않는다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '회의', '13:00', '1시간');
  await openCalendar(page, '일');
  const box = (await block(page, '회의').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15 + 2 * HOUR, { steps: 6 });
  await expect(page.locator('.tg-preview')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.tg-preview')).toHaveCount(0);
  await expect(block(page, '회의')).toHaveCSS('top', `${13 * HOUR}px`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('시각 알림이 있는 일정을 하루 종일로 옮겨도 저장되고, 되돌리면 알림이 돌아온다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '알림 일정');
  let dialog = await openEditor(page, '알림 일정');
  await dialog.getByLabel('기한', { exact: true }).fill('2026-11-12');
  await dialog.getByLabel('기한 시각').fill('15:00');
  await dialog.getByLabel('길이').selectOption({ label: '1시간' });
  await dialog.getByRole('checkbox', { name: /10분 전/ }).check();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await openCalendar(page, '일');
  const box = (await block(page, '알림 일정').boundingBox())!;
  const allday = (await page.locator('.tg-allday-cell').boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 15 }, { x: allday.x + allday.width / 2, y: allday.y + allday.height / 2 });
  await expect(page.locator('.tg-chip', { hasText: '알림 일정' })).toBeVisible(); // 저장 실패 없이 옮겨졌다
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(block(page, '알림 일정')).toHaveCSS('top', `${15 * HOUR}px`);
  await block(page, '알림 일정').click();
  dialog = page.getByRole('dialog', { name: '할 일 수정' });
  await expect(dialog.getByRole('checkbox', { name: /10분 전/ })).toBeChecked();
});

test('주 보기: 블록에 마우스를 올려 ×를 누르면 삭제되고, 실행 취소로 돌아온다 (수정 창·만들기 창은 열리지 않는다)', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '지울 일정', '13:00', '1시간');
  await openCalendar(page, '주');
  const del = page.getByRole('button', { name: '지울 일정 삭제' });
  await expect(del).toHaveCSS('opacity', '0'); // 평소에는 보이지 않는다
  await block(page, '지울 일정').hover();
  await expect(del).toHaveCSS('opacity', '1');
  await del.click();
  await expect(page.locator('.tg-block', { hasText: '지울 일정' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('삭제했어요')).toBeVisible();
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(block(page, '지울 일정')).toHaveCSS('top', `${13 * HOUR}px`);
});

test('블록에 포커스를 두고 Delete 키를 누르면 삭제된다 (키보드 사용자용)', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '키보드로 지움', '10:00', '1시간');
  await addTimed(page, '남을 일정', '15:00', '1시간');
  await openCalendar(page, '주');
  await block(page, '키보드로 지움').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.tg-block', { hasText: '키보드로 지움' })).toHaveCount(0);
  await expect(block(page, '남을 일정')).toBeVisible(); // 다른 일정은 그대로
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(block(page, '키보드로 지움')).toBeVisible();
});

test('하루 종일 칩도 Delete 키로 삭제할 수 있다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '종일 일정', null, null);
  await openCalendar(page, '주');
  await page.locator('.tg-chip', { hasText: '종일 일정' }).focus();
  await page.keyboard.press('Backspace');
  await expect(page.locator('.tg-chip', { hasText: '종일 일정' })).toHaveCount(0);
});

test('주 보기: Option(Alt)을 누른 채 블록을 옆 열로 끌면 복사되고 원래 블록은 그대로다. 실행 취소하면 복사본만 사라진다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '스터디', '13:00', '2시간');
  await openCalendar(page, '주');
  const box = (await block(page, '스터디').boundingBox())!;
  const next = (await col(page, '2026-11-13').boundingBox())!;
  await page.keyboard.down('Alt');
  await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: next.x + next.width / 2, y: box.y + 20 + HOUR });
  await page.keyboard.up('Alt');
  const copied = col(page, '2026-11-13').locator('.tg-block', { hasText: '스터디' });
  await expect(copied).toHaveCSS('top', `${14 * HOUR}px`);
  await expect(copied).toHaveCSS('height', `${2 * HOUR - 1}px`); // 길이도 같다
  await expect(col(page, '2026-11-12').locator('.tg-block', { hasText: '스터디' })).toHaveCSS('top', `${13 * HOUR}px`);
  await expect(page.getByText(/에 복사했어요/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(copied).toHaveCount(0);
  await expect(col(page, '2026-11-12').locator('.tg-block', { hasText: '스터디' })).toBeVisible();
});

test('블록에 포커스를 두고 ⌘/Ctrl+C, 마우스를 둔 칸에서 ⌘/Ctrl+V 를 누르면 그 칸에 붙여 넣는다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '회의', '10:00', '1시간');
  await openCalendar(page, '주');
  await block(page, '회의').focus();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByText(/복사했어요/)).toBeVisible();
  const p = await at(col(page, '2026-11-14'), 11 * 60 + 10);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(col(page, '2026-11-14').locator('.tg-block', { hasText: '회의' })).toHaveCSS('top', `${11 * HOUR}px`);
  await expect(col(page, '2026-11-12').locator('.tg-block', { hasText: '회의' })).toBeVisible();
  // 한 번 더 붙여 넣을 수 있다
  const q = await at(col(page, '2026-11-10'), 9 * 60 + 10);
  await page.mouse.move(q.x, q.y);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(col(page, '2026-11-10').locator('.tg-block', { hasText: '회의' })).toHaveCSS('top', `${9 * HOUR}px`);
});

test('마우스가 격자 밖에 있으면 ⌘/Ctrl+V 는 복사한 일정의 다음 날 같은 시각에 붙여 넣는다. 하루 종일 칩도 복사된다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '종일 행사', null, null);
  await openCalendar(page, '주');
  await page.locator('.tg-chip', { hasText: '종일 행사' }).focus();
  await page.keyboard.press('ControlOrMeta+c');
  await page.mouse.move(1, 1);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.tg-allday-cell[data-date="2026-11-13"] .tg-chip', { hasText: '종일 행사' })).toBeVisible();
  await expect(page.locator('.tg-allday-cell[data-date="2026-11-12"] .tg-chip', { hasText: '종일 행사' })).toBeVisible();
});

test('블록을 우클릭해 "복사"를 고르고, 빈 칸을 우클릭해 "붙여넣기"를 고르면 그 칸에 복사된다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '세미나', '10:00', '1시간');
  await openCalendar(page, '주');
  await block(page, '세미나').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '복사' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0); // 우클릭은 수정 창을 열지 않는다
  const p = await at(col(page, '2026-11-13'), 11 * 60 + 40);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.getByRole('menuitem', { name: /세미나.*붙여넣기/ }).click();
  await expect(col(page, '2026-11-13').locator('.tg-block', { hasText: '세미나' })).toHaveCSS('top', `${11.5 * HOUR}px`);
  await expect(col(page, '2026-11-12').locator('.tg-block', { hasText: '세미나' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); // 만들기 창도 열리지 않는다
});

test('우클릭 메뉴: 복사한 것이 없으면 붙여넣기는 비활성, Esc 로 닫힌다. 블록 메뉴의 "삭제"로 지울 수 있다', async ({ page }) => {
  await openApp(page);
  await addTimed(page, '지울 일정', '10:00', '1시간');
  await openCalendar(page, '주');
  const p = await at(col(page, '2026-11-13'), 11 * 60 + 10);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: '붙여넣기' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await block(page, '지울 일정').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '삭제' }).click();
  await expect(page.locator('.tg-block', { hasText: '지울 일정' })).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(block(page, '지울 일정')).toBeVisible();
});
