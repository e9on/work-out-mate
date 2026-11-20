# Work Out Mate — Phase 2 설계: 손 안 대는 루틴 앱

- 작성일: 2026-11-20
- 상태: 승인됨(2026-11-20). 빌더 검토 질문 3개 반영
- 근거
  - Phase 1 설계 `docs/specs/2026-11-18-work-out-mate-mvp-design.md`
  - Phase 0 결과 `docs/phase0-results.md`
  - 판단 기록 `docs/phase0-decisions.md`
  - GitHub 이슈 #1~#10
  - 2026-11-20 대화
- 표기: **[확정]** 사용자가 정한 것 / **[제안]** 설계자가 정한 것(바꿀 수 있음) / **[확인 필요]** 아직 검증하지 않은 것

---

## 0. 왜 만드는가

Phase 0에서 갤럭시 S23 앱이 30fps로 동작하고, 횟수·시간을 실시간으로 세는 카운터가 실측을 통과했다. Phase 2는 이것을 **실제로 운동할 때 쓰는 루틴 앱**으로 만든다.

처음 기획의 문제는 "방금 몇 회 했는지, 쉬는 시간을 지키는지 헷갈린다"였다. 그래서 핵심은 두 가지다.
- 폰을 바닥에 세워 두고 **한 번도 손대지 않고** 루틴을 끝까지 할 수 있어야 한다.
- 끝나면 기록이 남아야 한다.

## 1. 범위

### 목표 [확정]
1. 이름 붙인 루틴(예: 푸시데이·풀데이·하체데이)을 만들고, 고치고, 지울 수 있다. 루틴마다 운동, 세트 수, 목표(횟수 또는 초), 쉬는 시간을 정한다.
2. 홈 화면이 오늘의 루틴을 추천한다. 추천은 마지막으로 끝까지 마친 루틴의 다음 차례이고, 사용자는 다른 루틴을 골라도 된다. 루틴별로 몇 번째인지 함께 보여 준다.
3. **손 안 대는 세트 진행** (2절)
4. 쉬는 시간을 카운트다운하고, 마지막 20초에 다음 운동을 안내한다.
5. 기록을 저장하고, 기록 목록과 세션 상세를 볼 수 있다.
6. Android(Capacitor)와 PC(Electron)에서 같은 코드로 동작한다.

### 선행 작업 (Phase 0 최종 검토에서 넘어온 것) [확정: A안]
- **#4** RepCounter와 AdaptiveRepCounter를 공통 구조로 합치고, TrackerState를 판별 유니온으로 바꾼다.
- **#2** 보정 실패 대응: 타임아웃이면 관측한 최고점을 쓴다. "왜 안 세는지" 진단 상태를 둔다.
- **#3** 몸통 기울기를 world 좌표로 계산한다.
- **#1** 그만하기 버튼을 누르기 직전에 센 반복은 되돌린다.
- **#5** CSP `connect-src`로 모든 환경에서 네트워크를 차단한다.

### 비목표 (이번에 안 함)
- 자세 오류 판정과 교정 안내, 운동 품질 점수. 단, 네거티브의 내려온 시간처럼 이미 계산되는 값은 기록한다.
- 운동 영상 녹화·저장·다시 보기
- 자체 ML 모델
- 머리 위 박수 제스처. 손 안 대는 흐름이 그 의도를 대신한다.
- iOS
- 기기 간 동기화, 계정, 서버, 클라우드 백업
- 앱스토어 배포와 서명. 디버그 빌드와 개인 설치까지만 한다.

### 안티 목표 (이렇게 되면 실패)
- 세트를 시작하거나 끝내려고 폰까지 걸어가야 한다.
- 가만히 있는데 횟수가 오르거나, 한 세트에 ±1회보다 크게 틀린다.
- 영상·관절 좌표·기록이 기기 밖으로 나간다(네트워크, 클라우드 백업 모두 포함).
- 안 세지는데 이유를 알 수 없다.

## 2. 손 안 대는 세트 진행 [확정]

```
[카메라 배치 안내]  운동별 그림 + "옆에서, 온몸이 보이게"
      ↓ 몸이 화면에 들어옴
[준비 자세 대기]  "준비 자세를 잡아 주세요"  (보정 0.7초 / 철봉 운동은 아래 예외)
      ↓ 보정 완료
[카운트다운]  음성 "3, 2, 1, 시작"
      ↓
[운동 중]  큰 숫자로 횟수 표시, 매 회 음성 "하나, 둘…"
      ↓ 목표 도달 → 즉시 종료
      ↓ 또는 마지막 반복 후 5초 동안 반복 없음 → "세트를 마칠게요"
[쉬는 시간]  카운트다운, 10초 단위와 마지막 5초 음성, 남은 20초에 "다음은 …"
      ↓ 쉬는 시간 끝
[다음 세트 준비 자세 대기] → 반복 … 마지막 세트 뒤 [루틴 완료 요약]
```

- **철봉 운동은 카운트다운 없이 자세대로 바로 시작한다.** [확정, 2026-11-20] 철봉에 매달린 채 3초를 기다리면 힘이 빠지기 때문이다.
  - 매달리기·턱걸이: 매달린 자세(양팔 펴짐 + 손목이 코보다 위, 기존 deadHang `holding` 판정)가 300ms 이어지면 시작한다. 이때 "시작" 음성만 낸다.
  - 네거티브: 판정 관절이 보이면 바로 셀 준비가 된다. 위로 올라갔다 내려와야 1회이고 재무장도 있어서, 그 전에 잘못 세지 않는다.
- **매달리기**: 매달린 상태가 감지되면 바로 초를 센다. 손을 놓으면 끝난다. 목표 초에 닿으면 "목표 달성"이라고 말하고, 계속 버티면 계속 센다. [확정]
- **네거티브**: 바닥에 닿을 때마다 1회로 세고, 내려온 시간을 기록한다. [확정]
- **목표 미달**: 목표 10회에서 8회 뒤 5초 동안 반복이 없으면 세트를 끝내고 8회로 기록한다. 다음 세트는 원래 목표로 진행한다. [확정]
- **예외용 버튼**: 화면에 "일시정지", "건너뛰기"(지금 운동을 통째로 넘김), "그만하기"를 둔다. 기본은 손을 대지 않는 것이다. [확정]
  - **그만하기는 루틴 전체를 끝내고, 그때까지 한 세트를 `completed: false`(미완료) 세션으로 저장한다.** [확정, 2026-11-20] 세트만 일찍 끝내는 버튼은 따로 없다(멈추면 자동 종료).
  - 그만하기를 누르기 **직전 1.5초 안에 확정된 반복은 되돌린다**(#1). [제안]
  - 기록 목록에서 미완료 세션은 "미완료"로 표시한다. 오늘의 루틴 추천은 완료 세션만 본다.
- **세부 동작** [제안]
  - 카운트다운 중에 준비 자세가 깨져도 세트는 시작한다(3초 안에 움직이기 시작하는 건 자연스럽다).
  - "5초 동안 반복 없음"은 운동 중 상태에서만 잰다. 첫 반복 전에는 재지 않는다(시작했는데 아직 안 움직이는 경우). 대신 시작 뒤 **20초 동안 반복이 하나도 없으면** "준비가 되면 다시 자세를 잡아 주세요"라고 말하고 준비 자세 대기로 돌아간다.
  - 쉬는 시간이 끝나기 전에 준비 자세를 잡아도 쉬는 시간을 다 채운 뒤 시작한다. 쉬는 시간을 지키게 하려는 것이 기획 의도다.
  - 실제 쉰 시간은 세트가 끝난 시각부터 다음 세트 시작(카운트다운이 끝난 시각)까지로 기록한다.
  - 운동 사이의 쉬는 시간은 다음 운동에 설정된 쉬는 시간을 쓴다.

## 3. 제약
- 서버·클라우드 없음, 실행 중 네트워크 요청 0건. Android는 INTERNET 권한 없음과 allowBackup=false, PC는 Electron 외부 요청 차단, 공통으로 CSP를 둔다.
- 기준 기기는 갤럭시 S23과 Windows PC다. 저사양 Android는 보장하지 않는다.
- 카메라 배치는 **옆에서 찍기**가 전제다. 정면 촬영은 지원하지 않는다(준비 자세 확인이 몸통 방향을 본다).
- 실시간 처리: 프레임이 올 때마다 바로 판단한다.
- **실패하는 테스트를 먼저 쓴다.** RED를 확인한 뒤 고친다. [확정, 사용자 방식]
- 사용자에게 보이는 글과 음성은 모두 한국어다.

## 4. 만드는 방식

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **A. 코어 정리 → 새 앱 [확정]** | 선행 작업과 세트 진행기를 코어에 먼저 만들고, `apps/app`을 React로 새로 만든다 | 앱이 쓸 데이터 모양이 먼저 정해진다. 세트 진행을 녹화로 테스트할 수 있다 | 화면이 늦게 나온다 |
| B. 시험용 앱 키우기 | `apps/spike`를 진짜 앱으로 확장 | 카메라·음성·저장·포장이 이미 있어 빠르다 | 버리는 코드로 짠 부분이 많아 화면이 늘수록 손보기 어렵다 |
| C. 화면 먼저 | 앱부터 만들고 코어는 나중에 | 화면을 빨리 본다 | #4에서 데이터 모양이 바뀌어 화면을 다시 고쳐야 한다 |

작업은 **두 계획**으로 나눈다.
- **2a**: 코어 정리와 세트·루틴 진행기
- **2b**: 앱 화면, 저장, 포장

## 5. 2a: 코어 설계 (`packages/core`, 순수 TS)

### 5.1 카운터 통합 (#4)
- 공통 껍데기 하나에 판정 전략을 끼우는 구조로 바꾼다.
  - 공통 껍데기가 맡는 것: 가림 처리(일시정지·오래 가림 버리기), 재무장, 최소 시간, RepEvent 생성, 부호 반전(restSide), countAt
  - 판정 전략: `fixed`(enter/turn/exit)와 `adaptive`(준비 자세 보정 + 상대 판정)
- 운동 정의는 `mode: 'fixed' | 'adaptive'` 판별자로 나눈다.
- `TrackerState`는 판별 유니온으로 바꾼다. [제안]
  ```ts
  type Diagnosis = 'ok' | 'notVisible' | 'notReady' | 'calibratedByDefault';
  type RepTrackerState = { kind: 'reps'; count: number; lastRep: RepEvent | null;
    phase: 'calibrating' | 'rest' | 'out' | 'turned' | 'paused'; baseline: number | null;
    diagnosis: Diagnosis };
  type HoldTrackerState = { kind: 'hold'; heldMs: number; state: 'idle' | 'holding' | 'ended';
    diagnosis: Diagnosis };
  type TrackerState = RepTrackerState | HoldTrackerState;
  ```
- 통합 중 경계 비교와 재무장 시점을 Fixed 방식으로 맞췄다(dec9dfe). 시작·복귀·미달 복귀·재무장은 경계값을 넘어야 하고(바닥은 같아도 도달), rest로 돌아온 프레임이 이미 재무장선 너머면 그 프레임에서 무장한다. 실녹화로 돌린 결과는 이전과 차이 0이다(합격 테스트 회귀 기준값 그대로).
- 기존 테스트 134개(합격 테스트 포함)의 **동작이 그대로** 유지되어야 한다. 테스트 코드의 API 호출은 바꿔도 되지만, 기대값은 바꾸지 않는다. 회귀 기준값(expectedReplayCount)이 정확히 같아야 한다.

### 5.2 보정 실패 대응과 진단 (#2)
- 보정이 타임아웃되면 고정 기본값 대신 **보정 구간에서 관측한 rest 쪽 최고점**(high면 최댓값)을 기준으로 쓴다. 단, 그 값이 minBaseline(정상 보정과 같은 하한)보다 낮으면 기본값을 쓴다. 관측값이 하나도 없을 때도 기본값이다. 노이즈 한 프레임이 기준이 될 수 있다는 한계는 있다.
- 기준 출처는 `calibrationSource`: `'measured'`(정상 보정) / `'observed'`(타임아웃, 관측 최고점) / `'default'`(타임아웃, 기본값). observed와 default는 둘 다 진단에서 `calibratedByDefault`로 나온다.
- 진단 우선순위: `notVisible` > `notReady` > `calibratedByDefault` > `ok`. 매달리기는 판정 관절이 안 보이면 notVisible, 아니면 ok다.
- `diagnosis` 값의 뜻
  - `notVisible`: 판정 관절이 안 보임
  - `notReady`: 보정 중인데 ready가 계속 false임
  - `calibratedByDefault`: 타임아웃으로 기준을 정함
- 앱은 이 값을 보고 안내 문구를 고른다. 예: notReady면 "옆에서 찍어 주세요, 몸통이 보이게"

### 5.3 몸통 기울기 world 좌표 (#3)
- `torsoTilt*`를 `world` 좌표(미터 단위)의 x·y로 계산한다. 화면 비율의 영향을 없애기 위해서다.
- 양쪽 어깨·엉덩이가 모두 보이면 각각의 중점을 쓴다. 아니면 **같은 쪽** 어깨·엉덩이가 둘 다 보이는 쪽(두 점 visibility의 작은 값이 더 큰 쪽)을 쓴다. world에서 반대편끼리 짝지으면 z 차이가 섞여 기울기가 왜곡되기 때문이다. 같은 쪽 짝이 없으면 null(보이지 않음). 가시성 판단은 image visibility, 좌표는 world를 쓴다.
- 기존 실녹화 보정 결과(보정 시각과 기준값)가 크게 달라지지 않는지 확인하고, 바뀌면 그 값을 기록한다.

### 5.4 세트 진행기 `SetRunner` (새로 만듦)
- 위치: `src/session/setRunner.ts`
- 입력: `push(frame: PoseFrame)`, `tick(t: number)`(프레임이 없을 때의 시간 진행), `stop(t)`, `pause(t)`, `resume(t)`
- 출력: 호출마다 그 사이 일어난 이벤트 배열(일어난 순서). 조회: `phase`, `tracker`(TrackerState), `paused`, `result`(끝난 세트 결과의 **복사본**, 끝나기 전이거나 시작 전 stop이면 null)
- 시간: `f.t`와 `tick(t)`는 같은 시계다. 지금까지 본 시각보다 이른 push·tick은 무시한다.
- 상태: `waitingReady | countdown | active | finished`
- 시작 방식은 운동 정의의 `start` 설정으로 정한다.
  - `start: 'calibrate'`: 스쿼트·푸시업·벤치. 보정이 끝나면 카운트다운 3초를 거쳐 active로 간다.
  - `start: 'pose'`: 매달리기·턱걸이. 매달린 자세가 300ms 이어지면 카운트다운 없이 바로 active로 간다.
  - `start: 'visible'`: 네거티브. 판정 관절이 보이면 바로 active로 간다. 이 방식은 `backToReady`가 없다(보이면 바로 다시 시작해 "다시 자세를" → "시작"이 반복되기 때문이다).
  - 셋 다 같은 상태 기계를 쓰고, 카운트다운 길이만 0이 된다.
- 이벤트(앱이 음성과 화면으로 바꿈)
  - `{type:'countdown', n:3|2|1}`, `{type:'start'}`
  - `{type:'backToReady'}`: start 뒤 첫 반복 없이 noStartMs(기본 20초)가 지나 준비 자세 대기로 돌아갔다(세트가 끝난 것이 아니다. 트래커를 새로 만든다)
  - `{type:'rep', count}`, `{type:'hold', seconds}`(매달리기는 1초마다)
  - `{type:'goalReached'}`
  - `{type:'finished', reason:'target'|'idle'|'manual'|'released', result}`. EndReason에 `noStart`는 없다.
  - `{type:'hint', diagnosis}`: ok가 아닌 진단. 같은 진단은 hintRepeatMs(기본 10초) 간격으로 다시 내고, `calibratedByDefault`는 **세트당 한 번**만 낸다.
- **음성 문구는 코어가 정하지 않는다.** 이벤트만 내보내고, 문구와 말하기는 앱이 맡는다(언어와 플랫폼을 분리하기 위해서다).
- 2절의 규칙(5초 반복 없음, 20초 시작 없음, 그만하기 직전 1.5초 되돌림, 목표 도달, 매달리기 목표 달성 후 계속)을 구현한다. 시간 값은 설정으로 둔다.
- 구현된 세부 규칙
  - 카운트다운: `countdownMs` 안에 들어가는 숫자만 낸다(`n*1000 <= countdownMs`인 n. 1500이면 1만, 0이면 없음). 3000이면 3·2·1이 0·1000·2000ms에, start는 3000ms에 나온다. 카운트다운 중에도 트래커는 돌리고, start 시점 이전에 확정된 반복은 세지 않는다.
  - `stop(t)`: 먼저 시간을 흘려(advance) idle이 지났으면 idle로, 카운트다운이 끝났으면 start부터 처리한 뒤 끝낸다. 되돌림 기준 시각은 일시정지 중이면 `pausedAt`(그 순간에 시간이 멈춰 있다), 아니면 지금 시각이다. 세트가 시작되기 전(waitingReady·countdown)에 stop하면 기록 없이 finished 상태만 되고 이벤트는 `[]`다.
  - `resume`: waitingReady였다면 트래커를 새로 만든다(일시정지 시간 때문에 보정이 타임아웃되거나 HoldTimer가 일시정지 전부터 매달린 것으로 보는 일을 막는다). active였다면 트래커를 그대로 둔다. 카운트다운·idle 기준 시각과 마지막 프레임 시각은 일시정지한 만큼 뒤로 민다.
  - 매달리기에서 프레임이 끊기면 `tick(t)`가 HoldTimer와 같은 규칙으로 판정한다: 마지막 프레임 뒤 `hold.graceMs`가 지나면 `released`로 끝낸다. 이때 heldMs는 HoldTimer가 멈춰 둔 값이다.
  - 매달리기 `heldMs`는 일시정지 시간을 뺀다. HoldTimer는 일시정지를 모르므로, resume 뒤 holding 프레임이 와서 값이 일시정지 구간을 건너 늘었을 때만(증가가 확인됐을 때만) 그 일시정지 시간을 뺀다.
- `result`는 세트 기록이다: 목표 종류·값, 실제 횟수, 버틴 ms, 반복별 내려온 ms, 세트 시작·끝 시각(프레임 시계), 종료 사유.
- 이미 있는 실녹화 파일로 SetRunner를 돌려 세트 결과를 검증하는 테스트를 둔다. 녹화는 카운트다운이 없던 시절 것이라, "보정 → 카운트다운 3초 → 운동"을 적용하면 앞부분 반복을 놓칠 수 있다. 그래서 **테스트에서는 카운트다운 0초 설정**으로 돌린다. [제안]

### 5.5 루틴 진행기 `RoutineRunner` (새로 만듦)
- 위치: `src/session/routineRunner.ts`
- 루틴 정의(운동 목록, 세트 수, 목표, 쉬는 시간)를 받아 `운동 → 세트(SetRunner) → 쉬는 시간 → …` 순서로 진행한다.
- 이벤트(`RoutineEvent`). 인덱스는 모두 **0부터**다.
  - `{type:'exerciseStart', exerciseIndex, exercise}`: 첫 이벤트는 생성자에서 낼 수 없어 첫 호출(push·tick·skipExercise·stop)의 배열 맨 앞에 담긴다.
  - `{type:'set', exerciseIndex, setIndex, event}`: SetRunner 이벤트를 운동·세트 번호와 함께 감싼 것
  - `{type:'restStart', seconds, next:{exerciseIndex, setIndex, exercise, target}}`: next는 쉬는 시간 뒤 할 세트(다음이 없으면 쉬는 시간이 없으므로 항상 있다)
  - `{type:'restTick', remaining}`: 10의 배수 초와 마지막 5초. **올림한 정수 초** 기준이고, 시작 값은 내지 않으며, 건너뛴 값은 몰아서 내지 않는다(큰 tick 점프 때 지나간 값은 버린다).
  - `{type:'nextUp', exerciseIndex, exercise, setIndex, target}`: 남은 20초 이하가 되면 한 번. 쉬는 시간이 20초 이하면 restStart 바로 뒤에. 큰 tick 점프로 20초 구간을 건너뛰어도 안내를 놓치지 않게 **restEnd 바로 앞에서** 낸다.
  - `{type:'restEnd'}`
  - `{type:'routineEnd', session}`
- 쉬는 시간 중에는 SetRunner가 세지 않는다. 쉬는 시간이 끝나면 다음 SetRunner가 `waitingReady`로 시작한다. restEnd가 나온 호출의 프레임은 새 세트에 넣지 않는다(준비 자세 판정은 다음 push부터). 운동이 바뀌면 restEnd 뒤에 exerciseStart.
- 조회: `phase`('set'|'rest'|'done'), `current`({exerciseIndex, setIndex}, 쉬는 시간 중에는 방금 끝난 세트), `paused`(세트 중이면 SetRunner.paused, 쉬는 시간이면 쉬는 시간 일시정지 여부, 끝난 뒤 false)
- 입력: `push`, `tick`, `pause`, `resume`, `skipExercise`, `skipRest`, `stop`(화면 버튼용)
  - **`skipRest(t)`**: 쉬는 시간을 바로 끝내고 다음 세트로 간다(쉬는 시간이 끝났을 때와 같은 경로라 restEnd, 운동이 바뀌면 exerciseStart). completed에 영향이 없다. 쉬는 시간이 아니면 `[]`.
  - **`skipExercise(t)`**: 지금 운동의 남은 세트를 건너뛰고 다음 운동의 첫 세트로 간다(쉬는 시간 없음). 세트 중이면 반복이 있을 때만 기록한다. 쉬는 시간 중이면 "방금 끝난 운동의 남은 세트"를 건너뛴다(다음 운동을 건너뛰지 않는다). **실제로 건너뛴 세트가 있을 때만** completed가 false가 된다. 운동 사이 쉬는 시간이면 건너뛴 세트가 없어 skipRest와 같다.
  - **일시정지 중에 skipRest·skipExercise를 부르면 일시정지를 풀고 진행한다**(새 세트는 멈추지 않은 상태로 시작).
- 세트 수 `sets`는 정수가 아니면 내림(floor), 음수·NaN은 0이다. 세트가 0인 운동은 건너뛴다. 세트가 1개 이상인 운동이 없는 루틴은 생성자에서 Error.
- 반복 0인 세트(count 0이고 heldMs 0): 건너뛰기·그만하기로 끝내면 `set(finished)` 이벤트는 나오지만 **세션에 기록하지 않는다**.
- 끝나면 `routineEnd.session`으로 세션 기록 전체를 돌려준다. 그만하기로 끝나면 그때까지의 세트를 담아 `completed: false`로 돌려준다. 진행 중이던 세트는 그만하기 직전 1.5초 되돌림을 적용해 기록한다. 반복이 하나도 없던 세트(준비 자세 대기 중)는 기록하지 않는다. [제안]
- 시간은 모두 입력 t로만 잰다(테스트에서 시간을 조작할 수 있게).

### 5.6 데이터 모델 (코어 타입, 저장은 앱이 함) [제안]
```ts
type Target = { kind: 'reps'; reps: number } | { kind: 'seconds'; seconds: number };
type RoutineExercise = { exercise: ExerciseId; sets: number; target: Target; restSec: number };
type Routine = { id: string; name: string; order: number; exercises: RoutineExercise[]; createdAt: number; updatedAt: number };
type EndReason = 'target'|'idle'|'manual'|'released';
type SetResult = { exercise: ExerciseId; target: Target; count: number; heldMs: number;
  negativeDescentMs: number[]; startT: number; endT: number; endReason: EndReason };
type SetLog = SetResult & { exerciseIndex: number; setIndex: number; restTakenMs: number | null };
type WorkoutSession = { id: string; routineId: string; routineName: string; startedAt: number; endedAt: number;
  completed: boolean; sets: SetLog[] };
```
- `SetLog.exerciseIndex`는 루틴 안 운동 위치(같은 운동이 두 번 나와도 구분), `setIndex`는 그 운동 안 세트 번호(0부터)다.
- 시각: `SetResult`(= SetRunner의 result, `set(finished).result`)의 `startT/endT`는 **프레임 시계**다. 세션에 담기는 `SetLog.startT/endT`와 `startedAt/endedAt`은 RoutineRunner의 `toEpoch`로 바꾼 **절대 시각**이다(`toEpoch` 기본은 항등). `restTakenMs`는 이전 기록 세트의 endT부터 이 세트 startT까지의 **차이값**이라 시계와 상관없다(첫 기록 세트는 null).
- 저장은 `set(finished).result`가 아니라 `routineEnd.session`으로 한다.
- `completed`는 모든 운동의 모든 세트가 끝나고 그만하기(manual)로 끝난 세트가 없으며 실제로 건너뛴 세트가 없을 때 true다. 오늘의 루틴 추천은 completed 세션만 본다.
- 오늘의 루틴 추천 함수 `recommendNext(routines, sessions)`도 코어에 둔다(순수 함수, 테스트 가능).

### 5.6b 덤벨 벤치프레스 신호 [확정, 2026-11-20: 일단 구현하고 실측은 나중에]
- 벤치프레스 신호를 풀업·네거티브처럼 **보이는 팔만으로 판단**(`meanVisibleArms`: 둘 다 보이면 평균, 하나만 보이면 그쪽)하도록 바꾼다. 측면 촬영에서 반대쪽 팔이 가려져 0회가 되는 위험을 줄이기 위해서다. 동작 정의(양팔 동시)는 그대로다.
- 벤치프레스와 턱걸이는 다른 운동과 똑같이 고를 수 있다. 따로 표시하지 않는다. 실측은 이슈 #6, #9로 나중에 한다.
- 기존 테스트 "한쪽 팔이 가려지면 0"은 이 결정에 맞게 기대값을 바꾼다(실패 테스트 먼저).

### 5.7 CSP (#5)
앱 `index.html`에 CSP를 넣는다.
- `default-src 'self'; connect-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob: mediastream:`
- MediaPipe wasm·모델 로딩과 Capacitor·Electron 환경에서 실제로 동작하는지 확인한다. [확인함, 2026-11-20 시험용 앱]
  - Electron 자가 점검: 위 CSP 그대로 랜드마커 4종(lite/full × GPU/CPU) 생성 성공, wasm·모델 로딩 오류 없음. fetch·XHR·sendBeacon의 외부 요청은 CSP 위반 이벤트 3건으로 renderer에서 막힘(CSP가 없을 때는 0건이고 main의 webRequest가 대신 막음). 값을 넓힌 지시어는 없다.
  - 주의: `default-src 'self'`가 `<style>` 인라인도 막는다. 앱 CSS는 인라인 `<style>`이 아니라 외부 css 파일로 둔다(빌드에서는 Vite가 그렇게 만든다). 개발 서버만 Vite가 CSS를 `<style>`로 주입하고 HMR 웹소켓을 쓰므로 `style-src 'unsafe-inline'`과 `connect-src ws: wss:`를 개발 모드에만 더한다.
  - Android(Capacitor) APK 빌드는 성공. 실기기(S23) 동작은 사용자 확인 대기.

## 6. 2b: 앱 설계 (`apps/app`)

### 6.1 기술 [제안]
- Vite + React + TypeScript. 상태는 React 기본 기능(useReducer/context)으로 충분하면 그렇게 하고, 라이브러리는 꼭 필요할 때만 쓴다.
- 저장은 IndexedDB를 쓴다. 래퍼는 `idb` 같은 작은 라이브러리 하나로 둔다. Storage 포트 뒤에 숨겨서 나중에 SQLite로 바꿀 수 있게 한다.
- 포트(플랫폼별 구현)
  - `PoseSource`: MediaPipe 웹, 텔레메트리 차단 포함
  - `Speech`: Android는 Capacitor TTS, PC와 브라우저는 speechSynthesis
  - `KeepAwake`
  - `Storage`
- 포장은 시험용 앱에서 검증한 설정을 옮긴다.
  - Android: Capacitor 8, INTERNET 없음, allowBackup=false, CAMERA 권한
  - PC: Electron 45, `app://` 프로토콜, 카메라 권한 제한, 외부 요청 차단, 새 창·이동 차단
  - 시험용 앱의 Electron main과 preload를 그대로 복사하지 말고, 공용으로 정리할 부분은 정리한다. 빌더 판단.
- 모델은 lite, GPU를 쓰고 실패하면 CPU로 넘어간다.

### 6.2 화면 [제안 — 모양은 빌더 판단, 아래는 필요한 정보]
1. **홈**: 오늘의 추천 루틴(이름, "하체데이 5번째"), 시작 버튼, 다른 루틴 목록, 기록 보기
2. **루틴 목록·편집**
   - 루틴 추가, 이름 변경, 순서 변경, 삭제(확인 대화상자)
   - 운동 추가·삭제·순서 변경
   - 운동마다 세트 수, 목표(운동이 매달리기면 초, 아니면 횟수), 쉬는 시간(초)
   - 입력 범위 검증: 세트 1~10, 횟수 1~100, 초 5~600, 쉬는 시간 0~600 [제안]
3. **운동 중**
   - 카메라 화면과 관절 오버레이
   - 운동 이름과 세트(예: "스쿼트 2/3세트")
   - 큰 숫자: 횟수 또는 초
   - 상태 문구: 준비 자세, 카운트다운, 진단 안내
   - 일시정지와 그만하기 버튼
   - 처음 운동이 바뀔 때마다 **카메라 배치 안내**를 운동별 그림과 문구로 보여 준다. 자세가 잡히면 자동으로 넘어간다.
4. **쉬는 시간**: 큰 카운트다운, 다음 운동과 세트 표시, 건너뛰기 버튼(쉬는 시간 끝내기)
5. **완료 요약**: 세트별 결과(목표 대비 실제, 실제 쉰 시간), 총 시간
6. **기록**: 날짜순 세션 목록(루틴 이름, 완료 여부), 세션 상세(SetLog 표)

### 6.3 음성 문구 [제안]
- 카운트다운: "셋, 둘, 하나, 시작"
- 횟수: "하나"… "열" 순우리말, 11 이상은 숫자
- 목표 도달: "목표 달성, 세트 끝"
- 반복 없음 종료: "세트를 마칠게요, ○회"
- 쉬는 시간: "쉬는 시간 ○초", "30초 남았어요", 마지막 "다섯, 넷, 셋, 둘, 하나"
- 다음 안내: "다음은 스쿼트 2세트, 12회"
- 진단: notReady면 "옆에서 찍어 주세요", notVisible이면 "몸이 화면에 다 보이게 해 주세요"(같은 안내는 10초에 한 번만)
- 음성이 안 되는 기기에서는 화면 표시만 한다.

## 7. 테스트
- **코어**: 실패 테스트를 먼저 쓴다. 기존 134개 유지, 합격 테스트의 회귀 기준값 유지. SetRunner와 RoutineRunner는 합성 프레임과 시간 조작으로 2절 규칙을 하나씩 검증한다. 실녹화로 세트 결과도 검증한다.
- **앱**: 화면 로직(루틴 편집 검증, 추천, 기록 저장·조회)은 Vitest와 Testing Library로 테스트한다. 저장 포트는 메모리 구현으로 테스트한다.
- **CI**: 기존 CI에 `apps/app` 타입 검사·테스트·빌드, 앱 Android APK 빌드와 권한 확인을 추가한다.
- **실기기(사용자)**: S23 앱으로 루틴 하나(예: 하체데이: 스쿼트 3세트×10회, 쉬는 시간 60초)를 손 안 대고 끝까지 해 본다. 합격 기준은 세트마다 ±1회, 실제 쉰 시간 ±2초, 손을 댄 횟수 0이다. [제안]

## 8. 위험
| 위험 | 대응 |
|---|---|
| 카운트다운 3초 동안 이미 움직이기 시작해 첫 반복을 놓침 | 카운트다운 중에도 트래커는 돌리고, "시작" 시점 이전에 확정된 반복은 세지 않는다. 실측해서 조정한다 |
| 쉬는 시간 중 몸을 움직이다 다음 세트가 엉뚱하게 시작됨 | 쉬는 시간이 끝난 뒤에만 준비 자세를 받는다. 보정 조건(0.7초 정지와 몸통 방향)이 대부분 거른다 |
| 5초 반복 없음 기준이 느린 운동(네거티브)에 짧음 | 운동별로 idle 시간을 설정할 수 있게 한다. 네거티브는 [제안] 8초 |
| IndexedDB 데이터가 앱 재설치나 WebView 데이터 삭제로 사라짐 | MVP에서는 허용한다. 나중에 내보내기 기능이나 SQLite를 검토한다 |
| CSP가 MediaPipe wasm이나 워커를 막음 | 2a에서 시험용 앱으로 먼저 확인한다 |
| 벤치프레스·풀업 미실측 (#6, #9) | 일단 구현하고 실측은 나중에 한다(사용자 결정). 벤치는 보이는 팔만으로 판단해 0회 위험을 줄인다 |

## 9. 빌더에게 맡기는 것
- 화면 디자인(색, 레이아웃, 컴포넌트 구조), 운동별 배치 안내 그림의 형태(간단한 SVG 실루엣도 충분)
- 상태 관리 세부, 폴더 구조
- Electron·Capacitor 설정 중 시험용 앱과 공유할 부분

## 10. 2b로 넘기는 결정과 선행 작업

2a 최종 검토에서 나온, 2b 앱이 정하거나 먼저 해야 하는 일이다. 2b 계획은 이 절을 바탕으로 쓴다.

- **(a) hint는 연속 지속 시간 기준으로 낸다.** 예: 1500~2000ms 연속일 때. waitingReady에 들어간 직후의 notReady는 유예한다. 이유: 쉬는 시간이 끝나는 순간 아직 서 있는 사람에게 "옆에서 찍어 주세요"가 반복되고, 한 프레임짜리 visibility 깜빡임이 운동 중 음성을 끊는다.
- **(b) resume 복귀 유예.** `idleFrom`을 `max(idleFrom + d, resumeT)`로 두거나 유예를 준다. 폰까지 걸어와 일시정지하고 resume하면 1초 뒤 idle로 끝나는 문제가 있다.
- **(c) backToReady 반복 규칙.** squat는 서 있기만 해도 약 24초마다 "다시 자세" → "셋, 둘, 하나, 시작"이 반복된다. pullup도 같다. 준비 자세가 한 번 깨졌다가 다시 잡혀야 시작하게 할지 정한다.
- **(d) RoutineRunner 조회 getter를 추가한다.** 현재 SetRunner phase, tracker(diagnosis·baseline), 현재 횟수, 버틴 ms, 쉬는 시간 남은 ms.
- **(e) 시계는 하나다.** push의 `f.t`와 tick은 같은 단조 시계다. `toEpoch`는 시작 때 한 번 오프셋을 정한다. 기기가 잠들 때 단조 시계와 실제 시각이 어긋날 수 있다는 점을 알고 있어야 한다.
- **(f) tick 타이머와 백그라운드 정책.** 100~250ms 주기 tick 타이머를 둔다. 백그라운드 진입·visibilitychange 때 어떻게 할지(일시정지 등) 정한다.
- **(g) 화면 버튼 짝.** 쉬는 시간의 건너뛰기 = `skipRest`, 운동 중의 건너뛰기 = `skipExercise`.
- **(h) 표시.** 0부터 세는 인덱스(exerciseIndex·setIndex)는 화면·음성에서 +1 한다. 반복 0인 `finished`는 "세트 완료" 안내를 하지 않는다.
- **(i) 중간 저장/복구.** 앱이 도중에 죽으면 그 세션을 잃는다. MVP에서는 받아들일지, 중간 저장과 복구를 할지 정한다.
- **(j) CSP를 앱으로 옮긴다.** 개발 모드 완화(`style-src 'unsafe-inline'`, `connect-src ws: wss:`)를 넣는 replace가 실제로 적용되는지 검증한다. `base-uri`·`form-action`을 정한다. 자가 점검의 CSP 위반 수를 자동으로 판정한다.
- **(k) 루틴 편집 입력 범위 검증은 앱이 한다.** 코어는 범위를 검증하지 않는다(세트 수는 floor, 음수는 0).
- **(l) 실기기 확인 목록.** S23에서 CSP 동작, 벤치·턱걸이 실측(#6, #9), 푸시업 녹화 추가.
