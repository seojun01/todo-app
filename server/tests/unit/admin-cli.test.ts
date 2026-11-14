import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.ts';
import { createPairingCode, redeemPairingCode } from '../../src/auth.ts';

let dbFile = '';
beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), 'todo-cli-')), 'todo.db');
});

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--no-warnings', 'server/src/admin-cli.ts', ...args], {
    env: { ...process.env, TODO_DB: dbFile },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function registerDevice(name: string): string {
  const db = openDb(dbFile);
  const id = crypto.randomUUID();
  redeemPairingCode(db, createPairingCode(db, name), id);
  db.close();
  return id;
}

test('pair: 페어링 코드를 한 줄로 출력한다', () => {
  const r = cli('pair', '--name', 'iPhone');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out.trim(), /^페어링 코드: [A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4} \(10분간 유효, 1회용\)$/);
  // 발급된 코드는 DB 에 해시로 남는다
  const db = openDb(dbFile);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get() as { n: number }).n, 1);
  db.close();
});

test('pair: 이름이 없거나 비었거나 50자를 넘으면 종료 코드 2', () => {
  assert.equal(cli('pair').status, 2);
  assert.equal(cli('pair', '--name', '').status, 2);
  assert.equal(cli('pair', '--name', '   ').status, 2);
  assert.equal(cli('pair', '--name', 'x'.repeat(51)).status, 2);
  assert.equal(cli('pair', '--name', 'x'.repeat(50)).status, 0);
});

test('devices: 등록된 기기를 표로 보여 주고 해제하면 상태가 바뀐다', () => {
  const id = registerDevice('내 아이패드');
  let r = cli('devices');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /ID\s+이름\s+등록 시각\s+마지막 동기화\s+알림\s+상태/);
  const line = r.out.split('\n').find((l) => l.includes(id))!;
  assert.ok(line, '기기 줄');
  assert.match(line, /내 아이패드/);
  assert.match(line, /없음/); // 푸시 구독 없음
  assert.match(line, /활성/);

  assert.equal(cli('revoke', id).status, 0);
  r = cli('devices');
  assert.match(r.out.split('\n').find((l) => l.includes(id))!, /해제/);
});

test('revoke: 이름과 짧은 ID 를 출력하고, 없는 ID 는 종료 코드 1', () => {
  const id = registerDevice('iPhone');
  const ok = cli('revoke', id);
  assert.equal(ok.status, 0, ok.err);
  assert.equal(ok.out.trim(), `해제됨: iPhone (${id.slice(0, 4)}…)`);
  const db = openDb(dbFile);
  assert.ok((db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(id) as { revoked_at: string | null }).revoked_at);
  db.close();

  assert.equal(cli('revoke', crypto.randomUUID()).status, 1);
  assert.equal(cli('revoke').status, 2, 'ID 를 안 주면 사용법 오류');
});

test('알 수 없는 명령은 사용법을 보여 주고 종료 코드 2', () => {
  const r = cli('bogus');
  assert.equal(r.status, 2);
  assert.match(r.err + r.out, /사용법/);
});
