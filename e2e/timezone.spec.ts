import { test, expect } from '@playwright/test';
import { navTo, openApp, openEditor, quickAdd, row } from './helpers.ts';

// 같은 순간(서울 2026-11-12 09:00 = 뉴욕 2026-11-11 19:00)이 시간대에 따라 다른 "오늘"이 된다. 기한 날짜는 변하지 않는다 (FR-028).
const INSTANT = '2026-11-12T09:00:00+09:00';

for (const [timezoneId, todayLabel, todayIso] of [
  ['Asia/Seoul', '11월 12일', '2026-11-12'],
  ['America/New_York', '11월 11일', '2026-11-11'],
] as const) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId, locale: 'ko-KR' });

    test('"오늘"은 그 기기의 현지 날짜이고, 기한 날짜는 시간대와 무관하게 그대로다', async ({ page }) => {
      await openApp(page, INSTANT);
      await expect(page.getByText(todayLabel, { exact: false }).first()).toBeVisible(); // 오늘 화면의 날짜
      await quickAdd(page, '오늘 할 일'); // 기한 = 이 기기의 오늘
      await quickAdd(page, '고정 기한');
      const dialog = await openEditor(page, '고정 기한');
      await dialog.getByLabel('기한', { exact: true }).fill('2026-11-20');
      await dialog.getByRole('button', { name: '저장' }).click();
      await navTo(page, '수신함');
      await expect(row(page, '고정 기한')).toContainText('11월 20일 (금)');

      const stored = await page.evaluate(
        () =>
          new Promise<Record<string, string | null>>((resolve) => {
            const o = indexedDB.open('todo');
            o.onsuccess = () => {
              const q = o.result.transaction('tasks').objectStore('tasks').getAll();
              q.onsuccess = () => resolve(Object.fromEntries((q.result as { title: string; dueDate: string | null }[]).map((t) => [t.title, t.dueDate])));
            };
          }),
      );
      expect(stored['고정 기한']).toBe('2026-11-20'); // 시간 없는 달력 날짜 그대로
      expect(stored['오늘 할 일']).toBe(todayIso); // 오늘은 기기의 현지 날짜
    });
  });
}
