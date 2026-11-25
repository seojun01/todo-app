import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByUrgency } from '../../src/views.ts';

const t = (id: string, priority: number) => ({ id, priority });

test('P1·P2는 hot, 나머지는 rest — 각 구역 안의 순서를 지킨다', () => {
  const r = splitByUrgency([t('p4', 4), t('p1', 1), t('p3', 3), t('p2', 2)]);
  assert.deepEqual(r.hot.map((x) => x.id), ['p1', 'p2']);
  assert.deepEqual(r.rest.map((x) => x.id), ['p4', 'p3']);
});
test('빈 입력이면 둘 다 비어 있다', () => {
  assert.deepEqual(splitByUrgency([]), { hot: [], rest: [] });
});
test('모두 P4이면 hot 은 비어 있다', () => {
  assert.equal(splitByUrgency([t('a', 4), t('b', 4)]).hot.length, 0);
});
