// 내 데이터 내보내기 (FR-036): 기기에 있는 모든 프로젝트와 할 일을 JSON 파일로 저장한다
import { toDateString } from '../../shared/calendar.ts';
import { buildExport, type TodoExport } from '../../shared/export.ts';
import { getStoredSettings } from './store/meta.ts';
import { listProjects } from './store/projects.ts';
import { listAllTasks } from './store/tasks.ts';

export async function buildLocalExport(db: IDBDatabase, now: Date = new Date()): Promise<TodoExport> {
  return buildExport(await listProjects(db), await listAllTasks(db), await getStoredSettings(db), now);
}

export function exportFilename(now: Date): string {
  return `todo-export-${toDateString(now)}.json`;
}

/** 파일로 저장한다 (사람이 읽을 수 있는 들여쓰기 JSON) */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
