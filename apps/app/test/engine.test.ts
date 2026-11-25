import { createElement, StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineRunner, type PoseFrame, type Routine, type RoutineEvent, type RoutineExercise } from '@wom/core';
import { buildPose } from '../../../packages/core/test/helpers/poseBuilder';
import { WorkoutEngine, type EngineDeps, type EngineView } from '../src/workout/engine';
import { useWorkout } from '../src/workout/useWorkout';
import { CameraError, type PoseSource } from '../src/ports/pose';
import type { Speech } from '../src/ports/speech';
import type { Storage } from '../src/ports/storage';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import type { SetCapture } from '../src/form/setCapture';

const DT = 33;
const EPOCH = 1_700_000_000_000;
const T0 = 1000;

// ---- 프레임 열(코어 routineRunner.test.ts와 같은 방식) ----
function lin(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / n);
}
function oneRep(rest: number, bottom: number, n = 15): number[] {
  return [...Array(5).fill(rest), ...lin(rest, bottom, n), ...Array(3).fill(bottom), ...lin(bottom, rest, n), ...Array(5).fill(rest)];
}
const hold = (v: number, ms: number): number[] => Array(Math.ceil(ms / DT)).fill(v);
const reps = (k: number): number[] => Array.from({ length: k }, () => oneRep(175, 90)).flat();

function routine(exercises: RoutineExercise[]): Routine {
  return { id: 'r1', name: '루틴 1', order: 0, exercises, createdAt: 0, updatedAt: 0 };
}
const sq = (sets: number, n: number, restSec: number): RoutineExercise => ({
  exercise: 'squat',
  sets,
  target: { kind: 'reps', reps: n },
  restSec,
});
const pu = (sets: number, n: number, restSec: number): RoutineExercise => ({
  exercise: 'pushup',
  sets,
  target: { kind: 'reps', reps: n },
  restSec,
});

const isSetFinished = (e: RoutineEvent) => e.type === 'set' && e.event.type === 'finished';
const isRep = (count: number) => (e: RoutineEvent) => e.type === 'set' && e.event.type === 'rep' && e.event.count === count;

class FakePose implements PoseSource {
  delegate: 'GPU' | 'CPU' | null = null;
  startError: unknown = null;
  /** 설정하면 start가 이 promise를 기다린다 */
  gate: Promise<void> | null = null;
  starts = 0;
  stops = 0;
  private readonly cbs = new Set<(f: PoseFrame) => void>();
  constructor(private readonly calls: string[]) {}
  async start(_video: HTMLVideoElement): Promise<void> {
    this.calls.push('pose.start');
    this.starts++;
    if (this.gate) await this.gate;
    if (this.startError) throw this.startError;
  }
  stop(): void {
    this.calls.push('pose.stop');
    this.stops++;
  }
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

function makeRig(exercises: RoutineExercise[], opts: { speech?: Speech; storage?: Storage } = {}) {
  let t = T0;
  const calls: string[] = [];
  const spoken: string[] = [];
  const speech: Speech = opts.speech ?? {
    speak: async (s) => {
      spoken.push(s);
      return 'ok';
    },
    cancel() {},
  };
  const intervals = new Map<number, Interval>();
  let nextH = 1;
  const keepAwake = {
    on: vi.fn(async () => {
      calls.push('keepAwake.on');
    }),
    off: vi.fn(async () => {
      calls.push('keepAwake.off');
    }),
  };
  const pose = new FakePose(calls);
  const storage = opts.storage ?? createMemoryStorage();
  let idN = 0;
  const deps: EngineDeps = {
    routine: routine(exercises),
    pose,
    speech,
    keepAwake,
    storage,
    now: () => t,
    epochOffset: EPOCH,
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
  /** 엔진이 알린 모든 view와, 그 lastEvents를 이어 붙인 이벤트 기록 */
  const views: EngineView[] = [];
  const events: RoutineEvent[] = [];
  const rig = {
    deps,
    pose,
    spoken,
    keepAwake,
    storage,
    intervals,
    calls,
    views,
    events,
    get t() {
      return t;
    },
    get last(): EngineView {
      return views.at(-1)!;
    },
    attach(e: WorkoutEngine) {
      return e.subscribe((v) => {
        views.push(v);
        events.push(...v.lastEvents);
      });
    },
    /** 시계를 ms만큼 흘리며 때가 된 interval을 부른다 */
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
    /** DT만큼 시계를 흘린 뒤 무릎 각도 knee인 프레임을 보낸다 */
    frame(knee: number) {
      rig.advance(DT);
      pose.emit(buildPose({ t, knee }));
    },
    /** 각도 열을 넣다가 stopOn 이벤트가 나오면 멈춘다. 나왔는지 돌려준다 */
    frames(values: number[], stopOn?: (e: RoutineEvent) => boolean): boolean {
      const mark = events.length;
      for (const v of values) {
        rig.frame(v);
        if (stopOn && events.slice(mark).some(stopOn)) return true;
      }
      return false;
    },
    /** 준비 자세 1초 + 카운트다운 3초 + k회, 세트가 끝날 때까지 */
    doSet(k: number): boolean {
      return rig.frames([...hold(175, 1000), ...hold(175, 3500), ...reps(k), ...hold(175, 7000)], isSetFinished);
    },
  };
  return rig;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const video = () => document.createElement('video');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkoutEngine: 음성 안내', () => {
  it('가짜 프레임으로 squat 1세트를 하면 "셋", "둘", "하나", "시작", "하나", "둘" 순서로 말한다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.doSet(2)).toBe(true);
    expect(r.spoken[0]).toBe('스쿼트, 1세트');
    // 한 호출의 문구는 ", "로 이어 한 번에 말하므로 나눠서 본다
    const words = r.spoken.flatMap((s) => s.split(', ')).filter((s) => ['셋', '둘', '하나', '시작'].includes(s));
    expect(words).toEqual(['셋', '둘', '하나', '시작', '하나', '둘']);
  });

  it('목표 도달 묶음(한 번의 push)은 speak 한 번으로 "둘, 목표 달성, 세트 끝, 쉬는 시간 60초"를 말한다', async () => {
    const r = makeRig([sq(2, 2, 60)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.doSet(2)).toBe(true);
    expect(r.spoken).toContain('둘, 목표 달성, 세트 끝, 쉬는 시간 60초');
    expect(r.spoken).not.toContain('쉬는 시간 60초');
  });

  it('마지막 세트의 목표 도달은 "둘, 목표 달성, 세트 끝, 루틴 완료, 수고했어요"를 한 번에 말한다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    expect(r.spoken.at(-1)).toBe('둘, 목표 달성, 세트 끝, 루틴 완료, 수고했어요');
  });

  it('문구가 없는 호출(이벤트 없는 tick)에서는 speak를 부르지 않는다', async () => {
    const speak = vi.fn(async () => 'ok' as const);
    const r = makeRig([sq(1, 2, 0)], { speech: { speak, cancel() {} } });
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.frame(175); // exerciseStart
    expect(speak).toHaveBeenCalledTimes(1);
    r.advance(200 - DT); // 이벤트 없는 tick
    expect(r.last.lastEvents).toEqual([]);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unsupported를 돌려줄 때', (): Speech => ({ speak: async () => 'unsupported', cancel() {} })],
    ['reject할 때', (): Speech => ({ speak: () => Promise.reject(new Error('tts 실패')), cancel() {} })],
    [
      '동기로 throw할 때',
      (): Speech => ({
        speak: () => {
          throw new Error('tts 없음');
        },
        cancel() {},
      }),
    ],
  ])('speech.speak가 %s도 세트가 끝까지 진행된다', async (_name, mk) => {
    const r = makeRig([sq(1, 2, 0)], { speech: mk() });
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.doSet(2)).toBe(true);
    await flush();
    expect(r.last.ended?.completed).toBe(true);
    expect(r.last.ended?.sets[0]?.count).toBe(2);
  });
});

describe('WorkoutEngine: 저장', () => {
  it('세트가 끝날 때마다 같은 id 세션을 덮어쓰고, routineEnd에 completed true로 끝난다', async () => {
    const r = makeRig([sq(2, 2, 1)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    await flush();
    let all = await r.storage.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 's1', routineId: 'r1', completed: false, startedAt: T0 + EPOCH });
    expect(all[0]!.sets).toHaveLength(1);

    r.advance(1200); // 쉬는 시간 1초를 tick으로
    r.doSet(2);
    await flush();
    all = await r.storage.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('s1');
    expect(all[0]!.sets).toHaveLength(2);
    expect(all[0]!.completed).toBe(true);
  });

  it('routineEnd면 ended를 설정하고 completed true 세션을 저장한 뒤 interval·프레임 구독·카메라·화면 켜짐을 정리한다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.intervals.size).toBe(1);
    expect(r.pose.listeners).toBe(1);
    r.doSet(2);
    await flush();
    expect(r.last.ended).toMatchObject({ id: 's1', completed: true });
    expect(r.last.phase).toBe('done');
    expect(r.last.lastEvents.some((x) => x.type === 'routineEnd')).toBe(true);
    expect(await r.storage.getSession('s1')).toMatchObject({ completed: true });
    expect(r.intervals.size).toBe(0);
    expect(r.pose.listeners).toBe(0);
    expect(r.pose.stops).toBe(1);
    expect(r.keepAwake.off).toHaveBeenCalledTimes(1);
    expect(r.spoken.at(-1)?.endsWith('루틴 완료, 수고했어요')).toBe(true);
  });

  it('세트 하나 뒤 dispose(앱 꺼짐 흉내)하면 저장소에 sets 1, completed false 세션이 남는다', async () => {
    const r = makeRig([sq(2, 2, 30)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    await flush();
    e.dispose();
    await flush();
    const all = await r.storage.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 's1', completed: false });
    expect(all[0]!.sets).toHaveLength(1);
    // 정리만 했다: interval·구독·카메라·화면 켜짐
    expect(r.intervals.size).toBe(0);
    expect(r.pose.listeners).toBe(0);
    expect(r.pose.stops).toBe(1);
    expect(r.keepAwake.off).toHaveBeenCalledTimes(1);
    // dispose 뒤에는 더 알리지 않는다
    const n = r.views.length;
    r.advance(1000);
    expect(r.views.length).toBe(n);
  });

  it('반복 0으로 끝난 세트로 루틴이 끝나면(기록된 세트 0개) 중간 저장도 최종 저장도 하지 않는다', async () => {
    const r = makeRig([sq(2, 2, 30)]);
    const save = vi.spyOn(r.storage, 'saveSession');
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.frames(hold(175, 500));
    e.skipExercise(); // 반복 0인 세트 → routineEnd(다음 운동 없음)
    await flush();
    expect(save).not.toHaveBeenCalled();
    // Summary용 ended는 그대로 설정한다
    expect(r.last.ended).toMatchObject({ completed: false, sets: [] });
  });

  it('카메라를 켜기 전에 그만해도 빈 세션을 저장하지 않는다', async () => {
    const r = makeRig([sq(2, 2, 30)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.stop();
    expect(r.last.ended).not.toBeNull();
    expect(await r.storage.listSessions()).toHaveLength(0);
  });

  it('세트 하나 뒤 그만하면 completed false 세션을 저장한다', async () => {
    const r = makeRig([sq(2, 2, 30)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    await e.stop();
    const all = await r.storage.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ completed: false });
    expect(all[0]!.sets).toHaveLength(1);
  });

  it('저장이 실패해도 엔진은 멈추지 않고 console.warn만 남긴다', async () => {
    const storage = createMemoryStorage();
    storage.saveSession = () => Promise.reject(new Error('디스크 가득'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = makeRig([sq(2, 2, 1)], { storage });
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    await flush();
    r.advance(1200);
    expect(r.last.phase).toBe('set');
    expect(r.last.setIndex).toBe(1);
    r.doSet(2);
    await flush();
    expect(r.last.ended?.completed).toBe(true);
    expect(warn).toHaveBeenCalled();
    await expect(e.stop()).resolves.toBeUndefined();
  });
});

describe('WorkoutEngine: visibility(10.1 결정)', () => {
  it('세트 중 hidden이면 paused가 되고, visible로 돌아와도 자동 재개하지 않으며, resume 뒤에도 세트가 저절로 끝나지 않는다', async () => {
    const r = makeRig([sq(1, 5, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.frames([...hold(175, 1000), ...hold(175, 3500), ...reps(5)], isRep(1))).toBe(true);
    e.onVisibilityChange(true);
    expect(r.last.paused).toBe(true);
    e.onVisibilityChange(false);
    expect(r.last.paused).toBe(true);
    r.advance(30000); // 앱이 가려진 동안(프레임 없음, tick만)
    expect(r.events.some(isSetFinished)).toBe(false);
    expect(r.last.paused).toBe(true);
    e.resume();
    expect(r.last.paused).toBe(false);
    // 세트는 목표 도달이나 세트 끝 버튼으로만 끝난다(idle 자동 종료 없음)
    expect(r.frames(hold(175, 15000), isSetFinished)).toBe(false);
  });

  it('쉬는 시간 중 hidden이면 남은 시간이 멈춘다', async () => {
    const r = makeRig([sq(2, 2, 10)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    expect(r.last.phase).toBe('rest');
    r.advance(2000);
    e.onVisibilityChange(true);
    expect(r.last.paused).toBe(true);
    const before = r.last.rest!.remainingMs;
    expect(before).toBeLessThan(10000);
    r.advance(60000);
    expect(r.last.phase).toBe('rest');
    expect(r.last.rest!.remainingMs).toBe(before);
  });

  it('이미 일시정지면 hidden이 상태를 바꾸지 않고, 카메라 시작 전·끝난 뒤에는 아무것도 하지 않는다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    const pause = vi.spyOn(RoutineRunner.prototype, 'pause');
    e.onVisibilityChange(true); // 시작 전
    expect(pause).not.toHaveBeenCalled();
    await e.start(video());
    e.pause();
    expect(pause).toHaveBeenCalledTimes(1);
    e.onVisibilityChange(true);
    expect(pause).toHaveBeenCalledTimes(1);
    e.resume();
    r.doSet(2);
    await flush();
    expect(r.last.ended).not.toBeNull();
    e.onVisibilityChange(true); // 끝난 뒤
    expect(pause).toHaveBeenCalledTimes(1);
  });
});

describe('WorkoutEngine: 카메라 오류', () => {
  it("pose.start가 CameraError('denied')를 던지면 cameraError가 'denied'이고 예외가 새지 않으며, 다시 start하면 null로 돌아간다", async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    r.pose.startError = new CameraError('denied');
    await expect(e.start(video())).resolves.toBeUndefined();
    expect(r.last.cameraError).toBe('denied');
    expect(r.calls).toEqual(['keepAwake.on', 'pose.start', 'keepAwake.off']);
    expect(r.intervals.size).toBe(0);
    expect(r.pose.listeners).toBe(0);

    r.pose.startError = null;
    await e.start(video());
    expect(r.last.cameraError).toBeNull();
    expect(r.intervals.size).toBe(1);
    expect(r.pose.listeners).toBe(1);
    expect(r.doSet(2)).toBe(true);
  });

  it.each([
    [new CameraError('notFound'), 'notFound'],
    [new Error('뭔가 이상함'), 'other'],
    ['문자열 예외', 'other'],
  ])('pose.start 예외 %s → cameraError %s', async (err, kind) => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    r.pose.startError = err;
    await e.start(video());
    expect(r.last.cameraError).toBe(kind);
    expect(r.keepAwake.off).toHaveBeenCalledTimes(1);
  });

  it('start가 끝나기 전에 dispose하면, start가 끝난 뒤 카메라·화면 켜짐을 정리하고 루프를 시작하지 않는다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    let open!: () => void;
    r.pose.gate = new Promise<void>((res) => (open = res));
    const p = e.start(video());
    await flush();
    e.dispose();
    open();
    await p;
    expect(r.intervals.size).toBe(0);
    expect(r.pose.listeners).toBe(0);
    expect(r.pose.stops).toBe(1);
    expect(r.calls.at(-1)).toBe('keepAwake.off');
  });

  it.each([
    ['stop', (e: WorkoutEngine) => e.stop()],
    ['마지막 운동의 skipExercise', (e: WorkoutEngine) => e.skipExercise()],
  ])('start가 끝나기 전에 %s로 루틴이 끝나면, start가 끝난 뒤 카메라·화면 켜짐을 정리하고 루프를 시작하지 않는다', async (_n, end) => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    let open!: () => void;
    r.pose.gate = new Promise<void>((res) => (open = res));
    const p = e.start(video());
    await flush();
    await end(e);
    expect(r.last.ended).not.toBeNull();
    open();
    await p;
    await flush();
    expect(r.intervals.size).toBe(0);
    expect(r.pose.listeners).toBe(0);
    expect(r.pose.stops).toBe(1);
    expect(r.calls.at(-1)).toBe('keepAwake.off');
    const n = r.views.length;
    r.advance(1000);
    expect(r.views.length).toBe(n);
  });

  it.each([
    ['dispose', (e: WorkoutEngine) => e.dispose()],
    ['stop', (e: WorkoutEngine) => void e.stop()],
  ])('keepAwake.on을 기다리는 중에 %s되면 pose.start를 부르지 않고 화면 켜짐만 끈다', async (_n, end) => {
    const r = makeRig([sq(1, 2, 0)]);
    let open!: () => void;
    r.keepAwake.on.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          r.calls.push('keepAwake.on');
          open = res;
        }),
    );
    const e = new WorkoutEngine(r.deps);
    const p = e.start(video());
    await flush();
    end(e);
    open();
    await p;
    await flush();
    expect(r.pose.starts).toBe(0);
    expect(r.calls).toEqual(['keepAwake.on', 'keepAwake.off']);
    expect(r.intervals.size).toBe(0);
  });

  it('dispose하면 speech.cancel을 부른다', async () => {
    const cancel = vi.fn();
    const r = makeRig([sq(1, 2, 0)], { speech: { speak: async () => 'ok', cancel } });
    const e = new WorkoutEngine(r.deps);
    await e.start(video());
    e.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('WorkoutEngine: 세트 끝 버튼', () => {
  it('마지막 반복 뒤 30초 서 있어도 세트가 끝나지 않고, endSet이면 "세트를 마칠게요, 2회, 쉬는 시간 60초"를 말하고 button으로 중간 저장한다', async () => {
    const r = makeRig([sq(2, 5, 60)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.frames([...hold(175, 1000), ...hold(175, 3500), ...reps(2)], isRep(2))).toBe(true);
    expect(r.frames(hold(175, 30000), isSetFinished)).toBe(false);
    expect(r.last.set?.count).toBe(2);
    e.endSet();
    await flush();
    expect(r.last.phase).toBe('rest');
    expect(r.spoken.at(-1)).toBe('세트를 마칠게요, 2회, 쉬는 시간 60초');
    const saved = await r.storage.getSession('s1');
    expect(saved?.sets.map((x) => [x.count, x.endReason])).toEqual([[2, 'button']]);
    e.dispose();
  });

  it('세트가 시작되기 전에는 endSet이 아무것도 하지 않는다', async () => {
    const r = makeRig([sq(2, 5, 60)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.frames(hold(175, 300));
    e.endSet();
    expect(r.last.phase).toBe('set');
    expect(r.last.set?.setPhase).toBe('waitingReady');
    e.dispose();
  });
});

describe('WorkoutEngine: 진행', () => {
  it('프레임이 없어도 interval tick만으로 쉬는 시간이 끝난다', async () => {
    const r = makeRig([sq(2, 2, 3)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    expect(r.last.phase).toBe('rest');
    expect(r.spoken.some((s) => s.split(', ').includes('쉬는 시간 3초'))).toBe(true);
    r.advance(3200);
    expect(r.events.some((x) => x.type === 'restEnd')).toBe(true);
    expect(r.last.phase).toBe('set');
    expect(r.last.setIndex).toBe(1);
  });

  it('skipRest·skipExercise·stop이 RoutineRunner의 같은 메서드를 부르고, stop은 저장이 끝날 때까지 기다린다', async () => {
    const skipRest = vi.spyOn(RoutineRunner.prototype, 'skipRest');
    const skipExercise = vi.spyOn(RoutineRunner.prototype, 'skipExercise');
    const stop = vi.spyOn(RoutineRunner.prototype, 'stop');
    const r = makeRig([sq(2, 2, 30), pu(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.doSet(2);
    expect(r.last.phase).toBe('rest');

    e.skipRest();
    expect(skipRest).toHaveBeenCalledWith(r.t);
    expect(r.last.phase).toBe('set');
    expect(r.last.setIndex).toBe(1);

    e.skipExercise();
    expect(skipExercise).toHaveBeenCalledWith(r.t);
    expect(r.last.exerciseIndex).toBe(1);

    await e.stop();
    expect(stop).toHaveBeenCalledWith(r.t);
    expect(r.last.ended).toMatchObject({ id: 's1', completed: false });
    // flush 없이도 저장돼 있다
    expect(await r.storage.getSession('s1')).toMatchObject({ completed: false });
    expect(r.intervals.size).toBe(0);
    expect(r.keepAwake.off).toHaveBeenCalledTimes(1);
    expect(r.spoken.at(-1)).toBe('운동을 마쳤어요');
  });

  it('pause·resume 직후 알리고, tick은 이벤트가 없어도 알리며, 이벤트 없는 프레임은 알리지 않는다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    r.frame(175); // 첫 호출: exerciseStart
    expect(r.last.lastEvents.map((x) => x.type)).toEqual(['exerciseStart']);
    let n = r.views.length;
    r.frame(175);
    expect(r.views.length).toBe(n);
    r.advance(200 - DT); // 다음 tick까지
    expect(r.views.length).toBe(n + 1);
    expect(r.last.lastEvents).toEqual([]);
    n = r.views.length;
    e.pause();
    expect(r.views.length).toBe(n + 1);
    expect(r.last.paused).toBe(true);
    e.resume();
    expect(r.views.length).toBe(n + 2);
    expect(r.last.paused).toBe(false);
  });

  it('subscribe가 돌려준 함수로 구독을 끊는다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    const cb = vi.fn();
    const off = e.subscribe(cb);
    await e.start(video());
    r.advance(200);
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    off();
    r.advance(1000);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('useWorkout', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(document, 'hidden');
  });

  it('<StrictMode>에서도 살아 있는 엔진을 돌려주고 view가 갱신되며, visibilitychange로 pause하고, unmount하면 정리한다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    let out: ReturnType<typeof useWorkout> | null = null;
    function Probe({ deps }: { deps: EngineDeps }) {
      out = useWorkout(deps);
      return null;
    }
    const ui = render(createElement(StrictMode, null, createElement(Probe, { deps: r.deps })));
    const engine = out!.engine!;
    expect(engine).not.toBeNull();
    expect(out!.view?.phase).toBe('set');

    await act(async () => {
      await engine.start(video());
    });
    // 죽은(첫 mount의) 엔진이 아니라 살아 있는 엔진이 루프를 돌린다
    expect(r.intervals.size).toBe(1);
    expect(r.pose.listeners).toBe(1);
    act(() => r.advance(200));
    expect(out!.view?.lastEvents.map((x) => x.type)).toEqual(['exerciseStart']);
    expect(out!.engine).toBe(engine);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(out!.view?.paused).toBe(true);

    ui.unmount();
    expect(r.intervals.size).toBe(0);
    expect(r.pose.listeners).toBe(0);
    expect(r.keepAwake.off).toHaveBeenCalled();
  });
});

describe('WorkoutEngine: 세트 녹화(capture)', () => {
  function fakeCapture() {
    const log: string[] = [];
    const cap: SetCapture = {
      beginSession: vi.fn(async (s) => {
        log.push(`session:${s.sessionId}:${s.routineId}`);
      }),
      beginSet: vi.fn((ex: number, set: number) => {
        log.push(`begin:${ex}:${set}`);
      }),
      addFrame: vi.fn(() => {
        log.push('frame');
      }),
      endSet: vi.fn(async (keep?: boolean) => {
        log.push(`end:${keep ?? true}`);
        return null;
      }),
    };
    return { cap, log };
  }
  const noFrames = (log: string[]) => log.filter((l) => l !== 'frame');

  it('시작하면 beginSession을 한 번 부르고, 스쿼트 세트 start/finished에서 beginSet/endSet을 한 번씩 부른다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const { cap, log } = fakeCapture();
    const e = new WorkoutEngine({ ...r.deps, capture: cap });
    r.attach(e);
    await e.start(video());
    expect(r.doSet(2)).toBe(true);
    expect(noFrames(log)).toEqual(['session:s1:r1', 'begin:0:0', 'end:true']);
    // 세트 중 프레임은 epoch ms(t + epochOffset)로 넘어간다
    expect(vi.mocked(cap.addFrame).mock.calls.length).toBeGreaterThan(10);
    const [f, epochT] = vi.mocked(cap.addFrame).mock.calls[0]!;
    expect(epochT).toBe(f.t + EPOCH);
    e.dispose();
  });

  it('세트가 열려 있지 않은 때(카운트다운 전·쉬는 시간)의 프레임은 넘기지 않는다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const { cap, log } = fakeCapture();
    const e = new WorkoutEngine({ ...r.deps, capture: cap });
    await e.start(video());
    r.frames(hold(175, 1000));
    expect(log.filter((l) => l === 'frame')).toHaveLength(0);
    e.dispose();
  });

  it('푸시업 세트는 capture를 부르지 않는다(beginSession 제외)', async () => {
    const r = makeRig([pu(1, 2, 0)]);
    const { cap, log } = fakeCapture();
    const e = new WorkoutEngine({ ...r.deps, capture: cap });
    r.attach(e);
    await e.start(video());
    e.skipExercise();
    await flush();
    expect(noFrames(log).filter((l) => l.startsWith('begin') || l.startsWith('end'))).toEqual([]);
    expect(cap.beginSet).not.toHaveBeenCalled();
    expect(cap.endSet).not.toHaveBeenCalled();
    expect(cap.addFrame).not.toHaveBeenCalled();
    e.dispose();
  });

  it('세트 끝 버튼으로 끝난 반복 0 세트는 endSet(false)로 저장하지 않는다', async () => {
    const r = makeRig([sq(1, 5, 0)]);
    const { cap, log } = fakeCapture();
    const e = new WorkoutEngine({ ...r.deps, capture: cap });
    r.attach(e);
    await e.start(video());
    r.frames([...hold(175, 1000), ...hold(175, 3500)], (ev) => ev.type === 'set' && ev.event.type === 'start');
    expect(noFrames(log)).toContain('begin:0:0');
    e.endSet();
    await flush();
    expect(noFrames(log).filter((l) => l.startsWith('end'))).toEqual(['end:false']);
    e.dispose();
  });

  it('진행 중 세트에서 dispose하면 저장 없이 endSet(false)로 닫는다', async () => {
    const r = makeRig([sq(1, 5, 0)]);
    const { cap, log } = fakeCapture();
    const e = new WorkoutEngine({ ...r.deps, capture: cap });
    r.attach(e);
    await e.start(video());
    r.frames([...hold(175, 1000), ...hold(175, 3500)], (ev) => ev.type === 'set' && ev.event.type === 'start');
    e.dispose();
    expect(noFrames(log).filter((l) => l.startsWith('end'))).toEqual(['end:false']);
  });

  it('capture가 던지거나 reject해도 운동은 계속되고 경고만 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = makeRig([sq(1, 2, 0)]);
    const cap: SetCapture = {
      beginSession: () => Promise.reject(new Error('a')),
      beginSet: () => {
        throw new Error('b');
      },
      addFrame: () => {
        throw new Error('c');
      },
      endSet: () => Promise.reject(new Error('d')),
    };
    const e = new WorkoutEngine({ ...r.deps, capture: cap });
    r.attach(e);
    await e.start(video());
    expect(r.doSet(2)).toBe(true);
    await flush();
    expect(r.last.cameraError).toBeNull();
    expect(warn).toHaveBeenCalled();
    e.dispose();
  });

  it('capture가 없으면 지금과 똑같이 동작한다', async () => {
    const r = makeRig([sq(1, 2, 0)]);
    const e = new WorkoutEngine(r.deps);
    r.attach(e);
    await e.start(video());
    expect(r.doSet(2)).toBe(true);
    e.dispose();
  });
});
