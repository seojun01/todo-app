// 기기 페어링 + 기기별 세션 쿠키. 코드와 토큰은 SHA-256 해시만 저장한다.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isUuid } from '../../shared/task.ts';
import { transaction, type Db } from './db.ts';
import { HttpError } from './http.ts';

/** 혼동하기 쉬운 0/O, 1/I/L 을 뺀 대문자와 숫자 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 10 * 60_000;
export const COOKIE_NAME = 'todo_session';
export const MAX_DEVICE_NAME = 50;

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashToken = sha256;

const normalizeCode = (raw: string) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function validDeviceName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() === name && [...name].length >= 1 && [...name].length <= MAX_DEVICE_NAME;
}

/** 일회용 페어링 코드를 발급한다. 반환값(평문)은 이때 한 번만 볼 수 있다. */
export function createPairingCode(db: Db, deviceName: string, now: Date = new Date()): string {
  const name = typeof deviceName === 'string' ? deviceName.trim() : '';
  if (!validDeviceName(name)) throw new HttpError(400, 'invalid_name', `기기 이름은 1~${MAX_DEVICE_NAME}자여야 해요`);
  let plain = '';
  for (let i = 0; i < 8; i++) plain += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  db.prepare('INSERT INTO pairing_codes (code_hash, device_name, expires_at, used_at) VALUES (?, ?, ?, NULL)').run(
    sha256(plain),
    name,
    new Date(now.getTime() + CODE_TTL_MS).toISOString(),
  );
  return `${plain.slice(0, 4)}-${plain.slice(4)}`;
}

/** 실패가 윈도우(기본 1분) 안에 max(기본 5)회에 이르면 이후 시도를 429 로 막는다 */
export class FailureLimiter {
  private failures: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max = 5, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  private prune(now: Date) {
    const cutoff = now.getTime() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }
  check(now: Date): void {
    this.prune(now);
    if (this.failures.length >= this.max) throw new HttpError(429, 'rate_limited', '잠시 후 다시 시도해 주세요');
  }
  fail(now: Date): void {
    this.prune(now);
    this.failures.push(now.getTime());
  }
}

export function redeemPairingCode(
  db: Db,
  rawCode: string,
  deviceId: string,
  opts: { now?: Date; limiter?: FailureLimiter } = {},
): { deviceId: string; deviceName: string; token: string } {
  const now = opts.now ?? new Date();
  opts.limiter?.check(now);

  if (!isUuid(deviceId) || db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)) {
    throw new HttpError(400, 'invalid_device_id', '기기 ID 가 올바르지 않거나 이미 등록되어 있어요');
  }
  const token = randomBytes(32).toString('base64url'); // 256비트
  const nowIso = now.toISOString();
  const row = transaction(db, () => {
    const found = db
      .prepare('SELECT device_name FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(sha256(normalizeCode(rawCode)), nowIso) as { device_name: string } | undefined;
    if (!found) return null;
    db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?').run(nowIso, sha256(normalizeCode(rawCode)));
    db.prepare('INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)').run(
      deviceId,
      found.device_name,
      hashToken(token),
      nowIso,
    );
    return found;
  });
  if (!row) {
    opts.limiter?.fail(now);
    throw new HttpError(400, 'invalid_code', '페어링 코드가 틀렸거나 만료되었어요');
  }
  return { deviceId, deviceName: row.device_name, token };
}

/** 활성 기기의 토큰이면 기기를 돌려주고 last_seen_at 을 갱신한다 */
export function authenticate(db: Db, token: string | undefined, now: Date = new Date()): Device | null {
  if (!token) return null;
  const dev = db
    .prepare('SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(token)) as Device | undefined;
  if (!dev) return null;
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), dev.id);
  return { ...dev, last_seen_at: now.toISOString() };
}

/** 기기를 해제한다(푸시 구독도 함께 삭제). 그런 기기가 있었으면 true */
export function revokeDevice(db: Db, id: string, now: Date = new Date()): boolean {
  return transaction(db, () => {
    const dev = db.prepare('SELECT id FROM devices WHERE id = ?').get(id);
    if (!dev) return false;
    db.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now.toISOString(), id);
    db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
    return true;
  });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function tokenFromRequest(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

/** 개발·테스트(TODO_DEV=1)에서만 Secure 를 뺀다. WebKit 은 http://localhost 에서 Secure 쿠키를 거부한다. */
export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=315360000${secure ? '; Secure' : ''}`;
}
