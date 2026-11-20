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
  /**
   * 매달리기: HoldTimer는 일시정지를 모르므로, resume 뒤 holding 프레임이 와서 lastTrueT가 일시정지 구간을
   * 건너 밀리면 그만큼 heldMs가 부풀어 오른다. 그 경우에만 일시정지 시간을 뺀다.
   * pendingPauseMs: 아직 heldMs에 반영됐는지 모르는 일시정지 시간, rawAtResume: 그때의 HoldTimer 값
   */
  private pendingPauseMs = 0;
  private rawAtResume = 0;
  /** 실제로 HoldTimer 값에 들어가 있어 빼야 하는 일시정지 시간 합 */
  private pausedHoldMs = 0;

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

  /** 세트 결과의 복사본(끝나기 전이나 시작 전 그만하기면 null) */
  get result(): SetResult | null {
    return this.res ? copyResult(this.res) : null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
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
    if (this.ph === 'waitingReady') {
      // 보정·시작 자세 판정을 처음부터 다시 한다. 일시정지 시간 때문에 보정이 타임아웃되어 기본값으로
      // 잡히거나, HoldTimer가 일시정지 전 시각부터 매달린 것으로 보는 일을 막는다.
      this.tr = createTracker(this.cfg.exercise);
    } else if (this.ph === 'active') {
      // active 중에는 트래커를 그대로 둔다(세던 반복·버틴 시간을 이어 간다). 그래서 반복 도중 일시정지했다가
      // resume 뒤 이어서 움직이면 그 반복이 확정될 수 있다.
      const s = this.tr.state();
      if (s.kind === 'hold') {
        if (this.pendingPauseMs === 0) this.rawAtResume = s.heldMs;
        this.pendingPauseMs += d;
      }
    }
    // 일시정지 전의 시작 자세는 이어 보지 않는다.
    this.poseSince = null;
    this.lastT = Math.max(this.lastT, t);
  }

  stop(t: number): SetEvent[] {
    if (this.ph === 'finished') return [];
    // 지금까지 본 시각보다 이른 stop은 그 시각으로 본다. 일시정지 중이면 시간은 일시정지한 순간에 멈춰 있다.
    const now = Math.max(t, this.lastT);
    const ref = this.pausedAt !== null ? Math.max(Math.min(t, this.pausedAt), this.lastT) : now;
    // 밀린 시간 처리를 먼저 끝낸다: idle이 이미 지났으면 idle로 끝나고, 카운트다운이 끝났으면 start한다.
    const out: SetEvent[] = [];
    this.advance(ref, out);
    if (this.phase === 'finished') return out;
    if (this.phase !== 'active') {
      // 아직 세트가 시작되지 않았다: 기록할 결과가 없다.
      this.ph = 'finished';
      return [];
    }
    // 그만하기를 누르려고 움직이다 잘못 센 반복을 되돌린다(#1).
    this.reps = this.reps.filter((r) => !(r.endT > ref - this.undoMs));
    this.finish(now, 'manual', out);
    return out;
  }

  // ---- 내부 ----

  /** 프레임과 상관없이 시각 t까지 시간에 따른 일을 처리한다. */
  private advance(t: number, out: SetEvent[]): void {
    if (this.ph === 'countdown') {
      while (this.countdownNext < COUNTDOWN_NS.length) {
        const n = COUNTDOWN_NS[this.countdownNext]!;
        // countdownMs 안에 들어가는 숫자만 낸다(1500이면 1만, 0이면 없음).
        if (n * 1000 <= this.countdownMs) {
          if (t < this.countdownAt(n)) break;
          out.push({ type: 'countdown', n });
        }
        this.countdownNext += 1;
      }
      if (t >= this.countdownT0 + this.countdownMs) this.begin(t, out);
      return;
    }
    if (this.ph !== 'active' || this.def.kind !== 'reps') return;
    if (this.reps.length > 0) {
      if (t - this.idleFrom >= this.idleEndMs) this.finish(t, 'idle', out);
    } else if (this.def.start !== 'visible' && t - this.idleFrom >= this.noStartMs) {
      // 'visible'(네거티브)은 보이면 바로 다시 시작하므로, 되돌리면 "다시 자세를" → "시작"이 20초마다 반복된다.
      out.push({ type: 'backToReady' });
      this.toWaitingReady();
    }
  }

  /** n을 낼 시각(n*1000 <= countdownMs인 n만). 3000ms면 3·2·1이 0·1000·2000ms, start는 3000ms */
  private countdownAt(n: number): number {
    return this.countdownT0 + this.countdownMs - n * 1000;
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
    this.pendingPauseMs = 0;
    this.rawAtResume = 0;
    this.pausedHoldMs = 0;
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
    if (this.pendingPauseMs > 0 && s.heldMs > this.rawAtResume) {
      // resume 뒤 holding 프레임으로 HoldTimer 값이 일시정지 구간을 건너 늘었다(증가분 >= 일시정지 시간).
      this.pausedHoldMs += this.pendingPauseMs;
      this.pendingPauseMs = 0;
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
    return Math.max(0, raw - this.pausedHoldMs);
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
    out.push({ type: 'finished', reason, result: copyResult(this.res) });
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

function copyResult(r: SetResult): SetResult {
  return { ...r, target: { ...r.target }, negativeDescentMs: [...r.negativeDescentMs] };
}
