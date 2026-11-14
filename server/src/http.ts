// 작은 HTTP 헬퍼: JSON 응답, 본문 읽기(1 MiB 제한), 오류 형식
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY = 1024 * 1024; // 1 MiB

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendNoContent(res: ServerResponse, status = 204): void {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    return;
  }
  console.error('[server] unexpected error:', err);
  sendJson(res, 500, { error: 'internal', message: '서버 오류가 발생했어요' });
}

/** 본문을 읽는다. 1 MiB 를 넘으면 413 */
export async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'too_large', '요청이 너무 커요');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too_large', '요청이 너무 커요');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  if (buf.length === 0) throw new HttpError(400, 'invalid_json', '본문이 비어 있어요');
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', '올바른 JSON 이 아니에요');
  }
}
