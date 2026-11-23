import { vi } from 'vitest';
import type { PoseFrame } from '@wom/core';
import { buildPose } from '../../../packages/core/test/helpers/poseBuilder';
import type { PoseSource } from '../src/ports/pose';
import type { WorkoutFlowDeps } from '../src/workout/WorkoutFlow';

export const DT = 33;

export class FakePose implements PoseSource {
  delegate: 'GPU' | 'CPU' | null = null;
  startError: unknown = null;
  readonly videos: HTMLVideoElement[] = [];
  private readonly cbs = new Set<(f: PoseFrame) => void>();
  async start(video: HTMLVideoElement): Promise<void> {
    this.videos.push(video);
    if (this.startError) throw this.startError;
  }
  stop(): void {}
  onFrame(cb: (f: PoseFrame) => void): () => void {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }
  get listeners(): number {
    return this.cbs.size;
  }
  emit(f: PoseFrame): void {
    for (const cb of [...this.cbs]) cb(f);
  }
}

type Interval = { cb: () => void; ms: number; next: number };

/** WorkoutFlow에 넣을 가짜 deps와, 시계·프레임을 움직이는 도구 */
export function makeFakeWorkout() {
  let t = 1000;
  const pose = new FakePose();
  const intervals = new Map<number, Interval>();
  let nextH = 1;
  let idN = 0;
  const deps: WorkoutFlowDeps = {
    pose,
    speech: { speak: vi.fn(async () => 'ok' as const), cancel: vi.fn() },
    keepAwake: { on: vi.fn(async () => undefined), off: vi.fn(async () => undefined) },
    now: () => t,
    epochOffset: 1_700_000_000_000,
    newId: () => `s${++idN}`,
    setInterval: (cb, ms) => {
      const h = nextH++;
      intervals.set(h, { cb, ms, next: t + ms });
      return h;
    },
    clearInterval: (h) => {
      intervals.delete(h as number);
    },
  };
  const fw = {
    deps,
    pose,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let due: Interval | null = null;
        for (const iv of intervals.values()) if (iv.next <= end && (!due || iv.next < due.next)) due = iv;
        if (!due) break;
        t = due.next;
        due.next += due.ms;
        due.cb();
      }
      t = end;
    },
    frame(knee: number) {
      fw.advance(DT);
      pose.emit(buildPose({ t, knee }));
    },
    /** 준비 자세 1초 + 카운트다운 + k회, 그리고 세트가 끝날 때까지 프레임을 넣는다 */
    doSquatSet(k: number) {
      const values = [...hold(175, 1000), ...hold(175, 3500), ...reps(k), ...hold(175, 7000)];
      for (const v of values) fw.frame(v);
    },
  };
  return fw;
}

function lin(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / n);
}
function oneRep(rest: number, bottom: number, n = 15): number[] {
  return [...Array(5).fill(rest), ...lin(rest, bottom, n), ...Array(3).fill(bottom), ...lin(bottom, rest, n), ...Array(5).fill(rest)];
}
const hold = (v: number, ms: number): number[] => Array(Math.ceil(ms / DT)).fill(v);
const reps = (k: number): number[] => Array.from({ length: k }, () => oneRep(175, 90)).flat();


