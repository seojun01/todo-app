import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evenKeys, isValidSortKey, keyBetween, planReorder } from '../order.ts';

test('keyBetween: 언제나 두 키 사이의, 끝자리가 0 이 아닌 키를 만든다', () => {
  assert.equal(keyBetween(null, null), 'i');
  const cases: [string | null, string | null][] = [
    [null, 'i'], ['i', null], ['a', 'b'], ['a', 'a1'], ['az', 'b'], ['1', '2'], [null, '01'], ['zz', null], ['a01', 'a1'],
  ];
  for (const [a, b] of cases) {
    const k = keyBetween(a, b);
    assert.ok(isValidSortKey(k), `${a}..${b} -> ${k}`);
    if (a !== null) assert.ok(a < k, `${a} < ${k}`);
    if (b !== null) assert.ok(k < b, `${k} < ${b}`);
  }
  assert.throws(() => keyBetween('b', 'a'));
});

test('keyBetween: 같은 자리에 계속 끼워 넣어도 순서가 유지된다', () => {
  let lo = 'a';
  const hi = 'b';
  for (let i = 0; i < 50; i++) {
    const k = keyBetween(lo, hi);
    assert.ok(lo < k && k < hi);
    lo = k;
  }
  let a: string | null = null;
  for (let i = 0; i < 50; i++) {
    const k = keyBetween(null, a);
    if (a) assert.ok(k < a);
    a = k;
  }
});

test('evenKeys: n 개의 올바른 오름차순 키', () => {
  for (const n of [1, 2, 7, 35, 36, 200]) {
    const ks = evenKeys(n);
    assert.equal(ks.length, n);
    ks.forEach((k, i) => {
      assert.ok(isValidSortKey(k), k);
      if (i > 0) assert.ok(ks[i - 1]! < k);
    });
  }
});

test('planReorder: 키가 하나도 없으면 목록 전체에 새 순서대로 키를 준다', () => {
  const plan = planReorder(['c', 'a', 'b'], 'c', () => null);
  assert.equal(plan.size, 3);
  assert.ok(plan.get('c')! < plan.get('a')! && plan.get('a')! < plan.get('b')!);
});

test('planReorder: 모두 키가 있고 순서가 맞으면 옮긴 하나만 바꾼다', () => {
  const keys: Record<string, string> = { a: '1', b: '2', c: '3' };
  const plan = planReorder(['a', 'c', 'b'], 'c', (id) => keys[id]);
  assert.deepEqual([...plan.keys()], ['c']);
  assert.ok('1' < plan.get('c')! && plan.get('c')! < '2');
  // 맨 앞, 맨 뒤
  assert.ok(planReorder(['c', 'a', 'b'], 'c', (id) => keys[id]).get('c')! < '1');
  assert.ok(planReorder(['b', 'c', 'a'], 'a', (id) => keys[id]).get('a')! > '3');
});

test('planReorder: 키가 일부만 있으면 전체를 다시 매긴다 (바뀌는 것만)', () => {
  const keys: Record<string, string | null> = { a: '1', b: null, c: null };
  const plan = planReorder(['b', 'a', 'c'], 'b', (id) => keys[id]);
  const order = ['b', 'a', 'c'].map((id) => plan.get(id) ?? keys[id]!);
  assert.deepEqual([...order].sort(), order);
});

test('isValidSortKey', () => {
  assert.ok(isValidSortKey('a1'));
  assert.ok(!isValidSortKey(''));
  assert.ok(!isValidSortKey('a0'));
  assert.ok(!isValidSortKey('A'));
  assert.ok(!isValidSortKey('x'.repeat(65)));
  assert.ok(!isValidSortKey(3));
});
