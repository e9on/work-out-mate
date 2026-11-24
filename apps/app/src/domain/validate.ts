import type { ExerciseId, Routine } from '@wom/core';

export const EXERCISE_NAMES: Record<ExerciseId, string> = {
  squat: '스쿼트',
  pushup: '푸시업',
  dumbbellBench: '덤벨 벤치프레스',
  pullup: '턱걸이',
  negative: '네거티브',
  deadHang: '매달리기',
};

export const EXERCISE_IDS: ExerciseId[] = ['squat', 'pushup', 'dumbbellBench', 'pullup', 'negative', 'deadHang'];

export function newRoutine(name: string, order: number, now: number, id: string): Routine {
  return { id, name, order, exercises: [], createdAt: now, updatedAt: now };
}

const inRange = (v: number, min: number, max: number) => Number.isFinite(v) && v >= min && v <= max;
const inIntRange = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** 한국어 오류 문구 목록. 비어 있으면 통과. */
export function validateRoutine(r: Routine): string[] {
  const errors: string[] = [];
  const nameLen = r.name.trim().length;
  if (nameLen < 1 || nameLen > 20) errors.push('루틴 이름은 1자 이상 20자 이하로 입력해 주세요.');
  if (r.exercises.length < 1) errors.push('운동을 1개 이상 추가해 주세요.');
  r.exercises.forEach((e, i) => {
    const label = `${i + 1}번 ${EXERCISE_NAMES[e.exercise]}`;
    if (!inIntRange(e.sets, 1, 10)) errors.push(`${label}: 세트는 1~10 사이 정수로 입력해 주세요.`);
    if (e.exercise === 'deadHang') {
      if (e.target.kind !== 'seconds') errors.push(`${label}: 목표는 초로 정해야 해요.`);
      else if (!inRange(e.target.seconds, 5, 600)) errors.push(`${label}: 초는 5~600 사이로 입력해 주세요.`);
    } else if (e.target.kind !== 'reps') {
      errors.push(`${label}: 목표는 횟수로 정해야 해요.`);
    } else if (!inIntRange(e.target.reps, 1, 100)) {
      errors.push(`${label}: 횟수는 1~100 사이 정수로 입력해 주세요.`);
    }
    if (!inIntRange(e.restSec, 0, 600)) errors.push(`${label}: 쉬는 시간은 0~600 사이 정수로 입력해 주세요.`);
  });
  return errors;
}
