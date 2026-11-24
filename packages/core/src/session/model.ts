import type { ExerciseId } from '../exercises/runner';

/** 세트 목표: 횟수 또는 버틸 초 */
export type Target = { kind: 'reps'; reps: number } | { kind: 'seconds'; seconds: number };

/**
 * 세트가 끝난 이유.
 * target 목표 도달 / idle 마지막 반복 뒤 반복 없음 / manual 그만하기·건너뛰기 / button 세트 끝 버튼 /
 * released 매달리기에서 손을 놓음.
 * 시작 뒤 첫 반복이 없으면 세트를 끝내지 않고 준비 자세 대기로 돌아가므로(backToReady) 종료 사유가 아니다.
 */
export type EndReason = 'target' | 'idle' | 'manual' | 'button' | 'released';

/** 반복 하나의 시각. index는 1부터(세트 안 반복 번호), bottomT는 RepEvent.turnT. 시계는 쓰는 곳(SetResult·SetLog)을 따른다. */
export type RepTiming = { index: number; startT: number; bottomT: number; endT: number };

/** 세트 기록. 시각(startT·endT)은 프레임 시계(PoseFrame.t)와 같은 ms 단위다. */
export type SetResult = {
  exercise: ExerciseId;
  target: Target;
  /** 실제 횟수(버티기 운동은 0) */
  count: number;
  /** 버틴 ms(반복 운동은 0) */
  heldMs: number;
  /** negative 운동의 반복별 내려온 ms(RepEvent.outMs). 다른 운동은 빈 배열 */
  negativeDescentMs: number[];
  /** start 이벤트 시각 */
  startT: number;
  /** finished 시각 */
  endT: number;
  endReason: EndReason;
  /** 반복별 시각(버티기 운동은 빈 배열). 되돌려진 반복은 빠져 count === reps.length. 옛 기록엔 없을 수 있다 */
  reps?: RepTiming[];
};

/** 루틴 안의 운동 하나: 세트 수, 세트 목표, 이 운동 세트 앞의 쉬는 시간(초) */
export type RoutineExercise = { exercise: ExerciseId; sets: number; target: Target; restSec: number };

export type Routine = {
  id: string;
  name: string;
  /** 오늘의 루틴 추천 순서(작을수록 앞) */
  order: number;
  exercises: RoutineExercise[];
  createdAt: number;
  updatedAt: number;
};

/**
 * 세션에 담기는 세트 기록.
 * startT·endT는 RoutineRunner의 toEpoch로 바꾼 절대 시각이다(SetResult의 프레임 시계가 아니다).
 * exerciseIndex는 루틴 안 운동 위치(같은 운동이 두 번 나와도 구분), setIndex는 그 운동 안 세트 번호.
 * restTakenMs = 이전 기록 세트의 endT부터 이 세트 startT까지(차이값이라 시계와 상관없음, 첫 기록 세트는 null).
 */
export type SetLog = SetResult & { exerciseIndex: number; setIndex: number; restTakenMs: number | null };

/**
 * 루틴 한 번 진행한 기록. startT/endT(각 SetLog)/startedAt/endedAt은 모두 toEpoch로 바꾼 절대 시각이다.
 * completed는 모든 운동의 모든 세트가 그만하기(manual) 아닌 사유로(세트 끝 버튼 button은 정상 종료) 끝나고 건너뛰기·그만하기가 없었을 때만 true.
 */
export type WorkoutSession = {
  id: string;
  routineId: string;
  routineName: string;
  startedAt: number;
  endedAt: number;
  completed: boolean;
  sets: SetLog[];
};
