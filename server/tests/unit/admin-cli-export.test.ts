import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.ts';
import { applyChanges } from '../../src/sync.ts';
import { mkProject, mkSettings, mkTask } from '../helpers/test-server.ts';

let dir = '';
let dbFile = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-cli-export-'));
  dbFile = join(dir, 'todo.db');
});

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--no-warnings', 'server/src/admin-cli.ts', ...args], { env: { ...process.env, TODO_DB: dbFile }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function seed() {
  const project = mkProject({ name: '업무' });
  const dead = mkProject({ name: '삭제됨', deleted: true });
  const live = mkTask({ title: '살아 있는 일', projectId: project.id, priority: 1, dueTime: '09:00', reminders: ['at'], tags: ['집'], recurrence: { unit: 'week', interval: 1, weekdays: [1] } });
  const gone = mkTask({ title: '삭제된 일', deleted: true });
  const db = openDb(dbFile);
  applyChanges(db, {
    changes: [
      { type: 'project', record: project }, { type: 'project', record: dead },
      { type: 'task', record: live }, { type: 'task', record: gone },
      { type: 'settings', record: mkSettings({ defaultReminderTime: '07:45' }) },
    ],
  });
  db.close();
  return { project, live };
}

test('export: 서버의 기준 사본을 내보내기 형식으로 stdout 에 출력한다 (내부 필드 제외)', () => {
  const { project, live } = seed();
  const r = cli('export');
  assert.equal(r.status, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.format, 'todo-export');
  assert.equal(out.schemaVersion, 1);
  assert.deepEqual(out.projects.map((p: { id: string }) => p.id), [project.id]);
  assert.equal(out.tasks.length, 1);
  assert.deepEqual(out.tasks[0], {
    id: live.id, title: '살아 있는 일', dueDate: '2026-11-20', dueTime: '09:00', projectId: project.id, priority: 1,
    recurrence: { unit: 'week', interval: 1, weekdays: [1] }, reminders: ['at'], tags: ['집'], done: false, createdAt: live.createdAt,
  });
  assert.deepEqual(out.settings, { defaultReminderTime: '07:45' });
  assert.ok(!r.out.includes('armed_at') && !r.out.includes('armedAt'), '서버 내부 필드가 없어야 한다');
});

test('export --out: 파일에 쓴다', () => {
  seed();
  const file = join(dir, 'out.json');
  const r = cli('export', '--out', file);
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tasks.length, 1);
  assert.equal(r.out.trim(), '', '--out 이면 stdout 에는 내용을 쓰지 않는다');
});

test('backup: 서비스를 멈추지 않고(DB 가 열려 있어도) SQLite 백업을 만든다', () => {
  seed();
  const live = openDb(dbFile); // 서비스가 DB 를 열고 있는 상황
  const dest = join(dir, 'backup.db');
  const r = cli('backup', dest);
  assert.equal(r.status, 0, r.err);
  assert.ok(existsSync(dest));
  const copy = openDb(dest);
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 2, '툼스톤 포함 서버 기준 사본 그대로');
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, 2);
  copy.close();
  live.close();
});

test('backup: 파일이 이미 있거나 경로를 주지 않으면 실패한다', () => {
  seed();
  const dest = join(dir, 'exists.db');
  writeFileSync(dest, 'x');
  assert.equal(cli('backup', dest).status, 1, '덮어쓰지 않는다');
  assert.equal(readFileSync(dest, 'utf8'), 'x');
  assert.equal(cli('backup').status, 2);
});
