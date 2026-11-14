import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotify, editorNotice, support, type NotifyEnv } from '../../src/notify.ts';

const SERVER_KEY = Buffer.alloc(65, 7).toString('base64url');
const OTHER_KEY = Buffer.alloc(65, 9).toString('base64url');
const keyBytes = (b64u: string): ArrayBuffer => Uint8Array.from(Buffer.from(b64u, 'base64url')).buffer as ArrayBuffer;

interface Call {
  path: string;
  method: string;
  body: unknown;
  csrf: string | undefined;
}

/** 브라우저와 서버를 흉내 낸 환경. 구독·권한·서버 응답을 바꿔 가며 쓴다 */
function makeEnv(over: Partial<NotifyEnv> = {}) {
  const calls: Call[] = [];
  const st = {
    permission: 'default' as NotificationPermission,
    grantOnRequest: 'granted' as NotificationPermission,
    sub: null as null | { endpoint: string; key: ArrayBuffer | null; unsubscribed: boolean },
    subscribeCalls: [] as { userVisibleOnly: boolean; key: Uint8Array }[],
    serverPush: { subscribed: false, enabled: false, timezone: null as string | null },
    routes: {} as Record<string, () => Response | Promise<Response>>,
    online: true,
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchFake: typeof fetch = async (input, init) => {
    if (!st.online) throw new TypeError('offline');
    const path = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: headers['X-Todo-Client'] });
    const key = `${method} ${path}`;
    if (st.routes[key]) return st.routes[key]!();
    if (key === 'GET /api/devices/me') return json({ push: st.serverPush });
    if (key === 'GET /api/push/key') return json({ publicKey: SERVER_KEY });
    if (key === 'PUT /api/devices/me/push') {
      const b = JSON.parse(String(init!.body)) as { subscription?: unknown; enabled?: boolean; timezone?: string };
      st.serverPush = { subscribed: b.subscription !== undefined || st.serverPush.subscribed, enabled: b.enabled ?? st.serverPush.enabled, timezone: b.timezone ?? st.serverPush.timezone };
      return json(st.serverPush);
    }
    if (key === 'POST /api/push/test') return json({ sent: true });
    return json({ error: 'unexpected' }, 500);
  };
  const reg = {
    pushManager: {
      getSubscription: async () => (st.sub && !st.sub.unsubscribed ? subObj(st.sub) : null),
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        st.subscribeCalls.push({ userVisibleOnly: o.userVisibleOnly, key: o.applicationServerKey });
        st.sub = { endpoint: 'https://web.push.apple.com/new-sub', key: o.applicationServerKey.buffer.slice(o.applicationServerKey.byteOffset, o.applicationServerKey.byteOffset + o.applicationServerKey.byteLength) as ArrayBuffer, unsubscribed: false };
        return subObj(st.sub);
      },
    },
  };
  function subObj(s: NonNullable<typeof st.sub>) {
    return {
      endpoint: s.endpoint,
      options: { applicationServerKey: s.key },
      toJSON: () => ({ endpoint: s.endpoint, keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }),
      unsubscribe: async () => ((s.unsubscribed = true), true),
    };
  }
  const env: NotifyEnv = {
    notification: {
      get permission() {
        return st.permission;
      },
      requestPermission: async () => ((st.permission = st.grantOnRequest), st.permission),
    },
    registration: async () => reg,
    hasPushManager: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 0,
    standalone: false,
    fetch: fetchFake,
    timeZone: 'Asia/Seoul',
    readyTimeoutMs: 30,
    ...over,
  };
  return { env, st, calls, json };
}
const paired = (v = true) => async () => v;

test('지원 여부: 데스크톱은 PushManager·Notification·서비스 워커가 다 있어야 하고, iOS 는 홈 화면에 설치해야 한다', () => {
  const { env } = makeEnv();
  assert.equal(support(env), 'ok');
  assert.equal(support({ ...env, hasPushManager: false }), 'unsupported');
  assert.equal(support({ ...env, notification: undefined }), 'unsupported');
  assert.equal(support({ ...env, registration: undefined }), 'unsupported');
  const iphone = { ...env, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
  assert.equal(support({ ...iphone, hasPushManager: false }), 'needs-install', '설치 전의 iPhone 은 PushManager 가 없다');
  assert.equal(support(iphone), 'needs-install', 'PushManager 가 있어도 설치하지 않았으면 안내한다');
  assert.equal(support({ ...iphone, standalone: true }), 'ok');
  // 데스크톱 모드로 사이트를 요청하는 iPad: 맥처럼 보이지만 터치가 있다
  const ipad = { ...env, platform: 'MacIntel', maxTouchPoints: 5 };
  assert.equal(support(ipad), 'needs-install');
  assert.equal(support({ ...ipad, standalone: true }), 'ok');
});

test('상태: 지원 안 함·설치 필요·등록 안 함·권한 거부·서버에 닿지 않음', async () => {
  assert.deepEqual(await createNotify(paired(), makeEnv({ hasPushManager: false }).env).state(), { kind: 'unsupported' });
  assert.deepEqual(await createNotify(paired(), makeEnv({ userAgent: 'iPhone', platform: 'iPhone' }).env).state(), { kind: 'needs-install' });
  assert.deepEqual(await createNotify(paired(false), makeEnv().env).state(), { kind: 'unpaired' });
  const denied = makeEnv();
  denied.st.permission = 'denied';
  assert.deepEqual(await createNotify(paired(), denied.env).state(), { kind: 'denied' });
  const offline = makeEnv();
  offline.st.online = false;
  assert.deepEqual(await createNotify(paired(), offline.env).state(), { kind: 'offline' });
  const unauthorized = makeEnv();
  unauthorized.st.routes['GET /api/devices/me'] = () => new Response('{}', { status: 401 });
  assert.deepEqual(await createNotify(paired(), unauthorized.env).state(), { kind: 'unpaired' });
  const serverDown = makeEnv();
  serverDown.st.routes['GET /api/devices/me'] = () => new Response('{}', { status: 500 });
  assert.deepEqual(await createNotify(paired(), serverDown.env).state(), { kind: 'offline' });
});

test('상태: 켜짐은 권한 허용 + 서버에 구독·켜짐 + 이 기기의 구독이 모두 있을 때만, 하나라도 없으면 꺼짐', async () => {
  const on = makeEnv();
  on.st.permission = 'granted';
  on.st.sub = { endpoint: 'https://web.push.apple.com/a', key: keyBytes(SERVER_KEY), unsubscribed: false };
  on.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
  assert.deepEqual(await createNotify(paired(), on.env).state(), { kind: 'on', timezone: 'Asia/Seoul' });

  for (const mutate of [
    (m: ReturnType<typeof makeEnv>) => (m.st.permission = 'default'),
    (m: ReturnType<typeof makeEnv>) => (m.st.serverPush.enabled = false),
    (m: ReturnType<typeof makeEnv>) => (m.st.serverPush.subscribed = false),
    (m: ReturnType<typeof makeEnv>) => (m.st.sub = null),
  ]) {
    const m = makeEnv();
    m.st.permission = 'granted';
    m.st.sub = { endpoint: 'https://web.push.apple.com/a', key: keyBytes(SERVER_KEY), unsubscribed: false };
    m.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
    mutate(m);
    assert.deepEqual(await createNotify(paired(), m.env).state(), { kind: 'off' });
  }
  // 서비스 워커가 준비되지 않으면(등록 안 됨) 이 기기는 구독할 수 없다
  const noSw = makeEnv({ registration: () => new Promise(() => undefined) });
  noSw.st.permission = 'granted';
  assert.deepEqual(await createNotify(paired(), noSw.env).state(), { kind: 'unsupported' });
});

test('켜기: 권한을 요청하고 → 서버 공개키로 구독하고 → 구독·시간대·enabled 를 서버에 등록한다', async () => {
  const m = makeEnv();
  const r = await createNotify(paired(), m.env).enable();
  assert.deepEqual(r, { ok: true });
  assert.equal(m.st.permission, 'granted', '권한을 요청했다');
  assert.equal(m.st.subscribeCalls.length, 1);
  assert.equal(m.st.subscribeCalls[0]!.userVisibleOnly, true, 'userVisibleOnly');
  assert.equal(Buffer.from(m.st.subscribeCalls[0]!.key).toString('base64url'), SERVER_KEY, '서버 공개키가 applicationServerKey 다');
  const put = m.calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.path, '/api/devices/me/push');
  assert.equal(put.csrf, '1');
  assert.deepEqual(put.body, {
    subscription: { endpoint: 'https://web.push.apple.com/new-sub', keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } },
    timezone: 'Asia/Seoul',
    enabled: true,
  });
  assert.deepEqual(await createNotify(paired(), m.env).state(), { kind: 'on', timezone: 'Asia/Seoul' });
});

test('켜기: 권한을 거부하거나 닫으면 denied 이고 구독하지 않는다, 이미 거부된 상태에서는 요청하지 않는다', async () => {
  const refuse = makeEnv();
  refuse.st.grantOnRequest = 'denied';
  assert.deepEqual(await createNotify(paired(), refuse.env).enable(), { ok: false, reason: 'denied' });
  assert.equal(refuse.st.subscribeCalls.length, 0);
  assert.equal(refuse.calls.length, 0, '서버에도 아무것도 보내지 않는다');

  const dismiss = makeEnv();
  dismiss.st.grantOnRequest = 'default'; // 권한 창을 그냥 닫음
  assert.deepEqual(await createNotify(paired(), dismiss.env).enable(), { ok: false, reason: 'denied' });

  const already = makeEnv();
  already.st.permission = 'denied';
  let asked = 0;
  const env = { ...already.env, notification: { permission: 'denied' as const, requestPermission: async () => (asked++, 'granted' as const) } };
  assert.deepEqual(await createNotify(paired(), env).enable(), { ok: false, reason: 'denied' });
  assert.equal(asked, 0, '거부된 상태에서는 다시 묻지 않는다 (묻더라도 브라우저가 무시한다)');
});

test('켜기: 지원 안 함·설치 필요·등록 안 함은 권한을 묻기 전에 막는다', async () => {
  for (const [over, paired_, reason] of [
    [{ hasPushManager: false }, true, 'unsupported'],
    [{ userAgent: 'iPhone', platform: 'iPhone' }, true, 'needs-install'],
    [{}, false, 'unpaired'],
  ] as const) {
    const m = makeEnv(over);
    assert.deepEqual(await createNotify(paired(paired_), m.env).enable(), { ok: false, reason });
    assert.equal(m.st.permission, 'default', '권한 창을 띄우지 않았다');
  }
});

test('켜기: 이미 맞는 구독이 있으면 그대로 쓰고, 서버 키가 바뀌었으면 옛 구독을 지우고 새로 구독한다', async () => {
  const same = makeEnv();
  same.st.permission = 'granted';
  same.st.sub = { endpoint: 'https://web.push.apple.com/keep', key: keyBytes(SERVER_KEY), unsubscribed: false };
  assert.deepEqual(await createNotify(paired(), same.env).enable(), { ok: true });
  assert.equal(same.st.subscribeCalls.length, 0, '새로 구독하지 않는다');
  assert.equal((same.calls.find((c) => c.method === 'PUT')!.body as { subscription: { endpoint: string } }).subscription.endpoint, 'https://web.push.apple.com/keep');

  const changed = makeEnv();
  changed.st.permission = 'granted';
  const old = { endpoint: 'https://web.push.apple.com/old', key: keyBytes(OTHER_KEY), unsubscribed: false };
  changed.st.sub = old;
  assert.deepEqual(await createNotify(paired(), changed.env).enable(), { ok: true });
  assert.equal(old.unsubscribed, true, '옛 구독을 지웠다');
  assert.equal(changed.st.subscribeCalls.length, 1);
  assert.equal(Buffer.from(changed.st.subscribeCalls[0]!.key).toString('base64url'), SERVER_KEY);
});

test('켜기: 서버가 키를 못 주면(503) server, 등록이 거절되면 server, 401 이면 unpaired, 네트워크 오류면 offline', async () => {
  const noKey = makeEnv();
  noKey.st.routes['GET /api/push/key'] = () => new Response('{}', { status: 503 });
  assert.deepEqual(await createNotify(paired(), noKey.env).enable(), { ok: false, reason: 'server' });
  assert.equal(noKey.st.subscribeCalls.length, 0);

  const rejected = makeEnv();
  rejected.st.routes['PUT /api/devices/me/push'] = () => new Response('{}', { status: 400 });
  assert.deepEqual(await createNotify(paired(), rejected.env).enable(), { ok: false, reason: 'server' });

  const unauth = makeEnv();
  unauth.st.routes['PUT /api/devices/me/push'] = () => new Response('{}', { status: 401 });
  assert.deepEqual(await createNotify(paired(), unauth.env).enable(), { ok: false, reason: 'unpaired' });

  const offline = makeEnv();
  offline.st.online = false;
  assert.deepEqual(await createNotify(paired(), offline.env).enable(), { ok: false, reason: 'offline' });
});

test('끄기: 구독은 두고 enabled=false 만 서버에 보낸다', async () => {
  const m = makeEnv();
  assert.equal(await createNotify(paired(), m.env).disable(), true);
  assert.deepEqual(m.calls.map((c) => [c.method, c.path, c.body]), [['PUT', '/api/devices/me/push', { enabled: false }]]);
  m.st.online = false;
  assert.equal(await createNotify(paired(), m.env).disable(), false);
});

test('테스트 알림: 서버 응답을 구분해서 돌려준다', async () => {
  const m = makeEnv();
  assert.deepEqual(await createNotify(paired(), m.env).sendTest(), { ok: true });
  for (const [status, error, reason] of [[409, 'not_subscribed', 'not-subscribed'], [409, 'disabled', 'disabled'], [502, 'push_failed', 'unavailable'], [503, 'push_unavailable', 'unavailable']] as const) {
    const e = makeEnv();
    e.st.routes['POST /api/push/test'] = () => new Response(JSON.stringify({ error }), { status });
    assert.deepEqual(await createNotify(paired(), e.env).sendTest(), { ok: false, reason }, `${status} ${error}`);
  }
  m.st.online = false;
  assert.deepEqual(await createNotify(paired(), m.env).sendTest(), { ok: false, reason: 'offline' });
});

test('맞추기: 서버 푸시 키가 바뀌었으면 다시 구독해 등록하고, 시간대가 바뀌었으면 시간대만 보낸다', async () => {
  const keyChanged = makeEnv();
  keyChanged.st.permission = 'granted';
  const old = { endpoint: 'https://web.push.apple.com/old', key: keyBytes(OTHER_KEY), unsubscribed: false };
  keyChanged.st.sub = old;
  keyChanged.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
  await createNotify(paired(), keyChanged.env).reconcile();
  assert.equal(old.unsubscribed, true);
  assert.equal(keyChanged.st.subscribeCalls.length, 1);
  const put = keyChanged.calls.find((c) => c.method === 'PUT')!;
  assert.equal((put.body as { enabled: boolean }).enabled, true);
  assert.equal((put.body as { subscription: { endpoint: string } }).subscription.endpoint, 'https://web.push.apple.com/new-sub');

  const tz = makeEnv();
  tz.st.permission = 'granted';
  tz.st.sub = { endpoint: 'https://web.push.apple.com/a', key: keyBytes(SERVER_KEY), unsubscribed: false };
  tz.st.serverPush = { subscribed: true, enabled: true, timezone: 'America/New_York' }; // 서버는 옛 시간대를 안다
  await createNotify(paired(), tz.env).reconcile();
  assert.deepEqual(tz.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ timezone: 'Asia/Seoul' }]);
  assert.equal(tz.st.subscribeCalls.length, 0);

  // 이미 모두 맞으면 아무것도 보내지 않는다
  const same = makeEnv();
  same.st.permission = 'granted';
  same.st.sub = { endpoint: 'https://web.push.apple.com/a', key: keyBytes(SERVER_KEY), unsubscribed: false };
  same.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
  await createNotify(paired(), same.env).reconcile();
  assert.equal(same.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('맞추기: 알림이 꺼져 있거나 권한이 없거나 등록 안 된 기기는 건드리지 않고, 오류도 조용히 넘어간다', async () => {
  const cases: [string, (m: ReturnType<typeof makeEnv>) => void, boolean][] = [
    ['서버에서 꺼짐', (m) => (m.st.serverPush.enabled = false), true],
    ['구독 없음', (m) => (m.st.serverPush.subscribed = false), true],
    ['권한 기본값', (m) => (m.st.permission = 'default'), true],
    ['등록 안 됨', () => undefined, false],
  ];
  for (const [label, mutate, isPaired] of cases) {
    const m = makeEnv();
    m.st.permission = 'granted';
    m.st.sub = { endpoint: 'https://web.push.apple.com/a', key: keyBytes(OTHER_KEY), unsubscribed: false };
    m.st.serverPush = { subscribed: true, enabled: true, timezone: 'America/New_York' };
    mutate(m);
    await createNotify(paired(isPaired), m.env).reconcile();
    assert.equal(m.calls.filter((c) => c.method === 'PUT').length, 0, label);
    assert.equal(m.st.subscribeCalls.length, 0, label);
  }
  const offline = makeEnv();
  offline.st.permission = 'granted';
  offline.st.online = false;
  await assert.doesNotReject(createNotify(paired(), offline.env).reconcile());
});

test('편집 시트 안내: 이 기기에서 알림이 울리지 않는 이유를 알려 주고, 켜져 있거나 모를 때는 말이 없다', () => {
  assert.equal(editorNotice({ kind: 'on', timezone: 'Asia/Seoul' }), null);
  assert.equal(editorNotice({ kind: 'offline' }), null);
  assert.match(editorNotice({ kind: 'off' })!, /꺼져 있어서.*설정에서 알림을 켜세요/);
  assert.match(editorNotice({ kind: 'denied' })!, /차단/);
  assert.match(editorNotice({ kind: 'unpaired' })!, /홈서버에 등록/);
  assert.match(editorNotice({ kind: 'needs-install' })!, /홈 화면에 추가/);
  assert.match(editorNotice({ kind: 'unsupported' })!, /지원하지 않아요/);
});

test('푸시 서비스에 닿지 못해 getSubscription 이 끝나지 않아도 상태 확인은 끝난다 (구독 없음으로 본다)', async () => {
  const m = makeEnv({ registration: async () => ({ pushManager: { getSubscription: () => new Promise(() => undefined), subscribe: async () => { throw new Error('no'); } } }) as never });
  m.st.permission = 'granted';
  m.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
  assert.deepEqual(await createNotify(paired(), m.env).state(), { kind: 'off' }, '끝나지 않는 구독 조회가 설정 화면을 영영 막으면 안 된다');
  await assert.doesNotReject(createNotify(paired(), m.env).reconcile());
});

test('아직 켜지 않은 기기(권한 기본값·서버에 구독 없음·꺼짐)는 구독을 조회하지 않는다 (일부 환경에서 조회가 페이지를 멈춘다)', async () => {
  for (const [label, setup] of [
    ['권한 기본값', (m: ReturnType<typeof makeEnv>) => { m.st.permission = 'default'; m.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' }; }],
    ['서버에 구독 없음', (m: ReturnType<typeof makeEnv>) => { m.st.permission = 'granted'; }],
    ['서버에서 꺼짐', (m: ReturnType<typeof makeEnv>) => { m.st.permission = 'granted'; m.st.serverPush = { subscribed: true, enabled: false, timezone: 'Asia/Seoul' }; }],
  ] as const) {
    const m = makeEnv();
    setup(m);
    let asked = 0;
    const env = { ...m.env, registration: async () => ({ pushManager: { getSubscription: async () => (asked++, null), subscribe: async () => { throw new Error('no'); } } }) as never };
    assert.deepEqual(await createNotify(paired(), env).state(), { kind: 'off' }, label);
    assert.equal(asked, 0, `${label}: getSubscription 을 부르지 않는다`);
  }
  // 켜져 있을 가능성이 있을 때는 구독을 확인한다
  const m = makeEnv();
  m.st.permission = 'granted';
  m.st.serverPush = { subscribed: true, enabled: true, timezone: 'Asia/Seoul' };
  let asked = 0;
  const env = { ...m.env, registration: async () => ({ pushManager: { getSubscription: async () => (asked++, null), subscribe: async () => { throw new Error('no'); } } }) as never };
  assert.deepEqual(await createNotify(paired(), env).state(), { kind: 'off' });
  assert.equal(asked, 1);
});
