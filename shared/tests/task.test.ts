import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTask,
  validateTitle,
  validateProject,
  validateSettings,
  effectiveProjectId,
  isValidDate,
  isValidTime,
  PROJECT_COLORS,
  type Task,
  type Project,
} from '../task.ts';

const UUID = '3f2c1d7e-8a4b-4c1e-9d3a-0123456789ab';
const UUID2 = '4a2c1d7e-8a4b-4c1e-9d3a-0123456789ac';

function task(over: Partial<Task> = {}): Task {
  return {
    id: UUID,
    title: '장보기',
    dueDate: '2026-11-20',
    dueTime: null,
    projectId: 'inbox',
    priority: 4,
    recurrence: null,
    reminders: [],
    done: false,
    createdAt: '2026-11-12T12:00:00.000Z',
    deleted: false,
    version: '001762950896789-000000-dev',
    updatedBy: 'dev',
    ...over,
  };
}
const fields = (errs: { field: string }[]) => errs.map((e) => e.field);

test('title: 앞뒤 공백 제거 후 1~200자(코드 포인트 기준)', () => {
  assert.deepEqual(validateTitle('  장보기  '), { ok: true, value: '장보기' });
  assert.equal(validateTitle('').ok, false);
  assert.equal(validateTitle('   \t ').ok, false);
  assert.equal(validateTitle('a'.repeat(200)).ok, true);
  assert.equal(validateTitle('a'.repeat(201)).ok, false);
  // 이모지는 UTF-16 으로는 2칸이지만 코드 포인트 1개다
  assert.equal(validateTitle('😀'.repeat(200)).ok, true);
  assert.equal(validateTitle('😀'.repeat(201)).ok, false);
  // 앞뒤 공백을 지운 뒤 길이를 센다
  assert.equal(validateTitle(' ' + 'a'.repeat(200) + ' ').ok, true);
});

test('date: YYYY-MM-DD, 유효한 그레고리력 날짜', () => {
  for (const ok of ['2026-11-20', '2028-02-29', '2026-11-30', '2026-12-31']) assert.equal(isValidDate(ok), true, ok);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '2026-11-20T00:00', '2027-02-29', '', '20261120', '2026-00-10', '2026-11-00'])
    assert.equal(isValidDate(bad), false, bad);
});

test('time: HH:MM 24시간', () => {
  for (const ok of ['00:00', '09:00', '15:30', '23:59']) assert.equal(isValidTime(ok), true, ok);
  for (const bad of ['24:00', '9:00', '09:60', '15:30:00', '', '0900']) assert.equal(isValidTime(bad), false, bad);
});

test('validateTask: 정상 레코드는 오류가 없다', () => {
  assert.deepEqual(validateTask(task()), []);
  assert.deepEqual(validateTask(task({ dueDate: null })), []);
});

test('validateTask: 필드 규칙', () => {
  assert.ok(fields(validateTask(task({ title: '' }))).includes('title'));
  assert.ok(fields(validateTask(task({ title: ' 공백 ' }))).includes('title'), '앞뒤 공백이 남아 있으면 거부');
  assert.ok(fields(validateTask(task({ title: 'a'.repeat(201) }))).includes('title'));
  assert.ok(fields(validateTask(task({ dueDate: '2026-02-30' }))).includes('dueDate'));
  assert.ok(fields(validateTask(task({ dueTime: '24:00' }))).includes('dueTime'));
  assert.ok(fields(validateTask(task({ id: 'abc' }))).includes('id'));
  for (const p of [0, 5, 1.5, -1]) assert.ok(fields(validateTask(task({ priority: p as never }))).includes('priority'), String(p));
  for (const p of [1, 2, 3, 4]) assert.deepEqual(validateTask(task({ priority: p as never })), []);
  assert.ok(fields(validateTask(task({ createdAt: 'yesterday' }))).includes('createdAt'));
});

test('validateTask: 교차 규칙 — dueDate 가 없으면 dueTime·recurrence·reminders 도 없어야 한다', () => {
  assert.ok(fields(validateTask(task({ dueDate: null, dueTime: '09:00' }))).includes('dueTime'));
  assert.ok(
    fields(validateTask(task({ dueDate: null, recurrence: { unit: 'day', interval: 1 } }))).includes('recurrence'),
  );
  assert.ok(fields(validateTask(task({ dueDate: null, reminders: ['day'] }))).includes('reminders'));
});

test('validateTask: reminders 는 중복 없는 집합이고 시각 유무에 따라 종류가 제한된다', () => {
  // 시각 없음: day, 1d 만
  assert.deepEqual(validateTask(task({ reminders: ['day', '1d'] })), []);
  for (const k of ['at', '10m', '30m', '1h'] as const) assert.ok(fields(validateTask(task({ reminders: [k] }))).includes('reminders'), k);
  // 시각 있음: at, 10m, 30m, 1h, 1d 만
  const t = { dueTime: '15:00' };
  assert.deepEqual(validateTask(task({ ...t, reminders: ['at', '10m', '30m', '1h', '1d'] })), []);
  assert.ok(fields(validateTask(task({ ...t, reminders: ['day'] }))).includes('reminders'));
  // 중복, 알 수 없는 종류
  assert.ok(fields(validateTask(task({ ...t, reminders: ['at', 'at'] }))).includes('reminders'));
  assert.ok(fields(validateTask(task({ ...t, reminders: ['2h' as never] }))).includes('reminders'));
});

test('validateTask: recurrence 필드 규칙', () => {
  const rec = (r: object) => task({ recurrence: r as never });
  // unit 별 필수 필드
  assert.deepEqual(validateTask(rec({ unit: 'day', interval: 3 })), []);
  assert.deepEqual(validateTask(rec({ unit: 'week', interval: 1, weekdays: [1, 3, 5] })), []);
  assert.deepEqual(validateTask(rec({ unit: 'month', interval: 1, dayOfMonth: 31 })), []);
  assert.deepEqual(validateTask(rec({ unit: 'year', interval: 1, month: 2, dayOfMonth: 29 })), []);
  // interval 1..99
  for (const n of [0, 100, 1.5, -2]) assert.ok(fields(validateTask(rec({ unit: 'day', interval: n }))).includes('recurrence'), `interval ${n}`);
  assert.deepEqual(validateTask(rec({ unit: 'day', interval: 99 })), []);
  // weekdays: 0(일)~6(토), 중복 없는 비어 있지 않은 집합
  for (const w of [undefined, [], [7], [-1], [1, 1], [1.5]])
    assert.ok(fields(validateTask(rec({ unit: 'week', interval: 1, weekdays: w }))).includes('recurrence'), JSON.stringify(w));
  // dayOfMonth 1..31, month 1..12
  assert.ok(fields(validateTask(rec({ unit: 'month', interval: 1 }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'month', interval: 1, dayOfMonth: 32 }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'month', interval: 1, dayOfMonth: 0 }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'year', interval: 1, dayOfMonth: 1 }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'year', interval: 1, month: 13, dayOfMonth: 1 }))).includes('recurrence'));
  // unit 에 맞지 않는 필드는 거부
  assert.ok(fields(validateTask(rec({ unit: 'day', interval: 1, weekdays: [1] }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'week', interval: 1, weekdays: [1], dayOfMonth: 3 }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'month', interval: 1, dayOfMonth: 3, month: 2 }))).includes('recurrence'));
  assert.ok(fields(validateTask(rec({ unit: 'hour', interval: 1 }))).includes('recurrence'));
});

test('validateTask: recurrence.endDate 는 현재 dueDate 보다 빠르면 거부', () => {
  const rec = (endDate: string) => task({ dueDate: '2026-11-20', recurrence: { unit: 'day', interval: 1, endDate } });
  assert.ok(fields(validateTask(rec('2026-11-19'))).includes('recurrence'));
  assert.deepEqual(validateTask(rec('2026-11-20')), []);
  assert.deepEqual(validateTask(rec('2027-01-01')), []);
  assert.ok(fields(validateTask(rec('2026-02-30'))).includes('recurrence'));
});

test('validateProject: 이름 1~50자(코드 포인트), 팔레트 색상, inbox 레코드 거부', () => {
  const p = (over: Partial<Project> = {}): Project => ({
    id: UUID2,
    name: '업무',
    color: 'blue',
    createdAt: '2026-11-12T12:00:00.000Z',
    deleted: false,
    version: '001762950896789-000000-dev',
    updatedBy: 'dev',
    ...over,
  });
  assert.deepEqual(validateProject(p()), []);
  assert.ok(fields(validateProject(p({ name: '' }))).includes('name'));
  assert.ok(fields(validateProject(p({ name: '   ' }))).includes('name'));
  assert.ok(fields(validateProject(p({ name: ' 업무 ' }))).includes('name'), '앞뒤 공백');
  assert.deepEqual(validateProject(p({ name: 'a'.repeat(50) })), []);
  assert.ok(fields(validateProject(p({ name: 'a'.repeat(51) }))).includes('name'));
  assert.deepEqual(validateProject(p({ name: '😀'.repeat(50) })), []);
  assert.ok(fields(validateProject(p({ name: '😀'.repeat(51) }))).includes('name'));
  assert.deepEqual(PROJECT_COLORS, ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray']);
  for (const c of PROJECT_COLORS) assert.deepEqual(validateProject(p({ color: c })), []);
  assert.ok(fields(validateProject(p({ color: 'pink' as never }))).includes('color'));
  assert.ok(fields(validateProject(p({ id: 'inbox' }))).includes('id'));
});

test('validateSettings: defaultReminderTime 은 HH:MM', () => {
  const s = (t: string) => ({ id: 'settings' as const, defaultReminderTime: t, version: '001762950896789-000000-dev', updatedBy: 'dev' });
  assert.deepEqual(validateSettings(s('09:00')), []);
  assert.ok(fields(validateSettings(s('9:00'))).includes('defaultReminderTime'));
  assert.ok(fields(validateSettings(s('25:00'))).includes('defaultReminderTime'));
  assert.ok(fields(validateSettings({ ...s('09:00'), id: 'x' as never })).includes('id'));
});

test('effectiveProjectId: 프로젝트가 없거나 삭제되면 inbox', () => {
  const live: Project = { id: UUID2, name: 'a', color: 'gray', createdAt: '2026-11-12T00:00:00.000Z', deleted: false, version: 'v', updatedBy: 'd' };
  const dead: Project = { ...live, id: '5b2c1d7e-8a4b-4c1e-9d3a-0123456789ad', deleted: true };
  const projects = [live, dead];
  assert.equal(effectiveProjectId(task({ projectId: 'inbox' }), projects), 'inbox');
  assert.equal(effectiveProjectId(task({ projectId: live.id }), projects), live.id);
  assert.equal(effectiveProjectId(task({ projectId: dead.id }), projects), 'inbox');
  assert.equal(effectiveProjectId(task({ projectId: '6c2c1d7e-8a4b-4c1e-9d3a-0123456789ae' }), projects), 'inbox');
});

// ── 태그 ──

import { MAX_TAG, MAX_TAGS, isValidTag, normalizeTags, parseTags, tagKey, tagsOf } from '../task.ts';

test('태그: 없는 필드(옛 데이터)는 유효하고 빈 목록으로 읽힌다', () => {
  const t = task();
  delete (t as { tags?: string[] }).tags;
  assert.deepEqual(validateTask(t), []);
  assert.deepEqual(tagsOf(t), []);
  assert.deepEqual(validateTask(task({ tags: [] })), []);
});

test('태그: 형식·개수·중복 규칙', () => {
  assert.deepEqual(validateTask(task({ tags: ['집', 'Urgent', '2026_계획'] })), []);
  const rule = (tags: unknown) => validateTask(task({ tags: tags as string[] })).find((e) => e.field === 'tags')?.rule;
  assert.equal(rule('집'), 'type');
  assert.equal(rule(['a b']), 'format', '공백 불가');
  assert.equal(rule(['a,b']), 'format', '쉼표 불가');
  assert.equal(rule(['#집']), 'format', '# 는 입력할 때만 떼고 저장하지 않는다');
  assert.equal(rule(['']), 'format');
  assert.equal(rule([1]), 'format');
  assert.equal(rule(['가'.repeat(MAX_TAG + 1)]), 'format');
  assert.equal(rule(['가'.repeat(MAX_TAG)]), undefined, '30자까지');
  assert.equal(rule(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)), 'count');
  assert.equal(rule(Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`)), undefined, '10개까지');
  assert.equal(rule(['Home', 'home']), 'unique', '대소문자만 다른 태그는 같은 태그');
});

test('태그: 길이는 코드 포인트로 센다 (이모지 30개는 허용)', () => {
  assert.equal(isValidTag('😀'.repeat(MAX_TAG)), true);
  assert.equal(isValidTag('😀'.repeat(MAX_TAG + 1)), false);
});

test('태그: parseTags 는 공백·쉼표로 나누고 # 를 떼고 중복(대소문자 무시)을 없앤다', () => {
  assert.deepEqual(parseTags('집, 급함  #업무'), ['집', '급함', '업무']);
  assert.deepEqual(parseTags('  '), []);
  assert.deepEqual(parseTags('Home home HOME'), ['Home'], '먼저 쓴 표기를 남긴다');
  assert.deepEqual(parseTags('##a #'), ['a']);
  assert.deepEqual(normalizeTags([' a ', '#b', 'A', '']), ['a', 'b']);
  assert.equal(tagKey('Home'), tagKey('hOME'));
});

// ── 빠른 추가의 #태그 (앞·끝) ──

import { splitInlineTags } from '../task.ts';

test('#태그 분리: 끝에 붙여 쓴 것은 태그로 떼고 제목은 그대로 둔다', () => {
  assert.deepEqual(splitInlineTags('장보기 #집'), { title: '장보기', tags: ['집'] });
  assert.deepEqual(splitInlineTags('장보기 #집 #급함'), { title: '장보기', tags: ['집', '급함'] });
  assert.deepEqual(splitInlineTags('  장보기   우유  #집  '), { title: '장보기   우유', tags: ['집'] }, '제목 안의 공백은 그대로');
  assert.deepEqual(splitInlineTags('보고서 #Home #home'), { title: '보고서', tags: ['Home'] }, '대소문자만 다른 중복은 하나로');
  assert.deepEqual(splitInlineTags('회의\t#a'), { title: '회의', tags: ['a'] }, '탭 구분');
  // 실제로 입력했던 모양
  assert.deepEqual(splitInlineTags('치과 #개인'), { title: '치과', tags: ['개인'] });
  assert.deepEqual(splitInlineTags('ㄱㄱ #개인'), { title: 'ㄱㄱ', tags: ['개인'] });
});

test('#태그 분리: 앞에 붙여 쓴 것도 태그로 뗀다 (앞·끝을 함께 써도 된다)', () => {
  assert.deepEqual(splitInlineTags('#개인 이이'), { title: '이이', tags: ['개인'] });
  assert.deepEqual(splitInlineTags('#집 #급함 장보기'), { title: '장보기', tags: ['집', '급함'] });
  assert.deepEqual(splitInlineTags('#집 장보기 우유 #급함'), { title: '장보기 우유', tags: ['집', '급함'] });
  assert.deepEqual(splitInlineTags('#집   장보기   우유'), { title: '장보기   우유', tags: ['집'] }, '제목 안의 공백은 그대로');
  assert.deepEqual(splitInlineTags('#Home 청소 #home'), { title: '청소', tags: ['Home'] }, '앞과 끝의 중복도 하나로');
});

test('#태그 분리: 중간의 #는 제목의 일부이고, 숫자뿐인 #1·#123 은 번호라서 태그가 아니다', () => {
  for (const text of ['C# 공부', '버그 #123 수정', '가격 # 5', '그냥 글 #', '#1 우선 처리', '회의 #1', '#2026 계획']) {
    assert.deepEqual(splitInlineTags(text), { title: text, tags: [] }, JSON.stringify(text));
  }
  // 중간은 그대로 두고 끝·앞의 연속된 태그만 뗀다
  assert.deepEqual(splitInlineTags('버그 #123 수정 #급함'), { title: '버그 #123 수정', tags: ['급함'] });
  assert.deepEqual(splitInlineTags('#급함 버그 #123 수정'), { title: '버그 #123 수정', tags: ['급함'] });
  assert.deepEqual(splitInlineTags('프로젝트 #집 정리'), { title: '프로젝트 #집 정리', tags: [] }, '중간의 #집 은 그대로');
  // 숫자가 사이에 끼면 거기서 끊긴다: 끝의 연속 태그는 #급함 뿐
  assert.deepEqual(splitInlineTags('회의 #급함 #1'), { title: '회의 #급함 #1', tags: [] });
  assert.deepEqual(splitInlineTags('#1 #급함 회의'), { title: '#1 #급함 회의', tags: [] });
});

test('#태그 분리: 태그뿐인 글·빈 글은 아무것도 떼지 않는다 (제목이 사라지므로)', () => {
  for (const text of ['#집', '#집 #급함', '#', '##', '', '   ', '#a #b #c']) {
    assert.deepEqual(splitInlineTags(text), { title: text, tags: [] }, JSON.stringify(text));
  }
  assert.deepEqual(splitInlineTags('할 일 ##집'), { title: '할 일', tags: ['집'] }, '# 를 여러 개 써도 하나로');
  assert.deepEqual(splitInlineTags('##집 할 일'), { title: '할 일', tags: ['집'] });
  assert.deepEqual(splitInlineTags('할할##집'), { title: '할할##집', tags: [] }, '글자에 붙은 #는 태그가 아니다');
});

test('#태그 분리: 태그가 잘못됐거나(31자) 11개를 넘으면 아무것도 떼지 않는다', () => {
  const long = '가'.repeat(31);
  assert.deepEqual(splitInlineTags(`할 일 #${long}`), { title: `할 일 #${long}`, tags: [] });
  assert.deepEqual(splitInlineTags(`#${long} 할 일`), { title: `#${long} 할 일`, tags: [] });
  assert.deepEqual(splitInlineTags(`할 일 #${'가'.repeat(30)}`).tags, ['가'.repeat(30)], '30자는 된다');
  const eleven = Array.from({ length: 11 }, (_, i) => `#t${i}`).join(' ');
  assert.deepEqual(splitInlineTags(`할 일 ${eleven}`), { title: `할 일 ${eleven}`, tags: [] });
  const ten = Array.from({ length: 10 }, (_, i) => `#t${i}`).join(' ');
  assert.equal(splitInlineTags(`할 일 ${ten}`).tags.length, 10);
  assert.equal(splitInlineTags(`${ten} 할 일`).tags.length, 10);
  // 앞 6개 + 끝 5개 = 11개
  assert.deepEqual(splitInlineTags('#a #b #c #d #e #f 할 일 #g #h #i #j #k').tags, [], '앞뒤를 합쳐 11개면 거부');
  // 쉼표는 태그 문자가 아니다
  assert.deepEqual(splitInlineTags('할 일 #a,b'), { title: '할 일 #a,b', tags: [] });
});

test('#태그 분리: 아주 긴 입력도 빠르게 끝난다', () => {
  const t = Date.now();
  splitInlineTags(('가 #나 '.repeat(5000)).trim());
  splitInlineTags('#'.repeat(20000));
  splitInlineTags(`${'가 '.repeat(20000)}#집`);
  assert.ok(Date.now() - t < 500, '정규식이 폭주하지 않는다');
});
