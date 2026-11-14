# 할 일 앱 MCP 서버

Claude(Claude Code, Claude Desktop)가 할 일 앱의 할 일을 읽고 바꿀 수 있게 해 주는 [MCP](https://modelcontextprotocol.io) 서버예요.
"오늘 할 일 알려 줘", "내일 오후 3시 치과 예약 추가해 줘", "장보기 끝냈어" 같은 말로 쓸 수 있어요.

## 어떻게 동작하나

```
Claude ──(stdio)──> mcp/src/main.ts ──(HTTPS, 기기 토큰)──> https://todo.home.arpa/api/changes
```

- 이 서버는 앱의 **또 하나의 기기("Claude")**예요. 아이폰이나 맥처럼 페어링하고, 같은 동기화 API(`GET/POST /api/changes`)로 읽고 씁니다. **홈서버는 수정하지 않아요.**
- 검증, 반복 완료, 버전(HLC) 규칙은 앱과 같은 `shared/` 코드를 그대로 써서, Claude가 한 변경도 앱에서 한 것과 똑같이 모든 기기에 동기화돼요.
- 의존성이 없어요(Node 내장 기능만). MCP 프로토콜(stdio JSON-RPC)도 직접 구현했어요.
- 집 Wi-Fi나 WireGuard에 연결돼 있을 때만 동작해요(서버가 홈망 안에만 열려 있어서).

## 도구

| 도구 | 하는 일 | 데이터를 바꾸나 |
|---|---|---|
| `list_tasks` | 오늘·예정·기한 지남·기한 없음·전체 목록 (프로젝트·태그로 거르기) | 아니요 |
| `search_tasks` | 제목·태그 검색 | 아니요 |
| `list_projects` | 프로젝트와 미완료 개수 | 아니요 |
| `add_task` | 할 일 추가 (기한·시각·길이·우선순위·프로젝트·태그·알림·반복) | 예 |
| `update_task` | 일부 항목 수정 | 예 |
| `complete_task` | 완료 (반복 할 일은 다음 회차로 넘김) | 예 |
| `reopen_task` | 완료 취소 | 예 |
| `delete_task` | 삭제 (모든 기기에서 사라짐) | 예 |

프로젝트를 새로 만들거나 지우는 도구는 없어요. 반복 할 일은 현재 기한의 할 일 하나만 보여요(앱의 "예정" 화면의 미리보기 회차는 안 나와요).

## 설치 (한 번)

**1. 서버에서 페어링 코드 받기** (홈서버 LXC)

```bash
todo-admin pair --name "Claude"
```

**2. 맥에서 등록하기** (코드는 10분 안에, 한 번만 쓸 수 있어요)

```bash
cd ~/Documents/todo-app
mcp/bin/todo-mcp pair --url https://todo.home.arpa --code ABCD-EFGH
mcp/bin/todo-mcp status        # 연결됨: https://todo.home.arpa · 미완료 할 일 N개
```

토큰은 `~/.config/todo-mcp/credentials.json`(권한 0600)에만 저장돼요. 이 파일은 비밀번호와 같으니 공유하거나 저장소에 올리지 마세요.

**3. Claude에 연결하기**

Claude Code:

```bash
claude mcp add todo --scope user -- ~/Documents/todo-app/mcp/bin/todo-mcp
claude mcp list        # todo 가 Connected 로 보여야 해요
```

서버 이름(`todo`)은 **옵션보다 앞에** 써야 해요. `-e` 는 값을 여러 개 받는 옵션이라 이름이 뒤에 오면 환경 변수 값으로 읽혀서 `missing required argument 'commandOrUrl'` 오류가 나요.

Claude Desktop (`claude_desktop_config.json`의 `mcpServers`에 추가. Node를 nvm으로 설치했다면 `NODE`에 절대 경로를 주세요):

```json
{
  "mcpServers": {
    "todo": {
      "command": "/Users/<내 계정>/Documents/todo-app/mcp/bin/todo-mcp",
      "env": { "NODE": "/Users/<내 계정>/.nvm/versions/node/v22.21.0/bin/node" }
    }
  }
}
```

연결한 뒤 Claude에게 "내 할 일 보여 줘"라고 해 보세요.

## 안전하게 쓰기

- **읽기 전용으로 시작하기**: 환경 변수 `TODO_MCP_READONLY=1`을 주면 쓰기 도구가 목록에서 아예 빠져요. Claude Code라면 `claude mcp add todo --scope user -e TODO_MCP_READONLY=1 -- ~/Documents/todo-app/mcp/bin/todo-mcp`로 추가하세요(쓰기를 켜려면 `claude mcp remove todo` 후 `-e` 없이 다시 추가).
- Claude Code는 도구를 처음 쓸 때 허락을 물어요. 조회 도구만 "항상 허용"하고 쓰기 도구는 매번 확인하는 걸 권장해요.
- **차단하기**: 서버에서 `todo-admin devices`로 "Claude" 기기의 ID를 보고 `todo-admin revoke <ID>`를 하면 즉시 끊겨요.
- 삭제도 앱의 삭제와 같아서 모든 기기에서 사라지고, 앱의 "실행 취소"는 MCP로 한 삭제에는 쓸 수 없어요(되돌리려면 앱에서 다시 만드세요). 서버의 일일 백업(`todo-backup`)이 최후의 수단이에요.

## 설정

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `TODO_MCP_READONLY` | (꺼짐) | `1`이면 읽기 도구만 제공 |
| `TODO_TIMEZONE` | `Asia/Seoul` | "오늘"을 계산할 시간대 |
| `TODO_MCP_CREDENTIALS` | `~/.config/todo-mcp/credentials.json` | 등록 정보 파일 위치 |
| `NODE` | `node` | `bin/todo-mcp`가 쓸 Node 실행 파일 |

## 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `unable to get local issuer certificate` | Node가 Caddy 인증서를 신뢰하지 않아요. `node`를 직접 부르지 말고 `mcp/bin/todo-mcp`로 실행하세요(`--use-system-ca`를 붙여요). 맥 키체인에서 인증서를 신뢰해 둬야 해요 |
| `홈서버에 연결하지 못했어요` | 집 Wi-Fi나 WireGuard에 연결돼 있는지, `https://todo.home.arpa/api/health`가 열리는지 확인 |
| `이 기기(Claude)의 등록이 해제되었거나…` (401) | `todo-admin revoke`로 해제된 거예요. 새 코드로 `pair`를 다시 하세요 |
| `이 기기가 아직 홈서버에 등록되지 않았어요` | 위 "설치 2번"을 하세요 |
| Claude Desktop 로그에 `Operation not permitted` | 데스크톱 앱이 띄우는 프로세스는 macOS가 막는 `~/Documents` 안의 파일을 실행하지 못해요(폴더 권한을 켜도 안 되는 경우가 있어요). `mcp/bin/install-local`로 실행 파일을 `~/.local/share/todo-mcp`에 복사하고, 데스크톱 설정의 `command`를 `~/.local/share/todo-mcp/mcp/bin/todo-mcp`(절대 경로)로 바꾸세요. 코드를 고치면 `install-local`을 다시 실행해서 복사본을 갱신하세요 |
| Claude Desktop에서 `node`를 못 찾음 | 설정의 `env.NODE`에 Node 절대 경로를 넣으세요 (`which node`) |
| `다른 기기에서 먼저 바뀌어서 반영되지 않았어요` | 같은 할 일을 동시에 고친 거예요. 목록을 다시 보고 한 번 더 시도하세요 |

## 개발

```bash
npm test                       # mcp/tests 도 함께 돌아요 (메모리 DB의 실제 서버를 띄워서 검증)
node --test "mcp/tests/**/*.test.ts"
```

코드: `src/tasks.ts`(할 일 로직) · `src/tools.ts`(도구 정의) · `src/rpc.ts`(프로토콜) · `src/client.ts`(서버 API) · `src/main.ts`(진입점·페어링).
