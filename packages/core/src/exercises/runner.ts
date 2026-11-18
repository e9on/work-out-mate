import type { PoseFrame } from '../types';
import { Ema } from '../pose/signal';
import { RepCounter, type RepEvent } from '../counter/repCounter';
import { HoldTimer } from '../counter/holdTimer';
import { EMA_ALPHA, EXERCISES, type ExerciseId } from './definitions';

export { EXERCISES };
export type { ExerciseId, ExerciseDef } from './definitions';

export type TrackerState = { count: number; heldMs: number; paused: boolean; lastRep: RepEvent | null };

export type Tracker = {
  push(f: PoseFrame): TrackerState;
  state(): TrackerState;
};

/** 프레임이 올 때마다 push()가 그 자리에서 현재 상태를 돌려준다. 시간은 frame.t만 쓴다. */
export function createTracker(id: ExerciseId): Tracker {
  const def = EXERCISES[id];

  if (def.kind === 'hold') {
    const timer = new HoldTimer(def.hold);
    let paused = false;
    const state = (): TrackerState => ({ count: 0, heldMs: timer.heldMs, paused, lastRep: null });
    return {
      push(f) {
        const holding = def.holding(f);
        paused = holding === null;
        timer.update(f.t, holding);
        return state();
      },
      state,
    };
  }

  const counter = new RepCounter(def.rep);
  const ema = new Ema(EMA_ALPHA);
  let lastRep: RepEvent | null = null;
  const state = (): TrackerState => ({
    count: counter.count,
    heldMs: 0,
    paused: counter.phase === 'paused',
    lastRep,
  });
  return {
    push(f) {
      // NaN/Infinity가 Ema에 들어가면 이후 값이 영구히 NaN이 되므로 null로 바꿔 넣는다.
      const raw = def.signal(f);
      const safe = raw !== null && Number.isFinite(raw) ? raw : null;
      const ev = counter.update(f.t, ema.next(safe));
      if (ev) lastRep = ev;
      return state();
    },
    state,
  };
}

/** 녹화된 프레임을 createTracker와 같은 경로로 흘려보낸다(테스트용). */
export function replay(id: ExerciseId, frames: PoseFrame[]): TrackerState & { reps: RepEvent[] } {
  const def = EXERCISES[id];
  const tracker = createTracker(id);
  const reps: RepEvent[] = [];
  let prev: RepEvent | null = null;
  for (const f of frames) {
    const s = tracker.push(f);
    if (def.kind === 'reps' && s.lastRep && s.lastRep !== prev) {
      reps.push(s.lastRep);
      prev = s.lastRep;
    }
  }
  return { ...tracker.state(), reps };
}
