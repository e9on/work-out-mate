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
  // 모델은 git에 없어서 CI에는 없다. 경고만 하고 넘어간다(APK 권한 검사에는 필요 없다).
  console.warn(`경고: ${modelSrc} 이 없어서 모델은 복사하지 않아요. 실제 카메라 실행에는 필요해요(인터넷에서 받지 않아요).`);
} else {
  copyFileSync(modelSrc, resolve(dstDir, MODEL));
  console.log(`모델 복사: ${modelSrc} -> ${resolve(dstDir, MODEL)}`);
}
