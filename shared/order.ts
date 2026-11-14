// 할 일 목록의 직접 정한 순서 (끌어서 바꾼 순서).
// 순서 키는 0-9a-z 로 된 "소수점 아래 자리" 문자열이다: 사전순 비교가 곧 크기 비교이고, 어떤 두 키 사이에도 새 키를 만들 수 있어
// 한 할 일을 옮길 때 그 할 일 하나만 고치면 된다. 끝자리가 '0' 인 키는 쓰지 않는다 (그래야 사이 키가 항상 있다).

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
export const MAX_SORT_KEY = 64;

export const isValidSortKey = (k: unknown): k is string =>
  typeof k === 'string' && k.length > 0 && k.length <= MAX_SORT_KEY && /^[0-9a-z]*[1-9a-z]$/.test(k);

/** a < 결과 < b 인 키 (a 가 null 이면 맨 앞, b 가 null 이면 맨 뒤) */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  return mid(a ?? '', b);
}

function mid(a: string, b: string | null): string {
  if (b !== null) {
    // 같은 앞부분은 그대로 두고 그 뒤에서 가운데를 찾는다
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  // 바로 이웃한 자리: b 가 더 길면 b 의 첫 자리만으로 충분하고, 아니면 a 의 첫 자리 뒤에서 이어 찾는다
  if (b !== null && b.length > 1) return b[0]!;
  return DIGITS[da]! + mid(a.slice(1), null);
}

/** n 개의 고르게 떨어진 키 (오름차순) */
export function evenKeys(n: number): string[] {
  let width = 1;
  while (DIGITS.length ** width <= n) width++;
  const space = DIGITS.length ** width;
  const step = space / (n + 1);
  return Array.from({ length: n }, (_, i) => Math.round(step * (i + 1)).toString(36).padStart(width, '0').replace(/0+$/, ''));
}

/**
 * 목록 order(새 순서의 id 들)에서 moved 를 옮긴 뒤 저장할 순서 키들.
 * 목록의 모든 할 일에 키가 있고(옮긴 것 빼고) 그 순서대로 이미 오름차순이면 옮긴 할 일 하나만 고친다.
 * 아니면(처음 정렬하거나 섞여 있으면) 목록 전체에 새 키를 준다. 바뀌는 것만 돌려준다.
 */
export function planReorder(order: readonly string[], moved: string, keyOf: (id: string) => string | null | undefined): Map<string, string> {
  const i = order.indexOf(moved);
  if (i < 0) return new Map();
  const others = order.filter((id) => id !== moved).map((id) => keyOf(id) ?? null);
  const consistent = others.every((k, j) => k !== null && (j === 0 || others[j - 1]! < k));
  if (consistent) {
    const prev = i > 0 ? keyOf(order[i - 1]!)! : null;
    const next = i < order.length - 1 ? keyOf(order[i + 1]!)! : null;
    const key = keyBetween(prev, next);
    return key === keyOf(moved) || key.length > MAX_SORT_KEY ? fullPlan() : new Map([[moved, key]]);
  }
  return fullPlan();

  function fullPlan(): Map<string, string> {
    const keys = evenKeys(order.length);
    const out = new Map<string, string>();
    order.forEach((id, j) => {
      if (keyOf(id) !== keys[j]) out.set(id, keys[j]!);
    });
    return out;
  }
}
