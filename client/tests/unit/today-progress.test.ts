import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayProgress } from '../../src/views.ts';

const t = (n: number) => Array.from({ length: n }, () => ({}) as never);

test('오늘 3개 남고 2개 끝냈으면 2/5', () => {
  assert.deepEqual(todayProgress({ today: t(3), completed: t(2) }), { done: 2, total: 5, left: 3 });
});
test('모두 끝냈으면 left 0, total 은 완료 수', () => {
  assert.deepEqual(todayProgress({ today: [], completed: t(1) }), { done: 1, total: 1, left: 0 });
});
test('아무것도 없으면 total 0', () => {
  assert.deepEqual(todayProgress({ today: [], completed: [] }), { done: 0, total: 0, left: 0 });
});
