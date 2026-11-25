# 오늘 화면 재구성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (사용자가 inline 실행을 지정함). 체크박스(`- [ ]`)로 진행을 추적한다.

**Goal:** 오늘 목록을 기한 지남 / 지금 중요(P1·P2) / 나머지 구역으로 나누고, 넓은 화면에서 구글 일정을 오른쪽 칸으로 뺀다. 순서 바꾸기는 구역 안에서만 동작한다.

**Architecture:** `todayView`의 정렬 결과를 `priority <= 2`로 나누는 순수 함수 하나를 추가하고, `today.ts`가 구역마다 기존 `renderTaskList`(드래그 포함)를 부른다. 오른쪽 칸은 CSS 그리드만 쓴다(DOM 이동 없음).

**Tech Stack:** TypeScript(Node 22 직접 실행), 순수 CSS, node:test, Playwright(+axe).

**Spec:** `docs/superpowers/specs/2026-11-25-today-regroup-design.md`

## Global Constraints

- 기존 클래스·`data-key`·aria 속성은 지우거나 이름을 바꾸지 않는다. 오늘 화면의 구역 `section`은 기존 `open` 클래스를 유지한다.
- 저장·동기화·알림·순서 저장(`sortKey`, `enableReorder`, `planReorder`) 코드는 수정하지 않는다.
- 좁은 화면(<1100px)의 오늘 화면 배치는 지금과 같다(일정이 입력줄 위에 쌓임).
- 설계 변경 한 가지: 스펙은 오른쪽 칸을 `aside`로 적었으나 기존 `ul.events`가 이미 `aria-label="구글 캘린더 일정"`을 가지므로 새 요소 없이 그 `ul`을 그리드 칸으로 배치한다.
- 모든 글자색 대비 4.5:1 이상(axe e2e).

## Review Focus

- P1·P2가 하나도 없는 날: "지금 중요" 구역을 그리지 않고 "나머지"만 나온다 (제목 `나머지`도 구역이 하나뿐이면 보이되 어색하지 않게).
- 모두 P3·없음이면서 완료 항목만 있는 날: 빈 상태 문구와 완료됨 영역이 기존대로 나온다.
- 우선순위를 P4→P1로 바꾸면 카드가 "지금 중요" 구역으로 옮겨 가고, 되돌리면 "나머지"로 간다.
- 구글 일정이 없을 때 넓은 화면에서 오른쪽 칸이 빈 틀로 남지 않는다.
- 1100px 경계(1099/1100)에서 가로 스크롤이 생기지 않는다.

---

### Task 1: 우선순위 분할 함수

**Files:** Modify `client/src/views.ts`; Create `client/tests/unit/today-groups.test.ts`

**Interfaces:** Produces `export function splitByUrgency<T extends { priority: number }>(tasks: readonly T[]): { hot: T[]; rest: T[] }` — `priority <= 2`는 hot, 나머지는 rest. 입력 순서를 각 구역 안에서 보존한다.

- [ ] **Step 1: 실패하는 테스트** — `today-groups.test.ts`: (a) `[p4,p1,p3,p2]` → `hot` 제목 순서 `[p1,p2]`, `rest` `[p4,p3]` (순서 보존), (b) 빈 입력 → 둘 다 `[]`, (c) 전부 P4 → `hot` 비어 있음.
- [ ] **Step 2: 실패 확인** — `node --test client/tests/unit/today-groups.test.ts`. 기대: FAIL (export 없음).
- [ ] **Step 3: 구현** — `views.ts`의 `todayProgress` 옆에 위 시그니처로. 한 번의 순회.
- [ ] **Step 4: 통과 확인** — 같은 명령. 기대: PASS. 이어서 `npm run typecheck && npm test` 통과.
- [ ] **Step 5: Commit** — `git add -A client && git commit -m "feat(today): splitByUrgency"`

### Task 2: 오늘 화면 구역 나누기

**Files:** Modify `client/src/ui/today.ts`, `client/src/ui/styles.css` (구역 제목 스타일), `e2e/us16-list-reorder.spec.ts` (두 번째 테스트); Create `e2e/us19-today-groups.spec.ts`

**Interfaces:** Consumes `splitByUrgency`. Produces DOM: `section.section.open.group-hot[aria-labelledby=hot-heading]`(제목 `h3#hot-heading` 텍스트 `지금 중요 (N)`), `section.section.open.group-rest[aria-labelledby=rest-heading]`(`h3#rest-heading` `나머지 (N)`). 각 구역 안에 `renderTaskList(app, group, rowOpts)`가 만든 `ul.tasks`. 구역이 비면 그 `section`은 만들지 않는다.

- [ ] **Step 1: e2e 먼저** — `us19-today-groups.spec.ts`(`test.use` 시간대·로케일은 `us16`과 같게). 테스트: (1) P1·P2·없음 할 일을 만들면 `section.group-hot`에 P1·P2만, `section.group-rest`에 나머지, 제목 개수 일치. (2) P1·P2가 없으면 `section.group-hot` 개수 0. (3) 카드의 우선순위를 `1 긴급`으로 바꾸면 `section.group-hot`으로 이동, `4 없음`으로 되돌리면 `group-rest`로 복귀. (4) `group-rest` 안에서 카드를 끌면 그 구역 순서가 바뀌고 새로고침 후 유지(`us16`의 `dragRow` 방식 복사). (5) axe 위반 없음(`AxeBuilder`, `us4-priority` 방식).
- [ ] **Step 2: 실패 확인** — `npm run build && npx playwright test e2e/us19-today-groups.spec.ts --project=chromium`. 기대: FAIL (`group-hot` 없음).
- [ ] **Step 3: 구현** — `today.ts`에서 `v.today.length > 0`일 때 `splitByUrgency(v.today)` 결과로 구역을 위 DOM대로 만든다. 제목은 기존 `.section h3`/`.section-head` 패턴을 따른다(기한 지남 구역의 `h3` 마크업 참고).
- [ ] **Step 4: 기존 e2e 고치기** — `us16` 두 번째 테스트: 우선순위를 `1 긴급`으로 바꾼 뒤 기대 순서를 `['A','B']`, `C` 추가 뒤 `['A','B','C']`로 바꾸고 테스트 이름을 `우선순위를 바꾸면 다른 구역으로 옮겨 가고, 새로 추가한 할 일은 그 구역 맨 아래로 간다`로 바꾼다. `us1-today`, `us4-priority`, 기타 오늘 화면 테스트가 깨지면 구역 구조에 맞게 최소한으로 고친다.
- [ ] **Step 5: 확인** — `npm run build && npx playwright test e2e/us19-today-groups.spec.ts e2e/us16-list-reorder.spec.ts e2e/us1-today.spec.ts e2e/us4-priority.spec.ts e2e/a11y.spec.ts --project=chromium`. 기대: PASS.
- [ ] **Step 6: Commit** — `git add -A client e2e && git commit -m "feat(today): group tasks by urgency"`

### Task 3: 넓은 화면 오른쪽 일정 칸

**Files:** Modify `client/src/ui/today.ts`(루트에 클래스), `client/src/ui/styles.css`; Test `e2e/us19-today-groups.spec.ts`

**Interfaces:** Produces 오늘 화면 루트 `div.today-layout` (`today.ts`가 받은 `root`에 클래스를 붙인다). CSS: `@media (min-width: 1100px)`에서 `.today-layout`은 `grid-template-columns: minmax(0,1fr) 280px`, 자식은 기본 1열, `.today-layout > ul.events`는 2열·1행부터 전체 높이(`grid-row: 1 / span 20`, `align-self: start`). `.main:has(.today-layout)`는 `max-width: 1080px`.

- [ ] **Step 1: e2e 먼저** — 같은 파일에 추가. 구글 일정을 `us12-gcal-events.spec.ts`처럼 흉내 내서(그 파일의 `paired`, `isolateSync` 방식 복사, `serviceWorkers: 'block'`) 오늘 일정 1개를 만든 뒤: (1) 폭 1280에서 `ul.events`의 `x`가 목록 `ul.tasks`의 오른쪽 끝보다 크다. (2) 폭 390에서는 `ul.events`가 입력줄(`form.quick-add`)보다 위에 있다(`y` 비교). (3) 폭 1100·1099에서 `document.documentElement.scrollWidth <= innerWidth`. (4) 일정이 없으면 `ul.events` 개수 0.
- [ ] **Step 2: 실패 확인** — `npm run build && npx playwright test e2e/us19-today-groups.spec.ts --project=chromium`. 기대: (1) FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces대로 `root.classList.add('today-layout')`와 CSS. 폭 좁은 화면 CSS는 건드리지 않는다.
- [ ] **Step 4: 확인** — `npm run build && npx playwright test e2e/us19-today-groups.spec.ts e2e/us12-gcal-events.spec.ts e2e/layout.spec.ts e2e/a11y.spec.ts`. 기대: PASS. 1280/390 스크린샷으로 눈으로 확인.
- [ ] **Step 5: Commit** — `git add -A client e2e && git commit -m "feat(today): events column on wide screens"`

### Task 4: 마무리 검증

- [ ] **Step 1:** `npm run lint && npm test && npm run test:e2e` — 기대: 단위 439개 이상, e2e 383개 + 새 테스트 통과. 알려진 불안정 테스트(`us16` Alt+↑↓, `us15` 붙여넣기, `push-sw`)는 실패 시 3회 재실행으로 구분한다.
- [ ] **Step 2:** `git diff --stat main..` 변경 파일이 `views.ts`, `today.ts`, `styles.css`, 테스트·문서뿐인지 확인.

---

**Self-review:** 스펙의 구역(T2)·순서 바꾸기 유지(T2 테스트 4)·오른쪽 칸(T3)·동작 변경과 e2e 수정(T2 Step 4)·검증(T4)을 다룬다. 작은 달력은 스펙대로 제외. `splitByUrgency`는 T1에서 정의해 T2에서만 쓴다.
