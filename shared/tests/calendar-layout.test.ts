import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSpans, spanEnd } from '../calendar-layout.ts';

const span = (id: string, start: number, end: number) => ({ id, start, end });
const get = (m: ReturnType<typeof layoutSpans>, id: string) => m.get(id)!;

test('겹치지 않는 블록은 각자 한 줄을 다 쓴다', () => {
  const m = layoutSpans([span('a', 60, 120), span('b', 180, 240)]);
  assert.deepEqual(get(m, 'a'), { col: 0, cols: 1 });
  assert.deepEqual(get(m, 'b'), { col: 0, cols: 1 });
});

test('맞닿기만 한 블록(앞 끝 == 뒤 시작)은 겹친 것이 아니다', () => {
  const m = layoutSpans([span('a', 60, 120), span('b', 120, 180)]);
  assert.deepEqual(get(m, 'a'), { col: 0, cols: 1 });
  assert.deepEqual(get(m, 'b'), { col: 0, cols: 1 });
});

test('겹치는 두 블록은 나란히 놓인다', () => {
  const m = layoutSpans([span('a', 60, 150), span('b', 120, 180)]);
  assert.deepEqual(get(m, 'a'), { col: 0, cols: 2 });
  assert.deepEqual(get(m, 'b'), { col: 1, cols: 2 });
});

test('시작이 같으면 긴 블록이 앞 줄이다', () => {
  const m = layoutSpans([span('short', 60, 90), span('long', 60, 180)]);
  assert.equal(get(m, 'long').col, 0);
  assert.equal(get(m, 'short').col, 1);
});

test('먼저 끝난 줄은 다음 블록이 다시 쓴다 (줄 수는 묶음 안의 최대 동시 개수)', () => {
  // a: 60~240 (긴 블록), b: 60~120, c: 120~180 → b 와 c 는 같은 줄을 이어 쓴다
  const m = layoutSpans([span('a', 60, 240), span('b', 60, 120), span('c', 120, 180)]);
  assert.deepEqual(get(m, 'a'), { col: 0, cols: 2 });
  assert.deepEqual(get(m, 'b'), { col: 1, cols: 2 });
  assert.deepEqual(get(m, 'c'), { col: 1, cols: 2 });
});

test('연쇄로 이어진 묶음은 한 묶음이고, 끊기면 줄 수가 다시 시작한다', () => {
  // a~b 겹침, b~c 겹침(a 와 c 는 안 겹침) → 한 묶음. d 는 따로.
  const m = layoutSpans([span('a', 0, 60), span('b', 30, 120), span('c', 90, 150), span('d', 300, 360)]);
  assert.equal(get(m, 'a').cols, 2);
  assert.equal(get(m, 'b').cols, 2);
  assert.equal(get(m, 'c').cols, 2);
  assert.deepEqual(get(m, 'd'), { col: 0, cols: 1 });
  assert.equal(get(m, 'c').col, 0, 'c 는 a 가 끝난 첫 줄로 돌아온다');
});

test('세 블록이 한꺼번에 겹치면 3줄', () => {
  const m = layoutSpans([span('a', 60, 180), span('b', 90, 180), span('c', 100, 180)]);
  assert.deepEqual([get(m, 'a'), get(m, 'b'), get(m, 'c')].map((p) => p.col), [0, 1, 2]);
  for (const id of ['a', 'b', 'c']) assert.equal(get(m, id).cols, 3);
});

test('입력 순서와 상관없이 같은 결과이고, 입력을 바꾸지 않는다', () => {
  const input = [span('b', 120, 180), span('a', 60, 150), span('c', 400, 460)];
  const copy = structuredClone(input);
  const forward = layoutSpans(input);
  const backward = layoutSpans([...input].reverse());
  assert.deepEqual([...forward].sort(), [...backward].sort());
  assert.deepEqual(input, copy);
  assert.equal(layoutSpans([]).size, 0);
});

test('spanEnd: 자정을 넘기지 않는다', () => {
  assert.equal(spanEnd(13 * 60, 120), 15 * 60);
  assert.equal(spanEnd(23 * 60 + 30, 120), 1440);
});
