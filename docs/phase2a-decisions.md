# Phase 2a 진행 중 내린 판단

- 기간: 2026-11-20
- 브랜치: `feat/phase2a`
- 계획: `docs/superpowers/plans/2026-11-20-phase2a-core-session.md`
- 이 문서는 작업 중 진행 장부(git 제외)에 있던 판단 기록을 옮긴 것이다.

## 1. 사용자가 정한 것
- 세트는 손 안 대는 방식으로 진행한다. 준비 자세를 잡으면 "셋, 둘, 하나, 시작"이 나오고, 목표에 닿거나 5초 동안 멈추면 세트가 끝난다.
- 코어를 먼저 정리하고(A안), 그다음 앱을 새로 만든다.
- 철봉 운동은 카운트다운 없이 그 자세가 되면 바로 시작한다.
- 그만하기는 루틴 전체를 끝내고, 기록은 미완료로 저장한다.
- 벤치프레스와 턱걸이는 일단 구현하고 실측은 나중에 한다.
- 실패하는 테스트를 먼저 쓴다.

## 2. 구현하면서 대신 내린 판단 (틀렸을 때의 비용)
| 판단 | 이유 | 틀렸을 때 |
|---|---|---|
| 몸통 각도: 양쪽이 다 보이면 중점, 아니면 같은 쪽 어깨·엉덩이 짝, 짝이 없으면 null | world 좌표의 z 차이 때문에 반대편끼리 짝지으면 스쿼트 판정 경계(55°)에 걸린다 | 한쪽만 보이는 각도에서 준비 판정이 null로 더 자주 나온다 |
| 보정 타임아웃이면 관측한 최고점을 쓰되, minBaseline보다 낮으면 기본값을 쓴다 | 바닥 근처에서 시작하면 기준이 비정상으로 잡히는 것을 막는다 | 카메라 각도 때문에 전체 각도가 밀린 사람은 기본값으로 시작한다 |
| 타임아웃 기준점 테스트를 165→168(observed)로 바꿈 | 스펙 5.2에 따른 결과값이다 | — |
| 카운터 통합 때 경계 비교와 재무장 시점을 Fixed 방식으로 맞춤(dec9dfe) | 계획이 "기존 기대값이 안 깨지는 차이는 통일"을 허용한다. 녹화 비교 차이 0건 | 무작위 입력 1500개 중 99개 차이. 되돌리려면 `git revert dec9dfe` |
| 매달리기 중 프레임이 끊기면 tick 기준 graceMs(500) 뒤 released로 끝냄 | 카메라가 멈춰도 세트가 끝나야 한다 | — |
| calibratedByDefault 안내는 세트당 한 번 | 운동 중 같은 음성이 반복되면 방해된다 | — |
| noStart 사유는 쓰지 않고 backToReady 이벤트로 바꿈. 카운트다운 중 stop의 result는 null. startT/endT는 이벤트를 낸 호출 시각 | 단순화 | — |
| stop은 먼저 밀린 시간을 처리한다. 일시정지 중이면 되돌림 기준은 pausedAt. waitingReady에서 resume하면 트래커를 새로 만든다 | 그만하기·일시정지 경계를 정확히 하려고 | 운동 중(active) 일시정지는 트래커를 유지하므로, 반복 도중에 멈추면 재개 뒤 그 반복이 확정될 수 있다 |
| 네거티브(start 'visible')에는 noStart/backToReady를 적용하지 않음 | 보이는 채로 쉬면 20초마다 "다시 자세"와 "시작"이 반복된다 | — |
| 쉬는 시간 건너뛰기 `skipRest`를 추가(완료 여부에 영향 없음) | 스펙 6.2의 쉬는 시간 화면 버튼 | — |
| 일시정지 중 건너뛰기는 일시정지를 풀고 진행 | 새 세트가 멈춘 채로 시작되는 문제 | — |
| 기록 시각 통일(SetLog도 toEpoch), restStart.next 추가, nextUp·SetLog에 exerciseIndex 추가 | 저장할 레코드와 쉬는 시간 화면에 필요하다 | toEpoch는 평행이동(t + 상수)이어야 restTakenMs와 맞는다 |
| `set(finished).result`는 프레임 시계로 둠. 저장은 `routineEnd.session`으로 | 시계를 분리하려고 | 앱이 잘못된 쪽을 저장하면 시각이 틀어진다 |
| 운동 사이 쉬는 시간에 skipExercise를 하면 실제로 건너뛴 세트가 없으면 완료로 본다 | 최종 검토에서 나온 버그 수정 | — |

## 3. 2b로 넘긴 것
설계 문서 10절 (a)~(l) 참고. 핵심은 다음과 같다.
- 안내(hint)는 일정 시간 이상 이어질 때만 낸다.
- 일시정지를 풀었을 때 다시 시작할 여유를 준다.
- backToReady 반복 규칙
- RoutineRunner의 조회 getter
- tick 타이머와 시계
- CSP 이식

## 4. 미뤄 둔 작은 지적 (Minor)
- 테스트 보강
  - 양팔이 가려진 경우에 ready/FLAT
  - 좌우 대칭 중복
  - 한쪽 팔 깜빡임
  - pauseAfterMs 암묵 의존
  - 진단 우선순위 동시 조건
  - observed → calibratedByDefault
  - result 복사
  - countdown hint 발생 단언
  - 자가 점검 위반 수 자동 판정
- 코드 정리
  - exit ≥ enter 전제를 생성자에서 검사
  - `phase as RepPhase` 캐스트
  - strategies의 `this.base!` 주석
  - Fixed의 peak/valley 미사용 추적
  - 도달할 수 없는 throw
  - START_POSE_MS와 HOLD 상수 중복
  - visible 판정 중복 계산
  - push/tick 시각 비교 기준 통일
  - 테스트 헬퍼 중복을 `test/helpers`로
- 동작 경계
  - 일시정지 중 stop의 endT에 일시정지 시간이 들어간다
  - 매달리기 시작 전 pause의 rawAtResume
  - active가 아닐 때 stop은 advance 이벤트를 버린다
  - restTakenMs가 기록되지 않은 세트를 포함한다
  - 관측 최고점 한 프레임 노이즈(백분위 검토)
- 기타
  - flat 헬퍼의 world 무릎
  - 푸시업 실녹화 1개뿐
  - dev CSP replace 취약
  - base-uri/form-action
  - README 문장
