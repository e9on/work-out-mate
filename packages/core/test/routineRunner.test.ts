import { describe, expect, it } from 'vitest';
import { RoutineRunner, type RoutineEvent } from '../src/session/routineRunner';
import type { Routine, RoutineExercise, WorkoutSession } from '../src/session/model';
import type { SetConfig, SetEvent } from '../src/session/setRunner';
import { LM, type PoseFrame } from '../src/types';
import { buildPose } from './helpers/poseBuilder';

const DT = 33;

/** a에서 b로 n프레임 선형 변화(끝점 제외) */
function lin(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / n);
}
/** rest → bottom → rest 한 번(약 1.4초) */
function oneRep(rest: number, bottom: number, n = 15): number[] {
  return [...Array(5).fill(rest), ...lin(rest, bottom, n), ...Array(3).fill(bottom), ...lin(bottom, rest, n), ...Array(5).fill(rest)];
}
const hold = (v: number, ms: number): number[] => Array(Math.ceil(ms / DT)).fill(v);
const reps = (rest: number, bottom: number, k: number): number[] =>
  Array.from({ length: k }, () => oneRep(rest, bottom)).flat();

type Timed = { t: number; ev: RoutineEvent };

/** 스쿼트(무릎)·푸시업(팔꿈치, 엎드림) 합성 프레임. 준비 자세 1초 뒤 k회 */
const MOVES = {
  squat: { key: 'knee', rest: 175, bottom: 90, extra: {} },
  pushup: { key: 'elbow', rest: 170, bottom: 85, extra: { torso: 'flat' } },
} as const;
type Ex = keyof typeof MOVES;

/** 루틴 진행기에 프레임 시계를 붙여 프레임·tick을 넣고 이벤트를 시각과 함께 모은다. */
class Driver {
  t = 0;
  readonly log: Timed[] = [];
  /** 호출 하나가 돌려준 배열 단위 기록(같은 호출 안 순서 확인용) */
  readonly calls: Array<{ t: number; evs: RoutineEvent[] }> = [];
  constructor(readonly rr: RoutineRunner) {}

  private record(t: number, evs: RoutineEvent[]): RoutineEvent[] {
    if (evs.length > 0) this.calls.push({ t, evs });
    for (const ev of evs) this.log.push({ t, ev });
    return evs;
  }
  push(f: PoseFrame): RoutineEvent[] {
    return this.record(f.t, this.rr.push(f));
  }
  tick(t: number): RoutineEvent[] {
    this.t = Math.max(this.t, t);
    return this.record(t, this.rr.tick(t));
  }
  skip(): RoutineEvent[] {
    return this.record(this.t, this.rr.skipExercise(this.t));
  }
  stop(): RoutineEvent[] {
    return this.record(this.t, this.rr.stop(this.t));
  }
  /** 각도 열을 프레임으로 넣는다. until이 참인 이벤트가 나오면 그 프레임에서 멈춘다. */
  frames(ex: Ex, values: number[], until?: (e: RoutineEvent) => boolean): void {
    const m = MOVES[ex];
    for (const v of values) {
      const f = buildPose({ ...m.extra, t: this.t, [m.key]: v });
      this.t += DT;
      const evs = this.push(f);
      if (until && evs.some(until)) return;
    }
  }
  /** 준비 자세 1초 + k회. 세트가 끝나면 멈춘다 */
  doSet(ex: Ex, k: number): void {
    const m = MOVES[ex];
    this.frames(ex, [...hold(m.rest, 1000), ...reps(m.rest, m.bottom, k), ...hold(m.rest, 7000)], isSetFinished);
  }
  /** 프레임 없이 step 간격 tick으로 쉬는 시간이 끝날 때까지 */
  tickUntilRestEnd(step = 100, limitMs = 300000): void {
    const end = this.t + limitMs;
    while (this.t < end) {
      const evs = this.tick(this.t + step);
      if (evs.some((e) => e.type === 'restEnd')) return;
    }
    throw new Error('restEnd가 나오지 않음');
  }
}

const isSetFinished = (e: RoutineEvent) => e.type === 'set' && e.event.type === 'finished';
const isSet = (type: SetEvent['type']) => (e: RoutineEvent) => e.type === 'set' && e.event.type === type;

function routine(exercises: RoutineExercise[]): Routine {
  return { id: 'r1', name: '루틴 1', order: 0, exercises, createdAt: 0, updatedAt: 0 };
}
const sq = (sets: number, reps: number, restSec: number): RoutineExercise => ({
  exercise: 'squat',
  sets,
  target: { kind: 'reps', reps },
  restSec,
});
const pu = (sets: number, reps: number, restSec: number): RoutineExercise => ({
  exercise: 'pushup',
  sets,
  target: { kind: 'reps', reps },
  restSec,
});

function runner(
  exercises: RoutineExercise[],
  toEpoch?: (t: number) => number,
  set: Partial<Omit<SetConfig, 'exercise' | 'target'>> = {},
): Driver {
  return new Driver(
    new RoutineRunner(routine(exercises), { startT: 0, sessionId: 's1', toEpoch, set: { countdownMs: 0, ...set } }),
  );
}

/** 연속된 set 이벤트는 하나로 줄이고 restTick·nextUp은 빼서 큰 흐름만 본다 */
function flow(log: Timed[]): string[] {
  const out: string[] = [];
  for (const { ev } of log) {
    if (ev.type === 'restTick' || ev.type === 'nextUp') continue;
    if (ev.type === 'set' && out.at(-1) === 'set') continue;
    out.push(ev.type);
  }
  return out;
}
const ofType = <K extends RoutineEvent['type']>(log: Timed[], type: K) =>
  log.filter((x): x is { t: number; ev: Extract<RoutineEvent, { type: K }> } => x.ev.type === type);
function sessionOf(log: Timed[]): WorkoutSession {
  const e = ofType(log, 'routineEnd');
  expect(e).toHaveLength(1);
  return e[0]!.ev.session;
}
const restTicks = (log: Timed[]) => ofType(log, 'restTick').map((x) => x.ev.remaining);
/** 마지막 restStart 이벤트의 시각 */
const lastRestStartT = (d: Driver) => ofType(d.log, 'restStart').at(-1)!.t;

describe('RoutineRunner: 2운동 × 2세트를 끝까지', () => {
  it('exerciseStart → 세트 → 쉬는 시간 → … → routineEnd, sets 4개, completed true, restTakenMs = 실제 쉰 시간', () => {
    const d = runner([sq(2, 2, 3), pu(2, 2, 4)], (t) => 1_000_000 + t);
    d.doSet('squat', 2);
    d.tickUntilRestEnd();
    d.doSet('squat', 2);
    d.tickUntilRestEnd();
    d.doSet('pushup', 2);
    d.tickUntilRestEnd();
    d.doSet('pushup', 2);

    expect(flow(d.log)).toEqual([
      'exerciseStart', 'set', 'restStart', 'restEnd',
      'set', 'restStart', 'restEnd', 'exerciseStart',
      'set', 'restStart', 'restEnd',
      'set', 'routineEnd',
    ]);
    expect(ofType(d.log, 'exerciseStart').map((x) => [x.ev.exerciseIndex, x.ev.exercise])).toEqual([
      [0, 'squat'],
      [1, 'pushup'],
    ]);
    // 운동 사이(스쿼트 → 푸시업) 쉬는 시간은 다음 운동(푸시업)의 4초
    expect(ofType(d.log, 'restStart').map((x) => x.ev.seconds)).toEqual([3, 4, 4]);

    const s = sessionOf(d.log);
    expect(s.completed).toBe(true);
    expect(s.id).toBe('s1');
    expect(s.routineId).toBe('r1');
    expect(s.routineName).toBe('루틴 1');
    expect(s.startedAt).toBe(1_000_000);
    expect(s.endedAt).toBe(1_000_000 + ofType(d.log, 'routineEnd')[0]!.t);
    expect(s.sets.map((x) => [x.exercise, x.setIndex, x.count, x.endReason])).toEqual([
      ['squat', 0, 2, 'target'],
      ['squat', 1, 2, 'target'],
      ['pushup', 0, 2, 'target'],
      ['pushup', 1, 2, 'target'],
    ]);
    expect(s.sets[0]!.restTakenMs).toBeNull();
    // 실제 쉰 시간 = 세트 finished 시각부터 다음 세트 start 시각까지
    const fins = d.log.filter((x) => isSetFinished(x.ev));
    const starts = d.log.filter((x) => isSet('start')(x.ev));
    expect(fins).toHaveLength(4);
    expect(starts).toHaveLength(4);
    for (let i = 1; i < 4; i++) {
      const real = starts[i]!.t - fins[i - 1]!.t;
      expect(Math.abs(s.sets[i]!.restTakenMs! - real)).toBeLessThanOrEqual(50);
      expect(s.sets[i]!.restTakenMs!).toBeGreaterThanOrEqual(ofType(d.log, 'restStart')[i - 1]!.ev.seconds * 1000);
    }
    expect(d.rr.phase).toBe('done');
  });

  it('set 이벤트에 운동·세트 번호가 붙는다', () => {
    const d = runner([sq(2, 2, 3)]);
    d.doSet('squat', 2);
    const sets = ofType(d.log, 'set');
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.every((x) => x.ev.exerciseIndex === 0 && x.ev.setIndex === 0)).toBe(true);
    expect(sets.map((x) => x.ev.event.type)).toEqual(['start', 'rep', 'rep', 'goalReached', 'finished']);
  });

  it('세트가 끝난 호출에서 set(finished) → restStart가 같은 배열로, restEnd 호출에서 다음 운동의 exerciseStart가 이어서 나온다', () => {
    const d = runner([sq(1, 2, 30), pu(1, 2, 30)]);
    d.doSet('squat', 2);
    const finCall = d.calls.find((c) => c.evs.some(isSetFinished))!;
    const ts = finCall.evs.map((e) => (e.type === 'set' ? `set:${e.event.type}` : e.type));
    expect(ts.slice(-2)).toEqual(['set:finished', 'restStart']);
    expect(d.rr.phase).toBe('rest');
    d.tickUntilRestEnd();
    const endCall = d.calls.at(-1)!;
    expect(endCall.evs).toEqual([{ type: 'restEnd' }, { type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' }]);
    expect(d.rr.phase).toBe('set');
    expect(d.rr.current).toEqual({ exerciseIndex: 1, setIndex: 0 });
  });

  it('마지막 세트가 끝난 호출은 set(finished) → routineEnd로 끝나고 쉬는 시간이 없다', () => {
    const d = runner([sq(1, 2, 30)]);
    d.doSet('squat', 2);
    const last = d.calls.at(-1)!.evs;
    expect(last.at(-2)!.type).toBe('set');
    expect(last.at(-1)!.type).toBe('routineEnd');
    expect(ofType(d.log, 'restStart')).toHaveLength(0);
    expect(sessionOf(d.log).completed).toBe(true);
  });
});

describe('RoutineRunner: 쉬는 시간 이벤트', () => {
  it('60초: restTick 50,40,30,20,10,5,4,3,2,1, nextUp은 남은 20초에 한 번(다음 세트 정보)', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tickUntilRestEnd(100);
    expect(restTicks(d.log)).toEqual([50, 40, 30, 20, 10, 5, 4, 3, 2, 1]);
    const nu = ofType(d.log, 'nextUp');
    expect(nu).toHaveLength(1);
    expect(nu[0]!.ev).toEqual({ type: 'nextUp', exerciseIndex: 0, exercise: 'squat', setIndex: 1, target: { kind: 'reps', reps: 2 } });
    expect(nu[0]!.t - t0).toBeGreaterThanOrEqual(40000);
    expect(nu[0]!.t - t0).toBeLessThan(40000 + 100);
    // restTick은 올림한 남은 초가 그 값이 되는 첫 호출에서 나온다(남은 50초 이하 = 10초 지난 뒤 첫 tick)
    const tick50 = ofType(d.log, 'restTick')[0]!;
    expect(tick50.t - t0).toBeGreaterThanOrEqual(10000);
    expect(tick50.t - t0).toBeLessThan(10000 + 100);
    const end = ofType(d.log, 'restEnd')[0]!;
    expect(end.t - t0).toBeGreaterThanOrEqual(60000);
    expect(end.t - t0).toBeLessThan(60000 + 100);
  });

  it('tick이 크게 건너뛰면 지나간 값을 몰아서 내지 않고 지금 값 하나만 낸다', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    expect(d.tick(t0 + 30500)).toEqual([{ type: 'restTick', remaining: 30 }]);
    // 남은 27초: 10의 배수도 5 이하도 아니라 없음
    expect(d.tick(t0 + 33000)).toEqual([]);
    // 남은 19.5초 → 올림 20: restTick 20, 그리고 남은 20초 이하가 처음이라 nextUp
    expect(d.tick(t0 + 40500).map((e) => e.type)).toEqual(['restTick', 'nextUp']);
    // 같은 정수 초 안에서는 다시 내지 않는다
    expect(d.tick(t0 + 40700)).toEqual([]);
  });

  it('15초: nextUp이 restStart와 같은 호출에서 바로 나오고, restTick은 10,5,4,3,2,1', () => {
    const d = runner([sq(2, 2, 15)]);
    d.doSet('squat', 2);
    const finCall = d.calls.at(-1)!.evs;
    expect(finCall.slice(-3).map((e) => (e.type === 'set' ? `set:${e.event.type}` : e.type))).toEqual([
      'set:finished',
      'restStart',
      'nextUp',
    ]);
    d.tickUntilRestEnd(100);
    expect(ofType(d.log, 'nextUp')).toHaveLength(1);
    expect(restTicks(d.log)).toEqual([10, 5, 4, 3, 2, 1]);
  });

  it('운동 사이 쉬는 시간은 다음 운동의 restSec을 쓴다', () => {
    const d = runner([sq(1, 2, 30), pu(1, 2, 7)]);
    d.doSet('squat', 2);
    expect(ofType(d.log, 'restStart').map((x) => x.ev.seconds)).toEqual([7]);
    const nu = ofType(d.log, 'nextUp');
    expect(nu.map((x) => x.ev)).toEqual([
      { type: 'nextUp', exerciseIndex: 1, exercise: 'pushup', setIndex: 0, target: { kind: 'reps', reps: 2 } },
    ]);
  });

  it('restSec 0이면 restStart 없이 같은 호출에서 바로 다음 세트(waitingReady)', () => {
    const d = runner([sq(2, 2, 0), pu(1, 2, 0)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('set');
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 1 });
    d.doSet('squat', 2);
    expect(d.calls.at(-1)!.evs.at(-1)).toEqual({ type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' });
    d.doSet('pushup', 2);
    expect(ofType(d.log, 'restStart')).toHaveLength(0);
    expect(ofType(d.log, 'restEnd')).toHaveLength(0);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(3);
    expect(s.completed).toBe(true);
  });

  it('프레임 없이 tick만으로 쉬는 시간이 끝나고 다음 세트로 넘어간다', () => {
    const d = runner([sq(2, 2, 10)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 9999);
    expect(ofType(d.log, 'restEnd')).toHaveLength(0);
    expect(d.rr.phase).toBe('rest');
    expect(d.tick(t0 + 10000)).toEqual([{ type: 'restEnd' }]);
    expect(d.rr.phase).toBe('set');
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 1 });
  });

  it('쉬는 시간 중 프레임은 세지 않고, restEnd 뒤 새 세트는 준비 자세부터 시작한다', () => {
    const d = runner([sq(2, 2, 5)]);
    d.doSet('squat', 2);
    // 쉬는 시간 5초 동안 스쿼트를 해도 세트 이벤트가 없다
    const before = ofType(d.log, 'set').length;
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 2), ...hold(175, 3000)], (e) => e.type === 'restEnd');
    const during = d.log.filter((x) => x.t > lastRestStartT(d) && x.ev.type === 'set');
    expect(ofType(d.log, 'set').length).toBe(before);
    expect(during).toHaveLength(0);
    expect(ofType(d.log, 'restEnd')).toHaveLength(1);
    d.doSet('squat', 2);
    const s = sessionOf(d.log);
    expect(s.sets.map((x) => x.count)).toEqual([2, 2]);
  });

  it('쉬는 시간 중 10초 일시정지하면 restEnd가 10초 늦게 나오고, 멈춘 동안은 이벤트가 없다', () => {
    const d = runner([sq(2, 2, 30)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 1000);
    d.rr.pause(t0 + 1000);
    d.t = t0 + 1000;
    for (let t = t0 + 1100; t <= t0 + 11000; t += 100) expect(d.tick(t)).toEqual([]);
    d.rr.resume(t0 + 11000);
    d.tickUntilRestEnd(100);
    const end = ofType(d.log, 'restEnd')[0]!;
    expect(end.t - t0).toBeGreaterThanOrEqual(40000);
    expect(end.t - t0).toBeLessThan(40000 + 100);
    expect(restTicks(d.log)).toEqual([20, 10, 5, 4, 3, 2, 1]);
  });

  it('지금까지 본 시각보다 이르거나 같은 tick·push는 무시한다', () => {
    const d = runner([sq(2, 2, 10)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 5000);
    expect(d.tick(t0 + 5000)).toEqual([]);
    expect(d.tick(t0 + 4000)).toEqual([]);
    expect(d.push(buildPose({ t: t0 + 4500 }))).toEqual([]);
    expect(d.tick(t0 + 10000)).toEqual([{ type: 'restEnd' }]);
  });
});

describe('RoutineRunner: 건너뛰기', () => {
  it('반복이 있는 세트는 manual로 기록하고, 쉬는 시간 없이 다음 운동 waitingReady로 간다. completed false', () => {
    const d = runner([sq(2, 3, 10), pu(1, 2, 10)]);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1), ...hold(175, 2000)]);
    const evs = d.skip();
    expect(evs.map((e) => (e.type === 'set' ? `set:${e.event.type}` : e.type))).toEqual([
      'set:finished',
      'exerciseStart',
    ]);
    expect(evs.at(-1)).toEqual({ type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' });
    expect(d.rr.phase).toBe('set');
    expect(d.rr.current).toEqual({ exerciseIndex: 1, setIndex: 0 });
    d.doSet('pushup', 2);
    expect(ofType(d.log, 'restStart')).toHaveLength(0);
    const s = sessionOf(d.log);
    expect(s.completed).toBe(false);
    expect(s.sets.map((x) => [x.exercise, x.setIndex, x.count, x.endReason])).toEqual([
      ['squat', 0, 1, 'manual'],
      ['pushup', 0, 2, 'target'],
    ]);
  });

  it('반복이 없는 세트(준비 자세 대기)는 기록하지 않는다', () => {
    const d = runner([sq(2, 3, 10), pu(1, 2, 10)]);
    d.frames('squat', hold(175, 500));
    expect(d.skip()).toEqual([{ type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' }]);
    d.doSet('pushup', 2);
    const s = sessionOf(d.log);
    expect(s.sets.map((x) => x.exercise)).toEqual(['pushup']);
    expect(s.sets[0]!.restTakenMs).toBeNull();
    expect(s.completed).toBe(false);
  });

  it('같은 운동 세트 사이 쉬는 시간에 건너뛰면 쉬는 시간을 끝내고 남은 세트를 건너뛰어 다음 운동으로', () => {
    const d = runner([sq(3, 2, 30), pu(1, 2, 10)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    expect(d.skip()).toEqual([{ type: 'restEnd' }, { type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' }]);
    expect(d.rr.current).toEqual({ exerciseIndex: 1, setIndex: 0 });
    d.doSet('pushup', 2);
    const s = sessionOf(d.log);
    expect(s.sets.map((x) => [x.exercise, x.setIndex])).toEqual([
      ['squat', 0],
      ['pushup', 0],
    ]);
    expect(s.completed).toBe(false);
  });

  it('운동 사이 쉬는 시간에 건너뛰면 다음 운동을 건너뛰지 않고, 끝난 운동의 (남은 0개) 세트만 건너뛴다', () => {
    const d = runner([sq(1, 2, 30), pu(1, 2, 30), sq(1, 2, 30)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    // 쉬는 시간 중 current는 방금 끝난 세트
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 0 });
    expect(d.skip()).toEqual([{ type: 'restEnd' }, { type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' }]);
    expect(d.rr.current).toEqual({ exerciseIndex: 1, setIndex: 0 });
  });

  it('마지막 운동을 건너뛰면 routineEnd(completed false)', () => {
    const d = runner([sq(1, 2, 10), pu(2, 3, 10)]);
    d.doSet('squat', 2);
    d.tickUntilRestEnd();
    d.frames('pushup', [...hold(170, 1000), ...reps(170, 85, 1), ...hold(170, 2000)]);
    const evs = d.skip();
    expect(evs.at(-1)!.type).toBe('routineEnd');
    const s = sessionOf(d.log);
    expect(s.completed).toBe(false);
    expect(s.sets.map((x) => [x.exercise, x.count, x.endReason])).toEqual([
      ['squat', 2, 'target'],
      ['pushup', 1, 'manual'],
    ]);
    expect(d.rr.phase).toBe('done');
  });
});

describe('RoutineRunner: 그만하기', () => {
  it('첫 세트 준비 자세 대기 중 stop: sets 0, completed false', () => {
    const d = runner([sq(2, 2, 10)], (t) => 5000 + t);
    d.frames('squat', hold(175, 400));
    const evs = d.stop();
    expect(evs.at(-1)!.type).toBe('routineEnd');
    const s = sessionOf(d.log);
    expect(s.sets).toEqual([]);
    expect(s.completed).toBe(false);
    expect(s.startedAt).toBe(5000);
    expect(s.endedAt).toBe(5000 + d.t);
    expect(d.rr.phase).toBe('done');
  });

  it('입력 없이 바로 stop해도 exerciseStart 뒤 routineEnd', () => {
    const d = runner([sq(2, 2, 10)]);
    expect(d.stop().map((e) => e.type)).toEqual(['exerciseStart', 'routineEnd']);
  });

  it('두 번째 세트 중 stop: 첫 세트와 반복이 있는 두 번째 세트(manual)가 기록되고 completed false', () => {
    const d = runner([sq(2, 3, 10)]);
    d.doSet('squat', 3);
    d.tickUntilRestEnd();
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 2), ...hold(175, 2000)]);
    const evs = d.stop();
    expect(evs.map((e) => (e.type === 'set' ? `set:${e.event.type}` : e.type))).toEqual(['set:finished', 'routineEnd']);
    const s = sessionOf(d.log);
    expect(s.completed).toBe(false);
    expect(s.sets.map((x) => [x.setIndex, x.count, x.endReason])).toEqual([
      [0, 3, 'target'],
      [1, 2, 'manual'],
    ]);
    expect(s.sets[1]!.restTakenMs).not.toBeNull();
  });

  it('쉬는 시간 중 stop: 그 전까지의 세트로 routineEnd(completed false)', () => {
    const d = runner([sq(2, 2, 30)]);
    d.doSet('squat', 2);
    d.tick(d.t + 5000);
    expect(d.stop().map((e) => e.type)).toEqual(['routineEnd']);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(1);
    expect(s.completed).toBe(false);
  });

  it('routineEnd 뒤에는 모든 입력을 무시한다', () => {
    const d = runner([sq(1, 2, 10)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('done');
    expect(d.tick(d.t + 1000)).toEqual([]);
    expect(d.push(buildPose({ t: d.t + 2000 }))).toEqual([]);
    expect(d.skip()).toEqual([]);
    expect(d.stop()).toEqual([]);
    d.rr.pause(d.t + 3000);
    d.rr.resume(d.t + 4000);
    expect(d.tick(d.t + 5000)).toEqual([]);
  });

  it('세트 중 일시정지는 SetRunner에 전달된다(멈춘 동안 반복을 세지 않음)', () => {
    const d = runner([sq(1, 3, 10)]);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1)]);
    d.rr.pause(d.t);
    d.frames('squat', reps(175, 90, 2));
    d.rr.resume(d.t);
    const repCounts = ofType(d.log, 'set').flatMap((x) => (x.ev.event.type === 'rep' ? [x.ev.event.count] : []));
    expect(repCounts).toEqual([1]);
  });
});

describe('RoutineRunner: 쉬는 시간 건너뛰기 skipRest', () => {
  it('60초 쉬는 시간 10초에 skipRest → restEnd → 다음 세트 → 끝까지 하면 completed true, restTakenMs는 실제 쉰 시간', () => {
    const d = runner([sq(2, 2, 60), pu(1, 2, 60)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 10000);
    d.t = t0 + 10000;
    expect(d.rr.skipRest(d.t)).toEqual([{ type: 'restEnd' }]);
    expect(d.rr.phase).toBe('set');
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 1 });
    d.doSet('squat', 2);
    // 운동 사이 쉬는 시간을 건너뛰면 restEnd 뒤 exerciseStart
    d.t += 2000;
    expect(d.rr.skipRest(d.t)).toEqual([{ type: 'restEnd' }, { type: 'exerciseStart', exerciseIndex: 1, exercise: 'pushup' }]);
    d.doSet('pushup', 2);
    const s = sessionOf(d.log);
    expect(s.completed).toBe(true);
    expect(s.sets).toHaveLength(3);
    const fins = d.log.filter((x) => isSetFinished(x.ev));
    const starts = d.log.filter((x) => isSet('start')(x.ev));
    for (let i = 1; i < 3; i++) expect(s.sets[i]!.restTakenMs).toBe(starts[i]!.t - fins[i - 1]!.t);
    expect(s.sets[1]!.restTakenMs!).toBeLessThan(60000);
  });

  it('쉬는 시간이 아니면 skipRest는 []이고 아무것도 바뀌지 않는다', () => {
    const d = runner([sq(2, 2, 60)]);
    d.frames('squat', hold(175, 500));
    expect(d.rr.skipRest(d.t)).toEqual([]);
    expect(d.rr.phase).toBe('set');
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 0 });
    d.doSet('squat', 2);
    d.tickUntilRestEnd(1000);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('done');
    expect(d.rr.skipRest(d.t + 1000)).toEqual([]);
    expect(sessionOf(d.log).completed).toBe(true);
  });
});

describe('RoutineRunner: 일시정지 중 건너뛰기', () => {
  it('pause → skipExercise → 일시정지가 풀리고 다음 운동 세트가 push로 진행된다', () => {
    const d = runner([sq(2, 3, 10), pu(1, 2, 10)]);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1), ...hold(175, 2000)]);
    d.rr.pause(d.t);
    d.t += 3000;
    d.skip();
    expect(d.rr.current).toEqual({ exerciseIndex: 1, setIndex: 0 });
    d.doSet('pushup', 2);
    const pushSets = ofType(d.log, 'set').filter((x) => x.ev.exerciseIndex === 1).map((x) => x.ev.event.type);
    expect(pushSets).toEqual(['start', 'rep', 'rep', 'goalReached', 'finished']);
    const s = sessionOf(d.log);
    expect(s.sets.map((x) => [x.exercise, x.endReason])).toEqual([
      ['squat', 'manual'],
      ['pushup', 'target'],
    ]);
  });

  it('쉬는 시간 일시정지 중 skipRest도 일시정지를 풀고 다음 세트가 진행된다', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    d.rr.pause(d.t);
    d.t += 5000;
    expect(d.rr.skipRest(d.t)).toEqual([{ type: 'restEnd' }]);
    d.doSet('squat', 2);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(2);
    expect(s.completed).toBe(true);
  });

  it('일시정지 중 stop은 그대로 routineEnd', () => {
    const d = runner([sq(2, 3, 10)]);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1), ...hold(175, 2000)]);
    d.rr.pause(d.t);
    d.t += 3000;
    expect(d.stop().at(-1)!.type).toBe('routineEnd');
    expect(sessionOf(d.log).completed).toBe(false);
  });
});

describe('RoutineRunner.paused', () => {
  it('세트 중 pause → true → resume → false', () => {
    const d = runner([sq(2, 2, 30)]);
    d.frames('squat', hold(175, 500));
    expect(d.rr.paused).toBe(false);
    d.rr.pause(d.t);
    expect(d.rr.paused).toBe(true);
    d.rr.resume(d.t + 1000);
    expect(d.rr.paused).toBe(false);
  });

  it('쉬는 시간 중 pause → true, skipRest로 풀리면 false', () => {
    const d = runner([sq(2, 2, 30)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    d.rr.pause(d.t);
    expect(d.rr.paused).toBe(true);
    d.rr.skipRest(d.t + 1000);
    expect(d.rr.phase).toBe('set');
    expect(d.rr.paused).toBe(false);
  });

  it('skipExercise로 일시정지가 풀리면 false', () => {
    const d = runner([sq(2, 2, 30), pu(1, 2, 30)]);
    d.frames('squat', hold(175, 500));
    d.rr.pause(d.t);
    d.t += 1000;
    d.skip();
    expect(d.rr.paused).toBe(false);
  });

  it('일시정지 중 stop으로 routineEnd가 나면 false', () => {
    const d = runner([sq(2, 2, 30)]);
    d.frames('squat', hold(175, 500));
    d.rr.pause(d.t);
    d.t += 1000;
    d.stop();
    expect(d.rr.phase).toBe('done');
    expect(d.rr.paused).toBe(false);
  });
});

describe('RoutineRunner: 수정 1회차', () => {
  const dh = (sets: number, seconds: number, restSec: number): RoutineExercise => ({
    exercise: 'deadHang',
    sets,
    target: { kind: 'seconds', seconds },
    restSec,
  });
  /** 매달리기 프레임: hang이면 손목이 코 위(매달림), 아니면 손목이 코 아래 */
  function hangFrames(d: Driver, ms: number, hang: boolean): void {
    for (let i = 0; i < Math.ceil(ms / DT); i++) {
      d.push(buildPose({ t: d.t, elbow: 170, wristAboveNose: hang }));
      d.t += DT;
    }
  }

  describe('저장 시각은 toEpoch 시계 하나', () => {
    it('SetLog.startT·endT에도 toEpoch를 적용하고 restTakenMs는 그대로', () => {
      const E = 1_000_000;
      const d = runner([sq(2, 2, 3)], (t) => t + E);
      d.doSet('squat', 2);
      d.tickUntilRestEnd();
      d.doSet('squat', 2);
      const s = sessionOf(d.log);
      const fins = d.log.filter((x) => isSetFinished(x.ev));
      const starts = d.log.filter((x) => isSet('start')(x.ev));
      for (let i = 0; i < 2; i++) {
        expect(s.sets[i]!.startT).toBe(starts[i]!.t + E);
        expect(s.sets[i]!.endT).toBe(fins[i]!.t + E);
      }
      expect(s.sets[1]!.restTakenMs).toBe(starts[1]!.t - fins[0]!.t);
      expect(s.startedAt).toBe(E);
    });
  });

  describe('반복 시각 기록', () => {
    it('기록된 SetLog.reps 시각은 toEpoch(프레임 시각)', () => {
      const E = 5000;
      const d = runner([sq(1, 2, 3)], (t) => E + t);
      d.doSet('squat', 2);
      const s = sessionOf(d.log);
      const reps = s.sets[0]!.reps!;
      expect(reps).toHaveLength(2);
      expect(reps.map((x) => x.index)).toEqual([1, 2]);
      for (const x of reps) {
        expect(x.startT).toBeGreaterThanOrEqual(s.sets[0]!.startT);
        expect(x.startT).toBeLessThan(x.bottomT);
        expect(x.bottomT).toBeLessThan(x.endT);
        expect(x.endT).toBeLessThanOrEqual(s.sets[0]!.endT);
      }
      // 프레임 시계 원본과 비교: SetRunner 결과의 reps에 E를 더한 값
      const fin = d.log.find((x) => isSetFinished(x.ev))!.ev;
      const raw = fin.type === 'set' && fin.event.type === 'finished' ? fin.event.result.reps! : [];
      expect(reps).toEqual(raw.map((x) => ({ index: x.index, startT: E + x.startT, bottomT: E + x.bottomT, endT: E + x.endT })));
    });

    it('reps 필드가 없는 옛 세션 객체도 sessionSoFar·copy에서 깨지지 않는다', () => {
      const d = runner([sq(1, 2, 3)], (t) => 1_000_000 + t);
      d.doSet('squat', 2);
      const s = d.rr.sessionSoFar(d.t);
      delete (s.sets[0] as { reps?: unknown }).reps;
      expect(() => structuredClone(s)).not.toThrow();
      expect(d.rr.sessionSoFar(d.t).sets[0]!.reps).toHaveLength(2);
    });
  });

  describe('쉬는 시간의 다음 세트 정보', () => {
    it('스쿼트 → 푸시업 → 스쿼트: restStart.next, nextUp.exerciseIndex, SetLog.exerciseIndex', () => {
      const d = runner([sq(2, 2, 30), pu(1, 2, 30), sq(1, 2, 30)]);
      d.doSet('squat', 2);
      d.tickUntilRestEnd();
      d.doSet('squat', 2);
      d.tickUntilRestEnd();
      d.doSet('pushup', 2);
      d.tickUntilRestEnd();
      d.doSet('squat', 2);
      const R2 = { kind: 'reps', reps: 2 };
      expect(ofType(d.log, 'restStart').map((x) => x.ev)).toEqual([
        { type: 'restStart', seconds: 30, next: { exerciseIndex: 0, setIndex: 1, exercise: 'squat', target: R2 } },
        { type: 'restStart', seconds: 30, next: { exerciseIndex: 1, setIndex: 0, exercise: 'pushup', target: R2 } },
        { type: 'restStart', seconds: 30, next: { exerciseIndex: 2, setIndex: 0, exercise: 'squat', target: R2 } },
      ]);
      expect(ofType(d.log, 'nextUp').map((x) => [x.ev.exerciseIndex, x.ev.exercise, x.ev.setIndex])).toEqual([
        [0, 'squat', 1],
        [1, 'pushup', 0],
        [2, 'squat', 0],
      ]);
      const s = sessionOf(d.log);
      expect(s.sets.map((x) => [x.exerciseIndex, x.exercise, x.setIndex])).toEqual([
        [0, 'squat', 0],
        [0, 'squat', 1],
        [1, 'pushup', 0],
        [2, 'squat', 0],
      ]);
      expect(s.completed).toBe(true);
    });

    it('sets 0인 운동은 건너뛰고 restStart.next는 그다음 운동', () => {
      const d = runner([sq(1, 2, 30), pu(0, 2, 5), sq(1, 2, 25)]);
      d.doSet('squat', 2);
      const rs = ofType(d.log, 'restStart');
      expect(rs.map((x) => [x.ev.seconds, x.ev.next.exerciseIndex, x.ev.next.exercise])).toEqual([[25, 2, 'squat']]);
    });
  });

  describe('큰 tick 점프', () => {
    it('nextUp 전에 쉬는 시간 끝을 한 번에 지나가면 restEnd 바로 앞에서 nextUp을 낸다', () => {
      const d = runner([sq(2, 2, 60)]);
      d.doSet('squat', 2);
      const t0 = lastRestStartT(d);
      expect(d.tick(t0 + 70000)).toEqual([
        { type: 'nextUp', exerciseIndex: 0, exercise: 'squat', setIndex: 1, target: { kind: 'reps', reps: 2 } },
        { type: 'restEnd' },
      ]);
    });

    it('nextUp을 이미 냈으면 restEnd 앞에 다시 내지 않는다', () => {
      const d = runner([sq(2, 2, 60)]);
      d.doSet('squat', 2);
      const t0 = lastRestStartT(d);
      expect(d.tick(t0 + 45000).map((e) => e.type)).toEqual(['nextUp']);
      expect(d.tick(t0 + 70000)).toEqual([{ type: 'restEnd' }]);
    });
  });

  describe('sets가 정수가 아니면 내림', () => {
    it('sets 2.5 → 2세트로 끝나고 completed true', () => {
      const d = runner([sq(2.5, 2, 0)]);
      d.doSet('squat', 2);
      d.doSet('squat', 2);
      expect(d.rr.phase).toBe('done');
      const s = sessionOf(d.log);
      expect(s.sets).toHaveLength(2);
      expect(s.completed).toBe(true);
    });

    it('sets 0.5인 운동은 0세트로 건너뛴다(completed 판정 total에도 0)', () => {
      const d = runner([pu(0.5, 2, 0), sq(1, 2, 0)]);
      expect(d.rr.current).toEqual({ exerciseIndex: 1, setIndex: 0 });
      d.doSet('squat', 2);
      expect(sessionOf(d.log).completed).toBe(true);
    });
  });

  it('backToReady 뒤에도 같은 세트 번호를 유지한다', () => {
    const d = runner([sq(2, 2, 0)], undefined, { noStartMs: 2000 });
    d.doSet('squat', 2);
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 1 });
    // 두 번째 세트: 준비 자세 → start → 2초 동안 반복 없음 → backToReady
    d.frames('squat', hold(175, 4000), isSet('backToReady'));
    const btr = ofType(d.log, 'set').filter((x) => x.ev.event.type === 'backToReady');
    expect(btr.map((x) => [x.ev.exerciseIndex, x.ev.setIndex])).toEqual([[0, 1]]);
    expect(d.rr.current).toEqual({ exerciseIndex: 0, setIndex: 1 });
    expect(d.rr.phase).toBe('set');
    // 10.1(c): backToReady 뒤에는 준비 자세가 한 번 흐트러져야 다시 시작한다(다리가 안 보이는 400ms 이상).
    const hidden = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
    for (let i = 0; i < 16; i++, d.t += DT) d.push(buildPose({ t: d.t, knee: 175, hidden }));
    d.doSet('squat', 2);
    const s = sessionOf(d.log);
    expect(s.sets.map((x) => x.setIndex)).toEqual([0, 1]);
    expect(s.completed).toBe(true);
  });

  it('세트가 하나도 없는 루틴은 생성자에서 Error', () => {
    const make = (xs: RoutineExercise[]) => () => new RoutineRunner(routine(xs), { startT: 0, sessionId: 's' });
    expect(make([])).toThrow(Error);
    expect(make([sq(0, 2, 10), pu(0.5, 2, 10)])).toThrow(Error);
  });

  it('마지막 운동의 쉬는 시간 중 skipExercise → restEnd → routineEnd(completed false)', () => {
    const d = runner([sq(1, 2, 30), pu(2, 2, 30)]);
    d.doSet('squat', 2);
    d.tickUntilRestEnd();
    d.doSet('pushup', 2);
    expect(d.rr.phase).toBe('rest');
    expect(d.skip().map((e) => e.type)).toEqual(['restEnd', 'routineEnd']);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(2);
    expect(s.completed).toBe(false);
  });

  it('운동 사이 쉬는 시간의 skipExercise는 건너뛴 세트가 없어 completed에 영향이 없다', () => {
    const d = runner([sq(1, 2, 30), pu(1, 2, 30)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    expect(d.skip().map((e) => e.type)).toEqual(['restEnd', 'exerciseStart']);
    d.doSet('pushup', 2);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(2);
    expect(s.completed).toBe(true);
  });

  it('같은 운동의 세트 사이 쉬는 시간의 skipExercise는 남은 세트를 건너뛰어 completed false', () => {
    const d = runner([sq(2, 2, 30), pu(1, 2, 30)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    d.skip();
    d.doSet('pushup', 2);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(2);
    expect(s.completed).toBe(false);
  });

  it('매달리기 세트를 skip하면 heldMs > 0으로 manual 기록', () => {
    const d = runner([dh(2, 60, 30), sq(1, 2, 30)]);
    hangFrames(d, 500, false);
    hangFrames(d, 3000, true);
    const evs = d.skip();
    expect(evs.map((e) => e.type)).toEqual(['set', 'exerciseStart']);
    d.doSet('squat', 2);
    const s = sessionOf(d.log);
    const h = s.sets[0]!;
    expect([h.exercise, h.exerciseIndex, h.count, h.endReason]).toEqual(['deadHang', 0, 0, 'manual']);
    expect(h.heldMs).toBeGreaterThan(2000);
  });

  it('매달리기 세트를 stop하면 heldMs > 0으로 manual 기록', () => {
    const d = runner([dh(2, 60, 30)]);
    hangFrames(d, 500, false);
    hangFrames(d, 3000, true);
    expect(d.stop().map((e) => e.type)).toEqual(['set', 'routineEnd']);
    const s = sessionOf(d.log);
    expect(s.sets).toHaveLength(1);
    expect(s.sets[0]!.heldMs).toBeGreaterThan(2000);
    expect(s.sets[0]!.endReason).toBe('manual');
    expect(s.completed).toBe(false);
  });
});

describe('RoutineRunner.snapshot · sessionSoFar (2b 작업 2)', () => {
  it('세트 중 snapshot: count는 센 반복 수, tracker.kind가 맞고 rest는 null', () => {
    const d = runner([sq(2, 5, 30)]);
    const before = d.rr.snapshot(0);
    expect(before.phase).toBe('set');
    expect(before.set).not.toBeNull();
    expect(before.set!.count).toBe(0);
    expect(before.set!.heldMs).toBe(0);
    expect(before.rest).toBeNull();

    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 2)]);
    const s = d.rr.snapshot(d.t);
    const repEvents = ofType(d.log, 'set').filter((x) => x.ev.event.type === 'rep');
    expect(repEvents).toHaveLength(2);
    expect(s.phase).toBe('set');
    expect(s.paused).toBe(false);
    expect(s.exerciseIndex).toBe(0);
    expect(s.setIndex).toBe(0);
    expect(s.set!.setPhase).toBe('active');
    expect(s.set!.count).toBe(2);
    expect(s.set!.heldMs).toBe(0);
    expect(s.set!.tracker.kind).toBe('reps');
    expect(s.set!.waitingForBreak).toBe(false);
  });

  it('60초 쉬는 시간 25초 뒤 remainingMs 35000, pause 10초 뒤에도 35000, resume 뒤 다시 줄어든다', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    const t0 = lastRestStartT(d);

    const a = d.rr.snapshot(t0 + 25000);
    expect(a.phase).toBe('rest');
    expect(a.set).toBeNull();
    expect(a.rest!.totalMs).toBe(60000);
    expect(a.rest!.remainingMs).toBe(35000);
    expect(a.rest!.next).toMatchObject({ exerciseIndex: 0, setIndex: 1, exercise: 'squat' });

    d.tick(t0 + 25000);
    d.rr.pause(t0 + 25000);
    const b = d.rr.snapshot(t0 + 35000);
    expect(b.paused).toBe(true);
    expect(b.rest!.remainingMs).toBe(35000);

    d.rr.resume(t0 + 35000);
    const c = d.rr.snapshot(t0 + 45000);
    expect(c.paused).toBe(false);
    expect(c.rest!.remainingMs).toBe(25000);
  });

  it('snapshot은 상태를 바꾸지 않는다: phase·이벤트 순서가 같다', () => {
    const run = (withSnapshots: boolean): string[] => {
      const d = runner([sq(2, 2, 3)]);
      const snap = () => {
        if (withSnapshots) {
          d.rr.snapshot(d.t + 100000);
          d.rr.snapshot(-5);
        }
      };
      snap();
      d.doSet('squat', 2);
      snap();
      const ph = d.rr.phase;
      d.tickUntilRestEnd();
      snap();
      d.doSet('squat', 2);
      snap();
      return [ph, ...d.log.map((x) => `${x.t}:${x.ev.type}`)];
    };
    expect(run(true)).toEqual(run(false));
  });

  it('t가 lastT보다 이르면 lastT 기준으로 계산한다', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 10000);
    const early = d.rr.snapshot(t0);
    expect(early.rest!.remainingMs).toBe(50000);
  });

  it('2세트 끝난 뒤 sessionSoFar: sets 2, completed false, id는 sessionId, 진행 중 세트는 제외, toEpoch 적용', () => {
    const d = runner([sq(3, 2, 3)], (t) => 1_000_000 + t);
    d.doSet('squat', 2);
    d.tickUntilRestEnd();
    d.doSet('squat', 2);
    d.tickUntilRestEnd();
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1)]); // 3번째 세트 진행 중
    const s = d.rr.sessionSoFar(d.t);
    expect(s.sets).toHaveLength(2);
    expect(s.completed).toBe(false);
    expect(s.id).toBe('s1');
    expect(s.routineId).toBe('r1');
    expect(s.startedAt).toBe(1_000_000);
    expect(s.endedAt).toBe(1_000_000 + d.t);
    expect(s.sets.map((x) => [x.exerciseIndex, x.setIndex])).toEqual([[0, 0], [0, 1]]);
    // 깊은 복사: 바꿔도 내부 기록이 안 바뀐다
    s.sets[0]!.count = 99;
    s.sets[0]!.target = { kind: 'reps', reps: 99 };
    s.sets[0]!.negativeDescentMs.push(1);
    expect(d.rr.sessionSoFar(d.t).sets[0]!.count).toBe(2);
    expect(d.rr.sessionSoFar(d.t).sets[0]!.target).toEqual({ kind: 'reps', reps: 2 });

    d.doSet('squat', 2);
    const end = sessionOf(d.log);
    expect(end.id).toBe(s.id);
    expect(end.sets).toHaveLength(3);
  });

  it('routineEnd 뒤 snapshot.phase는 done, sessionSoFar는 최종 세션의 복사본', () => {
    const d = runner([sq(1, 2, 3)]);
    d.doSet('squat', 2);
    const fin = sessionOf(d.log);
    const snap = d.rr.snapshot(d.t);
    expect(snap.phase).toBe('done');
    expect(snap.paused).toBe(false);
    expect(snap.set).toBeNull();
    expect(snap.rest).toBeNull();
    const s = d.rr.sessionSoFar(d.t + 99999);
    expect(s).toEqual(fin);
    expect(s).not.toBe(fin);
    expect(s.sets[0]).not.toBe(fin.sets[0]);
    expect(s.completed).toBe(true);
  });

  it('tick 큰 점프 뒤 남은 시간이 restEnd 시각과 맞는다(남은 1ms까지 restEnd 없음, 0에서 restEnd)', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 40000);
    expect(d.rr.snapshot(t0 + 40000).rest!.remainingMs).toBe(20000);
    d.tick(t0 + 59999);
    expect(d.rr.phase).toBe('rest');
    expect(d.rr.snapshot(t0 + 59999).rest!.remainingMs).toBe(1);
    const evs = d.tick(t0 + 60000);
    expect(evs.some((e) => e.type === 'restEnd')).toBe(true);
    expect(d.rr.snapshot(t0 + 60000).phase).toBe('set');
  });

  it('일시정지 → resume → tick 점프 뒤에도 남은 시간이 restEnd 시각과 맞는다', () => {
    const d = runner([sq(2, 2, 60)]);
    d.doSet('squat', 2);
    const t0 = lastRestStartT(d);
    d.tick(t0 + 20000);
    d.rr.pause(t0 + 20000);
    d.rr.resume(t0 + 50000); // 30초 멈춤
    expect(d.rr.snapshot(t0 + 60000).rest!.remainingMs).toBe(30000);
    d.tick(t0 + 89999);
    expect(d.rr.phase).toBe('rest');
    expect(d.rr.snapshot(t0 + 89999).rest!.remainingMs).toBe(1);
    const evs = d.tick(t0 + 90000);
    expect(evs.some((e) => e.type === 'restEnd')).toBe(true);
  });

  it('일시정지된 세트: paused true, setPhase 유지', () => {
    const d = runner([sq(2, 5, 30)]);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1)]);
    d.rr.pause(d.t);
    const s = d.rr.snapshot(d.t + 5000);
    expect(s.paused).toBe(true);
    expect(s.set!.setPhase).toBe('active');
    expect(s.set!.count).toBe(1);
  });

  it('countdown 중 countdownRemainingMs는 남은 ms, 일시정지하면 멈추고, 그 밖에는 null', () => {
    const d = runner([sq(1, 5, 30)], undefined, { countdownMs: 3000 });
    expect(d.rr.snapshot(0).set!.countdownRemainingMs).toBeNull();
    d.frames('squat', hold(175, 6000), (e) => e.type === 'set' && e.event.type === 'countdown');
    const t3 = ofType(d.log, 'set').find((x) => x.ev.event.type === 'countdown')!.t;
    const a = d.rr.snapshot(t3);
    expect(a.set!.setPhase).toBe('countdown');
    expect(a.set!.count).toBe(0);
    expect(a.set!.countdownRemainingMs).toBe(3000);
    expect(d.rr.snapshot(t3 + 1000).set!.countdownRemainingMs).toBe(2000);
    d.rr.pause(t3 + 1000);
    expect(d.rr.snapshot(t3 + 9000).set!.countdownRemainingMs).toBe(2000);
    d.rr.resume(t3 + 9000);
    expect(d.rr.snapshot(t3 + 10000).set!.countdownRemainingMs).toBe(1000);
  });

  it('backToReady 뒤 waitingReady(waitingForBreak)에서 count는 0', () => {
    const d = runner([sq(1, 5, 30)]);
    d.frames('squat', hold(175, 25000), (e) => e.type === 'set' && e.event.type === 'backToReady');
    expect(ofType(d.log, 'set').some((x) => x.ev.event.type === 'backToReady')).toBe(true);
    const s = d.rr.snapshot(d.t);
    expect(s.set!.setPhase).toBe('waitingReady');
    expect(s.set!.waitingForBreak).toBe(true);
    expect(s.set!.count).toBe(0);
    expect(s.set!.countdownRemainingMs).toBeNull();
  });

  it('매달리기 세트의 snapshot.heldMs는 트래커 heldMs와 같다', () => {
    const rr = new RoutineRunner(
      routine([{ exercise: 'deadHang', sets: 1, target: { kind: 'seconds', seconds: 30 }, restSec: 0 }]),
      { startT: 0, sessionId: 's1' },
    );
    let t = 0;
    for (let i = 0; i < 120; i++, t += DT) rr.push(buildPose({ elbow: 170, wristAboveNose: true, t }));
    const s = rr.snapshot(t);
    expect(s.set!.tracker.kind).toBe('hold');
    expect(s.set!.count).toBe(0);
    expect(s.set!.heldMs).toBeGreaterThan(2000);
    expect(s.set!.heldMs).toBe((s.set!.tracker as { heldMs: number }).heldMs);
  });

  it('sessionSoFar의 endedAt은 toEpoch(max(t, lastT))', () => {
    const d = runner([sq(2, 2, 30)], (t) => 1_000_000 + t);
    d.doSet('squat', 2);
    const lastT = d.t - DT;
    expect(d.rr.sessionSoFar(0).endedAt).toBe(1_000_000 + lastT);
    expect(d.rr.sessionSoFar(lastT + 500).endedAt).toBe(1_000_000 + lastT + 500);
  });
});

describe('RoutineRunner.endSet (세트 끝 버튼)', () => {
  // 앱은 idle 자동 종료를 끈다(idleEndMs: Infinity). 세트는 목표 도달이나 endSet으로만 끝난다.
  const noIdle = { idleEndMs: Infinity };

  it('세트 중 반복 2회 뒤 endSet: button으로 기록하고 쉬는 시간으로 간다. 끝까지 하면 completed true', () => {
    const d = runner([sq(2, 5, 10)], undefined, noIdle);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 2), ...hold(175, 3000)]);
    const evs = d.rr.endSet(d.t);
    expect(evs.map((e) => (e.type === 'set' ? `set:${e.event.type}` : e.type))).toEqual([
      'set:finished',
      'restStart',
      'nextUp',
    ]);
    expect(d.rr.phase).toBe('rest');
    d.log.push(...evs.map((ev) => ({ t: d.t, ev })));
    d.tickUntilRestEnd();
    d.doSet('squat', 5);
    const s = sessionOf(d.log);
    expect(s.completed).toBe(true);
    expect(s.sets.map((x) => [x.setIndex, x.count, x.endReason])).toEqual([
      [0, 2, 'button'],
      [1, 5, 'target'],
    ]);
  });

  it('idle 자동 종료를 끄면 마지막 반복 뒤 오래 서 있어도 세트가 끝나지 않는다', () => {
    const d = runner([sq(1, 5, 10)], undefined, noIdle);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 2), ...hold(175, 30000)]);
    expect(d.log.some((x) => isSetFinished(x.ev))).toBe(false);
    expect(d.rr.snapshot(d.t).set?.count).toBe(2);
  });

  it('마지막 세트에서 endSet이면 routineEnd(completed true)', () => {
    const d = runner([sq(1, 5, 10)], undefined, noIdle);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 3), ...hold(175, 3000)]);
    const evs = d.rr.endSet(d.t);
    expect(evs.at(-1)!.type).toBe('routineEnd');
    const s = (evs.at(-1) as Extract<RoutineEvent, { type: 'routineEnd' }>).session;
    expect(s.completed).toBe(true);
    expect(s.sets.map((x) => x.count)).toEqual([3]);
  });

  it('반복이 0이면(버튼 누르며 센 반복을 되돌린 경우 포함) 기록하지 않고 쉬는 시간으로 간다', () => {
    const d = runner([sq(2, 5, 10)], undefined, noIdle);
    d.frames('squat', [...hold(175, 1000), ...reps(175, 90, 1)]);
    // 마지막 반복 직후(1.5초 안) 버튼: 그 반복은 버튼을 누르러 오며 센 것으로 보고 되돌린다.
    const evs = d.rr.endSet(d.t);
    expect(evs.map((e) => e.type)).toEqual(['set', 'restStart', 'nextUp']);
    expect(d.rr.sessionSoFar(d.t).sets).toEqual([]);
  });

  it('세트가 시작되기 전(준비 자세 대기)이나 쉬는 시간에는 []이고 아무것도 바뀌지 않는다', () => {
    const d = runner([sq(2, 2, 10)], undefined, noIdle);
    d.frames('squat', hold(175, 300));
    expect(d.rr.endSet(d.t)).toEqual([]);
    expect(d.rr.snapshot(d.t).set?.setPhase).toBe('waitingReady');
    d.doSet('squat', 2);
    expect(d.rr.phase).toBe('rest');
    expect(d.rr.endSet(d.t + 100)).toEqual([]);
    expect(d.rr.phase).toBe('rest');
  });
});
