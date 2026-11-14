// 할 일 앱 MCP 서버. Claude Code·Claude Desktop 이 자식 프로세스로 실행한다 (stdio).
//   node mcp/src/main.ts pair --url https://todo.home.arpa --code ABCD-EFGH   이 기기("Claude")를 서버에 등록
//   node mcp/src/main.ts status                                               등록 상태 확인
//   node mcp/src/main.ts                                                      MCP 서버로 실행 (보통 Claude 가 실행한다)
// 환경 변수: TODO_MCP_READONLY=1 (읽기 도구만), TODO_TIMEZONE (기본 Asia/Seoul), TODO_MCP_CREDENTIALS (저장 파일 경로)
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimeZone } from '../../shared/tz.ts';
import { ApiError, TodoClient, pair } from './client.ts';
import { credentialsPath, loadCredentials, saveCredentials } from './credentials.ts';
import { serve } from './rpc.ts';
import { ToolError, type Ctx } from './tasks.ts';
import { buildTools } from './tools.ts';

const USAGE = `사용법:
  pair --url <서버 주소> --code <페어링 코드>   서버에서 'todo-admin pair --name "Claude"' 로 받은 코드로 등록
  status                                      등록 상태와 서버 연결을 확인
  (인자 없음)                                 MCP 서버로 실행`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  const path = credentialsPath(env);

  if (cmd === 'pair') {
    const url = flag(rest, '--url') ?? env.TODO_URL;
    const code = flag(rest, '--code');
    if (!url || !code) {
      console.error(USAGE);
      return 2;
    }
    try {
      const creds = await pair(url, code);
      saveCredentials(path, creds);
      console.log(`등록했어요: ${creds.url} (기기 ID ${creds.deviceId})\n저장 위치: ${path} (이 파일은 비밀번호와 같아요. 공유하거나 올리지 마세요)`);
      return 0;
    } catch (err) {
      console.error(err instanceof ApiError ? `등록하지 못했어요: ${err.message}` : String(err));
      return 1;
    }
  }

  if (cmd === 'status') {
    const creds = loadCredentials(path);
    if (!creds) {
      console.error(`아직 등록하지 않았어요 (${path}). 'pair' 로 먼저 등록하세요.`);
      return 1;
    }
    try {
      const snap = await new TodoClient(creds).pullAll();
      const open = [...snap.tasks.values()].filter((t) => !t.deleted && !t.done).length;
      console.log(`연결됨: ${creds.url} · 미완료 할 일 ${open}개 · 프로젝트 ${[...snap.projects.values()].filter((p) => !p.deleted).length}개`);
      return 0;
    } catch (err) {
      console.error(err instanceof ApiError ? err.message : String(err));
      return 1;
    }
  }

  if (cmd !== undefined && cmd !== 'serve') {
    console.error(USAGE);
    return 2;
  }

  const tz = env.TODO_TIMEZONE?.trim() || 'Asia/Seoul';
  if (!isValidTimeZone(tz)) {
    console.error(`TODO_TIMEZONE 이 올바르지 않아요: ${tz}`);
    return 2;
  }
  const readOnly = env.TODO_MCP_READONLY === '1';
  // 등록하지 않았어도 서버는 뜨고, 도구를 부르면 등록 방법을 알려 준다 (Claude 쪽 목록에서 서버가 사라지지 않게)
  const getCtx = (): Ctx => {
    const creds = loadCredentials(path);
    if (!creds) {
      throw new ToolError(`이 기기가 아직 홈서버에 등록되지 않았어요. 서버에서 todo-admin pair --name "Claude" 로 코드를 받고, 터미널에서 'node mcp/src/main.ts pair --url <서버 주소> --code <코드>' 를 실행하세요.`);
    }
    return { client: new TodoClient(creds), deviceId: creds.deviceId, now: () => new Date(), tz };
  };
  await serve(buildTools(getCtx, { readOnly }), {
    input: process.stdin,
    output: process.stdout,
    info: { name: 'todo-app', version: '0.1.0' },
    log: (m) => console.error(m),
  });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
