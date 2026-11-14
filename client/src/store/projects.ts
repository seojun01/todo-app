import type { Project } from '../../../shared/task.ts';
import { req, runTx } from './db.ts';

export type StoredProject = Project & { dirty: 0 | 1 };

const read = <T>(db: IDBDatabase, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  runTx(db, ['projects'], 'readonly', (tx) => req(fn(tx.objectStore('projects'))));

export function getProject(db: IDBDatabase, id: string): Promise<StoredProject | undefined> {
  return read(db, (s) => s.get(id));
}

/** 만든 순서(createdAt 오름차순, 같으면 id) */
export async function listProjects(db: IDBDatabase): Promise<StoredProject[]> {
  const all = await read(db, (s) => s.getAll());
  return all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

export function listDirtyProjects(db: IDBDatabase): Promise<StoredProject[]> {
  return read(db, (s) => s.index('byDirty').getAll(1));
}
