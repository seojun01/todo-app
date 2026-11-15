import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, mkProject, mkSettings, mkTask, type TestServer } from '../helpers/test-server.ts';

let s: TestServer;
let cookie: string;
let now = new Date('2026-11-12T09:00:00.000Z');
before(async () => {
  s = await startTestServer({ now: () => now });
  ({ cookie } = await s.pair());
});
after(async () => {
  await s.close();
});

type Change = { type: 'task' | 'project' | 'settings'; record: Record<string, any> };
const push = (changes: Change[]) => s.api('/api/changes', { cookie, body: { changes } });
const pull = async (since = 0, limit?: number) => {
  const res = await s.api(`/api/changes?since=${since}${limit ? `&limit=${limit}` : ''}`, { cookie });
  assert.equal(res.status, 200);
  return (await res.json()) as { changes: Change[]; cursor: number; hasMore: boolean };
};
const armedAt = (id: string) => (s.db.prepare('SELECT armed_at FROM tasks WHERE id = ?').get(id) as { armed_at: string }).armed_at;

test('계약 6: task·project·settings 를 push 한 뒤 pull(since=0) 하면 seq 순서로 같은 레코드가 나온다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const task = mkTask();
  const project = mkProject();
  const settings = mkSettings({ defaultReminderTime: '08:30' });
  const res = await srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: task }, { type: 'project', record: project }, { type: 'settings', record: settings }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { applied: 3, ignored: 0, cursor: 3 });

  const got = (await (await srv.api('/api/changes?since=0', { cookie: c })).json()) as { changes: Change[]; cursor: number; hasMore: boolean };
  assert.deepEqual(got.changes.map((x) => x.type), ['task', 'project', 'settings']);
  assert.deepEqual(got.changes[0]!.record, task);
  assert.deepEqual(got.changes[1]!.record, project);
  assert.deepEqual(got.changes[2]!.record, settings);
  assert.equal(got.cursor, 3);
  assert.equal(got.hasMore, false);

  // since 이후만
  const after2 = (await (await srv.api('/api/changes?since=2', { cookie: c })).json()) as { changes: Change[]; cursor: number };
  assert.deepEqual(after2.changes.map((x) => x.type), ['settings']);
  const empty = (await (await srv.api('/api/changes?since=3', { cookie: c })).json()) as { changes: Change[]; cursor: number };
  assert.deepEqual(empty.changes, []);
  assert.equal(empty.cursor, 3);
  await srv.close();
});

test('계약 7: version 이 더 작은 레코드를 push 하면 ignored 이고 저장값은 바뀌지 않는다', async () => {
  const t = mkTask({ title: '원본', version: '001762950896789-000010-dev' });
  assert.equal((await push([{ type: 'task', record: t }])).status, 200);
  const older = { ...t, title: '오래된 변경', version: '001762950896789-000009-dev' };
  const res = await push([{ type: 'task', record: older }]);
  const body = (await res.json()) as { applied: number; ignored: number };
  assert.equal(body.applied, 0);
  assert.equal(body.ignored, 1);
  const stored = (await pull(0)).changes.find((c) => c.record.id === t.id)!;
  assert.equal(stored.record.title, '원본');
  // 같은 version 도 ignored
  const same = await push([{ type: 'task', record: { ...t, title: '같은 버전' } }]);
  assert.equal(((await same.json()) as { ignored: number }).ignored, 1);
  // 더 큰 version 은 반영
  const newer = { ...t, title: '새 변경', version: '001762950896789-000011-dev' };
  assert.equal(((await (await push([{ type: 'task', record: newer }])).json()) as { applied: number }).applied, 1);
});

test('계약 8: 같은 push 를 두 번 보내면 두 번째는 applied=0', async () => {
  const changes: Change[] = [{ type: 'task', record: mkTask() }, { type: 'project', record: mkProject() }];
  const first = (await (await push(changes)).json()) as { applied: number; cursor: number };
  const second = (await (await push(changes)).json()) as { applied: number; ignored: number; cursor: number };
  assert.equal(first.applied, 2);
  assert.equal(second.applied, 0);
  assert.equal(second.ignored, 2);
  assert.equal(second.cursor, first.cursor, 'ignored 는 seq 를 올리지 않는다');
});

const INVALID: [string, Change][] = [
  ['제목 0자', { type: 'task', record: mkTask({ title: '' }) }],
  ['제목 201자', { type: 'task', record: mkTask({ title: 'a'.repeat(201) }) }],
  ['제목이 공백뿐', { type: 'task', record: mkTask({ title: '   ' }) }],
  ['제목 앞뒤 공백', { type: 'task', record: mkTask({ title: ' x ' }) }],
  ['날짜 2026-02-30', { type: 'task', record: mkTask({ dueDate: '2026-02-30' }) }],
  ['dueTime 만 있고 dueDate 없음', { type: 'task', record: mkTask({ dueDate: null, dueTime: '09:00' }) }],
  ['반복인데 dueDate 없음', { type: 'task', record: mkTask({ dueDate: null, recurrence: { unit: 'day', interval: 1 } }) }],
  ['우선순위 5', { type: 'task', record: mkTask({ priority: 5 }) }],
  ['프로젝트 이름 51자', { type: 'project', record: mkProject({ name: 'p'.repeat(51) }) }],
  ['알 수 없는 색상', { type: 'project', record: mkProject({ color: 'pink' }) }],
  ['주 단위 반복인데 weekdays 없음', { type: 'task', record: mkTask({ recurrence: { unit: 'week', interval: 1 } }) }],
  ['시각 없는데 정시 알림', { type: 'task', record: mkTask({ dueTime: null, reminders: ['at'] }) }],
  ['시각 있는데 당일 알림', { type: 'task', record: mkTask({ dueTime: '10:00', reminders: ['day'] }) }],
  ['알림 중복', { type: 'task', record: mkTask({ dueTime: '10:00', reminders: ['at', 'at'] }) }],
  ['기본 알림 시각 형식 오류', { type: 'settings', record: mkSettings({ defaultReminderTime: '9:00' }) }],
  ['알 수 없는 type', { type: 'comment' as never, record: { id: 'x' } }],
];

test('계약 9: 검증에 실패하면 400 이고 같은 요청의 다른 레코드도 반영되지 않는다 (전체 롤백)', async () => {
  const before = (await pull(0)).cursor;
  for (const [name, bad] of INVALID) {
    const good = mkTask({ title: `롤백 확인: ${name}` });
    const res = await push([{ type: 'task', record: good }, bad]);
    assert.equal(res.status, 400, name);
    const body = (await res.json()) as { error: string; details?: { type: string; id: string; field: string; rule: string }[] };
    assert.equal(body.error, 'validation', name);
    assert.ok(Array.isArray(body.details) && body.details.length > 0, `${name}: details`);
    const all = (await pull(0)).changes;
    assert.ok(!all.some((c) => c.record.id === good.id), `${name}: 좋은 레코드도 롤백되어야 한다`);
  }
  assert.equal((await pull(0)).cursor, before, 'seq 도 올라가지 않는다');
});

test('changes 가 0개이거나 501개이면 400', async () => {
  assert.equal((await push([])).status, 400);
  const many = Array.from({ length: 501 }, () => ({ type: 'task' as const, record: mkTask() }));
  assert.equal((await push(many)).status, 400);
  const ok = Array.from({ length: 500 }, () => ({ type: 'task' as const, record: mkTask() }));
  assert.equal((await push(ok)).status, 200);
});

test('계약 10: limit 페이지 나누기를 따라가도 레코드가 빠지거나 중복되지 않고 종류가 섞여도 seq 순서가 유지된다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const records: Change[] = [];
  for (let i = 0; i < 6; i++) records.push({ type: 'task', record: mkTask() });
  for (let i = 0; i < 3; i++) records.push({ type: 'project', record: mkProject() });
  records.push({ type: 'settings', record: mkSettings() });
  // 섞어서 여러 번에 나눠 push
  const order = [...records].sort(() => 0.5 - Math.random());
  for (let i = 0; i < order.length; i += 3) {
    assert.equal((await srv.api('/api/changes', { cookie: c, body: { changes: order.slice(i, i + 3) } })).status, 200);
  }
  const seen: string[] = [];
  let since = 0;
  let pages = 0;
  for (;;) {
    const page = (await (await srv.api(`/api/changes?since=${since}&limit=3`, { cookie: c })).json()) as { changes: Change[]; cursor: number; hasMore: boolean };
    pages++;
    for (const ch of page.changes) seen.push(`${ch.type}:${ch.record.id}`);
    assert.ok(page.cursor >= since);
    since = page.cursor;
    if (!page.hasMore) break;
    assert.ok(pages < 20, '무한 반복');
  }
  assert.equal(seen.length, records.length);
  assert.equal(new Set(seen).size, records.length, '중복 없음');
  assert.deepEqual(seen, order.map((r) => `${r.type}:${r.record.id}`), 'push 한 순서(= seq 순서)대로');
  await srv.close();
});

test('limit 은 최대 1000, since 는 0 이상 정수', async () => {
  assert.equal((await s.api('/api/changes?since=-1', { cookie })).status, 400);
  assert.equal((await s.api('/api/changes?since=abc', { cookie })).status, 400);
  assert.equal((await s.api('/api/changes?since=0&limit=5000', { cookie })).status, 200); // 1000 으로 제한
});

test('armed_at: 기한·시각·알림·완료·반복이 바뀔 때만 갱신된다 (제목·우선순위·프로젝트만 바뀌면 유지)', async () => {
  const srv = await startTestServer({ now: () => now });
  const { cookie: c } = await srv.pair();
  const p = (rec: Record<string, any>) => srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: rec }] } });
  const armed = (id: string) => (srv.db.prepare('SELECT armed_at FROM tasks WHERE id = ?').get(id) as { armed_at: string }).armed_at;
  let ver = 100;
  const bump = (rec: Record<string, any>, over: Record<string, any>) => ({ ...rec, ...over, version: `001762950896789-${String(++ver).padStart(6, '0')}-dev` });

  now = new Date('2026-11-12T09:00:00.000Z');
  const t0 = mkTask({ dueTime: '15:00', reminders: ['at'], version: `001762950896789-${String(ver).padStart(6, '0')}-dev` });
  await p(t0);
  const created = armed(t0.id);
  assert.equal(created, '2026-11-12T09:00:00.000Z', '새 레코드는 만든 시각');

  now = new Date('2026-11-12T10:00:00.000Z');
  const unchanged = [{ title: '제목만' }, { priority: 1 }, { projectId: crypto.randomUUID() }, { deleted: true }];
  let cur = t0 as Record<string, any>;
  for (const ch of unchanged) {
    cur = bump(cur, ch);
    if ('projectId' in ch) cur = { ...cur };
    await p(cur);
    assert.equal(armed(t0.id), created, `${JSON.stringify(ch)} 는 armed_at 을 바꾸지 않는다`);
  }
  cur = bump(cur, { deleted: false });

  const affecting: [string, Record<string, any>][] = [
    ['dueDate', { dueDate: '2026-11-21' }],
    ['dueTime', { dueTime: '16:00' }],
    ['reminders', { reminders: ['at', '10m'] }],
    ['done', { done: true }],
    ['recurrence', { recurrence: { unit: 'day', interval: 2 }, done: false }],
  ];
  let minute = 0;
  for (const [name, ch] of affecting) {
    minute += 1;
    now = new Date(`2026-11-12T11:${String(minute).padStart(2, '0')}:00.000Z`);
    cur = bump(cur, ch);
    await p(cur);
    assert.equal(armed(t0.id), now.toISOString(), `${name} 변경은 armed_at 을 갱신한다`);
  }
  await srv.close();
  void armedAt;
});

test('태그: push 한 tags 는 pull 로 그대로 나오고, tags 없이 올린 옛 클라이언트의 레코드는 빈 목록이 된다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const push = (rec: Record<string, any>) => srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: rec }] } });
  const pull = async () => ((await (await srv.api('/api/changes?since=0', { cookie: c })).json()) as { changes: { record: any }[] }).changes.map((x) => x.record);

  const tagged = mkTask({ tags: ['집', 'Urgent'] });
  assert.equal((await push(tagged)).status, 200);
  const { tags: _omit, ...legacy } = mkTask({ title: '옛 앱' });
  assert.equal((await push(legacy)).status, 200, 'tags 가 없어도 받는다');

  const out = await pull();
  assert.deepEqual(out.find((r) => r.id === tagged.id)!.tags, ['집', 'Urgent']);
  assert.deepEqual(out.find((r) => r.id === legacy.id)!.tags, []);

  // 수정으로 태그를 바꿀 수 있다
  const next = { ...tagged, tags: ['업무'], version: '001762950896789-999999-dev' };
  assert.equal((await push(next)).status, 200);
  assert.deepEqual((await pull()).find((r) => r.id === tagged.id)!.tags, ['업무']);
  await srv.close();
});

test('길이: push 한 durationMin 은 pull 로 그대로 나오고, 없이 올린 옛 클라이언트의 레코드는 null 이다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const push = (rec: Record<string, any>) => srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: rec }] } });
  const pull = async () => ((await (await srv.api('/api/changes?since=0', { cookie: c })).json()) as { changes: { record: any }[] }).changes.map((x) => x.record);

  const timed = mkTask({ dueTime: '13:00', durationMin: 120 });
  assert.equal((await push(timed)).status, 200);
  const { durationMin: _omit, ...legacy } = mkTask({ title: '옛 앱', dueTime: '09:00' });
  assert.equal((await push(legacy)).status, 200, 'durationMin 이 없어도 받는다');
  const out = await pull();
  assert.equal(out.find((r) => r.id === timed.id)!.durationMin, 120);
  assert.equal(out.find((r) => r.id === legacy.id)!.durationMin, null);

  // 옮기고 늘리기: 길이를 바꿔 다시 올리면 반영된다
  assert.equal((await push({ ...timed, durationMin: 45, version: '001762950896789-999999-dev' })).status, 200);
  assert.equal((await pull()).find((r) => r.id === timed.id)!.durationMin, 45);
  await srv.close();
});

test('장소: push 한 location 은 pull 로 나오고, location 없이 올린 옛 기기의 수정은 저장된 장소를 지우지 않으며, null 은 지운다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const push = (rec: Record<string, any>) => srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: rec }] } });
  const pull = async () => ((await (await srv.api('/api/changes?since=0', { cookie: c })).json()) as { changes: { record: any }[] }).changes.map((x) => x.record);

  const t = mkTask({ title: '미팅', location: '강남역' });
  assert.equal((await push(t)).status, 200);
  assert.equal((await pull()).find((r) => r.id === t.id)!.location, '강남역');
  const { location: _omit, ...legacy } = { ...t, title: '미팅 (옛 앱에서 고침)', version: '001762950896789-999998-dev' } as Record<string, unknown>;
  assert.equal((await push(legacy)).status, 200);
  const after = (await pull()).find((r) => r.id === t.id)!;
  assert.equal(after.title, '미팅 (옛 앱에서 고침)');
  assert.equal(after.location, '강남역', '옛 기기가 고쳐도 장소는 남는다');
  assert.equal((await push({ ...t, location: null, version: '001762950896789-999999-dev' })).status, 200);
  assert.equal((await pull()).find((r) => r.id === t.id)!.location, undefined);
  for (const bad of [' 앞공백', '', 'x'.repeat(201), 3]) {
    assert.equal((await push(mkTask({ location: bad }))).status, 400, JSON.stringify(bad));
  }
  await srv.close();
});

test('길이: 잘못된 길이(시각 없음·범위 밖·자정 넘김)는 400 이고 아무것도 반영하지 않는다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const cases = [{ dueTime: null, durationMin: 60 }, { dueTime: '09:00', durationMin: 2 }, { dueTime: '09:00', durationMin: 1440 }, { dueTime: '23:30', durationMin: 60 }, { dueTime: '09:00', durationMin: 'x' }];
  for (const c2 of cases) {
    const res = await srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: mkTask(c2) }] } });
    assert.equal(res.status, 400, JSON.stringify(c2));
    const body = (await res.json()) as { details: { field: string }[] };
    assert.ok(body.details.some((d) => d.field === 'durationMin'));
  }
  const pulled = (await (await srv.api('/api/changes?since=0', { cookie: c })).json()) as { changes: unknown[] };
  assert.equal(pulled.changes.length, 0);
  await srv.close();
});

test('태그: 잘못된 태그가 하나라도 있으면 400 이고 아무것도 반영하지 않는다', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  for (const tags of [['공 백'], ['a,b'], ['#x'], Array.from({ length: 11 }, (_, i) => `t${i}`), ['A', 'a'], 'not-an-array']) {
    const res = await srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: mkTask({ tags }) }] } });
    assert.equal(res.status, 400, JSON.stringify(tags));
    const body = (await res.json()) as { details: { field: string }[] };
    assert.ok(body.details.some((d) => d.field === 'tags'));
  }
  assert.equal((srv.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
  await srv.close();
});

test('순서: push 한 sortKey 는 pull 로 그대로 나오고, 정한 적 없는 레코드에는 필드가 없다. 잘못된 키는 400', async () => {
  const srv = await startTestServer();
  const { cookie: c } = await srv.pair();
  const push = (rec: Record<string, any>) => srv.api('/api/changes', { cookie: c, body: { changes: [{ type: 'task', record: rec }] } });
  const pull = async () => ((await (await srv.api('/api/changes?since=0', { cookie: c })).json()) as { changes: { record: any }[] }).changes.map((x) => x.record);

  const ordered = mkTask({ sortKey: 'i' });
  const plain = mkTask({ title: '순서 없음' });
  assert.equal((await push(ordered)).status, 200);
  assert.equal((await push(plain)).status, 200);
  let out = await pull();
  assert.equal(out.find((r) => r.id === ordered.id)!.sortKey, 'i');
  assert.equal('sortKey' in out.find((r) => r.id === plain.id)!, false);

  assert.equal((await push({ ...ordered, sortKey: '3', version: '001762950896789-999999-dev' })).status, 200);
  out = await pull();
  assert.equal(out.find((r) => r.id === ordered.id)!.sortKey, '3');

  for (const bad of ['', 'A', 'a0', 'x'.repeat(65), 5]) {
    assert.equal((await push(mkTask({ sortKey: bad as any }))).status, 400, JSON.stringify(bad));
  }
  await srv.close();
});
