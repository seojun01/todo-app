// 알림 스케줄러 (research R13): 30초마다 "지금 보낼 알림"을 할 일 데이터에서 계산해 푸시로 보낸다.
// 알림 전용 큐는 없다 — 완료·삭제·기한 변경으로 인한 취소가 데이터에서 자동으로 반영된다.
// 중복은 reminder_log (task, 회차, 종류, 기기) 로 막고, 서버가 꺼져 있던 동안의 알림은 15분이 지나면 건너뛴다.
import { addDays } from '../../shared/calendar.ts';
import { dueKey, reminderInstant, shouldFire } from '../../shared/reminders.ts';
import type { Db } from './db.ts';
import { rowToTask } from './sync.ts';
import type { PushResult, PushSender } from './webpush.ts';

export interface TickResult {
  sent: number;
  gone: number;
  retry: number;
  fail: number;
}

export interface Scheduler {
  /** 지금 보낼 알림을 한 번 계산해 보낸다 (테스트와 타이머가 부른다) */
  tick(): Promise<TickResult>;
  /** 주기적으로 tick 을 돌린다 */
  start(): void;
  close(): void;
}

export interface SchedulerOptions {
  db: Db;
  /** 보내는 쪽. 처음 필요할 때 만들어지며(키 파일 생성), 만들 수 없으면 예외 */
  getSender: () => PushSender;
  now?: () => Date;
  intervalMs?: number;
}

const LOG_KEEP_DAYS = 7;
const WINDOW_BEFORE_DAYS = 2;
const WINDOW_AFTER_DAYS = 3;

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let senderErrorLogged = false;

  async function tick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, gone: 0, retry: 0, fail: 0 };
    if (running) return result; // 이전 tick 이 아직 돈다
    running = true;
    try {
      const at = now();
      db.prepare('DELETE FROM reminder_log WHERE sent_at < ?').run(new Date(at.getTime() - LOG_KEEP_DAYS * 86_400_000).toISOString());

      const devices = db
        .prepare(
          `SELECT ps.device_id, ps.endpoint, ps.p256dh, ps.auth, ps.timezone FROM push_subscriptions ps
           JOIN devices d ON d.id = ps.device_id WHERE ps.enabled = 1 AND d.revoked_at IS NULL`,
        )
        .all() as { device_id: string; endpoint: string; p256dh: string; auth: string; timezone: string }[];
      if (devices.length === 0) return result;

      // 후보 할 일: 미완료·미삭제, 알림이 있고, 기한이 서버 오늘의 앞 2일 ~ 뒤 3일 (시간대 차이 여유)
      const today = at.toISOString().slice(0, 10);
      const rows = db
        .prepare(`SELECT * FROM tasks WHERE done = 0 AND deleted = 0 AND reminders != '[]' AND due_date >= ? AND due_date <= ?`)
        .all(addDays(today, -WINDOW_BEFORE_DAYS), addDays(today, WINDOW_AFTER_DAYS)) as Record<string, any>[];
      if (rows.length === 0) return result;
      const settingsRow = db.prepare(`SELECT default_reminder_time FROM settings WHERE id = 'settings'`).get() as { default_reminder_time: string } | undefined;
      const settings = { defaultReminderTime: settingsRow?.default_reminder_time };

      let sender: PushSender | null = null;
      const seen = db.prepare('SELECT 1 FROM reminder_log WHERE task_id = ? AND due_key = ? AND kind = ? AND device_id = ?');
      const log = db.prepare('INSERT OR IGNORE INTO reminder_log (task_id, due_key, kind, device_id, sent_at) VALUES (?, ?, ?, ?, ?)');

      for (const dev of devices) {
        let deviceGone = false;
        for (const row of rows) {
          if (deviceGone) break;
          const task = rowToTask(row);
          const armedAt = new Date(row.armed_at as string);
          for (const kind of task.reminders) {
            const fireAt = reminderInstant(task, kind, settings, dev.timezone);
            if (!fireAt || !shouldFire(fireAt, armedAt, at)) continue;
            const key = dueKey(task);
            if (seen.get(task.id, key, kind, dev.device_id)) continue;
            if (!sender) {
              try {
                sender = opts.getSender();
              } catch (err) {
                if (!senderErrorLogged) console.error('[scheduler] 푸시를 보낼 수 없어요 (VAPID 키 파일 확인):', err);
                senderErrorLogged = true;
                return result;
              }
            }
            // 페이로드에는 내용(제목·프로젝트)을 넣지 않는다: 할 일의 고유 번호뿐 (SC-014)
            const outcome: PushResult = await sender.send({ endpoint: dev.endpoint, p256dh: dev.p256dh, auth: dev.auth }, { v: 1, taskId: task.id });
            if (outcome === 'ok') {
              log.run(task.id, key, kind, dev.device_id, at.toISOString());
              result.sent++;
            } else if (outcome === 'gone') {
              db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(dev.device_id); // 구독이 사라졌다
              result.gone++;
              deviceGone = true;
              break;
            } else if (outcome === 'retry') {
              result.retry++; // 기록하지 않으므로 15분 안에서 다음 tick 에 다시 시도한다
            } else {
              log.run(task.id, key, kind, dev.device_id, at.toISOString()); // 형식·VAPID 오류: 다시 보내지 않는다
              console.error(`[scheduler] 푸시를 거절당했어요 (기기 ${dev.device_id}, 알림 ${kind})`);
              result.fail++;
            }
          }
        }
      }
      return result;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((err) => console.error('[scheduler] tick 실패:', err)), opts.intervalMs ?? 30_000);
      timer.unref();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
