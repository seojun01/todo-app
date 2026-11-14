// 프로젝트 도메인 연산. 모든 쓰기는 한 트랜잭션으로 처리하고 complete 뒤에만 성공을 돌려준다 (FR-011).
import {
  INBOX_ID,
  validateProject,
  type FieldError,
  type Project,
  type ProjectColor,
  type Task,
} from '../../shared/task.ts';
import type { Ctx } from './context.ts';
import { commit } from './store/db.ts';
import { getProject, type StoredProject } from './store/projects.ts';
import { listTasksByProject, type StoredTask } from './store/tasks.ts';
import type { OpResult, TaskOps } from './tasks.ts';

export type ProjectResult = { ok: true; project: StoredProject } | { ok: false; errors: FieldError[] };

export interface ProjectOps {
  createProject(input: { name: string; color?: ProjectColor }): Promise<ProjectResult>;
  updateProject(id: string, changes: { name?: string; color?: ProjectColor }): Promise<ProjectResult>;
  /** 삭제될 할 일의 수 (확인 대화상자에 보여 준다). 삭제되지 않은 할 일 전부, 완료한 것 포함 */
  countTasks(projectId: string): Promise<number>;
  /** 프로젝트와 소속 할 일의 툼스톤을 한 번에 만든다 (FR-014) */
  deleteProject(id: string): Promise<{ ok: true; deletedTasks: number } | { ok: false; errors: FieldError[] }>;
  moveTask(taskId: string, projectId: string): Promise<OpResult>;
}

const fail = (field: string, rule: string): { ok: false; errors: FieldError[] } => ({ ok: false, errors: [{ field, rule }] });

export function createProjectOps(ctx: Ctx, tasks: TaskOps): ProjectOps {
  const stamp = () => ({ version: ctx.hlc.next(), updatedBy: ctx.deviceId });

  async function live(id: string): Promise<StoredProject | undefined> {
    if (id === INBOX_ID) return undefined; // 수신함은 저장하지 않는 가상 프로젝트
    const p = await getProject(ctx.db, id);
    return p && !p.deleted ? p : undefined;
  }

  const strip = ({ dirty: _d, ...rest }: StoredProject): Project => rest;

  return {
    async createProject(input) {
      const candidate: Project = {
        id: crypto.randomUUID(),
        name: typeof input.name === 'string' ? input.name.trim() : '',
        color: input.color ?? 'gray',
        createdAt: ctx.now().toISOString(),
        deleted: false,
        ...stamp(),
      };
      const errors = validateProject(candidate);
      if (errors.length) return { ok: false, errors };
      const stored: StoredProject = { ...candidate, dirty: 1 };
      await commit(ctx.db, { projects: [stored], meta: { hlc: ctx.hlc.state() } });
      return { ok: true, project: stored };
    },

    async updateProject(id, changes) {
      const current = await live(id);
      if (!current) return fail('id', id === INBOX_ID ? 'inbox' : 'not-found');
      const candidate: Project = { ...strip(current), ...changes, ...stamp() };
      if (changes.name !== undefined) candidate.name = changes.name.trim();
      const errors = validateProject(candidate);
      if (errors.length) return { ok: false, errors };
      const stored: StoredProject = { ...candidate, dirty: 1 };
      await commit(ctx.db, { projects: [stored], meta: { hlc: ctx.hlc.state() } });
      return { ok: true, project: stored };
    },

    async countTasks(projectId) {
      return (await listTasksByProject(ctx.db, projectId)).filter((t) => !t.deleted).length;
    },

    async deleteProject(id) {
      const current = await live(id);
      if (!current) return fail('id', id === INBOX_ID ? 'inbox' : 'not-found');
      const members = (await listTasksByProject(ctx.db, id)).filter((t) => !t.deleted);
      const tombstones: StoredTask[] = members.map((t) => {
        const { dirty: _d, ...base } = t;
        const next: Task = { ...base, deleted: true, ...stamp() };
        return { ...next, dirty: 1 };
      });
      const project: StoredProject = { ...strip(current), deleted: true, ...stamp(), dirty: 1 };
      // 프로젝트와 소속 할 일을 한 트랜잭션으로: 중간에 실패해도 반쪽만 삭제되지 않는다
      await commit(ctx.db, { projects: [project], tasks: tombstones, meta: { hlc: ctx.hlc.state() } });
      return { ok: true, deletedTasks: tombstones.length };
    },

    async moveTask(taskId, projectId) {
      if (projectId !== INBOX_ID && !(await live(projectId))) return fail('projectId', 'not-found');
      return tasks.editTask(taskId, { projectId });
    },
  };
}
