// 이 기기의 푸시 알림: 상태 확인, 켜기(권한 → 구독 → 서버 등록), 끄기, 테스트, 서버 키·시간대가 바뀐 것 맞추기 (research R15).
// 알림은 서버가 보낸다: 서버가 정한 시각에 푸시를 보내면 서비스 워커(sw.ts)가 받아 시스템 알림을 띄운다.

export type NotifyState =
  | { kind: 'unsupported' } // 이 브라우저는 푸시 알림을 지원하지 않는다
  | { kind: 'needs-install' } // iPhone·iPad: 홈 화면에 추가한 앱에서만 알림을 받을 수 있다
  | { kind: 'unpaired' } // 홈서버에 등록하지 않은 기기 (알림은 서버가 보낸다)
  | { kind: 'denied' } // 알림 권한이 거부됐다
  | { kind: 'offline' } // 홈서버에 닿지 못해 상태를 알 수 없다
  | { kind: 'off' } // 켤 수 있지만 지금은 꺼져 있다
  | { kind: 'on'; timezone: string };

export type EnableResult = { ok: true } | { ok: false; reason: 'unsupported' | 'needs-install' | 'unpaired' | 'denied' | 'offline' | 'server' };
export type TestResult = { ok: true } | { ok: false; reason: 'not-subscribed' | 'disabled' | 'unavailable' | 'offline' };

interface PushSub {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}
interface PushRegistration {
  pushManager: {
    getSubscription(): Promise<PushSub | null>;
    subscribe(opts: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSub>;
  };
}

/** 브라우저가 주는 것들. 테스트는 가짜를 넣는다. */
export interface NotifyEnv {
  notification?: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> };
  /** 서비스 워커 등록 (없으면 서비스 워커를 쓸 수 없다) */
  registration?: () => Promise<PushRegistration>;
  hasPushManager: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** 홈 화면에 설치한 앱으로 열렸는가 */
  standalone: boolean;
  fetch: typeof fetch;
  timeZone: string;
  /** 서비스 워커 준비를 기다리는 최대 시간 (기본 3초, 테스트는 줄인다) */
  readyTimeoutMs?: number;
}

export function browserEnv(): NotifyEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    notification: typeof Notification === 'undefined' ? undefined : Notification,
    registration:
      nav && 'serviceWorker' in nav
        ? async () => {
            // 서비스 워커가 등록되지 않았다면 ready 는 영원히 끝나지 않는다: 먼저 등록 여부를 확인해 바로 실패시킨다
            if (!(await nav.serviceWorker.getRegistration())) throw new Error('서비스 워커가 등록되지 않았어요');
            return nav.serviceWorker.ready as unknown as PushRegistration;
          }
        : undefined,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone: (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) || (nav as unknown as { standalone?: boolean } | undefined)?.standalone === true,
    fetch: (...args) => fetch(...args),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const isIos = (e: NotifyEnv) => /iPad|iPhone|iPod/.test(e.userAgent) || (e.platform === 'MacIntel' && e.maxTouchPoints > 1);

/** 이 환경에서 알림을 받을 수 있는 조건이 갖춰졌는가. 아니면 이유를 돌려준다. */
export function support(e: NotifyEnv): 'ok' | 'unsupported' | 'needs-install' {
  // iOS 는 홈 화면에 설치한 앱에서만 푸시를 쓸 수 있다 (설치 전에는 PushManager 가 없다)
  if (isIos(e) && !e.standalone) return 'needs-install';
  return e.notification && e.registration && e.hasPushManager ? 'ok' : 'unsupported';
}

/** base64url 문자열을 바이트로 (applicationServerKey 에 넘긴다) */
function urlBase64ToBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64u.length / 4) * 4, '=');
  return Uint8Array.from([...atob(b64)].map((c) => c.charCodeAt(0)));
}
const bytesToBase64Url = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface NotifyApi {
  state(): Promise<NotifyState>;
  enable(): Promise<EnableResult>;
  disable(): Promise<boolean>;
  sendTest(): Promise<TestResult>;
  /** 서버의 푸시 공개키나 이 기기의 시간대가 바뀌었으면 조용히 맞춘다 (알림이 켜져 있을 때만) */
  reconcile(): Promise<void>;
}

export function createNotify(isPaired: () => Promise<boolean>, env: NotifyEnv = browserEnv()): NotifyApi {
  const call = (path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> =>
    env.fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { 'X-Todo-Client': '1', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  /** p 가 ms 안에 끝나지 않거나 실패하면 null (타이머는 끝나는 즉시 치운다) */
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      p.then(
        (v) => (clearTimeout(timer), resolve(v)),
        () => (clearTimeout(timer), resolve(null)),
      );
    });

  async function registration(): Promise<PushRegistration | null> {
    // 서비스 워커가 등록되지 않았다면 ready 가 영원히 끝나지 않는다: 잠깐만 기다린다
    return env.registration ? withTimeout(env.registration(), env.readyTimeoutMs ?? 3000) : null;
  }

  /** 이 기기의 푸시 구독. 푸시 서비스에 닿지 못하는 환경에서는 getSubscription 이 끝나지 않을 수 있어 시간을 제한한다 (null = 구독 없음으로 본다) */
  const currentSubscription = (reg: PushRegistration): Promise<PushSub | null> => withTimeout(reg.pushManager.getSubscription(), env.readyTimeoutMs ?? 3000).then((v) => v ?? null);

  async function serverKey(): Promise<{ key: string } | { status: number }> {
    const res = await call('/api/push/key');
    if (!res.ok) return { status: res.status };
    return { key: ((await res.json()) as { publicKey: string }).publicKey };
  }

  async function subscribeFresh(reg: PushRegistration, key: string): Promise<PushSub> {
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
  }

  const putSubscription = (sub: PushSub, enabled: boolean): Promise<Response> => {
    const j = sub.toJSON();
    return call('/api/devices/me/push', { method: 'PUT', body: JSON.stringify({ subscription: { endpoint: j.endpoint ?? sub.endpoint, keys: j.keys }, timezone: env.timeZone, enabled }) });
  };

  async function serverView(): Promise<{ subscribed: boolean; enabled: boolean; timezone: string | null } | 'unauthorized' | 'offline'> {
    try {
      const res = await call('/api/devices/me', {}, 3000);
      if (res.status === 401) return 'unauthorized';
      if (!res.ok) return 'offline';
      return ((await res.json()) as { push: { subscribed: boolean; enabled: boolean; timezone: string | null } }).push;
    } catch {
      return 'offline';
    }
  }

  return {
    async state() {
      const sup = support(env);
      if (sup !== 'ok') return { kind: sup };
      if (!(await isPaired())) return { kind: 'unpaired' };
      if (env.notification!.permission === 'denied') return { kind: 'denied' };
      const view = await serverView();
      if (view === 'unauthorized') return { kind: 'unpaired' };
      if (view === 'offline') return { kind: 'offline' };
      const reg = await registration();
      if (!reg) return { kind: 'unsupported' };
      // 켜져 있을 가능성이 없으면(권한이 아직 없거나 서버에 구독이 없거나 꺼져 있으면) 구독을 조회하지 않는다.
      // 일부 환경에서는 getSubscription 이 페이지를 멈추거나 끝나지 않으므로 꼭 필요할 때만 부른다.
      if (env.notification!.permission !== 'granted' || !view.subscribed || !view.enabled) return { kind: 'off' };
      const sub = await currentSubscription(reg);
      return sub ? { kind: 'on', timezone: view.timezone ?? env.timeZone } : { kind: 'off' };
    },

    async enable() {
      const sup = support(env);
      if (sup !== 'ok') return { ok: false, reason: sup };
      if (!(await isPaired())) return { ok: false, reason: 'unpaired' };
      let permission = env.notification!.permission;
      if (permission === 'default') permission = await env.notification!.requestPermission(); // 사용자 조작(버튼)에서만 부른다
      if (permission !== 'granted') return { ok: false, reason: 'denied' };
      try {
        const reg = await registration();
        if (!reg) return { ok: false, reason: 'unsupported' };
        const key = await serverKey();
        if ('status' in key) return { ok: false, reason: key.status === 401 ? 'unpaired' : 'server' };
        let sub = await currentSubscription(reg);
        // 서버 키가 바뀌었다면 옛 구독은 쓸 수 없다: 새로 구독한다
        if (sub && sub.options?.applicationServerKey && bytesToBase64Url(sub.options.applicationServerKey) !== key.key) {
          await sub.unsubscribe();
          sub = null;
        }
        sub ??= await subscribeFresh(reg, key.key);
        const res = await putSubscription(sub, true);
        if (res.status === 401) return { ok: false, reason: 'unpaired' };
        return res.ok ? { ok: true } : { ok: false, reason: 'server' };
      } catch {
        return { ok: false, reason: 'offline' };
      }
    },

    async disable() {
      try {
        // 구독은 그대로 두고 서버가 이 기기로 보내지 않게만 한다
        return (await call('/api/devices/me/push', { method: 'PUT', body: JSON.stringify({ enabled: false }) })).ok;
      } catch {
        return false;
      }
    },

    async sendTest() {
      try {
        const res = await call('/api/push/test', { method: 'POST', body: '{}' });
        if (res.ok) return { ok: true };
        const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        if (error === 'not_subscribed') return { ok: false, reason: 'not-subscribed' };
        if (error === 'disabled') return { ok: false, reason: 'disabled' };
        return { ok: false, reason: 'unavailable' };
      } catch {
        return { ok: false, reason: 'offline' };
      }
    },

    async reconcile() {
      try {
        if (support(env) !== 'ok' || env.notification!.permission !== 'granted' || !(await isPaired())) return;
        const view = await serverView();
        if (typeof view === 'string' || !view.subscribed || !view.enabled) return; // 켜져 있을 때만 손댄다
        const reg = await registration();
        const sub = reg ? await currentSubscription(reg) : null;
        if (!reg || !sub) return;
        const key = await serverKey();
        if ('key' in key && sub.options?.applicationServerKey && bytesToBase64Url(sub.options.applicationServerKey) !== key.key) {
          // 서버의 푸시 키가 바뀌었다: 다시 구독해서 서버에 등록한다
          await sub.unsubscribe();
          await putSubscription(await subscribeFresh(reg, key.key), true);
          return;
        }
        if (view.timezone !== env.timeZone) await call('/api/devices/me/push', { method: 'PUT', body: JSON.stringify({ timezone: env.timeZone }) });
      } catch {
        /* 조용히 넘어간다: 다음에 앱을 열 때 다시 맞춘다 */
      }
    },
  };
}

/** 편집 시트에서 알림을 골랐을 때 이 기기에서 알림이 울리지 않는 이유 (알림이 켜져 있거나 상태를 모르면 null) */
export function editorNotice(state: NotifyState): string | null {
  switch (state.kind) {
    case 'off':
      return '이 기기의 알림이 꺼져 있어서 알림이 울리지 않아요. 설정에서 알림을 켜세요.';
    case 'denied':
      return '이 기기는 알림이 차단돼 있어서 알림이 울리지 않아요. 알림을 허용한 뒤 설정에서 켜세요.';
    case 'unpaired':
      return '홈서버에 등록한 기기에서만 알림이 울려요. 설정에서 이 기기를 등록하세요.';
    case 'needs-install':
      return 'iPhone·iPad에서는 홈 화면에 추가한 앱에서만 알림이 울려요.';
    case 'unsupported':
      return '이 브라우저는 알림을 지원하지 않아요.';
    default:
      return null;
  }
}
