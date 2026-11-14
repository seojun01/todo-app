// 상단의 동기화 상태 표시. role=status + aria-live 로 상태 변화를 알리고, 색깔만으로 구분하지 않는다.
import { describeStatus } from '../sync/status.ts';
import type { SyncEngine, SyncStatus } from '../sync/engine.ts';
import { h } from './dom.ts';

export function mountSyncStatus(host: HTMLElement, engine: SyncEngine): void {
  const el = h('div', { class: 'sync-status', role: 'status', 'aria-live': 'polite' });
  host.appendChild(el);

  const render = (s: SyncStatus) => {
    const v = describeStatus(s);
    el.dataset.state = s.state;
    el.replaceChildren(document.createTextNode(v.text));
    if (v.link) {
      el.appendChild(document.createTextNode(' — '));
      el.appendChild(h('a', { href: v.link.href }, v.link.label));
    }
  };
  engine.onStatus(render);
  void engine.status().then(render);
}
