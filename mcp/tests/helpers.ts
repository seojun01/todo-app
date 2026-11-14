// MCP 테스트용: 메모리 DB 의 실제 서버를 띄우고 "Claude" 기기로 페어링한다.
import { TodoClient } from '../src/client.ts';
import type { Ctx } from '../src/tasks.ts';
import { startTestServer, type TestServer } from '../../server/tests/helpers/test-server.ts';

/** 2026-11-14 12:00 (한국 시간) */
export const NOW = new Date('2026-11-14T03:00:00Z');
export const TODAY = '2026-11-14';

export interface Setup {
  srv: TestServer;
  ctx: Ctx;
  /** 앱의 다른 기기처럼 서버를 직접 부르기 위한 두 번째 기기의 쿠키 */
  other: { deviceId: string; cookie: string };
  close(): Promise<void>;
}

export async function setup(now: Date = NOW): Promise<Setup> {
  const srv = await startTestServer();
  const claude = await srv.pair('Claude');
  const other = await srv.pair('Phone');
  const token = claude.cookie.split('=')[1]!;
  const ctx: Ctx = { client: new TodoClient({ url: srv.base, token }), deviceId: claude.deviceId, now: () => now, tz: 'Asia/Seoul' };
  return { srv, ctx, other, close: () => srv.close() };
}

/** 도구가 돌려준 결과를 꺼내 쓰기 쉽게 any 로 본다 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
