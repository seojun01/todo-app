import type { Task } from '../../../shared/task.ts';
import { req, runTx } from './db.ts';

/** dirty: 1 = 서버에 아직 반영되지 않은 변경 */
export type StoredTask = Task & { dirty: 0 | 1 };

const read = <T>(db: IDBDatabase, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  runTx(db, ['tasks'], 'readonly', (tx) => req(fn(tx.objectStore('tasks'))));

export function getTask(db: IDBDatabase, id: string): Promise<StoredTask | undefined> {
  return read(db, (s) => s.get(id));
}

export function listAllTasks(db: IDBDatabase): Promise<StoredTask[]> {
  return read(db, (s) => s.getAll());
}

/** from ~ to (양 끝 포함) 사이에 기한이 있는 할 일. 기한이 없는 할 일은 나오지 않는다. */
export function listTasksByDueRange(db: IDBDatabase, from: string, to: string): Promise<StoredTask[]> {
  return read(db, (s) => s.index('byDue').getAll(IDBKeyRange.bound(from, to)));
}

export function listTasksByProject(db: IDBDatabase, projectId: string): Promise<StoredTask[]> {
  return read(db, (s) => s.index('byProject').getAll(projectId));
}

export function listDirtyTasks(db: IDBDatabase): Promise<StoredTask[]> {
  return read(db, (s) => s.index('byDirty').getAll(1));
}
