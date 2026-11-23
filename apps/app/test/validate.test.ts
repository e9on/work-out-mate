import { describe, expect, it } from 'vitest';
import type { Routine, RoutineExercise } from '@wom/core';
import { newRoutine, validateRoutine } from '../src/domain/validate';

const ex = (o: Partial<RoutineExercise> = {}): RoutineExercise => ({
  exercise: 'squat',
  sets: 3,
  target: { kind: 'reps', reps: 10 },
  restSec: 60,
  ...o,
});
const routine = (o: Partial<Routine> = {}): Routine => ({ ...newRoutine('아침', 0, 1000, 'r1'), exercises: [ex()], ...o });

describe('newRoutine', () => {
  it('빈 운동 목록과 같은 시각의 createdAt·updatedAt으로 만든다', () => {
    expect(newRoutine('아침', 2, 500, 'x')).toEqual({
      id: 'x', name: '아침', order: 2, exercises: [], createdAt: 500, updatedAt: 500,
    });
  });
});

describe('validateRoutine', () => {
  it('정상 루틴은 오류가 없다', () => {
    expect(validateRoutine(routine())).toEqual([]);
  });
  it('이름: 빈칸·공백만은 오류, 20자는 통과, 21자는 오류', () => {
    expect(validateRoutine(routine({ name: '' })).length).toBeGreaterThan(0);
    expect(validateRoutine(routine({ name: '   ' })).length).toBeGreaterThan(0);
    expect(validateRoutine(routine({ name: ' ' + 'a'.repeat(20) + ' ' }))).toEqual([]);
    expect(validateRoutine(routine({ name: 'a'.repeat(21) })).length).toBeGreaterThan(0);
  });
  it('운동이 0개면 오류', () => {
    expect(validateRoutine(routine({ exercises: [] })).length).toBeGreaterThan(0);
  });
  it.each([[0, false], [1, true], [10, true], [11, false], [2.5, false], [NaN, false]])('세트 %s -> 통과 %s', (sets, ok) => {
    expect(validateRoutine(routine({ exercises: [ex({ sets })] })).length === 0).toBe(ok);
  });
  it.each([[0, false], [1, true], [100, true], [101, false], [1.5, false], [NaN, false]])('횟수 %s -> 통과 %s', (reps, ok) => {
    expect(validateRoutine(routine({ exercises: [ex({ target: { kind: 'reps', reps } })] })).length === 0).toBe(ok);
  });
  it.each([[4, false], [5, true], [600, true], [601, false], [NaN, false]])('초 %s -> 통과 %s', (seconds, ok) => {
    const e = ex({ exercise: 'deadHang', target: { kind: 'seconds', seconds } });
    expect(validateRoutine(routine({ exercises: [e] })).length === 0).toBe(ok);
  });
  it.each([[-1, false], [0, true], [600, true], [601, false], [1.5, false], [NaN, false]])('쉬는 시간 %s -> 통과 %s', (restSec, ok) => {
    expect(validateRoutine(routine({ exercises: [ex({ restSec })] })).length === 0).toBe(ok);
  });
  it('deadHang에 reps 목표면 오류, 다른 운동에 seconds 목표도 오류', () => {
    expect(validateRoutine(routine({ exercises: [ex({ exercise: 'deadHang' })] })).length).toBeGreaterThan(0);
    expect(
      validateRoutine(routine({ exercises: [ex({ target: { kind: 'seconds', seconds: 30 } })] })).length,
    ).toBeGreaterThan(0);
  });
});
