// MediaPipe 자산을 public/mediapipe/ 로 복사한다(외부 CDN·인터넷 다운로드 금지).
// - wasm: node_modules의 @mediapipe/tasks-vision/wasm
// - 모델: 시험용 앱(apps/spike/public/mediapipe/)에 이미 있는 pose_landmarker_lite.task
// 자산은 git에서 제외한다. 빌드·테스트는 자산 없이도 통과한다(실제 카메라 실행에만 필요).
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wasmCandidates = [
  resolve(here, '../node_modules/@mediapipe/tasks-vision/wasm'),
  resolve(here, '../../../node_modules/@mediapipe/tasks-vision/wasm'),
];
const wasmSrc = wasmCandidates.find(existsSync);
if (!wasmSrc) throw new Error('@mediapipe/tasks-vision/wasm 을 찾을 수 없어요. npm install 먼저 하세요.');
const dstDir = resolve(here, '../public/mediapipe');
const wasmDst = resolve(dstDir, 'wasm');
mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });
console.log(`wasm 복사: ${wasmSrc} -> ${wasmDst}`);

const MODEL = 'pose_landmarker_lite.task';
const modelSrc = resolve(here, '../../spike/public/mediapipe', MODEL);
if (!existsSync(modelSrc)) {
  throw new Error(`${modelSrc} 이 없어요. 시험용 앱의 모델 파일을 먼저 준비하세요(인터넷에서 받지 않아요).`);
}
copyFileSync(modelSrc, resolve(dstDir, MODEL));
console.log(`모델 복사: ${modelSrc} -> ${resolve(dstDir, MODEL)}`);
