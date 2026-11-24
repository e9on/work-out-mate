# 운동 뒤 자세 분석 (스쿼트) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세트마다 영상을 폰 안에 녹화하고, 쉬는 시간에 RTMPose-m으로 다시 분석해 반복별 스쿼트 자세 오류(깊이 부족·무릎 모임·뒤꿈치 들림)와 세트 요약(빨리 내려감)을 결과 화면에 보여 주며, 맞아요/틀려요 정답과 동의한 학습 데이터를 모아 PC로 내보낸다.

**Architecture:** 판정 규칙은 `@wom/core`의 순수 TS(`form/`)로 두고 합성 관절점으로 테스트한다. 앱은 포트(MediaStore, FormPoseModel, SetCapture, VideoFrameReader)로 녹화·저장·모델·영상 읽기를 나누고, 분석 대기열이 실시간 세기가 쉬는 동안에만 돌게 한다. 반복 번호와 시각은 실시간 카운터(lite)가 확정한 값을 그대로 쓴다.

**Tech Stack:** TypeScript, React 18, Vitest + jsdom + testing-library, idb(IndexedDB), MediaRecorder, onnxruntime-web 1.20.1(WebGPU→WASM), RTMPose-m Halpe26 ONNX, Capacitor 8(Android), @capacitor/filesystem.

**Spec:** `docs/specs/2026-11-24-form-analysis-design.md` (2026-11-24 승인)

## Global Constraints

- 사용자에게 보이는 모든 문구는 한국어. 코드 주석도 한국어(기존 관례).
- 네트워크 요청 0건. 서버·클라우드·업로드 없음. 공유하기(다른 앱으로 보내기) 없음. Android INTERNET 권한 없음, allowBackup=false, CSP 유지.
- CSP 때문에 인라인 style 금지, src에서 변수명 `style` 금지(styleScan 테스트가 막는다).
- 새 의존성은 이 두 개만: `onnxruntime-web@1.20.1`(MIT), `@capacitor/filesystem@^8.1.5`(시험용 앱과 같은 버전). **설치 전에 사용자 허락**을 받는다(실행 시작 때 한 번 묻는다).
- 모델 파일은 git에 넣지 않는다. `copy-wasm` 스크립트가 로컬 경로에서 `apps/app/public/`으로 복사한다(인터넷에서 받지 않음).
  - RTMPose-m: `apps/spike/public/mediapipe/bench/rtmpose-m.onnx`
  - ORT wasm: `apps/spike/public/mediapipe/ort/ort-wasm-simd-threaded*.{mjs,wasm}`
- 개인 신체 데이터(영상·관절 좌표·녹화 JSON)는 git에 넣지 않는다. `packages/core/test/fixtures/private/`는 git 제외.
- 판정에는 거리 절댓값(cm)을 쓰지 않고 각도와 비율만 쓴다. 화면에 거리·각도 숫자를 보여 주지 않는다.
- 판정 기준값(모두 `SQUAT_RULES` 한곳에 둔다)
  - 깊이 부족: 바닥 무릎 각도(2D) **> 100°**
  - 무릎 모임 ①: 무릎 간격 ÷ 서 있을 때 발목 간격 **< 0.9** 지적, **0.9~1.1 보류**(지적 안 함)
  - 무릎 모임 ②(보조): ①에 안 걸린 반복이 '평소'보다 **15% 이상** 낮음. 평소 = 같은 운동, 바닥 무릎 각도 **±10°** 반복 값의 중앙값, 비교 반복 **5개 미만이면 판정 안 함**
  - 뒤꿈치: (엄지발가락 y − 뒤꿈치 y) ÷ 정강이 길이, 서 있을 때 값을 뺀 값 **≥ 0.25**
  - 빨리 내려감: 세트 평균 내려가는 시간 **< 1000ms**면 세트 요약 한 줄
  - 바닥 시각 앞뒤 **150ms** 중앙값, 서 있음 = 무릎 각도 **> 160°**, 내려가기 시작 = 서 있음 기준 **−15°**
- 분석은 **15fps**(33.3ms × 2 간격), 사람 영역은 lite 관절점 상자 + RTMPose 기본 여유 **1.25배**(더 넓히지 않음).
- RTMPose 전처리: 192×256 비율 맞춤, MEAN (123.675, 116.28, 103.53) / STD (58.395, 57.12, 57.375)를 **BGR 순서**에 적용, SimCC 출력 argmax ÷ 2.
- Halpe26 인덱스: 엉덩이 11/12, 무릎 13/14, 발목 15/16, 엄지발가락 20/21, 뒤꿈치 24/25.
- 동의 문구 버전 `v1`, 문구는 설계 6.4절 그대로.
- 보관: 루틴마다 최근 3회 기록은 전체 영상, 그보다 오래된 기록은 지적·라벨이 붙은 반복의 [시작−1초, 끝+1초] 구간만.
- 기존 기록(반복 시각·영상 없음)은 지금처럼 열려야 한다.

## Review Focus

1. **사람이 화면에서 벗어난 프레임 / lite 상자가 없는 구간** → 그 반복은 판정 보류(지적 없음), 세트 분석은 계속. Task 2(판정)와 Task 6(대기열)이 테스트한다.
2. **분석 도중 앱 종료·백그라운드** → 다음 실행 때 분석 안 된 세트만 이어서 분석, 같은 세트를 두 번 분석하지 않음. Task 6이 테스트한다.
3. **영상 저장 끔 / MediaRecorder 미지원·실패 / 카메라 스트림 없음** → 횟수 세기·저장은 그대로, 결과 화면에 "영상 없음" 사유. Task 5와 Task 7이 테스트한다.
4. **기존 기록(reps 시각·영상·분석 없음)** → 기록 목록·상세가 지금처럼 보이고 자세 영역은 숨김. Task 1과 Task 7이 테스트한다.
5. **반복 0~1회 세트, 세트 끝 버튼·그만하기로 끝난 세트** → 판정이 깨지지 않고 상대 기준은 적용 안 됨(비교 5개 미만). Task 2와 Task 5가 테스트한다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `packages/core/src/session/model.ts` (수정) | `RepTiming`, `SetResult.reps?` |
| `packages/core/src/session/setRunner.ts`, `routineRunner.ts` (수정) | 반복 시각을 결과·기록에 담기 |
| `packages/core/src/form/halpe.ts` | Halpe26 인덱스, `Kp2`, `KpFrame` |
| `packages/core/src/form/squatRules.ts` | `SQUAT_RULES`, `computeSquatRepMetrics`, `judgeSquat` |
| `packages/core/src/index.ts` (수정) | form 내보내기 |
| `apps/app/src/form/types.ts` | 앱 쪽 자세 분석 타입(SetVideo, SetAnalysis, RepLabel 등) |
| `apps/app/src/ports/mediaStore.ts` | MediaStore 포트 |
| `apps/app/src/storage/idbMediaStore.ts`, `memoryMediaStore.ts` | 구현(IDB는 같은 DB의 버전 2) |
| `apps/app/src/form/rtmposeCodec.ts` | 크롭 계산·입력 텐서·SimCC 해석(순수 함수) |
| `apps/app/src/platform/rtmposeOrt.ts` | onnxruntime-web 세션(FormPoseModel 구현) |
| `apps/app/src/form/setCapture.ts` | 세트 녹화 + lite 상자 수집 + 저장 + 대기열 넣기 |
| `apps/app/src/platform/mediaRecorderCapture.ts` | MediaRecorder 래퍼 |
| `apps/app/src/form/analysisQueue.ts` | 분석 대기열(쉬는 동안만, 이어서 하기) |
| `apps/app/src/platform/videoFrameReader.ts` | Blob 영상을 시각별로 읽기 |
| `apps/app/src/screens/FormFindings.tsx` | 세트별 지적 목록 + 맞아요/틀려요 |
| `apps/app/src/screens/RepPlayer.tsx` | 영상 재생·겹치기·느리게·직접 라벨 |
| `apps/app/src/screens/Settings.tsx`, `ConsentPrompt.tsx` | 설정, 동의 |
| `apps/app/src/form/retention.ts` | 보관 규칙 |
| `apps/app/src/form/exportData.ts`, `platform/exportFile.ts` | 학습 데이터 내보내기 |

---

### Task 1: 반복 시각을 세트 기록에 남기기 (core)

**Files:**
- Modify: `packages/core/src/session/model.ts`, `packages/core/src/session/setRunner.ts` (finish), `packages/core/src/session/routineRunner.ts` (record), `packages/core/src/index.ts`
- Test: `packages/core/test/setRunner.test.ts`, `packages/core/test/routineRunner.test.ts`

**Interfaces:**
- Produces: `export type RepTiming = { index: number; startT: number; bottomT: number; endT: number }` (index는 1부터, 세트 안 반복 번호). `SetResult.reps?: RepTiming[]` — SetRunner가 반복 운동에서 채운다(프레임 시계). `SetLog.reps`는 RoutineRunner가 `toEpoch`로 바꾼 절대 시각. 버티기 운동은 빈 배열. 그만하기·세트 끝 되돌리기로 빠진 반복은 들어가지 않는다(`count === reps.length`).

- [ ] **Step 1: 실패 테스트**
  - `setRunner.test.ts`: "반복 3회 세트 결과의 reps는 길이 3, index 1·2·3, 각 startT < bottomT < endT, bottomT는 RepEvent.turnT"
  - `setRunner.test.ts`: "세트 끝(button)으로 마지막 반복이 되돌려지면 reps 길이 === count"
  - `routineRunner.test.ts`: "기록된 SetLog.reps 시각은 toEpoch(프레임 시각)" — `toEpoch = t => 5000 + t`로 확인
  - `routineRunner.test.ts`: "reps 필드가 없는 옛 세션 객체도 sessionSoFar·copy에서 깨지지 않는다"(reps 없는 SetLog를 담은 세션 복사)
- [ ] **Step 2: 실행해 실패 확인** — `npx vitest run -w packages/core test/setRunner.test.ts test/routineRunner.test.ts` → FAIL(reps undefined)
- [ ] **Step 3: 구현** — `finish`에서 `this.reps.map((r, i) => ({ index: i + 1, startT: r.startT, bottomT: r.turnT, endT: r.endT }))`. `record`와 `copyLog`·`copyResult`에서 reps를 복사하고 시각을 toEpoch로 바꾼다(reps가 없으면 그대로 없음).
- [ ] **Step 4: 통과 확인** — `npm test -w packages/core` 전체 PASS, `npm run typecheck -w packages/core` 통과
- [ ] **Step 5: 커밋** — `feat(core): 세트 기록에 반복별 시작·바닥·끝 시각`

### Task 2: 스쿼트 자세 지표와 판정 규칙 (core)

**Files:**
- Create: `packages/core/src/form/halpe.ts`, `packages/core/src/form/squatRules.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/squatRules.test.ts`, `packages/core/test/helpers/halpeBuilder.ts`(합성 관절점)

**Interfaces:**
- Consumes: `RepTiming` (Task 1)
- Produces:
  ```ts
  // halpe.ts
  export const HALPE = { L_HIP: 11, R_HIP: 12, L_KNEE: 13, R_KNEE: 14, L_ANKLE: 15, R_ANKLE: 16, L_BIG_TOE: 20, R_BIG_TOE: 21, L_HEEL: 24, R_HEEL: 25 } as const;
  export type Kp2 = { x: number; y: number; score: number };   // 화면 픽셀(y 아래가 +)
  export type KpFrame = { t: number; kps: Kp2[] | null };       // t는 RepTiming과 같은 시계, kps 26개 또는 null(사람 없음)
  // squatRules.ts
  export const SQUAT_ENABLED: Record<FindingKind, boolean> = { depth: true, kneeIn: true, kneeInRelative: true, heel: true }; // 정확도 기준(설계 8.1)을 못 넘는 항목은 false로 꺼서 내보내지 않는다
  export const SQUAT_RULES: { depthMaxKneeDeg: 100; kneeInAbs: 0.9; kneeInUncertainMax: 1.1; relativeDrop: 0.15; relativeMinPeers: 5; relativeDepthWindowDeg: 10; heelRise: 0.25; fastDescentMs: 1000; medianWindowMs: 150; standingKneeDeg: 160; descentStartDropDeg: 15; segmentOutlierRatio: 0.3; minScore: 0.3 };
  export type SquatRepMetrics = { index: number; bottomT: number; kneeDeg: number | null; kneeAnkleRatio: number | null; heelRise: number | null; descentMs: number | null; skipped: null | 'noPerson' | 'oneLeg' };
  export type FindingKind = 'depth' | 'kneeIn' | 'kneeInRelative' | 'heel';
  export type FormFinding = { index: number; kind: FindingKind; value: number };
  export type SetNote = { kind: 'fastDescent'; avgDescentMs: number };
  export type SquatJudgement = { findings: FormFinding[]; notes: SetNote[]; uncertain: number[] /* 0.9~1.1 보류 반복 index */ };
  export function computeSquatRepMetrics(frames: KpFrame[], reps: RepTiming[]): SquatRepMetrics[];
  export function judgeSquat(metrics: SquatRepMetrics[], history: SquatRepMetrics[], enabled?: Record<FindingKind, boolean>): SquatJudgement;
  ```
- 계산 규칙(설계 5절): 2D 각도·비율만. 무릎 각도 = 엉덩이–무릎–발목 양쪽 평균. 서 있을 때 발목 간격·뒤꿈치 기준 = 세트 안 무릎 각도 > 160° 프레임의 중앙값(없으면 kneeAnkleRatio·heelRise는 null). 바닥 값 = bottomT ±150ms 프레임 중앙값. 허벅지·정강이 길이가 세트 중앙값과 30% 넘게 다르거나 해당 점 score < 0.3인 프레임은 버린다. 양 무릎 각도 차이가 40° 넘으면 `skipped: 'oneLeg'`. 구간 안 유효 프레임이 없으면 `'noPerson'`. descentMs = (bottomT − 바닥 전에서 무릎 각도가 서 있음 기준−15° 아래로 처음 내려간 시각).
- 판정 순서(SQUAT_ENABLED가 false인 종류는 지적하지 않음): skipped면 판정 없음 → 깊이(>100) 지적되면 그 반복의 무릎 모임 판정 안 함 → ① <0.9 지적, 0.9~1.1이면 uncertain → ② ①에 안 걸리고 ≥1.1인 반복만, history+이번 세트 중 같은 깊이 ±10° 반복이 5개 이상일 때 중앙값×0.85 미만이면 `kneeInRelative` → 뒤꿈치 ≥0.25 → 세트 평균 descentMs < 1000이면 note.

- [ ] **Step 1: 합성 관절점 도우미** — `halpeBuilder.ts`에 `buildHalpe({ kneeDeg, kneeAnkleRatio, heelRise, t })` → KpFrame(정면 45도가 아니라 단순 정면 투영이면 충분). 서 있음·내려가기·바닥·올라오기 순서를 만드는 `squatRep({ startT, bottomT, endT, bottom: {...} })`.
- [ ] **Step 2: 실패 테스트** (`squatRules.test.ts`)
  - "바른 반복(바닥 무릎 각도 80°, 비율 1.5, 뒤꿈치 0.05)은 지적 없음"
  - "바닥 무릎 각도 110°면 depth 지적, 그 반복은 kneeIn 판정 안 함"
  - "비율 0.7이면 kneeIn, 1.0이면 uncertain에 들어가고 지적 없음, 1.2면 지적 없음"
  - "비교 반복 5개(같은 깊이)의 중앙값 1.6, 이번 1.3이면 kneeInRelative / 비교 4개면 판정 안 함 / 깊이 ±10° 밖 반복은 비교에서 제외"
  - "뒤꿈치 0.3이면 heel, 0.2면 없음"
  - "세트 평균 descentMs 600이면 fastDescent note(avgDescentMs 600), 1500이면 없음"
  - Review Focus 1: "바닥 ±150ms 구간 kps가 모두 null이면 skipped 'noPerson', 다른 반복 판정은 그대로"
  - "한쪽 무릎만 굽은 구간(왼 80°, 오른 170°)은 skipped 'oneLeg'"
  - Review Focus 5: "reps가 0개·1개여도 예외 없이 빈 결과 / 1개 결과, 상대 기준 없음"
  - "점수 0.1인 프레임과 정강이 길이가 2배로 튄 프레임은 중앙값에서 빠진다"
  - "SQUAT_ENABLED.heel을 false로 바꾸면(테스트에서 주입) heel 지적이 나오지 않는다" — judgeSquat에 세 번째 인자 `enabled = SQUAT_ENABLED`를 둔다
  - 개인 녹화 회귀(있을 때만): `fixtures/private/angle-test/rtm-litebox-1.0.json`(frames {t(ms), k, s}) + 바닥 시각 `[6.9, 9.5, 12, 14.4, 21.8, 24.3, 26.7, 29.2, 36.9, 40, 43.1, 46.1, 49.4, 51.6, 53.7, 55.6, 58.6, 60.8, 63, 65.2]`초(start=bottom−0.8s, end=bottom+0.8s). 기대: 깊이는 마지막 4개만, kneeIn은 5~8번만, heel은 9~12번만. 파일이 없으면 `it.skip`(기존 `setRunner.test.ts`의 private 처리 방식과 같게).
- [ ] **Step 3: 실패 확인** — `npx vitest run -w packages/core test/squatRules.test.ts` → FAIL(모듈 없음)
- [ ] **Step 4: 구현** — 위 Interfaces 규칙대로. 각도는 `acos` 클램프, 중앙값은 정렬 후 가운데.
- [ ] **Step 5: 통과 확인** — `npm test -w packages/core` PASS, typecheck 통과
- [ ] **Step 6: 커밋** — `feat(core): 스쿼트 자세 지표와 판정 규칙(깊이·무릎 모임·뒤꿈치·빠른 하강)`

### Task 3: MediaStore 포트와 저장소 (app)

**Files:**
- Create: `apps/app/src/form/types.ts`, `apps/app/src/ports/mediaStore.ts`, `apps/app/src/storage/idbMediaStore.ts`, `apps/app/src/storage/memoryMediaStore.ts`
- Modify: `apps/app/src/storage/idbStorage.ts` (DB 버전 2 업그레이드를 함께 쓰도록 open 함수를 공유)
- Test: `apps/app/test/mediaStore.test.ts` (fake-indexeddb, 메모리·IDB 둘 다 같은 테스트)

**Interfaces:**
- Consumes: `SquatRepMetrics, FormFinding, SetNote, KpFrame, FindingKind` (Task 2)
- Produces (`form/types.ts`):
  ```ts
  export type SetKey = string; // `${sessionId}/${exerciseIndex}/${setIndex}`
  export const setKey = (sessionId: string, exerciseIndex: number, setIndex: number): SetKey;
  export type Box = [number, number, number, number]; // 정규화 0~1 (x1,y1,x2,y2)
  export type SetVideo = { key: SetKey; sessionId: string; routineId: string; exerciseIndex: number; setIndex: number; startedAt: number /* 첫 프레임 epoch ms */; mimeType: string; blob: Blob; boxes: { t: number; box: Box }[] };
  export type VideoClip = { key: string /* `${SetKey}#${index}` */; setKey: SetKey; index: number; startedAt: number; mimeType: string; blob: Blob };
  export type SetAnalysis = { key: SetKey; sessionId: string; status: 'done' | 'failed'; reason: null | 'noVideo' | 'noPerson' | 'error'; metrics: SquatRepMetrics[]; findings: FormFinding[]; notes: SetNote[]; uncertain: number[]; frames: KpFrame[]; model: 'rtmpose-m-halpe26'; analyzedAt: number };
  export type ManualErrorKind = 'depth' | 'kneeIn' | 'heel' | 'trunkLean' | 'lumbarFlexion' | 'bounce' | 'other';
  export type RepLabel = { key: string /* `${SetKey}#${index}` */; sessionId: string; setKey: SetKey; index: number; verdicts: { kind: FindingKind; agree: boolean }[]; manual: ManualErrorKind[]; normal: boolean; note: string; updatedAt: number };
  export type CaptureMeta = { sessionId: string; videoEnabled: boolean; consentAgreed: boolean; consentVersion: string | null };
  export type AppSettings = { videoEnabled: boolean; consent: { agreed: boolean; version: string; at: number } | null; guideSeen: number };
  export const DEFAULT_SETTINGS: AppSettings = { videoEnabled: false, consent: null, guideSeen: 0 };
  ```
- Produces (`ports/mediaStore.ts`): `interface MediaStore { putVideo(v: SetVideo): Promise<void>; getVideo(key): Promise<SetVideo|null>; deleteVideo(key): Promise<void>; listVideoKeys(): Promise<SetKey[]>; putClip(c: VideoClip); getClip(key); listClips(setKey): Promise<VideoClip[]>; deleteClipsOfSet(setKey); putAnalysis(a: SetAnalysis); getAnalysis(key): Promise<SetAnalysis|null>; listAnalyses(sessionId): Promise<SetAnalysis[]>; putLabel(l: RepLabel); listLabels(sessionId): Promise<RepLabel[]>; putCaptureMeta(m: CaptureMeta); getCaptureMeta(sessionId): Promise<CaptureMeta|null>; getSettings(): Promise<AppSettings>; putSettings(s: AppSettings); usageBytes(): Promise<number> }`
- IDB: 같은 DB `work-out-mate` 버전 2에 store `videos`(keyPath key), `clips`(keyPath key, index setKey), `analyses`(keyPath key, index sessionId), `labels`(keyPath key, index sessionId), `captureMeta`(keyPath sessionId), `settings`(key 'app'). 버전 1 데이터(routines·sessions)는 그대로 남아야 한다.

- [ ] **Step 1: 실패 테스트** — 저장·읽기·목록·삭제 왕복, `getSettings()` 기본값 = DEFAULT_SETTINGS, `usageBytes()`가 영상·클립 blob 크기 합, **버전 1 DB에 세션을 넣고 버전 2로 열어도 세션이 남아 있음**(Review Focus 4)
- [ ] **Step 2: 실패 확인** — `npx vitest run -w apps/app test/mediaStore.test.ts` → FAIL
- [ ] **Step 3: 구현** — `idbStorage.ts`의 openDB를 `openWomDb(name)`로 빼서 두 저장소가 공유. Blob은 fake-indexeddb에서 structuredClone 가능.
- [ ] **Step 4: 통과 확인** — `npm test -w apps/app` PASS, typecheck 통과
- [ ] **Step 5: 커밋** — `feat(app): 자세 분석용 MediaStore(영상·클립·분석·라벨·설정)`

### Task 4: RTMPose-m 모델 어댑터와 빌드 자산 (app)

**Files:**
- Create: `apps/app/src/form/rtmposeCodec.ts`, `apps/app/src/platform/rtmposeOrt.ts`, `apps/app/src/ports/formPose.ts`
- Modify: `apps/app/package.json`(의존성 `onnxruntime-web@1.20.1` — 허락 뒤 설치), `apps/app/scripts/copy-wasm.mjs`(모델·ORT 파일 복사), `apps/app/index.html`(CSP 변경 필요 시 최소로)
- Test: `apps/app/test/rtmposeCodec.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ports/formPose.ts
  export interface FormPoseModel { estimate(image: CanvasImageSource, width: number, height: number, box: Box): Promise<Kp2[]>; dispose(): void; readonly backend: 'webgpu' | 'wasm' }
  // form/rtmposeCodec.ts (순수 함수, DOM 없이 테스트)
  export const RTM_W = 192, RTM_H = 256;
  export function cropFor(box: Box, width: number, height: number): { sx: number; sy: number; sw: number; sh: number }; // 픽셀, 1.25배 여유, 192:256 비율
  export function toInputTensor(rgba: Uint8ClampedArray): Float32Array; // CHW, BGR 순서 MEAN/STD
  export function decodeSimcc(simccX: Float32Array, simccY: Float32Array, joints: number, crop: {sx,sy,sw,sh}): Kp2[]; // argmax÷2 → 원본 픽셀, score = 두 최댓값 중 작은 값
  // platform/rtmposeOrt.ts
  export async function createRtmposeModel(opts?: { modelUrl?: string; prefer?: 'webgpu' | 'wasm' }): Promise<FormPoseModel>; // 기본 '/form/rtmpose-m.onnx', webgpu 실패 시 wasm, ort.env.wasm.wasmPaths='/form/ort/', numThreads=1
  ```
- `copy-wasm.mjs`: `apps/spike/public/mediapipe/bench/rtmpose-m.onnx` → `apps/app/public/form/rtmpose-m.onnx`, `apps/spike/public/mediapipe/ort/*` → `apps/app/public/form/ort/`. 원본이 없으면 경고만(CI 대비, 기존 모델 처리와 같게). `.gitignore`에 `apps/app/public/form/` 추가.

- [ ] **Step 0: 의존성 허락 확인** — 사용자에게 `onnxruntime-web@1.20.1` 설치 허락을 받았는지 장부에서 확인(실행 시작 때 받음). 그 뒤 `npm install onnxruntime-web@1.20.1 -w apps/app`
- [ ] **Step 1: 실패 테스트** (`rtmposeCodec.test.ts`)
  - "cropFor: 상자 (0.4,0.2)-(0.6,0.8), 1080×1920 → 중심 유지, 높이 기준 1.25배, sw/sh = 192/256"
  - "toInputTensor: 픽셀 (R=10,G=20,B=30)이면 채널0 = (30−123.675)/58.395, 채널1 = (20−116.28)/57.12, 채널2 = (10−103.53)/57.375"
  - "decodeSimcc: x 최댓값 위치 200, y 300이면 크롭 좌표 (100,150) → 원본 sx + 100/192·sw"
- [ ] **Step 2: 실패 확인** — `npx vitest run -w apps/app test/rtmposeCodec.test.ts`
- [ ] **Step 3: 구현** — codec 순수 함수, `rtmposeOrt.ts`는 OffscreenCanvas(없으면 canvas)로 크롭 → codec → `ort.InferenceSession.run`. 텔레메트리·외부 fetch 없음.
- [ ] **Step 4: 통과 확인** — 전체 테스트, typecheck, `npm run build -w apps/app` 통과, `csp.test.ts` 통과
- [ ] **Step 5: 커밋** — `feat(app): RTMPose-m(ONNX Runtime Web) 자세 모델 어댑터`

### Task 5: 세트 녹화와 lite 상자 수집 (app)

**Files:**
- Create: `apps/app/src/form/setCapture.ts`, `apps/app/src/platform/mediaRecorderCapture.ts`
- Modify: `apps/app/src/workout/engine.ts`(EngineDeps에 `capture?: SetCapture`, set start/finished에서 호출), `apps/app/src/workout/WorkoutFlow.tsx`(capture 만들기, 설정 읽기)
- Test: `apps/app/test/setCapture.test.ts`, `apps/app/test/engine.test.ts`(추가)

**Interfaces:**
- Consumes: `MediaStore`, `SetVideo`, `CaptureMeta`, `setKey` (Task 3)
- Produces:
  ```ts
  export interface Recorder { start(): boolean /* 시작 못 하면 false */; stop(): Promise<{ blob: Blob; mimeType: string; startedAt: number } | null> }
  export function createMediaRecorder(getStream: () => MediaStream | null, now: () => number /* epoch ms */): Recorder;
  export interface SetCapture {
    beginSession(meta: CaptureMeta & { routineId: string }): Promise<void>;
    beginSet(exerciseIndex: number, setIndex: number): void;
    addFrame(f: PoseFrame, epochT: number): void; // lite 관절점 → 정규화 상자(사람 없음이면 건너뜀)
    endSet(): Promise<SetKey | null>;            // 저장된 key, 영상 없으면 null
  }
  export function createSetCapture(deps: { store: MediaStore; recorder: Recorder | null; onSaved: (key: SetKey) => void }): SetCapture;
  ```
- 시계: 녹화 시작 시각과 lite 프레임 시각은 모두 epoch ms(`now() + epochOffset`)로 맞춘다. SetLog.reps(Task 1)와 같은 시계다.
- 엔진: 세션 시작 때 `beginSession`, set 이벤트 `start`에서 `beginSet`, `finished`에서 `endSet`(반복 0이면 저장하지 않음). 실시간 프레임 처리 순서는 바꾸지 않는다. capture가 없거나 videoEnabled=false면 아무것도 하지 않는다. 스쿼트가 아닌 운동은 녹화하지 않는다(처음 버전은 스쿼트만, 설계 1절 목표 6).

- [ ] **Step 1: 실패 테스트**
  - setCapture: "beginSet→addFrame 3번→endSet이면 SetVideo가 저장되고 boxes 3개, key는 setKey(...)"
  - "lite 관절점이 없는 프레임(visibility 0)은 boxes에 넣지 않음"
  - Review Focus 3: "recorder.start()가 false거나 stop()이 null이면 저장하지 않고 endSet은 null, 예외 없음", "recorder가 null(MediaRecorder 미지원)이어도 세트 진행에 영향 없음"
  - engine: "videoEnabled=false면 capture를 부르지 않는다", "스쿼트 세트 start/finished에서 beginSet/endSet이 한 번씩, 푸시업 세트는 부르지 않음", Review Focus 5: "세트 끝 버튼으로 끝난 반복 0 세트는 endSet 뒤 저장 없음"
- [ ] **Step 2: 실패 확인** — `npx vitest run -w apps/app test/setCapture.test.ts test/engine.test.ts`
- [ ] **Step 3: 구현** — MediaRecorder는 `video/webm;codecs=vp9` → `video/webm` → `video/mp4` 순으로 `isTypeSupported` 확인, 비트레이트 2.5Mbps. 스트림은 WorkoutFlow의 `<video>.srcObject`.
- [ ] **Step 4: 통과 확인** — 전체 테스트·typecheck·styleScan
- [ ] **Step 5: 커밋** — `feat(app): 스쿼트 세트 영상 녹화와 lite 상자 저장`

### Task 6: 분석 대기열 (app)

**Files:**
- Create: `apps/app/src/form/analysisQueue.ts`, `apps/app/src/platform/videoFrameReader.ts`
- Modify: `apps/app/src/App.tsx`(앱 시작 때 대기열 만들고 이어서 하기), `apps/app/src/workout/WorkoutFlow.tsx`(engine 상태를 busy로 전달, capture onSaved → enqueue)
- Test: `apps/app/test/analysisQueue.test.ts`

**Interfaces:**
- Consumes: `MediaStore`(Task 3), `FormPoseModel`(Task 4), `computeSquatRepMetrics`, `judgeSquat`(Task 2), `Storage.getSession`(기존, SetLog.reps는 Task 1)
- Produces:
  ```ts
  export interface VideoFrameReader { open(blob: Blob): Promise<{ durationMs: number; width: number; height: number; frameAt(ms: number): Promise<CanvasImageSource>; close(): void }> }
  export type AnalysisQueue = { enqueue(key: SetKey): void; resumePending(): Promise<void>; setBusy(busy: boolean): void; onProgress(cb: (sessionId: string) => void): () => void; dispose(): void };
  export function createAnalysisQueue(deps: { store: MediaStore; storage: Storage; model: () => Promise<FormPoseModel>; reader: VideoFrameReader; now: () => number }): AnalysisQueue;
  ```
- 동작: 한 번에 한 세트. busy(세트 진행 중)면 프레임 사이에서 멈췄다가 풀리면 이어서. 프레임 시각 = 0부터 duration까지 1000/15ms 간격, 상자 = 그 시각과 가장 가까운 boxes 항목(±200ms 안, 없으면 kps null). history = 같은 세션의 이전 분석 metrics + 최근 기록 분석 metrics(같은 운동). 결과 `SetAnalysis` 저장 뒤 onProgress. 모델 로딩 실패·예외면 `status 'failed', reason 'error'`, 사람이 전혀 없으면 `'noPerson'`, 영상이 없으면 `'noVideo'`.
- 이어서 하기: `resumePending()`은 `listVideoKeys()` 중 analysis가 없는 key를 enqueue. 이미 대기열에 있거나 분석 중인 key는 다시 넣지 않는다.

- [ ] **Step 1: 실패 테스트** (가짜 reader가 시각별 가짜 이미지를, 가짜 model이 정해 둔 Kp2를 돌려줌)
  - "enqueue → 15fps 시각들로 model.estimate 호출, SetAnalysis(done) 저장, findings 포함"
  - "busy=true인 동안 estimate를 부르지 않고, false가 되면 이어서 끝낸다"
  - Review Focus 2: "resumePending은 분석 없는 key만 넣고, 같은 key를 두 번 enqueue해도 한 번만 분석"
  - Review Focus 1: "boxes가 빈 구간 프레임은 kps null로 넘어가고, 모든 프레임이 null이면 status failed·reason noPerson"
  - "model 생성이 reject되면 failed·error, 다음 key는 계속 시도"
  - "세션 기록에 reps가 없으면(옛 기록) 분석하지 않고 failed·noVideo가 아니라 건너뜀"(Review Focus 4)
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — videoFrameReader는 숨은 `<video>`에 objectURL, `currentTime` 설정 후 `seeked` 대기. SetVideo.startedAt + 프레임 ms를 KpFrame.t(epoch)로 써서 SetLog.reps와 같은 시계로 맞춘다.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(app): 쉬는 시간 분석 대기열과 이어서 분석`

### Task 7: 결과 화면 지적 목록과 맞아요/틀려요 (app)

**Files:**
- Create: `apps/app/src/screens/FormFindings.tsx`, `apps/app/src/domain/formPhrases.ts`
- Modify: `apps/app/src/screens/Summary.tsx`, `apps/app/src/screens/SessionDetail.tsx`, `apps/app/src/style.css`
- Test: `apps/app/test/FormFindings.test.tsx`, `apps/app/test/formPhrases.test.ts`

**Interfaces:**
- Consumes: `MediaStore.listAnalyses/listLabels/putLabel/getCaptureMeta`, `AnalysisQueue.onProgress`
- Produces: `FormFindings({ store, sessionId, session, onPlay(setKey, index) })`. 문구(`formPhrases.ts`):
  - depth "허벅지가 바닥과 평행해질 때까지 앉지 않았어요"
  - kneeIn "무릎이 발보다 안쪽으로 모였어요"
  - kneeInRelative "평소보다 무릎이 모였어요"
  - heel "뒤꿈치가 바닥에서 떨어졌어요"
  - fastDescent "이번 세트는 평균 {초}초 만에 내려갔어요. 2초 이상 천천히 내려가 보세요" (소수 한 자리)
  - 지적 없음 "자세 지적 없음", 분석 중 "분석 중… ({끝난 세트}/{전체 세트})", 사유 noVideo "영상이 없어 분석하지 못했어요", noPerson "사람이 화면에 보이지 않아 분석하지 못했어요", error "분석 중 문제가 생겼어요"
  - 줄 형식 "{index}번째 ({m:ss})  {문구}" — m:ss는 반복 startT − 세트 영상 startedAt
- 맞아요/틀려요는 지적마다 두 버튼, 누르면 `RepLabel.verdicts`에 저장, 다시 누르면 바뀜(현재 선택이 눌린 상태로 보임, `aria-pressed`).

- [ ] **Step 1: 실패 테스트**
  - "분석 done, findings 2개면 '4번째 (0:18)  무릎이 발보다 안쪽으로 모였어요'와 맞아요/틀려요 버튼"
  - "맞아요 누르면 putLabel(verdicts [{kind:'kneeIn',agree:true}]), 틀려요로 바꾸면 agree false로 덮어씀"
  - "분석 2/3 끝났으면 '분석 중… (2/3)'", "onProgress 뒤 다시 읽어 갱신"
  - Review Focus 3·4: "captureMeta가 없거나 videoEnabled=false인 세션은 자세 영역 자체를 그리지 않음", "noVideo 사유 문구"
  - formPhrases: fastDescent 600ms → "0.6초"
- [ ] **Step 2~4: 실패 확인 → 구현(Summary·SessionDetail에 FormFindings 끼우기, ▶은 onPlay) → 통과**
- [ ] **Step 5: 커밋** — `feat(app): 결과 화면 자세 지적 목록과 맞아요/틀려요`

### Task 8: 반복 영상 재생과 직접 라벨 (app)

**Files:**
- Create: `apps/app/src/screens/RepPlayer.tsx`
- Modify: `apps/app/src/App.tsx`(화면 상태 `{ kind: 'player', setKey, index }`), `apps/app/src/style.css`
- Test: `apps/app/test/RepPlayer.test.tsx`

**Interfaces:**
- Consumes: `MediaStore.getVideo/listClips/getAnalysis/listLabels/putLabel`, `HALPE`
- Produces: `RepPlayer({ store, sessionId, setKey, index, onBack })`
  - 재생 시작 = 반복 startT − 1000ms(영상 시각으로 환산, 0 아래면 0). 전체 영상이 없고 클립만 있으면 클립 재생, 둘 다 없으면 "영상이 삭제됐어요(오래된 기록은 지적 구간만 보관)".
  - 관절 선 겹치기 켜기/끄기(SetAnalysis.frames를 가장 가까운 시각으로 canvas에 그림), 0.5배 느리게 보기 토글.
  - 이전/다음 반복 버튼. "이 반복에 문제가 있어요" → 종류 선택(깊이 부족, 무릎 모임, 뒤꿈치 들림, 상체 과다 숙임, 허리 말림, 반동, 기타+메모) → `manual`, "이 반복은 정상" → `normal: true`(manual 비움). 저장은 putLabel.

- [ ] **Step 1: 실패 테스트** — "반복 startT가 영상 시작 + 5s면 currentTime 4", "클립만 있으면 클립 objectURL", "둘 다 없으면 삭제 안내", "느리게 보기 → playbackRate 0.5", "문제 있어요 → 무릎 모임 선택 → putLabel manual ['kneeIn']", "정상 → normal true, manual []", "다음 반복 → index+1"
- [ ] **Step 2~4: 실패 확인 → 구현 → 통과**
- [ ] **Step 5: 커밋** — `feat(app): 반복 영상 재생, 관절 선 겹치기, 직접 라벨`

### Task 9: 설정, 동의, 촬영 안내 (app)

**Files:**
- Create: `apps/app/src/screens/Settings.tsx`, `apps/app/src/screens/ConsentPrompt.tsx`
- Modify: `apps/app/src/screens/Home.tsx`(설정 진입), `apps/app/src/App.tsx`, `apps/app/src/screens/Placement.tsx`(스쿼트 안내), `apps/app/src/workout/WorkoutFlow.tsx`(세션 시작 때 captureMeta 기록)
- Test: `apps/app/test/Settings.test.tsx`, `apps/app/test/Placement.test.tsx`(또는 WorkoutScreens.test.tsx에 추가)

**Interfaces:**
- Consumes: `MediaStore.getSettings/putSettings/usageBytes/putCaptureMeta`, Task 10 `applyRetention`·Task 11 `exportTrainingData`는 버튼만 연결(없으면 다음 작업에서 연결)
- Produces:
  - 처음 영상 저장을 켤 때 ConsentPrompt: 영상 저장 설명 + **별도 체크박스** 동의 문구(설계 6.4절 그대로, 버전 `v1`). 동의 안 해도 영상 저장은 켤 수 있다.
  - Settings: 영상 저장 켜기/끄기, 학습 데이터 동의 켜기/끄기(끌 때 "이미 내보낸 파일은 지울 수 없어요" 안내), 영상 전체 삭제(확인 대화상자), 영상 용량 표시(MB, 소수 한 자리), 학습 데이터 내보내기 버튼.
  - SessionDetail: "이 기록의 영상 삭제" 버튼(확인 뒤 그 세션의 videos·clips 삭제, 분석·라벨은 남김).
  - 영상 저장을 끄면 그 뒤 세션은 녹화·분석하지 않는다(capture를 만들지 않음).
  - Placement(스쿼트, videoEnabled일 때): "폰을 몸 앞쪽 대각선(45도), 허리 높이에 두세요 / 머리부터 발끝까지 여유 있게 / 무릎이 보이는 옷(반바지나 붙는 바지), 신발은 평소대로 / 팔은 앞으로 뻗거나 가슴 앞에 모으세요". `guideSeen` 3회까지 보이고 "다시 보지 않기"로 끔.
  - 세션 시작 때 `putCaptureMeta({ sessionId, videoEnabled, consentAgreed, consentVersion })`.

- [ ] **Step 1: 실패 테스트** — "기록 상세에서 이 기록의 영상 삭제 → 확인 뒤 그 세션 영상·클립만 삭제", "영상 저장을 처음 켜면 동의 화면, 체크 없이 확인해도 videoEnabled true·consent agreed false", "체크 후 확인하면 consent {agreed:true, version:'v1'}", "동의 끄기 안내 문구", "전체 삭제는 확인 뒤에만 deleteVideo", "용량 12.3MB 표시", "스쿼트 배치 안내 문구와 다시 보지 않기", "세션 시작 시 captureMeta 저장"
- [ ] **Step 2~4: 실패 확인 → 구현 → 통과**
- [ ] **Step 5: 커밋** — `feat(app): 설정, 학습 데이터 동의, 스쿼트 촬영 안내`

### Task 10: 영상 보관 규칙 (app)

**Files:**
- Create: `apps/app/src/form/retention.ts`, `apps/app/src/platform/clipCutter.ts`
- Modify: `apps/app/src/workout/WorkoutFlow.tsx`(세션 최종 저장 뒤 applyRetention 실행)
- Test: `apps/app/test/retention.test.ts`

**Interfaces:**
- Consumes: `Storage.listSessions`, `MediaStore`(videos, clips, analyses, labels)
- Produces:
  ```ts
  export interface ClipCutter { cut(video: SetVideo, fromMs: number, toMs: number): Promise<{ blob: Blob; mimeType: string } | null> }
  export function planRetention(sessions: WorkoutSession[], analyses: SetAnalysis[], labels: RepLabel[], videoKeys: SetKey[]): { keepFull: SetKey[]; toClip: { setKey: SetKey; index: number; fromMs: number; toMs: number }[]; deleteFull: SetKey[] };
  export async function applyRetention(deps: { storage: Storage; store: MediaStore; cutter: ClipCutter }): Promise<void>;
  ```
- 규칙: routineId별로 endedAt 최신 3개 세션은 keepFull. 나머지 세션의 세트는 findings 또는 라벨(verdicts·manual·normal 중 하나라도)이 있는 반복만 [startT−1000, endT+1000]으로 클립, 그다음 전체 영상 삭제. 클립이 이미 있으면 다시 자르지 않는다. 클립을 못 만들면(cut null) 전체 영상을 지우지 않고 다음 정리 때 다시 시도.
- clipCutter: 숨은 video를 fromMs로 옮겨 `captureStream()` + MediaRecorder로 toMs까지 녹화(설계 11절 빌더 선택).

- [ ] **Step 1: 실패 테스트** (planRetention 순수 함수 위주) — "같은 루틴 4번째 세션이 생기면 1번째 세션만 정리 대상", "지적 반복 4번(startT 18s, endT 20s)은 [17s, 21s] 클립", "지적·라벨 없는 세트는 클립 없이 삭제", "cut이 null이면 deleteVideo 안 부름", "루틴이 다르면 따로 센다"
- [ ] **Step 2~4: 실패 확인 → 구현 → 통과**
- [ ] **Step 5: 커밋** — `feat(app): 루틴별 최근 3회 전체 보관, 오래된 기록은 지적 구간만`

### Task 11: 학습 데이터 내보내기 (app)

**Files:**
- Create: `apps/app/src/form/exportData.ts`, `apps/app/src/platform/exportFile.ts`
- Modify: `apps/app/package.json`(`@capacitor/filesystem@^8.1.5` — 허락 뒤 설치), `apps/app/src/screens/Settings.tsx`(버튼 연결)
- Test: `apps/app/test/exportData.test.ts`

**Interfaces:**
- Consumes: `Storage.listSessions/getSession`, `MediaStore.listAnalyses/listLabels/getCaptureMeta/getVideo/listClips`
- Produces:
  ```ts
  export type ExportRow = { source: 'own-app'; consentAgreed: true; consentVersion: string; exercise: 'squat'; sessionId: string; recordedAt: number; exerciseIndex: number; setIndex: number; index: number; rep: RepTiming; cameraAngle: '45deg'; model: 'rtmpose-m-halpe26'; appVersion: string; frames: KpFrame[] /* 반복 [startT−500, endT+500] */; metrics: SquatRepMetrics; findings: FindingKind[]; uncertain: boolean; label: Omit<RepLabel, 'key' | 'sessionId' | 'setKey'> | null };
  export async function buildExportRows(deps: { storage: Storage; store: MediaStore; appVersion: string }): Promise<ExportRow[]>;
  export function toJsonl(rows: ExportRow[]): string;
  export interface ExportFile { save(name: string, text: string): Promise<string /* 저장 위치 설명 */> }
  ```
- 동의한 세션(`captureMeta.consentAgreed === true`)만 넣는다. 파일 이름 `wom-train-YYYYMMDD-HHMMSS.jsonl`. Android는 Filesystem `Directory.Documents`, 실패 시 `Directory.Data`(시험용 앱 `saveRecordingNative`와 같은 방식). 웹은 Blob 다운로드. "영상 구간도 포함" 옵션은 이번 계획에서 하지 않는다(설계 [제안], 관절점만으로 파인튜닝 시작 가능) — 장부에 판단으로 남긴다.

- [ ] **Step 1: 실패 테스트** — "동의한 세션의 반복만 행으로", "동의를 끈 뒤 세션은 빠짐", "frames는 반복 앞뒤 500ms만", "label 없으면 null", "toJsonl은 한 줄에 한 행", "내보내기 중 fetch 호출 0회(fetch spy)"
- [ ] **Step 2~4: 실패 확인 → 구현 → 통과**
- [ ] **Step 5: 커밋** — `feat(app): 동의한 기록만 학습 데이터(JSONL)로 내보내기`

### Task 12: 통합 확인과 실기기 점검 목록

**Files:**
- Modify: `apps/app/src/selftest.ts`(PC 자가 점검에 RTMPose 세션 생성 확인 추가, 외부 요청 0건 유지), `docs/phase2b-decisions.md`가 아니라 새 `docs/form-analysis-decisions.md`(판단 기록·실기기 점검 목록)
- Test: 기존 `csp.test.ts`, `styleScan.test.ts`, `platform.test.ts` 그대로 통과

- [ ] **Step 1:** `npm test -w packages/core`, `npm test -w apps/app`, 각 typecheck, `npm run build -w apps/app` 모두 통과
- [ ] **Step 2:** `npm run android:build -w apps/app` 후 `scripts/check-apk-perms.sh` 통과(INTERNET 없음, allowBackup=false). APK에 `public/form/rtmpose-m.onnx`, `public/form/ort/*.wasm`이 들어 있는지 `unzip -l`로 확인
- [ ] **Step 3:** 판단 기록 문서 작성 — 진행 중 내린 판단(장부 Ruling), 미룬 것, 아래 실기기 점검 목록
- [ ] **Step 4: 커밋** — `docs: 자세 분석 판단 기록과 실기기 점검 목록`

**실기기 점검 목록 (사용자, S23)**
1. 녹화하면서 lite 실시간 세기가 밀리지 않는지(설계 12절 첫 위험)
2. 쉬는 시간 60초 안에 30초 세트 분석이 끝나는지, 분석 중 세기가 밀리지 않는지(8절 2번)
3. 무릎이 보이는 옷·운동화로 20회 정답 영상 → 8절 1번 정확도 기준
4. 맞아요/틀려요·직접 라벨이 앱을 다시 켜도 남는지, 내보낸 JSONL을 adb로 가져와 Python에서 읽히는지
5. 4회째 기록 뒤 1회째 영상이 지적 구간만 남는지, 발열·배터리
