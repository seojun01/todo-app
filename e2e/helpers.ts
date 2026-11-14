import { execFileSync } from 'node:child_process';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/** 기기의 시계를 고정된 시각에서 시작하게 하고 앱을 연다 (Asia/Seoul 기준) */
export async function openApp(page: Page, iso = '2026-11-12T09:00:00+09:00', hash = ''): Promise<void> {
  await page.clock.install({ time: new Date(iso) });
  await page.goto('/' + hash);
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
}

/** 빠른 추가 입력으로 할 일을 추가한다 */
export async function quickAdd(page: Page, title: string): Promise<void> {
  await page.getByRole('textbox', { name: '할 일 추가' }).fill(title);
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(row(page, title)).toBeVisible();
}

/** 제목으로 목록의 한 줄을 찾는다 */
export function row(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/** 제목으로 한 줄을 찾아 편집 시트를 연다 */
export async function openEditor(page: Page, title: string): Promise<Locator> {
  // 제목에 '수정'·'삭제' 같은 단어가 들어 있어도 헷갈리지 않게 접근 이름을 정확히 지정한다
  await row(page, title).getByRole('button', { name: `${title} 수정`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '할 일 수정' });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function navTo(page: Page, name: string): Promise<void> {
  const link = page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name, exact: true });
  await link.click();
  // 화면이 실제로 바뀔 때까지 기다린다 (전환 중에 입력을 시작하면 이전 화면에 들어갔다가 사라진다)
  await expect(link).toHaveAttribute('aria-current', 'page');
}

/** "완료됨" 영역이 접혀 있으면 펼친다 (펼침 상태는 다시 그려도 유지되므로 이미 열려 있으면 그대로 둔다) */
export async function expandCompleted(page: Page): Promise<Locator> {
  const details = page.locator('details.completed');
  await expect(details).toBeVisible();
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) await details.locator('summary').click();
  return details;
}

/** 서버 CLI 로 페어링 코드를 발급한다 (e2e 서버와 같은 DB 를 쓴다) */
export function cliPair(name: string): string {
  const out = execFileSync(process.execPath, ['--no-warnings', 'server/src/admin-cli.ts', 'pair', '--name', name], {
    env: { ...process.env, TODO_DB: process.env.E2E_DB! },
    encoding: 'utf8',
  });
  const m = /페어링 코드: (\S+)/.exec(out);
  if (!m) throw new Error(`페어링 코드를 읽을 수 없어요: ${out}`);
  return m[1]!;
}

export function cliRevoke(deviceId: string): void {
  execFileSync(process.execPath, ['--no-warnings', 'server/src/admin-cli.ts', 'revoke', deviceId], {
    env: { ...process.env, TODO_DB: process.env.E2E_DB! },
    encoding: 'utf8',
  });
}

/** 상태 표시줄 (동기화됨 / 대기 중 / 연결 안 됨 / 등록 안내) */
export function syncStatus(page: Page): Locator {
  return page.locator('.sync-status');
}

/** 등록 화면에서 페어링 코드를 입력해 이 기기를 등록한다 */
export async function pairThisDevice(page: Page, name: string): Promise<void> {
  await page.goto('/#/pair');
  await page.getByLabel('페어링 코드').fill(cliPair(name));
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(syncStatus(page)).toContainText('동기화됨', { timeout: 15_000 });
}

/** 새 브라우저 컨텍스트(= 새 기기)를 만들어 열고 등록한다 */
export async function newDevice(browser: Browser, name: string, opts: { pair?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
  if (opts.pair !== false) await pairThisDevice(page, name);
  await page.goto('/#/today');
  return { context, page };
}

/** 이 기기의 deviceId (IndexedDB meta) */
export async function deviceIdOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('todo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const q = open.result.transaction('meta').objectStore('meta').get('deviceId');
          q.onsuccess = () => resolve(q.result as string);
          q.onerror = () => reject(q.error);
        };
      }),
  );
}
