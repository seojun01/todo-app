// PRAGMA user_version 기반 마이그레이션. 스키마를 바꾸면 MIGRATIONS 에 단계를 추가한다.
import type { DatabaseSync } from 'node:sqlite';

type Migration = (db: DatabaseSync) => void;

const MIGRATIONS: Migration[] = [
  // v1: 초기 스키마 (specs/002-personal-task-manager/data-model.md "서버 저장소")
  (db) => {
    db.exec(`
      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        due_date    TEXT,
        due_time    TEXT,
        project_id  TEXT NOT NULL,
        priority    INTEGER NOT NULL,
        recurrence  TEXT,
        reminders   TEXT NOT NULL,
        done        INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        deleted     INTEGER NOT NULL,
        version     TEXT NOT NULL,
        updated_by  TEXT NOT NULL,
        seq         INTEGER NOT NULL UNIQUE,
        armed_at    TEXT NOT NULL
      );
      CREATE INDEX tasks_seq_idx ON tasks(seq);
      CREATE INDEX tasks_due_date_idx ON tasks(due_date);

      CREATE TABLE projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted    INTEGER NOT NULL,
        version    TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        seq        INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE settings (
        id                    TEXT PRIMARY KEY CHECK (id = 'settings'),
        default_reminder_time TEXT NOT NULL,
        version               TEXT NOT NULL,
        updated_by            TEXT NOT NULL,
        seq                   INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT
      );

      CREATE TABLE push_subscriptions (
        device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        timezone   TEXT NOT NULL,
        enabled    INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE reminder_log (
        task_id   TEXT NOT NULL,
        due_key   TEXT NOT NULL,
        kind      TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sent_at   TEXT NOT NULL,
        PRIMARY KEY (task_id, due_key, kind, device_id)
      );

      CREATE TABLE pairing_codes (
        code_hash   TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT
      );

      CREATE TABLE server_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
  // v2: 구글 캘린더 연동 (할 일 → 캘린더, 단방향). 토큰·캘린더·할 일↔일정 대응·OAuth 진행 상태
  (db) => {
    db.exec(`
      CREATE TABLE gcal_account (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        refresh_token TEXT,
        calendar_id   TEXT,
        connected_at  TEXT NOT NULL,
        last_sync_at  TEXT,
        last_error    TEXT,
        needs_reauth  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE gcal_events (
        task_id        TEXT PRIMARY KEY,
        event_id       TEXT NOT NULL,
        synced_version TEXT NOT NULL
      );

      CREATE TABLE gcal_oauth_state (
        state_hash TEXT PRIMARY KEY,
        verifier   TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  },
  // v3: 태그. 옛 클라이언트가 tags 없이 올려도 되도록 기본값은 빈 목록(JSON)
  (db) => {
    db.exec(`ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';`);
  },
  // v4: 구글 캘린더 일정 불러오기 (읽기 전용으로 겹쳐 보여 주기). 받은 권한, 불러올 캘린더 목록·선택, 불러온 일정의 사본
  (db) => {
    db.exec(`
      ALTER TABLE gcal_account ADD COLUMN scopes TEXT NOT NULL DEFAULT '';
      ALTER TABLE gcal_account ADD COLUMN import_enabled INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE gcal_import_calendars (
        calendar_id TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT,
        selected    INTEGER NOT NULL DEFAULT 0,
        is_primary  INTEGER NOT NULL DEFAULT 0
      );

      -- 날짜는 TODO_TIMEZONE 기준의 현지 날짜. end_date 는 그날을 포함한다(종일 일정의 끝 날짜는 구글에서 하루 뒤라 하루 줄여 저장).
      CREATE TABLE gcal_import_events (
        calendar_id TEXT NOT NULL,
        event_id    TEXT NOT NULL,
        title       TEXT NOT NULL,
        start_date  TEXT NOT NULL,
        end_date    TEXT NOT NULL,
        start_time  TEXT,
        end_time    TEXT,
        all_day     INTEGER NOT NULL,
        PRIMARY KEY (calendar_id, event_id)
      );
      CREATE INDEX gcal_import_events_range_idx ON gcal_import_events(start_date, end_date);
    `);
  },
  // v5: 소요 시간(분). 캘린더에서 시각 있는 할 일을 블록으로 그린다. 비어 있어도 되고, 옛 클라이언트가 보내지 않아도 된다
  (db) => {
    db.exec(`ALTER TABLE tasks ADD COLUMN duration_min INTEGER;`);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function getUserVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** 아직 적용되지 않은 단계만 순서대로 적용한다 (이미 최신이면 아무 일도 하지 않는다). */
export function migrate(db: DatabaseSync): void {
  for (let v = getUserVersion(db); v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v]!(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
