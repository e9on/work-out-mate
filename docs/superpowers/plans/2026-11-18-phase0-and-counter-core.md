# Phase 0 검증 + 카운터 코어 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설계 문서의 Phase 0(실기기 검증)과 Phase 1(플랫폼 무관 카운터 코어)을 만든다. 끝나면 갤럭시 S23·PC에서 자세 인식이 쓸 만한지 판단할 수 있고, 6가지 운동(스쿼트·푸시업·덤벨 벤치프레스·턱걸이·네거티브·매달리기)을 녹화된 랜드마크로 세고 검증할 수 있다.

**Architecture:** npm workspaces 모노레포. `packages/core`는 DOM·Capacitor·Tauri를 모르는 순수 TypeScript이고 Vitest로 테스트한다. `apps/spike`는 버리는 검증 앱(Vite + 순수 TS)이며 Capacitor(Android)와 Tauri(PC)로 감싼다. 스파이크 앱의 랜드마크 녹화 기능으로 만든 JSON이 코어 임계값 조정과 합격 테스트의 입력이 된다.

**Tech Stack:** TypeScript 5, Vite, Vitest, `@mediapipe/tasks-vision` 1.2.x, Capacitor 8.x, `@capacitor-community/text-to-speech`, Tauri 2.12+

**Spec:** `docs/specs/2026-11-18-work-out-mate-mvp-design.md`

**범위 밖 (다음 계획):** 루틴 설정·진행 화면, SQLite 저장, 음성 안내 흐름 = Phase 2. Phase 0 결과(WebView 유지/네이티브 교체)를 본 뒤 따로 계획한다.

## Global Constraints

- 서버·클라우드 없음. 실행 중 네트워크 요청 0건 (MediaPipe wasm·모델은 앱 안에 번들)
- `packages/core`는 `window`, `document`, `@capacitor/*`, `@tauri-apps/*`를 import하지 않는다
- 기준 기기: Android 갤럭시 S23, PC는 개발 PC 웹캠
- 합격 기준: 10회 세트마다 손으로 센 횟수와 **±1회 이내**, 매달리기는 **±1초 이내**, 네거티브는 횟수만 판정
- 덤벨 벤치프레스는 양팔 동시
- 턱걸이는 팔꿈치 각도로만 판별한다 (턱이 철봉을 넘었는지 보지 않음)
- **실시간 기반**: 운동 중 카메라 프레임이 들어올 때마다 바로 세고 화면·음성에 반영한다. 녹화 파일 재생(`replay`, CLI)은 테스트·임계값 조정용 도구일 뿐, 앱 동작은 항상 실시간이다. `createTracker().push()`는 프레임 하나를 즉시 처리하고 끝나야 한다(미래 프레임을 기다리거나 세트 전체를 모아 판단하지 않음)
- 시간 판정은 모두 프레임 타임스탬프(ms) 기준. 프레임 개수로 시간을 재지 않는다
- 랜드마크 녹화 파일은 개인 신체 데이터다. `packages/core/test/fixtures/private/`에 두고 git에 넣지 않는다
- 파일 다운로드(모델 `.task`)와 도구 설치(Rust, JDK, Android Studio)는 실행 전에 사용자 허락을 받는다
- 사용자에게 보이는 글(UI 문구, 커밋 메시지 본문 설명)은 한국어

## Review Focus

1. **세트 도중 몸 일부가 화면 밖으로 나감**(visibility 낮음) → 횟수가 오르지도, 에러가 나지도 않고 "일시정지" 상태가 된다. 다시 보이면 이어서 센다. (Task 4 테스트)
2. **가만히 서 있거나 임계값 근처에서 떨림** → 0회. (Task 4 테스트)
3. **반만 내려간 동작**(가동 범위 부족) → 세지 않는다. (Task 4 테스트)
4. **프레임이 불규칙하게 들어옴**(WebView가 느려 간격이 33ms·200ms로 섞임) → 최소 시간 판정과 매달리기 초가 타임스탬프 기준으로 맞게 나온다. (Task 4, Task 5 테스트)
5. **매달리기 중 1~2프레임만 랜드마크를 놓침** → 타이머가 끊기지 않는다. 손을 놓으면(자세가 유지 시간 이상 깨짐) 멈춘다. (Task 5 테스트)

---

## 파일 구조

```
work-out-mate/
  package.json                 # npm workspaces: packages/*, apps/*
  tsconfig.base.json
  .gitignore                   # node_modules, dist, **/fixtures/private/, src-tauri/target, android/build
  packages/core/
    package.json  tsconfig.json  vitest.config.ts
    src/
      index.ts                 # 공개 API 재수출
      types.ts                 # Landmark, PoseFrame, LM 인덱스 상수
      pose/angles.ts           # jointAngle
      pose/signal.ts           # Ema, visibleEnough
      counter/repCounter.ts    # RepCounter (상태 기계)
      counter/holdTimer.ts     # HoldTimer (매달리기)
      exercises/definitions.ts # 6개 운동 정의 + 임계값
      exercises/runner.ts      # createTracker, replay
    test/
      helpers/poseBuilder.ts   # 원하는 관절 각도의 가짜 PoseFrame 생성
      *.test.ts
      fixtures/private/        # (gitignore) S23·PC 녹화 JSON + manifest.json
    scripts/replay.ts          # CLI: 녹화 파일 → 횟수
  apps/spike/                  # 버리는 검증 앱
    index.html  vite.config.ts  package.json
    src/main.ts  src/pose.ts  src/recorder.ts  src/speech.ts  src/hud.ts
    public/mediapipe/          # wasm + pose_landmarker_{lite,full}.task (번들)
    capacitor.config.ts  android/   (cap add android 산출물)
    src-tauri/                 (tauri init 산출물)
  docs/phase0-results.md       # Phase 0 측정 결과 기록
```

---

### Task 1: 모노레포 골격과 관절 각도

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `packages/core/{package.json,tsconfig.json,vitest.config.ts}`, `packages/core/src/{index.ts,types.ts,pose/angles.ts}`
- Test: `packages/core/test/angles.test.ts`

**Interfaces:**
- Produces:
  - `type Landmark = { x: number; y: number; z: number; visibility: number }`
  - `type PoseFrame = { t: number; image: Landmark[]; world: Landmark[] }` — `t`는 ms, `image`는 정규화 좌표 33개, `world`는 미터 좌표 33개
  - `const LM = { NOSE:0, L_SHOULDER:11, R_SHOULDER:12, L_ELBOW:13, R_ELBOW:14, L_WRIST:15, R_WRIST:16, L_HIP:23, R_HIP:24, L_KNEE:25, R_KNEE:26, L_ANKLE:27, R_ANKLE:28 } as const`
  - `jointAngle(a: Landmark, b: Landmark, c: Landmark): number` — b가 꼭짓점, 3D, 도(°) 단위 0~180

- [ ] **Step 1: 저장소 초기화** — `git init`, 루트 `package.json`(`"private": true, "workspaces": ["packages/*", "apps/*"]`), `.gitignore`는 위 파일 구조의 항목. `packages/core`에 `typescript`, `vitest` devDependency, 스크립트 `"test": "vitest run"`.
- [ ] **Step 2: 실패하는 테스트 작성** (`angles.test.ts`)

```ts
const p = (x: number, y: number, z = 0) => ({ x, y, z, visibility: 1 });
test('직각', () => expect(jointAngle(p(1,0), p(0,0), p(0,1))).toBeCloseTo(90, 5));
test('일직선', () => expect(jointAngle(p(-1,0), p(0,0), p(1,0))).toBeCloseTo(180, 5));
test('3D 45도', () => expect(jointAngle(p(1,0,0), p(0,0,0), p(1,0,1))).toBeCloseTo(45, 5));
test('길이 0이면 NaN', () => expect(jointAngle(p(0,0), p(0,0), p(1,0))).toBeNaN());
```

- [ ] **Step 3: 실행해서 실패 확인** — `npm test -w packages/core` → FAIL (`jointAngle` 없음)
- [ ] **Step 4: `jointAngle` 구현** — 벡터 BA·BC 내적/노름, `acos`를 [-1,1]로 클램프. 노름 0이면 `NaN`.
- [ ] **Step 5: 통과 확인** — `npm test -w packages/core` → PASS 4개
- [ ] **Step 6: 커밋** — `git commit -m "chore: 모노레포 골격과 관절 각도 함수"`

### Task 2: 테스트용 가짜 포즈 생성기

**Files:**
- Create: `packages/core/test/helpers/poseBuilder.ts`
- Test: `packages/core/test/poseBuilder.test.ts`

**Interfaces:**
- Consumes: `Landmark`, `PoseFrame`, `LM`, `jointAngle` (Task 1)
- Produces (테스트 전용):
  - `buildPose(opts: { t: number; elbow?: number; knee?: number; wristAboveNose?: boolean; visibility?: number; hidden?: number[] }): PoseFrame` — 양쪽 팔꿈치 각도 = `elbow`(기본 170), 양쪽 무릎 각도 = `knee`(기본 175). `wristAboveNose`가 true면 두 손목 y를 코보다 위(이미지 y가 더 작게)로 둔다. `hidden`에 든 인덱스는 visibility 0.
  - `series(values: number[], key: 'elbow'|'knee', dtMs = 33, extra?: Partial<...>): PoseFrame[]` — 각도 값 배열을 프레임 열로

- [ ] **Step 1: 실패하는 테스트** — `buildPose({t:0, elbow:90})`의 왼팔(11,13,15)과 오른팔(12,14,16) `jointAngle` ≈ 90(±0.5). `knee:100`이면 (23,25,27)·(24,26,28) ≈ 100. `hidden:[13]`이면 `image[13].visibility === 0`.
- [ ] **Step 2: 실패 확인** — `npm test -w packages/core`
- [ ] **Step 3: 구현** — 어깨·엉덩이를 고정점에 두고, 팔뚝·정강이 끝점을 각도만큼 회전시켜 놓는다. `image`와 `world`에 같은 기하를 쓴다(테스트에서는 차이 불필요).
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `test: 가짜 포즈 생성기`

### Task 3: 신호 다듬기 (스무딩·가시성)

**Files:**
- Create: `packages/core/src/pose/signal.ts`
- Test: `packages/core/test/signal.test.ts`

**Interfaces:**
- Produces:
  - `class Ema { constructor(alpha: number); next(v: number | null): number | null; reset(): void }` — `null` 입력은 `null`을 내고 내부 값은 유지
  - `visibleEnough(frame: PoseFrame, idx: readonly number[], min = 0.5): boolean`

- [ ] **Step 1: 실패하는 테스트**
  - `new Ema(0.5)`에 10, 20 → 10, 15
  - 10, null, 20 → 10, null, 15
  - `visibleEnough`: 해당 인덱스 visibility 0.6이면 true, 하나라도 0.4면 false
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(core): EMA 스무딩과 가시성 판정`

### Task 4: RepCounter 상태 기계

**Files:**
- Create: `packages/core/src/counter/repCounter.ts`
- Test: `packages/core/test/repCounter.test.ts`

**Interfaces:**
- Produces:

```ts
type RepConfig = {
  restSide: 'high' | 'low';  // 시작 자세에서 신호가 큰 쪽인지 작은 쪽인지
  enter: number;             // 이 값을 넘어가면(restSide 반대 방향) '동작 중'
  turn: number;              // 이 값까지 가야 '반환점 도달'
  exit: number;              // 다시 이 값을 넘어 돌아오면 1회 확정 (enter와 히스테리시스)
  minRepMs: number;          // 반복 전체(startT→endT) 최소 시간. 구간별 최소 시간은 두지 않음
  pauseAfterMs: number;      // 신호 null이 이만큼 이어지면 진행 중 반복을 버림
  countAt?: 'return' | 'turn'; // 기본 'return'(돌아올 때 확정). 'turn'이면 turn 도달 프레임에 확정(endT=turnT, backMs=0), 이후 exit를 넘어야 재무장
};
type RepPhase = 'rest' | 'out' | 'turned' | 'paused';
type RepEvent = { index: number; startT: number; turnT: number; endT: number; outMs: number; backMs: number };
class RepCounter {
  constructor(cfg: RepConfig);
  update(t: number, signal: number | null): RepEvent | null;  // 1회 확정되면 이벤트
  get count(): number;
  get phase(): RepPhase;
  reset(): void;
}
```

상태 전이 (restSide 'high' 기준, 'low'는 부등호 반대):
`rest --(signal < enter)--> out --(signal <= turn)--> turned --(signal > exit, endT−startT ≥ minRepMs)--> rest (+1, RepEvent)`
`out --(signal > exit, turn 미도달)--> rest (세지 않음)`
signal null → 직전 phase 기억, `paused`. `pauseAfterMs` 넘게 이어지면 진행 중 반복을 버리고 `rest`로 복귀. 그 전에 신호가 돌아오면 기억한 phase로 계속.

- [ ] **Step 1: 실패하는 테스트** (cfg: restSide 'high', enter 150, turn 95, exit 160, minRepMs 500, pauseAfterMs 1500; 신호 배열은 33ms 간격)
  - `완전한 1회`: 170→…→90→…→170 (각 구간 400ms 이상) → count 1, 이벤트 1개, `outMs`≈나감 구간 시간
  - `3회 연속` → 3
  - `가만히 서 있음`: 170 근처 ±3 노이즈 300프레임 → 0 *(Review Focus 2)*
  - `임계값 근처 떨림`: 148~162 왕복 50회 → 0 *(Review Focus 2)*
  - `반만 내려감`: 170→120→170 → 0 *(Review Focus 3)*
  - `너무 빠름`: 나감 100ms, 돌아옴 100ms → 0
  - `불규칙 간격`: 같은 1회를 dt 33/200ms 섞어서 → 1, `outMs`가 타임스탬프 차와 같음 *(Review Focus 4)*
  - `잠깐 가림`: 반환점 후 null 10프레임(330ms) → 다시 170 → 1, 에러 없음 *(Review Focus 1)*
  - `오래 가림`: 반환점 후 null 2초 → 다시 170 → 0, phase는 `rest` *(Review Focus 1)*
  - `restSide 'low'`(네거티브용): cfg enter 70, turn 150, exit 60. 50→155→50 → 1
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 위 전이표 그대로. 시간은 인자 `t`로만 판단.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(core): 상태 기계 기반 반복 카운터`

### Task 5: HoldTimer (매달리기)

**Files:**
- Create: `packages/core/src/counter/holdTimer.ts`
- Test: `packages/core/test/holdTimer.test.ts`

**Interfaces:**
- Produces:

```ts
type HoldConfig = { startAfterMs: number; graceMs: number };
// startAfterMs: 자세가 이만큼 이어져야 시작(그 시간부터 셈). graceMs: 자세가 깨지거나 null이어도 이 시간까지는 계속 센다.
class HoldTimer {
  constructor(cfg: HoldConfig);
  update(t: number, holding: boolean | null): void;
  get heldMs(): number;     // 확정된 누적 시간 (grace 구간은 자세가 돌아오면 포함, 끝나면 제외)
  get state(): 'idle' | 'holding' | 'ended';
  reset(): void;
}
```

- [ ] **Step 1: 실패하는 테스트** (startAfterMs 300, graceMs 500)
  - `10초 매달림`: true 10초(33ms) 후 false 1초 → `heldMs` 10000±50, state `ended`
  - `잠깐 놓침`: true 3초, null 2프레임, true 3초, false → ≈6000±50 *(Review Focus 5)*
  - `진짜 놓음`: true 3초, false 600ms → `ended`, ≈3000±50 *(Review Focus 5)*
  - `불규칙 간격`: dt 33/250 섞어 5초 → ≈5000±50 *(Review Focus 4)*
  - `시작 전 깜빡임`: true 200ms, false → `idle`, 0
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 시작 시각은 자세가 처음 true가 된 프레임 t. `ended` 이후 update는 무시.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(core): 매달리기 시간 측정기`

### Task 6: 운동 정의 6종과 트래커

**Files:**
- Create: `packages/core/src/exercises/definitions.ts`, `packages/core/src/exercises/runner.ts`
- Modify: `packages/core/src/index.ts` (재수출)
- Test: `packages/core/test/exercises.test.ts`

**Interfaces:**
- Consumes: `jointAngle`, `LM`, `Ema`, `visibleEnough`, `RepCounter`, `HoldTimer`
- Produces:

```ts
type ExerciseId = 'squat' | 'pushup' | 'dumbbellBench' | 'pullup' | 'negative' | 'deadHang';
type ExerciseDef =
  | { id: ExerciseId; kind: 'reps'; signal(f: PoseFrame): number | null; rep: RepConfig }
  | { id: 'deadHang'; kind: 'hold'; holding(f: PoseFrame): boolean | null; hold: HoldConfig };
const EXERCISES: Record<ExerciseId, ExerciseDef>;
type TrackerState = { count: number; heldMs: number; paused: boolean; lastRep: RepEvent | null };
function createTracker(id: ExerciseId): { push(f: PoseFrame): TrackerState; state(): TrackerState };
function replay(id: ExerciseId, frames: PoseFrame[]): TrackerState & { reps: RepEvent[] };
```

신호 정의 (좌우 중 관련 관절 평균 visibility가 높은 쪽 사용, 둘 다 0.5 미만이면 `null`, 각도는 `world` 좌표, EMA alpha 0.5):
| id | 신호 | restSide | 초기 임계값 enter/turn/exit | 비고 |
|---|---|---|---|---|
| squat | 무릎 각도 (엉덩이-무릎-발목) | high | 150/100/160 | |
| pushup | 팔꿈치 각도 | high | **145/120/150** | 근거: S23 옆 바닥 촬영 5회 실측에서 반복 사이 맨 위가 155~157(exit 160 미달), 바닥이 90~114(turn 100 미달 3회)라 실제 1회만 셌음 |
| dumbbellBench | 양팔 팔꿈치 각도의 **평균** (양팔 동시) | high | 150/100/160 | 양팔 다 보여야 함, 한쪽만 보이면 null |
| pullup | **양팔 팔꿈치 각도 평균**(한쪽만 보이면 그쪽, 둘 다 안 보이면 null). 턱·철봉 위치는 보지 않음 — 사용자 결정 | high | 140/80/155 | |
| negative | **양팔 팔꿈치 각도 평균**(pullup과 동일 규칙) | low | **100/140/95**, `countAt: 'turn'`, **minRepMs 250** | `RepEvent.outMs` = 내려온 시간. 근거: S23 실측 enter→turn이 284~387ms라 minRepMs 500이면 2·3번째가 버려져 250으로 낮춤(교정은 outMs로 따로). 또 위로 올라가는 동작은 점프라 마지막 반복이 안 세졌고 위로 올라가는 동작은 점프라 마지막 반복이 안 세졌고, 좌우 한쪽만 쓰면 덜 펴진 팔 때문에 turn에 못 닿았으며, 맨 위 양팔 평균이 53~85°(바닥 145~159°)였다 |
| deadHang | holding = 두 손목이 코보다 위 && 양 팔꿈치 각도 ≥ 150 | — | startAfterMs 300, graceMs 500 | |

모든 RepConfig: minRepMs 500(전체 반복 최소 시간), pauseAfterMs 1500. (구간별 minPhaseMs 250을 바꾼 이유: 실측에서 150→100° 구간이 0.19~0.23초라 정상 반복이 버려졌고, 실제 반복 전체는 1.26~1.63초였다.) **임계값은 출발점일 뿐이고 Task 10에서 녹화 데이터로 조정한다.**

- [ ] **Step 1: 실패하는 테스트** — `buildPose`/`series`로:
  - 운동마다 "완전한 1회" 각도 열 → `replay(id).count === 1` (deadHang은 `wristAboveNose:true, elbow:170` 5초 → `heldMs` ≈ 5000±100, 시작 시각은 처음 true 프레임이므로 startAfterMs를 빼지 않는다)
  - pullup: 팔꿈치가 80°까지 굽혔다 펴지면 코·손목 위치와 상관없이 1 (팔 각도로만 판별)
  - dumbbellBench: 한쪽 팔(13,15) `hidden` → 신호 null → count 0, `paused` true
  - negative: `reps[0].outMs`가 내려온 구간 시간(±50)
  - `createTracker`를 프레임 단위로 push한 결과와 `replay` 결과가 같다
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(core): 운동 6종 정의와 트래커`

### Task 7: 녹화 재생 CLI

**Files:**
- Create: `packages/core/scripts/replay.ts`, `packages/core/test/fixtures/sample-squat-3.json` (Task 2 빌더로 생성한 합성 3회, 커밋함)
- Test: `packages/core/test/replayCli.test.ts`

**Interfaces:**
- Consumes: `replay`
- Produces: 녹화 파일 형식 `RecordingFile = { version: 1; device: string; exercise: ExerciseId; model: 'lite' | 'full'; frames: PoseFrame[] }`. CLI `npm run replay -w packages/core -- <file.json> [exerciseId]` → 한 줄 JSON `{"exercise":"squat","count":3,"heldMs":0,"reps":[...]}` 출력.

- [ ] **Step 1: 실패하는 테스트** — `execFileSync`로 CLI를 샘플 파일에 실행 → 출력 JSON `count === 3`. `exerciseId` 인자로 덮어쓰기 가능. 파일 없으면 종료 코드 1과 한국어 오류 메시지.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `tsx`로 실행 (`"replay": "tsx scripts/replay.ts"`).
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(core): 녹화 재생 CLI`

### Task 8: 스파이크 앱 (브라우저에서 먼저) — 버리는 코드

TDD 대상이 아니다. 완료 기준은 아래 수동 확인.

**Files:**
- Create: `apps/spike/{package.json,index.html,vite.config.ts}`, `apps/spike/src/{main.ts,pose.ts,recorder.ts,speech.ts,hud.ts}`, `apps/spike/public/mediapipe/`

**Interfaces:**
- Consumes: `createTracker`, `RecordingFile`, `ExerciseId` (core)

- [ ] **Step 1: 사용자 허락 받고 자산 준비** — `npm i @mediapipe/tasks-vision@1.2.x` 후 `node_modules/@mediapipe/tasks-vision/wasm/*`를 `public/mediapipe/wasm/`로 복사. 모델 `pose_landmarker_lite.task`, `pose_landmarker_full.task`를 Google 공식 저장소(`storage.googleapis.com/mediapipe-models/pose_landmarker/...`)에서 받는다 — **받기 전에 파일명·출처·크기를 사용자에게 알리고 허락받는다.**
- [ ] **Step 2: 화면 구성** — 카메라 `<video>`, 랜드마크 오버레이 `<canvas>`, 컨트롤: 운동 선택(6종), 모델(lite/full), delegate(GPU/CPU), 녹화 시작/정지, 음성 테스트 버튼. HUD: FPS(최근 1초 처리 프레임), 추론 ms(평균·p95), 현재 count/heldMs/paused.
- [ ] **Step 3: 추론 루프** — `FilesetResolver.forVisionTasks('/mediapipe/wasm')`, `modelAssetPath: '/mediapipe/pose_landmarker_<m>.task'`, `runningMode: 'VIDEO'`, `requestVideoFrameCallback`(없으면 rAF)마다 `detectForVideo`. 이전 추론이 안 끝났으면 그 프레임은 건너뛴다. 결과를 `PoseFrame`으로 바꿔 tracker에 push.
- [ ] **Step 4: 녹화** — 녹화 중 `PoseFrame`을 모아 `RecordingFile`로 저장. 브라우저/Tauri는 다운로드, Android는 Filesystem 플러그인으로 Documents에 저장(Task 9에서 연결).
- [ ] **Step 5: 음성** — `speech.ts`의 `speak(text: string): Promise<'ok'|'unsupported'>`: Capacitor 네이티브면 TTS 플러그인(`lang: 'ko-KR'`), 아니면 `speechSynthesis`에서 `ko` 음성 선택. 음성 목록을 HUD에 표시.
- [ ] **Step 6: 수동 확인 (PC Chrome, `npm run dev -w apps/spike`)** — 웹캠 켜짐, 랜드마크 표시, 스쿼트 3회 → count 3, 녹화 파일을 Task 7 CLI로 재생 → 같은 count. DevTools Network에서 MediaPipe 관련 외부 요청 0건.
- [ ] **Step 7: 커밋** — `chore(spike): Phase 0 검증용 스파이크 앱`

### Task 9: Tauri(PC)·Capacitor(Android)로 감싸서 측정

**선행 (사용자가 직접 설치, 각각 허락 후 진행):** Rust(rustup), Microsoft C++ Build Tools(Tauri 요구 시), JDK 21, Android Studio(이미 있는 SDK 폴더 재사용), S23 USB 디버깅 켜기.

**Files:**
- Create: `apps/spike/capacitor.config.ts`, `apps/spike/android/`(cap add), `apps/spike/src-tauri/`(tauri init), `docs/phase0-results.md`

- [ ] **Step 1: Capacitor 연결** — `@capacitor/core@8 @capacitor/cli@8 @capacitor/android@8 @capacitor-community/text-to-speech @capacitor/filesystem @capacitor-community/keep-awake`, `npx cap add android`, `AndroidManifest.xml`에 `CAMERA` 권한. 빌드 후 S23에 설치.
- [ ] **Step 2: Tauri 연결** — `npm create tauri-app` 대신 기존 Vite 앱에 `tauri init`(frontendDist `../dist`, devUrl `http://localhost:5173`). `tauri build`로 Windows 실행 파일.
- [ ] **Step 3: 측정 (S23, PC 각각)** — `docs/phase0-results.md`에 표로 기록:
  - lite/full × GPU/CPU별 FPS, 추론 ms 평균·p95 (각 30초)
  - 카메라 권한: 첫 실행 허용 / 거부 후 재실행 동작
  - 한국어 음성: 나옴/안 나옴, 음성 이름
  - 비행기 모드(인터넷 끔)로 실행 → 자세 인식 동작 여부
  - 누운 자세(푸시업, 벤치프레스) 랜드마크가 안정적으로 잡히는지 눈으로 확인 + 녹화 1개씩
  - 매달리기 자세 vs 그냥 팔 든 자세 구분 가능성 메모
- [ ] **Step 4: 결정 기록** — 결과에 따라 `docs/specs/...design.md` 5절·13절에 "WebView 유지 / PoseSource 네이티브 교체", 고정 버전, 모델(lite/full) 결정을 적는다.
- [ ] **Step 5: 커밋** — `docs: Phase 0 측정 결과와 결정`

### Task 10: 실제 녹화로 임계값 조정과 합격 테스트

**Files:**
- Create: `packages/core/test/fixtures/private/manifest.json`(gitignore), `packages/core/test/acceptance.test.ts`
- Modify: `packages/core/src/exercises/definitions.ts` (임계값)

**Interfaces:**
- Consumes: `replay`, `RecordingFile`
- Produces: `manifest.json` 형식 `[{ file: string; exercise: ExerciseId; expectedCount?: number; expectedHeldMs?: number; note: string }]`

- [ ] **Step 1: 녹화 수집 (사용자 촬영)** — 스파이크 앱(S23 기준)으로 운동마다 10회 세트 2개 이상, 매달리기 2개 이상. 촬영하며 손으로 센 횟수·스톱워치 초를 `manifest.json`에 적는다. 일부러 반만 내려간 반복, 화면 밖으로 잠깐 나간 세트도 1개씩 넣는다.
- [ ] **Step 2: 합격 테스트 작성** — manifest의 각 항목을 `replay` → `|count - expectedCount| <= 1`, `|heldMs - expectedHeldMs| <= 1000`. `manifest.json`이 없으면 `test.skip`.
- [ ] **Step 3: 실행해서 현재 성적 확인** — `npm test -w packages/core -- acceptance`. 실패 항목 기록.
- [ ] **Step 4: 임계값 조정** — `npm run replay`로 신호 값을 보며 `definitions.ts` 수정. 바꾼 값마다 근거(어떤 녹화에서 무엇이 틀렸는지)를 커밋 메시지에 적는다. Task 6 단위 테스트도 계속 통과해야 한다.
- [ ] **Step 5: 전부 통과 확인** — `npm test -w packages/core` → 전체 PASS. 통과 못 하는 운동은 `phase0-results.md`에 "보류"와 원인을 적는다.
- [ ] **Step 6: 커밋** — `feat(core): 실측 기반 임계값 조정`

---

## 다음 계획으로 넘길 것
- Phase 2 (루틴 앱): 루틴 CRUD·추천, 운동/쉬는 시간 화면, 마지막 20초 안내, 음성 흐름, SQLite 저장, Speech/Storage/KeepAwake 포트 정식 구현. Task 9의 결정에 따라 PoseSource 구현을 고른다.
