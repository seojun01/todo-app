import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { newDevice, openApp, openEditor, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

const nav = (page: Page) => page.getByRole('navigation', { name: '주 메뉴' });
const chip = (page: Page, tag: string) => page.getByRole('link', { name: `태그 ${tag}`, exact: true });

/** 편집 시트에서 태그 입력을 바꿔 저장한다 */
async function setTags(page: Page, title: string, tags: string): Promise<void> {
  const dialog = await openEditor(page, title);
  await dialog.getByLabel('태그', { exact: true }).fill(tags);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}

test('시나리오 1: 편집 시트에서 공백·쉼표로 태그를 붙이면 카드에 #태그로 보이고 새로고침해도 남는다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '병원 예약');
  await setTags(page, '병원 예약', '집, 급함  #업무');
  for (const t of ['집', '급함', '업무']) await expect(row(page, '병원 예약').getByRole('link', { name: `태그 ${t}`, exact: true })).toBeVisible();
  await expect(row(page, '병원 예약')).toContainText('#집');
  await page.reload();
  await expect(chip(page, '급함')).toBeVisible();

  // 편집 시트를 다시 열면 입력창에 현재 태그가 들어 있다
  const dialog = await openEditor(page, '병원 예약');
  await expect(dialog.getByLabel('태그', { exact: true })).toHaveValue('집 급함 업무');
  await dialog.getByRole('button', { name: '취소' }).click();
});

test('시나리오 2: 태그를 누르면 그 태그의 모든 할 일 화면으로 가고, 내비게이션에도 태그와 개수가 보인다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '치과');
  await quickAdd(page, '장보기');
  await quickAdd(page, '운동');
  await setTags(page, '치과', '집');
  await setTags(page, '장보기', '집 마트');
  await setTags(page, '운동', '건강');

  await expect(nav(page).getByRole('link', { name: '#집 2' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '#마트 1' })).toBeVisible();

  await chip(page, '집').first().click();
  await expect(page).toHaveURL(/#\/tag\/%EC%A7%91$/);
  await expect(page.getByRole('heading', { level: 2, name: '#집' })).toBeVisible();
  await expect(row(page, '치과')).toBeVisible();
  await expect(row(page, '장보기')).toBeVisible();
  await expect(row(page, '운동')).toBeHidden();
  await expect(nav(page).getByRole('link', { name: '#집 2' })).toHaveAttribute('aria-current', 'page');

  // 내비게이션의 태그로도 같은 화면에 간다
  await nav(page).getByRole('link', { name: '#건강 1' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '#건강' })).toBeVisible();
  await expect(row(page, '운동')).toBeVisible();
  await expect(row(page, '치과')).toBeHidden();
});

test('시나리오 3: 태그 화면에는 기한이 없거나 다른 프로젝트의 할 일도 모이고, 완료하면 완료됨으로 간다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '오늘 할 일');
  await navTo(page, '수신함');
  await quickAdd(page, '기한 없는 일');
  await setTags(page, '기한 없는 일', 'Home');
  await navTo(page, '오늘');
  await setTags(page, '오늘 할 일', 'home'); // 대소문자만 다르다 → 같은 태그

  // 하나로 묶이고, 표기는 먼저 만든 할 일("오늘 할 일")의 것을 따른다
  await expect(nav(page).getByRole('link', { name: /^#home/i })).toHaveCount(1);
  await expect(nav(page).getByRole('link', { name: '#home 2' })).toBeVisible();
  await nav(page).getByRole('link', { name: /^#home/i }).click();
  await expect(row(page, '오늘 할 일')).toBeVisible();
  await expect(row(page, '기한 없는 일')).toBeVisible();

  await row(page, '기한 없는 일').getByRole('checkbox').click();
  await expect(row(page, '기한 없는 일')).toBeHidden();
  await expect(page.locator('details.completed')).toContainText('완료됨 (1)');
});

async function navTo(page: Page, name: string): Promise<void> {
  const link = nav(page).getByRole('link', { name, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
}

test('시나리오 4: 쓰고 있는 태그는 시트에서 눌러 넣고 뺄 수 있다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '첫째');
  await quickAdd(page, '둘째');
  await setTags(page, '첫째', '집 급함');

  const dialog = await openEditor(page, '둘째');
  const input = dialog.getByLabel('태그', { exact: true });
  await expect(input).toHaveValue('');
  const pill = dialog.getByRole('button', { name: '#집', exact: true });
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
  await pill.click();
  await expect(input).toHaveValue('집');
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: '#급함', exact: true }).click();
  await expect(input).toHaveValue('집 급함');
  await pill.click(); // 다시 누르면 뺀다
  await expect(input).toHaveValue('급함');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, '둘째').getByRole('link', { name: '태그 급함', exact: true })).toBeVisible();
  await expect(row(page, '둘째').getByRole('link', { name: '태그 집', exact: true })).toBeHidden();
});

test('시나리오 5: 태그를 모두 지우면 카드와 내비게이션에서 사라지고, 없는 태그 화면은 안내가 나온다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '임시');
  await setTags(page, '임시', '지울것');
  await expect(nav(page).getByRole('link', { name: '#지울것 1' })).toBeVisible();
  await setTags(page, '임시', '');
  await expect(chip(page, '지울것')).toBeHidden();
  await expect(nav(page).getByRole('link', { name: /#지울것/ })).toBeHidden();
  await expect(nav(page).getByText('태그', { exact: true })).toBeHidden(); // 태그가 하나도 없으면 구역 제목도 없다

  await page.goto('/#/tag/%EC%97%86%EC%9D%8C');
  await expect(page.getByRole('heading', { level: 2, name: '#없음' })).toBeVisible();
  await expect(page.getByText('이 태그가 붙은 할 일이 없어요')).toBeVisible();
});

test('시나리오 6: 태그가 11개이거나 형식이 잘못되면 시트가 닫히지 않고 안내가 나온다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '검증');
  const dialog = await openEditor(page, '검증');
  await dialog.getByLabel('태그', { exact: true }).fill(Array.from({ length: 11 }, (_, i) => `t${i}`).join(' '));
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('태그는 10개까지 붙일 수 있어요.');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('태그', { exact: true }).fill('가'.repeat(31));
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.getByRole('alert')).toContainText('30자까지');
  await dialog.getByLabel('태그', { exact: true }).fill('정상');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
  await expect(chip(page, '정상')).toBeVisible();
});

test('시나리오 7: 한 기기에서 붙인 태그가 다른 기기에도 나타난다', async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const title = `동기화 ${Math.random().toString(36).slice(2, 7)}`;
  await quickAdd(a.page, title);
  await expect(row(b.page, title)).toBeVisible({ timeout: 8000 });
  await setTags(a.page, title, '공유태그');
  await expect(row(b.page, title).getByRole('link', { name: '태그 공유태그', exact: true })).toBeVisible({ timeout: 8000 });
  await expect(nav(b.page).getByRole('link', { name: /#공유태그/ })).toBeVisible();
  await a.context.close();
  await b.context.close();
});

test('태그 화면과 태그가 있는 편집 시트에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await openApp(page);
  await quickAdd(page, '접근성');
  await setTags(page, '접근성', '집 급함');
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
  const violations = async () => (await new AxeBuilder({ page }).withTags(tags).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

  expect(await violations()).toEqual([]); // 카드의 태그 링크가 있는 오늘 화면
  await chip(page, '집').click();
  await expect(page.getByRole('heading', { level: 2, name: '#집' })).toBeVisible();
  expect(await violations()).toEqual([]);

  const dialog = await openEditor(page, '접근성');
  await expect(dialog.getByRole('button', { name: '#집', exact: true })).toBeVisible();
  expect(await violations()).toEqual([]);
});

// ── 빠른 추가의 #태그, 태그 이름 바꾸기·지우기 ──

async function quickAddRaw(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '할 일 추가' }).fill(text);
  await page.getByRole('button', { name: '추가', exact: true }).click();
}
const titleOf = (page: Page) => page.locator('li.task .task-title');

test('빠른 추가: 글 끝에 붙여 쓴 #태그는 태그가 되고, 중간의 #·번호(#1)·태그뿐인 글은 제목으로 남는다', async ({ page }) => {
  await openApp(page);
  await quickAddRaw(page, '장보기 #집 #급함');
  await expect(row(page, '장보기')).toBeVisible();
  await expect(titleOf(page).filter({ hasText: /^장보기$/ })).toHaveCount(1); // 제목에서 태그는 빠진다
  await expect(row(page, '장보기').getByRole('link', { name: '태그 집', exact: true })).toBeVisible();
  await expect(row(page, '장보기').getByRole('link', { name: '태그 급함', exact: true })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '#집 1' })).toBeVisible();

  for (const text of ['#1 우선 처리', 'C# 공부', '버그 #123 수정', '#혼자']) {
    await quickAddRaw(page, text);
    await expect(titleOf(page).filter({ hasText: new RegExp(`^${text.replace(/[#]/g, '\\#')}$`) })).toHaveCount(1);
  }
  // 이 네 개는 태그가 붙지 않았다: 태그 링크는 장보기의 두 개뿐이고 내비게이션에도 새 태그가 없다
  await expect(page.locator('li.task a.chip.tag')).toHaveCount(2);
  await expect(nav(page).getByRole('link', { name: /^#/ })).toHaveCount(2);
});

test('빠른 추가: 글 앞에 쓴 #태그도 태그가 된다 (#개인 치과 예약, 앞과 끝을 함께 써도 된다)', async ({ page }) => {
  await openApp(page);
  await quickAddRaw(page, '#개인 치과 예약');
  await expect(row(page, '치과 예약')).toBeVisible();
  await expect(titleOf(page).filter({ hasText: /^치과 예약$/ })).toHaveCount(1);
  await expect(row(page, '치과 예약').getByRole('link', { name: '태그 개인', exact: true })).toBeVisible();

  await quickAddRaw(page, '#집 청소 #급함');
  await expect(row(page, '청소')).toBeVisible();
  await expect(titleOf(page).filter({ hasText: /^청소$/ })).toHaveCount(1);
  await expect(row(page, '청소').getByRole('link', { name: '태그 집', exact: true })).toBeVisible();
  await expect(row(page, '청소').getByRole('link', { name: '태그 급함', exact: true })).toBeVisible();

  // 번호(#1)는 앞에 써도 태그가 아니다
  await quickAddRaw(page, '#1 우선 처리');
  await expect(titleOf(page).filter({ hasText: /^#1 우선 처리$/ })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '할 일 추가' })).toHaveAttribute('placeholder', '할 일 추가 (#태그 가능)');
});

test('빠른 추가: 예정 화면의 날짜 열에서도 끝의 #태그가 태그가 된다', async ({ page }) => {
  await openApp(page);
  await navTo(page, '예정');
  await page.getByRole('button', { name: /11월 13일 금요일에 할 일 추가/ }).click();
  await quickAddRaw(page, '서류 제출 #업무');
  await expect(row(page, '서류 제출').getByRole('link', { name: '태그 업무', exact: true })).toBeVisible();
});

async function seedForRename(page: Page): Promise<void> {
  await openApp(page);
  await quickAdd(page, '치과');
  await quickAdd(page, '장보기');
  await setTags(page, '치과', '집 급함');
  await setTags(page, '장보기', '집');
  await nav(page).getByRole('link', { name: '#집 2' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '#집' })).toBeVisible();
}

test('태그 이름 바꾸기: 모든 할 일의 태그가 새 이름이 되고 새 태그 화면으로 가며, 실행 취소로 되돌린다', async ({ page }) => {
  await seedForRename(page);
  await page.getByRole('button', { name: '태그 이름 바꾸기' }).click();
  const dialog = page.getByRole('dialog', { name: '태그 이름 바꾸기' });
  await expect(dialog.getByLabel('새 이름')).toHaveValue('집');
  await dialog.getByLabel('새 이름').fill('우리집');
  await dialog.getByRole('button', { name: '바꾸기' }).click();
  await expect(dialog).toBeHidden();

  await expect(page).toHaveURL(/#\/tag\/%EC%9A%B0%EB%A6%AC%EC%A7%91$/);
  await expect(page.getByRole('heading', { level: 2, name: '#우리집' })).toBeVisible();
  await expect(row(page, '치과')).toBeVisible();
  await expect(row(page, '장보기')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '#우리집 2' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: /^#집 / })).toHaveCount(0); // 옛 이름은 사라졌다
  await expect(nav(page).getByRole('link', { name: '#급함 1' })).toBeVisible(); // 다른 태그는 그대로
  await expect(page.getByText("태그를 '#우리집'(으)로 바꿨어요 (할 일 2개)")).toBeVisible();

  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '#집' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '#집 2' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: /^#우리집/ })).toHaveCount(0);
  await expect(row(page, '치과').getByRole('link', { name: '태그 집', exact: true })).toBeVisible();
});

test('태그 이름 바꾸기: 이미 있는 태그 이름으로 바꾸면 하나로 합쳐지고, 잘못된 이름·같은 이름은 안내하거나 아무 일도 없다', async ({ page }) => {
  await seedForRename(page);
  await page.getByRole('button', { name: '태그 이름 바꾸기' }).click();
  const dialog = page.getByRole('dialog', { name: '태그 이름 바꾸기' });

  await dialog.getByLabel('새 이름').fill('두 단어');
  await dialog.getByRole('button', { name: '바꾸기' }).click();
  await expect(dialog.getByRole('alert')).toContainText('공백·쉼표 없이');
  await expect(dialog).toBeVisible(); // 닫히지 않는다

  await dialog.getByLabel('새 이름').fill('집'); // 같은 이름
  await dialog.getByRole('button', { name: '바꾸기' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { level: 2, name: '#집' })).toBeVisible();
  await expect(page.getByText(/태그를 .* 바꿨어요/)).toHaveCount(0); // 바뀐 것이 없으니 알림도 없다

  // 치과는 [집, 급함] → 집을 급함으로 바꾸면 [급함] 하나로 합쳐진다
  await page.getByRole('button', { name: '태그 이름 바꾸기' }).click();
  await dialog.getByLabel('새 이름').fill('#급함');
  await dialog.getByRole('button', { name: '바꾸기' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '#급함' })).toBeVisible();
  await expect(row(page, '치과').getByRole('link', { name: '태그 급함', exact: true })).toHaveCount(1);
  await expect(nav(page).getByRole('link', { name: '#급함 2' })).toBeVisible();
});

test('태그 지우기: 확인을 거쳐 모든 할 일에서 태그만 빠지고 할 일은 남으며, 취소하면 아무 일도 없고, 실행 취소로 되돌린다', async ({ page }) => {
  await seedForRename(page);
  await page.getByRole('button', { name: '태그 지우기' }).click();
  const dialog = page.getByRole('alertdialog', { name: '태그 지우기' });
  await expect(dialog).toContainText("'#집' 태그를 지울까요? 할 일 2개에서 태그만 빠지고, 할 일은 그대로 남아요.");
  await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused(); // 기본 포커스는 취소
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toBeHidden();
  await expect(nav(page).getByRole('link', { name: '#집 2' })).toBeVisible();

  await page.getByRole('button', { name: '태그 지우기' }).click();
  await dialog.getByRole('button', { name: '태그 지우기' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(nav(page).getByRole('link', { name: /^#집 / })).toHaveCount(0);
  await expect(row(page, '치과')).toBeVisible(); // 할 일은 그대로
  await expect(row(page, '장보기')).toBeVisible();
  await expect(chip(page, '집')).toHaveCount(0);
  await expect(chip(page, '급함')).toBeVisible(); // 다른 태그는 그대로
  await expect(page.getByText("'#집' 태그를 지웠어요 (할 일 2개)")).toBeVisible();

  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(nav(page).getByRole('link', { name: '#집 2' })).toBeVisible();
  await expect(chip(page, '집')).toHaveCount(2);
});

test('태그 이름 바꾸기는 다른 기기에도 반영된다', async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const t1 = `동기화 ${Math.random().toString(36).slice(2, 7)}`;
  const tag = `원래${Math.random().toString(36).slice(2, 6)}`;
  await quickAdd(a.page, t1);
  await expect(row(b.page, t1)).toBeVisible({ timeout: 8000 });
  await setTags(a.page, t1, tag);
  await expect(nav(b.page).getByRole('link', { name: new RegExp(`^#${tag}`) })).toBeVisible({ timeout: 8000 });

  await nav(a.page).getByRole('link', { name: new RegExp(`^#${tag}`) }).click();
  await a.page.getByRole('button', { name: '태그 이름 바꾸기' }).click();
  await a.page.getByRole('dialog', { name: '태그 이름 바꾸기' }).getByLabel('새 이름').fill(`${tag}새`);
  await a.page.getByRole('dialog', { name: '태그 이름 바꾸기' }).getByRole('button', { name: '바꾸기' }).click();
  await expect(nav(b.page).getByRole('link', { name: new RegExp(`^#${tag}새`) })).toBeVisible({ timeout: 8000 });
  await expect(row(b.page, t1).getByRole('link', { name: `태그 ${tag}새`, exact: true })).toBeVisible();
  await expect(nav(b.page).getByRole('link', { name: new RegExp(`^#${tag} `) })).toHaveCount(0);
  await a.context.close();
  await b.context.close();
});

test('태그 화면의 버튼과 이름 바꾸기·지우기 대화상자에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await seedForRename(page);
  const check = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  };
  await check();
  await page.getByRole('button', { name: '태그 이름 바꾸기' }).click();
  await expect(page.getByRole('dialog', { name: '태그 이름 바꾸기' })).toBeVisible();
  await check();
  await page.getByRole('dialog', { name: '태그 이름 바꾸기' }).getByRole('button', { name: '취소' }).click();
  await page.getByRole('button', { name: '태그 지우기' }).click();
  await expect(page.getByRole('alertdialog', { name: '태그 지우기' })).toBeVisible();
  await check();
});
