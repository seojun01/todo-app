// 캘린더의 년 보기: 12개월을 작은 달력으로 한눈에. 할 일이 있는 날에는 점이 찍히고,
// 날짜를 누르면 그날의 일 보기로, 달 이름을 누르면 그 달의 월 보기로 간다.
import type { App } from '../app.ts';
import { addDays, formatDate, monthGrid, parseDate } from '../../../shared/calendar.ts';
import { listTasksByDueRange } from '../store/tasks.ts';
import { h } from './dom.ts';

const DAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

export interface YearOptions {
  year: number;
  sel: string;
  today: string;
  onPickDay: (date: string) => void;
  onPickMonth: (date: string) => void;
}

export async function renderYear(app: App, root: HTMLElement, o: YearOptions): Promise<void> {
  const tasks = (await listTasksByDueRange(app.ctx.db, formatDate(o.year, 1, 1), formatDate(o.year, 12, 31))).filter((t) => !t.deleted);
  const open = new Map<string, number>(); // 날짜 → 남은 할 일 수
  const all = new Set<string>(); // 할 일이 있는 날 (완료 포함)
  for (const t of tasks) {
    all.add(t.dueDate!);
    if (!t.done) open.set(t.dueDate!, (open.get(t.dueDate!) ?? 0) + 1);
  }

  const wrap = h('div', { class: 'year' });
  // 선택한 날짜가 이 해에 있으면 그날, 아니면 1월 1일이 Tab 으로 들어오는 자리
  const entry = parseDate(o.sel).y === o.year ? o.sel : formatDate(o.year, 1, 1);

  for (let m = 1; m <= 12; m++) {
    const first = formatDate(o.year, m, 1);
    const cells = monthGrid(o.year, m).map((date) => {
      const { m: cm, d } = parseDate(date);
      if (cm !== m) return h('span', { class: 'year-blank', 'aria-hidden': 'true' });
      const n = open.get(date) ?? 0;
      return h(
        'button',
        {
          type: 'button',
          class: `year-day${all.has(date) ? ' has-tasks' : ''}`,
          'data-date': date,
          'data-key': `year:${date}`,
          'aria-current': date === o.today ? 'date' : null,
          'aria-pressed': date === o.sel ? 'true' : null,
          tabindex: date === entry ? '0' : '-1', // roving tabindex: 해 전체에서 Tab 정지점은 하나
          // 접근 가능한 이름은 보이는 숫자로 시작해야 한다(WCAG 2.5.3). 달 정보는 뒤에 붙인다.
          'aria-label': `${d} 일, ${o.year}년 ${m}월${n > 0 ? `, 남은 할 일 ${n}개` : all.has(date) ? ', 할 일 모두 완료' : ''}`,
          onclick: () => o.onPickDay(date),
        },
        String(d),
        all.has(date) ? h('span', { class: 'year-dot', 'aria-hidden': 'true' }) : null,
      );
    });
    wrap.appendChild(
      h(
        'section',
        { class: 'year-month', 'aria-label': `${o.year}년 ${m}월` },
        h('h3', {}, h('button', { type: 'button', class: 'year-month-btn', 'data-key': `year-month:${m}`, onclick: () => o.onPickMonth(first) }, `${m}월`)),
        h('div', { class: 'year-grid', 'aria-hidden': 'false' }, ...DAY_SHORT.map((d) => h('span', { class: 'year-dow', 'aria-hidden': 'true' }, d)), ...cells),
      ),
    );
  }

  // 방향키로 날짜 사이를 옮긴다 (달을 넘어도 이어진다). 다시 그리지 않고 포커스만 옮긴다.
  wrap.addEventListener('keydown', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('.year-day');
    if (!target) return;
    const date = target.dataset.date!;
    const moves: Record<string, string> = { ArrowLeft: addDays(date, -1), ArrowRight: addDays(date, 1), ArrowUp: addDays(date, -7), ArrowDown: addDays(date, 7) };
    const next = moves[ev.key];
    if (!next) return;
    ev.preventDefault();
    const el = wrap.querySelector<HTMLElement>(`.year-day[data-date="${next}"]`);
    if (!el) return; // 이 해를 벗어남
    wrap.querySelectorAll<HTMLElement>('.year-day[tabindex="0"]').forEach((b) => b.setAttribute('tabindex', '-1'));
    el.setAttribute('tabindex', '0');
    el.focus();
  });
  root.appendChild(wrap);
}
