# Phase 2b 손 안 대는 루틴 앱 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2a 코어 위에 실제로 쓰는 루틴 앱 `apps/app`을 만든다. 화면 6개, 음성 안내, IndexedDB 저장, Android·PC 포장이 들어간다. 사용자는 폰을 바닥에 세워 두고 손대지 않은 채 루틴 하나를 끝까지 할 수 있어야 한다.

**Architecture:**
- 코어(`packages/core`)를 먼저 보강한다. 반영할 결정은 spec 10절 (a)(b)(c)(d)(i)이다.
- 앱은 React 화면, 순수 로직, 플랫폼 포트로 나눈다.
  - 화면: React
  - 순수 로직: 음성 문구, 입력 검증, 운동 엔진
  - 플랫폼 포트: 자세 인식, 음성, 화면 켜짐, 저장
- 운동 엔진이 RoutineRunner를 프레임과 tick으로 돌리고, 이벤트를 음성·화면·저장으로 바꾼다.
- 포장은 시험용 앱(`apps/spike`)에서 검증한 설정을 옮긴다.

**Tech Stack:** TypeScript 7, React 18, Vite, Vitest, @testing-library/react, jsdom, idb, fake-indexeddb(테스트용), @mediapipe/tasks-vision 1.2.3, Capacitor 8, Electron 45

**Spec:** `docs/specs/2026-11-20-phase2-routine-app-design.md` (특히 2절, 6절, 10절·10.1)

## Global Constraints

- **서버·클라우드 없음, 실행 중 네트워크 요청 0건.**
  - Android: INTERNET 권한 없음, `allowBackup="false"`
  - PC(Electron): 외부 요청 차단, 새 창·이동 차단
  - 공통: CSP
- 영상과 관절 좌표는 저장하지 않는다. 저장 대상은 루틴과 세션 기록뿐이다.
- 사용자에게 보이는 글과 음성은 모두 한국어다.
- **실패하는 테스트를 먼저 쓴다.** 구현 전에 RED를 확인하고 출력을 보고서에 남긴다(사용자 방식). 화면 작업도 컴포넌트 테스트로 RED를 먼저 본다.
- `packages/core/src`는 Node·DOM을 쓰지 않는다. 시간은 입력 `t`로만 다룬다.
- 앱은 시계를 하나만 쓴다. push의 `f.t`와 `tick(t)`는 모두 `performance.now()` 기준이다. `toEpoch = (t) => t + (Date.now() - performance.now())`이고, 이 오프셋은 루틴 시작 때 한 번만 계산한다.
- 저장은 `routineEnd.session`과 세트마다 하는 중간 스냅샷으로만 한다. `set(finished).result`는 프레임 시계라서 저장하지 않는다.
- 0부터 세는 `exerciseIndex`·`setIndex`는 화면과 음성에서 +1 해서 보여 준다.
- 기존 코어 테스트 294개와 합격 테스트의 회귀값은 유지한다.
- 커밋 메시지는 한국어로 쓰고, 마지막 줄은 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`이다.

## Review Focus

1. **세트 중 앱이 백그라운드로 감**(전화, 화면 꺼짐): 자동으로 일시정지한다. 돌아오면 "다시 시작" 버튼이 보이고, 누른 직후 idle로 세트가 끝나지 않아야 한다. (Task 1, Task 8 테스트)
2. **카메라 권한 거부·카메라 없음**: 빈 화면이 아니라 한국어 안내("카메라 권한이 필요해요…")와 다시 시도 버튼이 보여야 한다. (Task 8, Task 9 테스트)
3. **루틴 도중 앱이 꺼짐**: 마지막으로 끝난 세트까지 `completed:false` 세션으로 기록에 남아야 한다. (Task 2, Task 8 테스트)
4. **음성이 안 되는 기기**(TTS 없음·한국어 음성 없음): 앱이 멈추지 않고 화면 표시만으로 진행해야 한다. (Task 7, Task 8 테스트)
5. **루틴을 지우거나 이름을 바꾼 뒤 기록 보기**: 기록은 저장할 때의 루틴 이름을 그대로 보여 주고, 추천은 지워진 루틴을 건너뛰어야 한다. (Task 6 테스트)

---

## 파일 구조

```
packages/core/src/session/setRunner.ts        # (a)(b)(c) 보강
packages/core/src/session/routineRunner.ts    # (d) snapshot, (i) sessionSoFar
apps/app/
  index.html  vite.config.ts  package.json  tsconfig.json  vitest.config.ts
  src/main.tsx  src/App.tsx  src/style.css
  src/ports/{pose.ts,speech.ts,keepAwake.ts,storage.ts}      # 포트 인터페이스
  src/platform/{mediapipePose.ts,webSpeech.ts,nativeSpeech.ts,keepAwake.ts}  # 구현
  src/storage/{idbStorage.ts,memoryStorage.ts}
  src/domain/{validate.ts,phrases.ts,koNumbers.ts}           # 순수 로직
  src/workout/{engine.ts,useWorkout.ts}                      # 운동 엔진
  src/screens/{Home.tsx,RoutineEdit.tsx,History.tsx,SessionDetail.tsx,Placement.tsx,Workout.tsx,Rest.tsx,Summary.tsx}
  test/**/*.test.ts(x)
  android/  electron/{main.ts,preload.ts}  scripts/*
```

---

### Task 1: SetRunner 보강 — 안내 지속 시간, 복귀 여유, 다시 시작 규칙 (spec 10 (a)(b)(c))

**Files:** Modify `packages/core/src/session/setRunner.ts`, Test `packages/core/test/setRunner.test.ts`, Modify spec 5.4(동작 갱신)

**Interfaces:**
- Produces: `SetConfig`에 `hintAfterMs?: number`(기본 1500), `notReadyGraceMs?: number`(기본 3000) 추가. 그 밖의 공개 API는 그대로다.

- [ ] **Step 1: 실패 테스트**
  - (a) 같은 진단이 1400ms 이어지면 hint 없음, 1500ms 이어지면 hint 1번. 중간에 1프레임 ok가 끼면 다시 잰다.
  - (a) waitingReady에 들어간 뒤 2900ms 동안은 notReady가 이어져도 hint가 없다. 3000ms + 1500ms 이후에는 hint가 나온다. notVisible에는 유예가 없다(1500ms 규칙만 적용).
  - (b) 반복 2회 → 4초 지남 → pause 10초 → resume → **resume 뒤 4999ms 안에는 idle 종료가 없고**, 5000ms에 idle 종료. noStart도 같다.
  - (c) squat: start 뒤 20초 반복 없음 → `backToReady` 1번 → 그대로 서 있기만 1분 → **countdown과 start가 없고 backToReady도 다시 나오지 않음**. 그 뒤 자세를 흐트러뜨리고(ready false 또는 신호 null 1프레임 이상) 다시 준비 자세 → 보정 → countdown → start.
  - (c) pullup: 매달린 채 20초 → backToReady → 계속 매달림 → start 없음 → 내려왔다가(startPose false) 다시 매달림 300ms → start.
- [ ] **Step 2: RED 확인** — `npm test -w packages/core -- setRunner`
- [ ] **Step 3: 구현** — 진단별로 시작 시각을 기억하는 지속 타이머를 둔다. 유예는 waitingReady에 들어간 시각을 기준으로 잰다. resume은 `idleFrom = max(idleFrom + d, resumeT)`로 한다. backToReady 뒤에는 "흐트러짐을 봤는지" 플래그가 서야만 시작 판정을 받는다.
- [ ] **Step 4: GREEN과 회귀** — `npm test -w packages/core`(294개와 합격 테스트), typecheck. 실녹화 SetRunner 테스트(카운트다운 0)도 통과해야 한다.
- [ ] **Step 5: spec 5.4를 갱신하고 커밋** — `feat(core): 안내 지속 시간·복귀 여유·다시 시작 규칙 (#2 보강)`

### Task 2: RoutineRunner 조회와 중간 스냅샷 (spec 10 (d)(i))

**Files:** Modify `packages/core/src/session/routineRunner.ts`, `packages/core/src/index.ts`, Test `packages/core/test/routineRunner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type RoutineSnapshot = {
    phase: RoutinePhase; paused: boolean; exerciseIndex: number; setIndex: number;
    set: { phase: SetPhase; tracker: TrackerState; count: number; heldMs: number } | null;   // 세트 중일 때만
    rest: { remainingMs: number; totalMs: number; next: NextSet } | null;                    // 쉬는 시간일 때만
  };
  // RoutineRunner
  snapshot(t: number): RoutineSnapshot;          // t 기준 남은 쉬는 시간(일시정지 반영), 상태를 바꾸지 않는다
  sessionSoFar(t: number): WorkoutSession;       // 지금까지 기록된 세트로 completed:false 세션(저장용, toEpoch 적용)
  ```
- `set.count`는 start 이후 센 반복 수다. waitingReady와 countdown에서는 0이다.

- [ ] **Step 1: 실패 테스트**
  - 세트 중 snapshot의 count와 tracker.kind가 맞다.
  - 60초 쉬는 시간 시작 25초 뒤 `remainingMs`가 35000(±1)이다. pause 10초 뒤에도 35000이다.
  - snapshot을 불러도 이벤트나 상태가 바뀌지 않는다(호출 전후 phase가 같고, 이후 이벤트 순서도 같다).
  - **2세트 끝난 뒤 `sessionSoFar` → sets 2, completed false, id는 생성자의 sessionId**. routineEnd의 session id와 같다(중간 저장을 덮어쓰기 위해).
  - routineEnd 뒤 snapshot.phase는 'done'이다.
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN**(전체, typecheck)
- [ ] **Step 5: 커밋** — `feat(core): RoutineRunner snapshot·sessionSoFar (화면 조회, 중간 저장)`

### Task 3: 앱 골격, CSP, 포트, CI

**Files:**
- Create `apps/app/{package.json,index.html,vite.config.ts,tsconfig.json,vitest.config.ts}`, `apps/app/src/{main.tsx,App.tsx,style.css}`, `apps/app/src/ports/*.ts`, `apps/app/test/csp.test.ts`, `apps/app/test/App.test.tsx`
- Modify `.github/workflows/ci.yml`

**Interfaces:**
- Produces (포트):
  ```ts
  // ports/pose.ts
  interface PoseSource { start(video: HTMLVideoElement): Promise<void>; stop(): void;
    onFrame(cb: (f: PoseFrame) => void): () => void; readonly delegate: 'GPU' | 'CPU' | null }
  class CameraError extends Error { kind: 'denied' | 'notFound' | 'other' }
  // ports/speech.ts
  interface Speech { speak(text: string): Promise<'ok' | 'unsupported'>; cancel(): void }
  // ports/keepAwake.ts
  interface KeepAwake { on(): Promise<void>; off(): Promise<void> }
  // ports/storage.ts
  interface Storage {
    listRoutines(): Promise<Routine[]>; saveRoutine(r: Routine): Promise<void>; deleteRoutine(id: string): Promise<void>;
    listSessions(): Promise<WorkoutSession[]>; getSession(id: string): Promise<WorkoutSession | null>;
    saveSession(s: WorkoutSession): Promise<void>;   // id 기준 덮어쓰기(upsert)
  }
  ```
- 라우팅은 `App.tsx`의 상태 하나(`screen`)로 한다. 라우터 라이브러리는 쓰지 않는다. [제안]
- CSP: 앱 index.html은 spec 5.7 원문에 `base-uri 'none'; form-action 'none'`을 더한 값으로 한다. 스타일은 외부 CSS만 쓴다(React 인라인 `style` 속성 금지, className만).
- dev 완화는 시험용 앱의 `relaxCspForDev`를 옮겨 온다. **replace가 실제로 적용되지 않으면 throw**한다(조용히 실패하지 않게).

- [ ] **Step 1: 실패 테스트**
  - `csp.test.ts`: 빌드 산출물 `dist/index.html`의 CSP meta가 기대 문자열과 정확히 같다(테스트 전에 `vite build`를 실행하는 스크립트를 둔다). dev 완화 함수에 CSP가 없는 html을 넣으면 throw한다.
  - `App.test.tsx`: 렌더하면 홈 제목 "Work Out Mate"가 보인다.
- [ ] **Step 2: RED 확인** — `npm test -w apps/app`
- [ ] **Step 3: 구현** — React 18, `@vitejs/plugin-react`, jsdom 환경으로 구성한다. `src/`에서 `style=` 속성을 쓰지 않는지 확인하는 테스트도 둔다(소스 grep).
- [ ] **Step 4: GREEN** — `npm test -w apps/app`, `npm run build -w apps/app`, 타입 검사
- [ ] **Step 5: CI** — core-and-web 작업에 `apps/app` 테스트·타입 검사·빌드를 추가한다.
- [ ] **Step 6: 커밋** — `feat(app): 루틴 앱 골격·CSP·플랫폼 포트`

### Task 4: 저장소 (IndexedDB + 메모리)

**Files:** Create `apps/app/src/storage/{idbStorage.ts,memoryStorage.ts}`, `apps/app/test/storage.test.ts`

**Interfaces:**
- Consumes: `Storage`(Task 3)
- Produces: `createIdbStorage(dbName = 'work-out-mate'): Storage`, `createMemoryStorage(): Storage`
- DB 스키마 v1: object store `routines`(keyPath `id`), `sessions`(keyPath `id`, index `endedAt`). `listRoutines`는 order 오름차순, `listSessions`는 endedAt 내림차순으로 돌려준다.

- [ ] **Step 1: 실패 테스트** — 같은 테스트 묶음을 두 구현에 모두 돌린다(`describe.each`). idb는 `fake-indexeddb/auto`를 쓴다.
  - saveRoutine → listRoutines 순서
  - deleteRoutine
  - saveSession 같은 id 두 번 → 1개, 나중 값
  - getSession 없는 id → null
  - 저장한 객체를 밖에서 바꿔도 저장된 값은 그대로(복사)
  - DB를 다시 열어도 데이터가 남는다(idb만)
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — `idb` 라이브러리를 쓴다.
- [ ] **Step 4: GREEN**
- [ ] **Step 5: 커밋** — `feat(app): IndexedDB·메모리 저장소`

### Task 5: 루틴 편집 화면과 입력 검증 (spec 6.2-2, 10 (k))

**Files:** Create `apps/app/src/domain/validate.ts`, `apps/app/src/screens/RoutineEdit.tsx`, Tests `apps/app/test/validate.test.ts`, `apps/app/test/RoutineEdit.test.tsx`

**Interfaces:**
- Produces: `validateRoutine(r: Routine): string[]`(한국어 오류 문구 목록, 비면 통과), `newRoutine(name: string, order: number, now: number, id: string): Routine`
- 검증 값(spec 6.2)
  - 이름: 1~20자(앞뒤 공백 제거 후)
  - 운동: 1개 이상
  - 세트: 1~10(정수)
  - 횟수: 1~100(정수)
  - 초: 5~600
  - 쉬는 시간: 0~600(정수)
  - 목표 종류: deadHang이면 `seconds`만, 나머지는 `reps`만
- 운동 이름 표시: 스쿼트, 푸시업, 덤벨 벤치프레스, 턱걸이, 네거티브, 매달리기

- [ ] **Step 1: 실패 테스트**
  - validate: 각 경계값 안쪽·바깥쪽(예: 세트 0과 11, 횟수 1과 101, 쉬는 시간 −1과 601, 이름 빈칸과 21자), deadHang에 reps 목표면 오류
  - RoutineEdit(메모리 저장소 주입)
    - 이름 입력 → 운동 추가 → 세트·목표·쉬는 시간 입력 → 저장하면 storage에 들어간다.
    - 잘못된 값이면 저장 버튼을 눌러도 저장되지 않고 오류 문구가 보인다.
    - 운동 순서 위아래 이동
    - 루틴 삭제는 확인 대화상자에서 "삭제"를 눌러야만 지워진다.
    - 매달리기를 고르면 목표 입력이 "초"로 바뀐다.
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN**
- [ ] **Step 5: 커밋** — `feat(app): 루틴 편집 화면과 입력 검증`

### Task 6: 홈·기록 화면 (spec 6.2-1, 6.2-6)

**Files:** Create `apps/app/src/screens/{Home.tsx,History.tsx,SessionDetail.tsx}`, Tests `apps/app/test/{Home,History}.test.tsx`

**Interfaces:**
- Consumes: `recommendNext`, `completedCount`(core), `Storage`
- Home에는 다음을 보여 준다.
  - 추천 루틴 이름과 "N번째"(N = completedCount + 1)
  - "시작" 버튼(→ 운동 화면, 루틴을 넘김)
  - 다른 루틴 목록(눌러서 시작하거나 편집)
  - "루틴 만들기"·"기록" 버튼
  - 루틴이 없으면 "루틴을 먼저 만들어 주세요" 안내와 만들기 버튼
- History는 endedAt 내림차순으로 날짜, 루틴 이름(세션에 저장된 `routineName`), "완료"/"미완료"를 보여 준다. 누르면 SessionDetail로 간다.
- SessionDetail은 세트 표를 보여 준다. 운동 이름, 세트(+1), 목표, 실제(횟수 또는 초), 실제 쉰 시간(초), 종료 사유(한국어: 목표 달성/멈춤/그만하기/손 놓음)가 들어간다.

- [ ] **Step 1: 실패 테스트**
  - 추천이 마지막 완료 루틴의 다음 순서로 나온다.
  - "하체데이 3번째"
  - 루틴 없음 안내
  - **지워진 루틴의 세션도 기록에 저장 당시 이름으로 보이고, 추천은 남은 루틴 중에서 나온다**(Review Focus 5).
  - 미완료 표시
  - 상세 표의 +1 표시와 종료 사유 한국어
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN**
- [ ] **Step 5: 커밋** — `feat(app): 홈·기록 화면`

### Task 7: 음성 문구 (spec 6.3, 10 (h))

**Files:** Create `apps/app/src/domain/{koNumbers.ts,phrases.ts}`, Test `apps/app/test/phrases.test.ts`

**Interfaces:**
- Consumes: `RoutineEvent`, `SetEvent`(core)
- Produces:
  - `koCount(n: number): string`: 1~10은 하나·둘·셋·넷·다섯·여섯·일곱·여덟·아홉·열, 11 이상은 숫자 문자열
  - `phraseFor(e: RoutineEvent, ctx: { routine: Routine }): string | null`
- 문구(spec 6.3 원문)

| 이벤트 | 문구 |
|---|---|
| countdown n | 셋/둘/하나 |
| start | 시작 |
| rep | koCount(count) |
| hold | 매 10초마다 "○초"(그 사이는 null) |
| goalReached(reps 목표) | 목표 달성, 세트 끝 |
| goalReached(seconds 목표) | 목표 달성 |
| finished idle | 세트를 마칠게요, ○회 |
| finished released | ○초 버텼어요 |
| finished manual / target | null |
| 반복 0인 finished | null |
| restStart | 쉬는 시간 ○초 |
| restTick 30 | 30초 남았어요 |
| restTick 5~1 | 다섯/넷/셋/둘/하나 |
| 그 밖의 restTick | null |
| nextUp | 다음은 {운동 이름} {setIndex+1}세트, {횟수}회 또는 {초}초 |
| hint notReady | 옆에서 찍어 주세요 |
| hint notVisible | 몸이 화면에 다 보이게 해 주세요 |
| hint calibratedByDefault | 준비 자세를 잡지 못해 기본값으로 셀게요 |
| backToReady | 준비가 되면 다시 자세를 잡아 주세요 |
| exerciseStart | {운동 이름}, {세트 수}세트 |
| routineEnd(completed) | 루틴 완료, 수고했어요 |
| routineEnd(미완료) | 운동을 마쳤어요 |
| restEnd | null |

- [ ] **Step 1: 실패 테스트** — 표의 모든 행, koCount 1·10·11·25, 매달리기 hold 10·20만 문구가 있고 15는 null
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN**
- [ ] **Step 5: 커밋** — `feat(app): 음성 안내 문구`

### Task 8: 운동 엔진과 플랫폼 구현 (spec 10 (e)(f)(g)(i), Review Focus 1~4)

**Files:**
- Create `apps/app/src/workout/{engine.ts,useWorkout.ts}`, `apps/app/src/platform/{mediapipePose.ts,webSpeech.ts,nativeSpeech.ts,keepAwake.ts}`
- Test `apps/app/test/engine.test.ts`
- 자산: `apps/app/public/mediapipe/`(시험용 앱의 copy-wasm과 모델 받기 절차를 옮기고, git 제외)

**Interfaces:**
- Consumes: `RoutineRunner`(snapshot, sessionSoFar), `PoseSource`, `Speech`, `KeepAwake`, `Storage`, `phraseFor`
- Produces:
  ```ts
  type EngineDeps = { routine: Routine; pose: PoseSource; speech: Speech; keepAwake: KeepAwake; storage: Storage;
    now: () => number; epochOffset: number; newId: () => string;
    setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void };
  type EngineView = RoutineSnapshot & { lastEvents: RoutineEvent[]; cameraError: CameraError['kind'] | null; ended: WorkoutSession | null };
  class WorkoutEngine {
    constructor(d: EngineDeps);
    start(video: HTMLVideoElement): Promise<void>;
    pause(): void; resume(): void; skipRest(): void; skipExercise(): void; stop(): Promise<void>;
    onVisibilityChange(hidden: boolean): void;   // hidden=true면 자동 pause
    subscribe(cb: (v: EngineView) => void): () => void;
    dispose(): void;
  }
  function useWorkout(d: EngineDeps): { view: EngineView; engine: WorkoutEngine };
  ```
- 동작
  - pose의 프레임마다 `runner.push(f)`를 부르고, 200ms마다 `runner.tick(now())`를 부른다[제안].
  - 나온 이벤트는 각각 `phraseFor`로 문구를 만들어 `speech.speak`에 넘긴다. 결과를 기다리지 않고, 실패하면 무시한다.
  - 세트 `finished` 이벤트 뒤(반복이 1 이상인 세트) `storage.saveSession(runner.sessionSoFar(now()))`
  - `routineEnd` 때 `storage.saveSession(session)`를 부르고 `ended`를 설정한다.
  - 시작할 때 keepAwake.on, 끝나거나 dispose할 때 off
  - visibility hidden이면 pause(10.1 결정). 자동으로 다시 시작하지 않는다.
  - 카메라 오류는 `cameraError`에 담는다(denied/notFound/other).
- 플랫폼 구현
  - mediapipePose: 시험용 앱의 `pose.ts`를 옮긴다. lite, GPU를 쓰고 실패하면 CPU로 넘어간다. 텔레메트리 fetch는 막는다. 이전 추론이 끝나지 않았으면 그 프레임은 건너뛴다. `getUserMedia` 오류 `NotAllowedError`는 denied, `NotFoundError`는 notFound로 바꾼다.
  - webSpeech: `speechSynthesis`, ko 음성
  - nativeSpeech: Capacitor TTS(ko-KR)
  - keepAwake: Capacitor KeepAwake. 웹에서는 Wake Lock API를 쓰고, 둘 다 실패해도 오류 없이 넘어간다.

- [ ] **Step 1: 실패 테스트**(engine.test.ts, 가짜 PoseSource·Speech·시계·interval·메모리 저장소)
  - 가짜 프레임으로 squat 1세트를 진행하면 speech에 "셋", "둘", "하나", "시작", "하나", "둘"…이 순서대로 간다.
  - **세트가 끝날 때마다 저장소에 같은 id의 세션이 덮어써지고, 엔진을 dispose(앱 꺼짐 흉내)한 뒤 저장소에 sets 1, completed false 세션이 남는다**(Review Focus 3).
  - routineEnd에 completed true 세션이 저장된다.
  - **세트 중 visibility hidden이면 view.paused가 true다. resume 뒤 4초 동안 idle 종료가 없다**(Review Focus 1).
  - **pose.start가 CameraError('denied')를 던지면 view.cameraError가 'denied'이고 예외가 밖으로 새지 않는다**(Review Focus 2).
  - **speech.speak가 'unsupported'를 돌려주거나 reject해도 세트가 끝까지 진행된다**(Review Focus 4).
  - 프레임이 없어도 interval tick만으로 쉬는 시간이 끝난다.
  - skipRest·skipExercise·stop이 RoutineRunner의 같은 메서드를 부른다(버튼 짝, 10 (g)).
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: GREEN**
- [ ] **Step 5: 커밋** — `feat(app): 운동 엔진·자세 인식·음성·화면 켜짐`

### Task 9: 운동 화면들 (spec 6.2-3·4·5)

**Files:** Create `apps/app/src/screens/{Placement.tsx,Workout.tsx,Rest.tsx,Summary.tsx}`, Test `apps/app/test/WorkoutScreens.test.tsx`

**Interfaces:**
- Consumes: `EngineView`, `WorkoutEngine`(Task 8)
- 화면 규칙
  - **Placement**: 운동이 바뀔 때마다(`exerciseStart`) 운동별 배치 안내를 보여 준다. 그림은 간단한 SVG 실루엣이고, 문구는 "옆에서, 온몸이 보이게"다. 철봉 운동은 "철봉과 손이 보이게"다. 세트가 countdown이나 active로 바뀌면 자동으로 닫힌다.
  - **Workout**
    - 카메라와 관절 오버레이(canvas)
    - "{운동} {세트+1}/{세트 수}세트"
    - 큰 숫자: 횟수, 또는 매달리기면 초
    - 상태 문구: 보정 중이면 "준비 자세를 잡아 주세요", 카운트다운이면 숫자, 진단이면 Task 7 문구
    - 버튼: 일시정지/다시 시작, 건너뛰기(skipExercise), 그만하기(확인 대화상자)
  - **Rest**: 큰 카운트다운(`rest.remainingMs`를 올림한 초, 매초 갱신), "다음: {운동} {세트}세트 {목표}", 건너뛰기(skipRest), 일시정지
  - **Summary**: routineEnd 세션의 세트 표(목표 대비 실제, 쉰 시간), 총 시간, 홈으로
  - **카메라 오류**
    - denied: "카메라 권한이 필요해요. 설정에서 허용한 뒤 다시 시도해 주세요" + 다시 시도
    - notFound: "카메라를 찾을 수 없어요"
    - 그 밖의 오류는 "카메라를 켜지 못했어요"

- [ ] **Step 1: 실패 테스트**(가짜 EngineView를 주입한 컴포넌트 테스트)
  - 세트 표기 +1
  - 매달리기는 초를 크게 보여 준다
  - 보정 중 문구
  - 일시정지 버튼 문구가 바뀐다
  - 그만하기는 확인을 거쳐야 stop을 부른다
  - Rest 남은 초 올림(35400ms → 36)
  - Rest 건너뛰기 → skipRest
  - Summary 표
  - 카메라 오류 3종 문구와 다시 시도
  - Placement가 active가 되면 닫힌다
- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — 스타일은 className과 `style.css`로만 한다(CSP).
- [ ] **Step 4: GREEN**, `npm run build -w apps/app`
- [ ] **Step 5: 브라우저 확인** — `npm run dev -w apps/app`로 띄워서 홈 → 루틴 만들기 → 운동 화면(카메라 권한 거부 화면 포함) 흐름이 보이는지 확인하고 스크린샷을 보고서에 남긴다.
- [ ] **Step 6: 커밋** — `feat(app): 운동·쉬는 시간·완료 화면과 카메라 배치 안내`

### Task 10: Android 앱 포장

**Files:** `apps/app/capacitor.config.ts`, `apps/app/android/`, `apps/app/package.json` 스크립트, `.github/workflows/ci.yml`(앱 APK 작업), `apps/app/README.md`

- 시험용 앱의 설정을 옮긴다.
  - appId: `com.workoutmate.app`
  - 이름: `Work Out Mate`
  - CAMERA 권한, TTS queries
  - **INTERNET 없음, allowBackup=false**
  - 플러그인: TTS, KeepAwake
  - 시험용 앱과 함께 설치되도록 appId를 다르게 둔다.
- 앱은 `Capacitor.isNativePlatform()`이면 nativeSpeech를 쓰고, 아니면 webSpeech를 쓴다.

- [ ] **Step 1: 실패 확인** — CI의 권한 검사 스크립트(aapt2 dump로 INTERNET 없음, CAMERA 있음, allowBackup=false)를 앱 APK에 먼저 걸고, 아직 APK가 없어서 실패하는 것을 확인한다.
- [ ] **Step 2: 구현과 빌드** — `npm run android:build -w apps/app`, `gradlew assembleDebug`(JAVA_HOME은 Android Studio jbr을 그 명령에서만 지정)
- [ ] **Step 3: GREEN** — 권한 검사를 통과한다. APK 안에 mediapipe 자산이 들어 있다.
- [ ] **Step 4: 커밋** — `feat(app): Android 앱 포장`

### Task 11: PC 앱 포장 (Electron)

**Files:** `apps/app/electron/{main.ts,preload.ts,tsconfig.json}`, `apps/app/scripts/{electron-build.mjs,electron-pack.mjs}`, `apps/app/package.json`, CI

- 시험용 앱의 Electron 설정을 옮기고 다음을 다듬는다.
  - `app://` 프로토콜, 경로 탈출 방지
  - media(video)만 허용
  - 외부 요청 차단
  - 새 창·이동 차단
  - origin은 **정확히 비교**한다(접두사 비교 금지).
  - 권한 체크 핸들러는 video만 허용한다.
  - `mkdirSync`를 예외 처리한다.
  - 숨은 환경 변수(`WOM_RECORD_DIR`)는 없앤다.
- 자가 점검(`WOM_SELFTEST=1`)
  - CSP 위반이 3건 미만이면 **종료 코드 1**로 자동 판정한다.
  - 랜드마커 생성
  - 외부 요청 0건

- [ ] **Step 1: 실패 확인** — 자가 점검이 아직 없으니 실패
- [ ] **Step 2: 구현** — `electron:build`, `electron:pack`
- [ ] **Step 3: GREEN** — 자가 점검이 종료 코드 0으로 끝난다. CI에 electron:build를 추가한다.
- [ ] **Step 4: 커밋** — `feat(app): PC 앱 포장 (Electron)`

### Task 12: 실기기 합격 (사용자)

**Files:** `docs/phase2-results.md`

- [ ] S23에 앱 APK를 설치하고 다음 루틴을 **손 안 대고** 끝까지 한다.
  - 루틴 "하체데이": 스쿼트 3세트×10회, 쉬는 시간 60초
- [ ] 합격 기준(spec 7)
  - 세트마다 ±1회
  - 실제 쉰 시간 ±2초
  - 손을 댄 횟수 0
  - 음성 안내가 순서대로 나옴
  - 기록에 completed로 남음
- [ ] 추가 확인
  - 세트 도중 홈 버튼 → 자동 일시정지 → 돌아와서 다시 시작
  - 비행기 모드에서 동작
  - S23에서 CSP 아래 자세 인식이 됨
- [ ] 결과를 `docs/phase2-results.md`에 기록하고 커밋한다.

---

## 다음
벤치·턱걸이 실측(#6, #9), 푸시업 녹화 추가, iOS(Capacitor), 자세 교정(비목표였던 것) 순으로 검토한다.
