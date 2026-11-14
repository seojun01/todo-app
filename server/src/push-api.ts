// 푸시 구독 API (contracts/sync-api.md 12~14): 공개키 조회, 이 기기의 구독 등록·갱신·삭제, 테스트 푸시.
import { Buffer } from 'node:buffer';
import { isValidTimeZone } from '../../shared/tz.ts';
import type { AuthedRoute } from './api.ts';
import type { Db } from './db.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import type { Vapid } from './vapid.ts';
import { isAllowedPushEndpoint, type PushSender } from './webpush.ts';

export interface PushApiDeps {
  db: Db;
  /** VAPID 키를 (처음이면 만들어) 돌려준다. 키 파일을 쓸 수 없으면 예외 */
  getVapid: () => Vapid;
  getSender: () => PushSender;
  /** 테스트용 추가 허용 호스트 */
  allowHosts: readonly string[];
  now: () => Date;
}

interface SubRow {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  timezone: string;
  enabled: number;
}

const b64uLen = (s: unknown): number => (typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url').length : -1);

export function createPushRoutes(deps: PushApiDeps): AuthedRoute[] {
  const { db } = deps;
  const subOf = (deviceId: string) => db.prepare('SELECT * FROM push_subscriptions WHERE device_id = ?').get(deviceId) as SubRow | undefined;
  const view = (r: SubRow) => ({ subscribed: true, enabled: r.enabled === 1, timezone: r.timezone });

  return [
    {
      method: 'GET',
      path: '/api/push/key',
      handle(_req, res) {
        try {
          sendJson(res, 200, { publicKey: deps.getVapid().publicKey });
        } catch (err) {
          console.error('[push] VAPID 키를 준비하지 못했어요:', err);
          throw new HttpError(503, 'push_unavailable', '이 서버는 알림을 보낼 수 없어요 (키 파일을 만들 수 없어요)');
        }
      },
    },
    {
      method: 'PUT',
      path: '/api/devices/me/push',
      async handle(req, res, _url, device) {
        const body = (await readJson<Record<string, unknown>>(req)) ?? {};
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'validation', 'enabled 는 true/false 여야 해요');
        if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) throw new HttpError(400, 'invalid_timezone', '올바른 시간대(예: Asia/Seoul)가 아니에요');
        const existing = subOf(device.id);
        const now = deps.now().toISOString();

        if (body.subscription === undefined) {
          // 구독은 그대로 두고 켜기/끄기·시간대만 바꾼다
          if (!existing) throw new HttpError(409, 'not_subscribed', '이 기기는 알림을 구독하지 않았어요');
          const enabled = body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0;
          const tz = (body.timezone as string | undefined) ?? existing.timezone;
          db.prepare('UPDATE push_subscriptions SET enabled = ?, timezone = ?, updated_at = ? WHERE device_id = ?').run(enabled, tz, now, device.id);
          sendJson(res, 200, view(subOf(device.id)!));
          return;
        }

        const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
        if (typeof sub !== 'object' || sub === null || typeof sub.endpoint !== 'string' || !isAllowedPushEndpoint(sub.endpoint, deps.allowHosts)) {
          throw new HttpError(400, 'invalid_endpoint', '허용되지 않은 푸시 주소예요');
        }
        const p256dh = sub.keys?.p256dh;
        const auth = sub.keys?.auth;
        if (b64uLen(p256dh) !== 65 || b64uLen(auth) !== 16) throw new HttpError(400, 'invalid_subscription', '구독 키가 올바르지 않아요');
        const timezone = (body.timezone as string | undefined) ?? existing?.timezone;
        if (!timezone) throw new HttpError(400, 'invalid_timezone', '시간대가 필요해요');
        const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0;
        // 한 푸시 구독은 기기 하나에만 속한다 (같은 브라우저를 새 기기로 다시 등록한 경우 옛 기기의 구독을 지운다)
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id != ?').run(sub.endpoint, device.id);
        db.prepare(
          `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, timezone, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, timezone = excluded.timezone, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        ).run(device.id, sub.endpoint, p256dh as string, auth as string, timezone, enabled, now);
        sendJson(res, 200, view(subOf(device.id)!));
      },
    },
    {
      method: 'DELETE',
      path: '/api/devices/me/push',
      handle(_req, res, _url, device) {
        db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(device.id);
        sendJson(res, 200, { subscribed: false, enabled: false, timezone: null });
      },
    },
    {
      method: 'POST',
      path: '/api/push/test',
      async handle(_req, res, _url, device) {
        const row = subOf(device.id);
        if (!row) throw new HttpError(409, 'not_subscribed', '이 기기는 알림을 구독하지 않았어요');
        if (row.enabled !== 1) throw new HttpError(409, 'disabled', '이 기기의 알림이 꺼져 있어요');
        let sender: PushSender;
        try {
          sender = deps.getSender();
        } catch (err) {
          console.error('[push] 보내기를 준비하지 못했어요:', err);
          throw new HttpError(503, 'push_unavailable', '이 서버는 알림을 보낼 수 없어요');
        }
        const result = await sender.send({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, { v: 1, test: true });
        if (result === 'ok') {
          sendJson(res, 200, { sent: true });
          return;
        }
        if (result === 'gone') {
          db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(device.id); // 푸시 서비스가 구독이 사라졌다고 답했다
          throw new HttpError(409, 'not_subscribed', '알림 구독이 만료됐어요. 알림을 다시 켜 주세요');
        }
        throw new HttpError(502, result === 'retry' ? 'push_unavailable' : 'push_failed', '푸시 서비스에 알림을 보내지 못했어요');
      },
    },
  ];
}
