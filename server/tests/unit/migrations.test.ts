import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.ts';
import { migrate, SCHEMA_VERSION } from '../../src/migrations.ts';

const names = (db: ReturnType<typeof openDb>, type: string) =>
  (db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as { name: string }[]).map((r) => r.name);
const version = (db: ReturnType<typeof openDb>) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('빈 DB 에 적용하면 user_version 5 와 모든 테이블이 생긴다', () => {
  const db = openDb(':memory:');
  assert.equal(version(db), 5);
  assert.equal(SCHEMA_VERSION, 5);
  const tables = names(db, 'table');
  for (const t of ['tasks', 'projects', 'settings', 'devices', 'push_subscriptions', 'reminder_log', 'pairing_codes', 'server_meta', 'gcal_account', 'gcal_events', 'gcal_oauth_state', 'gcal_import_calendars', 'gcal_import_events'])
    assert.ok(tables.includes(t), `${t} 테이블`);
  const indexes = names(db, 'index');
  assert.ok(indexes.includes('tasks_seq_idx'), 'tasks(seq) 인덱스');
  assert.ok(indexes.includes('tasks_due_date_idx'), 'tasks(due_date) 인덱스');
});

test('tasks 에는 알림 스케줄러용 armed_at 이 있다', () => {
  const db = openDb(':memory:');
  const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['id', 'title', 'due_date', 'due_time', 'project_id', 'priority', 'recurrence', 'reminders', 'done', 'created_at', 'deleted', 'version', 'updated_by', 'seq', 'armed_at', 'tags', 'duration_min'])
    assert.ok(cols.includes(c), c);
});

test('세 레코드 테이블의 seq 는 UNIQUE 이고 settings.id 는 settings 만 허용한다', () => {
  const db = openDb(':memory:');
  const insertTask = (id: string, seq: number) =>
    db
      .prepare(
        `INSERT INTO tasks (id,title,due_date,due_time,project_id,priority,recurrence,reminders,done,created_at,deleted,version,updated_by,seq,armed_at)
         VALUES (?,?,NULL,NULL,'inbox',4,NULL,'[]',0,'2026-11-12T00:00:00.000Z',0,'v','d',?,'2026-11-12T00:00:00.000Z')`,
      )
      .run(id, 't', seq);
  insertTask('a', 1);
  assert.throws(() => insertTask('b', 1), /UNIQUE/);
  assert.throws(() => db.prepare(`INSERT INTO settings (id, default_reminder_time, version, updated_by, seq) VALUES ('x','09:00','v','d',9)`).run(), /CHECK/);
  db.prepare(`INSERT INTO settings (id, default_reminder_time, version, updated_by, seq) VALUES ('settings','09:00','v','d',9)`).run();
});

test('이미 최신인 DB 에 다시 실행해도 아무 일도 없다 (멱등)', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO server_meta (key, value) VALUES ('last_seq', '7')`).run();
  migrate(db);
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.equal((db.prepare(`SELECT value FROM server_meta WHERE key = 'last_seq'`).get() as { value: string }).value, '7');
});

test('v2 DB 를 최신으로 올리면 기존 할 일은 태그가 빈 목록이 되고 데이터는 그대로다 (v3 이후)', () => {
  const db = openDb(':memory:');
  // v2 모양으로 되돌린다 (v3 의 tags 컬럼, v4 의 테이블·컬럼을 걷어 낸다)
  db.exec('DROP TABLE gcal_import_events; DROP TABLE gcal_import_calendars; ALTER TABLE gcal_account DROP COLUMN scopes; ALTER TABLE gcal_account DROP COLUMN import_enabled; ALTER TABLE tasks DROP COLUMN duration_min; ALTER TABLE tasks DROP COLUMN tags; PRAGMA user_version = 2;');
  db.prepare(
    `INSERT INTO tasks (id,title,due_date,due_time,project_id,priority,recurrence,reminders,done,created_at,deleted,version,updated_by,seq,armed_at)
     VALUES ('old','옛 할 일',NULL,NULL,'inbox',4,NULL,'[]',0,'2026-11-12T00:00:00.000Z',0,'v','d',1,'2026-11-12T00:00:00.000Z')`,
  ).run();
  assert.equal(version(db), 2);
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  const row = db.prepare(`SELECT title, tags FROM tasks WHERE id = 'old'`).get() as { title: string; tags: string };
  assert.deepEqual({ ...row }, { title: '옛 할 일', tags: '[]' });
});

test('v3 DB 를 올리면 구글 계정 행은 불러오기가 꺼진 채 권한 목록이 비어 있고 기존 값은 그대로다 (v4)', () => {
  const db = openDb(':memory:');
  db.exec('DROP TABLE gcal_import_events; DROP TABLE gcal_import_calendars; ALTER TABLE gcal_account DROP COLUMN scopes; ALTER TABLE gcal_account DROP COLUMN import_enabled; ALTER TABLE tasks DROP COLUMN duration_min; PRAGMA user_version = 3;');
  db.prepare(`INSERT INTO gcal_account (id, refresh_token, calendar_id, connected_at) VALUES (1, 'rt', 'cal', '2026-11-13T00:00:00.000Z')`).run();
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  const row = db.prepare('SELECT refresh_token, calendar_id, scopes, import_enabled FROM gcal_account').get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { refresh_token: 'rt', calendar_id: 'cal', scopes: '', import_enabled: 0 });
  assert.ok(names(db, 'table').includes('gcal_import_events'));
});

test('v4 DB 를 올리면 기존 할 일은 길이가 비어 있고 데이터는 그대로다 (v5)', () => {
  const db = openDb(':memory:');
  db.exec('ALTER TABLE tasks DROP COLUMN duration_min; PRAGMA user_version = 4;');
  db.prepare(
    `INSERT INTO tasks (id,title,due_date,due_time,project_id,priority,recurrence,reminders,tags,done,created_at,deleted,version,updated_by,seq,armed_at)
     VALUES ('old','옛 일정','2026-11-20','13:00','inbox',4,NULL,'[]','[]',0,'2026-11-12T00:00:00.000Z',0,'v','d',1,'2026-11-12T00:00:00.000Z')`,
  ).run();
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  const row = db.prepare(`SELECT title, due_time, duration_min FROM tasks WHERE id = 'old'`).get() as { title: string; due_time: string; duration_min: number | null };
  assert.deepEqual({ ...row }, { title: '옛 일정', due_time: '13:00', duration_min: null });
});
