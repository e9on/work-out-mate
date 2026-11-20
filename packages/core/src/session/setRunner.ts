import type { PoseFrame } from '../types';
import type { RepEvent } from '../counter/repCounter';
import {
  EXERCISES,
  createTracker,
  type Diagnosis,
  type ExerciseDef,
  type ExerciseId,
  type Tracker,
  type TrackerState,
} from '../exercises/runner';
import type { EndReason, SetResult, Target } from './model';

export type SetConfig = {
  exercise: ExerciseId;
  target: Target;
  /** 보정이 끝난 뒤 start까지(ms). 기본 3000. 시작 방식이 'calibrate'인 운동에만 쓴다 */
  countdownMs?: number;
  /** start 뒤 이 시간(ms) 동안 첫 반복이 없으면 준비 자세 대기로 돌아간다. 기본 20000 */
  noStartMs?: number;
  /** 그만하기 직전 이 시간(ms) 안에 확정된 반복은 되돌린다. 기본 1500 */
  undoBeforeStopMs?: number;
  /** 마지막 반복 뒤 이 시간(ms) 동안 반복이 없으면 세트를 끝낸다. 기본은 운동 정의의 idleEndMs */
  idleEndMs?: number;
  /** 같은 진단 hint를 다시 내기까지의 최소 간격(ms). 기본 10000. calibratedByDefault는 세트당 한 번만 */
  hintRepeatMs?: number;
};

export type SetPhase = 'waitingReady' | 'countdown' | 'active' | 'finished';

export type SetEvent =
  | { type: 'countdown'; n: 3 | 2 | 1 }
  | { type: 'start' }
  | { type: 'backToReady' }
  | { type: 'rep'; count: number }
  | { type: 'hold'; seconds: number }
  | { type: 'goalReached' }
  | { type: 'hint'; diagnosis: Exclude<Diagnosis, 'ok'> }
  | { type: 'finished'; reason: EndReason; result: SetResult };

/** 시작 자세가 이만큼 이어지면 시작(pullup). deadHang은 HoldTimer의 시작 판정을 그대로 쓴다 */
const START_POSE_MS = 300;
const COUNTDOWN_NS = [3, 2, 1] as const;

/**
 * 손 대지 않고 하는 세트 하나의 흐름(준비 자세 대기 → 카운트다운 → 운동 → 끝)을 다루는 상태 기계.
 * 프레임은 push(f), 프레임 없이 흐른 시간은 tick(t)로 넣는다. 시간은 f.t와 t(같은 시계)로만 본다.
 * 호출마다 그 사이에 일어난 이벤트를 일어난 순서대로 돌려준다. 음성 문구는 정하지 않는다.
 */
export class SetRunner {
  private readonly cfg: SetConfig;
  private readonly def: ExerciseDef;
  private readonly countdownMs: number;
  private readonly noStartMs: number;
  private readonly undoMs: number;
  private readonly idleEndMs: number;
  private readonly hintRepeatMs: number;

  private tr: Tracker;
  private ph: SetPhase = 'waitingReady';
  private res: SetResult | null = null;
  /** 지금까지 본 가장 늦은 시각. 이보다 이른 tick·push는 무시한다 */
  private lastT = -Infinity;
  /** 마지막으로 push된 프레임 시각. 일시정지만큼 뒤로 민다 */
  private lastFrameT = -Infinity;
  private pausedAt: number | null = null;
  /** 진단별 마지막 hint 시각 */
  private readonly hintAt = new Map<Diagnosis, number>();

  /** pullup 시작 자세가 처음 true였던 시각 */
  private poseSince: number | null = null;
  /** 카운트다운 기준 시각(들어간 시각). 일시정지만큼 뒤로 민다 */
  private countdownT0 = 0;
  private countdownNext = 0;

  private startT = 0;
  /** 마지막으로 본 트래커 RepEvent. start 때 그 시점 값으로 맞춰 그 전에 확정된 반복은 세지 않는다 */
  private prevRep: RepEvent | null = null;
  /** start 뒤 확정된 반복. 길이 = 트래커 count - start 시점 count(baseCount) */
  private reps: RepEvent[] = [];
  /** idle·noStart 판정 기준 시각(마지막 반복 확정 또는 start). 일시정지만큼 뒤로 민다 */
  private idleFrom = 0;
  private holdSecs = 0;
  private goalSent = false;
  /** active 중 일시정지한 시간 합. HoldTimer는 일시정지를 모르므로 heldMs에서 뺀다 */
  private pausedInActiveMs = 0;

  constructor(cfg: SetConfig) {
    this.def = EXERCISES[cfg.exercise];
    this.cfg = cfg;
    this.countdownMs = Math.max(0, cfg.countdownMs ?? 3000);
    this.noStartMs = cfg.noStartMs ?? 20000;
    this.undoMs = cfg.undoBeforeStopMs ?? 1500;
    this.idleEndMs = cfg.idleEndMs ?? this.def.idleEndMs;
    this.hintRepeatMs = cfg.hintRepeatMs ?? 10000;
    this.tr = createTracker(cfg.exercise);
  }

  get phase(): SetPhase {
    return this.ph;
  }

  get tracker(): TrackerState {
    return this.tr.state();
  }

  get result(): SetResult | null {
    return this.res;
  }

  push(f: PoseFrame): SetEvent[] {
    if (this.ph === 'finished' || this.pausedAt !== null || f.t < this.lastT) return [];
    const out: SetEvent[] = [];
    // 먼저 시간을 흘려 카운트다운·idle·noStart를 처리하고, 그다음 이 프레임을 지금 단계에 맞게 넣는다.
    this.advance(f.t, out);
    const ph = this.phase; // advance가 단계를 바꿨을 수 있다
    if (ph === 'finished') return out;
    this.lastT = f.t;
    this.lastFrameT = f.t;

    if (ph === 'countdown') {
      // 카운트다운 중에도 트래커는 계속 돌린다(자세가 깨져도 진행, 반복은 start 기준점으로 걸러짐).
      this.tr.push(f);
      return out;
    }
    const s = this.tr.push(f);
    this.hint(f.t, s.diagnosis, out);
    if (ph === 'waitingReady') this.checkReady(f, s, out);
    else this.onActiveFrame(f.t, s, out);
    return out;
  }

  tick(t: number): SetEvent[] {
    if (this.ph === 'finished' || this.pausedAt !== null || t <= this.lastT) return [];
    const out: SetEvent[] = [];
    this.advance(t, out);
    this.lastT = Math.max(this.lastT, t);
    // 매달리기 중 프레임이 끊겼다: HoldTimer는 프레임이 와야 grace를 재므로 여기서 같은 규칙으로 끝낸다.
    // heldMs는 HoldTimer가 마지막 holding 프레임(또는 자세가 깨진 시각)에서 멈춰 둔 값 그대로다.
    if (this.ph === 'active' && this.def.kind === 'hold' && t - this.lastFrameT >= this.def.hold.graceMs) {
      this.finish(t, 'released', out);
    }
    return out;
  }

  pause(t: number): void {
    if (this.ph === 'finished' || this.pausedAt !== null) return;
    this.pausedAt = t;
  }

  resume(t: number): void {
    if (this.pausedAt === null) return;
    const d = Math.max(0, t - this.pausedAt);
    this.pausedAt = null;
    if (this.ph === 'finished') return;
    this.countdownT0 += d;
    this.idleFrom += d;
    this.lastFrameT += d;
    if (this.ph === 'active') this.pausedInActiveMs += d;
    // 일시정지 전의 시작 자세는 이어 보지 않는다.
    this.poseSince = null;
    this.lastT = Math.max(this.lastT, t);
  }

  stop(t: number): SetEvent[] {
    if (this.ph === 'finished') return [];
    if (this.ph !== 'active') {
      // 아직 세트가 시작되지 않았다: 기록할 결과가 없다.
      this.ph = 'finished';
      return [];
    }
    // 그만하기를 누르려고 움직이다 잘못 센 반복을 되돌린다(#1).
    this.reps = this.reps.filter((r) => !(r.endT > t - this.undoMs));
    const out: SetEvent[] = [];
    this.finish(t, 'manual', out);
    return out;
  }

  // ---- 내부 ----

  /** 프레임과 상관없이 시각 t까지 시간에 따른 일을 처리한다. */
  private advance(t: number, out: SetEvent[]): void {
    if (this.ph === 'countdown') {
      while (this.countdownNext < COUNTDOWN_NS.length) {
        const n = COUNTDOWN_NS[this.countdownNext]!;
        if (t < this.countdownAt(n)) break;
        out.push({ type: 'countdown', n });
        this.countdownNext += 1;
      }
      if (t >= this.countdownT0 + this.countdownMs) this.begin(t, out);
      return;
    }
    if (this.ph !== 'active' || this.def.kind !== 'reps') return;
    if (this.reps.length > 0) {
      if (t - this.idleFrom >= this.idleEndMs) this.finish(t, 'idle', out);
    } else if (t - this.idleFrom >= this.noStartMs) {
      out.push({ type: 'backToReady' });
      this.toWaitingReady();
    }
  }

  /** n을 낼 시각. 3000ms면 3·2·1이 0·1000·2000ms. 짧으면 앞의 숫자는 들어가는 순간 함께 낸다 */
  private countdownAt(n: number): number {
    return this.countdownT0 + Math.max(0, this.countdownMs - n * 1000);
  }

  private checkReady(f: PoseFrame, s: TrackerState, out: SetEvent[]): void {
    const def = this.def;
    switch (def.start) {
      case 'calibrate':
        if (s.kind === 'reps' && s.phase !== 'calibrating') {
          this.ph = 'countdown';
          this.countdownT0 = f.t;
          this.countdownNext = 0;
          // countdownMs가 0이면 이 프레임에서 바로 start
          this.advance(f.t, out);
        }
        return;
      case 'visible':
        if (def.kind === 'reps') {
          const v = def.signal(f);
          if (v !== null && Number.isFinite(v)) this.begin(f.t, out);
        }
        return;
      case 'pose': {
        if (s.kind === 'hold') {
          // HoldTimer가 이미 300ms 시작 판정을 한다.
          if (s.state === 'holding') {
            this.begin(f.t, out);
            this.onActiveFrame(f.t, s, out);
          }
          return;
        }
        const p = def.startPose ? def.startPose(f) : null;
        if (p !== true) {
          this.poseSince = null;
          return;
        }
        this.poseSince ??= f.t;
        if (f.t - this.poseSince >= START_POSE_MS) this.begin(f.t, out);
        return;
      }
    }
  }

  private begin(t: number, out: SetEvent[]): void {
    const s = this.tr.state();
    this.ph = 'active';
    this.startT = t;
    this.idleFrom = t;
    this.prevRep = s.kind === 'reps' ? s.lastRep : null;
    this.reps = [];
    this.holdSecs = 0;
    this.goalSent = false;
    this.pausedInActiveMs = 0;
    out.push({ type: 'start' });
  }

  private onActiveFrame(t: number, s: TrackerState, out: SetEvent[]): void {
    const target = this.cfg.target;
    if (s.kind === 'reps') {
      if (!s.lastRep || s.lastRep === this.prevRep) return;
      this.prevRep = s.lastRep;
      this.reps.push(s.lastRep);
      this.idleFrom = t;
      const count = this.reps.length;
      out.push({ type: 'rep', count });
      if (target.kind === 'reps' && count >= target.reps) {
        out.push({ type: 'goalReached' });
        this.finish(t, 'target', out);
      }
      return;
    }
    const held = this.heldMs(s.heldMs);
    const secs = Math.floor(held / 1000);
    while (this.holdSecs < secs) {
      this.holdSecs += 1;
      out.push({ type: 'hold', seconds: this.holdSecs });
      if (!this.goalSent && target.kind === 'seconds' && this.holdSecs >= target.seconds) {
        this.goalSent = true;
        out.push({ type: 'goalReached' });
      }
    }
    if (s.state === 'ended') this.finish(t, 'released', out);
  }

  private heldMs(raw: number): number {
    return Math.max(0, raw - this.pausedInActiveMs);
  }

  private hint(t: number, d: Diagnosis, out: SetEvent[]): void {
    if (d === 'ok') return;
    const last = this.hintAt.get(d);
    // 기본값 보정 안내는 세트당 한 번(운동 중 반복되면 방해). 나머지는 hintRepeatMs 간격으로 다시 낸다.
    if (last !== undefined && (d === 'calibratedByDefault' || t - last < this.hintRepeatMs)) return;
    this.hintAt.set(d, t);
    out.push({ type: 'hint', diagnosis: d });
  }

  private finish(t: number, reason: EndReason, out: SetEvent[]): void {
    const s = this.tr.state();
    this.res = {
      exercise: this.cfg.exercise,
      target: this.cfg.target,
      count: s.kind === 'reps' ? this.reps.length : 0,
      heldMs: s.kind === 'hold' ? this.heldMs(s.heldMs) : 0,
      negativeDescentMs: this.def.id === 'negative' ? this.reps.map((r) => r.outMs) : [],
      startT: this.startT,
      endT: t,
      endReason: reason,
    };
    this.ph = 'finished';
    out.push({ type: 'finished', reason, result: this.res });
  }

  /** 첫 반복 없이 시간이 지났다: 트래커를 새로 만들고 준비 자세부터 다시 */
  private toWaitingReady(): void {
    this.tr = createTracker(this.cfg.exercise);
    this.ph = 'waitingReady';
    this.poseSince = null;
    this.reps = [];
    this.prevRep = null;
  }
}
