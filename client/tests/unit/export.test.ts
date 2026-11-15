import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport } from '../../../shared/export.ts';
import type { Project, Settings, Task } from '../../../shared/task.ts';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const P1 = '10000000-0000-4000-8000-000000000001';
const P_DEAD = '10000000-0000-4000-8000-000000000002';

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    title: `t${id}`,
    dueDate: '2026-11-20',
    dueTime: null,
    projectId: 'inbox',
    priority: 4,
    recurrence: null,
    reminders: [],
    done: false,
    createdAt: `2026-11-0${id}T00:00:00.000Z`,
    deleted: false,
    version: '001762950896789-000001-x',
    updatedBy: 'x',
    ...over,
  };
}
const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: '업무', color: 'blue', createdAt: '2026-11-01T00:00:00.000Z', deleted: false, version: '001762950896789-000001-x', updatedBy: 'x', ...over,
});
const settings: Settings = { id: 'settings', defaultReminderTime: '08:30', version: '001762950896789-000001-x', updatedBy: 'x' };

test('형식: format · schemaVersion · exportedAt · projects · tasks · settings', () => {
  const out = buildExport([project(P1)], [task(1, { projectId: P1 })], settings, NOW);
  assert.equal(out.format, 'todo-export');
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.exportedAt, '2026-11-12T12:00:00.000Z');
  assert.deepEqual(out.projects, [{ id: P1, name: '업무', color: 'blue', createdAt: '2026-11-01T00:00:00.000Z' }]);
  assert.deepEqual(out.settings, { defaultReminderTime: '08:30' });
  assert.equal(out.tasks.length, 1);
});

test('할 일에는 제목·기한 날짜와 시각·프로젝트·우선순위·반복·알림·완료 상태·생성 시각이 모두 들어 있다 (FR-036)', () => {
  const full = task(1, {
    title: '공과금 납부', dueDate: '2026-11-25', dueTime: '09:00', durationMin: 90, projectId: P1, priority: 2,
    recurrence: { unit: 'month', interval: 1, dayOfMonth: 25 }, reminders: ['1d', 'at'], tags: ['집', 'Urgent'], done: false,
  });
  const out = buildExport([project(P1)], [full], settings, NOW);
  assert.deepEqual(out.tasks[0], {
    id: full.id, title: '공과금 납부', dueDate: '2026-11-25', dueTime: '09:00', durationMin: 90, location: null, projectId: P1, priority: 2,
    recurrence: { unit: 'month', interval: 1, dayOfMonth: 25 }, reminders: ['1d', 'at'], tags: ['집', 'Urgent'], done: false, createdAt: full.createdAt,
  });
});

test('툼스톤과 내부 필드(version·updatedBy·dirty·deleted)는 내보내지 않는다', () => {
  const out = buildExport(
    [project(P1), project(P_DEAD, { deleted: true })],
    [task(1), task(2, { deleted: true }), { ...task(3), dirty: 1 } as Task],
    settings,
    NOW,
  );
  assert.deepEqual(out.projects.map((p) => p.id), [P1]);
  assert.deepEqual(out.tasks.map((t) => t.title), ['t1', 't3']);
  for (const t of out.tasks) for (const k of ['version', 'updatedBy', 'dirty', 'deleted']) assert.ok(!(k in t), `${k} 가 있으면 안 된다`);
  for (const p of out.projects) for (const k of ['version', 'updatedBy', 'dirty', 'deleted']) assert.ok(!(k in p), `${k} 가 있으면 안 된다`);
});

test('삭제되었거나 없는 프로젝트를 가리키는 할 일의 projectId 는 inbox 로 정리한다', () => {
  const out = buildExport(
    [project(P1), project(P_DEAD, { deleted: true })],
    [task(1, { projectId: P_DEAD }), task(2, { projectId: '10000000-0000-4000-8000-0000000000ff' }), task(3, { projectId: P1 })],
    settings,
    NOW,
  );
  assert.deepEqual(out.tasks.map((t) => t.projectId), ['inbox', 'inbox', P1]);
});

test('설정이 없으면 기본 알림 시각 09:00', () => {
  assert.deepEqual(buildExport([], [], null, NOW).settings, { defaultReminderTime: '09:00' });
});

test('정렬이 안정적이다: 프로젝트·할 일은 만든 순서(같으면 id)', () => {
  const out = buildExport(
    [project(P_DEAD.replace('2', '9'), { createdAt: '2026-11-03T00:00:00.000Z', name: '나중' }), project(P1, { createdAt: '2026-11-01T00:00:00.000Z', name: '먼저' })],
    [task(3), task(1), task(2)],
    settings,
    NOW,
  );
  assert.deepEqual(out.projects.map((p) => p.name), ['먼저', '나중']);
  assert.deepEqual(out.tasks.map((t) => t.title), ['t1', 't2', 't3']);
});

test('JSON 으로 직렬화했다가 다시 읽어도 같다 (사람이 읽을 수 있는 개방형 형식)', () => {
  const out = buildExport([project(P1)], [task(1, { projectId: P1, recurrence: { unit: 'week', interval: 2, weekdays: [1, 3] } })], settings, NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(out, null, 2)), out);
});
