import type { ProjectSummary, TagSummary } from '../views.ts';
import { h } from './dom.ts';

export interface NavItem {
  hash: string;
  label: string;
}

const MAIN_ITEMS: NavItem[] = [
  { hash: '#/today', label: '오늘' },
  { hash: '#/upcoming', label: '예정' },
  { hash: '#/project/inbox', label: '수신함' },
  { hash: '#/calendar', label: '캘린더' },
];
const SETTINGS: NavItem = { hash: '#/settings', label: '설정' };

/** 주 내비게이션. 현재 화면은 aria-current="page" 로 표시한다. 프로젝트는 색상 점 + 이름 + 미완료 개수 */
export function renderNav(
  current: string,
  projects: ProjectSummary[] = [],
  onAddProject: (opener: HTMLElement) => void = () => undefined,
  tags: TagSummary[] = [],
): HTMLElement {
  const link = (it: NavItem) =>
    h('li', {}, h('a', { href: it.hash, 'aria-current': current === it.hash ? 'page' : null }, it.label));

  const projectItems = projects.map(({ project, open }) => {
    const hash = `#/project/${project.id}`;
    return h(
      'li',
      {},
      h(
        'a',
        { href: hash, 'aria-current': current === hash ? 'page' : null },
        h('span', { class: 'dot', 'data-color': project.color, 'aria-hidden': 'true' }),
        h('span', {}, project.name),
        open > 0 ? h('span', { class: 'nav-count' }, String(open)) : null,
      ),
    );
  });
  const add = h(
    'li',
    {},
    h('button', { type: 'button', class: 'nav-link', onclick: (ev: Event) => onAddProject(ev.currentTarget as HTMLElement) }, '프로젝트 추가'),
  );

  const tagItems = tags.map(({ name, open }) => {
    const hash = `#/tag/${encodeURIComponent(name)}`;
    return h(
      'li',
      {},
      h(
        'a',
        { href: hash, 'aria-current': current === hash ? 'page' : null },
        h('span', {}, `#${name}`),
        open > 0 ? h('span', { class: 'nav-count' }, String(open)) : null,
      ),
    );
  });

  return h(
    'nav',
    { class: 'nav', 'aria-label': '주 메뉴' },
    h(
      'ul',
      {},
      ...MAIN_ITEMS.map(link),
      h('li', { class: 'nav-section', 'aria-hidden': 'true' }, '프로젝트'),
      ...projectItems,
      add,
      ...(tagItems.length > 0 ? [h('li', { class: 'nav-section', 'aria-hidden': 'true' }, '태그'), ...tagItems] : []),
      link(SETTINGS),
    ),
  );
}
