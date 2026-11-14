// 앱 부트스트랩과 해시 라우터
import './ui/styles.css';
import type { App, ViewRenderer } from './app.ts';
import { createCtx } from './context.ts';
import { openTodoDb } from './store/db.ts';
import { createProjectOps } from './projects.ts';
import { createNotify } from './notify.ts';
import { getTask } from './store/tasks.ts';
import { createSettingsOps } from './settings.ts';
import { createTaskOps } from './tasks.ts';
import { projectSummaries, tagSummaries } from './views.ts';
import { clear, h } from './ui/dom.ts';
import { renderNav } from './ui/nav.ts';
import { openProjectEditor } from './ui/projects.ts';
import { createToasts } from './ui/undo-toast.ts';
import { today } from '../../shared/calendar.ts';
import { renderCalendar } from './ui/calendar.ts';
import { renderPair } from './ui/pair.ts';
import { renderProject } from './ui/project-view.ts';
import { renderSettings } from './ui/settings.ts';
import { mountSyncStatus } from './ui/sync-status.ts';
import { renderToday } from './ui/today.ts';
import { renderUpcoming, resetUpcoming } from './ui/upcoming.ts';
import { renderTag } from './ui/tag-view.ts';
import { renderTaskPage } from './ui/task-page.ts';
import { createSyncEngine } from './sync/engine.ts';
import { startRealtime } from './sync/events.ts';

type RouteName = 'today' | 'upcoming' | 'project' | 'tag' | 'task' | 'calendar' | 'settings' | 'pair';

const TITLES: Record<RouteName, string> = {
  today: '오늘',
  upcoming: '예정',
  project: '프로젝트',
  tag: '태그',
  task: '할 일',
  calendar: '캘린더',
  settings: '설정',
  pair: '기기 등록',
};

/** 이후 스토리에서 라우트를 채운다 (예정, 캘린더, 설정, 등록). */
const routes: Partial<Record<RouteName, ViewRenderer>> = {
  today: renderToday,
  upcoming: renderUpcoming,
  calendar: renderCalendar,
  project: renderProject,
  tag: renderTag,
  task: renderTaskPage,
  settings: renderSettings,
  pair: renderPair,
};

function parseHash(hash: string): { name: RouteName; params: string[] } {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = (parts[0] ?? 'today') as RouteName;
  return { name: name in TITLES ? name : 'today', params: parts.slice(1).map(decodeURIComponent) };
}

export async function boot(): Promise<App> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app 이 없어요');

  // 알림을 눌러 앱이 새로 열리면 주소가 /?task=<id> 이다: 그 할 일 화면으로 보내고 주소를 정리한다
  const taskParam = new URLSearchParams(location.search).get('task');
  if (taskParam) history.replaceState(null, '', `${location.pathname}#/task/${encodeURIComponent(taskParam)}`);

  const db = await openTodoDb();
  const ctx = await createCtx(db);
  const toasts = createToasts();
  const tasks = createTaskOps(ctx);
  const projectOps = createProjectOps(ctx, tasks);
  const settingsOps = createSettingsOps(ctx);
  const notify = createNotify(async () => (await sync.status()).paired);
  const sync = createSyncEngine(ctx);
  sync.start(); // 저장소가 바뀌면 자동으로 push 한다

  const topbar = h('header', { class: 'topbar' }, h('h1', {}, '할 일'));
  mountSyncStatus(topbar, sync);
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const navSlot = h('div', { style: 'display: contents' });
  root.appendChild(h('div', { class: 'app' }, topbar, navSlot, main));
  root.appendChild(toasts.element);

  let rendering: Promise<void> = Promise.resolve();

  const app: App = {
    ctx,
    tasks,
    projects: projectOps,
    settings: settingsOps,
    notify,
    sync,
    toasts,
    today: () => today(ctx.now()),
    navigate: (hash) => {
      if (location.hash === hash) void app.refresh();
      else location.hash = hash;
    },
    refresh: () => (rendering = rendering.then(() => render(false))),
  };

  /** 다시 그리기 전에 포커스와 입력 중인 값을 기억했다가 복원한다 */
  function snapshot() {
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && main.contains(active) ? active.dataset.key : undefined;
    const values = new Map<string, string>();
    main.querySelectorAll<HTMLInputElement>('input[data-keep]').forEach((el) => values.set(el.dataset.keep!, el.value));
    return { focusKey, values };
  }
  function restore(s: ReturnType<typeof snapshot>) {
    s.values.forEach((v, k) => {
      const el = main.querySelector<HTMLInputElement>(`input[data-keep="${CSS.escape(k)}"]`);
      if (el && el.value === '') el.value = v;
    });
    if (s.focusKey) main.querySelector<HTMLElement>(`[data-key="${CSS.escape(s.focusKey)}"]`)?.focus();
  }

  async function render(navigated: boolean): Promise<void> {
    const hash = location.hash || '#/today';
    const { name, params } = parseHash(hash);
    if (navigated && name !== 'upcoming') resetUpcoming(); // 예정을 떠나면 다음에는 이번 주부터 보인다
    const view = routes[name];
    const next = h('div', {});
    if (view) await view(app, next, params);
    else next.appendChild(h('p', { class: 'empty' }, '준비 중인 화면이에요.'));
    const navHash =
      name === 'project' ? `#/project/${params[0] ?? 'inbox'}` : name === 'tag' ? `#/tag/${encodeURIComponent(params[0] ?? '')}` : `#/${name}`;
    const nav = renderNav(navHash, await projectSummaries(db), (opener) => void openProjectEditor(app, { opener }), await tagSummaries(db));

    // 다시 그린 결과가 지금 화면과 같으면 화면을 교체하지 않는다. 변경이 없는 동기화가 화면을 갈아엎으면
    // 누르는 도중의 클릭이 사라지고 포커스·스크롤이 흐트러진다. (isEqualNode 는 속성과 자식만 비교하므로 입력 중인 값은 영향을 주지 않는다)
    const unchanged = !navigated && (main.firstElementChild?.isEqualNode(next) ?? false);
    if (!unchanged) {
      // 입력 중인 값과 포커스는 화면을 바꾸기 "직전"에 기록한다. 그리는 동안(비동기) 타이핑한 내용이 사라지지 않게 한다.
      const snap = navigated ? null : snapshot();
      clear(main);
      main.appendChild(next);
      if (snap) restore(snap);
      else main.focus({ preventScroll: true });
    }
    if (!navSlot.firstElementChild?.isEqualNode(nav)) {
      navSlot.replaceChildren(nav);
      // 좁은 화면의 하단 탭은 가로로 스크롤되는 한 줄이다: 다시 그려도 지금 탭이 가려지지 않게 한다
      nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    document.title = `${TITLES[name]} · 할 일`;
  }

  window.addEventListener('hashchange', () => {
    rendering = rendering.then(() => render(true));
  });

  // 자정을 넘기면 "오늘" 기준을 갱신한다 (앱을 켜 둔 상태 포함, FR-002)
  let shownDay = app.today();
  function scheduleMidnight(): void {
    const now = ctx.now();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 200);
    setTimeout(() => {
      if (app.today() !== shownDay) {
        shownDay = app.today();
        void app.refresh();
      }
      scheduleMidnight();
    }, Math.max(1000, next.getTime() - now.getTime()));
  }
  scheduleMidnight();
  // 잠자던 기기를 깨웠을 때도 날짜가 바뀌었는지 확인한다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.today() !== shownDay) {
      shownDay = app.today();
      void app.refresh();
    }
  });

  // 홈 화면에 설치한 앱은 저장소를 지우지 않도록 영구 저장을 요청한다 (research R1)
  void navigator.storage?.persist?.().catch(() => undefined);

  rendering = render(true);
  await rendering;

  // 동기화로 다른 기기의 변경이 들어오면 화면을 다시 그린다
  sync.onStatus(() => void app.refresh());
  app.realtime = startRealtime(db, sync);

  // 서비스 워커: 앱 셸을 캐시해 오프라인에서도 열린다
  if ('serviceWorker' in navigator) {
    // 이미 서비스 워커가 맡고 있던 페이지에서 새 서비스 워커로 바뀌면 "새 버전이 받아졌다"는 뜻이다.
    // 지금 열려 있는 화면은 옛 코드로 돌고 있으니 새로고침을 안내한다 (입력 중인 내용을 잃지 않게 저절로 새로고침하지는 않는다).
    // 처음 설치될 때(맡고 있던 서비스 워커가 없을 때)는 새 버전이 아니므로 알리지 않는다.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      app.toasts.show('앱이 새 버전으로 업데이트됐어요. 새로고침하면 바로 쓸 수 있어요.', {
        duration: 0,
        actionLabel: '새로고침',
        onAction: () => location.reload(),
      });
    });
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('서비스 워커를 등록하지 못했어요', err));

    // 서비스 워커가 알림을 받았을 때: 앱이 열려 있으면 앱 안 알림(제목 포함)을 띄우고, 알림을 눌렀으면 그 할 일로 간다
    navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data as { type?: string; taskId?: unknown; test?: unknown } | null;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'open-task' && typeof d.taskId === 'string') {
        app.navigate(`#/task/${encodeURIComponent(d.taskId)}`);
      } else if (d.type === 'reminder' && document.visibilityState === 'visible') {
        void (async () => {
          if (d.test === true) {
            app.toasts.show('테스트 알림이 도착했어요', { duration: 6000 });
            return;
          }
          const task = typeof d.taskId === 'string' ? await getTask(db, d.taskId) : undefined;
          if (!task || task.deleted || task.done) return; // 이 기기에서 이미 끝낸 할 일은 알리지 않는다
          const id = task.id;
          app.toasts.show(`'${task.title}' 알림이에요`, { duration: 12_000, actionLabel: '열기', onAction: () => app.navigate(`#/task/${encodeURIComponent(id)}`) });
        })();
      }
    });
  }
  // 서버의 푸시 키나 이 기기의 시간대가 바뀌었다면 조용히 맞춘다 (알림이 켜져 있을 때만)
  void app.notify.reconcile();
  return app;
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  boot().catch((err) => {
    console.error(err);
    const root = document.getElementById('app');
    if (root) root.textContent = `앱을 시작하지 못했어요: ${err instanceof Error ? err.message : String(err)}`;
  });
}
