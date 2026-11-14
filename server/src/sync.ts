// 동기화: 변경 반영(push)과 변경 조회(pull). 세 종류의 레코드(task·project·settings)가 하나의 seq 번호 공간을 쓴다.
import { merge } from '../../shared/merge.ts';
import {
  validateProject,
  validateSettings,
  tagsOf,
  validateTask,
  type FieldError,
  type Project,
  type Settings,
  type Task,
} from '../../shared/task.ts';
import { transaction, type Db } from './db.ts';
import { HttpError } from './http.ts';

export type ChangeType = 'task' | 'project' | 'settings';
export interface Change {
  type: ChangeType;
  record: Task | Project | Settings;
}

export const MAX_CHANGES = 500;
export const MAX_PAGE = 1000;

type Row = Record<string, any>;

// ── 행 ↔ 레코드 변환 ────────────────────────────────────────────────

export const rowToTask = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  dueDate: r.due_date ?? null,
  dueTime: r.due_time ?? null,
  projectId: r.project_id,
  priority: r.priority,
  recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
  reminders: JSON.parse(r.reminders),
  tags: r.tags ? JSON.parse(r.tags) : [],
  done: r.done === 1,
  createdAt: r.created_at,
  deleted: r.deleted === 1,
  version: r.version,
  updatedBy: r.updated_by,
});

export const rowToProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  color: r.color,
  createdAt: r.created_at,
  deleted: r.deleted === 1,
  version: r.version,
  updatedBy: r.updated_by,
});

export const rowToSettings = (r: Row): Settings => ({
  id: 'settings',
  defaultReminderTime: r.default_reminder_time,
  version: r.version,
  updatedBy: r.updated_by,
});

/** 알림에 영향을 주는 필드. 이것이 바뀌면 armed_at 을 갱신한다 (research R13). */
const alarmKey = (t: Task) => JSON.stringify([t.dueDate, t.dueTime, t.reminders, t.done, t.recurrence]);

// ── 검증 ────────────────────────────────────────────────────────────

interface Detail extends FieldError {
  type: string;
  id: string;
}

function validateAll(changes: unknown[]): Detail[] {
  const details: Detail[] = [];
  for (const raw of changes) {
    const c = raw as { type?: string; record?: Row } | null;
    const type = String(c?.type);
    const rec = c?.record;
    const id = String(rec?.id ?? '');
    if (!c || typeof rec !== 'object' || rec === null) {
      details.push({ type, id, field: 'record', rule: 'type' });
      continue;
    }
    let errs: FieldError[];
    if (c.type === 'task') errs = validateTask(rec as Task);
    else if (c.type === 'project') errs = validateProject(rec as Project);
    else if (c.type === 'settings') errs = validateSettings(rec as Settings);
    else errs = [{ field: 'type', rule: 'unknown' }];
    for (const e of errs) details.push({ type, id, ...e });
  }
  return details;
}

// ── push ────────────────────────────────────────────────────────────

function lastSeq(db: Db): number {
  const r = db.prepare(`SELECT value FROM server_meta WHERE key = 'last_seq'`).get() as { value: string } | undefined;
  return r ? Number(r.value) : 0;
}

export function currentCursor(db: Db): number {
  return lastSeq(db);
}

/** 변경을 한 트랜잭션으로 반영한다. 하나라도 검증에 실패하면 아무것도 반영하지 않는다. */
export function applyChanges(db: Db, body: unknown, now: Date = new Date()): { applied: number; ignored: number; cursor: number } {
  const changes = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_CHANGES) {
    throw new HttpError(400, 'validation', `changes 는 1~${MAX_CHANGES}개여야 해요`, [{ type: 'request', id: '', field: 'changes', rule: 'count' }]);
  }
  const details = validateAll(changes);
  if (details.length > 0) throw new HttpError(400, 'validation', '올바르지 않은 레코드가 있어요', details);

  const nowIso = now.toISOString();
  return transaction(db, () => {
    let seq = lastSeq(db);
    let applied = 0;
    let ignored = 0;
    const bump = () => ++seq;

    for (const { type, record } of changes as Change[]) {
      if (type === 'task') {
        const incoming = record as Task;
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(incoming.id) as Row | undefined;
        const existing = row ? rowToTask(row) : undefined;
        if (merge(existing, incoming) !== incoming) {
          ignored++;
          continue;
        }
        const armedAt = !existing || alarmKey(existing) !== alarmKey(incoming) ? nowIso : (row!.armed_at as string);
        const params = [
          incoming.title, incoming.dueDate, incoming.dueTime, incoming.projectId, incoming.priority,
          incoming.recurrence ? JSON.stringify(incoming.recurrence) : null, JSON.stringify(incoming.reminders), JSON.stringify(tagsOf(incoming)),
          incoming.done ? 1 : 0, incoming.createdAt, incoming.deleted ? 1 : 0, incoming.version, incoming.updatedBy, bump(), armedAt,
        ] as const;
        if (existing) {
          db.prepare(
            `UPDATE tasks SET title=?, due_date=?, due_time=?, project_id=?, priority=?, recurrence=?, reminders=?, tags=?, done=?,
             created_at=?, deleted=?, version=?, updated_by=?, seq=?, armed_at=? WHERE id=?`,
          ).run(...params, incoming.id);
        } else {
          db.prepare(
            `INSERT INTO tasks (title, due_date, due_time, project_id, priority, recurrence, reminders, tags, done,
             created_at, deleted, version, updated_by, seq, armed_at, id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(...params, incoming.id);
        }
        applied++;
      } else if (type === 'project') {
        const incoming = record as Project;
        const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(incoming.id) as Row | undefined;
        const existing = row ? rowToProject(row) : undefined;
        if (merge(existing, incoming) !== incoming) {
          ignored++;
          continue;
        }
        const params = [incoming.name, incoming.color, incoming.createdAt, incoming.deleted ? 1 : 0, incoming.version, incoming.updatedBy, bump()] as const;
        if (existing) {
          db.prepare('UPDATE projects SET name=?, color=?, created_at=?, deleted=?, version=?, updated_by=?, seq=? WHERE id=?').run(...params, incoming.id);
        } else {
          db.prepare('INSERT INTO projects (name, color, created_at, deleted, version, updated_by, seq, id) VALUES (?,?,?,?,?,?,?,?)').run(...params, incoming.id);
        }
        applied++;
      } else {
        const incoming = record as Settings;
        const row = db.prepare(`SELECT * FROM settings WHERE id = 'settings'`).get() as Row | undefined;
        const existing = row ? rowToSettings(row) : undefined;
        if (merge(existing, incoming) !== incoming) {
          ignored++;
          continue;
        }
        const params = [incoming.defaultReminderTime, incoming.version, incoming.updatedBy, bump()] as const;
        if (existing) {
          db.prepare(`UPDATE settings SET default_reminder_time=?, version=?, updated_by=?, seq=? WHERE id='settings'`).run(...params);
        } else {
          db.prepare(`INSERT INTO settings (default_reminder_time, version, updated_by, seq, id) VALUES (?,?,?,?,'settings')`).run(...params);
        }
        applied++;
      }
    }
    if (applied > 0) {
      db.prepare(`INSERT INTO server_meta (key, value) VALUES ('last_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(seq));
    }
    return { applied, ignored, cursor: seq };
  });
}

// ── pull ────────────────────────────────────────────────────────────

export interface PullResult {
  changes: Change[];
  cursor: number;
  hasMore: boolean;
}

export function pullChanges(db: Db, since: number, limit: number = MAX_PAGE): PullResult {
  if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'invalid_cursor', 'since 는 0 이상의 정수여야 해요');
  const n = Math.max(1, Math.min(MAX_PAGE, Math.floor(limit) || MAX_PAGE));

  const tagged: { seq: number; change: Change }[] = [];
  for (const [type, table, map] of [
    ['task', 'tasks', rowToTask],
    ['project', 'projects', rowToProject],
    ['settings', 'settings', rowToSettings],
  ] as const) {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`).all(since, n + 1) as Row[];
    for (const r of rows) tagged.push({ seq: r.seq as number, change: { type, record: map(r) } });
  }
  tagged.sort((a, b) => a.seq - b.seq);
  const hasMore = tagged.length > n;
  const page = tagged.slice(0, n);
  // 아직 더 있으면 마지막으로 돌려준 seq, 다 줬으면 서버의 최신 seq (서버가 복원돼 줄어들었는지 클라이언트가 알 수 있게)
  const cursor = hasMore ? page[page.length - 1]!.seq : lastSeq(db);
  return { changes: page.map((t) => t.change), cursor, hasMore };
}
