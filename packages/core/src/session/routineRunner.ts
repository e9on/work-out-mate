import type { PoseFrame } from '../types';
import type { ExerciseId } from '../exercises/runner';
import { SetRunner, type SetConfig, type SetEvent } from './setRunner';
import type { Routine, SetLog, SetResult, Target, WorkoutSession } from './model';

/** 쉬는 시간 뒤에 할 세트 */
export type NextSet = { exerciseIndex: number; setIndex: number; exercise: ExerciseId; target: Target };

/**
 * 루틴 진행 이벤트.
 * - set: SetRunner 이벤트를 운동·세트 번호와 함께 감싼 것. 건너뛰기·그만하기로 반복이 0인 세트(count 0, heldMs 0)를
 *   끝내면 set(finished)는 나오지만 세션에 기록되지 않는다. 그래서 앱은 finished의 result.count·heldMs를 보고
 *   "세트 완료" 안내를 할지 정해야 한다.
 * - restStart.next: 쉬는 시간 뒤 세트(다음이 없으면 restStart 자체가 없으므로 항상 있다).
 */
export type RoutineEvent =
  | { type: 'exerciseStart'; exerciseIndex: number; exercise: ExerciseId }
  | { type: 'set'; exerciseIndex: number; setIndex: number; event: SetEvent }
  | { type: 'restStart'; seconds: number; next: NextSet }
  | { type: 'restTick'; remaining: number }
  | { type: 'nextUp'; exerciseIndex: number; exercise: ExerciseId; setIndex: number; target: Target }
  | { type: 'restEnd' }
  | { type: 'routineEnd'; session: WorkoutSession };

export type RoutineRunnerOptions = {
  /** 루틴을 시작한 시각(입력 t와 같은 시계). startedAt = toEpoch(startT) */
  startT: number;
  sessionId: string;
  /** 입력 시계 t를 세션에 저장할 시각으로 바꾼다. 기본은 항등 함수 */
  toEpoch?: (t: number) => number;
  /** 모든 세트에 쓸 SetRunner 설정(운동·목표는 루틴에서) */
  set?: Partial<Omit<SetConfig, 'exercise' | 'target'>>;
};

export type RoutinePhase = 'set' | 'rest' | 'done';

type Pos = { exerciseIndex: number; setIndex: number };

type Rest = {
  /** 쉬는 시간이 시작된 시각(끝난 세트의 endT) */
  t0: number;
  ms: number;
  /** 시작 값(올림 정수 초). 이 값은 restTick으로 내지 않는다 */
  startSec: number;
  /** 일시정지로 멈춰 있던 시간 합 */
  pausedMs: number;
  lastTick: number | null;
  nextUpSent: boolean;
  next: Pos;
};

/** 남은 시간이 이 값 이하가 되면 nextUp을 낸다 */
const NEXT_UP_MS = 20000;

/**
 * 루틴 하나를 `운동 → 세트(SetRunner) → 쉬는 시간 → …` 순서로 진행하는 상태 기계.
 * 시간은 입력 t(PoseFrame.t와 같은 시계)로만 본다. 지금까지 본 시각보다 이르거나 같은 push·tick은 무시한다.
 * 호출마다 그 사이에 일어난 이벤트를 일어난 순서대로 돌려준다.
 *
 * - 첫 exerciseStart는 생성자에서 낼 수 없으므로 첫 호출(push·tick·skipExercise·stop)의 배열 맨 앞에 담는다.
 * - 세트가 끝난 호출 안에서 쉬는 시간을 시작한다: set(finished) → restStart → (20초 이하면) nextUp.
 *   마지막 세트면 set(finished) → routineEnd.
 * - restEnd가 나온 호출 안에서 다음 SetRunner를 만들고, 운동이 바뀌면 exerciseStart를 낸다.
 *   그 호출의 프레임은 새 세트에 넣지 않는다(새 세트의 준비 자세 판정은 다음 push부터).
 * - 쉬는 시간 중 current는 방금 끝난 세트를 가리킨다. 그래서 쉬는 시간 중 skipExercise는
 *   "방금 끝난 운동의 남은 세트"를 건너뛰고 그다음 운동으로 간다(다음 운동을 건너뛰지 않는다).
 */
export class RoutineRunner {
  private readonly routine: Routine;
  private readonly opts: RoutineRunnerOptions;
  private readonly toEpoch: (t: number) => number;

  private ph: RoutinePhase = 'set';
  private pos: Pos;
  private runner: SetRunner;
  private rest: Rest | null = null;
  /** 첫 호출에 담아 낼 이벤트(첫 exerciseStart) */
  private pending: RoutineEvent[] = [];
  private lastT = -Infinity;
  private pausedAt: number | null = null;
  private readonly logs: SetLog[] = [];
  /** 마지막으로 기록한 세트의 endT(restTakenMs 기준) */
  private prevEndT: number | null = null;
  /** 건너뛰기나 그만하기가 한 번이라도 있었다 */
  private interrupted = false;

  constructor(routine: Routine, opts: RoutineRunnerOptions) {
    this.routine = routine;
    this.opts = opts;
    this.toEpoch = opts.toEpoch ?? ((t) => t);
    const first = this.nextExercise(-1);
    if (first === null) throw new Error('RoutineRunner: 세트가 1개 이상인 운동이 없는 루틴');
    this.pos = { exerciseIndex: first, setIndex: 0 };
    this.runner = this.makeRunner(this.pos);
    this.pending.push(this.exerciseStart(first));
  }

  get phase(): RoutinePhase {
    return this.ph;
  }

  /** 지금 세트(쉬는 시간 중에는 방금 끝난 세트) */
  get current(): { exerciseIndex: number; setIndex: number } {
    return { ...this.pos };
  }

  /** 일시정지 중인지. 세트 중이면 SetRunner.paused, 쉬는 시간이면 쉬는 시간 일시정지 여부, 끝난 뒤에는 false */
  get paused(): boolean {
    if (this.ph === 'done') return false;
    if (this.ph === 'set') return this.runner.paused;
    return this.pausedAt !== null;
  }

  push(f: PoseFrame): RoutineEvent[] {
    if (this.ph === 'done') return [];
    const out = this.takePending();
    if (this.pausedAt !== null || f.t <= this.lastT) return out;
    this.lastT = f.t;
    if (this.ph === 'rest') this.advanceRest(f.t, out);
    else this.onSetEvents(this.runner.push(f), out);
    return out;
  }

  tick(t: number): RoutineEvent[] {
    if (this.ph === 'done') return [];
    const out = this.takePending();
    if (this.pausedAt !== null || t <= this.lastT) return out;
    this.lastT = t;
    if (this.ph === 'rest') this.advanceRest(t, out);
    else this.onSetEvents(this.runner.tick(t), out);
    return out;
  }

  /** 세트 중이면 SetRunner에 전달하고, 쉬는 시간이면 남은 시간을 멈춘다 */
  pause(t: number): void {
    if (this.ph === 'done' || this.pausedAt !== null) return;
    this.pausedAt = Math.max(t, this.lastT);
    if (this.ph === 'set') this.runner.pause(this.pausedAt);
  }

  resume(t: number): void {
    if (this.pausedAt === null) return;
    const at = Math.max(t, this.pausedAt);
    if (this.ph === 'rest' && this.rest) this.rest.pausedMs += at - this.pausedAt;
    if (this.ph === 'set') this.runner.resume(at);
    this.pausedAt = null;
    this.lastT = Math.max(this.lastT, at);
  }

  /**
   * 지금 운동의 남은 세트를 건너뛰고 그다음 운동의 첫 세트(waitingReady)로 간다. 쉬는 시간은 두지 않는다.
   * 세트 중이면 반복이 있을 때만(count>0 또는 heldMs>0) 그만하기로 끝내 기록한다.
   * 쉬는 시간 중이면 restEnd를 내고 넘어간다. 다음 운동이 없으면 routineEnd(completed false).
   * 일시정지 중이면 일시정지를 풀고 진행한다.
   */
  skipExercise(t: number): RoutineEvent[] {
    if (this.ph === 'done') return [];
    const out = this.takePending();
    const now = Math.max(t, this.lastT);
    this.interrupted = true;
    if (this.ph === 'set') this.stopSet(t, out);
    else {
      this.rest = null;
      out.push({ type: 'restEnd' });
    }
    // 일시정지 중이면 풀고 진행한다(새 세트는 멈추지 않은 상태로 시작).
    this.pausedAt = null;
    this.lastT = now;
    const j = this.nextExercise(this.pos.exerciseIndex);
    if (j === null) this.end(now, out);
    else this.startSet({ exerciseIndex: j, setIndex: 0 }, out);
    return out;
  }

  /**
   * 쉬는 시간을 바로 끝내고 다음 세트(waitingReady)로 간다. 쉬는 시간이 끝났을 때와 같은 경로라
   * restEnd 뒤 운동이 바뀌면 exerciseStart를 낸다. completed에는 영향이 없다. 쉬는 시간이 아니면 [].
   * 일시정지 중이면 일시정지를 풀고 진행한다.
   */
  skipRest(t: number): RoutineEvent[] {
    if (this.ph !== 'rest' || !this.rest) return [];
    const out = this.takePending();
    const now = Math.max(t, this.lastT);
    this.pausedAt = null;
    this.lastT = now;
    const next = this.rest.next;
    this.rest = null;
    out.push({ type: 'restEnd' });
    this.startSet(next, out);
    return out;
  }

  /** 루틴 전체를 끝낸다. 진행 중 세트는 SetRunner.stop으로 끝내고 반복이 있으면 기록한다. completed false */
  stop(t: number): RoutineEvent[] {
    if (this.ph === 'done') return [];
    const out = this.takePending();
    const now = Math.max(t, this.lastT);
    this.interrupted = true;
    if (this.ph === 'set') this.stopSet(t, out);
    this.end(now, out);
    return out;
  }

  // ---- 내부 ----

  private takePending(): RoutineEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private makeRunner(p: Pos): SetRunner {
    const ex = this.routine.exercises[p.exerciseIndex]!;
    return new SetRunner({ ...this.opts.set, exercise: ex.exercise, target: ex.target });
  }

  private exerciseStart(i: number): RoutineEvent {
    return { type: 'exerciseStart', exerciseIndex: i, exercise: this.routine.exercises[i]!.exercise };
  }

  /** i번 운동의 세트 수(정수가 아니면 내림, 음수는 0) */
  private setsOf(i: number): number {
    const n = Math.floor(this.routine.exercises[i]!.sets);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** i 뒤로 세트가 1개 이상인 첫 운동 번호 */
  private nextExercise(i: number): number | null {
    const xs = this.routine.exercises;
    for (let j = i + 1; j < xs.length; j++) if (this.setsOf(j) >= 1) return j;
    return null;
  }

  /** p 다음 세트(같은 운동의 다음 세트, 없으면 다음 운동의 첫 세트) */
  private nextPos(p: Pos): Pos | null {
    if (p.setIndex + 1 < this.setsOf(p.exerciseIndex)) {
      return { exerciseIndex: p.exerciseIndex, setIndex: p.setIndex + 1 };
    }
    const j = this.nextExercise(p.exerciseIndex);
    return j === null ? null : { exerciseIndex: j, setIndex: 0 };
  }

  private wrap(ev: SetEvent): RoutineEvent {
    return { type: 'set', exerciseIndex: this.pos.exerciseIndex, setIndex: this.pos.setIndex, event: ev };
  }

  /** 세트 중 SetRunner 이벤트를 감싸 내고, finished면 기록한 뒤 쉬는 시간(또는 다음 세트·끝)으로 */
  private onSetEvents(evs: SetEvent[], out: RoutineEvent[]): void {
    for (const ev of evs) {
      out.push(this.wrap(ev));
      if (ev.type === 'finished') {
        this.record(ev.result);
        this.afterSet(ev.result.endT, out);
        return;
      }
    }
  }

  /** 건너뛰기·그만하기: 진행 중 세트를 끝내고 반복이 있으면 기록한다 */
  private stopSet(t: number, out: RoutineEvent[]): void {
    for (const ev of this.runner.stop(t)) {
      out.push(this.wrap(ev));
      if (ev.type === 'finished' && (ev.result.count > 0 || ev.result.heldMs > 0)) this.record(ev.result);
    }
  }

  private record(r: SetResult): void {
    this.logs.push({
      ...r,
      target: { ...r.target },
      negativeDescentMs: [...r.negativeDescentMs],
      // 저장 레코드는 toEpoch 시계 하나로 맞춘다. restTakenMs는 입력 시계 차이값(시계와 상관없음).
      startT: this.toEpoch(r.startT),
      endT: this.toEpoch(r.endT),
      exerciseIndex: this.pos.exerciseIndex,
      setIndex: this.pos.setIndex,
      restTakenMs: this.prevEndT === null ? null : r.startT - this.prevEndT,
    });
    this.prevEndT = r.endT;
  }

  /** 세트가 시각 t에 끝났다. 다음 세트가 있으면 그 세트 운동의 restSec만큼 쉰다(0이면 바로 다음 세트) */
  private afterSet(t: number, out: RoutineEvent[]): void {
    const next = this.nextPos(this.pos);
    if (next === null) {
      this.end(t, out);
      return;
    }
    // 같은 운동이면 그 운동의, 다음 운동이면 다음 운동의 restSec(둘 다 next 운동의 restSec)
    const restSec = this.routine.exercises[next.exerciseIndex]!.restSec;
    if (!(restSec > 0)) {
      this.startSet(next, out);
      return;
    }
    const ms = restSec * 1000;
    this.ph = 'rest';
    this.rest = { t0: t, ms, startSec: Math.ceil(ms / 1000), pausedMs: 0, lastTick: null, nextUpSent: false, next };
    out.push({ type: 'restStart', seconds: restSec, next: this.nextSet(next) });
    if (ms <= NEXT_UP_MS) this.nextUp(out);
  }

  private advanceRest(t: number, out: RoutineEvent[]): void {
    const r = this.rest!;
    const remaining = r.ms - (t - r.t0 - r.pausedMs);
    if (remaining <= 0) {
      // 큰 tick 점프로 남은 20초를 건너뛰었어도 "다음은…" 안내를 놓치지 않게 restEnd 바로 앞에서 낸다.
      this.nextUp(out);
      this.rest = null;
      out.push({ type: 'restEnd' });
      this.startSet(r.next, out);
      return;
    }
    // 정수 초(올림)마다 최대 한 번, 10의 배수와 5·4·3·2·1만. 건너뛴 값은 몰아서 내지 않는다.
    const sec = Math.ceil(remaining / 1000);
    if (sec < r.startSec && sec !== r.lastTick && (sec % 10 === 0 || sec <= 5)) {
      r.lastTick = sec;
      out.push({ type: 'restTick', remaining: sec });
    }
    if (remaining <= NEXT_UP_MS) this.nextUp(out);
  }

  private nextUp(out: RoutineEvent[]): void {
    const r = this.rest!;
    if (r.nextUpSent) return;
    r.nextUpSent = true;
    out.push({ type: 'nextUp', ...this.nextSet(r.next) });
  }

  private nextSet(p: Pos): NextSet {
    const ex = this.routine.exercises[p.exerciseIndex]!;
    return { exerciseIndex: p.exerciseIndex, setIndex: p.setIndex, exercise: ex.exercise, target: { ...ex.target } };
  }

  /** 다음 세트를 waitingReady로 시작한다. 운동이 바뀌면 exerciseStart */
  private startSet(p: Pos, out: RoutineEvent[]): void {
    const changed = p.exerciseIndex !== this.pos.exerciseIndex;
    this.pos = { ...p };
    this.runner = this.makeRunner(p);
    this.ph = 'set';
    if (changed) out.push(this.exerciseStart(p.exerciseIndex));
  }

  private end(t: number, out: RoutineEvent[]): void {
    this.ph = 'done';
    this.rest = null;
    let total = 0;
    for (let i = 0; i < this.routine.exercises.length; i++) total += this.setsOf(i);
    const completed =
      !this.interrupted && this.logs.length === total && this.logs.every((s) => s.endReason !== 'manual');
    const session: WorkoutSession = {
      id: this.opts.sessionId,
      routineId: this.routine.id,
      routineName: this.routine.name,
      startedAt: this.toEpoch(this.opts.startT),
      endedAt: this.toEpoch(t),
      completed,
      sets: this.logs.map((s) => ({ ...s, target: { ...s.target }, negativeDescentMs: [...s.negativeDescentMs] })),
    };
    out.push({ type: 'routineEnd', session });
  }
}
