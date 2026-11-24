// Windows x64 폴더(out/)로 포장한다. 앱에는 package.json, dist/, electron-dist/ 만 넣는다.
import { packager } from '@electron/packager';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = /^\/(package\.json|dist|electron-dist)(\/|$)/;
const paths = await packager({
  dir: root,
  out: resolve(root, 'out'),
  name: 'WorkOutMate',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  prune: false, // 번들에 다 들어 있어 node_modules 는 필요 없다(워크스페이스에서 prune이 꼬이는 것도 피한다)
  asar: false,
  ignore: (p) => p !== '' && !keep.test(p),
});
console.log('포장 완료:', paths.join(', '));
