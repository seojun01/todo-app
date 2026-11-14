// 구글 캘린더 연동 (단방향: 할 일 → 캘린더).
//  - 권한은 calendar.app.created 뿐이다: 이 앱이 만든 보조 캘린더("할 일")의 일정만 읽고 쓸 수 있고, 기존 캘린더는 건드리지 못한다.
//  - 동기화는 서버가 한다. 변경은 모두 applyChanges 로 모이고(seq), gcal_seq 커서 이후의 할 일만 구글로 보낸다.
//  - 기한(날짜)이 있는 할 일 → 일정. 시각이 있으면 30분짜리 일정, 없으면 종일 일정.
//    완료하면 제목 앞에 ✓, 삭제하거나 기한을 없애면 일정을 지운다. 완료된 채로 처음 보는 할 일은 만들지 않는다.
//  - (선택) 일정 불러오기: 사용자의 구글 캘린더 일정을 읽기 전용으로 가져와 예정·캘린더 화면에 겹쳐 보여 준다.
//    읽기 권한(calendarlist.readonly, events.readonly)을 따로 받아야 켤 수 있고, 켜지 않으면 위의 최소 권한만 쓴다.
//    이 앱이 보낸 "할 일" 캘린더는 제외해 중복을 막고, 제목·시각만 가져온다(설명·참석자·장소는 요청하지도 않는다).
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addDays } from '../../shared/calendar.ts';
import { describeRecurrence } from '../../shared/recurrence.ts';
import { INBOX_ID, isValidDate, tagsOf, type Task } from '../../shared/task.ts';
import type { AuthedRoute, PublicRoute } from './api.ts';
import { transaction, type Db } from './db.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { rowToTask } from './sync.ts';

export const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
/** 일정 불러오기에 추가로 필요한 읽기 전용 권한 (캘린더 목록 + 일정) */
export const GCAL_READ_SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'] as const;
export const CALENDAR_NAME = '할 일';
const IMPORT_MS = 10 * 60_000;
const IMPORT_PAST_DAYS = 31;
const IMPORT_FUTURE_DAYS = 366;
const IMPORT_MAX_PAGES = 10;
const MAX_EVENTS_RANGE_DAYS = 400;
const EVENT_MINUTES = 30;
const STATE_TTL_MS = 10 * 60_000;
const RETRY_MS = 5 * 60_000;
const BATCH = 50;

export interface GcalConfig {
  clientId: string;
  clientSecret: string;
  /** Google Cloud 콘솔의 "승인된 리디렉션 URI" 와 정확히 같아야 한다 */
  redirectUri: string;
  /** 시각이 있는 할 일의 시간대 (할 일의 시각은 그 기기의 현지 시각이라 서버가 알 수 없다) */
  timeZone: string;
  /** 연결을 마친 뒤 돌아갈 앱 주소 (기본: 같은 주소) */
  appUrl: string;
}

/** 환경 변수에서 설정을 읽는다. 클라이언트 ID/시크릿이 없으면 null (기능 꺼짐). */
export function gcalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GcalConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const base = (env.TODO_PUBLIC_URL?.trim() || `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, '');
  return {
    clientId,
    clientSecret,
    redirectUri: `${base}/api/gcal/callback`,
    timeZone: env.TODO_TIMEZONE?.trim() || 'Asia/Seoul',
    appUrl: (env.TODO_APP_URL?.trim() || '').replace(/\/+$/, ''),
  };
}

// ── 할 일 → 일정 변환 (순수 함수) ───────────────────────────────────

export interface GcalEvent {
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  colorId?: string;
  reminders: { useDefault: false };
  extendedProperties: { private: { todoTaskId: string } };
}

const PRIORITY_COLOR: Record<number, string> = { 1: '11', 2: '6', 3: '9' }; // 토마토·귤·블루베리

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const t = ((total % 1440) + 1440) % 1440;
  return { date: addDays(date, Math.floor(total / 1440)), time: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` };
}

/** 기한이 있는 할 일을 일정으로 바꾼다. 기한이 없으면 null. */
export function eventFor(task: Task, projectName: string, timeZone: string): GcalEvent | null {
  if (!task.dueDate) return null;
  const lines = [`프로젝트: ${projectName}`];
  if (task.priority < 4) lines.push(`우선순위: P${task.priority}`);
  if (tagsOf(task).length > 0) lines.push(`태그: ${tagsOf(task).map((t) => `#${t}`).join(' ')}`);
  if (task.recurrence) lines.push(`반복: ${describeRecurrence(task.recurrence)} (완료하면 다음 일정으로 옮겨져요)`);
  lines.push('', '할 일 앱에서 만든 일정이에요. 여기서 고쳐도 앱에는 반영되지 않아요.');

  let start: GcalEvent['start'];
  let end: GcalEvent['end'];
  if (task.dueTime) {
    const e = addMinutes(task.dueDate, task.dueTime, EVENT_MINUTES);
    start = { dateTime: `${task.dueDate}T${task.dueTime}:00`, timeZone };
    end = { dateTime: `${e.date}T${e.time}:00`, timeZone };
  } else {
    start = { date: task.dueDate };
    end = { date: addDays(task.dueDate, 1) }; // 종일 일정의 끝 날짜는 포함하지 않는다
  }
  return {
    summary: task.done ? `✓ ${task.title}` : task.title,
    description: lines.join('\n'),
    start,
    end,
    ...(PRIORITY_COLOR[task.priority] ? { colorId: PRIORITY_COLOR[task.priority] } : {}),
    // 알림은 앱이 보낸다. 캘린더 쪽 기본 알림이 겹쳐 울리지 않게 끈다.
    reminders: { useDefault: false },
    extendedProperties: { private: { todoTaskId: task.id } },
  };
}

// ── 불러온 일정 변환 (순수 함수) ────────────────────────────────────

/** 구글 일정 응답에서 우리가 요청하는 필드만 */
export interface GoogleEventItem {
  id?: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: { todoTaskId?: string } };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

export interface ImportRow {
  eventId: string;
  title: string;
  startDate: string;
  /** 그날을 포함하는 끝 날짜 */
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}

/** 불러온 일정 (API 응답) */
export interface ImportedEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  /** #rrggbb 또는 null */
  color: string | null;
  title: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}

function localParts(iso: string, timeZone: string): { date: string; time: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

/**
 * 구글 일정 하나를 앱이 보여 줄 모양으로 바꾼다. 보여 줄 필요가 없는 일정은 null:
 * 취소됨, 내가 거절함, 이 앱이 보낸 일정(중복), 날짜를 읽을 수 없음. 시각은 timeZone 의 현지 시각으로 바꾼다.
 */
export function importRowFor(item: GoogleEventItem, timeZone: string): ImportRow | null {
  if (!item.id || item.status === 'cancelled') return null;
  if (item.extendedProperties?.private?.todoTaskId) return null;
  if (item.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const title = [...((item.summary ?? '').trim() || '(제목 없음)')].slice(0, 200).join('');

  if (item.start?.date) {
    if (!isValidDate(item.start.date)) return null;
    // 종일 일정의 끝 날짜는 구글에서 "포함하지 않는" 날짜라 하루를 줄인다
    let endDate = item.end?.date && isValidDate(item.end.date) ? addDays(item.end.date, -1) : item.start.date;
    if (endDate < item.start.date) endDate = item.start.date;
    return { eventId: item.id, title, startDate: item.start.date, endDate, startTime: null, endTime: null, allDay: true };
  }
  if (item.start?.dateTime) {
    const s = localParts(item.start.dateTime, timeZone);
    const e = item.end?.dateTime ? localParts(item.end.dateTime, timeZone) : null;
    if (!s) return null;
    let endDate = e?.date ?? s.date;
    let endTime: string | null = e?.time ?? null;
    // 자정에 끝나는 일정은 그 전날까지로 본다 (예: 23:00 ~ 다음 날 00:00)
    if (e && endDate > s.date && e.time === '00:00') {
      endDate = addDays(endDate, -1);
      endTime = null;
    }
    if (endDate < s.date) endDate = s.date;
    return { eventId: item.id, title, startDate: s.date, endDate, startTime: s.time, endTime, allDay: false };
  }
  return null;
}

// ── 연동 본체 ───────────────────────────────────────────────────────

export interface GcalStatus {
  /** 서버에 구글 클라이언트 설정이 있는가 */
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** 아직 구글에 반영하지 못한 변경 수 */
  pending: number;
}

/** 일정 불러오기 설정·상태 */
export interface GcalImportStatus {
  /** 읽기 권한을 받았는가 (없으면 구글에서 권한을 더 허용해야 켤 수 있다) */
  available: boolean;
  enabled: boolean;
  calendars: { id: string; name: string; color: string | null; selected: boolean; primary: boolean }[];
  lastImportAt: string | null;
  lastError: string | null;
}

export interface Gcal {
  status(): GcalStatus;
  /** import: true 면 일정 읽기 권한도 함께 요청한다 */
  startAuth(opts?: { import?: boolean }): { url: string };
  syncNow(): Promise<GcalStatus>;
  disconnect(): Promise<GcalStatus>;
  importStatus(): GcalImportStatus;
  importNow(): Promise<GcalImportStatus>;
  /** from ~ to (양 끝 포함) 날짜와 겹치는, 불러온 일정 */
  eventsBetween(from: string, to: string): ImportedEvent[];
  /** 변경이 생겼을 때 부른다: 기다리지 않고 뒤에서 동기화한다 */
  kick(): void;
  close(): void;
  routes: AuthedRoute[];
  publicRoutes: PublicRoute[];
}

export interface GcalOptions {
  db: Db;
  config: GcalConfig | null;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 재시도 간격 (테스트용) */
  retryMs?: number;
}

interface AccountRow {
  refresh_token: string | null;
  calendar_id: string | null;
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  needs_reauth: number;
  /** 구글이 허용해 준 권한(공백으로 구분) */
  scopes: string;
  import_enabled: number;
}

class GcalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  /** 이 오류는 그 할 일만의 문제라 건너뛰고 계속해도 되는가 (일시적이거나 계정 문제면 멈추고 나중에 다시) */
  get skippable(): boolean {
    return this.status >= 400 && this.status < 500 && ![401, 403, 408, 429].includes(this.status);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

export function createGcal(opts: GcalOptions): Gcal {
  const { db, config } = opts;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  let access: { token: string; expiresAt: number } | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const account = () => db.prepare('SELECT * FROM gcal_account WHERE id = 1').get() as AccountRow | undefined;
  const meta = (key: string) => (db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const setMeta = (key: string, value: string) =>
    db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  const setAccount = (patch: Partial<Record<keyof AccountRow, string | number | null>>) => {
    const keys = Object.keys(patch);
    db.prepare(`UPDATE gcal_account SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`).run(...(keys.map((k) => patch[k as keyof AccountRow]) as (string | number | null)[]));
  };
  const cursor = () => Number(meta('gcal_seq') ?? 0);
  const connected = (a = account()) => !!a && !!a.refresh_token && a.needs_reauth === 0;

  function status(): GcalStatus {
    const a = account();
    const pending = connected(a) ? (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE seq > ?').get(cursor()) as { n: number }).n : 0;
    return {
      configured: config !== null,
      connected: connected(a),
      needsReauth: !!a && a.needs_reauth === 1,
      lastSyncAt: a?.last_sync_at ?? null,
      lastError: a?.last_error ?? null,
      pending,
    };
  }

  // ── OAuth ──

  function startAuth(opts: { import?: boolean } = {}): { url: string } {
    if (!config) throw new HttpError(503, 'gcal_not_configured', '서버에 구글 클라이언트 설정이 없어요');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const t = now();
    db.prepare('DELETE FROM gcal_oauth_state WHERE expires_at < ?').run(t.toISOString());
    db.prepare('INSERT INTO gcal_oauth_state (state_hash, verifier, expires_at) VALUES (?, ?, ?)').run(
      sha256(state),
      verifier,
      new Date(t.getTime() + STATE_TTL_MS).toISOString(),
    );
    const q = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: opts.import ? [GCAL_SCOPE, ...GCAL_READ_SCOPES].join(' ') : GCAL_SCOPE,
      include_granted_scopes: 'true', // 전에 허용한 권한을 잃지 않고 더한다
      access_type: 'offline',
      prompt: 'consent', // 다시 연결해도 refresh_token 을 항상 받는다
      state,
      code_challenge: sha256(verifier),
      code_challenge_method: 'S256',
    });
    return { url: `${AUTH_URL}?${q}` };
  }

  async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }> {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config!.clientId, client_secret: config!.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 400 && body.error === 'invalid_grant') throw new GcalError(400, 'invalid_grant');
      throw new GcalError(res.status, `토큰 요청 실패 (HTTP ${res.status})`);
    }
    return body as never;
  }

  /** 구글이 되돌려 보낸 주소를 처리한다. 성공하면 true. 상태·오류는 계정에 기록해 설정 화면에 보여 준다. */
  async function handleCallback(url: URL): Promise<boolean> {
    if (!config) return false;
    const state = url.searchParams.get('state') ?? '';
    const row = db.prepare('SELECT verifier, expires_at FROM gcal_oauth_state WHERE state_hash = ?').get(sha256(state)) as
      | { verifier: string; expires_at: string }
      | undefined;
    if (!row) return false; // 우리가 시작한 연결이 아니다 (조용히 무시)
    db.prepare('DELETE FROM gcal_oauth_state WHERE state_hash = ?').run(sha256(state)); // 한 번만 쓴다
    const fail = (msg: string) => {
      ensureAccountRow();
      setAccount({ last_error: msg });
      return false;
    };
    if (row.expires_at < now().toISOString()) return fail('연결 시간이 지났어요. 다시 시도해 주세요.');
    if (url.searchParams.get('error')) return fail('구글 연결을 취소했거나 거부했어요.');
    const code = url.searchParams.get('code');
    if (!code) return fail('구글에서 인증 코드를 받지 못했어요.');
    try {
      const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: row.verifier });
      if (!tok.refresh_token) return fail('구글이 장기 사용 권한을 주지 않았어요. 다시 연결해 주세요.');
      ensureAccountRow();
      setAccount({ refresh_token: tok.refresh_token, needs_reauth: 0, last_error: null, scopes: tok.scope ?? GCAL_SCOPE });
      // 읽기 권한까지 허용하고 돌아왔다면 일정 불러오기를 켜려던 것이다 (이 권한은 그 흐름에서만 요청한다)
      if (importAvailable()) setAccount({ import_enabled: 1 });
      access = { token: tok.access_token, expiresAt: now().getTime() + tok.expires_in * 1000 };
      return true;
    } catch (err) {
      return fail(err instanceof GcalError ? '구글 인증에 실패했어요. 다시 시도해 주세요.' : '구글에 연결하지 못했어요.');
    }
  }

  function ensureAccountRow(): void {
    db.prepare('INSERT OR IGNORE INTO gcal_account (id, refresh_token, calendar_id, connected_at) VALUES (1, NULL, NULL, ?)').run(now().toISOString());
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - 60_000 > now().getTime()) return access.token;
    const a = account();
    if (!a?.refresh_token) throw new GcalError(401, '연결되지 않았어요');
    try {
      const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh_token });
      if (tok.scope && tok.scope !== a.scopes) setAccount({ scopes: tok.scope });
      access = { token: tok.access_token, expiresAt: now().getTime() + tok.expires_in * 1000 };
      return access.token;
    } catch (err) {
      if (err instanceof GcalError && err.message === 'invalid_grant') {
        // 사용자가 구글에서 권한을 취소했거나 토큰이 만료됐다 — 사람이 다시 연결해야 한다
        setAccount({ needs_reauth: 1, last_error: '구글 연결이 끊어졌어요. 다시 연결해 주세요.' });
      }
      throw err;
    }
  }

  // ── 구글 캘린더 API ──

  async function api(path: string, init: { method: string; body?: unknown } = { method: 'GET' }, retried = false): Promise<unknown> {
    const res = await doFetch(`${API}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 401 && !retried) {
      access = null; // 토큰이 만료됐을 수 있다: 새로 받아 한 번만 다시
      return api(path, init, true);
    }
    if (!res.ok) throw new GcalError(res.status, `구글 캘린더 응답 오류 (HTTP ${res.status})`);
    return res.status === 204 ? null : res.json();
  }

  async function ensureCalendar(): Promise<string> {
    const existing = account()?.calendar_id;
    if (existing) return existing;
    const created = (await api('/calendars', { method: 'POST', body: { summary: CALENDAR_NAME, timeZone: config!.timeZone } })) as { id: string };
    setAccount({ calendar_id: created.id });
    return created.id;
  }

  function projectName(id: string): string {
    const r = db.prepare('SELECT name FROM projects WHERE id = ? AND deleted = 0').get(id) as { name: string } | undefined;
    return r?.name ?? (db.prepare('SELECT name FROM projects WHERE id = ?').get(INBOX_ID) as { name: string } | undefined)?.name ?? '수신함';
  }

  async function syncTask(calendarId: string, task: Task): Promise<void> {
    const map = db.prepare('SELECT event_id, synced_version FROM gcal_events WHERE task_id = ?').get(task.id) as
      | { event_id: string; synced_version: string }
      | undefined;
    const event = task.deleted || (task.done && !map) ? null : eventFor(task, projectName(task.projectId), config!.timeZone);

    if (!event) {
      if (!map) return;
      try {
        await api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(map.event_id)}`, { method: 'DELETE' });
      } catch (err) {
        if (!(err instanceof GcalError && (err.status === 404 || err.status === 410))) throw err; // 이미 지워졌으면 그대로 둔다
      }
      db.prepare('DELETE FROM gcal_events WHERE task_id = ?').run(task.id);
      return;
    }
    if (map?.synced_version === task.version) return;

    const create = async () =>
      ((await api(`/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: event })) as { id: string }).id;
    let eventId: string;
    if (map) {
      try {
        await api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(map.event_id)}`, { method: 'PUT', body: event });
        eventId = map.event_id;
      } catch (err) {
        if (!(err instanceof GcalError && (err.status === 404 || err.status === 410))) throw err;
        eventId = await create(); // 사용자가 캘린더에서 일정을 지웠다: 다시 만든다
      }
    } else {
      eventId = await create();
    }
    db.prepare(
      'INSERT INTO gcal_events (task_id, event_id, synced_version) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET event_id = excluded.event_id, synced_version = excluded.synced_version',
    ).run(task.id, eventId, task.version);
  }

  async function runSync(): Promise<void> {
    if (!config || !connected()) return;
    const calendarId = await ensureCalendar();
    let skipped: string | null = null;
    for (;;) {
      const rows = db.prepare('SELECT * FROM tasks WHERE seq > ? ORDER BY seq LIMIT ?').all(cursor(), BATCH) as Record<string, any>[];
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          await syncTask(calendarId, rowToTask(row));
        } catch (err) {
          if (err instanceof GcalError && err.skippable) skipped = err.message; // 이 할 일만 건너뛰고 계속한다
          else throw err;
        }
        setMeta('gcal_seq', String(row.seq));
      }
    }
    setAccount({ last_sync_at: now().toISOString(), last_error: skipped });
  }

  function syncNow(): Promise<GcalStatus> {
    if (running) {
      again = true; // 도는 중에 변경이 더 생겼다: 끝나면 한 번 더
      return running.then(status);
    }
    running = (async () => {
      do {
        again = false;
        try {
          await runSync();
        } catch (err) {
          const a = account();
          if (a && !a.needs_reauth) setAccount({ last_error: err instanceof GcalError ? err.message : '구글 캘린더에 연결하지 못했어요. 잠시 뒤 다시 시도해요.' });
          again = false; // 실패하면 멈추고 타이머가 다시 시도한다
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running.then(status);
  }

  async function disconnect(): Promise<GcalStatus> {
    const a = account();
    if (a?.refresh_token && config) {
      // 구글 쪽 권한도 취소한다 (실패해도 이 서버에서는 연결을 끊는다)
      await doFetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.refresh_token }) }).catch(() => {});
    }
    // 캘린더·대응표·커서는 남겨 둔다: 다시 연결하면 중복 없이 이어서 동기화한다
    if (a) setAccount({ refresh_token: null, needs_reauth: 0, last_error: null, scopes: '', import_enabled: 0 });
    // 불러온 일정은 사용자의 개인 정보이니 연결을 끊으면 함께 지운다 (권한도 취소했다)
    clearImported(true);
    access = null;
    return status();
  }

  // ── 일정 불러오기 ──

  const importAvailable = (a = account()): boolean => !!a && a.scopes.split(' ').filter(Boolean).length > 0 && GCAL_READ_SCOPES.every((sc) => a.scopes.split(' ').includes(sc));
  const hexColor = (c: unknown): string | null => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);

  function importStatus(): GcalImportStatus {
    const a = account();
    const calendars = (db.prepare('SELECT * FROM gcal_import_calendars ORDER BY is_primary DESC, name').all() as Record<string, any>[]).map((c) => ({
      id: c.calendar_id as string,
      name: c.name as string,
      color: (c.color as string | null) ?? null,
      selected: c.selected === 1,
      primary: c.is_primary === 1,
    }));
    return {
      available: connected(a) && importAvailable(a),
      enabled: !!a && a.import_enabled === 1,
      calendars,
      lastImportAt: meta('gcal_import_at') || null,
      lastError: meta('gcal_import_error') || null,
    };
  }

  /** 불러온 일정을 지운다 (calendars 까지 지우려면 true) */
  function clearImported(includeCalendars: boolean): void {
    db.prepare('DELETE FROM gcal_import_events').run();
    if (includeCalendars) db.prepare('DELETE FROM gcal_import_calendars').run();
    setMeta('gcal_import_at', '');
    setMeta('gcal_import_error', '');
  }

  async function listCalendars(): Promise<{ id: string; name: string; color: string | null; primary: boolean }[]> {
    const out: { id: string; name: string; color: string | null; primary: boolean }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < IMPORT_MAX_PAGES; page++) {
      const q = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250', fields: 'nextPageToken,items(id,summary,summaryOverride,backgroundColor,primary,deleted)' });
      if (pageToken) q.set('pageToken', pageToken);
      const res = (await api(`/users/me/calendarList?${q}`)) as { items?: Record<string, any>[]; nextPageToken?: string };
      for (const c of res.items ?? []) {
        if (typeof c.id === 'string' && !c.deleted) out.push({ id: c.id, name: String(c.summaryOverride || c.summary || c.id).slice(0, 100), color: hexColor(c.backgroundColor), primary: c.primary === true });
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async function fetchEvents(calendarId: string): Promise<ImportRow[]> {
    const t = now().getTime();
    const rows: ImportRow[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < IMPORT_MAX_PAGES; page++) {
      const q = new URLSearchParams({
        singleEvents: 'true', // 반복 일정을 하나씩 펼쳐 받는다
        orderBy: 'startTime',
        timeMin: new Date(t - IMPORT_PAST_DAYS * 86_400_000).toISOString(),
        timeMax: new Date(t + IMPORT_FUTURE_DAYS * 86_400_000).toISOString(),
        maxResults: '250',
        // 제목·시각 외에는 요청하지 않는다 (설명·장소·참석자 정보는 가져오지 않는다)
        fields: 'nextPageToken,items(id,status,summary,start,end,extendedProperties/private/todoTaskId,attendees(self,responseStatus))',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = (await api(`/calendars/${encodeURIComponent(calendarId)}/events?${q}`)) as { items?: GoogleEventItem[]; nextPageToken?: string };
      for (const item of res.items ?? []) {
        const row = importRowFor(item, config!.timeZone);
        if (row) rows.push(row);
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  async function runImport(): Promise<void> {
    const a = account();
    if (!config || !connected(a) || a!.import_enabled !== 1 || !importAvailable(a)) return;

    // 1) 캘린더 목록: 이 앱이 만든 "할 일" 캘린더는 뺀다. 새 캘린더는 기본 캘린더만 선택된 채로 들어온다.
    const live = (await listCalendars()).filter((c) => c.id !== a!.calendar_id);
    transaction(db, () => {
      const known = new Set((db.prepare('SELECT calendar_id FROM gcal_import_calendars').all() as { calendar_id: string }[]).map((r) => r.calendar_id));
      for (const c of live) {
        if (known.has(c.id)) db.prepare('UPDATE gcal_import_calendars SET name = ?, color = ?, is_primary = ? WHERE calendar_id = ?').run(c.name, c.color, c.primary ? 1 : 0, c.id);
        else db.prepare('INSERT INTO gcal_import_calendars (calendar_id, name, color, selected, is_primary) VALUES (?, ?, ?, ?, ?)').run(c.id, c.name, c.color, c.primary ? 1 : 0, c.primary ? 1 : 0);
      }
      const liveIds = new Set(live.map((c) => c.id));
      for (const id of known) {
        if (!liveIds.has(id)) {
          db.prepare('DELETE FROM gcal_import_events WHERE calendar_id = ?').run(id);
          db.prepare('DELETE FROM gcal_import_calendars WHERE calendar_id = ?').run(id);
        }
      }
    });

    // 2) 선택된 캘린더마다 일정을 통째로 새로 받아 바꿔 넣는다 (실패하면 그 캘린더는 이전 사본을 그대로 둔다)
    let problem: string | null = null;
    const selected = db.prepare('SELECT calendar_id FROM gcal_import_calendars WHERE selected = 1').all() as { calendar_id: string }[];
    for (const { calendar_id } of selected) {
      try {
        const rows = await fetchEvents(calendar_id);
        transaction(db, () => {
          db.prepare('DELETE FROM gcal_import_events WHERE calendar_id = ?').run(calendar_id);
          for (const r of rows) {
            db.prepare('INSERT OR REPLACE INTO gcal_import_events (calendar_id, event_id, title, start_date, end_date, start_time, end_time, all_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
              calendar_id, r.eventId, r.title, r.startDate, r.endDate, r.startTime, r.endTime, r.allDay ? 1 : 0,
            );
          }
        });
      } catch (err) {
        if (err instanceof GcalError && err.message === 'invalid_grant') throw err; // 연결이 끊어졌다: 전체 실패
        if (err instanceof GcalError && (err.status === 404 || err.status === 410)) {
          // 그 사이 캘린더가 없어졌다
          db.prepare('DELETE FROM gcal_import_events WHERE calendar_id = ?').run(calendar_id);
          db.prepare('DELETE FROM gcal_import_calendars WHERE calendar_id = ?').run(calendar_id);
        } else {
          problem = err instanceof GcalError ? err.message : '일정을 불러오지 못한 캘린더가 있어요.';
        }
      }
    }
    // 선택이 풀린 캘린더의 일정은 지운다
    db.prepare('DELETE FROM gcal_import_events WHERE calendar_id NOT IN (SELECT calendar_id FROM gcal_import_calendars WHERE selected = 1)').run();
    setMeta('gcal_import_at', now().toISOString());
    setMeta('gcal_import_error', problem ?? '');
  }

  let importRunning: Promise<void> | null = null;
  let importAgain = false;
  function importNow(): Promise<GcalImportStatus> {
    if (importRunning) {
      importAgain = true; // 도는 중에 설정이 바뀌었다: 끝나면 한 번 더
      return importRunning.then(importStatus);
    }
    importRunning = (async () => {
      do {
        importAgain = false;
        try {
          await runImport();
        } catch (err) {
          setMeta('gcal_import_error', err instanceof GcalError && err.message !== 'invalid_grant' ? err.message : '구글 캘린더 일정을 불러오지 못했어요.');
          importAgain = false;
        }
      } while (importAgain);
    })().finally(() => {
      importRunning = null;
    });
    return importRunning.then(importStatus);
  }

  /** 불러오기 설정을 바꾼다. 켜기/끄기와 불러올 캘린더 선택. */
  function updateImportSettings(body: { enabled?: unknown; calendars?: unknown }): void {
    const a = account();
    if (!a || !connected(a)) throw new HttpError(409, 'gcal_not_connected', '먼저 구글 캘린더를 연결해 주세요');
    if (!importAvailable(a)) throw new HttpError(409, 'gcal_import_not_granted', '구글에서 일정 읽기 권한을 먼저 허용해 주세요');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'validation', 'enabled 는 true/false 여야 해요');
    if (body.calendars !== undefined) {
      const ids = body.calendars;
      const known = new Set((db.prepare('SELECT calendar_id FROM gcal_import_calendars').all() as { calendar_id: string }[]).map((r) => r.calendar_id));
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && known.has(x))) throw new HttpError(400, 'validation', '알 수 없는 캘린더가 있어요');
      transaction(db, () => {
        db.prepare('UPDATE gcal_import_calendars SET selected = 0').run();
        for (const id of ids as string[]) db.prepare('UPDATE gcal_import_calendars SET selected = 1 WHERE calendar_id = ?').run(id);
      });
    }
    if (body.enabled !== undefined) {
      setAccount({ import_enabled: body.enabled ? 1 : 0 });
      if (!body.enabled) clearImported(false); // 끄면 불러온 일정은 지운다
    }
  }

  function eventsBetween(from: string, to: string): ImportedEvent[] {
    const a = account();
    if (!a || a.import_enabled !== 1) return [];
    const rows = db
      .prepare(
        `SELECT e.*, c.name AS calendar_name, c.color AS calendar_color
         FROM gcal_import_events e JOIN gcal_import_calendars c ON c.calendar_id = e.calendar_id
         WHERE c.selected = 1 AND e.start_date <= ? AND e.end_date >= ?
         ORDER BY e.start_date, e.all_day DESC, e.start_time, e.title`,
      )
      .all(to, from) as Record<string, any>[];
    return rows.map((r) => ({
      id: `${r.calendar_id}:${r.event_id}`,
      calendarId: r.calendar_id,
      calendarName: r.calendar_name,
      color: r.calendar_color ?? null,
      title: r.title,
      startDate: r.start_date,
      endDate: r.end_date,
      startTime: r.start_time ?? null,
      endTime: r.end_time ?? null,
      allDay: r.all_day === 1,
    }));
  }

  function kick(): void {
    if (config && connected()) void syncNow();
  }

  const timer = config
    ? setInterval(kick, opts.retryMs ?? RETRY_MS)
    : null;
  timer?.unref();
  const importTimer = config ? setInterval(() => void importNow(), IMPORT_MS) : null;
  importTimer?.unref();

  // ── HTTP 라우트 ──

  const routes: AuthedRoute[] = [
    { method: 'GET', path: '/api/gcal/status', handle: (_req, res) => sendJson(res, 200, status()) },
    {
      method: 'POST',
      path: '/api/gcal/connect',
      async handle(req, res) {
        const body = await readJson<{ import?: unknown }>(req);
        sendJson(res, 200, startAuth({ import: body?.import === true }));
      },
    },
    { method: 'POST', path: '/api/gcal/sync', handle: async (_req, res) => sendJson(res, 200, await syncNow()) },
    { method: 'POST', path: '/api/gcal/disconnect', handle: async (_req, res) => sendJson(res, 200, await disconnect()) },
    { method: 'GET', path: '/api/gcal/import', handle: (_req, res) => sendJson(res, 200, importStatus()) },
    {
      method: 'POST',
      path: '/api/gcal/import/settings',
      async handle(req, res) {
        updateImportSettings(await readJson<{ enabled?: unknown; calendars?: unknown }>(req));
        sendJson(res, 200, await importNow()); // 바뀐 설정으로 바로 다시 불러온다
      },
    },
    { method: 'POST', path: '/api/gcal/import/refresh', handle: async (_req, res) => sendJson(res, 200, await importNow()) },
    {
      method: 'GET',
      path: '/api/gcal/events',
      handle(_req, res, url) {
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        if (!isValidDate(from) || !isValidDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_EVENTS_RANGE_DAYS) {
          throw new HttpError(400, 'validation', `from, to 는 올바른 날짜(YYYY-MM-DD)이고 ${MAX_EVENTS_RANGE_DAYS}일 이내여야 해요`);
        }
        sendJson(res, 200, { events: eventsBetween(from, to) });
      },
    },
  ];

  const publicRoutes: PublicRoute[] = [
    {
      method: 'GET',
      path: '/api/gcal/callback',
      async handle(_req: IncomingMessage, res: ServerResponse, url: URL) {
        const ok = await handleCallback(url);
        if (ok) {
          kick();
          if (account()?.import_enabled === 1) void importNow(); // 읽기 권한을 허용했다면 바로 불러온다
        }
        // 돌아갈 곳은 설정 화면 하나뿐이다 (주소를 요청에서 받지 않는다)
        res.writeHead(302, { Location: `${config?.appUrl ?? ''}/#/settings`, 'Cache-Control': 'no-store' });
        res.end();
      },
    },
  ];

  return {
    status,
    startAuth,
    syncNow,
    disconnect,
    importStatus,
    importNow,
    eventsBetween,
    kick,
    close() {
      if (timer) clearInterval(timer);
      if (importTimer) clearInterval(importTimer);
    },
    routes,
    publicRoutes,
  };
}
