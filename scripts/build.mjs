// 클라이언트 번들: client/src/main.ts, client/src/sw.ts → client/dist/
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

rmSync('client/dist', { recursive: true, force: true });
mkdirSync('client/dist', { recursive: true });
cpSync('client/public', 'client/dist', { recursive: true });

const common = { bundle: true, target: 'es2022', sourcemap: true, logLevel: 'warning' };

// 앱 본체 (ES module). styles.css 는 main.ts 가 import 하며 main.css 로 함께 나온다.
await build({
  ...common,
  entryPoints: { main: 'client/src/main.ts' },
  outdir: 'client/dist',
  format: 'esm',
});

// 서비스 워커는 모듈 서비스 워커 지원이 불균일하므로 IIFE 로 만든다. (아직 없는 단계에서는 건너뛴다)
if (existsSync('client/src/sw.ts')) {
  await build({
    ...common,
    entryPoints: { sw: 'client/src/sw.ts' },
    outdir: 'client/dist',
    format: 'iife',
    // 배포마다 캐시 이름이 달라지게 해서 이전 앱 셸 캐시가 정리되도록 한다
    define: { __BUILD_ID__: JSON.stringify(String(Date.now())) },
  });
}

console.log('build ok → client/dist');
