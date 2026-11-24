# 다크 리디자인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 할 일 앱을 차콜 + 오렌지 다크 단일 테마의 카드형 디자인으로 바꾸고, 오늘 화면 맨 위에 진행률 링을 더한다. 기능은 바꾸지 않는다.

**Architecture:** 색은 `styles.css`의 CSS 변수 한 벌로 모으고(다크 단일), 컴포넌트 CSS는 변수만 쓰게 다듬는다. DOM 변경은 오늘 화면 요약 요소 하나뿐이며 기존 클래스·구조는 지우거나 바꾸지 않는다.

**Tech Stack:** TypeScript(Node 22 직접 실행), esbuild, 순수 CSS, node:test, Playwright(+axe).

**Spec:** `docs/superpowers/specs/2026-11-24-dark-redesign-design.md`

## Global Constraints

- 팔레트(다크 단일): 바탕 `#141414`, 카드 `#1F1F1F`, 선 `#333333`, 글자 `#F2F2F2`, 보조 글자 `#A3A3A3`, 포인트 `#FF7A1A`(포인트 위 글자 `#1E0C00`), 중요 `#FFC24D`, 기한 지남 `#FF6B5E`.
- 모든 글자색은 배경 대비 4.5:1 이상 (axe e2e가 검사한다). 색만으로 정보를 구분하지 않는다(기존 ⚑P1 글자·↻ 등 유지).
- 기존 클래스명·`data-*`·aria 속성·DOM 구조는 지우거나 이름을 바꾸지 않는다. 추가만 한다.
- `prefers-reduced-motion`, `:focus-visible` 규칙과 `[hidden]` 규칙 유지.
- `.ts` 로직(저장·동기화·순서 바꾸기·알림)은 수정하지 않는다. 변경 허용: `client/src/views.ts`(함수 추가), `client/src/ui/today.ts`(요약 요소 추가).
- 오늘 목록은 `ul` 하나를 유지한다 (sortKey가 우선순위보다 먼저라 나누면 순서 바꾸기가 깨진다).
- `theme-color`·`manifest`의 `background_color`/`theme_color`는 `#141414`.

## Review Focus

- 오늘 할 일 0개 + 완료 0개: 요약(링)을 그리지 않고 기존 "오늘 할 일이 없어요"만 보인다.
- 오늘 할 일 0개 + 완료 1개 이상: 링 100%, 문구는 "오늘 할 일을 모두 끝냈어요".
- 기한 지남만 있고 오늘 몫이 0개인 날: 링은 그리지 않고(분모 0) 기존 "기한 지남" 구역과 빈 상태 문구가 그대로 나온다.
- 사용자가 색 프로젝트(`data-color`) 점을 쓰는 화면: 어두운 카드 위에서도 점이 보인다(밝기 조정).
- 긴 제목·긴 태그가 좁은 폭(360px)에서 카드 밖으로 넘치지 않는다 (`layout.spec.ts`).

---

### Task 1: 다크 토큰과 앱 색

**Files:**
- Modify: `client/src/ui/styles.css:1-42` (토큰), `client/public/index.html` (`theme-color`), `client/public/manifest.webmanifest`
- Test: 기존 `e2e/a11y.spec.ts`, `e2e/layout.spec.ts`

**Interfaces:**
- Produces: CSS 변수 `--bg --surface --surface-2 --text --muted --border --accent --accent-text --danger --warn --ok --focus --p1 --p2 --p3 --overdue` (이름 유지, 값만 다크). 신규 `--hot`(중요 `#FFC24D`) 추가.

- [ ] **Step 1: 기준선 확인** — `npm install` 후 `npm run typecheck && npm test` 를 실행하고 결과를 기록한다. 기대: 모두 통과. 실패가 있으면 이 작업 전부터 있던 실패로 따로 적어 둔다.
- [ ] **Step 2: e2e 기준선** — `npx playwright install chromium` 후 `npm run test:e2e` 실행, 통과/실패 목록을 기록한다. 기준선과 비교해야 하므로 이 단계를 건너뛰지 않는다.
- [ ] **Step 3: 토큰 교체** — `:root` 값을 Global Constraints 팔레트로 바꾸고 `color-scheme: dark`로 한다. `--p1`=`--overdue`=`#FF6B5E`, `--p2`=`#FFC24D`, `--p3`=`#8AB4F8`(주황과 구분되는 차가운 색), `--danger` `#FF6B5E`, `--ok` `#7BD88F`, `--warn` `#FFC24D`, `--focus` `#FF7A1A`. `@media (prefers-color-scheme: dark)` 블록은 삭제한다.
- [ ] **Step 4: 앱 색** — `index.html`의 `theme-color`와 manifest 두 값을 `#141414`로.
- [ ] **Step 5: 확인** — `npm run build && npm run test:e2e -- a11y.spec.ts layout.spec.ts`. 기대: 기준선과 같은 통과. 대비 실패가 나면 해당 변수 값을 밝게 조정한다.
- [ ] **Step 6: Commit** — `git add client docs && git commit -m "style: dark charcoal+orange theme tokens"`

### Task 2: 오늘 화면 요약 (진행률 링)

**Files:**
- Modify: `client/src/views.ts` (함수 추가), `client/src/ui/today.ts`, `client/src/ui/styles.css` (`.today-summary` 추가)
- Create: `client/tests/unit/today-progress.test.ts`

**Interfaces:**
- Produces: `export function todayProgress(v: Pick<TodayView, 'today' | 'completed'>): { done: number; total: number; left: number }` — `done = completed.length`, `left = today.length`, `total = done + left`.
- Produces: DOM `div.today-summary` (자식: `span.ring[style="--pct:<0-100>"][aria-hidden=true]`, `p.today-summary-text`), `today.ts`가 `.view-header` 바로 뒤에 넣는다. `total === 0`이면 만들지 않는다.

- [ ] **Step 1: 실패하는 테스트** — `today-progress.test.ts`에 세 케이스. `todayProgress({today: [a,b,c], completed: [d,e]})` → `{done:2,total:5,left:3}`; `({today: [], completed: [d]})` → `{done:1,total:1,left:0}`; `({today: [], completed: []})` → `{done:0,total:0,left:0}`.
- [ ] **Step 2: 실패 확인** — `node --test client/tests/unit/today-progress.test.ts`. 기대: FAIL (함수 없음).
- [ ] **Step 3: 구현** — `views.ts`에 위 시그니처로 `todayProgress`. 한 줄 계산.
- [ ] **Step 4: 통과 확인** — 같은 명령. 기대: PASS.
- [ ] **Step 5: 화면 연결** — `today.ts`에서 `todayProgress(v)`로 `total > 0`일 때 요약을 추가한다. 문구: `left > 0`이면 `오늘 ${left}개 남았어요`, 아니면 `오늘 할 일을 모두 끝냈어요`. 링 안 숫자 `${done}/${total}`. 읽기용 `sr-only` 문구 `오늘 ${total}개 중 ${done}개 완료`를 같은 컨테이너에 둔다(링 자체는 `aria-hidden`).
- [ ] **Step 6: CSS** — `.ring`은 `conic-gradient(var(--accent) calc(var(--pct) * 1%), var(--surface-2) 0)` 원, 안쪽 구멍은 `::after`로 `--bg`. 크기 64px, 숫자 굵게. 요약 컨테이너는 flex, 간격 14px.
- [ ] **Step 7: 확인** — `npm run typecheck && npm test && npm run test:e2e -- us1-today.spec.ts a11y.spec.ts`. 기대: PASS.
- [ ] **Step 8: Commit** — `git commit -am "feat(today): progress ring summary"`

### Task 3: 공통 컴포넌트 리스타일 (카드·칩·버튼·내비·시트)

**Files:**
- Modify: `client/src/ui/styles.css` (레이아웃 93-239, 공통 239-382, 할 일 목록 382-504, 시트·토스트 504-600)

**Interfaces:**
- Consumes: Task 1 변수. CSS 변수 `--c`(프로젝트 점 색)는 그대로 사용.

- [ ] **Step 1: 할 일 카드** — `li.task`를 `--surface` 둥근 카드(radius 14px), 카드 간 간격 6px, 테두리는 없애고 구분은 배경 명도로. `.task-title` 15px/650. `.badge-p1`, `.badge-p2` 카드(`li.task`에 `:has(.badge-p1)` 사용 가능, 미지원이면 `.badge`만)에 왼쪽 3px 색 막대(`--p1`/`--p2`). 칩은 `--surface-2` 배경·작고 흐리게, 기한 지남 칩은 `--overdue` 글자.
- [ ] **Step 2: 완료 체크** — `.task-check` 원형, 기본 테두리 `--muted`, 체크 시 `--accent` 채움(체크 표시는 `--accent-text`).
- [ ] **Step 3: 버튼·입력** — `.btn-primary`는 `--accent`/`--accent-text`, 입력은 `--surface` 배경·`--border`, 포커스 링 `--focus` 유지.
- [ ] **Step 4: 내비·상단바** — 하단 탭/사이드바 활성 항목은 `--accent` 글자+굵게, 배경은 `--bg`, 위 경계선 `--border`. `.view-header h2`는 1.6rem/800, `.section h3`는 12px·`--muted`, `.section.overdue h3`는 `--overdue`.
- [ ] **Step 5: 시트·토스트** — 시트는 `--surface` 위에 `--surface-2` 입력, 토스트는 `--surface-2`+`--text`.
- [ ] **Step 6: 확인** — `npm run build && npm run test:e2e`. 기대: Task 1 기준선과 같은 통과 수. 실패가 새로 생기면 셀렉터가 아니라 CSS 값 때문인지 보고 CSS를 고친다.
- [ ] **Step 7: 눈으로 확인** — `npm run dev` 후 Playwright 또는 브라우저로 오늘·수신함 화면을 360px/1280px 폭에서 스크린샷, 넘침·겹침·대비를 확인한다.
- [ ] **Step 8: Commit** — `git commit -am "style: card-based components on dark theme"`

### Task 4: 예정·캘린더·태그·설정 화면과 프로젝트 점 색

**Files:**
- Modify: `client/src/ui/styles.css` (600-1445: 캘린더, 예정 보드, 태그, 가상 회차, 구글 일정, 알림, 시간 격자)

- [ ] **Step 1: 하드코딩 색 제거** — 이 구간의 `#` 색·`rgba()`는 토큰으로 바꾼다. 단 `[data-color]` 8개(`styles.css:181-188`)는 어두운 배경에서 보이게 밝은 계열로 조정한다: red `#FF7B6E`, orange `#FF9A47`, yellow `#F2C94C`, green `#5FD08A`, teal `#3CC7D6`, blue `#6EA8FF`, purple `#B58CFF`, gray `#9AA0A6`.
- [ ] **Step 2: 예정 보드** — 날짜 열은 `--surface` 큰 라운드 카드(radius 16px), 카드 안 `li.task`는 `--surface-2`로 한 단계 밝게. 오늘 열은 위쪽 3px `--accent` 막대.
- [ ] **Step 3: 캘린더** — 격자 선 `--border`, 오늘 칸은 `--accent` 윤곽, 시간 블록은 프로젝트 색 `--c`를 20% 투명 배경 + 왼쪽 3px 막대, 현재 시각 선은 `--accent`.
- [ ] **Step 4: 가상 회차·구글 일정** — 점선 카드는 `--border` 점선·`--muted` 글자 유지, 구글 일정은 `--surface-2` 배경으로 구분.
- [ ] **Step 5: 확인** — `npm run build && npm run test:e2e`. 기대: 기준선과 같은 통과 수.
- [ ] **Step 6: 눈으로 확인** — 예정·캘린더(일/주/월/년)·태그·설정을 360px/1280px에서 스크린샷하여 대비·넘침 확인.
- [ ] **Step 7: Commit** — `git commit -am "style: dark redesign for upcoming, calendar, tags, settings"`

### Task 5: 마무리 검증

- [ ] **Step 1:** `npm run lint && npm test && npm run test:e2e`. 기대: 모두 통과(기준선의 기존 실패는 그대로 보고).
- [ ] **Step 2:** `git diff --stat main..` 로 변경 파일이 `client/src/ui/styles.css`, `client/src/ui/today.ts`, `client/src/views.ts`, 테스트 1개, `index.html`, `manifest.webmanifest`, 문서뿐임을 확인한다. 그 밖의 `.ts`가 바뀌었으면 되돌린다.
- [ ] **Step 3:** 설치된 `~/Applications/TodoApp.app`·배포본에는 `npm run build` 결과가 따로 반영돼야 한다는 점을 사용자에게 알린다(배포는 이 계획에 포함하지 않음).

---

**Self-review:** 스펙의 팔레트(T1), 링·문구(T2), 카드·칩·막대(T3), 전 화면(T4), 테마색(T1), 검증(T5)을 모두 다룬다. "지금 중요" 묶음은 스펙에서 의도적으로 뺐다. `todayProgress` 이름·시그니처는 T2 안에서만 쓰인다.
