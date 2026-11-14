// 화면 모듈이 공유하는 App 인터페이스
import type { Ctx } from './context.ts';
import type { NotifyApi } from './notify.ts';
import type { ProjectOps } from './projects.ts';
import type { SettingsOps } from './settings.ts';
import type { Realtime } from './sync/events.ts';
import type { SyncEngine } from './sync/engine.ts';
import type { TaskOps } from './tasks.ts';

export interface ToastOptions {
  /** 표시 시간(ms). 0 이면 직접 닫을 때까지 */
  duration?: number;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

export interface Toasts {
  show(message: string, opts?: ToastOptions): void;
  clear(): void;
}

export interface App {
  ctx: Ctx;
  tasks: TaskOps;
  projects: ProjectOps;
  settings: SettingsOps;
  /** 이 기기의 푸시 알림 (상태·켜기·끄기·테스트) */
  notify: NotifyApi;
  sync: SyncEngine;
  /** 실시간 연결 (부트스트랩 후 설정된다) */
  realtime?: Realtime;
  /** 이 기기의 오늘 날짜 (FR-028) */
  today(): string;
  /** 현재 화면을 다시 그린다 (포커스와 입력 중인 값은 유지) */
  refresh(): Promise<void>;
  navigate(hash: string): void;
  toasts: Toasts;
}

export type ViewRenderer = (app: App, root: HTMLElement, params: string[]) => Promise<void> | void;
