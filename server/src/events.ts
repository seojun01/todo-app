// SSE: 새 변경이 반영되면 cursor 만 알린다. 클라이언트가 알림을 받으면 pull 한다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { currentCursor } from './sync.ts';

export interface EventsOptions {
  /** 연결 유지용 주석 줄(": ping") 간격. 기본 25초 */
  pingMs?: number;
  /** 연결된 기기가 해제되었는지 확인하는 간격. 기본 5초 (해제는 별도 프로세스인 CLI 가 DB 에 직접 쓴다) */
  checkMs?: number;
}

interface Conn {
  res: ServerResponse;
  deviceId: string;
  lastWrite: number;
}

export interface EventsHub {
  handle(req: IncomingMessage, res: ServerResponse, deviceId: string): void;
  broadcast(cursor: number): void;
  close(): void;
}

export function createEvents(db: Db, opts: EventsOptions = {}): EventsHub {
  const pingMs = opts.pingMs ?? 25_000;
  const checkMs = opts.checkMs ?? 5_000;
  const conns = new Set<Conn>();

  const write = (c: Conn, text: string) => {
    c.lastWrite = Date.now();
    c.res.write(text);
  };
  const cursorEvent = (cursor: number) => `event: cursor\ndata: ${JSON.stringify({ cursor })}\n\n`;

  function drop(c: Conn) {
    conns.delete(c);
    if (!c.res.writableEnded) c.res.end();
  }

  const timer = setInterval(() => {
    for (const c of [...conns]) {
      const dev = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(c.deviceId) as { revoked_at: string | null } | undefined;
      if (!dev || dev.revoked_at) {
        drop(c); // 해제된 기기의 스트림을 닫는다. 이후 재연결은 401
        continue;
      }
      if (Date.now() - c.lastWrite >= pingMs) write(c, ': ping\n\n');
    }
  }, checkMs);
  timer.unref();

  return {
    handle(req, res, deviceId) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 프록시가 버퍼링하지 않게
      });
      res.flushHeaders();
      const c: Conn = { res, deviceId, lastWrite: Date.now() };
      conns.add(c);
      write(c, cursorEvent(currentCursor(db)));
      req.on('close', () => conns.delete(c));
    },
    broadcast(cursor) {
      for (const c of conns) write(c, cursorEvent(cursor));
    },
    close() {
      clearInterval(timer);
      for (const c of [...conns]) drop(c);
    },
  };
}
