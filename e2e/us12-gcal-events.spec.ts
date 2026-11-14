import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navTo, openApp, pairThisDevice, quickAdd } from './helpers.ts';

// WebKit 은 서비스워커가 켜져 있으면 page.route 로 가로챈 응답이 앱에 닿지 않는다. 일정 API 를 흉내 내야 하므로 이 파일에서는 서비스워커를 막는다.
test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block' });
test.setTimeout(60_000);

// 고정 시계: 2026-11-12(목). 불러온 일정은 서버 응답을 흉내 낸다 (실제 구글 호출 없음)
const ev = (o: Record<string, unknown>) => ({
  calendarId: 'cal', calendarName: '내 일정', color: '#1a73e8', endDate: o.startDate, startTime: null, endTime: null, allDay: true, ...o,
});
const EVENTS = [
  ev({ id: 'cal:1', title: '치과', startDate: '2026-11-13', startTime: '13:00', endTime: '14:00', allDay: false }),
  ev({ id: 'cal:2', title: '휴가', startDate: '2026-11-13', endDate: '2026-11-14' }),
  ev({ id: 'cal:3', title: '아침 회의', startDate: '2026-11-12', startTime: '09:30', endTime: '10:00', allDay: false }),
  ev({ id: 'work:4', title: '출장', calendarId: 'work', calendarName: '업무', color: '#e8710a', startDate: '2026-11-13', endDate: '2026-11-15', startTime: '22:00', endTime: '02:00', allDay: false }),
];

/**
 * 다른 스펙이 서버에 남긴 할 일을 받아 오지도, 이 테스트의 할 일을 서버에 남기지도 않게 동기화 API 를 흉내 낸다.
 * (등록된 기기로 열면 서버의 모든 할 일이 내려오고, 이 파일은 날짜가 정해진 칸의 개수를 확인하기 때문이다)
 */
async function isolateSync(page: Page): Promise<void> {
  await page.route('**/api/changes**', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { changes: [], cursor: 0, hasMore: false } })
      : route.fulfill({ json: { applied: 0, ignored: 0, cursor: 0 } }),
  );
}

async function paired(page: Page, events: unknown[] = EVENTS): Promise<void> {
  await isolateSync(page);
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ json: { events } }));
  await openApp(page);
  await pairThisDevice(page, '일정 확인');
}
const section = (page: Page, heading: string): Locator => page.locator('section.day', { has: page.getByRole('heading', { level: 3, name: heading }) });
const cell = (page: Page, d: number): Locator => page.locator(`button[data-date="2026-11-${String(d).padStart(2, '0')}"]`);

test('시나리오 1: 오늘 화면 맨 위에 오늘의 구글 일정이 시각과 함께 보이고 읽기 전용이다', async ({ page }) => {
  await paired(page);
  await navTo(page, '오늘');
  const items = page.locator('ul.events li.event');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('아침 회의');
  await expect(items.first().locator('.event-time')).toHaveText('09:30–10:00');
  await expect(items.first()).toContainText('내 일정 일정'); // 어느 캘린더인지 (화면 낭독기용 글)
  await expect(items.first().getByRole('checkbox')).toHaveCount(0);
  await expect(items.first().getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('list', { name: '구글 캘린더 일정' })).toBeVisible();
});

test('시나리오 2: 예정 화면의 날짜 열에 일정이 종일 → 시각순으로 보이고, 여러 날 일정은 걸친 날마다 나온다', async ({ page }) => {
  await paired(page);
  await navTo(page, '예정');
  const labels = (heading: string) => section(page, heading).locator('li.event').evaluateAll((els) => els.map((e) => `${e.querySelector('.event-time')!.textContent} ${e.querySelector('.event-title')!.textContent}`));

  expect(await labels('11월 12일 목요일')).toEqual(['09:30–10:00 아침 회의']);
  // 13일: 종일(휴가) → 시각순(치과 13:00, 출장 22:00 시작)
  expect(await labels('11월 13일 금요일')).toEqual(['종일 휴가', '13:00–14:00 치과', '22:00~ 출장']);
  // 14일: 휴가(종일 2일째), 출장(여러 날의 가운데 날 = 종일)
  expect(await labels('11월 14일 토요일')).toEqual(['종일 출장', '종일 휴가']);
  // 일정이 있는 날은 "할 일 없음" 대신 일정이 보인다 (할 일이 없어도)
  await expect(section(page, '11월 13일 금요일').getByText('할 일 없음')).toBeHidden();
  // 일정은 할 일 개수에 세지 않는다
  await expect(section(page, '11월 13일 금요일').locator('.day-count')).toHaveText('0');
  // 다음 주 15일: 출장의 마지막 날
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(section(page, '11월 15일 일요일').locator('li.event .event-time')).toHaveText('~02:00');
  await expect(section(page, '11월 15일 일요일').locator('li.event .event-title')).toHaveText('출장');
});

test('시나리오 3: 일정과 할 일이 함께 보인다 (일정은 카드 위, 할 일 추가도 그대로)', async ({ page }) => {
  await paired(page);
  await navTo(page, '예정');
  await section(page, '11월 13일 금요일').getByRole('button', { name: /에 할 일 추가/ }).click();
  const group = section(page, '11월 13일 금요일');
  await group.getByRole('textbox', { name: '할 일 추가' }).fill('병원 서류');
  await group.getByRole('button', { name: '추가', exact: true }).click();
  await expect(group.locator('li.task', { hasText: '병원 서류' })).toBeVisible();
  await expect(group.locator('li.event')).toHaveCount(3);
  // 순서: 일정 목록이 할 일 목록보다 위
  const order = await group.locator('ul.events, ul.tasks').evaluateAll((els) => els.map((e) => e.className));
  expect(order[0]).toContain('events');
});

test('시나리오 4: 캘린더 칸에 일정이 시작 시각과 함께 미리보이고, 이름에 일정이 들어 있으며, 날짜를 고르면 목록이 나온다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await paired(page);
  await navTo(page, '캘린더');
  const items = cell(page, 13).locator('.cal-item.cal-event');
  await expect(items).toHaveText(['휴가', '13:00 치과', '22:00 출장']);
  await expect(cell(page, 13)).toHaveAccessibleName(/^13 일, 일정 3개: 휴가, 13:00 치과, 22:00 출장$/);
  await expect(cell(page, 13).locator('.cal-badge')).toHaveCount(0); // 남은 할 일 개수에는 세지 않는다
  await expect(cell(page, 12).locator('.cal-event')).toHaveText('09:30 아침 회의');
  await expect(cell(page, 14).locator('.cal-event')).toHaveText(['출장', '휴가']); // 이어지는 날에는 시각이 없다
  await expect(cell(page, 15).locator('.cal-event')).toHaveText('출장');

  await cell(page, 13).click();
  const group = page.locator('.event-group');
  await expect(group.getByRole('heading', { level: 4, name: '구글 캘린더 일정' })).toBeVisible();
  await expect(group.locator('li.event')).toHaveCount(3);
  await expect(group.locator('li.event').first()).toContainText('종일');
  await expect(page.getByText('이 날은 할 일이 없어요')).toBeVisible(); // 일정만 있고 할 일은 없다
});

test('시나리오 5: 칸의 세 줄을 일정이 먼저 쓰고 할 일은 남는 자리만, 나머지는 +N개로 센다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await paired(page);
  await navTo(page, '캘린더');
  await cell(page, 13).click();
  await expect(page.getByRole('heading', { level: 3, name: '11월 13일 금요일' })).toBeVisible(); // 다시 그려진 뒤에 입력한다
  await quickAdd(page, '병원 서류');
  await expect(cell(page, 13).locator('.cal-item')).toHaveCount(3); // 일정 3개가 세 줄을 다 쓴다
  await expect(cell(page, 13).locator('.cal-more')).toHaveText('+1개');
  await expect(cell(page, 13)).toHaveAccessibleName(/일정 3개: .+, 남은 할 일 1개: 병원 서류$/);
  // 일정이 적은 날은 할 일이 같이 보인다
  await cell(page, 12).click();
  await expect(page.getByRole('heading', { level: 3, name: '11월 12일 목요일' })).toBeVisible();
  await quickAdd(page, '오늘 할 일');
  await expect(cell(page, 12).locator('.cal-item')).toHaveText(['09:30 아침 회의', '오늘 할 일']);
});

test('시나리오 6: 서버가 오류를 내도 할 일 화면은 멀쩡하고 일정만 비어 있다', async ({ page }) => {
  await isolateSync(page);
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ status: 500, json: { error: 'internal' } }));
  await openApp(page);
  await pairThisDevice(page, '오류 확인');
  await navTo(page, '오늘');
  await quickAdd(page, '평소처럼 추가');
  await expect(page.locator('li.event')).toHaveCount(0);
  await navTo(page, '예정');
  await expect(page.locator('section.day')).toHaveCount(3);
  await navTo(page, '캘린더');
  await expect(page.locator('.cal-event')).toHaveCount(0);
});

test('시나리오 7: 홈서버에 등록하지 않은 기기는 일정 API 를 부르지 않는다', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/gcal/')) requested.push(r.url());
  });
  await openApp(page); // 등록하지 않음
  await navTo(page, '예정');
  await navTo(page, '캘린더');
  await navTo(page, '오늘');
  expect(requested).toEqual([]);
});

const storedCount = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('todo.gcal-events')).length);

test('시나리오 8: 서버에 닿지 못해도 새로고침한 뒤에 마지막으로 받은 일정이 그대로 보인다 (오프라인)', async ({ page }) => {
  await paired(page);
  await navTo(page, '예정');
  await expect(section(page, '11월 13일 금요일').locator('li.event')).toHaveCount(3);
  expect(await storedCount(page)).toBeGreaterThan(0); // 기기에 보관했다

  // 이제 일정 API 가 막힌다 (오프라인·서버 꺼짐). 새로 열어도 마지막으로 받은 일정이 보인다.
  await page.unroute('**/api/gcal/events**');
  await page.route('**/api/gcal/events**', (route) => route.abort());
  await page.reload();
  await expect(page.locator('section.day').first()).toBeVisible();
  await expect(section(page, '11월 13일 금요일').locator('li.event')).toHaveCount(3);
  await expect(section(page, '11월 13일 금요일').locator('li.event .event-title').first()).toHaveText('휴가');
  // 보관해 둔 적 없는 범위(다음 주)는 비어 있다
  await page.getByRole('button', { name: '다음 주' }).click();
  await expect(section(page, '11월 15일 일요일').locator('li.event')).toHaveCount(0); // 이 범위는 받은 적이 없으니 오프라인에서는 비어 있다 (엉뚱한 일정이 끼지 않는다)
});

test('시나리오 9: 서버가 "등록 안 된 기기"(401)로 답하면 보관해 둔 일정도 지운다', async ({ page }) => {
  await paired(page);
  await navTo(page, '예정');
  await expect(section(page, '11월 13일 금요일').locator('li.event')).toHaveCount(3);
  expect(await storedCount(page)).toBeGreaterThan(0);

  await page.unroute('**/api/gcal/events**');
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.reload();
  await expect(page.locator('section.day').first()).toBeVisible();
  await expect(page.locator('li.event')).toHaveCount(0);
  await expect.poll(() => storedCount(page)).toBe(0);
});

test('시나리오 10: 서버가 "빈 목록"으로 답하면(불러오기를 껐을 때) 보관해 둔 일정이 오프라인에서 되살아나지 않는다', async ({ page }) => {
  await paired(page);
  await navTo(page, '예정');
  await expect(section(page, '11월 13일 금요일').locator('li.event')).toHaveCount(3);

  await page.unroute('**/api/gcal/events**');
  await page.route('**/api/gcal/events**', (route) => route.fulfill({ json: { events: [] } }));
  await page.reload();
  await expect(page.locator('section.day').first()).toBeVisible();
  await expect(page.locator('li.event')).toHaveCount(0);

  await page.unroute('**/api/gcal/events**');
  await page.route('**/api/gcal/events**', (route) => route.abort()); // 그 뒤 오프라인
  await page.reload();
  await expect(page.locator('section.day').first()).toBeVisible();
  await expect(page.locator('li.event')).toHaveCount(0);
});

test('일정이 있는 화면(오늘·예정·캘린더)에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await paired(page);
  const check = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  };
  await navTo(page, '오늘');
  await expect(page.locator('li.event')).toHaveCount(1);
  await check();
  await navTo(page, '예정');
  await expect(section(page, '11월 13일 금요일').locator('li.event')).toHaveCount(3);
  await check();
  await navTo(page, '캘린더');
  await cell(page, 13).click();
  await expect(page.locator('.event-group li.event')).toHaveCount(3);
  await check();
});

// ── 설정: 일정 불러오기 ──

interface ImportState {
  available: boolean;
  enabled: boolean;
  calendars: { id: string; name: string; color: string | null; selected: boolean; primary: boolean }[];
  lastImportAt: string | null;
  lastError: string | null;
}

async function mockSettings(page: Page, state: ImportState): Promise<{ posts: { path: string; body: unknown }[] }> {
  const posts: { path: string; body: unknown }[] = [];
  await isolateSync(page);
  await page.route('**/api/gcal/status', (route) => route.fulfill({ json: { configured: true, connected: true, needsReauth: false, lastSyncAt: null, lastError: null, pending: 0 } }));
  await page.route('**/api/gcal/import', (route) => route.fulfill({ json: state }));
  await page.route('**/api/gcal/import/settings', async (route) => {
    const body = route.request().postDataJSON() as { enabled?: boolean; calendars?: string[] };
    posts.push({ path: 'settings', body });
    if (body.enabled !== undefined) state.enabled = body.enabled;
    if (body.calendars) for (const c of state.calendars) c.selected = body.calendars.includes(c.id);
    await route.fulfill({ json: state });
  });
  await page.route('**/api/gcal/import/refresh', async (route) => {
    posts.push({ path: 'refresh', body: null });
    state.lastImportAt = '2026-11-12T00:30:00.000Z';
    await route.fulfill({ json: state });
  });
  await page.route('**/api/gcal/connect', async (route) => {
    posts.push({ path: 'connect', body: route.request().postDataJSON() });
    await route.fulfill({ json: { url: '/#/settings' } });
  });
  return { posts };
}
const importBox = (page: Page): Locator => page.getByRole('group', { name: '일정 불러오기' });

test('설정 1: 읽기 권한이 없으면 안내와 "일정 불러오기 켜기"만 있고, 누르면 읽기 권한을 포함해 연결을 요청한다', async ({ page }) => {
  const { posts } = await mockSettings(page, { available: false, enabled: false, calendars: [], lastImportAt: null, lastError: null });
  await openApp(page);
  await pairThisDevice(page, '설정 확인');
  await navTo(page, '설정');
  const box = importBox(page);
  await expect(box.getByText('제목과 시각만 가져오고')).toBeVisible();
  await expect(box.getByText('읽기 권한을 한 번 더 허용')).toBeVisible();
  await expect(box.getByRole('checkbox')).toHaveCount(0);
  await box.getByRole('button', { name: '일정 불러오기 켜기' }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({ path: 'connect', body: { import: true } });
});

test('설정 2: 켜기/끄기, 불러올 캘린더 선택, 지금 불러오기, 오류 표시', async ({ page }) => {
  const { posts } = await mockSettings(page, {
    available: true,
    enabled: true,
    calendars: [
      { id: 'me', name: '내 일정', color: '#1a73e8', selected: true, primary: true },
      { id: 'work', name: '업무', color: '#e8710a', selected: false, primary: false },
    ],
    lastImportAt: null,
    lastError: '구글 캘린더 응답 오류 (HTTP 503)',
  });
  await openApp(page);
  await pairThisDevice(page, '설정 확인');
  await navTo(page, '설정');
  const box = importBox(page);
  await expect(box.getByLabel('구글 캘린더 일정을 이 앱에 표시')).toBeChecked();
  await expect(box.getByLabel('내 일정 (기본)')).toBeChecked();
  await expect(box.getByLabel('업무')).not.toBeChecked();
  await expect(box.getByRole('status')).toHaveText('구글 캘린더 응답 오류 (HTTP 503)');

  await box.getByLabel('업무').check();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({ path: 'settings', body: { calendars: ['me', 'work'] } });
  await expect(box.getByLabel('업무')).toBeChecked();

  await box.getByLabel('내 일정 (기본)').uncheck();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ path: 'settings', body: { calendars: ['work'] } });

  await box.getByRole('button', { name: '지금 불러오기' }).click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]!.path).toBe('refresh');
  await expect(box.getByText(/마지막으로 불러온 때: (?!아직)/)).toBeVisible();

  await box.getByLabel('구글 캘린더 일정을 이 앱에 표시').uncheck();
  await expect.poll(() => posts.length).toBe(4);
  expect(posts[3]).toEqual({ path: 'settings', body: { enabled: false } });
  await expect(box.getByRole('group', { name: '불러올 캘린더' })).toHaveCount(0); // 끄면 캘린더 선택은 숨는다
  await expect(box.getByRole('button', { name: '지금 불러오기' })).toHaveCount(0);
});

test('설정 3: 불러오기 설정 화면에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
  await mockSettings(page, {
    available: true,
    enabled: true,
    calendars: [{ id: 'me', name: '내 일정', color: '#1a73e8', selected: true, primary: true }],
    lastImportAt: '2026-11-12T00:30:00.000Z',
    lastError: '일부 오류',
  });
  await openApp(page);
  await pairThisDevice(page, '설정 확인');
  await navTo(page, '설정');
  await expect(importBox(page).getByLabel('내 일정 (기본)')).toBeVisible();
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
