import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { todayProgress } from '../../src/views.ts';

const t = (n: number, recurring = false) => Array.from({ length: n }, () => ({ recurrence: recurring ? {} : null }) as never);

test('오늘 3개 남고 2개 끝냈으면 2/5', () => {
  assert.deepEqual(todayProgress({ today: t(3), completed: t(2) }), { done: 2, total: 5, left: 3 });
});
test('모두 끝냈으면 left 0, total 은 완료 수', () => {
  assert.deepEqual(todayProgress({ today: [], completed: t(1) }), { done: 1, total: 1, left: 0 });
});
test('아무것도 없으면 total 0', () => {
  assert.deepEqual(todayProgress({ today: [], completed: [] }), { done: 0, total: 0, left: 0 });
});
test('반복 할 일은 완료해도 미완료로 남으므로 링 계산에서 빼고, 남은 개수에는 센다', () => {
  assert.deepEqual(todayProgress({ today: [...t(2, true), ...t(1)], completed: [] }), { done: 0, total: 1, left: 3 });
  assert.deepEqual(todayProgress({ today: t(3, true), completed: [] }), { done: 0, total: 0, left: 3 });
});

// 입력창 테두리는 카드·시트 바탕(--surface, --surface-2)과 3:1 이상 (WCAG 1.4.11)
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1]!;
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
for (const bg of ['bg', 'surface', 'surface-2']) {
  test(`입력창 테두리는 --${bg} 위에서 3:1 이상`, () => {
    assert.ok(ratio(token('input-border'), token(bg)) >= 3, `ratio ${ratio(token('input-border'), token(bg))}`);
  });
}
