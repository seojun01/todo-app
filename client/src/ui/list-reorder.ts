// 할 일 목록에서 카드를 집어 다른 자리에 놓아 순서를 바꾼다 (오늘·수신함·프로젝트·태그 화면).
//  - 마우스: 카드를 누른 채 조금 움직이면 집힌다. 터치: 길게 누르면 집힌다 (그냥 밀면 스크롤).
//  - 끄는 동안 카드가 손을 따라오고, 다른 카드의 가운데를 넘으면 자리가 바뀐다. Esc 는 취소.
//  - 키보드: 카드 안에 포커스를 두고 Alt+↑/↓ 로 한 칸씩 옮긴다.
// 놓으면 순서 키(shared/order.ts)를 저장하고 "실행 취소"를 보인다. 순서는 동기화되어 다른 기기에도 같다.
import type { App } from '../app.ts';
import { planReorder } from '../../../shared/order.ts';
import type { StoredTask } from '../store/tasks.ts';
import { beginDrag, endDrag } from './drag-guard.ts';

const DRAG_THRESHOLD = 5;
const LONG_PRESS_MS = 350;
/** 화면 위·아래 끝에서 이만큼(px) 안으로 오면 저절로 스크롤한다 */
const EDGE_PX = 48;

/** 목록 ul 에 순서 바꾸기를 붙인다. tasks 는 ul 의 카드 순서와 같다 */
export function enableReorder(app: App, ul: HTMLUListElement, tasks: StoredTask[]): void {
  if (tasks.length < 2) return;
  ul.classList.add('reorderable');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = (): HTMLLIElement[] => [...ul.querySelectorAll<HTMLLIElement>(':scope > li.task[data-task-id]')];
  const idsNow = (): string[] => rows().map((r) => r.dataset.taskId!);

  /** 끝난 직후의 click(완료 체크·수정 버튼)을 한 번 막는다 */
  let swallowClick = false;
  ul.addEventListener(
    'click',
    (ev) => {
      if (!swallowClick) return;
      swallowClick = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
    true,
  );

  ul.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !ev.isPrimary) return;
    const target = ev.target as HTMLElement;
    if (target.closest('a, input, textarea, select')) return;
    const row = target.closest<HTMLLIElement>('li.task[data-task-id]');
    if (!row || row.parentElement !== ul) return;
    start(ev, row);
  });

  function start(ev: PointerEvent, row: HTMLLIElement): void {
    const touch = ev.pointerType === 'touch';
    const before = idsNow();
    const startX = ev.clientX;
    let grabY = ev.clientY; // 카드가 지금 자리에 있을 때의 손 위치 (자리가 바뀌면 함께 옮긴다)
    let lastY = ev.clientY;
    let active = false;
    let scrollTimer: number | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;

    const activate = (): void => {
      active = true;
      beginDrag();
      row.classList.add('lifted');
      ul.classList.add('is-reordering');
      window.getSelection()?.removeAllRanges();
      if (touch) navigator.vibrate?.(10);
    };

    /** 손 위치에 맞춰 카드를 띄워 그리고, 이웃 카드의 가운데를 넘었으면 자리를 바꾼다 */
    const follow = (y: number): void => {
      lastY = y;
      for (;;) {
        const dy = y - grabY;
        const mid = row.getBoundingClientRect().top - currentShift() + row.offsetHeight / 2 + dy;
        const prev = row.previousElementSibling as HTMLElement | null;
        const next = row.nextElementSibling as HTMLElement | null;
        const oldTop = row.offsetTop;
        if (dy < 0 && prev?.matches('li.task[data-task-id]') && mid < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
          ul.insertBefore(row, prev);
        } else if (dy > 0 && next?.matches('li.task[data-task-id]') && mid > next.getBoundingClientRect().top + next.offsetHeight / 2) {
          ul.insertBefore(next, row);
        } else break;
        grabY += row.offsetTop - oldTop;
      }
      row.style.transform = `translateY(${y - grabY}px)`;
    };
    const currentShift = (): number => {
      const m = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
      return m ? Number(m[1]) : 0;
    };

    /** 화면 끝 가까이에서는 저절로 스크롤한다 (스크롤한 만큼 손 위치를 다시 맞춘다) */
    const autoScroll = (): void => {
      const speed = lastY < EDGE_PX ? -12 : lastY > window.innerHeight - EDGE_PX ? 12 : 0;
      if (speed !== 0) {
        const y0 = window.scrollY;
        window.scrollBy(0, speed);
        const moved = window.scrollY - y0;
        if (moved !== 0) {
          grabY -= moved;
          follow(lastY);
        }
      }
      scrollTimer = requestAnimationFrame(autoScroll);
    };

    const finish = (): void => {
      clearTimeout(holdTimer);
      if (scrollTimer !== undefined) cancelAnimationFrame(scrollTimer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
      ul.removeEventListener('touchmove', blockScroll);
      row.classList.remove('lifted');
      ul.classList.remove('is-reordering');
      row.style.transform = '';
    };
    const move = (e: PointerEvent): void => {
      if (!e.isPrimary) return;
      if (!active) {
        const far = Math.hypot(e.clientX - startX, e.clientY - lastY) > DRAG_THRESHOLD;
        if (touch) {
          if (far) finish(); // 길게 누르기 전에 움직였다: 스크롤이다
          return;
        }
        if (!far) return;
        activate();
        scrollTimer = requestAnimationFrame(autoScroll);
      }
      e.preventDefault();
      follow(e.clientY);
    };
    const up = (): void => {
      const wasActive = active;
      finish();
      if (!wasActive) return;
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
      const after = idsNow();
      endDrag();
      if (after.join() !== before.join()) void save(row.dataset.taskId!, after);
    };
    const restore = (): void => {
      for (const id of before) {
        const r = ul.querySelector<HTMLLIElement>(`:scope > li.task[data-task-id="${CSS.escape(id)}"]`);
        if (r) ul.appendChild(r);
      }
    };
    const cancel = (): void => {
      const wasActive = active;
      finish();
      if (wasActive) {
        restore();
        endDrag();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !active) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    const blockScroll = (e: TouchEvent): void => {
      if (active) e.preventDefault();
    };
    // 터치는 길게 누른 뒤에 스크롤 시작(autoScroll)도 시작한다
    if (touch) holdTimer = setTimeout(() => {
      activate();
      scrollTimer = requestAnimationFrame(autoScroll);
    }, LONG_PRESS_MS);

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
    ul.addEventListener('touchmove', blockScroll, { passive: false });
  }

  // ── 키보드: Alt+↑/↓ ──
  ul.addEventListener('keydown', (ev) => {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    const row = (ev.target as HTMLElement).closest<HTMLLIElement>('li.task[data-task-id]');
    if (!row || row.parentElement !== ul) return;
    const sibling = (ev.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling) as HTMLElement | null;
    ev.preventDefault();
    if (!sibling?.matches('li.task[data-task-id]')) return;
    const focused = document.activeElement as HTMLElement | null;
    if (ev.key === 'ArrowUp') ul.insertBefore(row, sibling);
    else ul.insertBefore(sibling, row);
    focused?.focus({ preventScroll: false });
    void save(row.dataset.taskId!, idsNow());
  });

  /** 새 순서를 저장하고 되돌리기 토스트를 보인다 */
  async function save(moved: string, order: string[]): Promise<void> {
    const plan = planReorder(order, moved, (id) => byId.get(id)?.sortKey ?? null);
    const prev = new Map([...plan.keys()].map((id) => [id, byId.get(id)?.sortKey ?? null]));
    try {
      for (const [id, sortKey] of plan) {
        const r = await app.tasks.editTask(id, { sortKey });
        if (!r.ok) throw new Error(`reorder ${id}: ${JSON.stringify(r.errors)}`);
      }
      await app.refresh();
      const title = byId.get(moved)?.title ?? '';
      app.toasts.show(`'${title}' 순서를 바꿨어요`, {
        actionLabel: '실행 취소',
        onAction: async () => {
          for (const [id, sortKey] of prev) await app.tasks.editTask(id, { sortKey });
          await app.refresh();
        },
      });
    } catch (err) {
      console.error(err);
      app.toasts.show('순서를 저장하지 못했어요. 다시 시도해 주세요.', { duration: 8000 });
      await app.refresh();
    }
  }
}
