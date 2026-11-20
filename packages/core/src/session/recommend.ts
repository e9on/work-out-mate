import type { Routine, WorkoutSession } from './model';

/**
 * 오늘의 루틴 추천. routines를 order로 정렬하고, 완료 세션 중 endedAt이 가장 큰 세션의 루틴 다음 순서를
 * 돌려준다(마지막이면 처음으로). 완료 세션이 없거나 그 루틴이 지워졌으면 첫 루틴, routines가 비면 null.
 * 미완료 세션은 보지 않는다.
 * 경계 동작(테스트로 고정): order가 같은 루틴은 입력 배열 순서를 유지하고(안정 정렬), endedAt이 같은 완료 세션이
 * 여럿이면 sessions 배열에서 먼저 나온 세션을 마지막 세션으로 본다.
 */
export function recommendNext(routines: Routine[], sessions: WorkoutSession[]): Routine | null {
  if (routines.length === 0) return null;
  const sorted = [...routines].sort((a, b) => a.order - b.order);
  let last: WorkoutSession | null = null;
  for (const s of sessions) {
    if (s.completed && (last === null || s.endedAt > last.endedAt)) last = s;
  }
  if (last === null) return sorted[0]!;
  const i = sorted.findIndex((r) => r.id === last.routineId);
  if (i < 0) return sorted[0]!;
  return sorted[(i + 1) % sorted.length]!;
}

/** 그 루틴의 완료 세션 수(화면의 "N번째"는 이 값 + 1) */
export function completedCount(routineId: string, sessions: WorkoutSession[]): number {
  let n = 0;
  for (const s of sessions) if (s.completed && s.routineId === routineId) n += 1;
  return n;
}
