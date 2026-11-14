# Contract: 동기화·푸시 HTTP API

**Base URL**: `https://todo.home.arpa` (Caddy가 TLS를 처리하고 `/api/*`를 Node 서버 `127.0.0.1:8080`으로 넘김)
**형식**: JSON (UTF-8). 타입 정의는 [data-model.md](../data-model.md)를 따른다.

## 공통 규칙

- **인증**: `/api/health`와 `/api/pair`를 뺀 모든 엔드포인트는 쿠키 `todo_session`이 필요하다. 없거나, 모르는 토큰이거나, 해제된 기기의 토큰이면 `401 {"error":"unauthorized"}`. 성공하면 `devices.last_seen_at`을 갱신한다.
- **CSRF**: `POST`/`PUT`/`DELETE` 요청에 `X-Todo-Client: 1` 헤더가 없으면 `403`.
- **오류 형식**: `{"error":"<code>","message":"<설명>","details"?:[...]}`
- **크기 제한**: 요청 본문 1 MiB 초과 시 `413`.
- **캐시**: 모든 `/api/*` 응답에 `Cache-Control: no-store`. Service Worker도 `/api/*`는 캐시하지 않는다.

---

## `GET /api/health`
인증 없음. `200 {"ok": true}`

## `POST /api/pair`
인증 없음. 일회용 페어링 코드로 기기를 등록한다.

요청: `{ "code": "K7Q2-M9XD", "deviceId": "<클라이언트가 만든 UUID v4>" }`

- `201 {"deviceId":"…","deviceName":"iPhone"}` + `Set-Cookie: todo_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=315360000` (`TODO_DEV=1`일 때만 `Secure` 제외)
- `400 {"error":"invalid_code"}`: 코드가 틀렸거나 만료·사용됨
- `400 {"error":"invalid_device_id"}`: UUID가 아니거나 이미 등록된 ID
- `429 {"error":"rate_limited"}`: 실패 1분 5회 초과

## `POST /api/changes` (push)

요청:
```json
{ "changes": [ { "type": "task" | "project" | "settings", "record": { … } }, … ] }
```
- `changes`는 1~500개. `record`는 data-model의 해당 타입 모든 필드(서버 내부 필드 제외)를 담는다.
- 레코드마다 서버가 `merge(stored, incoming)`을 하고 incoming이 이기면 반영하며 새 `seq`를 매긴다. 알림에 영향을 주는 필드가 바뀌었으면 `armed_at`을 갱신한다.
- 전체가 하나의 트랜잭션이다. 하나라도 검증에 실패하면 아무것도 반영하지 않는다.

응답 `200 {"applied":3,"ignored":1,"cursor":1042}`
- `ignored`: 서버에 이미 같거나 더 새로운 version이 있어 반영하지 않은 수(오류 아님).
- 오류: `400 {"error":"validation","details":[{"type":"task","id":"…","field":"title","rule":"length"}]}`, `401`, `403`, `413`

**멱등성**: 같은 요청을 여러 번 보내도 결과가 같다. 응답을 못 받은 push는 그대로 다시 보낸다.

## `GET /api/changes?since=<cursor>&limit=<n>` (pull)

- `since`: 0 이상 정수(처음 연결은 `0`). `limit`: 기본값·최대값 모두 1000.
- 응답 `200`:
  ```json
  { "changes": [ { "type": "task", "record": { … } }, … ], "cursor": 1042, "hasMore": false }
  ```
  세 종류의 레코드가 `seq` 오름차순으로 섞여 온다. 툼스톤도 포함된다. `hasMore`가 `true`이면 받은 `cursor`로 다시 요청한다.
- 클라이언트는 받은 레코드의 `merge`와 `cursor` 저장을 한 트랜잭션으로 처리한다.
- **서버 복원 감지**: 서버가 응답한 `cursor`가 클라이언트에 저장된 cursor보다 **작으면** 서버가 백업에서 복원된 것이다. 이때 클라이언트는 모든 로컬 레코드를 `dirty`로 표시하고 cursor를 0으로 되돌린 뒤 push와 pull을 차례로 한다.

## `GET /api/events` (SSE)

- `Content-Type: text/event-stream`. 연결 직후와 seq가 증가할 때마다 `event: cursor` / `data: {"cursor":1042}`. 25초마다 `: ping`. 기기가 해제되면 서버가 스트림을 닫고 이후 재연결은 401.
- 클라이언트는 받은 cursor가 저장된 값보다 크면 pull한다.

## `GET /api/devices/me`
`200 {"deviceId":"…","deviceName":"iPhone","createdAt":"…","push":{"subscribed":true,"enabled":true,"timezone":"Asia/Seoul"}}`

---

## 푸시 알림

### `GET /api/push/key`
`200 {"publicKey":"<VAPID 공개키, base64url 비압축 P-256 점>"}`

### `PUT /api/devices/me/push`
이 기기의 푸시 구독, 시간대, 켜기/끄기를 등록하거나 갱신한다(앱을 열 때와 시간대가 바뀔 때도 호출).

요청:
```json
{
  "subscription": { "endpoint": "https://web.push.apple.com/…", "keys": { "p256dh": "…", "auth": "…" } },
  "timezone": "Asia/Seoul",
  "enabled": true
}
```
- `204`: 저장됨
- `400 {"error":"invalid_endpoint"}`: `https:`가 아니거나 허용 호스트(`web.push.apple.com`, `*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`)가 아님(SSRF 방지)
- `400 {"error":"invalid_timezone"}`: 알 수 없는 IANA 시간대
- `subscription`을 생략하면 기존 구독은 그대로 두고 `timezone`/`enabled`만 갱신한다.

### `DELETE /api/devices/me/push`
이 기기의 구독을 삭제한다. `204`.

### `POST /api/push/test`
이 기기에 테스트 푸시 하나를 즉시 보낸다(설정 화면의 "테스트 알림 보내기"). `202`. 구독이 없으면 `409 {"error":"not_subscribed"}`.

### 서버가 보내는 푸시 (기기로 가는 메시지)

- 전송: Web Push (RFC 8030), 암호화 RFC 8291 `aes128gcm`, 서버 식별 VAPID (RFC 8292). 헤더 `TTL: 900`, `Urgency: high`, `Topic`은 쓰지 않는다.
- **평문 페이로드(암호화 전)**: `{"v":1,"taskId":"<UUID>"}` 또는 테스트용 `{"v":1,"test":true}`.
- **페이로드에는 제목·프로젝트 이름 등 할 일의 내용을 넣지 않는다** (FR-027, SC-014).
- 서비스 워커는 이를 받아 고정 문구 "할 일 1건이 있어요"로 알림을 표시하고 `tag`는 `task-<taskId>`로 한다.

### 서버 푸시 응답 처리
`404`/`410` → 구독 삭제. `429`/`5xx` → 발화 시각 + 15분 안에서만 다음 tick에 재시도. 그 밖의 `4xx` → 오류 로그, 재시도 없음.

---

## 계약 테스트 목록 (`server/tests/contract/`)

**인증·기기**
1. 쿠키 없이 `/api/changes`를 호출하면 401.
2. 해제된 기기의 쿠키로 호출하면 401.
3. 페어링 코드는 한 번만 성공. 같은 코드를 다시 쓰면 400.
4. 만료된 코드는 400. 이미 등록된 `deviceId`는 `invalid_device_id`.
5. `X-Todo-Client` 헤더가 없는 쓰기 요청은 403.

**동기화**
6. task/project/settings를 push한 뒤 pull(`since=0`)하면 같은 레코드가 `seq` 순서로 나온다.
7. 같은 id에 version이 더 작은 레코드를 push하면 `ignored=1`이고 저장값은 바뀌지 않는다.
8. 같은 push를 두 번 보내면 두 번째는 `applied=0`.
9. 검증 실패(제목 0자·201자·공백뿐, 날짜 `2026-02-30`, `dueTime`만 있고 `dueDate` 없음, 반복인데 `dueDate` 없음, 우선순위 5, 프로젝트 이름 51자, 알 수 없는 색상, 주 단위 반복인데 `weekdays` 없음, 잘못된 reminders 조합)는 400이며 전체가 롤백된다.
10. `limit` 페이지 나누기를 따라가도 레코드가 빠지거나 중복되지 않는다. 세 종류가 섞여도 `seq` 순서가 유지된다.
11. SSE 연결 중 다른 클라이언트가 push하면 1초 안에 `cursor` 이벤트가 온다. 기기를 해제하면 스트림이 닫힌다.

**푸시**
12. `PUT /api/devices/me/push`: 허용되지 않은 호스트·`http:` 엔드포인트는 400, 잘못된 시간대는 400, `subscription` 생략 시 `enabled`만 갱신.
13. `GET /api/push/key`는 인증이 필요하고 서버를 다시 시작해도 같은 키를 돌려준다.
14. `POST /api/push/test`가 가짜 푸시 서비스에 RFC 8291대로 암호화된 요청을 보내고, 복호화한 페이로드에 `test:true`만 있다.
