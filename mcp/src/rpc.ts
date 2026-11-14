// MCP(Model Context Protocol)의 stdio 전송: 한 줄에 JSON-RPC 메시지 하나. 필요한 부분(initialize, ping, tools/list, tools/call)만 구현한다.
// 표준 출력에는 프로토콜 메시지만 쓴다. 로그는 표준 오류(stderr)로 보낸다.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ApiError } from './client.ts';
import { ToolError } from './tasks.ts';
import type { ToolDef } from './tools.ts';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface ServeOptions {
  input: Readable;
  output: Writable;
  info: { name: string; version: string };
  log?: (msg: string) => void;
}

type Id = string | number | null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function errorText(err: unknown): { text: string; unexpected: boolean } {
  if (err instanceof ToolError) return { text: err.message, unexpected: false };
  if (err instanceof ApiError) return { text: err.message, unexpected: false };
  return { text: `예상치 못한 오류: ${err instanceof Error ? err.message : String(err)}`, unexpected: true };
}

export async function serve(tools: ToolDef[], opts: ServeOptions): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (msg: unknown) => void opts.output.write(JSON.stringify(msg) + '\n');
  const reply = (id: Id, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Id, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg: unknown): Promise<void> {
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      fail(isObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, -32600, 'Invalid Request');
      return;
    }
    // id 가 없으면 알림(notification)이라 답하지 않는다 (예: notifications/initialized)
    if (!('id' in msg)) return;
    const id = msg.id as Id;
    const params = isObject(msg.params) ? msg.params : {};

    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        reply(id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: opts.info,
          instructions:
            '개인 할 일 앱(홈서버)의 할 일을 읽고 바꿉니다. 날짜는 YYYY-MM-DD, 시각은 HH:MM 입니다. 상대 날짜는 list_tasks 가 돌려주는 today 를 기준으로 계산하세요. 삭제는 사용자가 분명히 원할 때만 하세요.',
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(
          id,
          {
            tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
          },
        );
        return;
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
        if (!tool) {
          fail(id, -32602, `알 수 없는 도구예요: ${String(params.name)}`);
          return;
        }
        const args = isObject(params.arguments) ? params.arguments : {};
        try {
          const out = await tool.run(args);
          reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (err) {
          const { text, unexpected } = errorText(err);
          if (unexpected) log(`[도구 오류] ${tool.name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          reply(id, { content: [{ type: 'text', text }], isError: true });
        }
        return;
      }
      default:
        fail(id, -32601, `지원하지 않는 메서드예요: ${msg.method}`);
    }
  }

  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    await handle(msg);
  }
}
