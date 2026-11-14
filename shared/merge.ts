// 항목 단위 LWW 병합. version(HLC 문자열)이 더 큰 쪽이 이기고, 같으면 local 을 유지한다.
// 교환·결합·멱등이므로 같은 변경 집합은 어떤 순서로 적용해도 같은 최종 상태가 된다.
export function merge<T extends { version: string }>(local: T | null | undefined, incoming: T): T {
  if (local == null || incoming.version > local.version) return incoming;
  return local;
}
