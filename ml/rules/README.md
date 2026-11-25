# 규칙 판정 기준선

core의 스쿼트 규칙(`computeSquatRepMetrics` + `judgeSquat`)을 test_own 반복에 그대로 돌려, 학습 모델과 견줄 기준선을 만든다.
core 코드는 수정하지 않고 import만 한다.

- `run_rules.ts`: 입력 JSON(녹화별 원본 프레임과 반복 시각) -> 반복별 `{kneeIn, shallow, skipped}`.
  녹화 한 개가 세트 하나다(서 있을 때 기준값을 세트 전체 프레임으로 구하는 앱 방식 그대로).
  MediaPipe 33점은 엉덩이 23/24, 무릎 25/26, 발목 27/28, 뒤꿈치 29/30, 엄지발가락 31/32를 Halpe 11/12, 13/14, 15/16, 24/25, 20/21 자리에 넣는다.
- 한 번에 실행: `python ml/scripts/rules_baseline.py` (입출력·`metrics.json`은 `ml/runs/rules/`, git 제외)
- 수동 실행:
  `npx esbuild ml/rules/run_rules.ts --bundle --platform=node --outfile=ml/runs/rules/run_rules.cjs`
  `node ml/runs/rules/run_rules.cjs <in.json> <out.json>`
- 규칙이 내지 않는 칸(feetWide, trunkLean)은 "규칙 없음"으로 표시하고 지표에서 뺀다.
