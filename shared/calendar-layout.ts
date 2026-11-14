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
