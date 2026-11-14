// Web Push 전송: 암호화(RFC 8291 aes128gcm) + 서버 식별(VAPID, RFC 8292) + 전송(RFC 8030). 외부 라이브러리 없이 node:crypto 만 쓴다.
// 서버가 외부로 내보내는 유일한 데이터 경로라서 구독 endpoint 는 허용 목록으로 제한한다 (SSRF 방지).
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { Vapid } from './vapid.ts';

export interface PushSubscription {
  endpoint: string;
  /** 구독자(브라우저)의 공개키: 비압축 점 65바이트의 base64url */
  p256dh: string;
  /** 구독자와 나눈 인증 비밀 16바이트의 base64url */
  auth: string;
}

export type PushResult = 'ok' | 'gone' | 'retry' | 'fail';

export interface PushOutcome {
  result: PushResult;
  /** 푸시 서비스가 돌려준 HTTP 상태 코드 (요청을 보내지 않았거나 응답이 없으면 없다) */
  status?: number;
}

export interface PushSender {
  /** payload 를 JSON 으로 암호화해 보낸다. 결과는 ok/gone(구독 삭제)/retry(다음에 다시)/fail(다시 보내지 않음) */
  send(sub: PushSubscription, payload: object): Promise<PushResult>;
  /** send 와 같지만 푸시 서비스의 응답 코드도 돌려준다 (관리 CLI 의 push-test 가 보여 준다) */
  sendDetailed(sub: PushSubscription, payload: object): Promise<PushOutcome>;
}

/** 푸시 서비스가 TTL 안에 전달하지 못하면 버리게 하는 시간(초). 알림을 15분 넘게 늦게 울리지 않는다 (research R13) */
export const PUSH_TTL = 900;
const RECORD_SIZE = 4096;
const SEND_TIMEOUT_MS = 10_000;
const text = (s: string) => Buffer.from(s, 'utf8');

// ── 허용 endpoint ──

const BUILT_IN_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const BUILT_IN_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

/**
 * 구독 endpoint 가 푸시 서비스 주소로 허용되는가: https 이고 기본 포트이며 자격 증명이 없고 허용 호스트일 때만.
 * extraHosts(예: "127.0.0.1:4567")는 테스트용 가짜 푸시 서비스를 위한 것으로 http 도 허용한다 (환경 변수 TODO_PUSH_ALLOW_HOSTS).
 */
export function isAllowedPushEndpoint(endpoint: string, extraHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (extraHosts.includes(url.host)) return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  return BUILT_IN_HOSTS.includes(host) || BUILT_IN_SUFFIXES.some((s) => host.endsWith(s));
}

// ── 암호화 (RFC 8291) ──

/** ECDH 비밀과 두 공개키·인증 비밀·salt 에서 콘텐츠 암호화 키(CEK 16바이트)와 nonce(12바이트)를 만든다 (RFC 8291 §3.3~3.4, RFC 8188) */
export function deriveEncryptionKeys(p: { ecdhSecret: Buffer; uaPublic: Buffer; asPublic: Buffer; authSecret: Buffer; salt: Buffer }): { ikm: Buffer; cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([text('WebPush: info\0'), p.uaPublic, p.asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', p.ecdhSecret, p.authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, p.salt, text('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, p.salt, text('Content-Encoding: nonce\0'), 12));
  return { ikm, cek, nonce };
}

/** plaintext 를 구독자에게만 풀리게 암호화한 요청 본문(헤더 + 암호문). salt·senderPrivate 는 공식 테스트 벡터 검증용이다. */
export function encryptPayload(plaintext: Buffer, sub: Pick<PushSubscription, 'p256dh' | 'auth'>, opts: { salt?: Buffer; senderPrivate?: Buffer } = {}): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('구독 공개키(p256dh)가 올바르지 않아요');
  if (authSecret.length !== 16) throw new Error('구독 인증 비밀(auth)이 올바르지 않아요');
  if (plaintext.length > RECORD_SIZE - 17 - 16 - 1) throw new Error('푸시 내용이 너무 길어요');

  const ecdh = createECDH('prime256v1');
  if (opts.senderPrivate) ecdh.setPrivateKey(opts.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ?? randomBytes(16);
  const { cek, nonce } = deriveEncryptionKeys({ ecdhSecret: ecdh.computeSecret(uaPublic), uaPublic, asPublic, authSecret, salt });

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 마지막 레코드의 끝에는 패딩 구분 바이트 0x02 를 붙인다
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

/** encryptPayload 의 반대 (구독자 쪽). 앱에는 필요 없고 테스트용 가짜 푸시 서비스가 요청을 검증하는 데 쓴다. */
export function decryptPayload(body: Buffer, receiverPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idLen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLen);
  const encrypted = body.subarray(21 + idLen);
  if (rs < encrypted.length) throw new Error('여러 레코드는 지원하지 않아요');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const { cek, nonce } = deriveEncryptionKeys({ ecdhSecret: ecdh.computeSecret(asPublic), uaPublic: ecdh.getPublicKey(), asPublic, authSecret, salt });
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const record = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--; // 뒤쪽 0 패딩
  if (end === 0 || record[end - 1] !== 0x02) throw new Error('패딩 구분 바이트가 올바르지 않아요');
  return record.subarray(0, end - 1);
}

// ── VAPID (RFC 8292) ──

/** ES256 JWT. aud 는 푸시 서비스의 origin, exp 는 24시간 이내(12시간), sub 는 연락처 URL */
export function createVapidJwt(audience: string, subject: string, vapid: Vapid, nowSec: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })}`;
  const signature = sign('sha256', Buffer.from(data), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' }); // r||s 64바이트
  return `${data}.${signature.toString('base64url')}`;
}

// ── 전송 ──

export interface PushSenderOptions {
  vapid: Vapid;
  /** VAPID sub 클레임 (mailto: 또는 https: URL). 실제 이메일을 외부에 보내지 않도록 기본은 https 주소다 */
  subject: string;
  fetch?: typeof fetch;
  /** 테스트용 추가 허용 호스트("host:port") */
  allowHosts?: readonly string[];
  now?: () => Date;
}

export function createPushSender(opts: PushSenderOptions): PushSender {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  async function sendDetailed(sub: PushSubscription, payload: object): Promise<PushOutcome> {
      // 허용되지 않은 주소에는 요청을 아예 보내지 않는다
      if (!isAllowedPushEndpoint(sub.endpoint, opts.allowHosts)) return { result: 'fail' };
      let body: Buffer;
      try {
        body = encryptPayload(text(JSON.stringify(payload)), sub);
      } catch {
        return { result: 'fail' }; // 구독 키가 잘못됐다: 다시 보내도 소용없다
      }
      const jwt = createVapidJwt(new URL(sub.endpoint).origin, opts.subject, opts.vapid, Math.floor(now().getTime() / 1000));
      try {
        const res = await doFetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `vapid t=${jwt}, k=${opts.vapid.publicKey}`,
            TTL: String(PUSH_TTL),
            Urgency: 'high',
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        await res.arrayBuffer().catch(() => undefined); // 연결을 돌려준다
        const status = res.status;
        if (status >= 200 && status < 300) return { result: 'ok', status };
        if (status === 404 || status === 410) return { result: 'gone', status }; // 구독이 사라졌다
        if (status === 429 || status >= 500 || status === 408) return { result: 'retry', status };
        return { result: 'fail', status }; // 400/401/403 등: VAPID·형식 오류. 다시 보내지 않는다
      } catch {
        return { result: 'retry' }; // 네트워크 오류·시간 초과
      }
  }
  return { send: async (sub, payload) => (await sendDetailed(sub, payload)).result, sendDetailed };
}
