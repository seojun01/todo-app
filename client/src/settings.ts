// 설정 레코드(기본 알림 시각) 읽기·쓰기. 다른 레코드처럼 version(HLC)과 dirty 를 달아 동기화된다 (가장 나중 변경이 이긴다).
import { DEFAULT_REMINDER_TIME, isValidTime, validateSettings, type FieldError, type Settings } from '../../shared/task.ts';
import type { Ctx } from './context.ts';
import { commit } from './store/db.ts';
import { getStoredSettings } from './store/meta.ts';

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; errors: FieldError[] };

export interface SettingsOps {
  /** 저장된 설정. 한 번도 바꾼 적이 없으면 기본값 */
  get(): Promise<Settings>;
  setDefaultReminderTime(time: string): Promise<SettingsResult>;
}

export function createSettingsOps(ctx: Ctx): SettingsOps {
  return {
    async get() {
      const stored = await getStoredSettings(ctx.db);
      if (stored) {
        const { dirty: _dirty, ...settings } = stored;
        return settings;
      }
      return { id: 'settings', defaultReminderTime: DEFAULT_REMINDER_TIME, version: '', updatedBy: '' };
    },

    async setDefaultReminderTime(time) {
      if (!isValidTime(time)) return { ok: false, errors: [{ field: 'defaultReminderTime', rule: 'format' }] };
      const settings: Settings = { id: 'settings', defaultReminderTime: time, version: ctx.hlc.next(), updatedBy: ctx.deviceId };
      const errors = validateSettings(settings);
      if (errors.length) return { ok: false, errors };
      await commit(ctx.db, { meta: { settings: { ...settings, dirty: 1 }, hlc: ctx.hlc.state() } });
      return { ok: true, settings };
    },
  };
}
