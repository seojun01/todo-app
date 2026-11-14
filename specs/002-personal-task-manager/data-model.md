# Data Model: 개인용 할 일 관리 앱

**Feature**: `002-personal-task-manager` | **Date**: 2026-11-12 | **근거**: [spec.md](./spec.md) Key Entities, [research.md](./research.md) R6·R9~R13

## 공통 타입

| 타입 | 형식 | 예 |
|---|---|---|
| `Uuid` | UUID v4 문자열 (클라이언트가 `crypto.randomUUID()`로 생성) | `"3f2c…"` |
| `DeviceId` | `Uuid`. **클라이언트가 첫 실행 때 생성**하고 페어링 때 서버에 등록 | |
| `CalendarDate` | `YYYY-MM-DD`, 시간대 없음, 유효한 그레고리력 날짜 | `"2026-11-20"` |
| `ClockTime` | `HH:MM` 24시간, 시간대 없음 ("그 기기의 현지 시각"으로 해석) | `"15:00"` |
| `Instant` | UTC ISO-8601, 밀리초 포함 | `"2026-11-12T12:34:56.789Z"` |
| `Hlc` | `<wallMs 15자리 0채움>-<counter 6자리 0채움>-<deviceId>` (문자열 비교 순서 = 시간 순서) | |
| `TimeZoneId` | IANA 시간대 이름 | `"Asia/Seoul"` |
| `ProjectId` | `Uuid` 또는 고정 문자열 `"inbox"` | |

---

## Task (할 일)

| 필드 | 타입 | 규칙 |
|---|---|---|
| `id` | Uuid | 필수, 불변 |
| `title` | string | 앞뒤 공백 제거 후 **1~200자(코드 포인트 기준)** (FR-006). 출력은 항상 텍스트로 넣고 HTML로 해석하지 않음 |
| `dueDate` | CalendarDate \| null | 선택. 없으면 `dueTime`, `recurrence`, `reminders`도 없어야 함 |
| `dueTime` | ClockTime \| null | 선택. `dueDate`가 있을 때만 |
| `projectId` | ProjectId | 필수, 기본 `"inbox"` |
| `priority` | 1 \| 2 \| 3 \| 4 | 기본 4 (1=긴급, 2=높음, 3=보통, 4=없음) (FR-016) |
| `recurrence` | Recurrence \| null | 선택. `dueDate`가 있을 때만 (FR-017) |
| `reminders` | ReminderKind[] | 중복 없는 집합, 기본 빈 배열. `dueDate`가 있을 때만 |
| `done` | boolean | 기본 `false` |
| `createdAt` | Instant | 생성 때 한 번 정하고 불변 |
| `deleted` | boolean | 툼스톤. `true`이면 모든 화면, 집계, 내보내기에서 제외 |
| `version` | Hlc | 레코드를 바꿀 때마다 새로 발급. LWW 비교 키 |
| `updatedBy` | DeviceId | 마지막으로 바꾼 기기 (진단용) |

**교차 규칙** (`shared/task.ts`가 검증):
- `dueDate == null` ⇒ `dueTime == null` 이고 `recurrence == null` 이고 `reminders == []`. 화면에서 기한을 지우면 이 셋도 함께 지워진다.
- `dueTime == null`이면 `reminders`는 `{"day","1d"}`의 부분집합, `dueTime != null`이면 `{"at","10m","30m","1h","1d"}`의 부분집합.
- 완료된 반복 할 일: `recurrence`가 있으면 완료 시 `done`은 `false`로 남고 `dueDate`만 다음 회차로 바뀐다. `endDate` 때문에 다음 회차가 없을 때만 `done=true`가 된다.
- 기한 시각이 바뀔 때의 알림 정리(`remapReminders`): 시각을 **추가**하면 `day` → `at`으로 바꾸고(`1d` 유지), 시각을 **없애면** `at`·`10m`·`30m`·`1h`를 제거한다(`1d` 유지). 제거된 개수는 사용자에게 안내한다.
- 반복을 지정하거나 규칙을 바꾸면 `dueDate`를 `firstOccurrenceOnOrAfter(rule, dueDate)`(원래 기한 이후, 당일 포함)로 맞춘다. 사용자가 `dueDate`를 `endDate` 뒤로 옮기면 거부한다.

### 상태 전이

```text
              add                     toggle                    edit(any field)
(없음) ──────────────▶ 활성(done=false) ◀────────────▶ 활성(done=true)  ──┐ 각 전이마다 version 새로 발급
                         │   ▲  │                                         │
        complete(반복)    │   │  └─ 다음 회차로 dueDate 이동(done=false 유지)  │
                delete   │   │ undo (같은 기기, 5초 이상 표시)              │
                         ▼   │                                             │
                     툼스톤(deleted=true) ◀─────────── delete ──────────────┘
```

- undo는 툼스톤을 `deleted=false`로 되돌리며 새 `version`을 붙인다. 반복 할 일의 완료 undo는 이전 `dueDate`와 `reminders`를 그대로 복원한다(되돌릴 값은 메모리에 보관).
- 정렬: [research R12](./research.md)의 규칙(`shared/sort.ts`).

## Recurrence (반복 규칙, Task에 내장)

```text
{ unit: "day" | "week" | "month" | "year",
  interval: 1..99,                      // N
  weekdays?: number[],                  // unit == "week"일 때 필수, 0(일)~6(토), 중복 없는 비어 있지 않은 집합
  dayOfMonth?: 1..31,                   // unit == "month" | "year"일 때 필수 (원래 일정의 날)
  month?: 1..12,                        // unit == "year"일 때 필수
  endDate?: CalendarDate }              // 선택. 현재 dueDate보다 빠르면 거부 (회차가 넘어가도 항상 endDate 이하)
```

- `unit`별로 위 필수 필드만 허용한다. 처음 지정할 때 `weekdays`/`dayOfMonth`/`month`의 기본값은 `dueDate`에서 가져온다(예: 11/20 → 매월 20일).
- 다음 회차 계산은 [research R10](./research.md)의 `nextOccurrence`.

## ReminderKind

`"at"`(정시), `"10m"`, `"30m"`, `"1h"`, `"1d"`(하루 전), `"day"`(당일, 시각 없는 할 일 전용). 실제 발화 시각은 `shared/reminders.ts`의 `reminderInstant(task, kind, settings, tz)`로 계산한다(시각이 없는 할 일은 `defaultReminderTime` 사용).

## Project (프로젝트)

| 필드 | 타입 | 규칙 |
|---|---|---|
| `id` | Uuid | 필수, 불변. `"inbox"`는 저장하지 않는 가상 프로젝트라 이 레코드로는 존재할 수 없음 |
| `name` | string | 앞뒤 공백 제거 후 **1~50자(코드 포인트 기준)**. 중복 허용 |
| `color` | `"red"\|"orange"\|"yellow"\|"green"\|"teal"\|"blue"\|"purple"\|"gray"` | 팔레트 8색 중 하나, 기본 `"gray"` |
| `createdAt` | Instant | 불변. 목록은 이 순서로 표시 |
| `deleted` | boolean | 툼스톤 |
| `version`, `updatedBy` | Hlc, DeviceId | Task와 동일 |

- 삭제하면 (a) 프로젝트 툼스톤, (b) 삭제 시점에 로컬에서 보이는 소속 할 일의 툼스톤을 **한 번에** 만든다.
- `effectiveProjectId(task, projects)`: `projectId`가 `"inbox"`가 아니고 해당 프로젝트가 없거나 `deleted`이면 `"inbox"`를 돌려준다(읽을 때 계산, 쓰기 없음).

## Settings (공통 설정, 레코드 1개)

| 필드 | 타입 | 규칙 |
|---|---|---|
| `id` | `"settings"` 고정 | |
| `defaultReminderTime` | ClockTime | 기본 `"09:00"` (FR-023) |
| `version`, `updatedBy` | Hlc, DeviceId | |

레코드가 없으면 기본값을 쓴다. 기기별 알림 켜기/끄기는 동기화되지 않고 서버의 기기 정보(`push_subscriptions.enabled`)에 둔다.

---

## 서버 저장소 (SQLite, `PRAGMA user_version = 1`)

```text
tasks
  id TEXT PRIMARY KEY
  title TEXT NOT NULL
  due_date TEXT                      -- NULL 가능
  due_time TEXT
  project_id TEXT NOT NULL
  priority INTEGER NOT NULL          -- 1..4
  recurrence TEXT                    -- JSON 또는 NULL
  reminders TEXT NOT NULL            -- JSON 배열
  done INTEGER NOT NULL              -- 0/1
  created_at TEXT NOT NULL
  deleted INTEGER NOT NULL
  version TEXT NOT NULL
  updated_by TEXT NOT NULL
  seq INTEGER NOT NULL UNIQUE        -- 전 테이블 공용 카운터
  armed_at TEXT NOT NULL             -- 서버 내부: 기한/시각/알림/완료/반복 진행이 바뀐 시각 (알림 스케줄러용)
  INDEX (seq), INDEX (due_date)

projects
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL, version TEXT NOT NULL, updated_by TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE

settings
  id TEXT PRIMARY KEY CHECK (id = 'settings'), default_reminder_time TEXT NOT NULL,
  version TEXT NOT NULL, updated_by TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE

devices
  id TEXT PRIMARY KEY                -- 클라이언트가 만든 DeviceId
  name TEXT NOT NULL                 -- 1~50자
  token_hash TEXT NOT NULL UNIQUE    -- SHA-256(hex)
  created_at TEXT NOT NULL
  last_seen_at TEXT
  revoked_at TEXT                    -- NULL이면 접근 허용

push_subscriptions                   -- 기기당 최대 1개
  device_id TEXT PRIMARY KEY REFERENCES devices(id)
  endpoint TEXT NOT NULL             -- https, 허용 호스트만
  p256dh TEXT NOT NULL               -- 구독자 공개키 (base64url)
  auth TEXT NOT NULL                 -- 구독자 auth 비밀 (base64url)
  timezone TEXT NOT NULL             -- IANA
  enabled INTEGER NOT NULL           -- 0/1, 기기별 알림 켜기/끄기
  updated_at TEXT NOT NULL

reminder_log                         -- 중복 전송 방지
  task_id TEXT NOT NULL, due_key TEXT NOT NULL, kind TEXT NOT NULL, device_id TEXT NOT NULL,
  sent_at TEXT NOT NULL, PRIMARY KEY (task_id, due_key, kind, device_id)

pairing_codes
  code_hash TEXT PRIMARY KEY, device_name TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT

server_meta
  key TEXT PRIMARY KEY, value TEXT NOT NULL    -- 'last_seq'
```

- push로 받은 레코드는 트랜잭션 하나 안에서 `merge`로 비교하고, 이길 때만 새 `seq`(`last_seq + 1`)를 매긴다. `armed_at`은 알림에 영향을 주는 필드(`due_date`, `due_time`, `reminders`, `done`, `recurrence`)가 실제로 바뀌었을 때만 갱신한다.
- 서버는 모든 검증을 다시 수행한다(클라이언트를 신뢰하지 않음): 제목 길이, 날짜·시각 형식, 교차 규칙, 우선순위 범위, 반복 규칙의 필수 필드, 프로젝트 이름 길이와 색상 팔레트.
- `reminder_log`는 완료·삭제된 지 오래된 할 일의 행을 7일 지나면 정리한다(스케줄러 tick에서 가볍게).
- 장기 보관 정책: 툼스톤은 이번 범위에서 정리하지 않는다(YAGNI).
- 마이그레이션은 `server/src/migrations.ts`에 순서대로 두고 시작할 때 `user_version`과 비교해 적용한다.

---

## 클라이언트 저장소 (IndexedDB `todo`, DB 버전 1)

| object store | key | 내용 |
|---|---|---|
| `tasks` | `id` | Task 전체 + `dirty: 0 \| 1` |
| `projects` | `id` | Project 전체 + `dirty: 0 \| 1` |
| `meta` | 문자열 | `deviceId`, `cursor`, `hlc`, `lastSyncAt`, `settings`(Settings 레코드 + `dirty`), `notifyEnabled`(이 기기의 알림 상태 캐시) |

- 인덱스: `tasks.byDue`(`dueDate`, 없는 레코드는 자동 제외), `tasks.byProject`(`projectId`), `tasks.byDirty`(`dirty`), `projects.byDirty`.
- **쓰기 원칙** (FR-011): 화면이 "성공"을 표시하는 시점은 IndexedDB 트랜잭션의 `complete` 이후다. 실패하면 오류를 알리고 입력은 폼에 남긴다. 프로젝트 삭제처럼 여러 레코드를 바꾸는 작업은 **한 트랜잭션**으로 처리한다.
- push 성공 시 `dirty` 해제는 보낸 시점과 `version`이 같을 때만 한다. pull의 merge와 cursor 저장은 같은 트랜잭션이다.
- **삭제/완료 실행 취소** 상태(되돌릴 레코드 스냅샷, 타이머)는 메모리에만 두며 가장 최근 1건만 되돌릴 수 있다.

## 파생 값 (저장하지 않음)

| 이름 | 계산 |
|---|---|
| Day 요약(`total`, `remaining`, `allDone`) | `byDue`로 그 날짜의 활성 할 일을 모아 계산. `allDone = total > 0 && remaining == 0`. 완료된 일반 할 일도 `total`에 포함 |
| 오늘 화면 | `dueDate <= 오늘`인 미완료 할 일. `dueDate < 오늘`은 "기한 지남" 구분 |
| 예정 화면 | `오늘 < dueDate <= 오늘+7n`, 날짜별 그룹 |
| 프로젝트 화면 | `effectiveProjectId == 프로젝트`인 활성 할 일, 완료됨 영역은 `done`만 |
| 동기화 상태 | `synced`(연결됨 + dirty 0), `pending`(연결됨 + dirty ≥ 1), `offline`(요청 실패 + SSE 끊김, dirty 수 표시), `unauthorized`(401) |

## 내보내기 형식 (FR-036)

```json
{
  "format": "todo-export",
  "schemaVersion": 1,
  "exportedAt": "2026-11-12T12:00:00.000Z",
  "projects": [
    { "id": "…", "name": "업무", "color": "blue", "createdAt": "2026-11-01T00:00:00.000Z" }
  ],
  "tasks": [
    {
      "id": "…", "title": "공과금 납부", "dueDate": "2026-11-25", "dueTime": "09:00",
      "projectId": "…", "priority": 2,
      "recurrence": { "unit": "month", "interval": 1, "dayOfMonth": 25 },
      "reminders": ["1d", "at"], "done": false, "createdAt": "2026-11-12T11:00:00.000Z"
    }
  ],
  "settings": { "defaultReminderTime": "09:00" }
}
```

툼스톤과 내부 필드(`version`, `updatedBy`, `dirty`, 서버의 `armed_at`)는 내보내지 않는다. 고아 할 일의 `projectId`는 `effectiveProjectId`로 정리해 `"inbox"`로 내보낸다.
