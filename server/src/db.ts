// SQLite (node:sqlite). WAL 모드. 스키마는 migrations.ts 가 PRAGMA user_version 으로 관리한다.
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';

export type Db = DatabaseSync;

export const DEFAULT_DB = '/var/lib/todo/todo.db';

export function openDb(path: string = process.env.TODO_DB ?? DEFAULT_DB): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** 하나의 트랜잭션으로 실행한다. 예외가 나면 전부 롤백된다. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 이미 롤백됨 */
    }
    throw err;
  }
}
