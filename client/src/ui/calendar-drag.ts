// 시간 격자의 직접 조작:
//  - 빈 곳을 누르면 그 시각에 일정 만들기 창이 열리고, 빈 곳을 끌면 끈 구간으로 열린다
//  - 블록을 끌면 날짜(주 보기)와 시각이 바뀌고, 아래쪽 끝을 끌면 길이가 바뀐다 (15분 단위)
//  - 블록을 "하루 종일" 줄로 끌면 시각이 없어지고, 하루 종일 칩을 시간 열로 끌면 그 시각이 정해진다
// 마우스는 조금만 움직여도 끌기가 시작되고, 터치는 길게 눌러야 시작된다 (그냥 밀면 스크롤).
// 키보드로는 블록(버튼)을 열어 수정 창에서 날짜·시각·길이를 바꾼다.
import type { App } from '../app.ts';
import { CLICK_CREATE_MIN, clickRange, dragRange, minutesAtY, movedStart, resizedEnd } from '../../../shared/calendar-layout.ts';
import { remapReminders } from '../../../shared/reminders.ts';
import { DEFAULT_DURATION, durationOf, fromMinutes, type ReminderKind } from '../../../shared/task.ts';
import { formatRange, formatShort } from '../format.ts';
import type { StoredTask } from '../store/tasks.ts';
import { h } from './dom.ts';
import { openTaskEditor } from './task-editor.ts';
import { TASK_DRAG_TYPE } from './task-list.ts';

/** 마우스가 이만큼(px) 움직이면 끌기로 본다 */
const DRAG_THRESHOLD = 4;
/** 터치는 이만큼(ms) 누르고 있어야 끌기가 시작된다 */
const LONG_PRESS_MS = 350;

export interface GridOptions {
  hourPx: number;
  /** 지금 격자에 그려진 할 일 (되돌리기용 원래 값을 읽는다) */
  tasks: Map<string, StoredTask>;
}

interface Change {
  dueDate: string;
  dueTime: string | null;
  durationMin: number | null;
}

const hm = (min: number): string => fromMinutes(Math.min(min, 1439));

export function enableGridInteractions(app: App, scroller: HTMLElement, o: GridOptions): void {
  const cols = (): HTMLElement[] => [...scroller.querySelectorAll<HTMLElement>('.tg-col')];
  const alldayCells = (): HTMLElement[] => [...scroller.querySelectorAll<HTMLElement>('.tg-allday-cell')];

  /** 끝난 직후에 따라오는 click(블록 열기)을 한 번 막는다 */
  let swallowClick = false;
  scroller.addEventListener(
    'click',
    (ev) => {
      if (!swallowClick) return;
      swallowClick = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
    true,
  );

  /** 지금 끌고 있는 것이 있으면 취소 함수 (Esc) */
  let cancelActive: (() => void) | null = null;
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') cancelActive?.();
  };

  /** 변경을 저장하고 되돌리기 토스트를 보인다 */
  async function apply(task: StoredTask, next: Change, message: string): Promise<void> {
    const prev: Change = { dueDate: task.dueDate!, dueTime: task.dueTime, durationMin: durationOf(task) };
    // 시각이 생기거나 없어지면 알림 종류를 맞춘다 (편집 창과 같은 규칙)
    const hadTime = task.dueTime !== null;
    const hasTime = next.dueTime !== null;
    const reminders: ReminderKind[] = hadTime === hasTime ? task.reminders : remapReminders(task.reminders, hadTime, hasTime).reminders;
    try {
      const r = await app.tasks.editTask(task.id, { ...next, reminders });
      if (!r.ok) {
        app.toasts.show('옮기지 못했어요. 값이 올바르지 않아요.', { duration: 6000 });
        return;
      }
      await app.refresh();
      app.toasts.show(message, {
        actionLabel: '실행 취소',
        onAction: async () => {
          await app.tasks.editTask(task.id, { ...prev, reminders: task.reminders });
          await app.refresh();
        },
      });
    } catch (err) {
      console.error(err);
      app.toasts.show('저장하지 못했어요. 저장 공간을 확인한 뒤 다시 시도해 주세요.', { duration: 8000 });
    }
  }

  /** 포인터 아래의 날짜 열 (없으면 null) */
  function colAt(x: number): HTMLElement | null {
    return cols().find((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x < r.right;
    }) ?? null;
  }
  const allDayRowRect = (): DOMRect | null => scroller.querySelector('.tg-allday')?.getBoundingClientRect() ?? null;

  /** 끌기 한 번의 공통 뼈대: 시작 조건(마우스 이동·터치 길게 누름)을 지키고, 끝나면 정리한다 */
  function startGesture(
    ev: PointerEvent,
    hooks: {
      onStart: () => void;
      onMove: (ev: PointerEvent) => void;
      onEnd: (ev: PointerEvent) => void | Promise<void>;
      onCancel: () => void;
      /** 터치도 길게 누르지 않고 바로 시작할 수 있는가 (해당 없음: 항상 길게 누름) */
      touchNeedsHold?: boolean;
      /** 끌지 않고 뗐을 때 (그냥 누름) */
      onTap?: (ev: PointerEvent) => void;
    },
  ): void {
    const startX = ev.clientX;
    const startY = ev.clientY;
    const touch = ev.pointerType === 'touch';
    let active = false;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    if (touch && hooks.touchNeedsHold !== false) {
      holdTimer = setTimeout(() => {
        active = true;
        hooks.onStart();
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    }

    const finish = (): void => {
      clearTimeout(holdTimer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      scroller.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('keydown', onKey);
      cancelActive = null;
    };
    const move = (e: PointerEvent): void => {
      if (!active) {
        const far = Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD;
        if (touch) {
          if (far) finish(); // 길게 누르기 전에 움직였다: 스크롤이다
          return;
        }
        if (!far) return;
        active = true;
        hooks.onStart();
      }
      hooks.onMove(e);
    };
    const up = (e: PointerEvent): void => {
      const wasActive = active;
      finish();
      if (wasActive) {
        swallowClick = true;
        setTimeout(() => (swallowClick = false), 0);
        void hooks.onEnd(e);
      } else hooks.onTap?.(e);
    };
    const cancel = (): void => {
      const wasActive = active;
      finish();
      if (wasActive) hooks.onCancel();
    };
    // 터치로 끌기가 시작된 뒤에는 화면이 스크롤되지 않게 한다
    const blockScroll = (e: TouchEvent): void => {
      if (active) e.preventDefault();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    scroller.addEventListener('touchmove', blockScroll, { passive: false });
    window.addEventListener('keydown', onKey);
    cancelActive = () => {
      const wasActive = active;
      finish();
      if (wasActive) hooks.onCancel();
    };
  }

  // ── 블록 끌기·늘이기, 빈 곳 만들기 ──
  scroller.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !ev.isPrimary) return;
    const target = ev.target as HTMLElement;
    if (target.closest('.tg-del')) return; // 삭제 버튼은 끌기·만들기를 시작하지 않는다

    const block = target.closest<HTMLElement>('.tg-block.movable');
    if (block) return startBlockGesture(ev, block, target.closest('.tg-resize') !== null);

    // 빈 곳 (블록·현재 시각 선이 아닌 열 자체)
    const col = target.closest<HTMLElement>('.tg-col');
    if (col && !target.closest('.tg-block')) startCreateGesture(ev, col);
  });

  function startBlockGesture(ev: PointerEvent, block: HTMLElement, resize: boolean): void {
    const id = block.dataset.taskId!;
    const task = o.tasks.get(id);
    if (!task || !task.dueDate || !task.dueTime) return;
    const origStart = Number(block.dataset.start);
    const origEnd = Number(block.dataset.end);
    const dur = origEnd - origStart;
    const originCol = block.closest<HTMLElement>('.tg-col')!;
    const startY = ev.clientY;
    let preview: HTMLElement | null = null;
    let result: { change: Change; label: string } | null = null;
    let overAllday: HTMLElement | null = null;

    const draw = (col: HTMLElement, start: number, end: number): void => {
      preview?.remove();
      preview = h('div', { class: 'tg-block tg-preview', 'aria-hidden': 'true', style: `top:${(start * o.hourPx) / 60}px;height:${Math.max(20, ((end - start) * o.hourPx) / 60 - 1)}px;left:1px;right:2px` }, h('span', { class: 'tg-title' }, task.title), h('span', { class: 'tg-time' }, formatRange(start, end)));
      col.appendChild(preview);
    };
    const clear = (): void => {
      preview?.remove();
      preview = null;
      overAllday?.classList.remove('drop-target');
      overAllday = null;
      block.classList.remove('dragging');
      scroller.classList.remove('is-dragging');
    };

    startGesture(ev, {
      onStart: () => {
        block.classList.add('dragging');
        scroller.classList.add('is-dragging');
        draw(originCol, origStart, origEnd);
      },
      onMove: (e) => {
        const delta = ((e.clientY - startY) * 60) / o.hourPx;
        if (resize) {
          const end = resizedEnd(origStart, origEnd, delta);
          draw(originCol, origStart, end);
          result = { change: { dueDate: task.dueDate!, dueTime: task.dueTime, durationMin: end - origStart }, label: '길이를 바꿨어요' };
          return;
        }
        // 하루 종일 줄 위에 있으면 시각 없는 일정으로
        const rowRect = allDayRowRect();
        overAllday?.classList.remove('drop-target');
        overAllday = null;
        if (rowRect && e.clientY >= rowRect.top && e.clientY <= rowRect.bottom) {
          const cell = alldayCells().find((c) => {
            const r = c.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX < r.right;
          });
          if (cell) {
            preview?.remove();
            preview = null;
            overAllday = cell;
            cell.classList.add('drop-target');
            result = { change: { dueDate: cell.dataset.date!, dueTime: null, durationMin: null }, label: `${formatShort(cell.dataset.date!)} 하루 종일로 옮겼어요` };
            return;
          }
        }
        const col = colAt(e.clientX) ?? originCol;
        const start = movedStart(origStart, dur, delta);
        draw(col, start, start + dur);
        const date = col.dataset.date!;
        result = {
          change: { dueDate: date, dueTime: hm(start), durationMin: durationOf(task) },
          label: `${formatShort(date)} ${formatRange(start, start + dur).split(' ~ ')[0]}로 옮겼어요`,
        };
      },
      onEnd: async () => {
        clear();
        const r = result;
        if (!r) return;
        const same = r.change.dueDate === task.dueDate && r.change.dueTime === task.dueTime && r.change.durationMin === durationOf(task);
        if (!same) await apply(task, r.change, r.label);
      },
      onCancel: clear,
    });
  }

  function startCreateGesture(ev: PointerEvent, col: HTMLElement): void {
    const touch = ev.pointerType === 'touch';
    const y0 = ev.clientY - col.getBoundingClientRect().top;
    const a = minutesAtY(y0, o.hourPx);
    let preview: HTMLElement | null = null;
    let range = clickRange(a);

    const draw = (): void => {
      preview?.remove();
      preview = h('div', { class: 'tg-block tg-preview', 'aria-hidden': 'true', style: `top:${(range.start * o.hourPx) / 60}px;height:${((range.end - range.start) * o.hourPx) / 60 - 1}px;left:1px;right:2px` }, h('span', { class: 'tg-time' }, formatRange(range.start, range.end)));
      col.appendChild(preview);
    };
    const open = (): void => {
      void openTaskEditor(app, {
        defaults: { dueDate: col.dataset.date!, dueTime: hm(range.start), durationMin: Math.min(range.end - range.start, CLICK_CREATE_MIN * 24) },
        opener: null,
      });
    };

    startGesture(ev, {
      // 터치는 끌어서 만들지 않고 톡 눌러서만 만든다 (스크롤과 겹친다)
      touchNeedsHold: false,
      onStart: () => {
        if (touch) return;
        scroller.classList.add('is-dragging');
        draw();
      },
      onMove: (e) => {
        if (touch) return;
        const b = minutesAtY(e.clientY - col.getBoundingClientRect().top, o.hourPx);
        range = dragRange(a, b);
        draw();
      },
      onEnd: () => {
        preview?.remove();
        scroller.classList.remove('is-dragging');
        open();
      },
      onCancel: () => {
        preview?.remove();
        scroller.classList.remove('is-dragging');
      },
      onTap: () => open(),
    });
  }

  // ── 하루 종일 칩 끌기 (HTML5): 다른 날의 하루 종일 칸으로, 또는 시간 열로 ──
  const draggedTask = (ev: DragEvent): StoredTask | null => {
    const id = ev.dataTransfer?.getData(TASK_DRAG_TYPE);
    return id ? (o.tasks.get(id) ?? null) : null;
  };
  const isTaskDrag = (ev: DragEvent): boolean => ev.dataTransfer?.types.includes(TASK_DRAG_TYPE) ?? false;

  scroller.addEventListener('dragstart', (ev) => {
    const chip = (ev.target as HTMLElement).closest<HTMLElement>('.tg-chip[data-task-id]');
    if (!chip) return;
    ev.dataTransfer?.setData(TASK_DRAG_TYPE, chip.dataset.taskId!);
    ev.dataTransfer?.setData('text/plain', chip.textContent ?? '');
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    chip.classList.add('dragging');
  });
  scroller.addEventListener('dragend', () => {
    scroller.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    scroller.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });
  scroller.addEventListener('dragover', (ev) => {
    if (!isTaskDrag(ev)) return;
    const zone = (ev.target as HTMLElement).closest<HTMLElement>('.tg-allday-cell, .tg-col');
    if (!zone) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    scroller.querySelectorAll('.drop-target').forEach((el) => el !== zone && el.classList.remove('drop-target'));
    zone.classList.add('drop-target');
  });
  scroller.addEventListener('drop', (ev) => {
    const zone = (ev.target as HTMLElement).closest<HTMLElement>('.tg-allday-cell, .tg-col');
    if (!zone || !isTaskDrag(ev)) return;
    ev.preventDefault();
    zone.classList.remove('drop-target');
    const task = draggedTask(ev);
    if (!task?.dueDate) return;
    const date = zone.dataset.date!;
    if (zone.classList.contains('tg-allday-cell')) {
      if (date === task.dueDate) return;
      void apply(task, { dueDate: date, dueTime: task.dueTime, durationMin: durationOf(task) }, `${formatShort(date)}로 옮겼어요`);
      return;
    }
    // 시간 열에 놓으면 그 시각의 일정이 된다 (길이는 기본 한 시간)
    const start = clickRange(minutesAtY(ev.clientY - zone.getBoundingClientRect().top, o.hourPx)).start;
    void apply(task, { dueDate: date, dueTime: hm(start), durationMin: durationOf(task) ?? DEFAULT_DURATION }, `${formatShort(date)} ${formatRange(start, start + DEFAULT_DURATION).split(' ~ ')[0]}로 옮겼어요`);
  });
}
