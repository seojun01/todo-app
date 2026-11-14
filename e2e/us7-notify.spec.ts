import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navTo, openApp, openEditor, pairThisDevice, quickAdd, row } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

// 알림 권한·푸시 구독은 브라우저가 실제로 하기 어려우므로 흉내 낸다. 서버 API 도 흉내 내서 다른 스펙의 데이터와 섞이지 않게 한다.
// (WebKit 은 서비스 워커가 켜져 있으면 page.route 응답이 앱에 닿지 않으므로 서비스 워커는 막는다.)
const SERVER_KEY = Buffer.alloc(65, 7).toString('base64url');

interface PushStub {
  permission: NotificationPermission;
  grantOnRequest: NotificationPermission;
  subscribeCalls: { userVisibleOnly: boolean }[];
  requested: number;
  sub: unknown;
}
declare global {
  interface Window {
    __push: PushStub;
  }
}

async function stubBrowser(page: Page, opts: { permission?: NotificationPermission; grantOnRequest?: NotificationPermission; subscribed?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ permission, grantOnRequest, serverKey, subscribed }) => {
      const state = { permission, grantOnRequest, subscribeCalls: [] as { userVisibleOnly: boolean }[], requested: 0, sub: null as unknown };
      window.__push = state as never;
      class FakeNotification {
        static get permission() {
          return state.permission;
        }
        static async requestPermission() {
          state.requested++;
          state.permission = state.grantOnRequest;
          return state.permission;
        }
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
      if (!('PushManager' in window)) (window as unknown as { PushManager: unknown }).PushManager = class {};
      const b64u = (n: number, fill: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(fill))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const manager = {
        getSubscription: async () => state.sub,
        subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
          state.subscribeCalls.push({ userVisibleOnly: o.userVisibleOnly });
          const sub = {
            endpoint: `https://web.push.apple.com/e2e-${Math.random().toString(36).slice(2)}`,
            options: { applicationServerKey: o.applicationServerKey.buffer.slice(o.applicationServerKey.byteOffset, o.applicationServerKey.byteOffset + o.applicationServerKey.byteLength) },
            toJSON() {
              return { endpoint: sub.endpoint, keys: { p256dh: b64u(65, 1), auth: b64u(16, 2) } };
            },
            unsubscribe: async () => ((state.sub = null), true),
          };
          state.sub = sub;
          return sub;
        },
      };
      if (subscribed) {
        // 이미 구독된 기기로 시작한다 (새로고침해도 유지되도록 처음부터 만든다)
        const key = Uint8Array.from(atob(serverKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(serverKey.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
        void manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        state.subscribeCalls.length = 0;
      }
      const reg = { pushManager: manager };
      Object.defineProperty(navigator.serviceWorker, 'getRegistration', { value: async () => reg, configurable: true });
      Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg), configurable: true });
      void serverKey;
    },
    { permission: opts.permission ?? 'default', grantOnRequest: opts.grantOnRequest ?? 'granted', serverKey: SERVER_KEY, subscribed: opts.subscribed ?? false },
  );
}

interface ServerState {
  push: { subscribed: boolean; enabled: boolean; timezone: string | null };
  puts: unknown[];
  tests: number;
  /** GET /api/changes(pull) 횟수 */
  pulls: number;
  testStatus: number;
  testError: string;
}

async function mockServer(page: Page): Promise<ServerState> {
  const st: ServerState = { push: { subscribed: false, enabled: false, timezone: null }, puts: [], tests: 0, pulls: 0, testStatus: 200, testError: '' };
  await page.route('**/api/changes**', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: { applied: 0, ignored: 0, cursor: 0 } });
    st.pulls++;
    return route.fulfill({ json: { changes: [], cursor: 0, hasMore: false } });
  });
  await page.route('**/api/devices/me', (route) => route.fulfill({ json: { deviceId: 'e2e', deviceName: 'e2e 기기', createdAt: '2026-11-12T00:00:00.000Z', push: st.push } }));
  await page.route('**/api/devices/me/push', (route) => {
    const body = route.request().postDataJSON() as { subscription?: unknown; enabled?: boolean; timezone?: string };
    st.puts.push(body);
    st.push = { subscribed: body.subscription !== undefined || st.push.subscribed, enabled: body.enabled ?? (body.subscription !== undefined ? true : st.push.enabled), timezone: body.timezone ?? st.push.timezone };
    return route.fulfill({ json: st.push });
  });
  await page.route('**/api/push/key', (route) => route.fulfill({ json: { publicKey: SERVER_KEY } }));
  await page.route('**/api/push/test', (route) => {
    st.tests++;
    return st.testStatus === 200 ? route.fulfill({ json: { sent: true } }) : route.fulfill({ status: st.testStatus, json: { error: st.testError } });
  });
  return st;
}

async function save(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog).toBeHidden();
}
const notifyBox = (page: Page): Locator => page.getByRole('region', { name: '알림' });
const toggle = (page: Page): Locator => page.getByLabel('이 기기에서 알림 받기');
async function openSettings(page: Page): Promise<void> {
  await openApp(page);
  await pairThisDevice(page, '알림 확인');
  await navTo(page, '설정');
  await expect(notifyBox(page)).toBeVisible();
}

test.describe('설정: 이 기기에서 알림 받기', () => {
  test.use({ serviceWorkers: 'block' });

  test('홈서버에 등록하지 않은 기기는 스위치를 쓸 수 없고 등록 안내가 나온다', async ({ page }) => {
    await stubBrowser(page);
    await openApp(page);
    await navTo(page, '설정');
    await expect(toggle(page)).toBeDisabled();
    await expect(page.getByText('알림은 홈서버가 보내요. 먼저 이 기기를 홈서버에 등록해 주세요.')).toBeVisible();
    await expect(notifyBox(page).getByRole('link', { name: '이 기기 등록하기' })).toBeVisible();
  });

  test('켜기: 권한을 묻고 → 구독하고 → 서버에 등록하면 "켜져 있어요"와 테스트 알림 버튼이 나온다', async ({ page }) => {
    await stubBrowser(page);
    const st = await mockServer(page);
    await openSettings(page);
    await expect(toggle(page)).toBeEnabled();
    await expect(toggle(page)).not.toBeChecked();
    await expect(page.getByText('알림 문구에는 할 일 제목이 들어가지 않아요')).toBeVisible();

    await toggle(page).check();
    await expect(page.getByText('이 기기의 알림을 켰어요')).toBeVisible();
    await expect(page.getByText('알림이 켜져 있어요. 시간대는 Asia/Seoul예요.')).toBeVisible();
    await expect(toggle(page)).toBeChecked();
    const put = st.puts[0] as { subscription: { endpoint: string; keys: unknown }; timezone: string; enabled: boolean };
    expect(put.enabled).toBe(true);
    expect(put.timezone).toBe('Asia/Seoul');
    expect(put.subscription.endpoint).toMatch(/^https:\/\/web\.push\.apple\.com\/e2e-/);
    expect(await page.evaluate(() => window.__push.requested)).toBe(1);
    expect(await page.evaluate(() => window.__push.subscribeCalls)).toEqual([{ userVisibleOnly: true }]);
    await expect(page.getByRole('button', { name: '테스트 알림 보내기' })).toBeVisible();
  });

  test('테스트 알림: 보내면 안내가 나오고, 서버가 실패하면 이유를 알려 준다', async ({ page }) => {
    await stubBrowser(page, { permission: 'granted', subscribed: true });
    const st = await mockServer(page);
    st.push = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
    await openSettings(page);
    const send = page.getByRole('button', { name: '테스트 알림 보내기' });
    await expect(send).toBeVisible();
    await send.click();
    await expect(page.getByText('테스트 알림을 보냈어요. 잠시 뒤 알림이 와요.')).toBeVisible();
    expect(st.tests).toBe(1);
    st.testStatus = 502;
    st.testError = 'push_failed';
    await send.click();
    await expect(page.getByText('서버가 알림을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.')).toBeVisible();
  });

  test('끄기: 서버에 enabled=false 를 보내고 스위치가 꺼진다 (구독은 그대로)', async ({ page }) => {
    await stubBrowser(page);
    const st = await mockServer(page);
    await openSettings(page);
    await toggle(page).check();
    await expect(toggle(page)).toBeChecked();
    await toggle(page).uncheck();
    await expect(page.getByText('이 기기의 알림을 껐어요')).toBeVisible();
    await expect(toggle(page)).not.toBeChecked();
    expect(st.puts.at(-1)).toEqual({ enabled: false });
    expect(st.push).toEqual({ subscribed: true, enabled: false, timezone: 'Asia/Seoul' });
    await expect(page.getByRole('button', { name: '테스트 알림 보내기' })).toHaveCount(0);
  });

  test('권한 창에서 거부하면 안내가 나오고 스위치는 꺼진 채로 남으며 서버에는 아무것도 등록하지 않는다', async ({ page }) => {
    await stubBrowser(page, { grantOnRequest: 'denied' });
    const st = await mockServer(page);
    await openSettings(page);
    await toggle(page).check();
    await expect(page.getByText('알림 권한이 허용되지 않았어요.', { exact: false })).toBeVisible();
    await expect(page.getByText('이 기기는 알림이 차단돼 있어요.', { exact: false })).toBeVisible();
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeDisabled(); // 차단된 상태에서는 켤 수 없다
    expect(st.puts).toEqual([]);
    expect(await page.evaluate(() => window.__push.subscribeCalls.length)).toBe(0);
  });

  test('이미 차단된 기기는 해결 방법을 안내하고 스위치를 쓸 수 없다', async ({ page }) => {
    await stubBrowser(page, { permission: 'denied' });
    await mockServer(page);
    await openSettings(page);
    await expect(toggle(page)).toBeDisabled();
    await expect(page.getByText('브라우저(또는 기기 설정)에서 이 사이트의 알림을 허용한 뒤 다시 켜세요.')).toBeVisible();
  });

  test('홈서버에 닿지 않으면 상태를 확인하지 못했다고 알린다', async ({ page }) => {
    await stubBrowser(page);
    await mockServer(page);
    await openApp(page);
    await pairThisDevice(page, '오프라인 확인');
    await page.route('**/api/devices/me', (route) => route.abort());
    await navTo(page, '설정');
    await expect(page.getByText('홈서버에 닿지 못해 알림 상태를 확인하지 못했어요.')).toBeVisible();
    await expect(toggle(page)).toBeDisabled();
  });

  test.describe('iPhone(홈 화면에 설치하지 않음)', () => {
    test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 800 } });
    test('"홈 화면에 추가" 안내가 나온다', async ({ page }) => {
      await stubBrowser(page);
      await openApp(page);
      await navTo(page, '설정');
      await expect(page.getByText("iPhone·iPad에서는 Safari의 공유 버튼에서 '홈 화면에 추가'로 설치한 뒤, 설치한 앱에서 알림을 켤 수 있어요.")).toBeVisible();
      await expect(toggle(page)).toBeDisabled();
    });
  });

  test('접근성: 알림 영역(꺼짐·켜짐·차단)에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
    await stubBrowser(page);
    await mockServer(page);
    await openSettings(page);
    const check = async () => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    };
    await check();
    await toggle(page).check();
    await expect(page.getByRole('button', { name: '테스트 알림 보내기' })).toBeVisible();
    await check();
  });
});

test.describe('편집 시트: 이 기기에서 알림이 울리지 않으면 알려 준다', () => {
  test.use({ serviceWorkers: 'block' });

  test('알림을 골랐는데 이 기기의 알림이 꺼져 있으면 안내하고, 켜져 있으면 안내가 없다', async ({ page }) => {
    await stubBrowser(page);
    const st = await mockServer(page);
    await openApp(page);
    await pairThisDevice(page, '편집 확인');
    await navTo(page, '오늘');
    await quickAdd(page, '약 먹기');
    let dialog = await openEditor(page, '약 먹기');
    await dialog.getByLabel('기한', { exact: true }).fill('2026-11-20'); // 하루 전(11/19)이 아직 오지 않은 날짜
    const status = dialog.getByRole('group', { name: '알림' }).getByRole('status');
    await expect(status).toBeHidden(); // 알림을 고르기 전에는 말이 없다
    await dialog.getByRole('checkbox', { name: '하루 전' }).check();
    await expect(status).toContainText('이 기기의 알림이 꺼져 있어서 알림이 울리지 않아요. 설정에서 알림을 켜세요.');
    await dialog.getByRole('checkbox', { name: '하루 전' }).uncheck();
    await expect(status).toBeHidden();
    await save(dialog); // 기한을 11/20 으로 바꿔 저장한다 (다음에 열 때도 하루 전이 아직 오지 않은 날짜)

    // 알림을 켠 뒤에는 안내가 없다
    await navTo(page, '설정');
    await toggle(page).check();
    await expect(page.getByRole('button', { name: '테스트 알림 보내기' })).toBeVisible();
    expect(st.push.enabled).toBe(true);
    await navTo(page, '예정');
    await page.getByRole('button', { name: '다음 주' }).click(); // 11/15 ~ 11/21 에 기한 11/20 이 있다
    dialog = await openEditor(page, '약 먹기');
    await dialog.getByRole('checkbox', { name: '하루 전' }).check();
    await expect(dialog.getByRole('group', { name: '알림' }).getByRole('status')).toBeHidden();
  });

  test('등록하지 않은 기기는 "홈서버에 등록한 기기에서만 알림이 울려요"라고 알려 준다', async ({ page }) => {
    await stubBrowser(page);
    await openApp(page);
    await quickAdd(page, '로컬 할 일');
    const dialog = await openEditor(page, '로컬 할 일');
    await dialog.getByRole('checkbox', { name: '하루 전' }).check();
    await expect(dialog.getByRole('group', { name: '알림' }).getByRole('status')).toContainText('홈서버에 등록한 기기에서만 알림이 울려요.');
  });
});

test.describe('알림을 눌러 열린 앱: 해당 할 일 화면', () => {
  test.use({ serviceWorkers: 'block' });
  const idOf = async (page: Page, title: string) => ((await row(page, title).getAttribute('data-key')) ?? '').replace('task:', '');

  test('/?task=<id> 로 열면 그 할 일이 보이는 화면으로 가고 주소의 query 는 정리된다, 완료도 할 수 있다', async ({ page }) => {
    await openApp(page);
    await quickAdd(page, '병원 예약');
    const id = await idOf(page, '병원 예약');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await page.goto(`/?task=${id}`);
    await expect(page.getByRole('heading', { level: 2, name: '할 일' })).toBeVisible();
    await expect(row(page, '병원 예약')).toBeVisible();
    await expect(page.getByText('알림이 온 할 일')).toBeVisible();
    expect(page.url()).toBe(`http://localhost:8080/#/task/${id}`);
    await row(page, '병원 예약').getByRole('checkbox').click();
    await expect(page.getByText('이미 끝낸 할 일이에요')).toBeVisible();
    await expect(page.getByRole('link', { name: '오늘 화면으로 가기' })).toBeVisible();
  });

  test('없는 할 일·삭제한 할 일은 찾을 수 없다고 안내한다', async ({ page }) => {
    await openApp(page);
    await page.goto('/?task=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { level: 2, name: '할 일을 찾을 수 없어요' })).toBeVisible();
    await expect(page.getByText('삭제되었거나 아직 이 기기로 전달되지 않은 할 일이에요.')).toBeVisible();

    await page.goto('/#/today');
    await quickAdd(page, '곧 삭제');
    const id = await idOf(page, '곧 삭제');
    await row(page, '곧 삭제').getByRole('button', { name: '곧 삭제 삭제' }).click();
    await expect(row(page, '곧 삭제')).toBeHidden(); // 삭제가 저장된 뒤에 이동한다
    await page.goto(`/?task=${id}`);
    await expect(page.getByRole('heading', { level: 2, name: '할 일을 찾을 수 없어요' })).toBeVisible();
  });

  test('등록된 기기에서 이 기기에 없는 할 일을 열면 한 번만 동기화해 찾고, 화면 그리기와 동기화가 끝없이 반복되지 않는다', async ({ page }) => {
    await stubBrowser(page);
    const st = await mockServer(page);
    await openApp(page);
    await pairThisDevice(page, '찾기 확인');
    await page.goto('/?task=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { level: 2, name: '할 일을 찾을 수 없어요' })).toBeVisible();
    await expect(page.getByText('삭제되었거나 아직 이 기기로 전달되지 않은 할 일이에요.')).toBeVisible(); // 찾고 난 뒤의 최종 안내
    const settled = st.pulls;
    await page.waitForTimeout(1500);
    expect(st.pulls - settled, '1.5초 동안 동기화가 더 일어나지 않는다').toBeLessThanOrEqual(1);
  });

  test('할 일 화면에 WCAG 2.1 AA 위반이 없다', async ({ page }) => {
    await openApp(page);
    await quickAdd(page, '접근성');
    const id = await idOf(page, '접근성');
    await page.goto(`/#/task/${id}`);
    await expect(row(page, '접근성')).toBeVisible();
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
});
