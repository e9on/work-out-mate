// node_modules의 MediaPipe wasm을 public/mediapipe/wasm/ 로 복사한다 (외부 CDN 사용 금지).
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, '../node_modules/@mediapipe/tasks-vision/wasm'),
  resolve(here, '../../../node_modules/@mediapipe/tasks-vision/wasm'),
];
const src = candidates.find(existsSync);
if (!src) throw new Error('@mediapipe/tasks-vision/wasm 을 찾을 수 없다. npm install 먼저.');
const dst = resolve(here, '../public/mediapipe/wasm');
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`복사 완료: ${src} -> ${dst}`);
