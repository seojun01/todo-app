---

description: "개인용 할 일 관리 앱(Todoist 스타일) 구현 작업 목록"
---

# Tasks: 개인용 할 일 관리 앱 (Todoist 스타일)

**Input**: `specs/002-personal-task-manager/` 의 plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Prerequisites**: plan.md, spec.md (모두 있음)

**Tests**: 헌법 III(Test-First, NON-NEGOTIABLE)에 따라 **테스트 작업을 포함한다.** 각 단계에서 테스트 작업을 먼저 쓰고, 구현 전에 **실패하는 것을 확인**한 뒤 구현한다. 모든 사용자 스토리에 수용 기준을 검증하는 자동화 테스트가 최소 1개 있다.

**Organization**: 사용자 스토리별로 묶었다. 각 스토리는 독립적으로 구현하고 검증할 수 있다.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 병렬 가능 (서로 다른 파일이고 아직 끝나지 않은 작업에 의존하지 않음)
- **[Story]**: 소속된 사용자 스토리 (US1~US9)
- 모든 설명에 정확한 파일 경로를 적었다

## Path Conventions

plan.md의 구조를 따른다: `shared/`, `server/src`, `server/tests`, `client/src`, `client/tests`, `e2e/`, `deploy/`. 공유 로직의 테스트는 `shared/tests/`에 둔다. 실행 명령은 모두 저장소 루트에서 한다.

**여러 스토리가 같은 파일을 고친다**: `client/src/tasks.ts`, `client/src/views.ts`, `client/src/ui/task-editor.ts`, `client/src/ui/task-list.ts`, `client/src/ui/settings.ts`, `client/src/sw.ts`, `client/src/main.ts`, `server/src/main.ts`, `server/src/admin-cli.ts`, `e2e/a11y.spec.ts`. 이런 작업은 [P]로 표시하지 않았고, 스토리 순서대로 진행한다.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 프로젝트 초기화

- [X] T001 plan.md의 "Source Code" 트리대로 빈 디렉터리를 만든다: `shared/`, `shared/tests/`, `server/src/`, `server/tests/unit/`, `server/tests/contract/`, `server/tests/helpers/`, `client/public/icons/`, `client/src/store/`, `client/src/sync/`, `client/src/ui/`, `client/tests/unit/`, `e2e/`, `deploy/`, `scripts/`
- [X] T002 `package.json`을 만든다. **런타임 `dependencies`는 비워 둔다**(헌법 V). `engines.node`는 `>=24`. `devDependencies`는 typescript(>=5.8, `erasableSyntaxOnly` 때문), esbuild, @playwright/test, @axe-core/playwright, fake-indexeddb, @types/node 뿐이다. 스크립트: `dev`(`npm run build` 후 `TODO_DEV=1 node server/src/main.ts`), `build`(T004), `test`(`node --test` 로 `shared/tests`, `server/tests`, `client/tests` 실행), `test:e2e`(`playwright test`), `typecheck`(`tsc --noEmit`), `lint`(`npm run typecheck && node scripts/lint.mjs`, 헌법의 "린트/포맷 검사 통과" 게이트). `bin`에 `todo-admin` → `server/src/admin-cli.ts` 를 등록한다. `npm install` 과 `npx playwright install webkit chromium` 을 실행한 뒤, `node -e "import('node:sqlite').then(m=>console.log(typeof m.DatabaseSync))"` 가 `function` 을 출력하는지 확인한다(research R3). 출력되지 않으면 멈추고 사용자에게 `better-sqlite3` 추가 여부를 묻는다
- [X] T003 [P] `tsconfig.json`을 만든다: `strict`, `erasableSyntaxOnly`(Node의 type stripping 호환), `allowImportingTsExtensions`, `noEmit`, target/lib ES2022 + DOM + WebWorker, `include`는 `shared`, `server`, `client`, `e2e`, `scripts`. 서버와 공유 파일의 import는 `.ts` 확장자를 붙여 쓴다
- [X] T004 [P] 빌드 스크립트 `scripts/build.mjs`를 만든다. esbuild로 `client/src/main.ts` 와 `client/src/sw.ts` 를 각각 번들해 `client/dist/` 에 내고(sw는 `client/dist/sw.js`), `client/public/` 을 그대로 복사한다. 번들 형식은 브라우저 ES module, sourcemap 포함. 같은 폴더에 `scripts/lint.mjs`도 만든다. 이 스크립트는 (a) `shared/`, `server/src/`, `client/src/` 에서 `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` 사용이 있으면 실패하고, (b) `package.json` 의 `dependencies` 가 비어 있지 않으면 실패하고, (c) 위 세 폴더의 `.ts` 가 상대 경로나 `node:` 가 아닌 패키지를 import 하면 실패한다(런타임 의존성 0 유지, 헌법 V). 포맷터는 두지 않는다(plan 의 Constitution Check 참고)
- [X] T005 [P] `playwright.config.ts`를 만든다: projects는 `webkit`, `chromium`. `webServer`는 `npm run build` 후 `TODO_DEV=1 TODO_DB=<임시 파일> TODO_VAPID_FILE=<임시 파일> PORT=8080` 으로 서버를 띄운다. `use.baseURL`은 `http://localhost:8080`, `serviceWorkers: 'allow'`. 기기 2대 시뮬레이션은 테스트 안에서 브라우저 컨텍스트를 두 개 만들어서 한다
- [X] T006 [P] `.gitignore`를 만든다: `node_modules/`, `client/dist/`, `*.db`, `*.db-wal`, `*.db-shm`, `vapid.json`, `test-results/`, `playwright-report/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 모든 사용자 스토리가 쓰는 공유 로직, 로컬 저장소, 앱 껍데기

**⚠️ CRITICAL**: 이 단계가 끝나기 전에는 어떤 사용자 스토리도 시작하지 않는다

### Tests (먼저 작성하고, 실패를 확인한다)

- [X] T007 [P] `shared/tests/task.test.ts`: data-model.md 의 검증 규칙을 모두 확인한다. **Task**: `title` 은 "앞뒤 공백 제거 후 1~200자(코드 포인트 기준)"(빈 문자열·공백뿐·201자 거부, 이모지 포함 200 코드 포인트 통과, 앞뒤 공백 제거된 값 반환), `dueDate`/`recurrence`의 날짜는 "`YYYY-MM-DD`, 시간대 없음, 유효한 그레고리력 날짜"(`2026-02-30`, `2026-13-01`, `2026-1-5`, `2026-11-20T00:00` 거부, `2028-02-29` 통과), `dueTime` 은 `HH:MM` 24시간(`24:00`, `9:00`, `09:60` 거부), `priority` 는 1|2|3|4 이고 기본 4(5·0·1.5 거부). **교차 규칙**: `dueDate == null` 이면 `dueTime`·`recurrence`가 null 이고 `reminders`가 빈 배열이어야 함. `dueTime == null` 이면 `reminders`는 `{"day","1d"}`의 부분집합, `dueTime != null` 이면 `{"at","10m","30m","1h","1d"}`의 부분집합, 중복 없는 집합. **Recurrence**: `unit` 은 day|week|month|year, `interval` 은 1..99, `weekdays` 는 week 에서 필수이며 "0(일)~6(토), 중복 없는 비어 있지 않은 집합", `dayOfMonth` 는 month·year 에서 필수(1..31), `month` 는 year 에서 필수(1..12), `endDate` 는 "현재 dueDate보다 빠르면 거부", unit 에 맞지 않는 필드는 거부. **Project**: `name` 은 "앞뒤 공백 제거 후 1~50자(코드 포인트 기준)", `color` 는 red|orange|yellow|green|teal|blue|purple|gray 중 하나(기본 gray), `id` 가 `"inbox"` 인 프로젝트 레코드 거부. **Settings**: `defaultReminderTime` 은 `HH:MM`(기본 `09:00`). `effectiveProjectId(task, projects)` 는 프로젝트가 없거나 `deleted` 이면 `"inbox"`
- [X] T008 [P] `shared/tests/hlc.test.ts`: Hlc 형식은 `<wallMs 15자리 0채움>-<counter 6자리 0채움>-<deviceId>` 이다. 문자열 비교 순서가 발급 순서와 같고, 같은 밀리초에 여러 번 발급하면 counter 가 증가한다. 시계가 뒤로 가도 값이 줄지 않는다. 원격 값을 받으면(`receive`) 로컬 값이 그보다 커진다. 서로 다른 deviceId 로 발급한 값은 절대 같지 않다
- [X] T009 [P] `shared/tests/merge.test.ts`: `merge(local, incoming)` 는 `local == null || incoming.version > local.version` 이면 incoming, 아니면 local 이다. version 이 같으면 local 을 유지한다. task·project·settings 레코드에 모두 적용된다. 같은 변경 집합을 **무작위 순서로 여러 번 섞어서** 적용해도 항상 같은 최종 상태가 되는지 속성 기반으로 검증한다(교환·결합·멱등, SC-009). 삭제 대 수정은 version 이 큰 쪽이 이긴다
- [X] T010 [P] `shared/tests/calendar.test.ts`: 월 격자는 일요일에 시작하고 항상 7의 배수 칸이다. 윤년 2월(2028-02)과 평년 2월(2026-02), 31일이 있는 달과 없는 달, 1일이 일요일/토요일인 달을 확인한다. `addDays`, `addMonths`(1월 31일 + 1개월 = 2월 말일), `toDateString(Date)` 는 시간대와 무관하게 로컬 날짜를 쓴다. `diffDays(a, b)` 가 서머타임과 무관하게 정수 일수를 준다
- [X] T011 [P] `shared/tests/sort.test.ts`: 목록 정렬은 우선순위 오름차순(1이 먼저) → `dueTime` 이 있는 것이 이른 순, `dueTime` 이 없는 것은 그 뒤 → `createdAt` → `id` 순이다(FR-012). "기한 지남" 구분은 `dueDate` 오름차순을 앞에 붙인 뒤 같은 규칙을 따른다. 정렬은 안정적이고 입력 배열을 바꾸지 않는다
- [X] T012 [P] `client/tests/unit/store.test.ts` (fake-indexeddb 사용): 저장 Promise 는 IndexedDB 트랜잭션의 `complete` 이벤트 뒤에 resolve 되고 abort 되면 reject 된다. `tasks`·`projects`·`meta` object store 와 인덱스 `tasks.byDue`, `tasks.byProject`, `tasks.byDirty`, `projects.byDirty` 가 있다. `dirty` 는 **0 또는 1 정수** 로 저장된다. `dueDate` 가 없는 할 일은 `byDue` 조회에 나오지 않는다. 여러 레코드를 한 트랜잭션으로 쓰다 실패하면 아무것도 저장되지 않는다. `meta` 의 `deviceId`, `cursor`, `hlc`, `lastSyncAt`, `settings`, `notifyEnabled` 읽기와 쓰기를 확인한다

### Implementation

- [X] T013 [P] `shared/task.ts`: `Task`, `Project`, `Settings`, `Recurrence`, `ReminderKind` 타입과 `validateTask`, `validateProject`, `validateSettings`, `effectiveProjectId` 를 구현한다. 규칙은 T007 에 인용한 data-model.md 그대로이며 서버와 클라이언트가 함께 쓴다. 검증은 필드별 오류(`field`, `rule`)를 돌려준다
- [X] T014 [P] `shared/hlc.ts`: 하이브리드 논리 시계(`create(deviceId, now)`, `next()`, `receive(remote)`, 직렬화·복원). 시간 소스는 주입할 수 있게 한다
- [X] T015 [P] `shared/merge.ts`: `merge(local, incoming)` 를 T009 의 규칙대로 구현한다
- [X] T016 [P] `shared/calendar.ts`: 월 격자 계산, `addDays`, `addMonths`, `diffDays`, 날짜 문자열 변환과 파싱. 시각 부분 없이 `YYYY-MM-DD` 문자열만 다룬다
- [X] T017 [P] `shared/sort.ts`: `compareTasks(a, b)` 와 `sortOverdue(tasks)` 를 T011 의 규칙대로 구현한다
- [X] T018 `client/src/store/db.ts`: IndexedDB `todo` 를 버전 1로 연다. object store `tasks`(keyPath `id`; 인덱스 `byDue`=`dueDate`, `byProject`=`projectId`, `byDirty`=`dirty`), `projects`(keyPath `id`; 인덱스 `byDirty`), `meta`(키는 문자열). 업그레이드 경로를 `onupgradeneeded` 에 버전별로 둔다. 트랜잭션이 `complete` 될 때만 resolve 하는 `tx()` 헬퍼를 제공한다
- [X] T019 [P] `client/src/store/tasks.ts`: `put`, `putMany`, `get`, `listByDueRange(from, to)`, `listByProject(projectId)`, `listDirty()`, `listAll()`. **`dirty` 는 `0 | 1` 정수로 저장한다**(boolean 은 IndexedDB 키가 될 수 없다)
- [X] T020 [P] `client/src/store/projects.ts`: `put`, `putMany`, `get`, `listAll()`(`createdAt` 오름차순), `listDirty()`
- [X] T021 [P] `client/src/store/meta.ts`: `deviceId`(첫 실행 때 `crypto.randomUUID()` 로 생성), `cursor`, `hlc`, `lastSyncAt`, `settings`(Settings 레코드 + `dirty`), `notifyEnabled` 읽기와 쓰기
- [X] T022 `server/src/main.ts` 최소 골격: `node:http` 서버(기본 `127.0.0.1:8080`, 환경 변수 `HOST`, `PORT`)가 `client/dist/` 의 정적 파일을 제공하고(경로 탈출 방지, SPA 폴백으로 `index.html`) `GET /api/health` 가 `200 {"ok":true}` 를 준다. 모든 `/api/*` 응답에 `Cache-Control: no-store` 를 붙이고, 요청 본문은 1 MiB 를 넘으면 `413` 으로 거부한다. 다른 `/api` 경로는 `404 {"error":"not_found"}`
- [X] T023 [P] `client/public/index.html`, `client/public/manifest.webmanifest`(이름, `display: standalone`, `lang: ko`, 아이콘 참조), `client/public/icons/`(192, 512, apple-touch-icon 180 PNG). 아이콘 PNG 는 `scripts/make-icons.mjs` 가 `node:zlib` 로 직접 인코딩해 생성한다(단색 배경 + 흰 체크 모양, 외부 패키지 없음). 생성된 파일을 커밋한다. 외부 CDN, 폰트, 스크립트는 쓰지 않는다. `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<html lang="ko">`
- [X] T024 [P] `client/src/ui/styles.css`: CSS 변수로 색상 토큰(본문 대비 4.5:1 이상, 라이트와 다크 모두), 눈에 띄는 `:focus-visible` 윤곽선, `prefers-reduced-motion` 존중, 폭 320px 부터 가로 스크롤이 없는 반응형 레이아웃(`min-width: 0`, 긴 텍스트 `overflow-wrap: anywhere`), 좁은 화면에서는 하단 탭/햄버거, 넓은 화면에서는 사이드바
- [X] T025 `client/src/main.ts` 부트스트랩: 첫 실행에 `meta.deviceId` 를 만들고 HLC 를 복원한다. 해시 라우터(`#/today`, `#/upcoming`, `#/project/<id>`(`inbox` 포함), `#/calendar`, `#/settings`, `#/pair`)를 만들고 화면 모듈을 `mount(route)` 로 연결하는 틀을 둔다. 기본 경로는 `#/today`. 화면은 아직 비어 있다
- [X] T026 `client/src/ui/nav.ts`: 내비게이션(오늘, 예정, 수신함, 캘린더, 설정 + 프로젝트 목록 자리)을 만든다. 현재 화면을 `aria-current="page"` 로 표시하고, 키보드로 모두 도달할 수 있으며, 폭 320px 에서도 넘치지 않는다

**Checkpoint**: `npm test`(T007~T012)가 통과하고 `npm run build && npm run dev` 로 내비게이션이 있는 빈 앱 껍데기가 열린다

---

## Phase 3: User Story 1 - 오늘 할 일을 보고 관리하기 (Priority: P1) 🎯 MVP

**Goal**: 오늘 화면에서 오늘 할 일과 기한 지남을 보고 할 일을 추가·완료·수정·삭제한다. 기한이 없는 할 일은 수신함에 쌓인다. 앱을 닫았다 열어도 남아 있다

**Independent Test**: 오늘 화면에서 할 일 2개를 추가하고 하나를 완료한 뒤 하나의 제목과 기한을 고치고, 앱을 다시 열어 결과가 그대로인지 확인한다. 기한이 없는 할 일은 수신함에서 보이는지 확인한다 (spec US1)

### Tests for User Story 1 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T027 [P] [US1] `client/tests/unit/tasks.test.ts`: `addTask({title, dueDate?, projectId?})` 는 제목을 trim 해 저장하고 `done=false`, `deleted=false`, `priority=4`, `projectId="inbox"`(기본), `reminders=[]`, `dirty=1`, 새 `version`, `createdAt`(UTC ISO 밀리초 포함), 클라이언트 UUID `id` 를 가진 레코드를 만든다. 빈 제목, 공백뿐, 201자는 저장하지 않고 이유가 담긴 오류를 돌려준다(FR-006). `editTask(id, changes)` 는 제목·기한을 바꾸고 `dueDate` 를 `null` 로 바꾸면 `dueTime`·`recurrence`·`reminders` 도 함께 지워지며, 검증 실패 시 레코드가 바뀌지 않는다. `toggleDone(id)` 는 `done` 만 뒤집고 `version` 을 새로 발급한다. `deleteTask(id)` 는 툼스톤을 만들고, `undoDelete()` 는 가장 최근 삭제 1건만 원래 모든 속성(제목, 기한, 프로젝트, 우선순위, 완료 상태)으로 복원하며 `version` 을 새로 발급한다. 복원된 레코드는 `version`·`updatedBy` 를 제외한 모든 필드가 삭제 전과 깊은 비교로 같다(이후 스토리에서 추가되는 `dueTime`·`recurrence`·`reminders` 포함, FR-009). `moveOverdueToToday(today)` 는 `dueDate < today` 인 미완료 할 일만 `dueDate = today` 로 바꾼다(시각·반복·알림 유지). 저장소 쓰기가 실패하면 성공을 돌려주지 않는다(FR-011)
- [X] T028 [P] [US1] `e2e/us1-today.spec.ts`: spec US1 수용 시나리오 1~8 을 그대로 자동화한다. 첫 화면이 오늘 화면(오늘 날짜 표시, 빈 상태 안내), "장보기" 추가 → 기한 오늘·수신함, 완료 → "완료됨" 영역으로 이동하고 해제하면 복귀(기한이 지난 할 일을 완료하면 오늘 화면에서 사라지고 수신함 화면의 "완료됨"에서 보임), 어제 기한 할 일이 "기한 지남" 맨 위에 기한 날짜와 함께 보이고 자동으로 이동하지 않음, "모두 오늘로", 제목·기한 수정과 취소, "기한 없음"으로 바꾸면 오늘 화면에서 사라지고 수신함에 보임, 삭제 후 "실행 취소"가 최소 5초 보이고 복원, 새로고침 후에도 유지. `page.clock` 으로 자정을 넘기면 오늘/기한 지남 구분이 다시 계산되는지도 확인한다
- [X] T029 [P] [US1] `e2e/a11y.spec.ts`: `@axe-core/playwright` 로 오늘 화면과 수신함의 WCAG 2.1 AA 위반이 0건인지 검사한다. 마우스 없이 키보드만으로 할 일 추가·완료·수정·삭제가 되는지, 폭 320px 에서 `document.documentElement.scrollWidth <= clientWidth` 인지 확인한다. 이후 스토리에서 화면이 늘 때마다 이 파일에 시나리오를 추가한다

### Implementation for User Story 1

- [X] T030 [US1] `client/src/tasks.ts`: `addTask`, `editTask`, `toggleDone`, `deleteTask`, `undoDelete`, `moveOverdueToToday` 를 구현한다. 검증은 `shared/task.ts`, 버전 발급은 HLC, 저장은 `client/src/store/tasks.ts` 를 쓴다. 저장 트랜잭션이 `complete` 되기 전에는 성공을 돌려주지 않는다. 되돌리기 스냅샷은 메모리에만 둔다(가장 최근 삭제 1건)
- [X] T031 [P] [US1] `client/src/views.ts`: `todayView(today)`(`dueDate == today` 인 미완료, `dueDate < today` 인 미완료는 `overdue` 구분, `dueDate == today` 인 완료 항목만 `completed`(기한이 지난 완료 항목은 오늘 화면에 나타나지 않음, spec US1-3); `shared/sort.ts` 로 정렬)와 `projectTasks(projectId)`(수신함 포함, 기한 유무와 관계없이 미완료 + 완료됨 분리)를 구현한다. 삭제된 할 일은 항상 제외한다
- [X] T032 [P] [US1] `client/src/ui/undo-toast.ts`: `role="status"` 의 "실행 취소" 안내를 만든다. 최소 5초 표시하고 다른 삭제가 있으면 새 안내로 교체하며, 포커스를 빼앗지 않지만 Tab 으로 도달할 수 있다
- [X] T033 [P] [US1] `client/src/ui/task-editor.ts`: 추가·수정에 쓰는 시트(대화상자, 포커스 가두기, Esc 로 취소). 이번 단계에서는 제목(`<input maxlength="200">`)과 기한 날짜(`<input type="date">` + "기한 없음" 버튼)만 있다. 검증 오류는 입력 아래 `role="alert"` 로 안내하고 입력값은 지우지 않는다. 이후 스토리가 같은 시트에 프로젝트·우선순위·반복·시각·알림을 더한다
- [X] T034 [US1] `client/src/ui/task-list.ts`: 할 일 목록 컴포넌트. 한 줄에 완료 토글(`role="checkbox"`, `aria-checked`, 제목을 이름으로 사용), 제목, 기한 날짜(지난 날짜는 강조), "수정"·"삭제" 버튼. 완료 항목은 체크 표시와 취소선으로 구분하고(색상만으로 구분하지 않음), 접힌 "완료됨" 영역, 빈 상태 안내, 빠른 추가 입력(`<label>` 연결)을 제공한다. 제목은 `textContent` 로만 넣고 긴 제목도 줄바꿈된다. 목록이 다시 그려져도 포커스가 유지된다. 추가·완료·삭제는 두 번 이하의 조작으로 가능해야 한다(FR-010)
- [X] T035 [US1] `client/src/ui/today.ts`: 오늘 화면. "기한 지남" 구분(기한 날짜 표시, "모두 오늘로" 버튼)과 오늘 목록과 "완료됨"을 `task-list.ts` 로 그린다. 빠른 추가의 기본 기한은 오늘이다(FR-006)
- [X] T036 [US1] `client/src/ui/project-view.ts`: 수신함 화면(`#/project/inbox`). 기한 유무와 관계없이 수신함의 모든 할 일과 "완료됨" 영역을 보여 주고, 빠른 추가의 기본 기한은 없음이다
- [X] T037 [US1] `client/src/main.ts`: 오늘 화면과 수신함을 라우터에 연결한다. 변경 후 화면을 다시 그리고, 다음 자정에 맞춘 타이머로 "오늘" 기준을 갱신한다(앱을 켜 둔 상태 포함). 삭제/실행 취소를 토스트와 연결한다
- [X] T038 [US1] `client/src/main.ts`, `client/src/ui/task-list.ts`: 저장 실패(예: 저장 공간 부족)가 나면 성공처럼 보이지 않게 오류를 안내하고 입력 내용을 보존한다(FR-011). 시작할 때 `navigator.storage.persist()` 를 요청한다(research R1)

**Checkpoint**: T027~T029 가 통과한다. 이 시점에 단독 사용 가능한 로컬 앱(MVP)이 완성된다

---

## Phase 4: User Story 2 - 맥북·아이폰·아이패드 간 동기화 (Priority: P2)

**Goal**: 홈서버를 기준 저장소로 삼아 할 일·프로젝트·설정의 변경을 기기 간에 주고받는다. 오프라인에서도 계속 쓰고, 재연결하면 자동으로 맞춘다

**Independent Test**: 맥북에서 할 일을 추가해 아이폰에 나타나는지 확인하고, 아이폰을 오프라인으로 두고 완료 처리한 뒤 다시 연결해 다른 기기에 반영되는지 확인한다 (spec US2)

### Tests for User Story 2 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T039 [P] [US2] `server/tests/unit/migrations.test.ts`: 빈 DB 에 마이그레이션을 적용하면 `PRAGMA user_version = 1` 이 되고 data-model.md 의 `tasks`, `projects`, `settings`, `devices`, `push_subscriptions`, `reminder_log`, `pairing_codes`, `server_meta` 테이블과 `tasks(seq)`, `tasks(due_date)` 인덱스가 생긴다. 세 레코드 테이블의 `seq` 는 UNIQUE 이고 `settings.id` 는 `'settings'` 만 허용한다. 이미 최신인 DB 에 다시 실행해도 아무 일도 없다(멱등)
- [X] T040 [P] [US2] `server/tests/unit/auth.test.ts`: 페어링 코드는 혼동하기 쉬운 문자(0/O, 1/I/L)를 뺀 대문자와 숫자 8자리이고 DB 에는 해시만 저장된다. 발급 후 10분이 지나면 만료되고 한 번 쓰면 다시 쓸 수 없다. 세션 토큰은 256비트 랜덤이고 DB 에는 SHA-256(hex) 해시만 저장된다. 실패가 1분에 5회를 넘으면 `rate_limited` 가 된다. 해제된 기기의 토큰은 인증에 실패한다. `deviceId` 는 UUID 여야 하고 이미 등록된 값이면 거부한다
- [X] T041 [P] [US2] `server/tests/contract/auth-pairing.contract.test.ts` (실제 HTTP 서버 + 임시 SQLite): contracts/sync-api.md 계약 테스트 1~5. `/api/pair` 응답의 `Set-Cookie` 가 `HttpOnly; SameSite=Strict; Path=/api; Max-Age=315360000` 을 포함하고 운영 모드에서는 `Secure` 도 포함하는지(`TODO_DEV=1` 에서만 제외) 확인한다
- [X] T042 [P] [US2] `server/tests/contract/changes.contract.test.ts`: 계약 테스트 6~10. task·project·settings 를 push 한 뒤 pull(`since=0`)하면 `seq` 순서로 나오고, version 이 작은 레코드는 `ignored`, 같은 push 를 두 번 보내면 두 번째는 `applied=0`, 검증 실패(제목 0자·201자·공백뿐, 날짜 `2026-02-30`, `dueTime` 만 있고 `dueDate` 없음, 반복인데 `dueDate` 없음, 우선순위 5, 프로젝트 이름 51자, 알 수 없는 색상, 주 단위 반복인데 `weekdays` 없음, 잘못된 reminders 조합)는 400 이며 전체가 롤백된다. `limit` 페이지 나누기에서 레코드가 빠지거나 중복되지 않는다. 또한 서버 내부 `armed_at` 이 `due_date`·`due_time`·`reminders`·`done`·`recurrence` 가 실제로 바뀌었을 때만 갱신되고 제목·우선순위·프로젝트만 바뀌면 유지되는지 확인한다
- [X] T043 [P] [US2] `server/tests/contract/events.contract.test.ts`: 계약 테스트 11. SSE 연결 중에 다른 클라이언트가 push 하면 1초 안에 `cursor` 이벤트가 오고, 연결 직후 현재 cursor 이벤트가 오며, 기기를 해제하면 스트림이 닫힌다
- [X] T044 [P] [US2] `server/tests/unit/admin-cli.test.ts`: contracts/admin-cli.md 의 `pair`(이름이 비었거나 50자를 넘으면 종료 코드 2), `devices`(표 출력), `revoke`(없는 ID 이면 종료 코드 1)를 임시 DB 로 검증한다
- [X] T045 [P] [US2] `client/tests/unit/sync-engine.test.ts` (fake-indexeddb, 가짜 서버): `dirty` 레코드만 push 한다(task·project·settings 모두). push 가 성공해도 보낸 시점과 `version` 이 달라졌다면 `dirty` 를 유지한다. pull 로 받은 레코드의 merge 와 cursor 저장이 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않는다. 응답을 받지 못한 push 를 그대로 다시 보내도 결과가 같다. `hasMore=true` 이면 이어서 pull 한다. 서버가 준 cursor 가 저장된 cursor 보다 작으면 모든 로컬 레코드를 `dirty=1` 로 바꾸고 cursor 를 0 으로 되돌린 뒤 push 와 pull 을 차례로 한다. 반복 할 일을 두 기기가 같은 회차를 같은 날 각각 완료한 레코드를 병합하면 레코드가 하나만 남고 다음 기한이 한 회차만 넘어가 있다(예: 매일 반복, 월요일 기한을 둘 다 월요일에 완료 → 화요일). 서로 다른 날 완료한 경우에는 `version` 이 더 큰(나중) 완료 레코드가 이긴다. 프로젝트가 삭제된 뒤 도착한 할 일은 `effectiveProjectId` 로 수신함에 표시된다. 상태는 `synced`/`pending`/`offline`/`unauthorized` 로 올바르게 바뀐다
- [X] T046 [P] [US2] `e2e/us2-sync.spec.ts`: 브라우저 컨텍스트 두 개를 기기 2대로 쓴다. quickstart V4(한 기기에서 추가 → 5초 안에 다른 기기에 표시, 새로고침 없이), V5(`context.setOffline(true)` 에서 추가·완료·수정·삭제가 즉시 반영되고 "대기 중인 변경" 표시, 복귀 후 30초 안에 반영되고 "동기화됨"), V6(두 기기 오프라인에서 같은 할 일을 다르게 수정 → 나중 수정으로 수렴, 중복·유실 없음, 반복 실행), 삭제 대 나중 수정, 같은 날 두 기기에서 반복 할 일을 같은 회차로 완료(다음 기한이 한 회차만 넘어감), 등록하기 전에 만든 로컬 할 일이 등록 후 서버와 다른 기기로 올라감, 새로 등록한 기기가 기존 데이터를 모두 내려받는지, 등록하지 않은 컨텍스트가 데이터를 못 읽는지, 기기를 해제하면 그 기기가 "등록 해제됨" 상태가 되는지 확인한다

### Implementation for User Story 2 — Server

- [X] T047 [US2] `server/src/db.ts`: `node:sqlite` 로 `TODO_DB`(기본 `/var/lib/todo/todo.db`)를 열고 WAL 모드, 외래 키 사용. `transaction(fn)` 헬퍼를 제공한다
- [X] T048 [US2] `server/src/migrations.ts`: `PRAGMA user_version` 으로 순서대로 적용하는 마이그레이션 목록과 버전 1 스키마를 data-model.md "서버 저장소" 그대로 구현한다(알림 스케줄러용 `armed_at`, `push_subscriptions`, `reminder_log` 포함). 시작할 때 자동 적용한다
- [X] T049 [US2] `server/src/auth.ts`: 페어링(코드 검증, 클라이언트가 보낸 `deviceId` 로 기기 등록, 토큰 발급), 쿠키 `todo_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=315360000`(`TODO_DEV=1` 일 때만 `Secure` 제외), SHA-256 해시 저장, 인증 미들웨어(실패 시 `401 {"error":"unauthorized"}`, 성공 시 `last_seen_at` 갱신), 쓰기 요청의 `X-Todo-Client: 1` 검사(없으면 403), 페어링 실패 1분 5회 제한(`429 rate_limited`)
- [X] T050 [US2] `server/src/sync.ts`: `POST /api/changes`(1~500개, 각 레코드를 `shared/task.ts` 로 종류별 다시 검증, 전체가 한 트랜잭션, `shared/merge.ts` 로 비교해 이길 때만 `server_meta.last_seq + 1` 을 `seq` 로 부여, 알림에 영향을 주는 필드가 바뀌면 `armed_at` 을 현재 시각으로 갱신, `{applied, ignored, cursor}` 응답)와 `GET /api/changes?since&limit`(`since` 는 0 이상 정수, `limit` 기본값과 최대값 모두 1000, 세 테이블을 `seq` 오름차순으로 합쳐 `{type, record}` 로 반환, 툼스톤 포함, `hasMore`)를 contracts/sync-api.md 대로 구현한다
- [X] T051 [US2] `server/src/events.ts`: `GET /api/events` SSE. 연결 직후와 seq 가 늘 때마다 `event: cursor` 를 보내고 25초마다 `: ping` 을 보낸다. 기기가 해제되면 스트림을 닫는다. `sync.ts` 가 반영 후 브로드캐스트를 호출하게 연결한다
- [X] T052 [US2] `server/src/main.ts`: `/api/pair`, `/api/changes`, `/api/events`, `/api/devices/me`(`{deviceId, deviceName, createdAt, push:{subscribed, enabled, timezone}}`; 푸시 정보는 구독이 없으면 `subscribed:false`) 라우팅을 연결하고 `/api/health` 와 `/api/pair` 를 제외한 모든 `/api` 에 인증을 적용한다. 오류 응답은 `{"error","message","details"?}` 형식이다
- [X] T053 [US2] `server/src/admin-cli.ts`: `todo-admin pair --name <이름>`(출력 `페어링 코드: K7Q2-M9XD (10분간 유효, 1회용)`), `devices`, `revoke <deviceId>` 를 contracts/admin-cli.md 의 출력과 종료 코드대로 구현한다. DB 에 직접 접근하고 `TODO_DB` 를 따른다

### Implementation for User Story 2 — Client

- [X] T054 [US2] `client/src/sync/engine.ts`: push(`dirty` 레코드를 500개씩; task·project·settings 를 `{type, record}` 로), pull(cursor 부터 `hasMore` 동안 반복), merge 와 cursor 저장을 한 트랜잭션으로 처리, HLC `receive`, 보낸 시점과 version 이 같을 때만 `dirty` 해제, 서버 복원 감지 규칙(contracts/sync-api.md "서버 복원 감지")을 구현한다. 모든 쓰기 요청에 `X-Todo-Client: 1` 을 붙이고 `credentials: "same-origin"` 을 쓴다
- [X] T055 [P] [US2] `client/src/sync/status.ts`: 상태 `synced`/`pending`/`offline`/`unauthorized`, 대기 중인 변경 수, `lastSyncAt` 을 data-model.md 의 표대로 계산하고 구독 가능한 이벤트로 낸다
- [X] T056 [US2] `client/src/sync/events.ts`: `EventSource('/api/events')` 로 `cursor` 이벤트를 받으면 저장된 cursor 보다 클 때 pull 한다. 보조 장치로 `visibilitychange`, `online` 이벤트, 앱 시작 시에 pull 하고 SSE 가 끊긴 동안은 30초 간격으로 pull 한다. 401 이면 `unauthorized` 로 바꾸고 재시도를 멈춘다
- [X] T057 [US2] `client/src/store/db.ts`: 쓰기 트랜잭션이 `complete` 된 뒤 "변경됨" 이벤트를 내보내게 하고, `client/src/sync/engine.ts` 가 이를 구독해 짧은 지연(300ms) 후 push 하게 연결한다. 오프라인이어도 쓰기는 막히지 않는다
- [X] T058 [P] [US2] `client/src/ui/pair.ts`: 등록 화면(페어링 코드 입력 → `POST /api/pair` 에 `{code, deviceId}`). 틀렸거나 만료된 코드와 `429` 를 한국어로 안내하고, 성공하면 등록 전에 만든 로컬 레코드를 모두 `dirty=1` 로 표시해 push 하고(LWW 로 병합) 오늘 화면으로 가서 첫 pull 로 기존 데이터를 모두 내려받는다. `unauthorized` 상태가 되면 "이 기기의 등록이 해제되었어요. 다시 등록하세요" 와 함께 이 화면을 보여 준다(로컬 데이터는 지우지 않는다)
- [X] T059 [P] [US2] `client/src/ui/sync-status.ts`: 화면 상단에 상태 표시("동기화됨" / "동기화 대기 중 N개" / "홈서버에 연결 안 됨")와 마지막 동기화 시각을 보여 준다. `role="status"` 와 `aria-live="polite"` 를 쓰고 색깔만으로 구분하지 않는다
- [X] T060 [P] [US2] `client/src/ui/settings.ts`: 설정 화면 틀. 이 기기 이름·등록 시각(`GET /api/devices/me`)과 "지금 동기화" 버튼(FR-031)을 둔다. 이후 스토리가 알림·내보내기 항목을 더한다
- [X] T061 [US2] `client/src/sw.ts`: Service Worker. 설치 시 앱 셸(`index.html`, 번들 JS, CSS, manifest, 아이콘)을 버전이 붙은 캐시에 넣고, 내비게이션 요청은 캐시된 `index.html` 로 응답해 오프라인에서도 앱이 열린다. `/api/*` 는 절대 캐시하지 않는다. 새 버전이 활성화되면 오래된 캐시를 지운다. `client/src/main.ts` 에서 등록한다
- [X] T062 [US2] `client/src/main.ts`: 시작할 때 항상 오늘 화면으로 열고(등록 전에도 로컬로 모든 기능을 쓸 수 있음, FR-032), 등록되지 않은 기기는 동기화 상태 표시줄에 "홈서버에 등록되지 않음 — 등록하기" 안내와 `#/pair` 링크를 보이며, 동기화 엔진과 SSE 를 시작하며, 상태 표시와 설정 화면을 연결한다. `e2e/a11y.spec.ts` 에 등록 화면과 설정 화면의 axe 검사를 추가한다

**Checkpoint**: T039~T046 이 통과한다. 이 시점에 세 기기가 홈서버를 통해 서로 동기화된다

---

## Phase 5: User Story 3 - 프로젝트로 분류하기 (Priority: P2)

**Goal**: 프로젝트를 만들어 할 일을 나눠 담고 프로젝트별로 본다

**Independent Test**: 프로젝트 2개를 만들어 각각에 할 일을 추가하고, 프로젝트 화면에서 자기 할 일만 보이는지, 다른 프로젝트로 옮기면 이동하는지 확인한다 (spec US3)

### Tests for User Story 3 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T063 [P] [US3] `client/tests/unit/projects.test.ts`: `createProject({name, color?})` 는 이름을 "앞뒤 공백 제거 후 1~50자(코드 포인트 기준)" 로, 색상을 red|orange|yellow|green|teal|blue|purple|gray 중 하나(기본 gray)로 검증하고 이름 중복을 허용한다. `updateProject` 로 이름·색상을 바꾼다. `deleteProject(id)` 는 프로젝트 툼스톤과 소속 활성 할 일의 툼스톤을 **한 트랜잭션** 으로 만들고, 삭제될 할 일 개수를 미리 알려 주는 `countTasks(id)` 가 있다. `"inbox"` 는 이름 변경·삭제를 거부한다. `moveTask(taskId, projectId)` 는 프로젝트만 바꾸고 `version` 을 새로 발급한다. 삭제된 프로젝트를 가리키는 할 일은 `effectiveProjectId` 로 `"inbox"` 에 나타난다
- [X] T064 [P] [US3] `e2e/us3-projects.spec.ts`: spec US3 수용 시나리오 1~7. "업무" 프로젝트 생성(이름·색상), 프로젝트 화면에서 추가한 할 일은 그 프로젝트 소속이고 기한 유무와 관계없이 보이며 오늘/예정 화면에서는 프로젝트 이름이 함께 표시됨, 수신함 → 업무 이동, 이름·색상 변경이 모든 표시에 반영, 할 일 3개가 있는 프로젝트 삭제 시 "할 일 3개도 함께 삭제됩니다" 확인을 거침, 수신함 이름 변경·삭제 불가, "완료됨" 영역에서 완료 해제. 다른 기기가 오프라인으로 삭제된 프로젝트에 할 일을 추가하면 동기화 후 수신함에 남는지도 확인한다

### Implementation for User Story 3

- [X] T065 [US3] `client/src/projects.ts`: `createProject`, `updateProject`, `deleteProject`, `countTasks`, `moveTask` 를 구현한다. 모든 쓰기는 한 트랜잭션으로 처리하고 `complete` 뒤에만 성공을 돌려준다
- [X] T066 [US3] `client/src/views.ts`: `projectTasks(projectId)` 를 `effectiveProjectId` 기준으로 바꾸고(삭제된 프로젝트의 고아 할 일은 수신함에 나타남), 프로젝트 목록 조회(만든 순서)와 프로젝트별 미완료 개수를 추가한다
- [X] T067 [P] [US3] `client/src/ui/projects.ts`: 프로젝트 생성·수정 시트(이름 `maxlength="50"`, 색상 팔레트 8색은 색 이름 텍스트도 함께 제공)와 삭제 확인 대화상자("할 일 N개도 함께 삭제됩니다")를 만든다
- [X] T068 [US3] `client/src/ui/project-view.ts`: 수신함 외 프로젝트 화면(`#/project/<id>`)을 지원한다. 헤더에 프로젝트 이름·색상과 수정·삭제 버튼, 빠른 추가의 기본 프로젝트는 현재 프로젝트다. 없는 프로젝트 ID 는 수신함으로 안내한다
- [X] T069 [US3] `client/src/ui/nav.ts`: 프로젝트 목록(색상 점 + 이름 + 미완료 개수)과 "프로젝트 추가" 항목을 내비게이션에 넣는다
- [X] T070 [US3] `client/src/ui/task-editor.ts`: 프로젝트 선택(`<select>`, 수신함 포함)을 더한다. 값 변경은 `moveTask` 가 아니라 저장 시 한 번에 반영한다
- [X] T071 [US3] `client/src/ui/task-list.ts`: 오늘·예정 같은 여러 프로젝트가 섞이는 화면에서는 각 항목에 소속 프로젝트(색상 + 이름)를 표시하는 옵션을 더한다(FR-015)

**Checkpoint**: T063~T064 가 통과한다

---

## Phase 6: User Story 4 - 우선순위 정하기 (Priority: P2)

**Goal**: 할 일마다 우선순위를 정하고 중요한 일이 위쪽에 보이게 한다

**Independent Test**: 같은 날 할 일 3개에 서로 다른 우선순위를 주고 오늘 화면에서 우선순위 순으로 정렬되며 색상 외의 방법으로도 구분되는지 확인한다 (spec US4)

### Tests for User Story 4 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T072 [P] [US4] `client/tests/unit/tasks.test.ts` (priority 부분): `addTask`/`editTask` 가 우선순위를 1(긴급)~4(없음)로만 받고 기본값은 4 이며, 범위 밖 값은 저장하지 않고 이유를 돌려준다. 우선순위만 바꿔도 `version` 이 새로 발급된다
- [X] T073 [P] [US4] `e2e/us4-priority.spec.ts`: spec US4 수용 시나리오 1~4. 추가·수정 시트에서 1~4 를 고르고(미선택은 4), 오늘 화면에서 우선순위 4/1/2 인 할 일이 1, 2, 4 순으로 보이며, 우선순위가 색상과 함께 텍스트 또는 아이콘으로 표시되고, 우선순위가 같으면 기한 시각이 이른 것 → 시각 없는 것 → 먼저 만든 것 순임을 확인한다. 화면 낭독기용 이름(`aria-label`)에 "우선순위 1 긴급" 이 포함되는지도 확인한다

### Implementation for User Story 4

- [X] T074 [US4] `client/src/ui/task-editor.ts`: 우선순위 선택(라디오 그룹 "1 긴급 / 2 높음 / 3 보통 / 4 없음")을 더한다
- [X] T075 [US4] `client/src/ui/task-list.ts`: 우선순위 1~3 항목에 색상 + 텍스트("P1" 등) + 아이콘 배지를 표시하고 `aria-label` 에 "우선순위 N" 을 포함한다(우선순위 4 는 표시 없음). 목록은 `shared/sort.ts` 로 정렬한다
- [X] T076 [P] [US4] `client/src/ui/styles.css`: 우선순위 색상 토큰을 라이트·다크 모두에서 대비 4.5:1 이상으로 정의한다

**Checkpoint**: T072~T073 이 통과한다

---

## Phase 7: User Story 5 - 예정 화면으로 앞으로의 일 미리 보기 (Priority: P2)

**Goal**: 내일부터 7일치 할 일을 날짜별로 묶어 보고 날짜별로 추가·이동한다

**Independent Test**: 앞으로 며칠에 걸쳐 할 일을 만들고, 예정 화면에서 날짜별로 정확히 묶이는지, 날짜 머리글에서 바로 추가되는지, 날짜를 바꾸면 다른 묶음으로 이동하는지 확인한다 (spec US5)

### Tests for User Story 5 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T077 [P] [US5] `client/tests/unit/upcoming.test.ts`: `upcomingView(today, weeks)` 는 `today < dueDate <= today + 7*weeks 일` 인 미완료 할 일을 날짜별로 묶고(요일 포함), 할 일이 없는 날도 그룹으로 포함하며, 기한이 지난 할 일과 기한 없는 할 일을 제외하고, 각 그룹을 `shared/sort.ts` 로 정렬한다. `weeks` 를 늘리면 이어서 다음 7일이 포함된다
- [X] T078 [P] [US5] `e2e/us5-upcoming.spec.ts`: spec US5 수용 시나리오 1~5. 내일부터 7일치가 요일 포함 날짜별로 묶이고 빈 날도 머리글이 보임, 날짜 머리글의 "추가"로 만든 할 일의 기한이 그 날짜, 기한을 바꾸면 묶음 사이 이동(7일 밖이면 사라짐), "더 보기"로 다음 7일, 기한 지난·기한 없는 할 일은 나타나지 않음

### Implementation for User Story 5

- [X] T079 [US5] `client/src/views.ts`: `upcomingView(today, weeks)` 를 구현한다. `tasks.byDue` 범위 조회를 쓴다
- [X] T080 [US5] `client/src/ui/upcoming.ts`: 예정 화면. 날짜(요일) 머리글별 그룹, 각 머리글의 "추가"(기한이 그 날짜인 빠른 추가), 아래쪽 "더 보기" 버튼, 프로젝트 표시 옵션을 켠 `task-list.ts` 를 쓴다
- [X] T081 [US5] `client/src/main.ts`: `#/upcoming` 라우트를 연결하고 내비게이션에 "예정" 을 활성화한다. `e2e/a11y.spec.ts` 에 예정 화면의 axe 검사와 키보드 시나리오를 추가한다

**Checkpoint**: T077~T078 이 통과한다

---

## Phase 8: User Story 6 - 반복 일정 (Priority: P3)

**Goal**: 되풀이되는 할 일을 한 번만 만들고, 완료할 때마다 다음 기한으로 자동으로 넘어간다

**Independent Test**: "매주 월요일" 반복 할 일을 만들어 완료하고 기한이 다음 월요일로 넘어가며 미완료로 남는지 확인한다. 월말과 기한이 지난 상태에서 완료하는 경우도 확인한다 (spec US6)

### Tests for User Story 6 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T082 [P] [US6] `shared/tests/recurrence.test.ts`: `nextOccurrence(rule, dueDate, completedOn)` 는 `ref = max(dueDate, completedOn)` 이후(초과)의 첫 일정일을 돌려준다(FR-018). **일**: N일마다, 기한이 사흘 전인 매일 반복을 오늘 완료하면 내일. **주**: "매주 월요일", 월·수·금, 2주마다 월·수(기준 주는 `dueDate` 가 속한 일요일 시작 주), 주의 경계. **월**: "매월 31일" 은 31일이 없는 달에서 그 달 마지막 날, 그다음 달에는 다시 31일(원래 `dayOfMonth` 에서 재계산), 2주기·12개월마다. **년**: 평년의 2/29 → 2/28, 윤년에는 2/29. **종료**: `endDate` 를 넘기는 결과는 `null`. `firstOccurrenceOnOrAfter(rule, dueDate)`: 기한이 이미 규칙에 맞으면 그대로, 수요일 기한에 "매주 월요일"이면 다음 월요일, 2주마다 월요일(기준 주는 기한이 속한 주)이면 기한 이상인 첫 해당 날짜, "매월 31일"·"매년 2월 29일" 규칙 정렬, 결과는 항상 `dueDate` 이상. 속성 기반: 결과는 항상 `ref` 보다 뒤이고 규칙에 맞는 날이며 같은 입력에 같은 출력. 시간대와 무관하다. data-model.md 의 Recurrence 필드 규칙을 위반한 입력은 `validateTask` 단계에서 거부된 상태로 가정한다
- [X] T083 [P] [US6] `client/tests/unit/recurring-tasks.test.ts`: `toggleDone` 이 반복 할 일에 대해 `done=false` 를 유지한 채 `dueDate` 만 `nextOccurrence` 로 바꾸고 `dueTime`·`reminders` 는 유지하며 새 `version` 을 발급한다. 완료 직후 `undoDelete` 와 같은 방식의 `undoComplete()` 가 이전 `dueDate` 를 복원한다. `endDate` 때문에 다음 회차가 없으면 `done=true` 가 된다. 반복을 해제하면 현재 기한을 가진 일반 할 일이 된다. 반복 할 일을 삭제하면 툼스톤이 되고 undo 로 반복 규칙까지 복원된다. 기한이 없는 할 일에 반복을 지정하면 거부된다. 반복을 지정하거나 규칙을 바꾸면 기한이 `firstOccurrenceOnOrAfter` 결과로 맞춰진다. 기한을 `endDate` 뒤로 옮기려 하면 거부되고 레코드가 바뀌지 않는다. 사용자가 기한을 직접 바꾸면 그 날짜가 새 기준이 된다(FR-021)
- [X] T084 [P] [US6] `e2e/us6-recurrence.spec.ts`: spec US6 수용 시나리오 1~9. 수요일 기한에 "매주 월요일" 지정 시 기한이 다음 월요일로 맞춰지고(월요일 기한이면 그대로) 반복 표시가 나타남, 완료하면 미완료로 남은 채 다음 월요일로 넘어가 오늘 화면에서 사라지며 실행 취소로 복귀, 연체 후 완료, 매월 31일, 종료 날짜, 기한 시각 유지, 반복 해제, 삭제, 기한 없는 할 일에 반복 지정 시 기한을 먼저 정하도록 안내

### Implementation for User Story 6

- [X] T085 [US6] `shared/recurrence.ts`: `nextOccurrence`, `firstOccurrenceOnOrAfter(rule, dueDate)`, `defaultRuleFor(dueDate, unit)`(처음 지정할 때 `weekdays`·`dayOfMonth`·`month` 기본값을 `dueDate` 에서 가져옴)를 research R10 의 알고리즘대로 구현한다. 날짜 계산은 `shared/calendar.ts` 만 쓴다
- [X] T086 [US6] `client/src/tasks.ts`: `toggleDone` 이 `recurrence` 가 있는 할 일을 완료할 때 다음 회차로 넘기게 하고(`done` 은 `false` 유지, 마지막 회차면 `true`), `undoComplete()` 를 추가한다. 반복 규칙 설정·해제와 기한 직접 변경을 `editTask` 에서 처리한다(규칙을 지정하거나 바꾸면 기한을 `firstOccurrenceOnOrAfter` 로 맞추고, 기한을 `endDate` 뒤로 옮기면 거부)
- [X] T087 [US6] `client/src/ui/task-editor.ts`: 반복 섹션을 더한다(없음 / N일마다 / N주마다 + 요일 체크박스 / N개월마다 / N년마다, 간격 1~99, 종료 날짜 선택). 기한이 없으면 반복 섹션을 비활성화하고 "먼저 기한을 정하세요" 안내를 보인다. 기한을 종료 날짜 뒤로 옮기려 하면 "종료 날짜를 먼저 바꾸세요" 로 안내한다. 완료 직후 "실행 취소" 토스트를 `undo-toast.ts` 로 보인다
- [X] T088 [US6] `client/src/ui/task-list.ts`: 반복 할 일에 반복 아이콘 + "반복" 텍스트를 표시하고 `aria-label` 에 "반복" 을 포함한다

**Checkpoint**: T082~T084 가 통과한다

---

## Phase 9: User Story 7 - 알림 (Priority: P3)

**Goal**: 할 일에 시각과 알림을 정하면 그 시각에 기기가 알려 준다. 앱이 닫혀 있어도 울리고, 알림 문구에는 할 일 내용이 없다

**Independent Test**: 2분 뒤 시각의 할 일에 "정시" 알림을 켜고 그 시각에 기기가 알려 주는지, 알림을 눌러 해당 할 일로 이동하는지, 완료한 할 일은 알리지 않는지 확인한다 (spec US7)

### Tests for User Story 7 ⚠️ 먼저 작성하고 실패를 확인한다

> **구현 메모 (2026-11-13)**: 아래 US7 작업은 모두 구현했다. 파일 이름이 계획과 다른 곳이 있다 — 클라이언트의 알림 로직은 `client/src/notify.ts`(T105 의 `push.ts`)와 서비스 워커용 `client/src/sw-notify.ts`로 나눴고, 테스트는 `client/tests/unit/notify.test.ts`·`sw-notify.test.ts`(T095 의 `push.test.ts`), E2E 는 `e2e/us7-reminders.spec.ts`·`us7-notify.spec.ts`·`push-sw.spec.ts`(T096)다. 서비스 워커에 push 를 직접 전달하는 CDP 와 알림 권한이 필요한 `push-sw.spec.ts` 는 전체 크로미엄 채널 전용 프로젝트(`chromium-push`)로 돈다. 페이로드는 T093 에 따라 `{"v":1,"taskId":"…"}` 뿐이다(research R14 의 `tag` 는 서비스 워커가 `task-<id>` 로 만든다).

- [X] T089 [P] [US7] `shared/tests/tz.test.ts`: `wallTimeToInstant(date, time, tz)` 가 `Asia/Seoul`(서머타임 없음)과 `America/New_York` 에서 올바른 UTC 순간을 준다. 봄에 건너뛴 시각은 건너뛴 직후 시각으로, 가을에 두 번 있는 시각은 이른 쪽으로 정한다. 잘못된 시간대는 오류. 같은 입력에 같은 출력
- [X] T090 [P] [US7] `shared/tests/reminders.test.ts`: `reminderInstant(task, kind, settings, tz)` 가 `at`=기한 시각, `10m`/`30m`/`1h` = 그만큼 앞, `1d`=하루 전 같은 시각(시각이 없으면 하루 전 `defaultReminderTime`), `day`=당일 `defaultReminderTime` 을 돌려준다. `shouldFire(...)` 는 `armedAt < 발화 시각 <= now` 이고 `now - 발화 시각 <= 15분` 일 때만 참이다. 이미 지난 시각(`armedAt` 이후 설정했는데 발화 시각이 그보다 앞)은 거짓이다. `remapReminders(reminders, hadTime, hasTime)` 는 시각을 추가하면 `day` → `at`(`1d` 유지), 시각을 없애면 `at`·`10m`·`30m`·`1h` 를 제거(`1d` 유지)하고 제거된 개수를 함께 돌려준다
- [X] T091 [P] [US7] `server/tests/helpers/fake-push-service.ts`: 테스트용 로컬 HTTP 가짜 푸시 서비스. 구독자 P-256 키쌍과 auth 비밀을 만들어 `subscription`(endpoint = 로컬 URL)을 돌려주고, 받은 요청의 `Authorization: vapid …`·`TTL`·`Content-Encoding: aes128gcm` 를 검사하고 RFC 8291 로 **복호화**해 평문 페이로드를 기록한다. 임의 상태 코드(404/410/429/500)를 돌려주는 모드도 있다. 서버는 `TODO_PUSH_ALLOW_HOSTS` 로 이 호스트를 허용한다
- [X] T092 [P] [US7] `server/tests/unit/webpush.test.ts`: **RFC 8291 부록 A 의 공식 테스트 벡터**(고정 서버 키·구독자 키·salt·평문 → 정확히 일치하는 암호문)로 암호화 구현을 검증한다. 벡터 값은 IETF datatracker 의 RFC 8291 부록 A 원문을 `WebFetch` 로 가져와 `server/tests/fixtures/rfc8291-appendix-a.json` 에 저장해 쓴다(값을 기억에 의존해 쓰지 않는다). VAPID JWT 는 ES256 서명이 공개키로 검증되고 `aud`(푸시 서비스 origin), `exp`(24시간 이내), `sub`(`TODO_VAPID_SUBJECT`, 기본 `https://todo.home.arpa`)가 올바르며 `Authorization: vapid t=<jwt>, k=<공개키>` 형식이다. 전송 헤더에 `TTL: 900`, `Urgency: high`, `Content-Encoding: aes128gcm` 이 있다. 응답 404/410 은 `gone`, 429/5xx 는 `retry`, 그 밖의 4xx 는 `fail` 로 분류한다. 허용되지 않은 호스트·`http:` 엔드포인트에는 요청을 보내지 않는다
- [X] T093 [P] [US7] `server/tests/unit/scheduler.test.ts` (주입된 시계 + 가짜 푸시 서비스): tick 이 알림이 켜진 기기마다 기기 시간대로 발화 시각을 계산해 보낸다(정시·10분 전·30분 전·1시간 전·하루 전·당일). 시각 없는 할 일은 `defaultReminderTime` 을 쓴다. **페이로드에 제목·프로젝트 이름 등 내용이 없고 `{"v":1,"taskId":"…"}` 뿐이다**(SC-014). 완료·삭제된 할 일은 보내지 않고, 기한을 바꾸면(`armed_at` 갱신) 이전 알림은 취소되고 새 기한 기준으로 보낸다. 반복 할 일이 다음 회차로 넘어가면 새 `dueKey` 로 다시 보낸다. 같은 알림은 `reminder_log` 때문에 서버를 다시 시작해도 한 번만 보낸다. 15분을 넘겨 늦은 것은 건너뛴다. `armed_at` 이후에 설정했는데 이미 지난 시각의 알림은 보내지 않는다. 알림이 꺼진 기기·구독이 없는 기기에는 보내지 않는다. 404/410 응답은 구독을 삭제하고 429/5xx 는 15분 안에서만 재시도한다. 두 기기에 각각 한 번씩 보낸다
- [X] T094 [P] [US7] `server/tests/contract/push-api.contract.test.ts`: contracts/sync-api.md 계약 테스트 12~14. `PUT /api/devices/me/push` 가 허용되지 않은 호스트·`http:` 엔드포인트(400 `invalid_endpoint`)와 잘못된 시간대(400 `invalid_timezone`)를 거부하고 `subscription` 생략 시 `enabled`/`timezone` 만 갱신하며, `GET /api/push/key` 가 인증이 필요하고 서버를 다시 시작해도 같은 키를 돌려주고, `POST /api/push/test` 가 가짜 푸시 서비스에 RFC 8291 대로 암호화된 요청을 보내 복호화한 페이로드에 `test:true` 만 있다. 구독이 없으면 `409 not_subscribed`. 기기를 해제하면 구독이 삭제된다
- [X] T095 [P] [US7] `client/tests/unit/push.test.ts`: 알림 켜기 흐름(권한 요청 → 구독 → 서버 등록), 권한 거부 시 안내 상태, 홈 화면에 설치되지 않은 iOS(푸시 API 없음) 안내 상태, 서버 공개키가 바뀌면 자동으로 다시 구독, 시간대가 바뀌면 서버에 다시 보고, 편집 중 이미 지난 알림 감지(`isReminderInPast`)를 가짜 `Notification`/`PushManager`/fetch 로 검증한다
- [X] T096 [P] [US7] `e2e/us7-reminders.spec.ts`: 편집 시트에서 기한 시각과 알림 종류(시각이 있으면 정시·10분 전·30분 전·1시간 전·하루 전, 없으면 당일·하루 전)를 고를 수 있고 이미 지난 알림은 "이미 지난 알림이에요" 로 안내됨, 이 기기의 알림이 꺼져 있으면 알림을 고를 때 그 사실이 안내됨, 시각을 넣으면 "당일" 알림이 "정시"로 바뀌고 시각을 지우면 시각 기준 알림이 제거되며 안내됨, 설정에서 기본 알림 시각 변경, 알림 켜기/끄기 스위치와 권한 거부 안내, 서비스 워커의 `push` 이벤트를 직접 발생시키면 시스템 알림이 "할 일 1건이 있어요" 로 표시되고 앞에 열린 창에는 제목이 포함된 앱 안 알림이 뜸, `notificationclick` 이 해당 할 일 화면(`/?task=<id>`)으로 이동, 다른 기기에서 완료한 알림은 동기화 후 목록에서 사라짐을 확인한다

### Implementation for User Story 7

- [X] T097 [P] [US7] `shared/tz.ts`: `wallTimeToInstant(date, time, tz)` 를 `Intl.DateTimeFormat` 으로 구한 오프셋을 반복 보정해 구현한다. 서머타임 경계 규칙은 T089 에 따른다
- [X] T098 [P] [US7] `shared/reminders.ts`: `reminderInstant`, `shouldFire`, `remapReminders`, `dueKey(task)`(= `dueDate dueTime`)를 구현한다. 발화 조건과 15분 규칙은 T090 에 따른다
- [X] T099 [P] [US7] `server/src/vapid.ts`: 첫 시작 때 P-256 키쌍을 만들어 `TODO_VAPID_FILE`(기본 `/var/lib/todo/vapid.json`, 권한 0600)에 저장하고 이후에는 읽어 쓴다. 공개키를 base64url 비압축 점으로 제공한다. 이 파일은 저장소에 커밋되지 않는다
- [X] T100 [US7] `server/src/webpush.ts`: `node:crypto` 로 RFC 8291 `aes128gcm` 암호화(ECDH, HKDF-SHA256, AES-128-GCM, 레코드 크기 4096)와 RFC 8292 VAPID(ES256 JWT)를 구현하고 `sendPush(subscription, payload)` 가 허용 호스트 검사(`web.push.apple.com`, `*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, 테스트 시 `TODO_PUSH_ALLOW_HOSTS`) 후 `TTL: 900`, `Urgency: high` 로 전송하고 결과를 `ok`/`gone`/`retry`/`fail` 로 돌려준다. **RFC 벡터 테스트(T092)를 먼저 통과시킨다**
- [X] T101 [US7] `server/src/push-api.ts`: `GET /api/push/key`, `PUT /api/devices/me/push`, `DELETE /api/devices/me/push`, `POST /api/push/test` 를 contracts/sync-api.md 대로 구현한다(엔드포인트 호스트 검증, IANA 시간대 검증, 구독당 기기 1개)
- [X] T102 [US7] `server/src/scheduler.ts`: 30초마다 research R13 의 절차로 후보 할 일을 조회해 기기별 발화 시각을 계산하고, `shouldFire` 를 통과하고 `reminder_log` 에 없는 것을 `sendPush` 로 보낸 뒤 로그에 기록한다. 페이로드는 `{"v":1,"taskId":"<UUID>"}` 뿐이다. `now` 를 주입할 수 있게 한다. 7일 지난 `reminder_log` 행을 정리한다. `gone` 이면 구독을 삭제하고 `retry` 는 다음 tick 에 재시도한다
- [X] T103 [US7] `server/src/main.ts`: 푸시 API 라우트를 연결하고 서버 시작 시 스케줄러를 시작하며 종료 시 멈춘다
- [X] T104 [US7] `server/src/admin-cli.ts`: `devices` 에 알림 열(켬/끔/없음)을 더하고, `revoke` 가 그 기기의 푸시 구독도 삭제하게 하며, `push-test <deviceId>`(푸시 서비스의 응답 코드를 출력, 구독이 없으면 안내)를 추가한다
- [X] T105 [US7] `client/src/push.ts`: `enableNotifications()`(사용자 조작에서 호출 → `Notification.requestPermission()` → 서버 공개키로 `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` → 서버 등록), `disableNotifications()`(서버 `enabled=false`), 상태 조회(`unsupported`/`needs-install`/`denied`/`off`/`on`), 시간대 보고, 공개키 변경 감지 시 재구독, 앱을 열 때 구독이 사라졌으면 자동 재구독을 구현한다
- [X] T106 [US7] `client/src/sw.ts`: `push` 이벤트에서 페이로드를 해석해 **항상** `showNotification("할 일 1건이 있어요", {tag: "task-<id>", data: {taskId}})` 를 호출하고(iOS 규칙, 제목은 절대 넣지 않음), 앞에 열린 창이 있으면 메시지를 보내 제목이 포함된 앱 안 알림을 띄우게 한다. `notificationclick` 은 열린 창을 포커스하거나 `/?task=<id>` 로 연다
- [X] T107 [US7] `client/src/ui/task-editor.ts`: 기한 시각 입력(`<input type="time">` + "시각 없음")과 알림 선택(시각이 있으면 정시·10분 전·30분 전·1시간 전·하루 전, 없으면 당일·하루 전, 체크박스 여러 개)을 더한다. 기한이 없으면 두 섹션을 비활성화한다. 이미 지난 알림은 `isReminderInPast` 로 판단해 "이미 지난 알림이에요" 를 표시한다(FR-026). 시각을 추가·삭제하면 `remapReminders` 로 알림을 정리하고 제거된 개수를 안내한다. 알림을 고를 때 이 기기의 알림이 꺼져 있거나 권한이 없으면 "이 기기는 알림이 꺼져 있어요"(설정으로 가는 링크 포함)를 차단하지 않는 안내로 보인다
- [X] T108 [US7] `client/src/ui/settings.ts`: 알림 섹션을 더한다. "알림 켜기/끄기" 스위치(이 기기), 상태별 안내(홈 화면에 설치 필요 / 권한 거부 시 설정 앱에서 허용하는 방법 / 지원 안 함), "기본 알림 시각"(`<input type="time">`, 기본 `09:00`, 변경은 Settings 레코드로 동기화), "테스트 알림 보내기" 버튼을 둔다
- [X] T109 [US7] `client/src/main.ts`, `client/src/ui/undo-toast.ts`: 서비스 워커의 메시지를 받아 제목이 포함된 앱 안 알림(토스트)을 보이고, `?task=<id>` 로 열리면 해당 할 일이 보이는 화면을 연다(데이터가 없으면 동기화 후 재시도). 시작 시와 `visibilitychange` 에서 시간대를 서버에 보고한다
- [X] T110 [US7] `client/src/ui/task-list.ts`: 기한 시각이 있으면 시각을 표시하고(오늘의 지난 시각은 강조), 알림이 있으면 알림 아이콘 + 접근 가능한 텍스트를 표시한다

**Checkpoint**: T089~T096 이 통과한다. 실제 애플 푸시는 quickstart V15~V20 으로 실기기에서 확인한다(T131)

---

## Phase 10: User Story 8 - 월간 캘린더로 한눈에 보기 (Priority: P4)

**Goal**: 월간 캘린더에서 할 일이 있는 날과 진행 상황을 보고, 날짜를 눌러 그 날의 할 일을 확인·추가한다

**Independent Test**: 여러 날짜에 할 일을 만들고 일부만 완료한 뒤 각 날짜 칸의 표시가 실제와 일치하는지, 날짜를 선택하면 그 날짜의 할 일만 보이는지 확인한다 (spec US8)

### Tests for User Story 8 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T111 [P] [US8] `client/tests/unit/day-summary.test.ts`: `summarizeMonth(year, month)` 가 날짜별 `total`, `remaining`, `allDone` 을 data-model.md 의 정의대로 계산한다(삭제된 항목 제외, 완료된 일반 할 일도 `total` 에 포함, `allDone = total > 0 && remaining == 0`, 할 일이 없는 날은 결과에 없음, `dueDate` 가 없는 할 일은 포함되지 않음, 달 밖의 날짜는 포함되지 않음)
- [X] T112 [P] [US8] `e2e/us8-calendar.spec.ts`: spec US8 수용 시나리오 1~6. 처음 열면 이번 달과 선택된 오늘의 목록, 이전/다음 달·"오늘" 버튼, 11/20 에 3개(1개 완료)이면 20일 칸에 남은 개수 2, 모두 완료한 날은 "모두 완료"로 구분, 할 일이 없는 날은 표시 없음, 선택한 날짜에서 추가하면 기한이 그 날짜, 기한 없는 할 일은 어느 날짜에도 나타나지 않음. 방향키·PageUp/PageDown 으로 날짜를 이동하고, 칸의 `aria-label` 에 "남은 할 일 2개" 또는 "모두 완료" 가 포함되며, 100개인 날도 목록이 스크롤되고 캘린더에는 개수로 요약되는지 확인한다

### Implementation for User Story 8

- [X] T113 [US8] `client/src/views.ts`: `summarizeMonth(year, month)` 를 구현한다. `tasks.byDue` 로 달 전체 범위를 한 번에 조회한다
- [X] T114 [US8] `client/src/ui/calendar.ts`: 월 격자를 `role="grid"` 로 그린다(요일 머리글은 일요일 시작). 각 날짜 칸은 `<button>` 이고 `aria-label="2026년 11월 20일, 남은 할 일 2개"` 형태이며 선택된 칸은 `aria-selected`, 오늘은 `aria-current="date"`, roving tabindex 를 쓴다. 방향키로 하루/한 주 이동, PageUp/PageDown 으로 달 이동. 남은 개수 배지 또는 "모두 완료" 표시를 색상만이 아니라 텍스트·아이콘으로도 구분하고 대비 4.5:1 이상을 지킨다. 이전 달·다음 달·"오늘" 버튼을 둔다
- [X] T115 [US8] `client/src/main.ts`, `client/src/ui/project-view.ts`: `#/calendar` 라우트를 연결한다. 캘린더 아래에 선택한 날짜의 목록(`task-list.ts`, 빠른 추가 기본 기한 = 선택한 날짜)을 보여 주고, 데이터가 바뀌면(동기화 포함) 캘린더 칸을 다시 계산한다. `e2e/a11y.spec.ts` 에 캘린더 화면의 axe 검사를 추가한다

**Checkpoint**: T111~T112 가 통과한다

---

## Phase 11: User Story 9 - 내 데이터 내보내기 (Priority: P5)

**Goal**: 모든 프로젝트와 할 일을 JSON 파일로 내려받아 홈서버와 별도로 백업한다

**Independent Test**: 프로젝트와 할 일 여러 개를 만든 뒤 내보내기를 실행해 파일에 모든 내용이 빠짐없이 들어 있는지 확인한다 (spec US9)

### Tests for User Story 9 ⚠️ 먼저 작성하고 실패를 확인한다

- [X] T116 [P] [US9] `client/tests/unit/export.test.ts`: `buildExport(projects, tasks, settings, now)` 가 data-model.md 의 내보내기 형식(`format: "todo-export"`, `schemaVersion: 1`, `exportedAt`, `projects[]`, `tasks[]`(각각 `id`, `title`, `dueDate`, `dueTime`, `projectId`, `priority`, `recurrence`, `reminders`, `done`, `createdAt`), `settings`)을 만든다. 툼스톤(`deleted=true`)과 내부 필드(`version`, `updatedBy`, `dirty`)는 내보내지 않고, 고아 할 일의 `projectId` 는 `"inbox"` 로 정리한다
- [X] T117 [P] [US9] `server/tests/unit/admin-cli-export.test.ts`: `todo-admin export` 가 같은 형식으로 서버의 기준 사본을 출력하고(`armed_at` 같은 서버 내부 필드 제외) `--out` 이 있으면 파일에 쓴다. `todo-admin backup <파일>` 이 서비스를 중지하지 않고 SQLite 온라인 백업을 만들며 만든 DB 를 열면 같은 데이터가 들어 있다
- [X] T118 [P] [US9] `e2e/us9-export.spec.ts`: 설정 화면의 "내보내기" 로 다운로드한 파일이 올바른 JSON 이고 만든 프로젝트·할 일(반복·알림·우선순위 포함)이 모두 들어 있다(spec US9 수용 시나리오 1)

### Implementation for User Story 9

- [X] T119 [P] [US9] `client/src/export.ts`: `buildExport` 와 파일 다운로드(`Blob` + `<a download="todo-export-YYYY-MM-DD.json">`)를 구현한다
- [X] T120 [US9] `client/src/ui/settings.ts`: "내보내기" 버튼을 추가해 `client/src/export.ts` 를 호출한다. 실패하면 오류를 안내한다
- [X] T121 [US9] `server/src/admin-cli.ts`: `todo-admin export [--out <파일>]` 와 `todo-admin backup <파일>`(SQLite 온라인 백업, 실패하면 종료 코드 1)을 contracts/admin-cli.md 대로 추가한다

**Checkpoint**: T116~T118 이 통과한다. 모든 사용자 스토리가 동작한다

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: 배포, 성능·접근성·보안 점검, 수동 확인

- [X] T122 [P] `deploy/Caddyfile`: `todo.home.arpa { tls internal; handle /api/* { reverse_proxy 127.0.0.1:8080 { flush_interval -1 } }; handle { root * /opt/todo/client/dist; try_files {path} /index.html; file_server } }` 형태로 만든다. SSE 가 버퍼링되지 않도록 `flush_interval -1` 을 쓰고, `sw.js` 와 `index.html` 은 `Cache-Control: no-cache` 로 제공한다
- [X] T123 [P] `deploy/todo.service`: systemd 유닛. 전용 사용자 `todo`, `ExecStart=/usr/bin/node /opt/todo/server/src/main.ts`, `Environment=TODO_DB=/var/lib/todo/todo.db`, `Environment=TODO_VAPID_FILE=/var/lib/todo/vapid.json`, `StateDirectory=todo`, `ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges=true`, `PrivateTmp=true`, `Restart=on-failure`. 아웃바운드 HTTPS 를 막는 옵션(`IPAddressDeny` 등)은 쓰지 않는다(푸시 전송에 필요)
- [X] T124 `deploy/install.sh`: LXC 안에서 실행한다. Node 24 와 Caddy 설치, `todo` 사용자 생성, `/opt/todo` 에 빌드 산출물 배포, `/var/lib/todo` 생성, `todo.service` 와 Caddyfile 적용, `/usr/local/bin/todo-admin` 래퍼 설치를 한다. 여러 번 실행해도 안전해야 한다(멱등). 끝나면 `curl -k https://todo.home.arpa/api/health` 와 `curl -sI https://web.push.apple.com` 으로 서버와 푸시 아웃바운드를 확인해 결과를 출력한다 (T122, T123 에 의존)
- [X] T125 [P] `e2e/performance.spec.ts`: 할 일 1,000개가 있을 때 화면 전환·달 이동·날짜 선택이 1초 안에 화면에 반영되는지(SC-004), 추가·완료·삭제 조작 후 화면 반영이 100ms 안인지(SC-002, 로컬 저장 기준), 초기 로드가 2초 안에 인터랙티브해지는지(헌법 IV) 측정해 기준을 넘으면 실패시킨다
- [X] T126 [P] `e2e/a11y.spec.ts`: 모든 화면(오늘, 예정, 프로젝트, 캘린더, 편집 시트, 프로젝트 시트, 설정, 등록, 실행 취소 토스트가 떠 있는 상태)에서 axe 검사와 키보드 전용 시나리오, 폭 320px 시나리오를 확장한다 (FR-037). `<html lang="ko">` 이고 주요 화면의 제목·버튼 문구가 한국어인지도 확인한다 (FR-038)
- [X] T127 [P] 보안 점검: 저장소 전체에서 `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` 사용이 `npm run lint`(`scripts/lint.mjs`)에서 0건으로 통과하는지 확인한다. 비밀(세션 토큰, VAPID 개인키, CA 키)이 저장소에 없는지, `vapid.json` 이 `.gitignore` 에 있는지, 서버가 모든 입력을 다시 검증하는지, 푸시 엔드포인트가 허용 호스트로 제한되는지 확인한다 (헌법 Technical Constraints)
- [X] T128 [P] `e2e/timezone.spec.ts`: Playwright 의 `timezoneId` 를 `Asia/Seoul` 과 `America/New_York` 으로 바꿔 같은 할 일의 `dueDate`·`dueTime` 이 변하지 않고 "오늘" 이 해당 기기의 현지 날짜로 계산되는지 확인한다(FR-028, V19 의 클라이언트 부분)
- [X] T129 `npm run lint`(타입 검사 포함) 와 `npm test` 와 `npm run test:e2e` 를 모두 실행해 전부 통과하는지 확인하고, 실패가 있으면 고친다
- [ ] T130 `quickstart.md` 의 §1 명령과 경로가 실제 구현과 일치하는지 확인해 다르면 갱신하고, §4 의 V1~V23 중 자동화(✅) 항목이 모두 통과하는지 확인한다
- [ ] T131 **[사용자 수동 작업, 코드 아님]** 개인 배포 메모(저장소 밖)의 절차를 따라 홈서버에 적용하고 실제 기기로 확인한다: 서버 만들기, 고정 IP와 내부 이름 `todo.home.arpa` 설정, 방화벽 허용 규칙, 서버에서 `*.push.apple.com` 으로 나가는 연결 확인, `deploy/install.sh` 실행, Caddy 루트 인증서를 맥·아이폰·아이패드에 설치하고 신뢰, 각 기기에서 홈 화면에 추가한 뒤 `todo-admin pair` 로 등록, 설정에서 "알림 켜기". 그리고 수동 항목 V15(실제 푸시, 10회 반복 모두 1분 이내. **애플이 VAPID `sub` 값 `https://todo.home.arpa` 를 거부하면 사용자에게 사용할 값을 확인한다**), V4, V5, V16, V17, V18, V19, V20, V23 을 맥·아이폰·아이패드 각각에서 확인한다(기기마다 오늘 화면의 추가·완료가 동작하는지 포함, FR-029)

---


---

## 진행 현황 (2026-11-13 기준)

**완료: 107 / 131** — Setup, Foundational, US1~US6, US8, US9, Polish 일부. 유닛·계약 테스트 170개, e2e 136개(chromium + webkit)가 모두 통과하고 `npm run lint` 도 통과한다.

**남은 작업**
- **US7 알림 (T089~T110, 22개)**: Web Push 암호화(RFC 8291)·VAPID, 서버 스케줄러, 서비스 워커 push 처리, 편집 시트의 시각·알림 UI, 설정의 알림 켜기/끄기. 구현은 T091(가짜 푸시 서비스 테스트 도구)과 T092(RFC 벡터 테스트)부터 시작한다.
- **T130**: quickstart §4 의 자동화 항목 확인 — US7 시나리오(V13, V14, V17, V18, V19 의 서버 부분)가 끝나야 완료된다.
- **T131**: 사용자 수동 작업(홈서버 적용, 실기기 확인).

**계획과 달라진 점 (구현 중 결정)**
- 개발 환경의 Node 는 22.21 이다. `node:sqlite`·타입 제거 실행·시간대 데이터가 모두 동작해 `engines` 를 `>=22.18` 로 두었고, 배포 대상(LXC)은 계속 Node 24 다(`deploy/install.sh`).
- 내보내기 형식 생성 코드는 클라이언트와 서버 CLI 가 공유하도록 `client/src/export.ts` 가 아니라 `shared/export.ts` 에 두었다(`client/src/export.ts` 는 파일 저장만 맡는다).
- 반복 설정 UI 는 `client/src/ui/recurrence-field.ts` 로 분리했고, 규칙 비교는 키 순서와 무관한 `canonicalRule`(shared/recurrence.ts)로 한다.
- 예정·캘린더 화면의 접근성 검사는 `e2e/a11y.spec.ts` 가 아니라 각 스토리의 e2e 파일(`us5-upcoming`, `us8-calendar`)에 두었다.
- `deploy/install.sh`·`Caddyfile`·`todo.service` 는 문법과 배포 폴더 구조까지만 이 환경에서 검증했다. 실제 apt 설치·Caddy·systemd 동작은 LXC 에서 처음 실행할 때 확인해야 한다.

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 의존성 없음 — 바로 시작
- **Foundational (Phase 2)**: Setup 이 끝나야 한다 — **모든 사용자 스토리를 막는다**
- **User Stories (Phase 3~11)**: 모두 Foundational 이 끝나야 한다
- **Polish (Phase 12)**: 원하는 사용자 스토리가 모두 끝나야 한다

### User Story Dependencies

- **US1 (P1)**: Foundational 이후 시작. 다른 스토리에 의존하지 않는다 — MVP
- **US2 (P2)**: 서버 작업(T047~T053)은 US1 과 독립이라 동시에 진행할 수 있다. 클라이언트 작업(T054~T062)은 `client/src/main.ts` 를 고치므로 US1 이 끝난 뒤에 한다
- **US3 (P2)**, **US4 (P2)**, **US5 (P2)**, **US6 (P3)**, **US8 (P4)**: US1 위에 얹는다. 서로 `task-editor.ts`·`task-list.ts`·`views.ts`·`main.ts` 를 같이 고치므로 순서대로 한다. 데이터는 US2 없이도 로컬에서 동작한다
- **US7 (P3)**: US1 의 편집 시트와 US2 의 서버·인증·기기 등록이 필요하다(푸시 구독이 기기에 묶이고 스케줄러가 서버 DB 를 읽는다). 반복 할 일의 알림 재예약은 US6 이 있으면 종단으로 확인할 수 있지만, 스케줄러 단위 테스트는 US6 없이도 가능하다
- **US9 (P5)**: US2 의 설정 화면(T060)과 서버 CLI(T053)가 필요하다

### Within Each User Story

- 테스트를 먼저 쓰고 **실패하는 것을 확인한 뒤** 구현한다 (헌법 III)
- 서버는 `db` → `migrations` → `auth` → `sync` → `events` → `main` 순서, 푸시는 `vapid`·`webpush`(RFC 벡터 먼저) → `push-api` → `scheduler` → `main` 순서
- 클라이언트는 `tasks.ts`/`projects.ts`(로직) → `views.ts`(조회) → `ui/*`(화면) → `main.ts`(연결) 순서
- 한 스토리가 끝나면 체크포인트에서 독립적으로 검증하고 다음으로 넘어간다

### Parallel Opportunities

- Phase 1 의 [P] 작업(T003~T006)은 병렬이다
- Phase 2 의 테스트 T007~T012 는 모두 병렬이고, 구현 T013~T017(공유 로직)과 T019~T021(저장소)도 서로 다른 파일이라 병렬이다
- US2 의 테스트 T039~T046 은 모두 병렬이다. 서버 구현(T047~T053)과 클라이언트의 순수 모듈(T055, T058~T060)은 병렬로 진행할 수 있다
- US7 의 테스트 T089~T096 과 공유 로직 T097~T099 는 병렬이다(단 T091 가짜 푸시 서비스가 T092~T094 보다 먼저)
- US1 이 끝난 뒤에는 서버 쪽 US2 와, US3·US4·US5·US6 의 테스트 작성을 동시에 진행할 수 있다
- Polish 의 T122, T123, T125~T128 은 병렬이다

---

## Parallel Example: Phase 2 Foundational

```bash
# 테스트 6개를 함께 작성한다 (모두 다른 파일):
Task: "shared/tests/task.test.ts"         # T007
Task: "shared/tests/hlc.test.ts"          # T008
Task: "shared/tests/merge.test.ts"        # T009
Task: "shared/tests/calendar.test.ts"     # T010
Task: "shared/tests/sort.test.ts"         # T011
Task: "client/tests/unit/store.test.ts"   # T012

# 실패를 확인한 뒤 공유 로직 5개를 함께 구현한다:
Task: "shared/task.ts"      # T013
Task: "shared/hlc.ts"       # T014
Task: "shared/merge.ts"     # T015
Task: "shared/calendar.ts"  # T016
Task: "shared/sort.ts"      # T017
```

## Parallel Example: User Story 7

```bash
# 테스트 인프라를 먼저 만든 뒤, 테스트들을 함께 작성한다:
Task: "server/tests/helpers/fake-push-service.ts"          # T091 (먼저)
Task: "shared/tests/tz.test.ts"                            # T089
Task: "shared/tests/reminders.test.ts"                     # T090
Task: "server/tests/unit/webpush.test.ts"                  # T092 (RFC 8291 벡터)
Task: "server/tests/unit/scheduler.test.ts"                # T093
Task: "server/tests/contract/push-api.contract.test.ts"    # T094
Task: "client/tests/unit/push.test.ts"                     # T095
Task: "e2e/us7-reminders.spec.ts"                          # T096
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup 완료
2. Phase 2: Foundational 완료 (**필수**, 모든 스토리를 막음)
3. Phase 3: US1 완료
4. **멈추고 검증**: T027~T029 통과, 맥 Safari 에서 `npm run dev` 로 직접 써 본다
5. 이 단계에서도 "한 기기에서 쓰는 오늘 화면 + 수신함 투두"로 이미 쓸 수 있다

### Incremental Delivery

1. Setup + Foundational → 기반 완료
2. US1 → 독립 검증 → **MVP**
3. US2 → 독립 검증 → 홈서버에 배포(T122~T124, T131 의 앞부분)해서 세 기기 동기화 시작 — **스펙의 필수 요구사항(동기화)이 충족되는 첫 지점**
4. US3(프로젝트) → US4(우선순위) → US5(예정 화면): 매일 쓰는 Todoist 핵심 화면이 갖춰진다
5. US6(반복) → US7(알림): 반복과 알림. 알림은 실기기 검증(T131)이 필요하므로 이 시점에 실제 아이폰에서 신뢰도를 확인한다
6. US8(캘린더), US9(내보내기)
7. Polish → 성능·접근성·보안 점검과 최종 확인

사용자가 명시한 필수 요구사항이 "세 기기 동기화"이므로, 실제로 쓰기 시작하는 시점은 **US1 + US2 완료 후**를 권장한다. 알림(US7)은 iOS 웹 푸시의 신뢰도가 변수이므로([research R1](./research.md)) 실기기에서 부족하다고 판단되면 알림 클라이언트 부분만 네이티브로 바꿀 수 있고, 서버 스케줄러와 API 는 그대로 쓸 수 있다.

---

## Notes

- [P] 작업은 서로 다른 파일이고 의존성이 없다
- [Story] 라벨은 작업을 스펙의 사용자 스토리와 연결한다
- 테스트가 실패하는 것을 확인한 뒤 구현한다
- 작업 하나 또는 논리적인 묶음이 끝날 때마다 커밋한다
- 체크포인트마다 멈춰서 스토리를 독립적으로 검증한다
- 피할 것: 모호한 작업, 같은 파일 충돌, 스토리 독립성을 깨는 스토리 간 의존
