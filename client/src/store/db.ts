// IndexedDB `todo` (버전 1). 모든 쓰기는 트랜잭션이 complete 된 뒤에만 resolve 된다 (FR-011).
import type { StoredTask } from './tasks.ts';
import type { StoredProject } from './projects.ts';

export const DB_NAME = 'todo';
const DB_VERSION = 1;

export function openTodoDb(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = (ev) => migrate(open.result, ev.oldVersion);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB 를 열 수 없어요'));
    open.onblocked = () => reject(new Error('다른 탭이 데이터베이스를 쓰고 있어요'));
  });
}

/** 버전별 업그레이드 경로. 스키마를 바꾸면 DB_VERSION 을 올리고 여기에 단계를 추가한다. */
function migrate(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
    tasks.createIndex('byDue', 'dueDate'); // dueDate 가 null 이면 키가 아니므로 인덱스에서 자동 제외
    tasks.createIndex('byProject', 'projectId');
    tasks.createIndex('byDirty', 'dirty'); // 0 | 1 (boolean 은 IndexedDB 키가 될 수 없다)
    const projects = db.createObjectStore('projects', { keyPath: 'id' });
    projects.createIndex('byDirty', 'dirty');
    db.createObjectStore('meta'); // 바깥 키(문자열)
  }
}

/** IDBRequest 를 Promise 로 */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 요청 실패'));
  });
}

/**
 * 트랜잭션을 열고 fn 을 실행한다. 트랜잭션이 complete 되면 fn 의 결과로 resolve,
 * fn 이 throw 하거나 reject 하면 abort 하고 reject 한다.
 * (fn 안에서 IndexedDB 가 아닌 비동기 작업을 기다리면 트랜잭션이 닫히므로 하지 않는다.)
 */
export function runTx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result!: T;
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      fail(e);
      return;
    }
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    tx.onabort = () => fail(tx.error ?? new Error('트랜잭션이 취소되었어요'));
    const abort = (e: unknown) => {
      try {
        tx.abort();
      } catch {
        /* 이미 끝남 */
      }
      fail(e);
    };
    try {
      Promise.resolve(fn(tx)).then((v) => {
        result = v;
      }, abort);
    } catch (e) {
      abort(e);
    }
  });
}

export interface CommitOps {
  tasks?: StoredTask[];
  projects?: StoredProject[];
  meta?: Record<string, unknown>;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** 쓰기가 커밋된 뒤 호출된다. 동기화 엔진이 구독해 push 를 예약한다. */
export function onStoreChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * 여러 object store 에 대한 쓰기를 한 트랜잭션으로 처리한다. 하나라도 실패하면 전부 취소된다.
 * silent 이면 변경 알림을 보내지 않는다(동기화 엔진 자신의 쓰기).
 */
export async function commit(db: IDBDatabase, ops: CommitOps, opts: { silent?: boolean } = {}): Promise<void> {
  await runTx(db, ['tasks', 'projects', 'meta'], 'readwrite', (tx) => {
    const tasks = tx.objectStore('tasks');
    const projects = tx.objectStore('projects');
    const meta = tx.objectStore('meta');
    for (const t of ops.tasks ?? []) tasks.put(t);
    for (const p of ops.projects ?? []) projects.put(p);
    for (const [k, v] of Object.entries(ops.meta ?? {})) meta.put(v, k);
  });
  if (!opts.silent) for (const l of [...listeners]) l();
}
