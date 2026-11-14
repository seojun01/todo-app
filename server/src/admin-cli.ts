#!/usr/bin/env node
// todo-admin: 홈서버 LXC 안에서만 실행하는 관리 CLI. HTTP 를 거치지 않고 DB 에 직접 접근한다.
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { MAX_DEVICE_NAME, createPairingCode, revokeDevice, validDeviceName } from './auth.ts';
import { buildExport } from '../../shared/export.ts';
import { DEFAULT_DB, openDb, type Db } from './db.ts';
import { rowToProject, rowToSettings, rowToTask } from './sync.ts';
import { loadOrCreateVapid } from './vapid.ts';
import { createPushSender } from './webpush.ts';

const USAGE = `사용법: todo-admin <명령>
  pair --name <이름>      새 기기를 등록할 일회용 페어링 코드를 발급한다 (10분간 유효)
  devices                  등록된 기기 목록
  revoke <deviceId>        기기의 접근 권한을 해제한다
  push-test <deviceId>     그 기기에 테스트 푸시를 보내고 푸시 서비스의 응답 코드를 출력한다
  export [--out <파일>]    모든 프로젝트와 할 일을 JSON 으로 내보낸다 (파일을 주지 않으면 stdout)
  backup <파일>            SQLite 온라인 백업을 만든다 (서비스를 멈추지 않아도 된다)`;

const fmtTime = (iso: string | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function cmdPair(db: Db, args: string[]): number {
  const i = args.indexOf('--name');
  const name = i >= 0 ? (args[i + 1] ?? '').trim() : '';
  if (!validDeviceName(name)) {
    console.error(`기기 이름은 1~${MAX_DEVICE_NAME}자여야 해요.\n${USAGE}`);
    return 2;
  }
  const code = createPairingCode(db, name);
  console.log(`페어링 코드: ${code} (10분간 유효, 1회용)`);
  return 0;
}

function cmdDevices(db: Db): number {
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.revoked_at, p.enabled AS push_enabled
       FROM devices d LEFT JOIN push_subscriptions p ON p.device_id = d.id ORDER BY d.created_at`,
    )
    .all() as { id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; push_enabled: number | null }[];
  const lines = [['ID', '이름', '등록 시각', '마지막 동기화', '알림', '상태']];
  for (const r of rows) {
    lines.push([r.id, r.name, fmtTime(r.created_at), fmtTime(r.last_seen_at), r.push_enabled === null ? '없음' : r.push_enabled ? '켬' : '끔', r.revoked_at ? '해제' : '활성']);
  }
  const widths = lines[0]!.map((_, c) => Math.max(...lines.map((l) => l[c]!.length)));
  for (const l of lines) console.log(l.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd());
  return 0;
}

function cmdRevoke(db: Db, args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error(USAGE);
    return 2;
  }
  const dev = db.prepare('SELECT name FROM devices WHERE id = ?').get(id) as { name: string } | undefined;
  if (!dev || !revokeDevice(db, id)) {
    console.error(`그런 기기가 없어요: ${id}`);
    return 1;
  }
  console.log(`해제됨: ${dev.name} (${id.slice(0, 4)}…)`);
  return 0;
}

/** 푸시 서비스의 응답을 사람이 읽을 안내로 */
const PUSH_HINT: Record<string, string> = {
  ok: '전달됐어요. 기기에 테스트 알림이 보이는지 확인하세요.',
  gone: '푸시 서비스가 이 구독을 모른다고 답했어요 (만료). 그 기기의 앱 설정에서 알림을 다시 켜세요.',
  retry: '푸시 서비스가 일시적으로 받지 못했어요 (오류·제한). 잠시 뒤 다시 시도하세요.',
  fail: '푸시 서비스가 요청을 거절했어요 (키·형식 오류, 허용되지 않은 주소 등). 서버 로그와 VAPID 설정을 확인하세요.',
};

async function cmdPushTest(db: Db, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error(USAGE);
    return 2;
  }
  const dev = db.prepare('SELECT name, revoked_at FROM devices WHERE id = ?').get(id) as { name: string; revoked_at: string | null } | undefined;
  if (!dev) {
    console.error(`그런 기기가 없어요: ${id}`);
    return 1;
  }
  const sub = db.prepare('SELECT endpoint, p256dh, auth, enabled FROM push_subscriptions WHERE device_id = ?').get(id) as
    | { endpoint: string; p256dh: string; auth: string; enabled: number }
    | undefined;
  if (!sub) {
    console.error(`${dev.name} 기기는 알림을 구독하지 않았어요. 그 기기의 앱 설정에서 "이 기기에서 알림 받기"를 켜세요.`);
    return 1;
  }
  const vapidFile = process.env.TODO_VAPID_FILE ?? join(dirname(process.env.TODO_DB ?? DEFAULT_DB), 'vapid.json');
  const allowHosts = (process.env.TODO_PUSH_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  let sender;
  try {
    sender = createPushSender({ vapid: loadOrCreateVapid(vapidFile), subject: process.env.TODO_VAPID_SUBJECT ?? 'https://todo.home.arpa', allowHosts });
  } catch (err) {
    console.error(`VAPID 키를 준비하지 못했어요 (${vapidFile}): ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const out = await sender.sendDetailed({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, { v: 1, test: true });
  console.log(`푸시 서비스 응답: ${out.status ?? '응답 없음'} (${out.result})`);
  console.log(PUSH_HINT[out.result]!);
  if (sub.enabled !== 1) console.log('참고: 이 기기의 알림은 앱에서 꺼져 있어요 (예약된 알림은 가지 않아요).');
  if (dev.revoked_at) console.log('참고: 이 기기는 해제된 기기예요.');
  return out.result === 'ok' ? 0 : 1;
}

function cmdExport(db: Db, args: string[]): number {
  const i = args.indexOf('--out');
  const out = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && !out) {
    console.error(USAGE);
    return 2;
  }
  const data = buildExport(
    (db.prepare('SELECT * FROM projects').all() as Record<string, any>[]).map(rowToProject),
    (db.prepare('SELECT * FROM tasks').all() as Record<string, any>[]).map(rowToTask),
    (() => {
      const r = db.prepare(`SELECT * FROM settings WHERE id = 'settings'`).get() as Record<string, any> | undefined;
      return r ? rowToSettings(r) : null;
    })(),
  );
  const json = JSON.stringify(data, null, 2);
  if (out) writeFileSync(out, json + '\n');
  else console.log(json);
  return 0;
}

function cmdBackup(db: Db, args: string[]): number {
  const dest = args[0];
  if (!dest) {
    console.error(USAGE);
    return 2;
  }
  if (existsSync(dest)) {
    console.error(`이미 있는 파일이에요. 덮어쓰지 않아요: ${dest}`);
    return 1;
  }
  try {
    db.prepare('VACUUM INTO ?').run(dest); // 실행 중인 DB 에서도 일관된 사본을 만든다
  } catch (err) {
    console.error(`백업하지 못했어요: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(`백업함: ${dest}`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'pair' && cmd !== 'devices' && cmd !== 'revoke' && cmd !== 'export' && cmd !== 'backup' && cmd !== 'push-test') {
    console.error(USAGE);
    return 2;
  }
  const db = openDb();
  try {
    if (cmd === 'pair') return cmdPair(db, rest);
    if (cmd === 'devices') return cmdDevices(db);
    if (cmd === 'export') return cmdExport(db, rest);
    if (cmd === 'backup') return cmdBackup(db, rest);
    if (cmd === 'push-test') return await cmdPushTest(db, rest);
    return cmdRevoke(db, rest);
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
