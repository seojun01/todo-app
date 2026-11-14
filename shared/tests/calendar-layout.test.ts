import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickRange, dragRange, layoutSpans, minutesAtY, movedStart, resizedEnd, snapMinutes, spanEnd } from '../calendar-layout.ts';

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

test('snapMinutes / minutesAtY', () => {
  assert.equal(snapMinutes(7), 0);
  assert.equal(snapMinutes(8), 15);
  assert.equal(snapMinutes(52), 45);
  assert.equal(minutesAtY(52, 52), 60);
  assert.equal(minutesAtY(26, 52), 30);
  assert.equal(minutesAtY(-10, 52), 0);
  assert.equal(minutesAtY(99999, 52), 1440);
});

test('movedStart: 15분 단위로 맞추고 하루 안에 가둔다 (끝이 자정을 넘지 않는다)', () => {
  assert.equal(movedStart(13 * 60, 120, 60), 14 * 60);
  assert.equal(movedStart(13 * 60, 120, 22), 13 * 60 + 15);
  assert.equal(movedStart(13 * 60, 120, -9999), 0);
  assert.equal(movedStart(13 * 60, 120, 9999), 1440 - 120, '2시간짜리는 22:00 까지만 내려간다');
  assert.equal(movedStart(60, 30, 0), 60, '안 움직이면 그대로');
});

test('resizedEnd: 단위에 맞추고, 최소 15분·자정 한도를 지킨다', () => {
  assert.equal(resizedEnd(13 * 60, 15 * 60, 30), 15 * 60 + 30);
  assert.equal(resizedEnd(13 * 60, 15 * 60, -9999), 13 * 60 + 15, '시작보다 앞으로는 못 줄인다');
  assert.equal(resizedEnd(23 * 60, 23 * 60 + 30, 9999), 1440);
  assert.equal(resizedEnd(13 * 60, 15 * 60, 7), 15 * 60, '단위보다 작은 움직임은 무시');
});

test('dragRange: 방향과 상관없이 정렬하고 최소 길이를 보장하며 자정을 넘지 않는다', () => {
  assert.deepEqual(dragRange(13 * 60, 15 * 60), { start: 780, end: 900 });
  assert.deepEqual(dragRange(15 * 60, 13 * 60), { start: 780, end: 900 }, '위로 끌어도 같다');
  assert.deepEqual(dragRange(780, 783), { start: 780, end: 795 }, '거의 안 움직이면 15분');
  assert.deepEqual(dragRange(1430, 1440), { start: 1425, end: 1440 });
});

test('clickRange: 누른 30분 칸에서 시작해 한 시간, 자정 근처에서는 앞당긴다', () => {
  assert.deepEqual(clickRange(13 * 60 + 10), { start: 780, end: 840 });
  assert.deepEqual(clickRange(13 * 60 + 40), { start: 810, end: 870 });
  assert.deepEqual(clickRange(23 * 60 + 40), { start: 1380, end: 1440 });
  assert.deepEqual(clickRange(0), { start: 0, end: 60 });
});
