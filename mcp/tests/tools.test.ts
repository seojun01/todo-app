import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkProject, mkTask } from '../../server/tests/helpers/test-server.ts';
import { addTask, completeTask, deleteTask, listProjects, listTasks, reopenTask, searchTasks, todayIn, updateTask, ToolError } from '../src/tasks.ts';
import { buildTools } from '../src/tools.ts';
import { TODAY, setup, type Json, type Setup } from './helpers.ts';

describe('MCP 도구 (실제 서버 대상)', () => {
  let s: Setup;
  before(async () => {
    s = await setup();
  });
  after(async () => {
    await s.close();
  });

  const titles = (r: Json) => r.tasks.map((t: Json) => t.title);

  it('todayIn: 시간대 기준의 오늘 날짜', () => {
    assert.equal(todayIn('Asia/Seoul', new Date('2026-11-14T16:00:00Z')), '2026-11-15'); // 한국은 이미 다음 날
    assert.equal(todayIn('America/New_York', new Date('2026-11-14T16:00:00Z')), '2026-11-14');
  });

  it('할 일을 추가하면 목록에 나오고, 다른 기기도 같은 레코드를 받는다', async () => {
    const r = (await addTask(s.ctx, { title: '  우유 사기  ', due_date: TODAY, priority: 2, tags: ['#집', '집', '장보기'] })) as Json;
    assert.equal(r.added.title, '우유 사기'); // 앞뒤 공백 정리
    assert.equal(r.added.project, '수신함');
    assert.deepEqual(r.added.tags, ['집', '장보기']); // # 제거, 대소문자 중복 제거
    assert.equal(r.added.priority, 2);

    const list = (await listTasks(s.ctx, {})) as Json;
    assert.ok(titles(list).includes('우유 사기'));

    // 앱의 다른 기기(폰) 입장에서 본 서버 데이터
    const pull = await s.srv.api('/api/changes?since=0', { cookie: s.other.cookie });
    const body = (await pull.json()) as Json;
    const rec = body.changes.find((c: Json) => c.type === 'task' && c.record.title === '우유 사기')?.record;
    assert.ok(rec, '서버에 저장돼 있어야 해요');
    assert.equal(rec.updatedBy, s.ctx.deviceId);
    assert.equal(rec.deleted, false);
  });

  it('프로젝트 이름으로 추가·필터하고, 없는 프로젝트는 오류', async () => {
    const proj = mkProject({ name: '업무' });
    const res = await s.srv.api('/api/changes', { cookie: s.other.cookie, body: { changes: [{ type: 'project', record: proj }] } });
    assert.equal(res.status, 200);

    const r = (await addTask(s.ctx, { title: '보고서 쓰기', project: '업무' })) as Json;
    assert.equal(r.added.project, '업무');
    const only = (await listTasks(s.ctx, { scope: 'all', project: '업무' })) as Json;
    assert.deepEqual(titles(only), ['보고서 쓰기']);

    await assert.rejects(addTask(s.ctx, { title: 'x', project: '없는곳' }), (e: Error) => e instanceof ToolError && /없는 프로젝트/.test(e.message) && /업무/.test(e.message));

    const projects = (await listProjects(s.ctx)) as Json;
    assert.ok(projects.projects.some((p: Json) => p.name === '업무' && p.open_tasks === 1));
    assert.equal(projects.projects[0].name, '수신함');
  });

  it('검증 오류는 알아볼 수 있는 문장으로 돌려준다', async () => {
    await assert.rejects(addTask(s.ctx, { title: '' }), ToolError);
    await assert.rejects(addTask(s.ctx, { title: '시각만', due_time: '09:00' }), (e: Error) => /due_time: requires-dueDate/.test(e.message));
    await assert.rejects(addTask(s.ctx, { title: '잘못된 날짜', due_date: '2026-02-30' }), (e: Error) => /due_date: format/.test(e.message));
    await assert.rejects(addTask(s.ctx, { title: '우선순위', priority: 5 }), (e: Error) => e instanceof ToolError && /priority/.test(e.message));
  });

  it('scope 별 목록: today(기한 지남 먼저)·upcoming·overdue·no_date', async () => {
    const t = await setup();
    try {
      await addTask(t.ctx, { title: '어제', due_date: '2026-11-13' });
      await addTask(t.ctx, { title: '오늘 낮은 우선순위', due_date: TODAY, priority: 4 });
      await addTask(t.ctx, { title: '오늘 높은 우선순위', due_date: TODAY, priority: 1 });
      await addTask(t.ctx, { title: '내일', due_date: '2026-11-15' });
      await addTask(t.ctx, { title: '열흘 뒤', due_date: '2026-11-24' });
      await addTask(t.ctx, { title: '기한 없음' });

      assert.deepEqual(titles(await listTasks(t.ctx, {})), ['어제', '오늘 높은 우선순위', '오늘 낮은 우선순위']);
      assert.equal(((await listTasks(t.ctx, {})) as Json).tasks[0].overdue, true);
      assert.deepEqual(titles(await listTasks(t.ctx, { scope: 'upcoming' })), ['내일']);
      assert.deepEqual(titles(await listTasks(t.ctx, { scope: 'upcoming', days: 30 })), ['내일', '열흘 뒤']);
      assert.deepEqual(titles(await listTasks(t.ctx, { scope: 'overdue' })), ['어제']);
      assert.deepEqual(titles(await listTasks(t.ctx, { scope: 'no_date' })), ['기한 없음']);
      assert.equal(((await listTasks(t.ctx, { scope: 'all' })) as Json).total, 6);
      const limited = (await listTasks(t.ctx, { scope: 'all', limit: 2 })) as Json;
      assert.equal(limited.shown, 2);
      assert.equal(limited.total, 6);
      await assert.rejects(listTasks(t.ctx, { scope: 'weird' }), ToolError);
    } finally {
      await t.close();
    }
  });

  it('검색: 제목·태그, 완료 포함 여부', async () => {
    const t = await setup();
    try {
      await addTask(t.ctx, { title: '치과 예약', tags: ['건강'] });
      const done = (await addTask(t.ctx, { title: '치과 영수증 정리' })) as Json;
      await completeTask(t.ctx, { id: done.added.id });
      assert.deepEqual(titles(await searchTasks(t.ctx, { query: '치과' })), ['치과 예약']);
      assert.equal(((await searchTasks(t.ctx, { query: '치과', include_completed: true })) as Json).total, 2);
      assert.deepEqual(titles(await searchTasks(t.ctx, { query: '#건강' })), ['치과 예약']);
    } finally {
      await t.close();
    }
  });

  it('수정: 넘긴 항목만 바뀌고, id 앞부분으로도 찾는다', async () => {
    const r = (await addTask(s.ctx, { title: '수정 대상', due_date: '2026-11-20', priority: 3 })) as Json;
    const u = (await updateTask(s.ctx, { id: r.added.id.slice(0, 8), title: '수정됨', priority: 1 })) as Json;
    assert.equal(u.updated.title, '수정됨');
    assert.equal(u.updated.priority, 1);
    assert.equal(u.updated.due, '2026-11-20'); // 그대로
    await assert.rejects(updateTask(s.ctx, { id: r.added.id }), (e: Error) => /바꿀 항목이 없어요/.test(e.message));
    await assert.rejects(updateTask(s.ctx, { id: '00000000-0000-4000-8000-000000000000', title: 'x' }), (e: Error) => /그런 할 일이 없어요/.test(e.message));
  });

  it('기한을 지우면 시각·반복·알림도 지워진다', async () => {
    const r = (await addTask(s.ctx, {
      title: '기한 딸린 것들',
      due_date: '2026-11-20',
      due_time: '15:00',
      reminders: ['at', '1d'],
      recurrence: { unit: 'week', interval: 1, weekdays: [5] },
    })) as Json;
    assert.equal(r.added.due, '2026-11-20 15:00');
    assert.equal(r.added.repeat, '매주 금요일');
    const u = (await updateTask(s.ctx, { id: r.added.id, due_date: null })) as Json;
    assert.equal(u.updated.due, null);
    assert.equal(u.updated.reminders, undefined);
    assert.equal(u.updated.repeat, undefined);
  });

  it('시각을 없애면 시각 기준 알림을 날짜 기준으로 맞춘다 (오류 없이)', async () => {
    const r = (await addTask(s.ctx, { title: '시각 있던 것', due_date: '2026-11-20', due_time: '15:00', reminders: ['at', '1d'] })) as Json;
    const u = (await updateTask(s.ctx, { id: r.added.id, due_time: null })) as Json;
    assert.equal(u.updated.due, '2026-11-20');
    for (const k of u.updated.reminders ?? []) assert.ok(['day', '1d'].includes(k), `날짜 기준 알림이어야 해요: ${k}`);
  });

  it('길이: 시각과 함께 정하고 바꿀 수 있고, 시각을 없애면 함께 지워지며, 잘못된 값은 오류다', async () => {
    const r = (await addTask(s.ctx, { title: '수업', due_date: '2026-11-20', due_time: '13:00', duration_minutes: 120 })) as Json;
    assert.equal(r.added.duration_minutes, 120);
    const noLen = (await addTask(s.ctx, { title: '길이 없음', due_date: '2026-11-20', due_time: '13:00' })) as Json;
    assert.equal(noLen.added.duration_minutes, undefined);
    const u = (await updateTask(s.ctx, { id: r.added.id, duration_minutes: 45 })) as Json;
    assert.equal(u.updated.duration_minutes, 45);
    const moved = (await updateTask(s.ctx, { id: r.added.id, due_time: '15:00' })) as Json;
    assert.equal(moved.updated.duration_minutes, 45, '시각만 바꾸면 길이는 그대로');
    const cleared = (await updateTask(s.ctx, { id: r.added.id, duration_minutes: null })) as Json;
    assert.equal(cleared.updated.duration_minutes, undefined);
    const again = (await addTask(s.ctx, { title: '다시', due_date: '2026-11-20', due_time: '13:00', duration_minutes: 60 })) as Json;
    const noTime = (await updateTask(s.ctx, { id: again.added.id, due_time: null })) as Json;
    assert.equal(noTime.updated.duration_minutes, undefined, '시각을 없애면 길이도 없다');
    await assert.rejects(addTask(s.ctx, { title: '시각 없는 길이', due_date: '2026-11-20', duration_minutes: 60 }), (e: Error) => /durationMin: requires-dueTime/.test(e.message));
    await assert.rejects(addTask(s.ctx, { title: '자정 넘김', due_date: '2026-11-20', due_time: '23:30', duration_minutes: 60 }), (e: Error) => /durationMin: crosses-midnight/.test(e.message));
  });

  it('끝 시각: end_time 으로 길이를 정하고, 목록에 끝 시각이 보이며, 잘못된 값은 오류다', async () => {
    const r = (await addTask(s.ctx, { title: '회의', due_date: '2026-11-20', due_time: '14:00', end_time: '16:30' })) as Json;
    assert.equal(r.added.duration_minutes, 150);
    assert.equal(r.added.end_time, '16:30');
    const moved = (await updateTask(s.ctx, { id: r.added.id, due_time: '15:00' })) as Json;
    assert.equal(moved.updated.end_time, '17:30', '시작만 바꾸면 길이가 유지돼 끝도 밀린다');
    const both = (await updateTask(s.ctx, { id: r.added.id, due_time: '09:00', end_time: '09:45' })) as Json;
    assert.equal(both.updated.due, '2026-11-20 09:00');
    assert.equal(both.updated.duration_minutes, 45, '바뀐 시작 시각 기준으로 계산');
    const end = (await updateTask(s.ctx, { id: r.added.id, end_time: '12:00' })) as Json;
    assert.equal(end.updated.end_time, '12:00');
    const cleared = (await updateTask(s.ctx, { id: r.added.id, end_time: null })) as Json;
    assert.equal(cleared.updated.end_time, undefined);
    const noLen = (await addTask(s.ctx, { title: '시작만', due_date: '2026-11-20', due_time: '13:00' })) as Json;
    assert.equal(noLen.added.end_time, undefined);
    await assert.rejects(addTask(s.ctx, { title: '거꾸로', due_date: '2026-11-20', due_time: '14:00', end_time: '13:00' }), (e: Error) => /시작 시각.*보다 늦어야/.test(e.message));
    await assert.rejects(addTask(s.ctx, { title: '시작 없음', due_date: '2026-11-20', end_time: '13:00' }), (e: Error) => /due_time/.test(e.message));
    await assert.rejects(addTask(s.ctx, { title: '형식', due_date: '2026-11-20', due_time: '13:00', end_time: '25:00' }), (e: Error) => /HH:MM/.test(e.message));
    await assert.rejects(addTask(s.ctx, { title: '둘 다', due_date: '2026-11-20', due_time: '13:00', end_time: '14:00', duration_minutes: 60 }), (e: Error) => /둘 중 하나/.test(e.message));
  });

  it('장소: location 으로 정하고 바꾸고 지울 수 있고, 검색에도 걸린다', async () => {
    const r = (await addTask(s.ctx, { title: '미팅', due_date: '2026-11-20', due_time: '14:00', location: '  강남역 2번 출구 ' })) as Json;
    assert.equal(r.added.title, '미팅');
    assert.equal(r.added.location, '강남역 2번 출구');
    const found = (await searchTasks(s.ctx, { query: '강남' })) as Json;
    assert.ok(JSON.stringify(found).includes(r.added.id));
    const u = (await updateTask(s.ctx, { id: r.added.id, location: '판교' })) as Json;
    assert.equal(u.updated.location, '판교');
    const kept = (await updateTask(s.ctx, { id: r.added.id, title: '팀 미팅' })) as Json;
    assert.equal(kept.updated.location, '판교', '다른 항목만 바꾸면 장소는 그대로');
    const cleared = (await updateTask(s.ctx, { id: r.added.id, location: null })) as Json;
    assert.equal(cleared.updated.location, undefined);
    await assert.rejects(addTask(s.ctx, { title: '긴 장소', location: 'x'.repeat(201) }), (e: Error) => /location: length/.test(e.message));
  });

  it('완료: 일반 할 일은 done, 이미 완료면 알려 준다, 다시 열 수 있다', async () => {
    const r = (await addTask(s.ctx, { title: '한 번만 할 일', due_date: TODAY })) as Json;
    const c = (await completeTask(s.ctx, { id: r.added.id })) as Json;
    assert.equal(c.task.done, true);
    assert.ok(!titles(await listTasks(s.ctx, {})).includes('한 번만 할 일'));
    assert.ok(titles(await listTasks(s.ctx, { include_completed: true })).includes('한 번만 할 일'));
    assert.match(((await completeTask(s.ctx, { id: r.added.id })) as Json).message, /이미 완료/);
    const o = (await reopenTask(s.ctx, { id: r.added.id })) as Json;
    assert.equal(o.task.done, false);
  });

  it('반복 할 일을 완료하면 미완료로 남은 채 다음 회차로 넘어간다', async () => {
    const r = (await addTask(s.ctx, { title: '매일 약 먹기', due_date: TODAY, recurrence: { unit: 'day', interval: 1 } })) as Json;
    const c = (await completeTask(s.ctx, { id: r.added.id })) as Json;
    assert.equal(c.task.done, false);
    assert.equal(c.task.due, '2026-11-15');
    assert.match(c.message, /다음 기한\(2026-11-15\)/);
  });

  it('반복이 끝나는 날을 넘기면 완료 처리한다', async () => {
    const r = (await addTask(s.ctx, { title: '오늘이 마지막', due_date: TODAY, recurrence: { unit: 'day', interval: 1, end_date: TODAY } })) as Json;
    const c = (await completeTask(s.ctx, { id: r.added.id })) as Json;
    assert.equal(c.task.done, true);
  });

  it('삭제하면 목록에서 사라지고 서버에는 삭제 표시(툼스톤)가 남는다', async () => {
    const r = (await addTask(s.ctx, { title: '지울 것', due_date: TODAY })) as Json;
    await deleteTask(s.ctx, { id: r.added.id });
    assert.ok(!titles(await listTasks(s.ctx, { scope: 'all', include_completed: true })).includes('지울 것'));
    await assert.rejects(deleteTask(s.ctx, { id: r.added.id }), (e: Error) => /그런 할 일이 없어요/.test(e.message));
    const pull = (await (await s.srv.api('/api/changes?since=0', { cookie: s.other.cookie })).json()) as Json;
    const rec = pull.changes.find((c: Json) => c.type === 'task' && c.record.id === r.added.id).record;
    assert.equal(rec.deleted, true);
  });

  it('앱(다른 기기)에서 바꾼 것이 MCP 에 보이고, 시계가 앞선 기기의 레코드도 이길 수 있다', async () => {
    // 다른 기기의 시계가 아주 앞서 있는 경우 (2100년 버전)
    const future = mkTask({ title: '미래 버전', dueDate: TODAY, version: '004102444800000-000000-phone', updatedBy: 'phone' });
    const res = await s.srv.api('/api/changes', { cookie: s.other.cookie, body: { changes: [{ type: 'task', record: future }] } });
    assert.equal(res.status, 200);
    assert.ok(titles(await listTasks(s.ctx, {})).includes('미래 버전'));
    // 내 시계가 뒤쳐져 있어도 receive 로 더 큰 버전을 만들어서 반영된다
    const u = (await updateTask(s.ctx, { id: future.id, title: '미래 버전 수정' })) as Json;
    assert.equal(u.updated.title, '미래 버전 수정');
    const pull = (await (await s.srv.api('/api/changes?since=0', { cookie: s.other.cookie })).json()) as Json;
    assert.equal(pull.changes.find((c: Json) => c.record.id === future.id).record.title, '미래 버전 수정');
  });

  it('읽기 전용 모드에서는 쓰기 도구를 아예 내놓지 않는다', () => {
    const all = buildTools(() => s.ctx, { readOnly: false }).map((t) => t.name);
    const ro = buildTools(() => s.ctx, { readOnly: true }).map((t) => t.name);
    assert.deepEqual(ro, ['list_tasks', 'search_tasks', 'list_projects']);
    for (const w of ['add_task', 'update_task', 'complete_task', 'reopen_task', 'delete_task']) {
      assert.ok(all.includes(w));
      assert.ok(!ro.includes(w));
    }
  });
});
