# Phase 2a 코어 정리와 세트·루틴 진행기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 손 안 대는 루틴 앱(2b)이 그대로 가져다 쓸 수 있도록 카운터 코어를 정리한다(#1~#5). 그 위에 세트 진행기(`SetRunner`), 루틴 진행기(`RoutineRunner`), 데이터 모델, 오늘의 루틴 추천 함수를 순수 TS로 만든다.

**Architecture:** 모두 `packages/core` 안에 둔다. 공통 카운터 껍데기 하나에 fixed/adaptive 판정 전략을 끼우고, `TrackerState`는 판별 유니온으로 바꾼다. `SetRunner`는 트래커를 감싸 2절의 세트 흐름을 상태 기계로 구현하고, 음성 문구 대신 **이벤트**를 낸다. `RoutineRunner`는 SetRunner와 쉬는 시간을 이어서 세션 기록을 만든다. 시간은 모두 입력 `t`(ms)로만 잰다.

**Tech Stack:** TypeScript 7, Vitest, 기존 `@wom/core`

**Spec:** `docs/specs/2026-11-20-phase2-routine-app-design.md` (특히 2절, 5절)

**범위 밖:** 앱 화면, 저장(IndexedDB), 포장 → 2b 계획

## Global Constraints

- `packages/core/src`는 Node·DOM을 쓰지 않는다. `tsconfig.json`이 `types: []`, `lib: ES2022`로 이를 강제한다.
- 시간 판정은 모두 프레임·입력 타임스탬프 `t`(ms) 기준이다. `Date.now()`와 `performance.now()`는 쓰지 않는다.
- 실시간 처리: `push`/`tick`은 즉시 처리하고 결과를 돌려준다. 미래 프레임을 기다리지 않는다.
- **실패하는 테스트를 먼저 쓴다.** 구현 전에 RED를 확인하고 그 출력을 보고서에 남긴다(사용자 방식).
- 기존 테스트 134개의 **기대값은 바꾸지 않는다.** API 호출 방식은 바꿔도 된다. 단, 스펙이 동작을 바꾸라고 한 곳은 예외다(벤치 한쪽 팔, 보정 타임아웃 기준).
- 합격 테스트의 회귀 기준(`expectedReplayCount`, `expectedReplayHeldMs`)은 정확히 유지한다.
  - 예외: 몸통 각도(#3) 변경으로 보정 시각이 달라져 값이 바뀌면, 바뀐 값과 이유를 보고서에 적고 manifest를 갱신한다.
  - 사람이 센 값 기준(±1)은 반드시 통과해야 한다.
- `packages/core/test/fixtures/private/`의 녹화는 읽기만 한다. 내용은 보고서에 옮기지 않고 커밋하지 않는다. manifest.json(메타)은 수정해도 된다.
- 음성 문구는 코어에 두지 않는다. 코어는 이벤트만 낸다.
- 커밋 메시지는 한국어로 쓰고, 마지막 줄은 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **세트 중 프레임이 끊김**(카메라 멈춤, 앱 백그라운드): `tick(t)`만 와도 카운트다운이 진행되고, 반복 없음 종료와 쉬는 시간이 시간대로 끝나야 한다. (Task 6, Task 7 테스트)
2. **카운트다운 3초 안에 벌써 움직이기 시작함**: "시작" 전에 확정된 반복은 세지 않고, 시작 후 첫 반복이 1이어야 한다. (Task 6 테스트)
3. **일시정지했다가 다시 시작**: 일시정지 동안은 세지 않고, 반복 없음 타이머와 쉬는 시간에 일시정지 시간이 들어가지 않아야 한다. (Task 6, Task 7 테스트)
4. **쉬는 시간이 20초 이하**: 다음 안내(nextUp)가 쉬는 시간 시작 때 바로 나와야 한다. (Task 7 테스트)
5. **첫 세트 준비 자세 대기 중에 그만하기**: 세트 0개, `completed: false` 세션이 나오고 빈 세트는 기록하지 않아야 한다. (Task 7 테스트)

---

## 파일 구조

```
packages/core/src/
  counter/repEngine.ts        # 새 공통 껍데기 (가림·재무장·최소 시간·이벤트·부호·countAt)
  counter/strategies.ts       # fixedStrategy, adaptiveStrategy (판정 전략)
  counter/repCounter.ts       # RepCounter = 껍데기+fixed 의 얇은 파사드 (기존 테스트 유지용)
  counter/adaptiveRepCounter.ts # AdaptiveRepCounter = 껍데기+adaptive 파사드
  counter/holdTimer.ts        # 그대로
  exercises/definitions.ts    # mode·start·idleEndMs 추가, 벤치 신호, world 몸통각
  exercises/runner.ts         # TrackerState 판별 유니온, diagnosis
  session/model.ts            # Target, Routine, SetLog, WorkoutSession 타입
  session/setRunner.ts        # SetRunner
  session/routineRunner.ts    # RoutineRunner
  session/recommend.ts        # recommendNext, completedCount
packages/core/test/
  repEngine.test.ts  setRunner.test.ts  routineRunner.test.ts  recommend.test.ts  (+ 기존 파일 수정)
apps/spike/index.html          # CSP (Task 8)
```

---

### Task 1: 덤벨 벤치프레스는 보이는 팔만으로 판단 (스펙 5.6b)

**Files:** Modify `packages/core/src/exercises/definitions.ts`, `packages/core/test/exercises.test.ts`, `docs/superpowers/plans/2026-11-18-phase0-and-counter-core.md`(Task 6 표의 dumbbellBench 행)

**Interfaces:** Produces: `EXERCISES.dumbbellBench.signal = meanVisibleArms` (pullup·negative와 같은 함수)

- [ ] **Step 1: 실패 테스트** — exercises.test.ts의 "dumbbellBench: 한쪽 팔 hidden → count 0, paused" 테스트를 바꿔요. 한쪽 팔(13, 15)이 hidden이어도 **보이는 팔로 1회를 세고 paused는 false**여야 해요. 양팔 모두 hidden이면 paused true로 두세요.
- [ ] **Step 2: RED 확인** — `npm test -w packages/core -- exercises` → 바꾼 테스트가 실패해야 해요.
- [ ] **Step 3: 구현** — dumbbellBench의 signal을 `meanVisibleArms`로 바꾸세요. 쓰지 않게 된 `bothArmsMean`은 지우세요.
- [ ] **Step 4: GREEN** — `npm test -w packages/core` 전부 통과
- [ ] **Step 5: 커밋** — `fix(core): 덤벨 벤치프레스는 보이는 팔만으로 판단 (#6 위험 완화)`

### Task 2: 몸통 기울기를 world 좌표로 (#3)

**Files:** Modify `packages/core/src/exercises/definitions.ts`, Test `packages/core/test/exercises.test.ts`

**Interfaces:** 바깥으로 보이는 변화는 없어요(lyingReady·uprightReady 동작이 화면 비율에 영향받지 않게 됨).

- [ ] **Step 1: 실패 테스트** — `world` 좌표 기준으로 몸통이 수평인 포즈를 만들고, **`image` 좌표만 가로로 1.78배 늘린** 프레임(세로 화면 흉내)에서도 `lyingReady`가 true여야 해요. 반대로 world 기준 수평에서 50° 기운 포즈는 image가 어떻든 false여야 해요. 정의 함수를 바로 시험하기 어려우면 `EXERCISES.pushup.ready`로 시험하세요.
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — `torsoTiltFromHorizontal`을 world 좌표로 계산하세요. 기울기 = `atan2(|dy|, hypot(dx, dz))`(수평면 대비 각도, 0=수평, 90=수직)이에요. 보이는 점 고르기는 지금처럼 image visibility로 해요.
- [ ] **Step 4: GREEN과 합격 테스트** — `npm test -w packages/core` 통과. 회귀 기준값이 바뀌면 Global Constraints대로 처리해요(바뀐 값과 이유를 보고서에 적고 manifest 갱신, 사람 기준 ±1은 반드시 통과).
- [ ] **Step 5: 커밋** — `fix(core): 몸통 기울기를 world 좌표로 계산 (#3)`

### Task 3: 보정 타임아웃은 관측 최고점 사용, 보정 출처 노출 (#2 앞부분)

**Files:** Modify `packages/core/src/counter/adaptiveRepCounter.ts`, Test `packages/core/test/adaptiveRepCounter.test.ts`

**Interfaces:** Produces: `AdaptiveRepCounter.calibrationSource: 'measured' | 'observed' | 'default' | null` (보정 전 null)

- [ ] **Step 1: 실패 테스트**
  - 계속 움직이다 3초 타임아웃이 나는 시나리오(관측 최고값 158, 기본값 165): `baseline === 158`, `calibrationSource === 'observed'`
  - 보정 구간에 유효 신호가 하나도 없이 타임아웃: `baseline === defaultBaseline`, `'default'`
  - 정상 보정: `'measured'`
  - restSide 'low'면 관측 **최솟값**을 쓰는지(부호 반전)
  - 기존 "타임아웃이면 defaultBaseline" 테스트(3번)는 이 스펙대로 기대값을 바꿔요(스펙 5.2가 허용한 변경).
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — 보정 구간이 마지막으로 비워진 뒤부터 타임아웃까지 받은 유효 신호(ready 여부와 무관)의 rest 쪽 최고값을 기억해 두었다가, 타임아웃 때 기준으로 써요.
- [ ] **Step 4: GREEN** — 전체 테스트 통과
- [ ] **Step 5: 커밋** — `feat(core): 보정 타임아웃 시 관측 최고점 사용 (#2)`

### Task 4: 카운터 공통 껍데기로 통합 (#4) — 판단이 많은 작업, 가장 강한 모델 권장

**Files:**
- Create `packages/core/src/counter/repEngine.ts`, `packages/core/src/counter/strategies.ts`, `packages/core/test/repEngine.test.ts`
- Modify `packages/core/src/counter/repCounter.ts`, `packages/core/src/counter/adaptiveRepCounter.ts`(파사드로)

**Interfaces:**
- Produces:
  ```ts
  // repEngine.ts
  interface JudgeStrategy {
    // 부호 반전된(rest 쪽이 큰) 신호 s로 판정. 껍데기가 상태·시간·이벤트를 관리하고 전략은 "선"만 정한다.
    onSignal(t: number, s: number, ready: boolean | null): void; // 보정 등 전략 내부 상태 갱신
    ready(): boolean;                 // 판정할 준비가 됐는지 (fixed는 항상 true, adaptive는 보정 끝)
    startLine(peak: number): number;  // rest → out 기준
    turnLine(): number;               // out → turned 기준
    completeLine(valley: number): number; // turned → rest(1회) 기준
    abortLine(peak: number): number;  // out 중 미도달 복귀 기준
    rearmLine(): number;              // 재무장선
  }
  class RepEngine {
    constructor(strategy: JudgeStrategy, cfg: { restSide: 'high'|'low'; minRepMs: number; pauseAfterMs: number; countAt?: 'return'|'turn' });
    update(t: number, signal: number | null, ready?: boolean | null): RepEvent | null;
    get count(): number; get phase(): 'calibrating'|'rest'|'out'|'turned'|'paused'; get paused(): boolean;
    reset(): void;
  }
  // strategies.ts
  function fixedStrategy(cfg: RepConfig): JudgeStrategy;
  function adaptiveStrategy(cfg: AdaptiveConfig): JudgeStrategy & { readonly baseline: number | null; readonly calibrated: boolean; readonly calibrationSource: 'measured'|'observed'|'default'|null };
  ```
  - `RepCounter`와 `AdaptiveRepCounter`는 위 둘을 조합한 파사드로 남겨요. 생성자와 getter 이름은 지금과 같아요.
- 위 인터페이스는 **제안**이에요. 두 클래스의 현재 동작을 그대로 담을 수 있으면 메서드 모양은 바꿔도 돼요. 대신 바꾼 모양을 보고서에 적으세요.

- [ ] **Step 1: 동작 차이 조사와 고정** — 두 클래스의 의미 차이를 표로 정리해요. 예: 오래 가림을 Rep은 null 프레임에서 처리하고 Adaptive는 신호가 돌아올 때 처리해요. 각 차이를 지금 동작 그대로 고정하는 테스트를 `repEngine.test.ts`에 추가해요(현재 코드에서 GREEN이어야 해요. "특성 테스트"). 둘이 다르게 동작해야 할 이유가 없는 차이는 하나로 맞추되, **기존 테스트 기대값이 바뀌면 그 차이는 맞추지 말고** 보고서에 적어요.
- [ ] **Step 2: RED** — 껍데기와 전략 모듈 없이 `repEngine.test.ts`의 새 테스트(RepEngine + fixedStrategy로 기존 시나리오 2~3개)가 실패하는지 확인해요.
- [ ] **Step 3: 구현** — RepEngine과 두 전략을 만들고, 두 파사드가 그것을 쓰게 해요. 가림, 재무장, 최소 시간, RepEvent, 부호, countAt 코드는 껍데기 한 곳에만 있어야 해요.
- [ ] **Step 4: GREEN** — `npm test -w packages/core` 전부 통과(합격 테스트 회귀값 포함), `npm run typecheck -w packages/core`
- [ ] **Step 5: 커밋** — `refactor(core): RepCounter·AdaptiveRepCounter를 공통 껍데기와 판정 전략으로 통합 (#4)`

### Task 5: TrackerState 판별 유니온, 진단, 운동별 시작 방식 (#4 나머지, #2 진단)

**Files:**
- Modify `packages/core/src/exercises/runner.ts`, `packages/core/src/exercises/definitions.ts`, `packages/core/src/index.ts`, `packages/core/scripts/replay.ts`, `packages/core/test/exercises.test.ts`, `packages/core/test/acceptance.test.ts`(필요 시)
- Modify `apps/spike/src/main.ts`, `apps/spike/src/hud.ts`(새 상태 타입에 맞추기)

**Interfaces:**
- Produces (스펙 5.1 그대로):
  ```ts
  type Diagnosis = 'ok' | 'notVisible' | 'notReady' | 'calibratedByDefault';
  type RepTrackerState = { kind: 'reps'; count: number; lastRep: RepEvent | null;
    phase: 'calibrating'|'rest'|'out'|'turned'|'paused'; baseline: number | null; diagnosis: Diagnosis };
  type HoldTrackerState = { kind: 'hold'; heldMs: number; state: 'idle'|'holding'|'ended'; diagnosis: Diagnosis };
  type TrackerState = RepTrackerState | HoldTrackerState;
  type StartMode = 'calibrate' | 'pose' | 'visible';
  // ExerciseDef 공통에 추가: start: StartMode; idleEndMs: number; startPose?(f: PoseFrame): boolean | null
  ```
- 정의 값: squat·pushup·dumbbellBench는 `start: 'calibrate'`. pullup은 `start: 'pose'`이고 `startPose = deadHangHolding`. deadHang은 `start: 'pose'`. negative는 `start: 'visible'`. `idleEndMs`는 negative만 8000이고 나머지는 5000이에요.
- diagnosis 규칙
  - 이번 프레임 신호(또는 holding)가 null이면 `notVisible`
  - 보정 중이고 이번 프레임 ready가 false면 `notReady`
  - `calibrationSource === 'default'` 또는 `'observed'`로 보정됐으면 `calibratedByDefault`
  - 그 외 `ok`
  - 우선순위는 notVisible > notReady > calibratedByDefault
- 운동 정의는 `mode: 'fixed' | 'adaptive'` 판별자를 갖게 해요. runner의 non-null 단언(`def.rep!`, `(adaptive ?? fixed)!`)을 없애세요.
- `EXERCISES`는 `satisfies Record<ExerciseId, ExerciseDef>` 형태로 바꿔 개별 정의의 타입이 좁혀지게 해요. 테스트의 `as unknown as` 캐스트를 줄이세요.

- [ ] **Step 1: 실패 테스트** (exercises.test.ts)
  - squat 트래커 state의 `kind === 'reps'`
  - deadHang의 `kind === 'hold'`
  - 관절을 다 hidden으로 → `diagnosis === 'notVisible'`
  - 서 있는 자세의 pushup 보정 중 → `'notReady'`
  - 3초 타임아웃 보정 → `'calibratedByDefault'`
  - 정의의 start, idleEndMs 값
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — runner, definitions, index 재수출, replay CLI 출력을 바꿔요. 출력 JSON은 `kind`에 따라 count 또는 heldMs를 담아요. 기존 키 `count`, `heldMs`, `reps`는 유지해요(합격 테스트·CLI 테스트 호환). 스파이크 앱의 HUD와 진단 표시도 새 타입에 맞춰요.
- [ ] **Step 4: GREEN** — `npm test -w packages/core`, `npm run typecheck -w packages/core`, `npm run build -w apps/spike`
- [ ] **Step 5: 커밋** — `refactor(core): TrackerState 판별 유니온과 진단, 운동별 시작 방식 (#4, #2)`

### Task 6: 세트 진행기 SetRunner (스펙 2절, 5.4, #1)

**Files:** Create `packages/core/src/session/model.ts`(Target·EndReason·SetResult 타입만 먼저), `packages/core/src/session/setRunner.ts`, `packages/core/test/setRunner.test.ts`. Modify `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `createTracker`, `TrackerState`, `Diagnosis`, `ExerciseDef.start/idleEndMs/startPose`(Task 5)
- Produces:
  ```ts
  type Target = { kind: 'reps'; reps: number } | { kind: 'seconds'; seconds: number };
  type EndReason = 'target' | 'idle' | 'manual' | 'released' | 'noStart';
  type SetResult = { exercise: ExerciseId; target: Target; count: number; heldMs: number;
    negativeDescentMs: number[]; startT: number; endT: number; endReason: EndReason };
  type SetConfig = { exercise: ExerciseId; target: Target; countdownMs?: number /*기본 3000*/;
    noStartMs?: number /*기본 20000*/; undoBeforeStopMs?: number /*기본 1500*/; idleEndMs?: number /*기본 정의값*/;
    hintRepeatMs?: number /*기본 10000*/ };
  type SetPhase = 'waitingReady' | 'countdown' | 'active' | 'finished';
  type SetEvent =
    | { type: 'countdown'; n: 3 | 2 | 1 } | { type: 'start' } | { type: 'backToReady' }
    | { type: 'rep'; count: number } | { type: 'hold'; seconds: number } | { type: 'goalReached' }
    | { type: 'hint'; diagnosis: Exclude<Diagnosis, 'ok'> }
    | { type: 'finished'; reason: EndReason; result: SetResult };
  class SetRunner {
    constructor(cfg: SetConfig);
    push(f: PoseFrame): SetEvent[];   // 프레임 처리 (f.t가 현재 시각)
    tick(t: number): SetEvent[];      // 프레임 없이 시간만 진행
    pause(t: number): void; resume(t: number): void;
    stop(t: number): SetEvent[];      // 그만하기: finished('manual') — waitingReady면 빈 배열과 phase 'finished', result는 null
    get phase(): SetPhase; get tracker(): TrackerState; get result(): SetResult | null;
  }
  ```
- 동작 규칙(스펙 2절)
  - **waitingReady**: 트래커에 프레임을 넣어요. 운동의 start 방식에 따라 다음으로 넘어가요.
    - `calibrate`: 보정이 끝나면 countdown
    - `pose`: `startPose`(deadHang은 holding)가 300ms 이어지면 바로 active(`start` 이벤트, 카운트다운 없음)
    - `visible`: 신호가 null이 아니면 바로 active
  - **countdown**: 들어갈 때 n=3, +1000ms에 2, +2000ms에 1, +3000ms에 `start`를 내요(`countdownMs`가 0이면 바로 start). 카운트다운 중에 자세가 깨져도 진행해요. 트래커는 계속 돌리되, **start 시점의 count를 기준점으로 삼아** 그 전에 확정된 반복은 세지 않아요.
  - **active(횟수)**
    - 반복이 확정될 때마다 `rep(count)`. count는 기준점에서 뺀 값이에요.
    - 목표에 닿으면 `goalReached`와 `finished('target')`
    - 첫 반복 뒤 마지막 반복에서 `idleEndMs`가 지나면 `finished('idle')`
    - 첫 반복이 `noStartMs` 동안 없으면 `backToReady`. 트래커를 새로 만들고 waitingReady로 가요.
  - **active(매달리기)**
    - heldMs가 1초를 넘길 때마다 `hold(seconds)`
    - 목표 초에 처음 닿으면 `goalReached`(끝내지 않음)
    - HoldTimer가 ended면 `finished('released')`
  - **stop(t)**: `endT > t - undoBeforeStopMs`인 반복은 count에서 빼요(#1). negativeDescentMs도 맞춰서 빼요. 그리고 `finished('manual')`
  - **pause/resume**: 일시정지 중의 push와 tick은 무시해요. resume 때 idle, noStart, 카운트다운 기준 시각을 일시정지한 시간만큼 뒤로 미뤄요.
  - **hint**: 트래커 diagnosis가 ok가 아니면 같은 진단은 `hintRepeatMs`에 한 번만 내요(waitingReady와 active 모두).
  - **결과**: negativeDescentMs는 negative 운동의 RepEvent.outMs 목록이에요(다른 운동은 빈 배열). startT는 start 이벤트 시각, endT는 finished 시각이에요.

- [ ] **Step 1: 실패 테스트** (setRunner.test.ts, buildPose/series 합성 프레임) — 아래를 각각 테스트로 써요.
  - squat
    - 준비 자세 1초 → countdown 3,2,1 이벤트 시각(±40ms) → start → 3회 → `rep` 1,2,3
    - 목표 3이면 `goalReached`와 `finished('target')`, result.count 3
  - 목표 10에서 8회 뒤 정지
    - 마지막 반복 + 5000ms에 `finished('idle')`, count 8
    - negative는 8000ms에서 끝나는지 확인
  - **카운트다운 중 반복**(Review Focus 2): 카운트다운 2초째에 1회 확정 → start 뒤 첫 rep 이벤트 count가 1
  - start 뒤 20초 반복 없음 → `backToReady`, phase waitingReady
  - deadHang
    - 매달림 300ms → 바로 `start`(countdown 이벤트 없음)
    - 1초마다 hold 1, 2, 3…
    - 목표 5초에 goalReached를 한 번만 내고 계속 셈
    - 손을 놓으면 `finished('released')`
  - pullup: 매달림 자세 300ms → 카운트다운 없이 start
  - negative: 관절이 보이자마자 start
  - stop
    - 마지막 반복 0.5초 뒤 stop → 그 반복은 빼요(count 5 → 4)
    - 마지막 반복 3초 뒤 stop → 빼지 않아요
    - waitingReady에서 stop → result null
  - **프레임 끊김**(Review Focus 1): active에서 반복 2회 뒤 push 없이 tick만 → 5000ms에 `finished('idle')`. countdown 중 tick만으로도 start
  - **일시정지**(Review Focus 3): 2회 뒤 pause 10초 → resume → 4초 뒤 아직 안 끝남, 5초 뒤 idle 종료. 일시정지 중 push된 반복은 세지 않음
  - hint: 관절 hidden 상태 30초 동안 notVisible hint가 3번(0, 10, 20초)
  - **실녹화**: manifest의 각 녹화를 `countdownMs: 0`으로 SetRunner에 넣었을 때 result.count가 사람 기준(expectedCount) ±1. 녹화 끝의 반복 없음은 tick으로 마무리하고, manifest가 없으면 skip
- [ ] **Step 2: RED 확인** — 모듈 없음 실패만 보고 끝내지 말고, 빈 껍데기(아무 이벤트도 안 냄)로도 돌려서 각 테스트가 판정에서 실패하는지 확인해요.
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN** — 전체 테스트, typecheck
- [ ] **Step 5: 커밋** — `feat(core): 손 안 대는 세트 진행기 SetRunner (#1)`

### Task 7: 루틴 진행기 RoutineRunner, 데이터 모델, 오늘의 루틴 추천

**Files:**
- Modify `packages/core/src/session/model.ts`
- Create `packages/core/src/session/routineRunner.ts`, `packages/core/src/session/recommend.ts`, `packages/core/test/routineRunner.test.ts`, `packages/core/test/recommend.test.ts`
- Modify `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `SetRunner`, `SetEvent`, `SetResult`, `Target`, `EndReason`(Task 6)
- Produces (스펙 5.6 그대로, model.ts에 추가):
  ```ts
  type RoutineExercise = { exercise: ExerciseId; sets: number; target: Target; restSec: number };
  type Routine = { id: string; name: string; order: number; exercises: RoutineExercise[]; createdAt: number; updatedAt: number };
  type SetLog = SetResult & { setIndex: number; restTakenMs: number | null };
  type WorkoutSession = { id: string; routineId: string; routineName: string; startedAt: number; endedAt: number; completed: boolean; sets: SetLog[] };
  type RoutineEvent =
    | { type: 'exerciseStart'; exerciseIndex: number; exercise: ExerciseId }
    | { type: 'set'; exerciseIndex: number; setIndex: number; event: SetEvent }
    | { type: 'restStart'; seconds: number }
    | { type: 'restTick'; remaining: number }
    | { type: 'nextUp'; exercise: ExerciseId; setIndex: number; target: Target }
    | { type: 'restEnd' }
    | { type: 'routineEnd'; session: WorkoutSession };
  class RoutineRunner {
    constructor(routine: Routine, opts: { startT: number; sessionId: string; toEpoch?: (t: number) => number; set?: Partial<Omit<SetConfig, 'exercise' | 'target'>> });
    push(f: PoseFrame): RoutineEvent[]; tick(t: number): RoutineEvent[];
    pause(t: number): void; resume(t: number): void;
    skipExercise(t: number): RoutineEvent[]; stop(t: number): RoutineEvent[];
    get phase(): 'set' | 'rest' | 'done'; get current(): { exerciseIndex: number; setIndex: number };
  }
  function recommendNext(routines: Routine[], sessions: WorkoutSession[]): Routine | null;
  function completedCount(routineId: string, sessions: WorkoutSession[]): number;
  ```
- 동작 규칙(스펙 2절, 5.5)
  - 첫 운동의 첫 세트부터 시작해요. 운동이 바뀔 때마다 `exerciseStart`를 내요.
  - 세트가 finished되면 쉬는 시간을 시작해요(마지막 운동의 마지막 세트면 바로 routineEnd).
    - 같은 운동의 다음 세트로 갈 때는 그 운동의 restSec을 써요.
    - 다음 운동으로 넘어갈 때는 **다음 운동의** restSec을 써요.
    - restSec이 0이면 쉬는 시간 없이 바로 다음 세트예요.
  - **쉬는 시간 이벤트**
    - `restStart(seconds)`
    - `restTick`: 남은 초가 10의 배수일 때와 5·4·3·2·1일 때, 정수 초마다 최대 한 번
    - `nextUp`: 남은 20초. 쉬는 시간이 20초 이하면 restStart 직후 바로
    - `restEnd`
  - 쉬는 시간 중 프레임은 SetRunner에 넣지 않아요. restEnd 뒤에 다음 SetRunner를 새로 만들어요(waitingReady).
  - `restTakenMs` = 이전 세트 endT부터 이번 세트 startT까지예요. 첫 세트는 null이에요.
  - 세트가 `backToReady`를 내도 같은 세트를 유지해요.
  - **skipExercise**: 진행 중인 세트에 반복이 있으면(count>0이나 heldMs>0) manual로 끝내 기록하고, 없으면 기록하지 않아요. 그다음 운동으로 넘어가요(쉬는 시간 없이 다음 운동 waitingReady). 건너뛰면 세션 completed는 false예요.
  - **stop**: 진행 중 세트를 SetRunner.stop으로 끝내요. 결과가 있고 반복이 있으면 기록하고, `routineEnd(completed:false)`를 내요.
  - **completed**: 모든 운동의 모든 세트가 finished(manual 제외)로 기록됐을 때만 true예요.
  - **pause/resume**: 세트 중이면 SetRunner에 전달하고, 쉬는 시간이면 남은 시간을 멈춰요.
  - `startedAt` = toEpoch(startT), `endedAt` = toEpoch(종료 t). toEpoch 기본값은 항등 함수예요.
- recommendNext
  - routines를 order로 정렬해요.
  - completed 세션 중 endedAt이 가장 큰 세션의 routineId 다음 순서(마지막이면 처음으로)를 추천해요.
  - completed 세션이 없거나, 그 루틴이 지워졌으면 첫 루틴을 추천해요.
  - routines가 비면 null이에요.
- completedCount: 그 루틴의 completed 세션 수예요(화면의 "N번째"는 +1).

- [ ] **Step 1: 실패 테스트** (routineRunner.test.ts, recommend.test.ts). 세트 진행은 `set: { countdownMs: 0 }`과 합성 프레임으로 빠르게 끝내요.
  - 2운동 × 2세트 루틴
    - 이벤트 순서: exerciseStart → set… → restStart → … → routineEnd
    - sets 4개, completed true
    - restTakenMs가 실제 쉰 시간(±50)
  - 쉬는 시간 60초
    - restTick 남은 값이 50,40,30,20,10,5,4,3,2,1
    - nextUp이 남은 20초에 한 번
  - **쉬는 시간 15초**(Review Focus 4): nextUp이 restStart와 같은 호출에서 나옴
  - 운동 사이 쉬는 시간은 다음 운동의 restSec
  - restSec 0이면 restStart 없음
  - **프레임 없이 tick만으로 쉬는 시간이 끝남**(Review Focus 1)
  - **쉬는 시간 중 pause 10초**(Review Focus 3): restEnd가 10초 늦게 나옴
  - skipExercise
    - 반복이 있는 세트는 기록되고 다음 운동으로 감
    - completed false
  - **첫 세트 waitingReady 중 stop**(Review Focus 5): sets 0, completed false
  - 두 번째 세트 중 stop: 첫 세트와 반복이 있는 두 번째 세트가 기록됨, completed false
  - recommendNext
    - 세션 없음 → order 첫 루틴
    - 마지막 완료가 B면 C
    - 마지막이 마지막 순서면 처음으로
    - 미완료 세션은 무시
    - 지워진 루틴 → 첫 루틴
    - 빈 목록 → null
  - completedCount: 완료 세션만 셈
- [ ] **Step 2: RED 확인** — 빈 껍데기로 판정 실패를 확인해요.
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN** — 전체 테스트와 typecheck
- [ ] **Step 5: 커밋** — `feat(core): 루틴 진행기·데이터 모델·오늘의 루틴 추천`

### Task 8: CSP로 네트워크 차단 확인 (#5, 스펙 5.7)

**Files:** Modify `apps/spike/index.html`, `apps/spike/README.md`, `docs/specs/2026-11-20-phase2-routine-app-design.md`(5.7에 확인 결과)

- [ ] **Step 1: 실패 확인(RED)** — 스파이크 Electron 자가 점검(`WOM_SELFTEST=1`)에 renderer에서 `fetch('https://example.com')`, `XMLHttpRequest`, `navigator.sendBeacon`을 시도하는 항목을 추가해요. CSP가 없을 때 XHR과 sendBeacon이 **renderer 단계에서는 막히지 않는 것**(webRequest가 막기 전에 요청이 시작됨)을 출력으로 확인해요. 판정 기준은 "CSP 위반(securitypolicyviolation) 이벤트가 0건"이에요.
- [ ] **Step 2: 구현** — index.html에 스펙 5.7의 CSP meta를 넣어요.
- [ ] **Step 3: GREEN** — 자가 점검을 다시 돌려요(`npm run electron:build -w apps/spike`와 자가 점검 실행). 확인할 것:
  - 위 세 시도가 CSP 위반 이벤트로 막히는지
  - MediaPipe 랜드마커 4종(lite/full × GPU/CPU)이 여전히 생성되는지
  - wasm 로딩 오류가 없는지
  - 막히면 CSP를 최소한으로 넓히고, 넓힌 지시어와 이유를 기록해요.
- [ ] **Step 4: Android** — `npm run android:build -w apps/spike`와 APK 빌드를 성공시켜요. S23 확인은 사용자 몫이고, README에 확인 방법을 적어요.
- [ ] **Step 5: 커밋** — `feat(spike): CSP로 renderer 단계 네트워크 차단 (#5)`

---

## 다음 계획 (2b)
`apps/app` React 앱, IndexedDB 저장, 화면 6개, 음성 문구, Android·PC 포장, CI 확장. 이 계획(2a)의 인터페이스가 확정된 뒤에 쓴다.
