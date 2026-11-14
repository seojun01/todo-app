// 끌기 중에는 화면을 다시 그리지 않는다.
// 끌기를 시작하면 화면에 미리보기·표시 클래스가 붙어서, 그 사이에 동기화 같은 다시 그리기가 한 번이라도 끼어들면
// "달라졌다"고 보고 화면을 통째로 갈아엎는다. 끌던 요소가 문서에서 떨어져 나가 드롭이 엉뚱하게 처리된다.
// 그래서 끌기 동안은 다시 그리기를 미뤘다가, 끝나면 한 번 새로 그린다.

/** 끌기가 끝나지 않은 채 멈춰 버려도 화면이 영영 안 갱신되지 않도록, 이 시간(ms)이 지나면 끌기가 끝난 것으로 본다 */
const MAX_HOLD_MS = 30_000;

let holdUntil = 0;
let skipped = false;
let onIdle: (() => void) | null = null;

/** 끌기가 진행 중인가 */
export function isDragging(): boolean {
  return Date.now() < holdUntil;
}

/** 끌기 중에 다시 그리기가 미뤄졌음을 기록한다 (main 이 호출) */
export function noteSkippedRefresh(): void {
  skipped = true;
}

/** 끌기가 끝났을 때 미뤄진 다시 그리기를 해야 할 때 불릴 함수를 등록한다 (main 이 한 번 등록) */
export function setOnDragIdle(fn: () => void): void {
  onIdle = fn;
}

export function beginDrag(): void {
  holdUntil = Date.now() + MAX_HOLD_MS;
}

/** 끌기를 마친다. 그 사이 미뤄진 다시 그리기가 있었다면 지금 한다. */
export function endDrag(): void {
  holdUntil = 0;
  if (skipped) {
    skipped = false;
    onIdle?.();
  }
}
