import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../src/scheduler.ts';
import { revokeDevice } from '../../src/auth.ts';
import { startFakePush, type FakePush } from '../helpers/fake-push-service.ts';
import { mkSettings, mkTask, startTestServer, type TestServer } from '../helpers/test-server.ts';

// 기준: 2026-11-13(금) 서울 09:00 = 00:00Z. 서울은 UTC+9 → 15:00 = 06:00Z, 14:30 = 05:30Z
const T0 = '2026-11-13T00:00:00Z';
let ver = 0;
const bump = <T extends Record<string, unknown>>(rec: T, over: Record<string, unknown> = {}) => ({ ...rec, ...over, version: `002000000000000-${String(++ver).padStart(6, '0')}-dev` });

async function setup(start = T0) {
  const fake = await startFakePush();
  let clock = new Date(start);
  const srv: TestServer = await startTestServer({ now: () => clock, push: { allowHosts: [fake.host] } });
  const at = (iso: string) => void (clock = new Date(iso));
  const device = async (name: string, tz = 'Asia/Seoul', enabled = true) => {
    const d = await srv.pair(name);
    const sub = fake.newSubscription();
    const res = await srv.api('/api/devices/me/push', { method: 'PUT', cookie: d.cookie, body: { subscription: { endpoint: sub.endpoint, keys: sub.keys }, timezone: tz, enabled } });
    assert.equal(res.status, 200);
    return { ...d, sub };
  };
  const put = async (cookie: string, ...records: Record<string, unknown>[]) => {
    const res = await srv.api('/api/changes', { cookie, body: { changes: records.map((record) => ({ type: 'task', record })) } });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const tick = () => srv.scheduler.tick();
  const sentTo = (sub: { id: string }) => fake.received.filter((r) => r.subscription === sub.id);
  const close = async () => {
    await srv.close();
    await fake.close();
  };
  return { fake, srv, at, device, put, tick, sentTo, close };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
async function withCtx(fn: (c: Ctx) => Promise<void>, start = T0) {
  const c = await setup(start);
  try {
    await fn(c);
  } finally {
    await c.close();
  }
}

test('정시·30분 전: 각 알림이 자기 시각에 한 번씩 가고, 같은 알림은 다시 가지 않는다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const task = mkTask({ title: '치과', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at', '30m'] });
    await c.put(d.cookie, task);

    c.at('2026-11-13T05:29:00Z'); // 14:29
    assert.equal((await c.tick()).sent, 0, '아직 14:30 전');
    c.at('2026-11-13T05:30:30Z'); // 14:30:30 → 30분 전
    assert.equal((await c.tick()).sent, 1);
    c.at('2026-11-13T05:31:00Z');
    assert.equal((await c.tick()).sent, 0, '같은 알림은 다시 가지 않는다');
    c.at('2026-11-13T06:00:10Z'); // 15:00:10 → 정시
    assert.equal((await c.tick()).sent, 1);
    c.at('2026-11-13T06:00:40Z');
    assert.equal((await c.tick()).sent, 0);
    assert.equal(c.sentTo(d.sub).length, 2);
  }));

test('페이로드에는 내용(제목·프로젝트)이 없고 할 일 번호뿐이다 (SC-014)', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const task = mkTask({ title: '비밀 진료 예약', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    await c.put(d.cookie, task);
    c.at('2026-11-13T06:00:05Z');
    await c.tick();
    const r = c.sentTo(d.sub)[0]!;
    assert.deepEqual(r.payload, { v: 1, taskId: task.id });
    assert.deepEqual(Object.keys(r.payload as object).sort(), ['taskId', 'v']);
    assert.ok(!r.rawBody.toString('latin1').includes('비밀'), '평문이 전송 본문에 드러나지 않는다');
    assert.ok(!JSON.stringify(r.payload).includes('진료'));
  }));

test('시각이 없는 할 일: 당일은 기본 알림 시각(09:00)에, 설정에서 바꾸면 그 시각에 간다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    // 기본 알림 시각 07:45 로 바꾼다 (서울 → 전날 22:45Z)
    const res = await c.srv.api('/api/changes', { cookie: d.cookie, body: { changes: [{ type: 'settings', record: mkSettings({ defaultReminderTime: '07:45' }) }] } });
    assert.equal(res.status, 200);
    const task = mkTask({ title: '제출', dueDate: '2026-11-14', dueTime: null, reminders: ['day'] }); // 내일(토)
    await c.put(d.cookie, task);

    c.at('2026-11-13T22:44:00Z'); // 11/14 07:44
    assert.equal((await c.tick()).sent, 0);
    c.at('2026-11-13T22:45:20Z'); // 11/14 07:45
    assert.equal((await c.tick()).sent, 1);
    assert.equal(c.sentTo(d.sub).length, 1);
  }));

test('하루 전: 시각이 있으면 하루 전 같은 시각, 없으면 하루 전 기본 알림 시각', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const timed = mkTask({ title: '발표', dueDate: '2026-11-15', dueTime: '14:00', reminders: ['1d'] }); // 11/14 14:00 = 05:00Z
    const dateOnly = mkTask({ title: '서류', dueDate: '2026-11-15', dueTime: null, reminders: ['1d'] }); // 11/14 09:00 = 00:00Z
    await c.put(d.cookie, timed, dateOnly);
    c.at('2026-11-14T00:00:30Z');
    assert.equal((await c.tick()).sent, 1, '서류만');
    c.at('2026-11-14T05:00:30Z');
    assert.equal((await c.tick()).sent, 1, '발표');
    assert.deepEqual(c.sentTo(d.sub).map((r) => (r.payload as { taskId: string }).taskId), [dateOnly.id, timed.id]);
  }));

test('기기마다 자기 시간대로 계산해 각 기기에 한 번씩 보낸다', () =>
  withCtx(async (c) => {
    const seoul = await c.device('맥북', 'Asia/Seoul');
    const ny = await c.device('아이패드', 'America/New_York');
    const task = mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    await c.put(seoul.cookie, task);
    // 서울 15:00 = 06:00Z, 뉴욕 15:00(EST, -5) = 20:00Z
    c.at('2026-11-13T06:00:20Z');
    const first = await c.tick();
    assert.equal(first.sent, 1);
    assert.equal(c.sentTo(seoul.sub).length, 1);
    assert.equal(c.sentTo(ny.sub).length, 0, '뉴욕 기기는 아직');
    c.at('2026-11-13T20:00:20Z');
    // 알림이 15분 안에 도착해야 하므로 06:00Z 의 알림은 이미 지나 건너뛰지만, 뉴욕의 20:00Z 는 지금 간다
    const second = await c.tick();
    assert.equal(second.sent, 1);
    assert.equal(c.sentTo(ny.sub).length, 1);
    assert.equal(c.sentTo(seoul.sub).length, 1, '서울 기기에 다시 가지 않는다');
  }));

test('같은 시각에 알림이 켜진 두 기기가 있으면 둘 다 받는다 (기기별로 끈 기기는 받지 않는다)', () =>
  withCtx(async (c) => {
    const a = await c.device('맥북');
    const b = await c.device('아이폰');
    const off = await c.device('끈 기기', 'Asia/Seoul', false);
    const task = mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    await c.put(a.cookie, task);
    c.at('2026-11-13T06:00:10Z');
    const r = await c.tick();
    assert.equal(r.sent, 2);
    assert.equal(c.sentTo(a.sub).length, 1);
    assert.equal(c.sentTo(b.sub).length, 1);
    assert.equal(c.sentTo(off.sub).length, 0);
    // 끈 기기를 다시 켜도 이미 지난 알림은 가지 않는다 (15분 규칙은 시각 기준이 아니라 이미 지난 알림이라서)
    await c.srv.api('/api/devices/me/push', { method: 'PUT', cookie: off.cookie, body: { enabled: true } });
    assert.equal((await c.tick()).sent, 1, '켜자마자 아직 15분 안인 알림은 간다');
  }));

test('구독이 없는 기기·해제된 기기에는 보내지 않는다', () =>
  withCtx(async (c) => {
    const none = await c.srv.pair('구독 없음');
    const revoked = await c.device('해제될 기기');
    const task = mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    await c.put(none.cookie, task);
    revokeDevice(c.srv.db, revoked.deviceId, new Date(T0));
    c.at('2026-11-13T06:00:10Z');
    assert.deepEqual(await c.tick(), { sent: 0, gone: 0, retry: 0, fail: 0 });
    assert.equal(c.fake.received.length, 0);
  }));

test('완료·삭제한 할 일은 보내지 않는다 (알림이 울리기 전에 취소된 경우)', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const done = mkTask({ title: '완료할 일', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    const gone = mkTask({ title: '삭제할 일', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    const keep = mkTask({ title: '남는 일', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    await c.put(d.cookie, done, gone, keep);
    c.at('2026-11-13T05:00:00Z');
    await c.put(d.cookie, bump(done, { done: true }), bump(gone, { deleted: true }));
    c.at('2026-11-13T06:00:10Z');
    assert.equal((await c.tick()).sent, 1);
    assert.deepEqual(c.sentTo(d.sub).map((r) => (r.payload as { taskId: string }).taskId), [keep.id]);
  }));

test('기한을 바꾸면 이전 시각의 알림은 취소되고 새 기한 기준으로 보낸다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const task = mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    await c.put(d.cookie, task);
    c.at('2026-11-13T05:00:00Z'); // 14:00 — 15:00 알림 전에 16:00 으로 옮긴다
    await c.put(d.cookie, bump(task, { dueTime: '16:00' }));
    c.at('2026-11-13T06:00:10Z'); // 15:00
    assert.equal((await c.tick()).sent, 0, '옛 시각의 알림은 울리지 않는다');
    c.at('2026-11-13T07:00:10Z'); // 16:00
    assert.equal((await c.tick()).sent, 1, '새 시각의 알림은 울린다');
  }));

test('이미 지난 시각으로 알림을 정하면 뒤늦게 울리지 않는다 (알림을 설정한 뒤의 시각만)', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    c.at('2026-11-13T06:10:00Z'); // 지금 15:10 에 15:00 정시 알림을 정한다 → 이미 지난 알림
    const late = mkTask({ title: '이미 지남', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] });
    const ahead = mkTask({ title: '앞으로', dueDate: '2026-11-13', dueTime: '15:30', reminders: ['at'] });
    await c.put(d.cookie, late, ahead);
    assert.equal((await c.tick()).sent, 0, '15분 안이라도 설정할 때 이미 지났던 알림은 보내지 않는다');
    c.at('2026-11-13T06:30:10Z'); // 15:30
    assert.equal((await c.tick()).sent, 1);
    assert.deepEqual(c.sentTo(d.sub).map((r) => (r.payload as { taskId: string }).taskId), [ahead.id]);
  }));

test('15분 넘게 늦은 알림은 건너뛴다 (서버가 꺼져 있던 동안의 알림), 15분 안이면 보낸다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    await c.put(d.cookie, mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }));
    c.at('2026-11-13T06:16:00Z'); // 15:16 — 16분 늦었다
    assert.equal((await c.tick()).sent, 0);
    assert.equal(c.fake.received.length, 0);

    const t2 = mkTask({ title: '두 번째', dueDate: '2026-11-13', dueTime: '16:00', reminders: ['at'] });
    c.at('2026-11-13T05:00:00Z');
    await c.put(d.cookie, t2);
    c.at('2026-11-13T07:15:00Z'); // 16:15 — 딱 15분 늦었다
    assert.equal((await c.tick()).sent, 1);
  }));

test('서버를 다시 시작해도(스케줄러를 새로 만들어도) 같은 알림은 한 번만 간다 (reminder_log)', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    await c.put(d.cookie, mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }));
    c.at('2026-11-13T06:00:10Z');
    assert.equal((await c.tick()).sent, 1);
    const restarted = createScheduler({ db: c.srv.db, getSender: () => { throw new Error('다시 보내면 안 된다'); }, now: () => new Date('2026-11-13T06:01:00Z') });
    assert.deepEqual(await restarted.tick(), { sent: 0, gone: 0, retry: 0, fail: 0 });
    assert.equal(c.fake.received.length, 1);
  }));

test('반복 할 일: 다음 회차로 넘어가면 새 회차의 알림이 다시 간다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const weekly = mkTask({ title: '주간 회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'], recurrence: { unit: 'week', interval: 1, weekdays: [5] } });
    await c.put(d.cookie, weekly);
    c.at('2026-11-13T06:00:10Z');
    assert.equal((await c.tick()).sent, 1, '이번 회차');
    // 완료하면 기한이 다음 주 금요일로 넘어간다 (done 은 false 유지)
    await c.put(d.cookie, bump(weekly, { dueDate: '2026-11-20' }));
    c.at('2026-11-20T06:00:10Z');
    assert.equal((await c.tick()).sent, 1, '다음 회차는 새 회차 키라서 다시 간다');
    assert.equal(c.sentTo(d.sub).length, 2);
  }, T0));

test('푸시 서비스가 404/410 으로 답하면 그 기기의 구독을 지운다', () =>
  withCtx(async (c) => {
    const d = await c.device('만료된 기기');
    await c.put(d.cookie, mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }));
    c.fake.setStatus(410);
    c.at('2026-11-13T06:00:10Z');
    const r = await c.tick();
    assert.equal(r.gone, 1);
    assert.equal((c.srv.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n, 0);
    c.fake.setStatus(201);
    c.at('2026-11-13T06:00:50Z');
    assert.equal((await c.tick()).sent, 0, '구독이 없으니 더는 보내지 않는다');
  }));

test('푸시 서비스가 429/5xx 로 답하면 기록하지 않고 15분 안에서 다음 tick 에 다시 시도한다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    await c.put(d.cookie, mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }));
    c.fake.setStatus(503);
    c.at('2026-11-13T06:00:10Z');
    assert.deepEqual(await c.tick(), { sent: 0, gone: 0, retry: 1, fail: 0 });
    c.at('2026-11-13T06:00:40Z');
    assert.equal((await c.tick()).retry, 1, '다음 tick 에도 다시 시도한다');
    c.fake.setStatus(201);
    c.at('2026-11-13T06:01:10Z');
    assert.equal((await c.tick()).sent, 1, '복구되면 보낸다');
    c.at('2026-11-13T06:01:40Z');
    assert.equal((await c.tick()).sent, 0);
    // 15분이 지나면 포기한다
    const t2 = mkTask({ title: '두 번째', dueDate: '2026-11-13', dueTime: '17:00', reminders: ['at'] });
    c.at('2026-11-13T07:00:00Z');
    await c.put(d.cookie, t2);
    c.fake.setStatus(500);
    c.at('2026-11-13T08:00:10Z');
    assert.equal((await c.tick()).retry, 1);
    c.at('2026-11-13T08:16:00Z');
    assert.deepEqual(await c.tick(), { sent: 0, gone: 0, retry: 0, fail: 0 }, '15분을 넘기면 시도하지 않는다');
  }));

test('푸시 서비스가 400/403 으로 거절하면 기록하고 다시 보내지 않는다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    await c.put(d.cookie, mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }));
    c.fake.setStatus(403);
    c.at('2026-11-13T06:00:10Z');
    assert.deepEqual(await c.tick(), { sent: 0, gone: 0, retry: 0, fail: 1 });
    c.fake.setStatus(201);
    c.at('2026-11-13T06:00:50Z');
    assert.equal((await c.tick()).sent, 0, '거절당한 알림은 다시 보내지 않는다');
    assert.equal((c.srv.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n, 1, '구독은 그대로');
  }));

test('7일 지난 reminder_log 는 정리하고, 7일 안의 기록은 남긴다 (구독자가 없어도 정리한다)', () =>
  withCtx(async (c) => {
    c.srv.db
      .prepare(`INSERT INTO reminder_log (task_id, due_key, kind, device_id, sent_at) VALUES ('old', 'k', 'at', 'x', '2026-11-05T23:59:59.000Z'), ('edge', 'k', 'at', 'x', '2026-11-06T00:00:01.000Z'), ('recent', 'k', 'at', 'x', '2026-11-12T00:00:00.000Z')`)
      .run();
    await c.tick(); // 지금 11/13 00:00Z → 11/06 00:00Z 보다 앞선 기록을 지운다
    const left = (c.srv.db.prepare('SELECT task_id FROM reminder_log ORDER BY task_id').all() as { task_id: string }[]).map((r) => r.task_id);
    assert.deepEqual(left, ['edge', 'recent']);
  }));

test('기한이 며칠 뒤인 할 일의 하루 전 알림도 그날에 간다 (후보 범위: 서버 오늘의 앞 2일 ~ 뒤 3일)', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    const task = mkTask({ title: '사흘 뒤 일정', dueDate: '2026-11-16', dueTime: null, reminders: ['1d'] }); // 11/15 09:00 서울 = 00:00Z
    await c.put(d.cookie, task);
    c.at('2026-11-14T00:00:30Z');
    assert.equal((await c.tick()).sent, 0, '하루 전(11/15)이 아직 아니다');
    c.at('2026-11-15T00:00:30Z');
    assert.equal((await c.tick()).sent, 1);
  }));

test('겹쳐서 tick 이 불려도 같은 알림이 두 번 가지 않는다', () =>
  withCtx(async (c) => {
    const d = await c.device('iPhone');
    await c.put(d.cookie, mkTask({ title: '회의', dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }));
    c.at('2026-11-13T06:00:10Z');
    const [a, b] = await Promise.all([c.tick(), c.tick()]);
    assert.equal(a.sent + b.sent, 1);
    assert.equal(c.fake.received.length, 1);
  }));

test('VAPID 키 파일을 쓸 수 없어 보낼 수 없으면 스케줄러는 예외 없이 조용히 넘어간다', async () => {
  const fake = await startFakePush();
  const clock = new Date(T0);
  // vapidFile 이 디렉터리라서 읽기도 만들기도 실패한다
  const srv = await startTestServer({ now: () => clock, vapidFile: '/dev/null/not-allowed/vapid.json', push: { allowHosts: [fake.host] } });
  try {
    const d = await srv.pair('iPhone');
    const sub = fake.newSubscription();
    await srv.api('/api/devices/me/push', { method: 'PUT', cookie: d.cookie, body: { subscription: { endpoint: sub.endpoint, keys: sub.keys }, timezone: 'Asia/Seoul' } });
    await srv.api('/api/changes', { cookie: d.cookie, body: { changes: [{ type: 'task', record: mkTask({ dueDate: '2026-11-13', dueTime: '15:00', reminders: ['at'] }) }] } });
    const fixed = new Date('2026-11-13T06:00:10Z');
    const sched = createScheduler({ db: srv.db, getSender: () => { throw new Error('키 파일 없음'); }, now: () => fixed });
    assert.deepEqual(await sched.tick(), { sent: 0, gone: 0, retry: 0, fail: 0 });
    // API 도 서버를 죽이지 않고 503 으로 답한다
    assert.equal((await srv.api('/api/push/key', { cookie: d.cookie })).status, 503);
  } finally {
    await srv.close();
    await fake.close();
  }
});
