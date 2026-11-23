import { describe, expect, it } from 'vitest';
import type { EndReason, Routine, RoutineEvent, SetEvent, SetResult, WorkoutSession } from '@wom/core';
import { koCount } from '../src/domain/koNumbers';
import { phraseFor } from '../src/domain/phrases';

const routine: Routine = {
  id: 'r1',
  name: '테스트',
  order: 0,
  createdAt: 0,
  updatedAt: 0,
  exercises: [
    { exercise: 'squat', sets: 3, target: { kind: 'reps', reps: 10 }, restSec: 60 },
    { exercise: 'deadHang', sets: 2, target: { kind: 'seconds', seconds: 30 }, restSec: 60 },
  ],
};
const ctx = { routine };

const setEv = (event: SetEvent, exerciseIndex = 0): RoutineEvent => ({ type: 'set', exerciseIndex, setIndex: 0, event });
const result = (o: Partial<SetResult> = {}): SetResult => ({
  exercise: 'squat',
  target: { kind: 'reps', reps: 10 },
  count: 0,
  heldMs: 0,
  negativeDescentMs: [],
  startT: 0,
  endT: 0,
  endReason: 'idle',
  ...o,
});
const finished = (reason: EndReason, r: Partial<SetResult> = {}, exerciseIndex = 0) =>
  setEv({ type: 'finished', reason, result: result({ endReason: reason, ...r }) }, exerciseIndex);
const session = (completed: boolean) => ({ completed }) as unknown as WorkoutSession;

describe('koCount', () => {
  it('1~10은 고유어, 11 이상은 숫자', () => {
    expect(koCount(1)).toBe('하나');
    expect(koCount(2)).toBe('둘');
    expect(koCount(5)).toBe('다섯');
    expect(koCount(10)).toBe('열');
    expect(koCount(11)).toBe('11');
    expect(koCount(25)).toBe('25');
  });
});

describe('phraseFor', () => {
  it('countdown', () => {
    expect(phraseFor(setEv({ type: 'countdown', n: 3 }), ctx)).toBe('셋');
    expect(phraseFor(setEv({ type: 'countdown', n: 2 }), ctx)).toBe('둘');
    expect(phraseFor(setEv({ type: 'countdown', n: 1 }), ctx)).toBe('하나');
  });
  it('start, rep', () => {
    expect(phraseFor(setEv({ type: 'start' }), ctx)).toBe('시작');
    expect(phraseFor(setEv({ type: 'rep', count: 3 }), ctx)).toBe('셋');
    expect(phraseFor(setEv({ type: 'rep', count: 12 }), ctx)).toBe('12');
  });
  it('hold: 10초 배수만', () => {
    expect(phraseFor(setEv({ type: 'hold', seconds: 10 }, 1), ctx)).toBe('10초');
    expect(phraseFor(setEv({ type: 'hold', seconds: 20 }, 1), ctx)).toBe('20초');
    expect(phraseFor(setEv({ type: 'hold', seconds: 15 }, 1), ctx)).toBeNull();
    expect(phraseFor(setEv({ type: 'hold', seconds: 0 }, 1), ctx)).toBeNull();
  });
  it('goalReached', () => {
    expect(phraseFor(setEv({ type: 'goalReached' }, 0), ctx)).toBe('목표 달성, 세트 끝');
    expect(phraseFor(setEv({ type: 'goalReached' }, 1), ctx)).toBe('목표 달성');
    expect(phraseFor(setEv({ type: 'goalReached' }, 9), ctx)).toBeNull();
  });
  it('finished', () => {
    expect(phraseFor(finished('idle', { count: 8 }), ctx)).toBe('세트를 마칠게요, 8회');
    expect(phraseFor(finished('idle', { count: 0 }), ctx)).toBeNull();
    expect(phraseFor(finished('released', { heldMs: 25000 }, 1), ctx)).toBe('25초 버텼어요');
    expect(phraseFor(finished('released', { heldMs: 1400 }, 1), ctx)).toBe('1초 버텼어요');
    expect(phraseFor(finished('released', { heldMs: 400 }, 1), ctx)).toBeNull();
    expect(phraseFor(finished('released', { heldMs: 0 }, 1), ctx)).toBeNull();
    expect(phraseFor(finished('manual', { count: 5 }), ctx)).toBeNull();
    expect(phraseFor(finished('target', { count: 10 }), ctx)).toBeNull();
  });
  it('rest', () => {
    const next = { exerciseIndex: 0, setIndex: 1, exercise: 'squat' as const, target: { kind: 'reps' as const, reps: 10 } };
    expect(phraseFor({ type: 'restStart', seconds: 60, next }, ctx)).toBe('쉬는 시간 60초');
    expect(phraseFor({ type: 'restTick', remaining: 30 }, ctx)).toBe('30초 남았어요');
    expect(phraseFor({ type: 'restTick', remaining: 5 }, ctx)).toBe('다섯');
    expect(phraseFor({ type: 'restTick', remaining: 4 }, ctx)).toBe('넷');
    expect(phraseFor({ type: 'restTick', remaining: 3 }, ctx)).toBe('셋');
    expect(phraseFor({ type: 'restTick', remaining: 2 }, ctx)).toBe('둘');
    expect(phraseFor({ type: 'restTick', remaining: 1 }, ctx)).toBe('하나');
    expect(phraseFor({ type: 'restTick', remaining: 20 }, ctx)).toBeNull();
    expect(phraseFor({ type: 'restTick', remaining: 6 }, ctx)).toBeNull();
    expect(phraseFor({ type: 'restEnd' }, ctx)).toBeNull();
  });
  it('nextUp', () => {
    expect(
      phraseFor({ type: 'nextUp', exerciseIndex: 0, exercise: 'squat', setIndex: 1, target: { kind: 'reps', reps: 12 } }, ctx),
    ).toBe('다음은 스쿼트 2세트, 12회');
    expect(
      phraseFor({ type: 'nextUp', exerciseIndex: 1, exercise: 'deadHang', setIndex: 0, target: { kind: 'seconds', seconds: 30 } }, ctx),
    ).toBe('다음은 매달리기 1세트, 30초');
  });
  it('hint, backToReady', () => {
    expect(phraseFor(setEv({ type: 'hint', diagnosis: 'notReady' }), ctx)).toBe('옆에서 찍어 주세요');
    expect(phraseFor(setEv({ type: 'hint', diagnosis: 'notVisible' }), ctx)).toBe('몸이 화면에 다 보이게 해 주세요');
    expect(phraseFor(setEv({ type: 'hint', diagnosis: 'calibratedByDefault' }), ctx)).toBe('준비 자세를 잡지 못해 기본값으로 셀게요');
    expect(phraseFor(setEv({ type: 'backToReady' }), ctx)).toBe('준비가 되면 다시 자세를 잡아 주세요');
  });
  it('exerciseStart', () => {
    expect(phraseFor({ type: 'exerciseStart', exerciseIndex: 0, exercise: 'squat' }, ctx)).toBe('스쿼트, 3세트');
    expect(phraseFor({ type: 'exerciseStart', exerciseIndex: 7, exercise: 'squat' }, ctx)).toBeNull();
  });
  it('routineEnd', () => {
    expect(phraseFor({ type: 'routineEnd', session: session(true) }, ctx)).toBe('루틴 완료, 수고했어요');
    expect(phraseFor({ type: 'routineEnd', session: session(false) }, ctx)).toBe('운동을 마쳤어요');
  });
});
