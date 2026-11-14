// 테스트용 가짜 푸시 서비스: 로컬 HTTP 서버. 구독마다 P-256 키쌍과 auth 비밀을 만들어 주고, 받은 요청의 헤더를 기록하며
// 본문을 RFC 8291 대로 복호화해 평문 페이로드를 남긴다. 응답 상태 코드를 바꿀 수 있다 (404/410/429/500 등).
import { createECDH, randomBytes } from 'node:crypto';
import http from 'node:http';
import { decryptPayload } from '../../src/webpush.ts';

export interface ReceivedPush {
  /** newSubscription() 이 만든 구독의 번호 */
  subscription: string;
  headers: http.IncomingHttpHeaders;
  /** 복호화한 평문 (JSON 이면 파싱한 값) */
  payload: unknown;
  rawBody: Buffer;
}

export interface FakePush {
  /** "127.0.0.1:포트" — 서버의 TODO_PUSH_ALLOW_HOSTS(allowHosts)에 넣는다 */
  host: string;
  received: ReceivedPush[];
  /** 앞으로 받는 요청에 돌려줄 상태 코드 */
  setStatus(code: number): void;
  newSubscription(): { id: string; endpoint: string; keys: { p256dh: string; auth: string } };
  close(): Promise<void>;
}

export async function startFakePush(): Promise<FakePush> {
  const subs = new Map<string, { priv: Buffer; auth: Buffer }>();
  const received: ReceivedPush[] = [];
  let status = 201;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const id = decodeURIComponent((req.url ?? '').replace(/^\/push\//, ''));
      const sub = subs.get(id);
      if (!sub) {
        res.writeHead(404).end(); // 모르는 구독 = 사라진 구독
        return;
      }
      const rawBody = Buffer.concat(chunks);
      try {
        const plain = decryptPayload(rawBody, sub.priv, sub.auth).toString('utf8');
        let payload: unknown = plain;
        try {
          payload = JSON.parse(plain);
        } catch {
          /* 평문 그대로 */
        }
        received.push({ subscription: id, headers: req.headers, payload, rawBody });
        res.writeHead(status).end();
      } catch {
        res.writeHead(400).end(); // 암호화가 올바르지 않다
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let n = 0;
  return {
    host: `127.0.0.1:${port}`,
    received,
    setStatus: (code) => (status = code),
    newSubscription() {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const auth = randomBytes(16);
      const id = `sub-${++n}`;
      subs.set(id, { priv: ecdh.getPrivateKey(), auth });
      return { id, endpoint: `http://127.0.0.1:${port}/push/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    },
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
