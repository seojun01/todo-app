import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventShortTime, eventTimeLabel, eventsByDate, invalidateEvents, loadEvents, safeColor, type CalendarEvent } from '../../src/gcal-events.ts';
import type { App } from '../../src/app.ts';

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'c:1', calendarId: 'c', calendarName: '내 일정', color: '#1a73e8', title: '일정', startDate: '2026-11-20', endDate: '2026-11-20',
  startTime: null, endTime: null, allDay: true, ...over,
});

test('시각 문구: 종일 / 시작–끝 / 시작만 / 여러 날의 첫날·가운데·마지막 날', () => {
  assert.equal(eventTimeLabel(ev({}), '2026-11-20'), '종일');
  assert.equal(eventTimeLabel(ev({ allDay: false, startTime: '13:00', endTime: '14:30' }), '2026-11-20'), '13:00–14:30');
  assert.equal(eventTimeLabel(ev({ allDay: false, startTime: '23:00', endTime: null }), '2026-11-20'), '23:00', '자정에 끝나는 일정은 시작 시각만');
  const multi = ev({ allDay: false, startDate: '2026-11-20', endDate: '2026-11-22', startTime: '22:00', endTime: '02:00' });
  assert.equal(eventTimeLabel(multi, '2026-11-20'), '22:00~');
  assert.equal(eventTimeLabel(multi, '2026-11-21'), '종일');
  assert.equal(eventTimeLabel(multi, '2026-11-22'), '~02:00');
  assert.equal(eventTimeLabel(ev({ startDate: '2026-11-20', endDate: '2026-11-22' }), '2026-11-21'), '종일', '여러 날 종일');
});

test('칸 안 짧은 시각: 시작하는 날의 시작 시각만, 종일·이어지는 날은 없다', () => {
  const timed = ev({ allDay: false, startTime: '13:00', endTime: '14:00' });
  assert.equal(eventShortTime(timed, '2026-11-20'), '13:00');
  assert.equal(eventShortTime(ev({}), '2026-11-20'), '');
  const multi = ev({ allDay: false, startDate: '2026-11-20', endDate: '2026-11-21', startTime: '22:00', endTime: '02:00' });
  assert.equal(eventShortTime(multi, '2026-11-20'), '22:00');
  assert.equal(eventShortTime(multi, '2026-11-21'), '', '이어지는 날에는 시각을 붙이지 않는다');
});

test('날짜별로 묶기: 여러 날 일정은 걸친 날마다, 범위 밖 날짜는 만들지 않고, 종일이 먼저 시각순', () => {
  const events = [
    ev({ id: 'c:b', title: '오후', allDay: false, startTime: '15:00', endTime: '16:00' }),
    ev({ id: 'c:a', title: '아침', allDay: false, startTime: '08:00', endTime: '09:00' }),
    ev({ id: 'c:v', title: '휴가', startDate: '2026-11-19', endDate: '2026-11-22' }),
  ];
  const m = eventsByDate(events, '2026-11-20', '2026-11-21');
  assert.deepEqual([...m.keys()], ['2026-11-20', '2026-11-21'], '범위(20~21) 밖인 19일·22일은 없다');
  assert.deepEqual(m.get('2026-11-20')!.map((e) => e.title), ['휴가', '아침', '오후']);
  assert.deepEqual(m.get('2026-11-21')!.map((e) => e.title), ['휴가']);
});

test('날짜별로 묶기: 아주 긴 일정도 보이는 범위만 훑는다', () => {
  const t = Date.now();
  const m = eventsByDate([ev({ startDate: '2000-01-01', endDate: '2099-12-31' })], '2026-11-01', '2026-11-30');
  assert.equal(m.size, 30);
  assert.ok(Date.now() - t < 200);
});

test('색: #rrggbb 만 통과시킨다 (스타일에 그대로 들어가므로)', () => {
  assert.equal(safeColor('#1a73e8'), '#1a73e8');
  assert.equal(safeColor('#ABCDEF'), '#ABCDEF');
  for (const bad of ['red', '#fff', '#12345g', 'url(javascript:1)', '#1a73e8; background: red', '', null]) assert.equal(safeColor(bad as string | null), null, String(bad));
});

// ── 조회: 등록 여부, 캐시, 실패 시 마지막 값 ──

const appWith = (paired: boolean): App => ({ sync: { status: async () => ({ paired }) } }) as unknown as App;
const realFetch = globalThis.fetch;
let calls: string[] = [];
beforeEach(() => {
  invalidateEvents();
  calls = [];
  globalThis.fetch = realFetch;
});
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
}
const ok = (events: CalendarEvent[]) => new Response(JSON.stringify({ events }), { status: 200 });

test('조회: 홈서버에 등록되지 않은 기기는 서버를 부르지 않는다', async () => {
  stubFetch(() => ok([ev({})]));
  assert.deepEqual(await loadEvents(appWith(false), '2026-11-01', '2026-11-30'), []);
  assert.equal(calls.length, 0);
});

test('조회: 같은 범위는 잠깐 캐시하고, 비우면 다시 받고, 동시에 부르면 한 번만 받는다', async () => {
  stubFetch(() => ok([ev({})]));
  const app = appWith(true);
  assert.equal((await loadEvents(app, '2026-11-01', '2026-11-30')).length, 1);
  assert.equal((await loadEvents(app, '2026-11-01', '2026-11-30')).length, 1);
  assert.equal(calls.length, 1, '캐시');
  assert.ok(calls[0]!.endsWith('/api/gcal/events?from=2026-11-01&to=2026-11-30'));
  await loadEvents(app, '2026-12-01', '2026-12-31');
  assert.equal(calls.length, 2, '범위가 다르면 따로');
  invalidateEvents();
  await loadEvents(app, '2026-11-01', '2026-11-30');
  assert.equal(calls.length, 3, '비우면 다시');
  invalidateEvents();
  await Promise.all([loadEvents(app, '2026-10-01', '2026-10-31'), loadEvents(app, '2026-10-01', '2026-10-31')]);
  assert.equal(calls.length, 4, '동시 요청은 하나로');
});

test('조회: 서버 오류·네트워크 오류에서는 조용히 빈 목록, 이미 받은 값이 있으면 그것을 유지한다 (오프라인)', async () => {
  const app = appWith(true);
  stubFetch(() => new Response('{}', { status: 500 }));
  assert.deepEqual(await loadEvents(app, '2026-11-01', '2026-11-30'), []);
  stubFetch(() => {
    throw new TypeError('network');
  });
  assert.deepEqual(await loadEvents(app, '2026-11-02', '2026-11-30'), []);

  // 한 번 받은 뒤 캐시가 만료돼 실패하면 마지막 값을 그대로 보여 준다
  stubFetch(() => ok([ev({ title: '받아 둔 일정' })]));
  assert.equal((await loadEvents(app, '2026-11-03', '2026-11-30'))[0]!.title, '받아 둔 일정');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000; // 캐시 유효 시간(30초) 경과
    stubFetch(() => {
      throw new TypeError('offline');
    });
    assert.equal((await loadEvents(app, '2026-11-03', '2026-11-30'))[0]!.title, '받아 둔 일정');
  } finally {
    Date.now = realNow;
  }
});

// ── 이 기기에 보관 (오프라인) ──

import { STORE_MAX } from '../../src/gcal-events.ts';

const PREFIX = 'todo.gcal-events.v1:';
class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
let fake: FakeStorage;
const setStorage = (v: unknown) => Object.defineProperty(globalThis, 'localStorage', { value: v, configurable: true, writable: true });
beforeEach(() => {
  fake = new FakeStorage();
  setStorage(fake);
});
const offline = () =>
  stubFetch(() => {
    throw new TypeError('offline');
  });

test('보관: 서버에서 받으면 이 기기에도 보관하고, 서버에 닿지 못하는 새 실행에서는 보관해 둔 것을 보여 준다', async () => {
  const app = appWithPaired();
  stubFetch(() => ok([ev({ id: 'c:9', title: '치과' })]));
  await loadEvents(app, '2026-11-01', '2026-11-30');
  const raw = fake.getItem(`${PREFIX}2026-11-01:2026-11-30`)!;
  assert.equal(JSON.parse(raw).events[0].title, '치과');

  // 새로 연 앱: 메모리 캐시는 비어 있고(invalidate 없이 페이지가 새로 뜬 상황을 보관본 직접 주입으로 재현) 서버는 오프라인
  invalidateEvents(); // 메모리와 보관본을 모두 비운다
  fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, raw);
  offline();
  assert.equal((await loadEvents(app, '2026-11-01', '2026-11-30'))[0]!.title, '치과');
  // 다른 범위는 보관본이 없으니 빈 목록
  assert.deepEqual(await loadEvents(app, '2026-12-01', '2026-12-31'), []);
});

test('보관: 서버 5xx 에서도 보관본을 보여 주고, 서버가 정상으로 답하면 최신으로 바꾼다 (끈 경우의 빈 목록 포함)', async () => {
  const app = appWithPaired();
  fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, JSON.stringify({ at: 1, events: [ev({ id: 'c:1', title: '옛 일정' })] }));
  stubFetch(() => new Response('{}', { status: 503 }));
  assert.equal((await loadEvents(app, '2026-11-01', '2026-11-30'))[0]!.title, '옛 일정');

  invalidateEvents();
  fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, JSON.stringify({ at: 1, events: [ev({ id: 'c:1', title: '옛 일정' })] }));
  stubFetch(() => ok([])); // 불러오기를 껐거나 일정이 모두 지워진 서버
  assert.deepEqual(await loadEvents(app, '2026-11-01', '2026-11-30'), []);
  assert.deepEqual(JSON.parse(fake.getItem(`${PREFIX}2026-11-01:2026-11-30`)!).events, [], '보관본도 빈 목록으로 바뀐다 (끈 일정이 오프라인에서 되살아나지 않는다)');
});

test('보관: 기기 등록이 해제되면(401) 보관본을 지우고 빈 목록, 등록하지 않은 기기도 보관본을 남기지 않는다', async () => {
  fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, JSON.stringify({ at: 1, events: [ev({ id: 'c:1' })] }));
  fake.setItem('다른 앱 값', 'x');
  stubFetch(() => new Response('{}', { status: 401 }));
  assert.deepEqual(await loadEvents(appWithPaired(), '2026-11-01', '2026-11-30'), []);
  assert.equal(fake.length, 1, '우리 보관본만 지운다');
  assert.equal(fake.getItem('다른 앱 값'), 'x');

  fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, JSON.stringify({ at: 1, events: [ev({ id: 'c:1' })] }));
  invalidateEvents();
  fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, JSON.stringify({ at: 1, events: [ev({ id: 'c:1' })] }));
  assert.deepEqual(await loadEvents(appWith(false), '2026-11-01', '2026-11-30'), []);
  assert.equal(storedCount(), 0, '등록하지 않은 기기에는 남기지 않는다');
});

const storedCount = () => [...fake.map.keys()].filter((k) => k.startsWith(PREFIX)).length;

test('보관: invalidateEvents 는 보관본도 비우고(다른 앱 값은 그대로), 범위가 너무 많아지면 오래된 것부터 지운다', async () => {
  const app = appWithPaired();
  fake.setItem('다른 앱 값', 'x');
  stubFetch(() => ok([ev({})]));
  await loadEvents(app, '2026-11-01', '2026-11-30');
  assert.equal(storedCount(), 1);
  invalidateEvents();
  assert.equal(storedCount(), 0);
  assert.equal(fake.getItem('다른 앱 값'), 'x');

  // STORE_MAX 보다 많은 범위를 받으면 가장 오래된 것부터 사라진다
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => (t += 1000); // 받은 순서대로 시각이 흐르게
    for (let i = 1; i <= STORE_MAX + 3; i++) {
      await loadEvents(app, `2026-${String(Math.ceil(i / 3)).padStart(2, '0')}-0${(i % 3) + 1}`, `2027-01-${String(i).padStart(2, '0')}`);
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(storedCount(), STORE_MAX);
  assert.ok(![...fake.map.keys()].some((k) => k.endsWith(':2027-01-01') || k.endsWith(':2027-01-02') || k.endsWith(':2027-01-03')), '가장 먼저 받은 3개가 지워졌다');
  assert.ok([...fake.map.keys()].some((k) => k.endsWith(`:2027-01-${String(STORE_MAX + 3).padStart(2, '0')}`)), '가장 최근 것은 남아 있다');
});

test('보관: 깨진 보관본·모양이 다른 보관본은 없는 것으로 보고, localStorage 를 쓸 수 없어도 동작한다', async () => {
  const app = appWithPaired();
  offline();
  for (const bad of ['{not json', JSON.stringify({ events: 'nope' }), JSON.stringify({ events: [{ title: 1 }] }), '']) {
    invalidateEvents();
    fake.setItem(`${PREFIX}2026-11-01:2026-11-30`, bad);
    assert.deepEqual(await loadEvents(app, '2026-11-01', '2026-11-30'), [], bad);
  }
  // localStorage 접근이 예외를 던지거나 없는 환경
  setStorage({
    get length(): number {
      throw new Error('blocked');
    },
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('quota');
    },
    removeItem() {
      throw new Error('blocked');
    },
    key() {
      throw new Error('blocked');
    },
  });
  invalidateEvents();
  stubFetch(() => ok([ev({ title: '메모리에는 둔다' })]));
  assert.equal((await loadEvents(app, '2026-11-05', '2026-11-30'))[0]!.title, '메모리에는 둔다', '보관이 실패해도 일정은 보인다');
  setStorage(undefined);
  invalidateEvents();
  assert.equal((await loadEvents(app, '2026-11-06', '2026-11-30')).length, 1);
});

function appWithPaired(): App {
  return appWith(true);
}
