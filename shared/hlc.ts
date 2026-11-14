// 하이브리드 논리 시계(HLC). 문자열 비교 순서가 곧 시간 순서가 되도록 0 으로 채운다.
// 형식: <wallMs 15자리>-<counter 6자리>-<deviceId>

export interface HlcState {
  wallMs: number;
  counter: number;
}

export interface Hlc {
  /** 로컬 변경을 위한 새 버전 */
  next(): string;
  /** 원격 버전을 받아 로컬 시계를 앞으로 당기고, 그보다 큰 값을 돌려준다 */
  receive(remote: string): string;
  state(): HlcState;
}

const RE = /^(\d{15})-(\d{6})-(.+)$/;

export function formatHlc(wallMs: number, counter: number, deviceId: string): string {
  return `${String(wallMs).padStart(15, '0')}-${String(counter).padStart(6, '0')}-${deviceId}`;
}

export function parseHlc(s: string): { wallMs: number; counter: number; deviceId: string } | null {
  const m = RE.exec(s);
  if (!m) return null;
  return { wallMs: Number(m[1]), counter: Number(m[2]), deviceId: m[3]! };
}

export function createHlc(deviceId: string, opts: { now?: () => number; state?: HlcState } = {}): Hlc {
  const now = opts.now ?? (() => Date.now());
  let wall = opts.state?.wallMs ?? 0;
  let counter = opts.state?.counter ?? 0;
  const fmt = () => formatHlc(wall, counter, deviceId);
  return {
    next() {
      const pt = now();
      if (pt > wall) {
        wall = pt;
        counter = 0;
      } else {
        counter += 1;
      }
      return fmt();
    },
    receive(remote) {
      const r = parseHlc(remote);
      if (!r) return fmt();
      const pt = now();
      const newWall = Math.max(wall, r.wallMs, pt);
      if (newWall === wall && newWall === r.wallMs) counter = Math.max(counter, r.counter) + 1;
      else if (newWall === wall) counter += 1;
      else if (newWall === r.wallMs) counter = r.counter + 1;
      else counter = 0;
      wall = newWall;
      return fmt();
    },
    state() {
      return { wallMs: wall, counter };
    },
  };
}
