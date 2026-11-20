import { describe, expect, it } from 'vitest';
import { completedCount, recommendNext } from '../src/session/recommend';
import type { Routine, WorkoutSession } from '../src/session/model';

function r(id: string, order: number): Routine {
  return { id, name: `루틴 ${id}`, order, exercises: [], createdAt: 0, updatedAt: 0 };
}
function s(routineId: string, endedAt: number, completed = true): WorkoutSession {
  return { id: `s-${routineId}-${endedAt}`, routineId, routineName: routineId, startedAt: endedAt - 10, endedAt, completed, sets: [] };
}
// 일부러 order와 다른 순서로 둔다
const ROUTINES = [r('C', 3), r('A', 1), r('B', 2)];

describe('recommendNext', () => {
  it('세션이 없으면 order가 가장 앞인 루틴', () => {
    expect(recommendNext(ROUTINES, [])!.id).toBe('A');
  });
  it('마지막 완료 세션이 B면 C', () => {
    expect(recommendNext(ROUTINES, [s('B', 200), s('A', 100)])!.id).toBe('C');
  });
  it('세션 배열 순서가 아니라 endedAt이 가장 큰 세션을 본다', () => {
    expect(recommendNext(ROUTINES, [s('A', 300), s('B', 200)])!.id).toBe('B');
  });
  it('마지막이 마지막 순서 루틴이면 처음으로', () => {
    expect(recommendNext(ROUTINES, [s('C', 100)])!.id).toBe('A');
  });
  it('미완료 세션은 무시한다', () => {
    expect(recommendNext(ROUTINES, [s('A', 100), s('B', 200, false)])!.id).toBe('B');
    expect(recommendNext(ROUTINES, [s('B', 200, false)])!.id).toBe('A');
  });
  it('마지막 완료 루틴이 지워졌으면 첫 루틴', () => {
    expect(recommendNext(ROUTINES, [s('A', 100), s('X', 200)])!.id).toBe('A');
  });
  it('루틴이 없으면 null', () => {
    expect(recommendNext([], [s('A', 100)])).toBeNull();
  });
  it('입력 배열을 바꾸지 않는다', () => {
    const rs = [...ROUTINES];
    recommendNext(rs, []);
    expect(rs.map((x) => x.id)).toEqual(['C', 'A', 'B']);
  });
});

describe('completedCount', () => {
  it('그 루틴의 완료 세션만 센다', () => {
    const ss = [s('A', 1), s('A', 2), s('A', 3, false), s('B', 4)];
    expect(completedCount('A', ss)).toBe(2);
    expect(completedCount('B', ss)).toBe(1);
    expect(completedCount('C', ss)).toBe(0);
  });
});
