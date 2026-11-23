import { RoutineRunner, type Routine, type RoutineEvent, type RoutineSnapshot, type WorkoutSession } from '@wom/core';
import { CameraError, type PoseSource } from '../ports/pose';
import type { Speech } from '../ports/speech';
import type { KeepAwake } from '../ports/keepAwake';
import type { Storage } from '../ports/storage';
import { phraseFor } from '../domain/phrases';

export type EngineDeps = {
  routine: Routine;
  pose: PoseSource;
  speech: Speech;
  keepAwake: KeepAwake;
  storage: Storage;
  /** PoseFrame.t와 같은 시계(브라우저에서는 performance.now) */
  now: () => number;
  /** now 시계를 epoch ms로 바꾸는 차이값(Date.now() - performance.now()) */
  epochOffset: number;
  newId: () => string;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
};

export type EngineView = RoutineSnapshot & {
  /** 이 알림을 만든 호출에서 나온 이벤트(없으면 []) */
  lastEvents: RoutineEvent[];
  cameraError: CameraError['kind'] | null;
  ended: WorkoutSession | null;
};

/** 프레임이 없을 때도 시간을 흘리는 tick 간격 */
const TICK_MS = 200;

/**
 * 카메라 자세 프레임을 RoutineRunner에 흘려 넣고, 음성·저장·화면 켜짐·일시정지를 묶는다.
 * - start: keepAwake.on → pose.start. 성공하면 프레임 구독과 TICK_MS interval을 시작한다.
 *   실패하면 cameraError에 담고 keepAwake.off. 예외는 밖으로 내보내지 않고, 다시 start할 수 있다.
 * - 한 호출(push·tick·버튼)에서 나온 문구를 ", "로 이어 speak 한 번으로 말한다(기다리지 않고 실패는 무시).
 *   음성 구현은 새 문구가 이전 문구를 끊으므로, 묶음 안의 문구가 서로 끊기지 않게 한다. 문구가 없으면 말하지 않는다.
 * - 반복이 있는 세트가 끝나면 sessionSoFar를 중간 저장하고, routineEnd면 정리한다.
 *   최종 세션은 기록된 세트가 있을 때만 저장한다(0세트로 그만하면 빈 미완료 세션을 남기지 않는다).
 *   저장은 순서대로 이어서 하고, 실패는 console.warn만 남긴다.
 * - dispose: 저장 없이 정리만 한다(앱 꺼짐 흉내. 중간 저장은 세트마다 이미 했다).
 */
export class WorkoutEngine {
  private readonly d: EngineDeps;
  private readonly runner: RoutineRunner;
  private readonly subs = new Set<(v: EngineView) => void>();

  private lastEvents: RoutineEvent[] = [];
  private cameraError: CameraError['kind'] | null = null;
  private ended: WorkoutSession | null = null;
  private disposed = false;

  /** 카메라·루프가 돌고 있다(keepAwake.on·pose.start 성공 뒤) */
  private live = false;
  private starting = false;
  private interval: unknown = null;
  private unsubFrame: (() => void) | null = null;
  /** 저장을 순서대로 잇는 사슬(늘 resolve한다) */
  private saving: Promise<void> = Promise.resolve();

  constructor(d: EngineDeps) {
    this.d = d;
    this.runner = new RoutineRunner(d.routine, {
      startT: d.now(),
      sessionId: d.newId(),
      toEpoch: (t) => t + d.epochOffset,
    });
  }

  /** 지금 화면용 상태 */
  view(): EngineView {
    return {
      ...this.runner.snapshot(this.d.now()),
      lastEvents: this.lastEvents,
      cameraError: this.cameraError,
      ended: this.ended,
    };
  }

  async start(video: HTMLVideoElement): Promise<void> {
    if (this.disposed || this.ended || this.live || this.starting) return;
    this.starting = true;
    this.cameraError = null;
    try {
      try {
        await this.d.keepAwake.on();
      } catch {
        // 화면 켜짐은 있으면 좋은 것. 실패해도 운동은 한다.
      }
      if (this.gone()) {
        // keepAwake.on을 기다리는 동안 dispose되거나 루틴이 끝났다: 카메라는 켜지 않는다.
        this.starting = false;
        await this.safeOff();
        return;
      }
      await this.d.pose.start(video);
    } catch (e) {
      this.starting = false;
      if (this.gone()) {
        void this.safeOff();
        return;
      }
      this.cameraError = e instanceof CameraError ? e.kind : 'other';
      await this.safeOff();
      this.notify([]);
      return;
    }
    this.starting = false;
    if (this.gone()) {
      // start를 기다리는 동안 dispose되거나 루틴이 끝났다(stop·마지막 skipExercise): 켜 둔 것을 끄고 루프는 시작하지 않는다.
      this.d.pose.stop();
      void this.safeOff();
      return;
    }
    this.live = true;
    this.unsubFrame = this.d.pose.onFrame((f) => {
      const evs = this.runner.push(f);
      if (evs.length > 0) void this.handle(evs);
    });
    this.interval = this.d.setInterval(() => {
      void this.handle(this.runner.tick(this.d.now()));
    }, TICK_MS);
    this.notify([]);
  }

  pause(): void {
    if (!this.canControl()) return;
    this.runner.pause(this.d.now());
    this.notify([]);
  }

  resume(): void {
    if (!this.canControl()) return;
    this.runner.resume(this.d.now());
    this.notify([]);
  }

  skipRest(): void {
    if (!this.canControl()) return;
    void this.handle(this.runner.skipRest(this.d.now()));
  }

  skipExercise(): void {
    if (!this.canControl()) return;
    void this.handle(this.runner.skipExercise(this.d.now()));
  }

  /** 루틴을 그만한다. routineEnd를 처리하고 저장이 끝날 때까지 기다린다 */
  async stop(): Promise<void> {
    if (!this.canControl()) {
      await this.saving;
      return;
    }
    await this.handle(this.runner.stop(this.d.now()));
  }

  /** hidden=true면 세트·쉬는 시간 중이고 아직 일시정지가 아닐 때 pause. false는 아무것도 하지 않는다(자동 재개 금지) */
  onVisibilityChange(hidden: boolean): void {
    if (!hidden || !this.live || !this.canControl()) return;
    const phase = this.runner.phase;
    if ((phase === 'set' || phase === 'rest') && !this.runner.paused) this.pause();
  }

  subscribe(cb: (v: EngineView) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  /** 저장 없이 정리만 한다. 여러 번 불러도 된다 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    try {
      this.d.speech.cancel();
    } catch {
      // 무시
    }
    this.subs.clear();
  }

  // ---- 내부 ----

  /** dispose됐거나 루틴이 끝났다 */
  private gone(): boolean {
    return this.disposed || this.ended !== null;
  }

  private canControl(): boolean {
    return !this.gone();
  }

  /** 한 호출에서 나온 이벤트를 처리한다: 음성 → 저장 → (끝이면) 정리 → 알림. 이 호출의 저장까지 기다리는 promise */
  private handle(evs: RoutineEvent[]): Promise<void> {
    let end: WorkoutSession | null = null;
    let saveMid = false;
    const texts: string[] = [];
    for (const e of evs) {
      const text = phraseFor(e, { routine: this.d.routine });
      if (text !== null) texts.push(text);
      if (e.type === 'set' && e.event.type === 'finished') {
        const r = e.event.result;
        if (r.count > 0 || r.heldMs > 0) saveMid = true;
      } else if (e.type === 'routineEnd') {
        end = e.session;
      }
    }
    if (texts.length > 0) this.say(texts.join(', '));
    if (end) {
      this.ended = end;
      if (end.sets.length > 0) this.save(end);
      this.teardown();
    } else if (saveMid) {
      this.save(this.runner.sessionSoFar(this.d.now()));
    }
    this.notify(evs);
    return this.saving;
  }

  private say(text: string): void {
    try {
      Promise.resolve(this.d.speech.speak(text)).catch(() => undefined);
    } catch {
      // 음성이 없어도 운동은 계속한다.
    }
  }

  private save(s: WorkoutSession): void {
    this.saving = this.saving
      .then(() => this.d.storage.saveSession(s))
      .catch((e: unknown) => {
        console.warn('운동 기록 저장 실패', e);
      });
  }

  /** interval·프레임 구독을 끊고 카메라·화면 켜짐을 끈다(켜져 있을 때만) */
  private teardown(): void {
    if (!this.live) return;
    this.live = false;
    if (this.interval !== null) this.d.clearInterval(this.interval);
    this.interval = null;
    this.unsubFrame?.();
    this.unsubFrame = null;
    this.d.pose.stop();
    void this.safeOff();
  }

  private async safeOff(): Promise<void> {
    try {
      await this.d.keepAwake.off();
    } catch {
      // 무시
    }
  }

  private notify(evs: RoutineEvent[]): void {
    if (this.disposed) return;
    this.lastEvents = evs;
    const v = this.view();
    for (const cb of [...this.subs]) cb(v);
  }
}
