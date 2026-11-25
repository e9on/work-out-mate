// 빌드 결과(dist)에서 개인 신체 데이터 폴더를 지운다.
// public/mediapipe/bench/ 에는 본인 운동 영상·녹화가 있어 vite가 dist로 그대로 복사한다(APK·PC 앱에 섞여 들어감).
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
for (const p of ['mediapipe/bench']) {
  const full = dist + p;
  if (existsSync(full)) {
    rmSync(full, { recursive: true, force: true });
    console.log(`개인 데이터 폴더를 빌드 결과에서 뺌: dist/${p}`);
  }
  if (existsSync(full)) throw new Error(`dist/${p}를 지우지 못함 — 빌드를 멈춤`);
}
