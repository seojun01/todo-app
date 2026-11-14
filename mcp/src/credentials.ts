// 이 기기("Claude")의 서버 주소와 세션 토큰을 내 컴퓨터에만 저장한다. 저장소에는 올리지 않는다.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Credentials {
  url: string;
  deviceId: string;
  token: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TODO_MCP_CREDENTIALS?.trim() || join(homedir(), '.config', 'todo-mcp', 'credentials.json');
}

export function loadCredentials(path: string): Credentials | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw) as Partial<Credentials>;
    if (typeof j.url === 'string' && typeof j.deviceId === 'string' && typeof j.token === 'string') {
      return { url: j.url, deviceId: j.deviceId, token: j.token };
    }
  } catch {
    // 손상된 파일은 없는 것으로 본다
  }
  return null;
}

/** 토큰이 들어 있으므로 폴더 0700, 파일 0600 으로 쓴다 */
export function saveCredentials(path: string, c: Credentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
