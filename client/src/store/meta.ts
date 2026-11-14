// meta object store: deviceId, cursor, hlc, lastSyncAt, settings, notifyEnabled
import type { HlcState } from '../../../shared/hlc.ts';
import type { Settings } from '../../../shared/task.ts';
import { commit, req, runTx } from './db.ts';

export type StoredSettings = Settings & { dirty: 0 | 1 };

export function getMeta<T = unknown>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return runTx(db, ['meta'], 'readonly', (tx) => req(tx.objectStore('meta').get(key) as IDBRequest<T | undefined>));
}

/** 첫 실행 때 만들고 이후에는 같은 값을 돌려준다 */
export async function getOrCreateDeviceId(db: IDBDatabase): Promise<string> {
  const existing = await getMeta<string>(db, 'deviceId');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await commit(db, { meta: { deviceId: id } }, { silent: true });
  return id;
}

export const getHlcState = (db: IDBDatabase) => getMeta<HlcState>(db, 'hlc');
export const getCursor = async (db: IDBDatabase) => (await getMeta<number>(db, 'cursor')) ?? 0;
export const getStoredSettings = (db: IDBDatabase) => getMeta<StoredSettings>(db, 'settings');
