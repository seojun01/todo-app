import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { createPairingCode } from '../../server/src/auth.ts';
import { ApiError, TodoClient, pair } from '../src/client.ts';
import { loadCredentials } from '../src/credentials.ts';
import { run } from '../src/main.ts';
import { serve } from '../src/rpc.ts';
import { buildTools } from '../src/tools.ts';
import { setup, type Json, type Setup } from './helpers.ts';

/** 요청을 한 줄씩 보내고 입력을 닫은 뒤, 서버가 쓴 응답을 모두 돌려준다 */
async function exchange(s: Setup, requests: unknown[], opts: { readOnly?: boolean } = {}): Promise<Json[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (d: Buffer) => chunks.push(d.toString()));
  const done = serve(buildTools(() => s.ctx, { readOnly: opts.readOnly ?? false }), { input, output, info: { name: 'todo-app', version: 'test' } });
  for (const r of requests) input.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n');
  input.end();
  await done;
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('MCP 프로토콜 (stdio JSON-RPC)', () => {
  let s: Setup;
  before(async () => {
    s = await setup();
  });
  after(async () => {
    await s.close();
  });

  it('initialize → 알림은 답하지 않고 → tools/list', async () => {
    const out = await exchange(s, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ]);
    assert.equal(out.length, 3, '알림(id 없음)에는 응답이 없어야 해요');
    assert.equal(out[0].id, 1);
    assert.equal(out[0].result.protocolVersion, '2025-06-18');
    assert.equal(out[0].result.serverInfo.name, 'todo-app');
    assert.deepEqual(out[0].result.capabilities.tools, { listChanged: false });
    assert.deepEqual(out[1], { jsonrpc: '2.0', id: 2, result: {} });
    const names = out[2].result.tools.map((t: Json) => t.name);
    assert.deepEqual(names, ['list_tasks', 'search_tasks', 'list_projects', 'add_task', 'update_task', 'complete_task', 'reopen_task', 'delete_task']);
    for (const t of out[2].result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 10);
    }
  });

  it('모르는 프로토콜 버전을 물으면 지원하는 최신 버전으로 답한다', async () => {
    const [r] = await exchange(s, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }]);
    assert.equal(r.result.protocolVersion, '2025-06-18');
  });

  it('tools/call: 추가 → 목록 (결과는 text 안의 JSON)', async () => {
    const out = await exchange(s, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_task', arguments: { title: '프로토콜로 추가', due_date: '2026-11-14' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } },
    ]);
    assert.equal(out[0].result.isError, undefined);
    assert.equal(JSON.parse(out[0].result.content[0].text).added.title, '프로토콜로 추가');
    const list = JSON.parse(out[1].result.content[0].text);
    assert.ok(list.tasks.some((t: Json) => t.title === '프로토콜로 추가'));
    assert.equal(list.today, '2026-11-14');
  });

  it('도구 오류는 JSON-RPC 오류가 아니라 isError 결과로 돌려준다', async () => {
    const [r] = await exchange(s, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_task', arguments: { title: '' } } }]);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /title/);
  });

  it('프로토콜 오류: 모르는 도구·메서드, 깨진 JSON', async () => {
    const out = await exchange(s, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'format_disk', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      '이건 JSON 이 아니에요',
      { hello: 'world' },
    ]);
    assert.equal(out[0].error.code, -32602);
    assert.equal(out[1].error.code, -32601);
    assert.equal(out[2].error.code, -32700);
    assert.equal(out[3].error.code, -32600);
  });

  it('읽기 전용 모드: 쓰기 도구는 목록에도 없고 호출도 거부한다', async () => {
    const out = await exchange(
      s,
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_task', arguments: { id: 'x' } } },
      ],
      { readOnly: true },
    );
    assert.equal(out[0].result.tools.length, 3);
    assert.equal(out[1].error.code, -32602);
  });
});

describe('페어링과 CLI', () => {
  let s: Setup;
  before(async () => {
    s = await setup();
  });
  after(async () => {
    await s.close();
  });

  it('pair(): 코드로 등록하면 그 토큰으로 서버를 읽을 수 있다', async () => {
    const code = createPairingCode(s.srv.db, 'Claude 2');
    const creds = await pair(s.srv.base, code);
    assert.equal(creds.url, s.srv.base);
    const snap = await new TodoClient(creds).pullAll();
    assert.ok(snap.tasks instanceof Map);
  });

  it('pair(): 틀린 코드는 invalid_code, 한 번 쓴 코드는 다시 못 쓴다', async () => {
    await assert.rejects(pair(s.srv.base, 'AAAA-BBBB'), (e: Error) => e instanceof ApiError && e.code === 'invalid_code');
    const code = createPairingCode(s.srv.db, 'once');
    await pair(s.srv.base, code);
    await assert.rejects(pair(s.srv.base, code), (e: Error) => e instanceof ApiError && e.code === 'invalid_code');
  });

  it('해제된 기기는 401 과 함께 다시 페어링하라는 안내를 받는다', async () => {
    const code = createPairingCode(s.srv.db, 'revoked');
    const creds = await pair(s.srv.base, code);
    s.srv.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), creds.deviceId);
    await assert.rejects(new TodoClient(creds).pullAll(), (e: Error) => e instanceof ApiError && e.status === 401 && /pair/.test(e.message));
  });

  it('서버에 닿지 않으면 연결 확인 안내가 나온다', async () => {
    const dead = new TodoClient({ url: 'http://127.0.0.1:1', token: 'x' });
    await assert.rejects(dead.pullAll(), (e: Error) => e instanceof ApiError && e.code === 'network' && /WireGuard/.test(e.message));
  });

  it('CLI: pair → 파일은 0600 → status 가 서버에 연결된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-mcp-'));
    const file = join(dir, 'sub', 'credentials.json');
    const env = { TODO_MCP_CREDENTIALS: file };
    const log = console.log;
    const err = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      assert.equal(await run(['status'], env), 1, '등록 전에는 실패');
      assert.equal(await run(['pair', '--url', s.srv.base, '--code', 'AAAA-BBBB'], env), 1, '틀린 코드');
      assert.equal(loadCredentials(file), null);
      const code = createPairingCode(s.srv.db, 'cli');
      assert.equal(await run(['pair', '--url', s.srv.base, '--code', code], env), 0);
      assert.equal(statSync(file).mode & 0o777, 0o600, '토큰이 든 파일은 본인만 읽을 수 있어야 해요');
      assert.equal(await run(['status'], env), 0);
      assert.equal(await run(['bogus'], env), 2);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
