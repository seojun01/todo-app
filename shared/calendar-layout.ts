// 시간 격자에서 하루의 블록들을 어디에 놓을지 계산한다 (DOM 과 무관한 순수 함수).
// 겹치는 블록은 나란히 놓고, 겹치지 않으면 한 줄을 다 쓴다 (구글 캘린더와 같은 방식).

export interface TimeSpan {
  id: string;
  /** 자정부터의 분 (0..1440) */
  start: number;
  /** 자정부터의 분. start 보다 커야 한다 */
  end: number;
}

export interface Placement {
  /** 왼쪽부터 몇 번째 줄인가 (0부터) */
  col: number;
  /** 이 블록이 속한 겹침 묶음의 줄 수 */
  cols: number;
}

/**
 * 겹치는 블록끼리 묶음(cluster)으로 만들고, 묶음 안에서 앞 줄부터 빈 곳에 채운다.
 * 시작이 같으면 긴 블록이 앞 줄에 온다. 맞닿기만 한 블록(앞 end == 뒤 start)은 겹친 것이 아니다.
 */
export function layoutSpans(spans: readonly TimeSpan[]): Map<string, Placement> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<string, Placement>();

  let cluster: { id: string; col: number }[] = [];
  let colEnds: number[] = []; // 줄마다 마지막 블록의 끝
  let clusterEnd = -1;

  const flush = (): void => {
    for (const m of cluster) out.set(m.id, { col: m.col, cols: colEnds.length });
    cluster = [];
    colEnds = [];
  };

  for (const s of sorted) {
    if (cluster.length > 0 && s.start >= clusterEnd) flush(); // 앞 묶음과 겹치지 않으면 새 묶음
    let col = colEnds.findIndex((end) => end <= s.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(s.end);
    } else colEnds[col] = s.end;
    cluster.push({ id: s.id, col });
    clusterEnd = cluster.length === 1 ? s.end : Math.max(clusterEnd, s.end);
  }
  flush();
  return out;
}

/** 시작 시각과 길이(분)로 블록의 끝을 구한다. 자정을 넘기지 않는다. */
export const spanEnd = (startMin: number, durationMin: number): number => Math.min(1440, startMin + durationMin);

// ── 격자에서 끌기·만들기 계산 (모두 자정부터의 분) ─────────────────────────

/** 시간 격자에서 시각이 맞춰지는 단위(분) */
export const SNAP_MIN = 15;
/** 끌어서 줄일 수 있는 가장 짧은 길이(분) */
export const MIN_BLOCK_MIN = 15;
/** 빈 곳을 눌러 만들 때의 기본 길이(분) */
export const CLICK_CREATE_MIN = 60;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** 가까운 단위로 맞춘다 */
export const snapMinutes = (min: number, step: number = SNAP_MIN): number => Math.round(min / step) * step;

/** 열의 위에서부터 y(px) 위치의 분 (0..1440) */
export const minutesAtY = (y: number, hourPx: number): number => clamp((y * 60) / hourPx, 0, 1440);

/** 블록 전체를 deltaMin 만큼 옮긴 새 시작 시각: 단위에 맞추고 하루 안(0 ~ 자정-길이)에 가둔다 */
export function movedStart(start: number, durationMin: number, deltaMin: number): number {
  return clamp(snapMinutes(start + deltaMin), 0, Math.max(0, 1440 - durationMin));
}

/** 아래쪽 끝을 deltaMin 만큼 끌어 늘이거나 줄인 새 끝: 단위에 맞추고 최소 길이 이상, 자정 이하 */
export function resizedEnd(start: number, end: number, deltaMin: number): number {
  return clamp(snapMinutes(end + deltaMin), start + MIN_BLOCK_MIN, 1440);
}

/** 빈 곳을 끌어 만들 때의 구간: 두 지점 사이를 단위에 맞추고, 너무 짧으면 최소 길이로 */
export function dragRange(aMin: number, bMin: number): { start: number; end: number } {
  let start = snapMinutes(Math.min(aMin, bMin));
  let end = snapMinutes(Math.max(aMin, bMin));
  if (end - start < MIN_BLOCK_MIN) end = start + MIN_BLOCK_MIN;
  if (end > 1440) {
    end = 1440;
    start = Math.min(start, 1440 - MIN_BLOCK_MIN);
  }
  return { start, end };
}

/** 빈 곳을 한 번 눌렀을 때의 구간: 누른 지점이 속한 30분 칸에서 시작해 한 시간 (자정을 넘지 않게 앞당긴다) */
export function clickRange(min: number): { start: number; end: number } {
  const start = clamp(Math.floor(min / 30) * 30, 0, 1440 - CLICK_CREATE_MIN);
  return { start, end: start + CLICK_CREATE_MIN };
}
