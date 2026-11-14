// 실시간 반영(SSE) + 보조 장치: 앱이 다시 보일 때, 온라인이 될 때, 시작할 때, SSE 가 끊긴 동안 30초 간격 pull
import type { SyncEngine } from './engine.ts';
import { getCursor } from '../store/meta.ts';

export interface Realtime {
  /** 등록 상태가 바뀐 뒤(등록 완료 등) 연결을 다시 맺는다 */
  restart(): void;
  stop(): void;
}

export const POLL_MS = 30_000;

export function startRealtime(db: IDBDatabase, engine: SyncEngine): Realtime {
  let es: EventSource | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const closeStream = () => {
    es?.close();
    es = undefined;
  };
  const stopPolling = () => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  };
  const startPolling = () => {
    poll ??= setInterval(() => void engine.syncNow(), POLL_MS);
  };

  async function sync(): Promise<void> {
    const status = await engine.syncNow();
    if (status.state === 'unauthorized') {
      // 등록되지 않았거나 해제됨: 401 을 반복해서 받지 않도록 연결과 폴링을 멈춘다
      closeStream();
      stopPolling();
    }
  }

  function connect(): void {
    if (stopped || es) return;
    es = new EventSource('/api/events');
    es.addEventListener('cursor', (ev) => {
      const { cursor } = JSON.parse((ev as MessageEvent).data) as { cursor: number };
      void getCursor(db).then((mine) => {
        if (cursor !== mine) void sync(); // 더 크면 새 변경, 더 작으면 서버가 복원된 것 — 둘 다 동기화로 확인한다
      });
    });
    es.addEventListener('open', stopPolling);
    es.addEventListener('error', () => {
      startPolling(); // 끊긴 동안은 30초마다 확인
      void sync(); // 그리고 해제·오프라인 상태를 바로 확인한다
    });
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      connect();
      void sync();
    }
  };
  const onOnline = () => {
    connect();
    void sync();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);

  // 시작할 때: 등록된 기기라면 연결하고 한 번 동기화한다
  void engine.status().then((s) => {
    if (s.paired) connect();
    void sync();
  });

  return {
    restart() {
      closeStream();
      stopPolling();
      connect();
      void sync();
    },
    stop() {
      stopped = true;
      closeStream();
      stopPolling();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    },
  };
}
