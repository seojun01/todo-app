import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from '../merge.ts';

interface R {
  id: string;
  v: string; // 표시용 내용
  version: string;
  deleted?: boolean;
}
const rec = (id: string, v: string, version: string, deleted = false): R => ({ id, v, version, deleted });

test('local 이 없으면 incoming', () => {
  const inc = rec('a', 'x', '001-000000-d');
  assert.equal(merge(null, inc), inc);
  assert.equal(merge(undefined, inc), inc);
});

test('version 이 더 큰 쪽이 이긴다', () => {
  const lo = rec('a', 'old', '001-000000-d');
  const hi = rec('a', 'new', '002-000000-d');
  assert.equal(merge(lo, hi), hi);
  assert.equal(merge(hi, lo), hi);
});

test('version 이 같으면 local 을 유지한다', () => {
  const a = rec('a', 'one', '001-000000-d');
  const b = rec('a', 'two', '001-000000-d');
  assert.equal(merge(a, b), a);
});

test('삭제 대 수정은 version 이 큰 쪽이 이긴다', () => {
  const del = rec('a', 'x', '005-000000-d', true);
  const edit = rec('a', 'y', '006-000000-e');
  assert.equal(merge(del, edit), edit); // 나중에 수정했으면 남는다
  const edit2 = rec('a', 'y', '004-000000-e');
  assert.equal(merge(del, edit2), del); // 나중에 삭제했으면 사라진다
});

test('같은 변경 집합은 어떤 순서로 적용해도 같은 최종 상태가 된다 (SC-009)', () => {
  // 간단한 결정적 난수
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let round = 0; round < 200; round++) {
    const ids = ['a', 'b', 'c'];
    const changes: R[] = [];
    for (let i = 0; i < 12; i++) {
      const id = ids[Math.floor(rnd() * ids.length)]!;
      const wall = String(Math.floor(rnd() * 20)).padStart(3, '0');
      const dev = rnd() < 0.5 ? 'x' : 'y';
      // 실제 HLC 는 기기마다 counter 로 값이 유일하다 (같은 version 에 다른 내용이 있을 수 없다)
      const counter = String(i).padStart(6, '0');
      changes.push(rec(id, `${wall}${dev}${i}`, `${wall}-${counter}-${dev}`, rnd() < 0.2));
    }
    const apply = (order: R[]) => {
      const state = new Map<string, R>();
      for (const c of order) state.set(c.id, merge(state.get(c.id), c));
      return JSON.stringify([...state.entries()].sort(([p], [q]) => (p < q ? -1 : 1)));
    };
    const base = apply(changes);
    for (let k = 0; k < 5; k++) {
      const shuffled = [...changes].sort(() => rnd() - 0.5);
      // 중복 적용(멱등)도 섞는다
      const withDupes = [...shuffled, ...shuffled.slice(0, 4)];
      assert.equal(apply(withDupes), base);
    }
  }
});
