// electron/main.ts, preload.ts 를 electron-dist/ 로 번들한다 (CommonJS, electron은 외부 모듈).
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: { main: resolve(root, 'electron/main.ts'), preload: resolve(root, 'electron/preload.ts') },
  outdir: resolve(root, 'electron-dist'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
});
