import { test, expect } from '@playwright/test';
import { cliRevoke, deviceIdOf, newDevice, pairThisDevice, quickAdd, row, syncStatus, openEditor } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });
test.setTimeout(90_000);

const uniq = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;

test('V4 실시간: 한 기기에서 추가하면 5초 안에 다른 기기에 새로고침 없이 나타난다', async ({ browser }) => {
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const title = uniq('실시간');
  await quickAdd(a.page, title);
  await expect(row(b.page, title)).toBeVisible({ timeout: 5000 });
  // 완료도 반영된다
  await row(a.page, title).getByRole('checkbox').click();
  await expect(row(b.page, title)).toBeHidden({ timeout: 5000 }); // 완료됨 영역(접힘)으로 이동
  await a.context.close();
  await b.context.close();
});

test('V5 오프라인: 추가·완료·수정·삭제가 즉시 반영되고 재연결 후 다른 기기에 반영된다', async ({ browser }) => {
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const toDone = uniq('완료할 것');
  const toEdit = uniq('고칠 것');
  const toDelete = uniq('지울 것');
  for (const t of [toDone, toEdit, toDelete]) await quickAdd(a.page, t);
  for (const t of [toDone, toEdit, toDelete]) await expect(row(b.page, t)).toBeVisible({ timeout: 8000 });

  await b.context.setOffline(true);
  const added = uniq('오프라인에서 추가');
  await quickAdd(b.page, added);
  await row(b.page, toDone).getByRole('checkbox').click();
  await expect(row(b.page, toDone)).toBeHidden(); // 즉시 반영
  const dialog = await openEditor(b.page, toEdit);
  const edited = uniq('수정됨');
  await dialog.getByLabel('제목').fill(edited);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(row(b.page, edited)).toBeVisible();
  await row(b.page, toDelete).getByRole('button', { name: '삭제' }).click();
  await expect(row(b.page, toDelete)).toBeHidden();

  // 아직 동기화되지 않았다는 표시
  await expect(syncStatus(b.page)).toContainText(/연결 안 됨|대기/, { timeout: 15_000 });
  await expect(row(a.page, added)).toBeHidden();

  await b.context.setOffline(false);
  await expect(row(a.page, added)).toBeVisible({ timeout: 30_000 });
  await expect(row(a.page, edited)).toBeVisible({ timeout: 30_000 });
  await expect(row(a.page, toDelete)).toBeHidden({ timeout: 30_000 });
  await expect(row(a.page, toDone)).toBeHidden({ timeout: 30_000 });
  await expect(syncStatus(b.page)).toContainText('동기화됨', { timeout: 30_000 });
  await a.context.close();
  await b.context.close();
});

test('V6 충돌: 두 기기가 오프라인에서 같은 할 일을 다르게 고치면 나중 수정으로 수렴하고 중복·유실이 없다', async ({ browser }) => {
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const original = uniq('충돌 원본');
  await quickAdd(a.page, original);
  await expect(row(b.page, original)).toBeVisible({ timeout: 8000 });

  await a.context.setOffline(true);
  await b.context.setOffline(true);
  const titleA = uniq('A가 고침');
  const titleB = uniq('B가 나중에 고침');
  let dialog = await openEditor(a.page, original);
  await dialog.getByLabel('제목').fill(titleA);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(row(a.page, titleA)).toBeVisible();
  await a.page.waitForTimeout(100); // B 의 변경이 확실히 더 나중이 되게 한다
  dialog = await openEditor(b.page, original);
  await dialog.getByLabel('제목').fill(titleB);
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(row(b.page, titleB)).toBeVisible();

  await a.context.setOffline(false);
  await b.context.setOffline(false);
  for (const p of [a.page, b.page]) {
    await expect(row(p, titleB)).toBeVisible({ timeout: 30_000 });
    await expect(row(p, titleA)).toBeHidden({ timeout: 30_000 });
    await expect(row(p, original)).toBeHidden();
    await expect(p.locator('li.task .task-title', { hasText: titleB })).toHaveCount(1); // 중복 없음
  }
  await a.context.close();
  await b.context.close();
});

test('삭제한 할 일을 다른 기기가 오프라인에서 나중에 수정했다면 할 일이 남는다', async ({ browser }) => {
  const a = await newDevice(browser, 'A-맥');
  const b = await newDevice(browser, 'B-아이폰');
  const title = uniq('삭제 대 수정');
  await quickAdd(a.page, title);
  await expect(row(b.page, title)).toBeVisible({ timeout: 8000 });

  await b.context.setOffline(true);
  await row(a.page, title).getByRole('button', { name: `${title} 삭제`, exact: true }).click();
  await expect(row(a.page, title)).toBeHidden();
  await a.page.waitForTimeout(300);
  const revived = uniq('나중에 수정');
  const dialog = await openEditor(b.page, title);
  await dialog.getByLabel('제목').fill(revived);
  await dialog.getByRole('button', { name: '저장' }).click();
  await b.context.setOffline(false);

  await expect(row(a.page, revived)).toBeVisible({ timeout: 30_000 });
  await expect(row(b.page, revived)).toBeVisible({ timeout: 30_000 });
  await a.context.close();
  await b.context.close();
});

test('새로 등록한 기기는 기존 할 일을 모두 내려받는다', async ({ browser }) => {
  const a = await newDevice(browser, 'A-맥');
  const titles = [uniq('기존 1'), uniq('기존 2'), uniq('기존 3')];
  for (const t of titles) await quickAdd(a.page, t);
  await expect(syncStatus(a.page)).toContainText('동기화됨', { timeout: 15_000 });

  const c = await newDevice(browser, 'C-아이패드');
  for (const t of titles) await expect(row(c.page, t)).toBeVisible({ timeout: 10_000 });
  await a.context.close();
  await c.context.close();
});

test('등록하기 전에 만든 로컬 할 일은 등록하면 서버와 다른 기기로 올라간다', async ({ browser }) => {
  const b = await newDevice(browser, 'B-아이폰');
  const local = await newDevice(browser, 'unused', { pair: false });
  await expect(syncStatus(local.page)).toContainText('등록되지 않음');
  await expect(syncStatus(local.page).getByRole('link', { name: '등록하기' })).toBeVisible();
  const title = uniq('등록 전에 만든 것');
  await quickAdd(local.page, title); // 등록하지 않아도 로컬로 쓸 수 있다
  await expect(row(b.page, title)).toBeHidden();

  await pairThisDevice(local.page, 'D-신규');
  await local.page.goto('/#/today');
  await expect(row(local.page, title)).toBeVisible();
  await expect(row(b.page, title)).toBeVisible({ timeout: 10_000 });
  await b.context.close();
  await local.context.close();
});

test('V9 등록되지 않은 컨텍스트는 데이터를 읽거나 바꿀 수 없다', async ({ browser }) => {
  const context = await browser.newContext();
  const read = await context.request.get('/api/changes?since=0');
  expect(read.status()).toBe(401);
  const write = await context.request.post('/api/changes', { data: { changes: [] }, headers: { 'X-Todo-Client': '1' } });
  expect(write.status()).toBe(401);
  const events = await context.request.get('/api/events');
  expect(events.status()).toBe(401);
  await context.close();
});

test('기기를 해제하면 그 기기는 "등록 해제됨" 상태가 되고 로컬 데이터는 남는다', async ({ browser }) => {
  const a = await newDevice(browser, 'A-맥');
  const target = await newDevice(browser, 'E-해제될기기');
  const title = uniq('해제 전 데이터');
  await quickAdd(target.page, title);
  await expect(syncStatus(target.page)).toContainText('동기화됨', { timeout: 15_000 });
  const id = await deviceIdOf(target.page);
  cliRevoke(id);
  await expect(syncStatus(target.page)).toContainText('등록이 해제', { timeout: 30_000 });
  await expect(row(target.page, title)).toBeVisible(); // 로컬 데이터는 지우지 않는다
  await a.context.close();
  await target.context.close();
});
