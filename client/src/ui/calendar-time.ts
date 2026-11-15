// 캘린더의 일·주 보기: 시간 축 격자. 위에는 "하루 종일" 줄(시각 없는 할 일·종일 일정), 아래에는 시각 있는 할 일을
// 시작 시각부터 길이만큼의 블록으로 그린다. 겹치는 블록은 나란히 놓고, 오늘 열에는 현재 시각 선이 있다.
import type { App } from '../app.ts';
import { addDays, parseDate, startOfWeek, weekday } from '../../../shared/calendar.ts';
import { layoutSpans, spanEnd, type TimeSpan } from '../../../shared/calendar-layout.ts';
import { DEFAULT_DURATION, durationOf, locationOf, toMinutes } from '../../../shared/task.ts';
import { sortTasks } from '../../../shared/sort.ts';
import { dayName, formatLong, formatRange } from '../format.ts';
import { eventMinutesOn, eventsByDate, loadEvents, safeColor, wholeDay, type CalendarEvent } from '../gcal-events.ts';
import { listTasksByDueRange, type StoredTask } from '../store/tasks.ts';
import { projectLabels, recurringGhosts, type ProjectLabel } from '../views.ts';
import { h } from './dom.ts';
import { openTaskEditor } from './task-editor.ts';
import { enableGridInteractions, removeTask } from './calendar-drag.ts';

/** 한 시간의 높이(px). 격자 줄무늬(CSS)도 이 값을 --hh 로 받아 쓴다 */
export const HOUR_PX = 52;
const MIN_BLOCK_PX = 20;
/** 아주 짧은 블록도 보이는 높이만큼은 자리를 차지한다 (겹침 계산용, 분) */
const MIN_VISUAL_MIN = Math.ceil((MIN_BLOCK_PX * 60) / HOUR_PX);
const DAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

/** 다시 그려도 보던 세로 위치를 유지한다 */
let savedScroll: number | null = null;
/** 주 보기에서 다시 그려도 보던 가로 위치(맨 왼쪽에 보이던 날짜)를 유지한다 */
let savedLeftDate: string | null = null;

/** 주 보기는 보던 주의 앞뒤로 이만큼의 주를 이어 붙여, 좌우로 밀어 다른 주를 바로 본다 */
export const WEEKS_AROUND = 6;
/** 날짜 열 앞쪽의 시간 눈금 폭(px) — CSS 의 --gutter 와 같다 */
const GUTTER_PX = 56;

export interface TimeGridOptions {
  mode: 'day' | 'week';
  sel: string;
  today: string;
  /** 주 보기에서 날짜 머리글을 누르면 그날의 일 보기로 */
  onPickDay: (date: string) => void;
  /** 주 보기에서 좌우로 밀어 맨 왼쪽에 보이는 날짜가 바뀔 때 (제목을 맞추는 데 쓴다) */
  onVisible?: (leftDate: string) => void;
  /** 이어 붙인 주의 끝에 가까워졌을 때: 보는 날짜를 가운데로 다시 맞추도록 다시 그려 달라고 요청한다 */
  onRecenter?: (leftDate: string) => void;
}

/** 한 주(일~토)의 날짜들. 일 보기는 그날 하루 */
export const gridDays = (mode: 'day' | 'week', sel: string): string[] =>
  mode === 'day' ? [sel] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(sel), i));

/** 실제로 그리는 날짜들: 일 보기는 하루, 주 보기는 보던 주의 앞뒤 WEEKS_AROUND 주를 이어 붙인 것 */
export const renderedDays = (mode: 'day' | 'week', sel: string): string[] => {
  if (mode === 'day') return [sel];
  const first = addDays(startOfWeek(sel), -7 * WEEKS_AROUND);
  return Array.from({ length: 7 * (2 * WEEKS_AROUND + 1) }, (_, i) => addDays(first, i));
};

const hourLabel = (hh: number): string => (hh === 0 ? '' : hh < 12 ? `오전 ${hh}시` : hh === 12 ? '정오' : `오후 ${hh - 12}시`);

type Item =
  | { kind: 'task' | 'ghost'; id: string; task: StoredTask; start: number; end: number }
  | { kind: 'event'; id: string; event: CalendarEvent; start: number; end: number };

export async function renderTimeGrid(app: App, root: HTMLElement, o: TimeGridOptions): Promise<void> {
  const days = renderedDays(o.mode, o.sel);
  const multi = o.mode === 'week';
  const from = days[0]!;
  const to = days[days.length - 1]!;
  const tasks = (await listTasksByDueRange(app.ctx.db, from, to)).filter((t) => !t.deleted);
  const ghosts = await recurringGhosts(app.ctx.db, o.today, from, to);
  const labels = await projectLabels(app.ctx.db);
  const events = eventsByDate(await loadEvents(app, from, to), from, to);
  const now = app.ctx.now();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const inner = h('div', { class: `tg-inner${multi ? ' tg-multi' : ''}`, style: `--days: ${days.length}; --hh: ${HOUR_PX}px` });

  // ── 머리글: 요일·날짜 ──
  const head = h('div', { class: 'tg-row tg-head' }, h('div', { class: 'tg-gutter' }));
  for (const date of days) {
    const { m, d } = parseDate(date);
    const isToday = date === o.today;
    const weekStart = multi && weekday(date) === 0 ? ' tg-week-start' : '';
    const label = h(
      'span',
      { class: 'tg-headlabel' },
      h('span', { class: 'tg-dow' }, DAY_SHORT[weekday(date)]!),
      // 이어 붙인 주 보기에서는 달이 바뀌는 날(1일)에 달을 함께 보인다
      multi && d === 1 ? h('span', { class: 'tg-month', 'aria-hidden': 'true' }, `${m}월`) : null,
      h('span', { class: `tg-date${isToday ? ' is-today' : ''}`, 'aria-hidden': 'true' }, String(d)),
      h('span', { class: 'sr-only' }, ` ${formatLong(date)}${isToday ? ' (오늘)' : ''}`),
    );
    head.appendChild(
      o.mode === 'week'
        ? h('div', { class: `tg-col-head${weekStart}` }, h('button', { type: 'button', class: 'tg-headbtn', 'aria-current': isToday ? 'date' : null, 'data-key': `tg-day:${date}`, onclick: () => o.onPickDay(date) }, label))
        : h('div', { class: `tg-col-head${weekStart}`, 'aria-current': isToday ? 'date' : null }, label),
    );
  }

  // ── 하루 종일 줄 ──
  const allday = h('div', { class: 'tg-row tg-allday' }, h('div', { class: 'tg-gutter' }, h('span', { class: 'tg-gutter-label' }, '하루 종일')));

  const chipFor = (kind: 'task' | 'ghost', t: StoredTask): HTMLElement => {
    const label = labels.get(t.projectId) ?? labels.get('inbox')!;
    return h(
      'button',
      {
        type: 'button',
        class: `tg-chip${t.done ? ' done' : ''}${kind === 'ghost' ? ' ghost' : ''}`,
        'data-color': label.color,
        'data-task-id': kind === 'task' ? t.id : null,
        draggable: kind === 'task' ? 'true' : null,
        'data-key': `${kind === 'ghost' ? 'tg-ghost' : 'tg-task'}:${t.id}`,
        onclick: (ev: Event) => openTaskEditor(app, { task: t, opener: ev.currentTarget as HTMLElement }),
        onkeydown: kind === 'ghost' ? null : (ev: Event) => onDeleteKey(app, t, ev as KeyboardEvent),
      },
      kind === 'ghost' ? h('span', { 'aria-hidden': 'true' }, '↻ ') : null,
      t.done ? h('span', { 'aria-hidden': 'true' }, '✓ ') : null,
      h('span', {}, t.title),
      t.done ? h('span', { class: 'sr-only' }, ' (완료)') : null,
      kind === 'ghost' ? h('span', { class: 'sr-only' }, ' (반복 예정)') : null,
    );
  };

  // ── 본문: 시간 축 + 날짜별 열 ──
  const gutter = h('div', { class: 'tg-gutter tg-hours', 'aria-hidden': 'true' });
  for (let hh = 0; hh < 24; hh++) gutter.appendChild(h('div', { class: 'tg-hour' }, h('span', {}, hourLabel(hh))));
  const body = h('div', { class: 'tg-row tg-body' }, gutter);

  for (const date of days) {
    // 그날의 항목을 모은다
    const dayTasks = sortTasks(tasks.filter((t) => t.dueDate === date)) as StoredTask[];
    const items: Item[] = [];
    const weekStartCls = multi && weekday(date) === 0 ? ' tg-week-start' : '';
    const alldayCell = h('div', { class: `tg-allday-cell${weekStartCls}`, 'data-date': date });
    for (const t of dayTasks) {
      if (t.dueTime) {
        const start = toMinutes(t.dueTime);
        items.push({ kind: 'task', id: `t:${t.id}`, task: t, start, end: spanEnd(start, durationOf(t) ?? DEFAULT_DURATION) });
      } else alldayCell.appendChild(chipFor('task', t));
    }
    for (const t of ghosts.get(date) ?? []) {
      if (t.dueTime) {
        const start = toMinutes(t.dueTime);
        items.push({ kind: 'ghost', id: `g:${t.id}`, task: t, start, end: spanEnd(start, durationOf(t) ?? DEFAULT_DURATION) });
      } else alldayCell.appendChild(chipFor('ghost', t));
    }
    for (const e of events.get(date) ?? []) {
      const span = eventMinutesOn(e, date);
      if (span) items.push({ kind: 'event', id: `e:${e.id}`, event: e, ...span });
      else if (wholeDay(e, date)) {
        const color = safeColor(e.color);
        alldayCell.appendChild(
          h('div', { class: 'tg-chip tg-event', ...(color ? { style: `--ev: ${color}` } : {}) }, h('span', {}, e.title), h('span', { class: 'sr-only' }, ` (${e.calendarName} 일정, 종일)`)),
        );
      }
    }
    allday.appendChild(alldayCell);

    // 겹치는 블록은 나란히
    const spans: TimeSpan[] = items.map((it) => ({ id: it.id, start: it.start, end: Math.max(it.end, it.start + MIN_VISUAL_MIN) }));
    const placed = layoutSpans(spans);

    const col = h('div', { class: `tg-col${weekStartCls}`, role: 'group', 'aria-label': `${formatLong(date)} 일정`, 'data-date': date });
    for (const it of items) {
      const p = placed.get(it.id)!;
      const top = (it.start * HOUR_PX) / 60;
      const height = Math.max(MIN_BLOCK_PX, ((it.end - it.start) * HOUR_PX) / 60 - 1);
      const geo = `top:${top}px;height:${height}px;left:calc(${p.col} * 100% / ${p.cols} + 1px);width:calc(100% / ${p.cols} - 3px)`;
      const range = formatRange(it.start, it.end);
      // 나란히 놓여 좁은 블록은 시작 시각만 보인다 (전체 구간은 title·스크린 리더 이름에 있다)
      const shownTime = p.cols > 1 ? formatRange(it.start, it.end).split(' ~ ')[0]! : range;
      if (it.kind === 'event') {
        const color = safeColor(it.event.color);
        col.appendChild(
          h(
            'div',
            { class: 'tg-block tg-event', style: `${geo}${color ? `;--ev: ${color}` : ''}`, title: `${it.event.title} · ${range}` },
            h('span', { class: 'tg-title' }, it.event.title),
            height >= 38 ? h('span', { class: 'tg-time' }, shownTime) : null,
            h('span', { class: 'sr-only' }, ` (${it.event.calendarName} 일정, ${range})`),
          ),
        );
        continue;
      }
      const t = it.task;
      const label: ProjectLabel = labels.get(t.projectId) ?? labels.get('inbox')!;
      const ghost = it.kind === 'ghost';
      const blockEl = h(
          'button',
          {
            type: 'button',
            class: `tg-block${t.done ? ' done' : ''}${ghost ? ' ghost' : ' movable'}`,
            style: geo,
            'data-task-id': ghost ? null : t.id,
            'data-start': String(it.start),
            'data-end': String(it.end),
            'data-color': label.color,
            'data-priority': String(t.priority),
            'data-key': `${ghost ? 'tg-ghost' : 'tg-task'}:${t.id}:${date}`,
            title: `${t.title} · ${range}${locationOf(t) ? ` · ${locationOf(t)}` : ''}`,
            onclick: (ev: Event) => openTaskEditor(app, { task: t, opener: ev.currentTarget as HTMLElement }),
            onkeydown: ghost ? null : (ev: Event) => onDeleteKey(app, t, ev as KeyboardEvent),
          },
          h('span', { class: 'tg-title' }, ghost ? h('span', { 'aria-hidden': 'true' }, '↻ ') : null, t.done ? h('span', { 'aria-hidden': 'true' }, '✓ ') : null, t.title),
          height >= 38 ? h('span', { class: 'tg-time' }, shownTime) : null,
          h('span', { class: 'sr-only' }, ` (${range}${t.done ? ', 완료' : ''}${ghost ? ', 반복 예정' : ''}, ${label.name})`),
          ghost ? null : h('span', { class: 'tg-resize', 'aria-hidden': 'true', title: '끌어서 길이 바꾸기' }),
        );
      col.appendChild(blockEl);
      if (!ghost) {
        // 마우스를 올리거나 포커스를 두면 나타나는 삭제 버튼 (블록 안에 버튼을 넣을 수 없어 형제로 둔다)
        col.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'tg-del',
              'aria-label': `${t.title} 삭제`,
              'data-key': `tg-del:${t.id}:${date}`,
              style: `top:${top + 2}px;left:calc(${p.col + 1} * 100% / ${p.cols} - 24px)`,
              onclick: () => void removeTask(app, t),
            },
            '×',
          ),
        );
      }
    }
    if (date === o.today) {
      const line = h('div', { class: 'tg-now', 'aria-hidden': 'true', style: `top:${(nowMin * HOUR_PX) / 60}px` });
      col.appendChild(line);
      // 켜 둔 채로 시간이 흐르면 선을 옮긴다 (다시 그려져 사라진 선이면 멈춘다)
      const timer = setInterval(() => {
        if (!line.isConnected) return clearInterval(timer);
        const n = app.ctx.now();
        line.style.top = `${((n.getHours() * 60 + n.getMinutes()) * HOUR_PX) / 60}px`;
      }, 60_000);
    }
    body.appendChild(col);
  }

  const scroller = h(
    'div',
    { class: 'tg-scroll', tabindex: '0', role: 'region', 'aria-label': o.mode === 'day' ? `${dayName(o.sel)} 시간별 일정` : '주간 시간별 일정' },
    inner,
  );
  inner.append(h('div', { class: 'tg-sticky' }, head, allday), body);

  // 한 날짜 열의 폭 (주 보기는 7열이 한 화면에 보이도록 CSS 가 정한다)
  const colWidth = (): number => scroller.querySelector<HTMLElement>('.tg-col')?.getBoundingClientRect().width ?? 0;
  let edgeTimer: ReturnType<typeof setTimeout> | undefined;
  scroller.addEventListener(
    'scroll',
    () => {
      savedScroll = scroller.scrollTop;
      if (!multi) return;
      const w = colWidth();
      if (w <= 0) return;
      const left = days[Math.min(days.length - 1, Math.max(0, Math.round(scroller.scrollLeft / w)))]!;
      savedLeftDate = left;
      o.onVisible?.(left);
      // 이어 붙인 주의 끝에서 한 주 안으로 들어오면, 멈춘 뒤에 보던 자리를 가운데로 다시 맞춘다 (끝이 없는 것처럼)
      clearTimeout(edgeTimer);
      edgeTimer = setTimeout(() => {
        const max = scroller.scrollWidth - scroller.clientWidth;
        if (scroller.scrollLeft < 7 * w || scroller.scrollLeft > max - 7 * w) o.onRecenter?.(left);
      }, 150);
    },
    { passive: true },
  );
  root.appendChild(scroller);
  enableGridInteractions(app, scroller, { hourPx: HOUR_PX, tasks: new Map(tasks.map((t) => [t.id, t])) });

  // 처음에는 지금 시각(오늘이 보일 때) 또는 아침 7시 근처가 보이게, 다시 그릴 때는 보던 자리를 유지한다
  const initial = days.includes(o.today) ? Math.max(0, nowMin / 60 - 1.5) * HOUR_PX : 7 * HOUR_PX;
  // 가로: 보던 날짜가 맨 왼쪽에 오게 (보던 날짜가 선택한 날짜를 포함할 때만 — 다른 곳에서 날짜를 바꿨으면 그 주부터)
  const leftTarget = savedLeftDate && o.sel >= savedLeftDate && o.sel <= addDays(savedLeftDate, 6) && days.includes(savedLeftDate) ? savedLeftDate : startOfWeek(o.sel);
  // 화면은 다른 읽기를 마친 뒤에야 DOM 에 붙는다. 붙기 전에 scroll 위치를 정하면 무시되므로 붙을 때까지 기다린다.
  whenAttached(scroller, () => {
    scroller.scrollTop = savedScroll ?? initial;
    if (multi) {
      const target = scroller.querySelector<HTMLElement>(`.tg-col[data-date="${leftTarget}"]`);
      if (target) scroller.scrollLeft = target.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft - GUTTER_PX;
    }
  });
}

/**
 * 주 보기에서 한 주 앞/뒤로 부드럽게 민다 (이어 붙인 범위를 벗어나면 false — 호출한 쪽이 날짜를 옮겨 다시 그린다).
 * dir 0 은 오늘이 있는 주로 간다.
 */
export function scrollWeeks(dir: -1 | 0 | 1, todayDate: string): boolean {
  const sc = document.querySelector<HTMLElement>('.tg-scroll');
  const first = sc?.querySelector<HTMLElement>('.tg-col');
  if (!sc || !first) return false;
  const w = first.getBoundingClientRect().width;
  let left: number;
  if (dir === 0) {
    const col = sc.querySelector<HTMLElement>(`.tg-col[data-date="${startOfWeek(todayDate)}"]`);
    if (!col) return false;
    left = col.getBoundingClientRect().left - sc.getBoundingClientRect().left + sc.scrollLeft - GUTTER_PX;
  } else left = (weekScrollTarget ?? sc.scrollLeft) + dir * 7 * w; // 앞선 부드러운 스크롤이 끝나기 전에 또 누르면 그 목표에서 이어 간다
  if (left < 0 || left > sc.scrollWidth - sc.clientWidth) return false;
  weekScrollTarget = left;
  clearTimeout(weekScrollTimer);
  weekScrollTimer = setTimeout(() => (weekScrollTarget = null), 800);
  sc.scrollTo({ left, behavior: 'smooth' });
  return true;
}

/** 부드럽게 미는 중인 목표 위치 (연달아 누르면 누적한다) */
let weekScrollTarget: number | null = null;
let weekScrollTimer: ReturnType<typeof setTimeout> | undefined;

/** 블록·칩에 포커스를 둔 채 Delete(맥은 Backspace)를 누르면 지운다 */
function onDeleteKey(app: App, t: StoredTask, ev: KeyboardEvent): void {
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  ev.preventDefault();
  void removeTask(app, t);
}

/** el 이 문서에 붙으면(최대 약 2초) 다음 프레임에 fn 을 실행한다 */
function whenAttached(el: HTMLElement, fn: () => void): void {
  let tries = 120;
  const tick = (): void => {
    if (el.isConnected) fn();
    else if (tries-- > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 다른 화면으로 갔다 오면 처음 위치부터 다시 */
export function resetTimeGridScroll(): void {
  savedScroll = null;
  savedLeftDate = null;
}
