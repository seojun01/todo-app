// 캘린더의 일·주 보기: 시간 축 격자. 위에는 "하루 종일" 줄(시각 없는 할 일·종일 일정), 아래에는 시각 있는 할 일을
// 시작 시각부터 길이만큼의 블록으로 그린다. 겹치는 블록은 나란히 놓고, 오늘 열에는 현재 시각 선이 있다.
import type { App } from '../app.ts';
import { addDays, parseDate, startOfWeek, weekday } from '../../../shared/calendar.ts';
import { layoutSpans, spanEnd, type TimeSpan } from '../../../shared/calendar-layout.ts';
import { DEFAULT_DURATION, durationOf, toMinutes } from '../../../shared/task.ts';
import { sortTasks } from '../../../shared/sort.ts';
import { dayName, formatLong, formatTime } from '../format.ts';
import { eventMinutesOn, eventsByDate, loadEvents, safeColor, wholeDay, type CalendarEvent } from '../gcal-events.ts';
import { listTasksByDueRange, type StoredTask } from '../store/tasks.ts';
import { projectLabels, recurringGhosts, type ProjectLabel } from '../views.ts';
import { h } from './dom.ts';
import { openTaskEditor } from './task-editor.ts';

/** 한 시간의 높이(px). 격자 줄무늬(CSS)도 이 값을 --hh 로 받아 쓴다 */
export const HOUR_PX = 52;
const MIN_BLOCK_PX = 20;
/** 아주 짧은 블록도 보이는 높이만큼은 자리를 차지한다 (겹침 계산용, 분) */
const MIN_VISUAL_MIN = Math.ceil((MIN_BLOCK_PX * 60) / HOUR_PX);
const DAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

/** 다시 그려도 보던 세로 위치를 유지한다 */
let savedScroll: number | null = null;

export interface TimeGridOptions {
  mode: 'day' | 'week';
  sel: string;
  today: string;
  /** 주 보기에서 날짜 머리글을 누르면 그날의 일 보기로 */
  onPickDay: (date: string) => void;
}

/** 이 보기가 보여 주는 날짜들 */
export const gridDays = (mode: 'day' | 'week', sel: string): string[] =>
  mode === 'day' ? [sel] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(sel), i));

const hourLabel = (hh: number): string => (hh === 0 ? '' : hh < 12 ? `오전 ${hh}시` : hh === 12 ? '정오' : `오후 ${hh - 12}시`);

/** "오후 1:00 ~ 오후 3:00" (자정에 끝나면 "자정") */
export function rangeLabel(start: number, end: number): string {
  const t = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${formatTime(t(start))} ~ ${end >= 1440 ? '자정' : formatTime(t(end))}`;
}

type Item =
  | { kind: 'task' | 'ghost'; id: string; task: StoredTask; start: number; end: number }
  | { kind: 'event'; id: string; event: CalendarEvent; start: number; end: number };

export async function renderTimeGrid(app: App, root: HTMLElement, o: TimeGridOptions): Promise<void> {
  const days = gridDays(o.mode, o.sel);
  const from = days[0]!;
  const to = days[days.length - 1]!;
  const tasks = (await listTasksByDueRange(app.ctx.db, from, to)).filter((t) => !t.deleted);
  const ghosts = await recurringGhosts(app.ctx.db, o.today, from, to);
  const labels = await projectLabels(app.ctx.db);
  const events = eventsByDate(await loadEvents(app, from, to), from, to);
  const now = app.ctx.now();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const inner = h('div', { class: 'tg-inner', style: `--days: ${days.length}; --hh: ${HOUR_PX}px` });

  // ── 머리글: 요일·날짜 ──
  const head = h('div', { class: 'tg-row tg-head' }, h('div', { class: 'tg-gutter' }));
  for (const date of days) {
    const { d } = parseDate(date);
    const isToday = date === o.today;
    const label = h(
      'span',
      { class: 'tg-headlabel' },
      h('span', { class: 'tg-dow' }, DAY_SHORT[weekday(date)]!),
      h('span', { class: `tg-date${isToday ? ' is-today' : ''}`, 'aria-hidden': 'true' }, String(d)),
      h('span', { class: 'sr-only' }, ` ${formatLong(date)}${isToday ? ' (오늘)' : ''}`),
    );
    head.appendChild(
      o.mode === 'week'
        ? h('div', { class: 'tg-col-head' }, h('button', { type: 'button', class: 'tg-headbtn', 'aria-current': isToday ? 'date' : null, 'data-key': `tg-day:${date}`, onclick: () => o.onPickDay(date) }, label))
        : h('div', { class: 'tg-col-head', 'aria-current': isToday ? 'date' : null }, label),
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
        'data-key': `${kind === 'ghost' ? 'tg-ghost' : 'tg-task'}:${t.id}`,
        onclick: (ev: Event) => openTaskEditor(app, { task: t, opener: ev.currentTarget as HTMLElement }),
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
    const alldayCell = h('div', { class: 'tg-allday-cell' });
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

    const col = h('div', { class: 'tg-col', role: 'group', 'aria-label': `${formatLong(date)} 일정`, 'data-date': date });
    for (const it of items) {
      const p = placed.get(it.id)!;
      const top = (it.start * HOUR_PX) / 60;
      const height = Math.max(MIN_BLOCK_PX, ((it.end - it.start) * HOUR_PX) / 60 - 1);
      const geo = `top:${top}px;height:${height}px;left:calc(${p.col} * 100% / ${p.cols} + 1px);width:calc(100% / ${p.cols} - 3px)`;
      const range = rangeLabel(it.start, it.end);
      // 나란히 놓여 좁은 블록은 시작 시각만 보인다 (전체 구간은 title·스크린 리더 이름에 있다)
      const shownTime = p.cols > 1 ? rangeLabel(it.start, it.end).split(' ~ ')[0]! : range;
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
      col.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: `tg-block${t.done ? ' done' : ''}${ghost ? ' ghost' : ''}`,
            style: geo,
            'data-color': label.color,
            'data-priority': String(t.priority),
            'data-key': `${ghost ? 'tg-ghost' : 'tg-task'}:${t.id}:${date}`,
            title: `${t.title} · ${range}`,
            onclick: (ev: Event) => openTaskEditor(app, { task: t, opener: ev.currentTarget as HTMLElement }),
          },
          h('span', { class: 'tg-title' }, ghost ? h('span', { 'aria-hidden': 'true' }, '↻ ') : null, t.done ? h('span', { 'aria-hidden': 'true' }, '✓ ') : null, t.title),
          height >= 38 ? h('span', { class: 'tg-time' }, shownTime) : null,
          h('span', { class: 'sr-only' }, ` (${range}${t.done ? ', 완료' : ''}${ghost ? ', 반복 예정' : ''}, ${label.name})`),
        ),
      );
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
  scroller.addEventListener('scroll', () => (savedScroll = scroller.scrollTop), { passive: true });
  root.appendChild(scroller);

  // 처음에는 지금 시각(오늘이 보일 때) 또는 아침 7시 근처가 보이게, 다시 그릴 때는 보던 자리를 유지한다
  const initial = days.includes(o.today) ? Math.max(0, nowMin / 60 - 1.5) * HOUR_PX : 7 * HOUR_PX;
  requestAnimationFrame(() => {
    scroller.scrollTop = savedScroll ?? initial;
  });
}

/** 다른 화면으로 갔다 오면 처음 위치부터 다시 */
export function resetTimeGridScroll(): void {
  savedScroll = null;
}
