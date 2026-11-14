// 토스트: "삭제했어요 [실행 취소]" 같은 안내. 포커스를 빼앗지 않지만 Tab 으로 도달할 수 있다.
import type { ToastOptions, Toasts } from '../app.ts';
import { h } from './dom.ts';

export const DEFAULT_TOAST_MS = 6000; // 실행 취소는 최소 5초 (FR-009)

export interface ToastHost extends Toasts {
  element: HTMLElement;
}

export function createToasts(): ToastHost {
  // role=status 컨테이너는 처음부터 있어야 스크린 리더가 내용 추가를 읽어 준다
  const element = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clear(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    element.replaceChildren();
  }

  function show(message: string, opts: ToastOptions = {}): void {
    clear(); // 새 안내가 이전 안내를 대신한다
    const toast = h('div', { class: 'toast' }, h('span', {}, message));
    if (opts.actionLabel && opts.onAction) {
      const onAction = opts.onAction;
      toast.appendChild(
        h('button', {
          type: 'button',
          onclick: () => {
            clear();
            void onAction();
          },
        }, opts.actionLabel),
      );
    }
    element.appendChild(toast);
    const duration = opts.duration ?? DEFAULT_TOAST_MS;
    if (duration > 0) timer = setTimeout(clear, duration);
  }

  return { element, show, clear };
}
