// 앱 전역 컨텍스트: DB, 이 기기의 ID, 논리 시계, 현재 시각
import { createHlc, type Hlc } from '../../shared/hlc.ts';
import { getHlcState, getOrCreateDeviceId } from './store/meta.ts';

export interface Ctx {
  db: IDBDatabase;
  deviceId: string;
  hlc: Hlc;
  /** 현재 시각 (테스트에서 주입) */
  now: () => Date;
}

export async function createCtx(
  db: IDBDatabase,
  opts: { now?: () => Date; hlcNow?: () => number; deviceId?: string } = {},
): Promise<Ctx> {
  const deviceId = opts.deviceId ?? (await getOrCreateDeviceId(db));
  const state = await getHlcState(db);
  const now = opts.now ?? (() => new Date());
  const hlc = createHlc(deviceId, { now: opts.hlcNow ?? (() => now().getTime()), state });
  return { db, deviceId, hlc, now };
}
