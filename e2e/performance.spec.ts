import { test, expect, type Page } from '@playwright/test';
import { navTo, openApp } from './helpers.ts';

test.use({ timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

/** 할 일 1,000개: 오늘 100개 + 앞으로 9일 동안 하루 100개 (프로젝트는 수신함) */
async function seed1000(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('todo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('tasks', 'readwrite');
          const store = tx.objectStore('tasks');
          for (let i = 0; i < 1000; i++) {
            const day = 12 + Math.floor(i / 100);
            store.put({
              id: crypto.randomUUID(), title: `성능 ${i}`, dueDate: `2026-11-${String(day).padStart(2, '0')}`, dueTime: null, projectId: 'inbox',
              priority: ((i % 4) + 1) as number, recurrence: null, reminders: [], done: i % 7 === 0, createdAt: new Date(2026, 10, 1, 0, 0, i).toISOString(),
              deleted: false, version: `001762950896789-${String(i).padStart(6, '0')}-perf`, updatedBy: 'perf', dirty: 1,
            });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

test('할 일 1,000개에서 화면 전환·달 이동·날짜 선택이 1초 안에 표시된다 (SC-004)', async ({ page }) => {
  await openApp(page);
  await seed1000(page);
  await page.reload();
  const timed = async (label: string, action: () => Promise<void>, ready: () => Promise<void>) => {
    const t0 = Date.now();
    await action();
    await ready();
    const ms = Date.now() - t0;
    expect(ms, `${label}: ${ms}ms`).toBeLessThan(1000);
  };
  await timed('예정 화면', () => navTo(page, '예정'), () => expect(page.getByRole('heading', { level: 2, name: '예정' })).toBeVisible());
  await timed('캘린더 화면', () => navTo(page, '캘린더'), () => expect(page.getByRole('heading', { level: 3, name: '2026년 11월' })).toBeVisible());
  await timed('다음 달', () => page.getByRole('button', { name: '다음 달' }).click(), () => expect(page.getByRole('heading', { level: 3, name: '2026년 12월' })).toBeVisible());
  await timed('이전 달', () => page.getByRole('button', { name: '이전 달' }).click(), () => expect(page.getByRole('heading', { level: 3, name: '2026년 11월' })).toBeVisible());
  await timed('날짜 선택', () => page.locator('button[data-date="2026-11-15"]').click(), () => expect(page.getByRole('heading', { level: 3, name: '11월 15일 일요일' })).toBeVisible());
  await timed('오늘 화면', () => navTo(page, '오늘'), () => expect(page.getByRole('heading', { level: 2, name: '오늘' })).toBeVisible());
});

test('추가·완료·삭제 후 화면 반영이 0.1초 안이다 (SC-002, 로컬 저장 기준)', async ({ page }) => {
  await openApp(page);
  await seed1000(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: '오늘' })).toBeVisible();

  // 클릭부터 화면이 바뀔 때까지를 페이지 안에서 잰다 (Playwright 왕복 지연을 빼기 위해)
  const measure = (setup: string) =>
    page.evaluate(
      (code) =>
        new Promise<number>((resolve) => {
          const main = document.getElementById('main')!;
          const start = performance.now();
          const obs = new MutationObserver(() => {
            obs.disconnect();
            resolve(performance.now() - start);
          });
          obs.observe(main, { childList: true, subtree: true });
          // eslint-disable-next-line no-new-func
          new Function(code)();
        }),
      setup,
    );

  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    samples.push(
      await measure(`
        const input = document.querySelector('input[data-keep="today"]');
        input.value = '측정 ${i}';
        input.form.requestSubmit();
      `),
    );
  }
  for (let i = 0; i < 5; i++) samples.push(await measure(`document.querySelectorAll('section.open .task-check')[${i}].click();`));
  for (let i = 0; i < 5; i++) samples.push(await measure(`document.querySelector('section.open li.task button[aria-label$="삭제"]').click();`));
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  expect(median, `중앙값 ${median.toFixed(0)}ms (표본: ${sorted.map((x) => x.toFixed(0)).join(', ')})`).toBeLessThan(100);
  expect(sorted.at(-1)!, '최악의 경우도 0.3초를 넘지 않는다').toBeLessThan(300);
});

test('초기 로드가 2초 안에 인터랙티브해진다 (헌법 IV)', async ({ page }) => {
  await openApp(page);
  await seed1000(page);
  const t0 = Date.now();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '할 일 추가' })).toBeEditable();
  expect(Date.now() - t0).toBeLessThan(2000);
});
