// 내보내기 형식 (data-model.md "내보내기 형식", FR-036). 클라이언트와 서버 CLI 가 같은 코드로 만든다.
// 툼스톤과 내부 필드(version·updatedBy·dirty·deleted·서버의 armed_at)는 내보내지 않는다.
import { DEFAULT_REMINDER_TIME, INBOX_ID, durationOf, effectiveProjectId, tagsOf, type Project, type Recurrence, type ReminderKind, type Settings, type Task } from './task.ts';

export interface ExportedProject {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface ExportedTask {
  id: string;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  durationMin: number | null;
  projectId: string;
  priority: number;
  recurrence: Recurrence | null;
  reminders: ReminderKind[];
  tags: string[];
  done: boolean;
  createdAt: string;
}

export interface TodoExport {
  format: 'todo-export';
  schemaVersion: 1;
  exportedAt: string;
  projects: ExportedProject[];
  tasks: ExportedTask[];
  settings: { defaultReminderTime: string };
}

const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;

export function buildExport(
  projects: readonly Project[],
  tasks: readonly Task[],
  settings: Pick<Settings, 'defaultReminderTime'> | null | undefined,
  now: Date = new Date(),
): TodoExport {
  const liveProjects = projects.filter((p) => !p.deleted);
  return {
    format: 'todo-export',
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    projects: [...liveProjects].sort(byCreated).map((p) => ({ id: p.id, name: p.name, color: p.color, createdAt: p.createdAt })),
    tasks: tasks
      .filter((t) => !t.deleted)
      .sort(byCreated)
      .map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        durationMin: durationOf(t),
        // 삭제되었거나 없는 프로젝트의 할 일은 읽을 때와 마찬가지로 수신함으로 정리한다
        projectId: effectiveProjectId(t, projects) ?? INBOX_ID,
        priority: t.priority,
        recurrence: t.recurrence,
        reminders: [...t.reminders],
        tags: [...tagsOf(t)],
        done: t.done,
        createdAt: t.createdAt,
      })),
    settings: { defaultReminderTime: settings?.defaultReminderTime ?? DEFAULT_REMINDER_TIME },
  };
}
