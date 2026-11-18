# 스파이크 앱 (Phase 0 검증용, 버리는 코드)

MediaPipe Pose Landmarker 웹판의 속도·정확도를 PC 웹캠과 폰에서 재고, 랜드마크를 녹화한다.

## 준비 (최초 1회)

모델과 wasm은 용량 때문에 git에 없다. 저장소 루트에서:

```bash
npm install
npm run copy-wasm -w apps/spike        # node_modules의 wasm을 public/mediapipe/wasm/ 로 복사
cd apps/spike/public/mediapipe
curl -fLO https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task   # 5,777,746 바이트
curl -fLO https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task   # 9,398,198 바이트
```

## 실행

```bash
npm run dev -w apps/spike     # http://localhost:5173
npm run build -w apps/spike   # 타입 검사 + 번들
```

카메라는 localhost 또는 https에서만 켜진다. 녹화 파일은 `wom-<운동>-<모델>-<날짜>.json`으로 다운로드되고,
`npm run replay -w packages/core -- <파일>` 로 재생해 count를 비교한다.
