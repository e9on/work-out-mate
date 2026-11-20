import type { PoseFrame } from '../types';
import { Ema } from '../pose/signal';
import { RepCounter, type RepEvent } from '../counter/repCounter';
import { AdaptiveRepCounter } from '../counter/adaptiveRepCounter';
import { HoldTimer } from '../counter/holdTimer';
import { EMA_ALPHA, EXERCISES, type ExerciseDef, type ExerciseId } from './definitions';

export { EXERCISES };
export type { ExerciseId, StartMode, ExerciseDef, RepExerciseDef, FixedRepExerciseDef, AdaptiveRepExerciseDef, HoldExerciseDef } from './definitions';

/** 지금 프레임이 왜 안 세어지는지 / 어떻게 보정됐는지. 우선순위는 notVisible > notReady > calibratedByDefault. */
export type Diagnosis = 'ok' | 'notVisible' | 'notReady' | 'calibratedByDefault';

export type RepTrackerState = {
  kind: 'reps';
  count: number;
  lastRep: RepEvent | null;
  /** 준비 자세 보정 중이면 'calibrating'(신호가 끊겨도 유지) */
  phase: 'calibrating' | 'rest' | 'out' | 'turned' | 'paused';
  /** 준비 자세 기준값(도). 준비 자세 기준 운동이 보정을 마친 뒤에만 숫자, 그 외 null */
  baseline: number | null;
  diagnosis: Diagnosis;
};

export type HoldTrackerState = {
  kind: 'hold';
  heldMs: number;
  state: 'idle' | 'holding' | 'ended';
  diagnosis: Diagnosis;
};

export type TrackerState = RepTrackerState | HoldTrackerState;

type KindOf<I extends ExerciseId> = (typeof EXERCISES)[I]['kind'];
type StateOfKind<K extends 'reps' | 'hold'> = K extends 'reps' ? RepTrackerState : HoldTrackerState;
/** 운동 id에 맞는 상태 타입(id가 리터럴이면 좁혀지고, ExerciseId 전체면 유니온). */
export type StateFor<I extends ExerciseId> = StateOfKind<KindOf<I>>;

export type Tracker<S extends TrackerState = TrackerState> = {
  push(f: PoseFrame): S;
  state(): S;
};

/** 프레임이 올 때마다 push()가 그 자리에서 현재 상태를 돌려준다. 시간은 frame.t만 쓴다. */
export function createTracker<I extends ExerciseId>(id: I): Tracker<StateFor<I>>;
export function createTracker(id: ExerciseId): Tracker {
  const def: ExerciseDef = EXERCISES[id];

  if (def.kind === 'hold') {
    const timer = new HoldTimer(def.hold);
    let diagnosis: Diagnosis = 'ok';
    const state = (): HoldTrackerState => ({ kind: 'hold', heldMs: timer.heldMs, state: timer.state, diagnosis });
    return {
      push(f) {
        const holding = def.holding(f);
        diagnosis = holding === null ? 'notVisible' : 'ok';
        timer.update(f.t, holding);
        return state();
      },
      state,
    };
  }

  // 판정 전략에 따라 카운터를 하나만 만든다. 어느 쪽이든 count·phase는 같은 모양이다.
  const adaptive = def.mode === 'adaptive' ? new AdaptiveRepCounter(def.adaptive) : null;
  const fixed = def.mode === 'fixed' ? new RepCounter(def.rep) : null;
  const counter = adaptive ?? fixed;
  if (!counter) throw new Error(`알 수 없는 카운터 방식: ${id}`);
  const ema = new Ema(EMA_ALPHA);
  let lastRep: RepEvent | null = null;
  let seen: 'visible' | 'notVisible' | 'notReady' = 'visible';
  const diagnose = (): Diagnosis => {
    if (seen !== 'visible') return seen;
    const src = adaptive?.calibrationSource;
    return src === 'default' || src === 'observed' ? 'calibratedByDefault' : 'ok';
  };
  const state = (): RepTrackerState => ({
    kind: 'reps',
    count: counter.count,
    lastRep,
    phase: counter.phase,
    baseline: adaptive?.baseline ?? null,
    diagnosis: diagnose(),
  });
  return {
    push(f) {
      // NaN/Infinity가 Ema에 들어가면 이후 값이 영구히 NaN이 되므로 null로 바꿔 넣는다.
      const raw = def.signal(f);
      const safe = raw !== null && Number.isFinite(raw) ? raw : null;
      const s = ema.next(safe);
      // 준비 자세 확인은 보정 중에만 필요하다. 보정이 끝나면 프레임마다 계산하지 않는다.
      const ready = adaptive && def.mode === 'adaptive' && !adaptive.calibrated ? def.ready(f) : true;
      const ev = adaptive ? adaptive.update(f.t, s, ready) : fixed?.update(f.t, s) ?? null;
      if (ev) lastRep = ev;
      seen = safe === null ? 'notVisible' : adaptive && !adaptive.calibrated && ready === false ? 'notReady' : 'visible';
      return state();
    },
    state,
  };
}

export type ReplayResult<S extends TrackerState = TrackerState> = S & { reps: RepEvent[] };

/** 녹화된 프레임을 createTracker와 같은 경로로 흘려보낸다(테스트용). 버티기 운동의 reps는 빈 배열. */
export function replay<I extends ExerciseId>(id: I, frames: PoseFrame[]): ReplayResult<StateFor<I>>;
export function replay(id: ExerciseId, frames: PoseFrame[]): ReplayResult {
  const tracker = createTracker(id);
  const reps: RepEvent[] = [];
  let prev: RepEvent | null = null;
  for (const f of frames) {
    const s = tracker.push(f);
    if (s.kind === 'reps' && s.lastRep && s.lastRep !== prev) {
      reps.push(s.lastRep);
      prev = s.lastRep;
    }
  }
  return { ...tracker.state(), reps };
}
