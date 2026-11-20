import type { ExerciseId } from '../exercises/runner';

/** 세트 목표: 횟수 또는 버틸 초 */
export type Target = { kind: 'reps'; reps: number } | { kind: 'seconds'; seconds: number };

/**
 * 세트가 끝난 이유.
 * target 목표 도달 / idle 마지막 반복 뒤 반복 없음 / manual 그만하기 / released 매달리기에서 손을 놓음 /
 * noStart 시작 뒤 첫 반복 없음(SetRunner는 이때 끝내지 않고 준비 자세 대기로 돌아간다. 루틴 쪽에서 쓸 값)
 */
export type EndReason = 'target' | 'idle' | 'manual' | 'released' | 'noStart';

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
};
