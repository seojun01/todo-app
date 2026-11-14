import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// e2e 테스트가 같은 DB 에 `todo-admin pair` 로 페어링 코드를 만들 수 있도록 경로를 환경 변수로 공유한다.
const db = (process.env.E2E_DB ??= join(tmpdir(), `todo-e2e-${process.pid}.db`));
const vapid = (process.env.E2E_VAPID ??= `${db}.vapid.json`);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [
    // push-sw.spec.ts 는 서비스 워커에 push 를 직접 전달하는 CDP 와 알림 권한이 필요해 전체 크로미엄 채널 전용 프로젝트에서만 돈다
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /push-sw\.spec\.ts/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /push-sw\.spec\.ts/ },
    { name: 'chromium-push', use: { ...devices['Desktop Chrome'], channel: 'chromium' }, testMatch: /push-sw\.spec\.ts/ },
  ],
  webServer: {
    command: 'node scripts/build.mjs && node server/src/main.ts',
    url: 'http://localhost:8080/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      TODO_DEV: '1',
      TODO_DB: db,
      TODO_VAPID_FILE: vapid,
      PORT: '8080',
      HOST: '127.0.0.1',
    },
  },
});
