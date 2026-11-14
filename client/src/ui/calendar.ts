// 월간 캘린더: 날짜별 남은 개수·"모두 완료" 표시, 날짜 선택, 키보드 이동 (FR-005, FR-037)
import type { App, ViewRenderer } from '../app.ts';
import { addDays, addMonths, monthGrid, parseDate, startOfWeek } from '../../../shared/calendar.ts';
import { formatLong } from '../format.ts';
import { eventShortTime, eventsByDate, loadEvents, safeColor } from '../gcal-events.ts';
import { DAY_PREVIEW_MAX, dayTasks, projectLabels, recurringGhosts, summarizeMonth } from '../views.ts';
import { h } from './dom.ts';
import { renderEventList } from './event-list.ts';
import { renderCompleted, renderGhostList, renderQuickAdd, renderTaskList } from './task-list.ts';
import { gridDays, renderTimeGrid, resetTimeGridScroll, scrollWeeks } from './calendar-time.ts';
import { renderYear } from './calendar-year.ts';
import { openTaskEditor } from './task-editor.ts';

const DAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_LONG = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/** 화면을 다시 그려도 유지되는 상태: 선택한 날짜 (보이는 달은 선택한 날짜를 따른다) */
let selected: string | null = null;
let lastToday: string | null = null;

/** 보기 방식. 마지막으로 고른 것을 이 기기에 기억한다 (처음에는 월) */
type Mode = 'day' | 'week' | 'month' | 'year';
const MODES: { mode: Mode; label: string }[] = [
  { mode: 'day', label: '일' },
  { mode: 'week', label: '주' },
  { mode: 'month', label: '월' },
  { mode: 'year', label: '년' },
];
const MODE_KEY = 'todo.cal-mode';
let mode: Mode = readMode();

function readMode(): Mode {
  try {
    const v = globalThis.localStorage?.getItem(MODE_KEY);
    return v === 'day' || v === 'week' || v === 'month' || v === 'year' ? v : 'month';
  } catch {
    return 'month'; // 저장소를 쓸 수 없으면 기억만 건너뛴다
  }
}

async function setMode(app: App, next: Mode): Promise<void> {
  mode = next;
  try {
    globalThis.localStorage?.setItem(MODE_KEY, next);
  } catch {
    /* 기억만 건너뛴다 */
  }
  await app.refresh();
}

/** 이전·다음으로 한 칸 움직인 날짜 (일: 하루, 주: 7일, 년: 12개월) */
const shifted = (unit: Mode, date: string, dir: -1 | 1): string => (unit === 'day' ? addDays(date, dir) : unit === 'week' ? addDays(date, 7 * dir) : addMonths(date, 12 * dir));

const UNIT_LABELS: Record<'day' | 'week' | 'year', [string, string]> = { day: ['이전 날', '다음 날'], week: ['이전 주', '다음 주'], year: ['이전 해', '다음 해'] };

/** 일·주·년 보기의 제목: 일 "11월 14일 토요일", 주 "2026년 11월" (두 달에 걸치면 "2026년 11월 ~ 12월"), 년 "2026년" */
function unitTitle(unit: 'day' | 'week' | 'year', sel: string): string {
  if (unit === 'day') return formatLong(sel);
  if (unit === 'year') return `${parseDate(sel).y}년`;
  const days = gridDays('week', sel);
  const a = parseDate(days[0]!);
  const b = parseDate(days[6]!);
  if (a.y !== b.y) return `${a.y}년 ${a.m}월 ~ ${b.y}년 ${b.m}월`;
  return a.m === b.m ? `${a.y}년 ${a.m}월` : `${a.y}년 ${a.m}월 ~ ${b.m}월`;
}

/** 일·주·월·년 전환과 "일정 추가" */
function renderModeBar(app: App, sel: string): HTMLElement {
  return h(
    'div',
    { class: 'cal-modebar' },
    h(
      'div',
      { class: 'cal-modes', role: 'group', 'aria-label': '보기 방식' },
      ...MODES.map(({ mode: m, label }) =>
        h('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': String(mode === m), 'data-key': `cal-mode:${m}`, onclick: () => void setMode(app, m) }, label),
      ),
    ),
    h('button', { type: 'button', class: 'btn btn-small btn-primary', 'data-key': 'cal-add', onclick: (ev: Event) => void openTaskEditor(app, { defaults: { dueDate: sel }, opener: ev.currentTarget as HTMLElement }) }, '+ 일정 추가'),
  );
}

/** 일·주·년 보기의 이전/오늘/다음과 제목 */
function renderUnitNav(app: App, unit: 'day' | 'week' | 'year', sel: string, today: string): HTMLElement {
  const go = async (date: string): Promise<void> => {
    selected = date;
    await app.refresh();
  };
  // 주 보기는 이어 붙인 화면을 한 주만큼 부드럽게 민다. 이어 붙인 범위를 벗어나면 날짜를 옮겨 다시 그린다.
  const step = (dir: -1 | 1) => (): void => {
    if (unit === 'week' && scrollWeeks(dir, today)) return;
    void go(shifted(unit, sel, dir));
  };
  const goToday = (): void => {
    if (unit === 'week') {
      selected = today;
      if (scrollWeeks(0, today)) return;
    }
    void go(today);
  };
  const [prev, next] = UNIT_LABELS[unit];
  return h(
    'div',
    { class: 'cal-nav' },
    h('button', { type: 'button', class: 'btn btn-small', onclick: step(-1) }, prev),
    h('h3', { 'data-title': 'true' }, unitTitle(unit, sel)),
    h('button', { type: 'button', class: 'btn btn-small', onclick: step(1) }, next),
    h('button', { type: 'button', class: 'btn btn-small', onclick: goToday }, '오늘'),
  );
}

export const renderCalendar: ViewRenderer = async (app, root) => {
  const today = app.today();
  // 처음 열면(또는 날짜가 바뀌면) 오늘이 선택된 상태로 보여 준다
  if (selected === null || lastToday !== today) {
    selected = today;
    lastToday = today;
  }
  const sel = selected;
  root.appendChild(h('div', { class: 'view-header' }, h('h2', {}, '캘린더')));
  root.appendChild(renderModeBar(app, sel));
  if (mode === 'month') return renderMonth(app, root, today, sel);
  const unitNav = renderUnitNav(app, mode, sel, today);
  root.appendChild(unitNav);
  if (mode === 'year') {
    return renderYear(app, root, {
      year: parseDate(sel).y,
      sel,
      today,
      onPickDay: (date) => {
        selected = date;
        void setMode(app, 'day');
      },
      onPickMonth: (date) => {
        selected = date;
        void setMode(app, 'month');
      },
    });
  }
  return renderTimeGrid(app, root, {
    mode,
    sel,
    today,
    onPickDay: (date) => {
      selected = date;
      void setMode(app, 'day');
    },
    // 주 보기: 좌우로 밀어 보이는 주가 바뀌면 제목을 맞추고, 선택한 날짜가 화면 밖이면 보이는 첫 날로 옮긴다
    onVisible: (left) => {
      const title = unitNav.querySelector('[data-title]');
      if (title) title.textContent = unitTitle('week', left);
      if (selected === null || selected < left || selected > addDays(left, 6)) selected = left;
    },
    onRecenter: (left) => {
      if (selected === null || selected < left || selected > addDays(left, 6)) selected = left;
      void app.refresh();
    },
  });
};

/** 다른 화면으로 이동했다가 돌아오면 시간 격자는 처음 위치부터 다시 보인다 */
export function resetCalendar(): void {
  resetTimeGridScroll();
}

async function renderMonth(app: App, root: HTMLElement, today: string, sel: string): Promise<void> {
  const { y, m } = parseDate(sel);
  const summary = await summarizeMonth(app.ctx.db, y, m, today);
  const gridDates = monthGrid(y, m);
  // 구글 캘린더에서 불러온 일정 (불러오기를 켜지 않았거나 실패하면 비어 있다)
  const eventMap = eventsByDate(await loadEvents(app, gridDates[0]!, gridDates[gridDates.length - 1]!), gridDates[0]!, gridDates[gridDates.length - 1]!);

  async function select(date: string, focus = false): Promise<void> {
    selected = date;
    await app.refresh();
    if (focus) document.querySelector<HTMLElement>(`[data-key="cal:${date}"]`)?.focus();
  }

  root.appendChild(
    h(
      'div',
      { class: 'cal-nav' },
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => void select(addMonths(sel, -1)) }, '이전 달'),
      h('h3', {}, `${y}년 ${m}월`),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => void select(addMonths(sel, 1)) }, '다음 달'),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => void select(today) }, '오늘'),
    ),
  );

  const head = h(
    'div',
    { class: 'cal-grid', role: 'row' },
    ...DAY_SHORT.map((d, i) => h('div', { class: 'cal-head', role: 'columnheader', 'aria-label': DAY_LONG[i] }, d)),
  );
  const cells = gridDates.map((date) => {
    const { m: cm, d } = parseDate(date);
    const inMonth = cm === m;
    const s = inMonth ? summary.get(date) : undefined;
    const evs = inMonth ? (eventMap.get(date) ?? []) : [];
    // 접근 가능한 이름은 "보이는 숫자"로 시작해야 한다(WCAG 2.5.3). 달 정보는 격자의 이름("2026년 11월")이 맡고,
    // 이웃 달의 칸에만 달을 덧붙인다. 현황은 색상·아이콘 외에 글로도 읽힌다.
    let spoken = ' 일';
    const label = (p: { title: string; time: string | null }) => (p.time ? `${p.time} ${p.title}` : p.title);
    // 칸 안 미리보기는 구글 일정 → 실제 할 일 → 반복 예정 순으로 한 칸에 최대 DAY_PREVIEW_MAX 줄을 나눠 쓴다
    const shownEv = evs.slice(0, DAY_PREVIEW_MAX);
    const roomReal = DAY_PREVIEW_MAX - shownEv.length;
    const shownReal = (s?.preview ?? []).slice(0, roomReal);
    const shownRepeats = (s?.repeats ?? []).slice(0, roomReal - shownReal.length);
    const hidden = evs.length + (s ? s.remaining + s.repeatCount : 0) - shownEv.length - shownReal.length - shownRepeats.length;
    const evLabel = (e: (typeof evs)[number]) => {
      const t = eventShortTime(e, date);
      return t ? `${t} ${e.title}` : e.title;
    };
    if (evs.length > 0) {
      const more = evs.length - shownEv.length;
      spoken += `, 일정 ${evs.length}개: ${shownEv.map(evLabel).join(', ')}${more > 0 ? ` 외 ${more}개` : ''}`;
    }
    if (s?.allDone) spoken += ', 모두 완료';
    else if (s && s.remaining > 0) {
      // 칸 안에 보이는 미리보기 글자도 이름에 들어 있어야 한다(WCAG 2.5.3)
      const shown = s.preview.map(label).join(', ');
      const more = s.remaining - s.preview.length;
      spoken += `, 남은 할 일 ${s.remaining}개: ${shown}${more > 0 ? ` 외 ${more}개` : ''}`;
    }
    if (s && s.repeatCount > 0) {
      const more = s.repeatCount - s.repeats.length;
      spoken += `, 반복 예정 ${s.repeatCount}개: ${s.repeats.map(label).join(', ')}${more > 0 ? ` 외 ${more}개` : ''}`;
    }
    const button = h(
      'button',
      {
        type: 'button',
        class: `cal-cell${inMonth ? '' : ' other-month'}`,
        'aria-pressed': String(date === sel),
        'aria-current': date === today ? 'date' : null,
        tabindex: date === sel ? '0' : '-1', // roving tabindex: 선택된 칸만 Tab 으로 들어온다
        'data-key': `cal:${date}`,
        'data-date': date,
        onclick: () => void select(date),
      },
      inMonth ? null : h('span', { class: 'sr-only' }, `${cm}월 `),
      h('span', { class: 'cal-day' }, String(d)),
      h('span', { class: 'sr-only' }, spoken),
      s?.allDone
        ? h('span', { class: 'cal-badge all-done', 'aria-hidden': 'true' }, '✓')
        : s && s.remaining > 0
          ? h('span', { class: 'cal-badge', 'aria-hidden': 'true' }, String(s.remaining))
          : null,
      // 칸 안의 할 일 미리보기 (넓은 화면에서만 보인다)
      shownEv.length + shownReal.length + shownRepeats.length > 0
        ? h(
            'span',
            { class: 'cal-preview', 'aria-hidden': 'true' },
            ...shownEv.map((e) => h('span', { class: 'cal-item cal-event', ...(safeColor(e.color) ? { style: `--ev: ${safeColor(e.color)}` } : {}) }, evLabel(e))),
            ...shownReal.map((p) => h('span', { class: 'cal-item', 'data-priority': String(p.priority) }, p.time ? `${p.time} ${p.title}` : p.title)),
            ...shownRepeats.map((p) => h('span', { class: 'cal-item cal-ghost', 'data-priority': String(p.priority) }, `↻ ${p.time ? `${p.time} ` : ''}${p.title}`)),
            hidden > 0 ? h('span', { class: 'cal-more' }, `+${hidden}개`) : null,
          )
        : null,
    );
    return h('div', { role: 'gridcell' }, button);
  });
  const rows: HTMLElement[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(h('div', { class: 'cal-grid', role: 'row' }, ...cells.slice(i, i + 7)));

  const grid = h('div', { role: 'grid', 'aria-label': `${y}년 ${m}월` }, head, ...rows);
  grid.addEventListener('keydown', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-date]');
    if (!target) return;
    const date = target.dataset.date!;
    const moves: Record<string, string> = {
      ArrowLeft: addDays(date, -1),
      ArrowRight: addDays(date, 1),
      ArrowUp: addDays(date, -7),
      ArrowDown: addDays(date, 7),
      PageUp: addMonths(date, -1),
      PageDown: addMonths(date, 1),
      Home: startOfWeek(date),
      End: addDays(startOfWeek(date), 6),
    };
    const next = moves[ev.key];
    if (next) {
      ev.preventDefault();
      void select(next, true);
    }
  });
  root.appendChild(grid);

  // 선택한 날짜의 할 일
  const { open, completed } = await dayTasks(app.ctx.db, sel);
  const rowOpts = { today, projects: await projectLabels(app.ctx.db) };
  const section = h('section', { class: 'section', 'aria-labelledby': 'sel-day' }, h('div', { class: 'section-head' }, h('h3', { id: 'sel-day' }, formatLong(sel))));
  // 그날의 구글 캘린더 일정 (읽기 전용)
  const dayEventList = renderEventList(eventMap.get(sel) ?? [], sel);
  if (dayEventList) section.appendChild(h('div', { class: 'event-group' }, h('h4', {}, '구글 캘린더 일정'), dayEventList));
  section.appendChild(renderQuickAdd(app, { dueDate: sel, keepKey: `cal:${sel}` }));
  const ghosts = (await recurringGhosts(app.ctx.db, today, sel, sel)).get(sel) ?? [];
  if (open.length > 0) section.appendChild(h('div', { class: 'open' }, renderTaskList(app, open, rowOpts)));
  else if (completed.length === 0 && ghosts.length === 0) section.appendChild(h('p', { class: 'empty' }, '이 날은 할 일이 없어요'));
  // 반복 할 일의 앞으로의 회차 (완료·삭제 없이 시리즈 수정만)
  if (ghosts.length > 0) section.appendChild(h('div', { class: 'ghost-group' }, h('h4', {}, '반복 예정'), renderGhostList(app, ghosts, rowOpts)));
  const done = renderCompleted(app, completed, rowOpts);
  if (done) section.appendChild(done);
  root.appendChild(section);
}
