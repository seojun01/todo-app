// 헌법의 "린트/포맷 검사 통과" 게이트. 타입 검사는 `npm run typecheck` 가 맡고, 이 스크립트는
// (a) 금지 API, (b) 런타임 의존성 0, (c) 런타임 코드의 외부 패키지 import 를 검사한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['shared', 'server/src', 'client/src'];
const BANNED = [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/];

const problems = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'tests') continue;
      yield* walk(p);
    } else if (['.ts', '.mts'].includes(extname(p))) {
      yield p;
    }
  }
}

for (const root of ROOTS) {
  let files = [];
  try {
    files = [...walk(root)];
  } catch {
    continue; // 아직 없는 폴더
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const re of BANNED) {
        if (re.test(code)) problems.push(`${file}:${i + 1}: 금지 API ${re}`);
      }
      const m = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/.exec(line) ?? /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
      if (m) {
        const spec = m[1];
        const ok = spec.startsWith('.') || spec.startsWith('node:');
        if (!ok) problems.push(`${file}:${i + 1}: 외부 패키지 import '${spec}' (런타임 의존성 0 위반)`);
      }
    });
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  problems.push(`package.json: 런타임 dependencies 가 비어 있지 않음 (${Object.keys(pkg.dependencies).join(', ')})`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nlint 실패: ${problems.length}건`);
  process.exit(1);
}
console.log('lint ok');
