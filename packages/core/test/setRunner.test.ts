import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, test } from 'vitest';
import { SetRunner, type SetConfig, type SetEvent } from '../src/session/setRunner';
import { EXERCISES, replay, type ExerciseId } from '../src/exercises/runner';
import type { RecordingFile } from '../src/recording';
import type { PoseFrame } from '../src/types';
import { LM } from '../src/types';
import { buildPose, type PoseOpts } from './helpers/poseBuilder';

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
const reps = (rest: number, bottom: number, k: number, n = 15): number[] =>
  Array.from({ length: k }, () => oneRep(rest, bottom, n)).flat();

type Extra = Partial<Omit<PoseOpts, 't' | 'elbow' | 'knee'>>;

/** 프레임 시계를 이어 가며 각도 열을 프레임으로 만든다. */
class Clock {
  t = 0;
  frames(values: number[], key: 'elbow' | 'knee', extra: Extra = {}): PoseFrame[] {
    return values.map((v) => {
      const f = buildPose({ ...extra, t: this.t, [key]: v });
      this.t += DT;
      return f;
    });
  }
}

type Timed = { t: number; ev: SetEvent };

/** 프레임을 차례로 넣고 나온 이벤트를 시각과 함께 모은다. until이 참이면 그 프레임에서 멈춘다. */
function feed(r: SetRunner, frames: PoseFrame[], out: Timed[] = [], until?: (e: SetEvent) => boolean): Timed[] {
  for (const f of frames) {
    const evs = r.push(f);
    for (const ev of evs) out.push({ t: f.t, ev });
    if (until && evs.some(until)) break;
  }
  return out;
}
function tickTo(r: SetRunner, from: number, to: number, step: number, out: Timed[] = []): Timed[] {
  for (let t = from; t <= to; t += step) for (const ev of r.tick(t)) out.push({ t, ev });
  return out;
}

const types = (xs: Timed[]) => xs.map((x) => x.ev.type);
const repCounts = (xs: Timed[]) => xs.flatMap((x) => (x.ev.type === 'rep' ? [x.ev.count] : []));
const first = (xs: Timed[], type: SetEvent['type']) => xs.find((x) => x.ev.type === type);
const finishedOf = (xs: Timed[]) => {
  const f = xs.find((x) => x.ev.type === 'finished');
  return f && f.ev.type === 'finished' ? { t: f.t, reason: f.ev.reason, result: f.ev.result } : undefined;
};

function squat(target: SetConfig['target'] = { kind: 'reps', reps: 10 }, extra: Partial<SetConfig> = {}) {
  return new SetRunner({ exercise: 'squat', target, ...extra });
}

/** 스쿼트: 준비 자세 1초 + 카운트다운 3초 동안 서 있기. 반환값은 start 시각 */
function squatToActive(r: SetRunner, c: Clock, out: Timed[]): number {
  feed(r, c.frames(hold(175, 1000 + 3200), 'knee'), out, (e) => e.type === 'start');
  const s = first(out, 'start');
  if (!s) throw new Error('start가 나오지 않음');
  return s.t;
}

describe('SetRunner: 스쿼트(보정 → 카운트다운 → 운동)', () => {
  it('준비 자세 1초 → countdown 3,2,1을 1초 간격으로 → start → 3회 rep 1,2,3', () => {
    const r = squat({ kind: 'reps', reps: 5 });
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 1000), ...hold(175, 3200), ...reps(175, 90, 3)], 'knee'));
    const cd = out.filter((x) => x.ev.type === 'countdown');
    expect(cd.map((x) => (x.ev.type === 'countdown' ? x.ev.n : 0))).toEqual([3, 2, 1]);
    const t0 = cd[0]!.t;
    expect(t0).toBeLessThanOrEqual(1000);
    expect(Math.abs(cd[1]!.t - t0 - 1000)).toBeLessThanOrEqual(40);
    expect(Math.abs(cd[2]!.t - t0 - 2000)).toBeLessThanOrEqual(40);
    expect(Math.abs(first(out, 'start')!.t - t0 - 3000)).toBeLessThanOrEqual(40);
    expect(types(out).slice(0, 4)).toEqual(['countdown', 'countdown', 'countdown', 'start']);
    expect(repCounts(out)).toEqual([1, 2, 3]);
    expect(r.phase).toBe('active');
  });

  it('목표 3이면 rep 3 → goalReached → finished(target), result.count 3', () => {
    const r = squat({ kind: 'reps', reps: 3 });
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 3), ...hold(175, 1000)], 'knee'));
    expect(types(out).slice(-3)).toEqual(['rep', 'goalReached', 'finished']);
    const fin = finishedOf(out)!;
    expect(fin.reason).toBe('target');
    expect(fin.result.count).toBe(3);
    expect(fin.result.endReason).toBe('target');
    expect(fin.result.startT).toBe(first(out, 'start')!.t);
    expect(fin.result.endT).toBe(fin.t);
    expect(fin.result.negativeDescentMs).toEqual([]);
    expect(r.phase).toBe('finished');
    expect(r.result).toEqual(fin.result);
  });

  it('목표 10에서 8회 뒤 멈추면 마지막 반복 + 5000ms에 finished(idle), count 8', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 8), ...hold(175, 7000)], 'knee'));
    const lastRep = out.filter((x) => x.ev.type === 'rep').at(-1)!;
    const fin = finishedOf(out)!;
    expect(fin.reason).toBe('idle');
    expect(fin.result.count).toBe(8);
    expect(fin.t - lastRep.t).toBeGreaterThanOrEqual(5000);
    expect(fin.t - lastRep.t).toBeLessThan(5000 + 40);
  });

  it('카운트다운 중에 확정된 반복은 세지 않는다: start 뒤 첫 rep 이벤트가 1', () => {
    const r = squat();
    const c = new Clock();
    const out: Timed[] = [];
    // 준비 자세 1초(보정은 약 0.7초에 끝남) 뒤 바로 1회: 카운트다운 1~2초째에 확정된다.
    feed(r, c.frames([...hold(175, 1000), ...oneRep(175, 90)], 'knee'), out);
    expect(r.phase).toBe('countdown');
    expect(r.tracker.kind === 'reps' && r.tracker.count).toBe(1);
    feed(r, c.frames([...hold(175, 2500), ...oneRep(175, 90)], 'knee'), out);
    expect(first(out, 'start')).toBeDefined();
    expect(repCounts(out)).toEqual([1]);
    expect(r.tracker.kind === 'reps' && r.tracker.count).toBe(2);
  });

  it('start 뒤 20초 동안 반복이 없으면 backToReady, phase waitingReady', () => {
    const r = squat();
    const c = new Clock();
    const out: Timed[] = [];
    const startT = squatToActive(r, c, out);
    feed(r, c.frames(hold(175, 21000), 'knee'), out, (e) => e.type === 'backToReady');
    const back = first(out, 'backToReady')!;
    expect(back).toBeDefined();
    expect(back.t - startT).toBeGreaterThanOrEqual(20000);
    expect(back.t - startT).toBeLessThan(20000 + 40);
    expect(r.phase).toBe('waitingReady');
    expect(finishedOf(out)).toBeUndefined();
    // 트래커를 새로 만들었으므로 다시 보정부터
    expect(r.tracker.kind === 'reps' && r.tracker.phase).toBe('calibrating');
  });
});

describe('SetRunner: 철봉 운동(카운트다운 없음)', () => {
  const HANG = { wristAboveNose: true } as const;

  it('deadHang: 매달림 300ms → 바로 start, 1초마다 hold, 목표 5초 goalReached 한 번, 손 놓으면 released', () => {
    const r = new SetRunner({ exercise: 'deadHang', target: { kind: 'seconds', seconds: 5 } });
    const c = new Clock();
    const out = feed(r, c.frames(hold(170, 500), 'elbow'));
    const hangT = c.t;
    feed(r, c.frames(hold(170, 8200), 'elbow', HANG), out);
    feed(r, c.frames(hold(170, 1500), 'elbow'), out);

    expect(types(out)).not.toContain('countdown');
    const s = first(out, 'start')!;
    expect(s.t - hangT).toBeGreaterThanOrEqual(300);
    expect(s.t - hangT).toBeLessThan(300 + 40);
    const holds = out.flatMap((x) => (x.ev.type === 'hold' ? [x.ev.seconds] : []));
    expect(holds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(types(out).filter((t) => t === 'goalReached')).toHaveLength(1);
    const i5 = out.findIndex((x) => x.ev.type === 'hold' && x.ev.seconds === 5);
    expect(out[i5 + 1]!.ev.type).toBe('goalReached');
    const fin = finishedOf(out)!;
    expect(fin.reason).toBe('released');
    expect(Math.abs(fin.result.heldMs - 8200)).toBeLessThanOrEqual(100);
    expect(fin.result.count).toBe(0);
  });

  it('deadHang: 매달려 3초 뒤 프레임이 끊기면 tick만으로 마지막 프레임 + 500ms에 released, heldMs 약 3000', () => {
    const r = new SetRunner({ exercise: 'deadHang', target: { kind: 'seconds', seconds: 10 } });
    const c = new Clock();
    const out = feed(r, c.frames(hold(170, 500), 'elbow'));
    const hangT = c.t;
    feed(r, c.frames(hold(170, 3000), 'elbow', HANG), out);
    const lastT = c.t - DT;
    expect(r.phase).toBe('active');
    tickTo(r, lastT + 200, lastT + 3000, 200, out);
    const fin = finishedOf(out)!;
    expect(fin).toBeDefined();
    expect(fin.reason).toBe('released');
    expect(fin.t - lastT).toBeGreaterThanOrEqual(500);
    expect(fin.t - lastT).toBeLessThan(500 + 200);
    expect(Math.abs(fin.result.heldMs - 3000)).toBeLessThanOrEqual(50);
    expect(fin.result.heldMs).toBe(lastT - hangT);
  });

  it('pullup: 매달린 자세 300ms → 카운트다운 없이 start, 그 뒤 1회 → rep 1', () => {
    const r = new SetRunner({ exercise: 'pullup', target: { kind: 'reps', reps: 5 } });
    const c = new Clock();
    const out = feed(r, c.frames(hold(170, 500), 'elbow'));
    expect(types(out)).not.toContain('start');
    const hangT = c.t;
    feed(r, c.frames([...hold(170, 600), ...oneRep(170, 70)], 'elbow', HANG), out);
    expect(types(out)).not.toContain('countdown');
    const s = first(out, 'start')!;
    expect(s.t - hangT).toBeGreaterThanOrEqual(300);
    expect(s.t - hangT).toBeLessThan(300 + 40);
    expect(repCounts(out)).toEqual([1]);
  });

  it('pullup: 매달린 자세가 300ms 전에 끊기면 다시 잰다', () => {
    const r = new SetRunner({ exercise: 'pullup', target: { kind: 'reps', reps: 5 } });
    const c = new Clock();
    const out = feed(r, c.frames(hold(170, 200), 'elbow', HANG));
    feed(r, c.frames(hold(170, 100), 'elbow'), out);
    const hangT = c.t;
    feed(r, c.frames(hold(170, 200), 'elbow', HANG), out);
    expect(types(out)).not.toContain('start');
    feed(r, c.frames(hold(170, 300), 'elbow', HANG), out);
    expect(first(out, 'start')!.t - hangT).toBeGreaterThanOrEqual(300);
  });

  it('negative: 판정 관절이 보이자마자 start', () => {
    const r = new SetRunner({ exercise: 'negative', target: { kind: 'reps', reps: 5 } });
    const c = new Clock();
    const out = feed(r, c.frames(hold(40, 1000), 'elbow', { hidden: [13, 14, 15, 16] }));
    expect(types(out)).not.toContain('start');
    const visT = c.t;
    feed(r, c.frames(hold(40, 300), 'elbow'), out);
    expect(types(out.filter((x) => x.t >= visT))).toEqual(['start']);
    expect(first(out, 'start')!.t).toBe(visT);
  });

  it('negative: 마지막 반복 + 8000ms에 finished(idle), negativeDescentMs는 반복마다', () => {
    const r = new SetRunner({ exercise: 'negative', target: { kind: 'reps', reps: 10 } });
    const c = new Clock();
    const out = feed(r, c.frames([...hold(40, 500), ...reps(40, 170, 2, 90), ...hold(40, 9000)], 'elbow'));
    const lastRep = out.filter((x) => x.ev.type === 'rep').at(-1)!;
    const fin = finishedOf(out)!;
    expect(fin.reason).toBe('idle');
    expect(fin.result.count).toBe(2);
    expect(fin.t - lastRep.t).toBeGreaterThanOrEqual(8000);
    expect(fin.t - lastRep.t).toBeLessThan(8000 + 40);
    expect(fin.result.negativeDescentMs).toHaveLength(2);
    for (const ms of fin.result.negativeDescentMs) expect(ms).toBeGreaterThan(0);
  });
});

describe('SetRunner: 그만하기 stop', () => {
  function squatWith5(): { r: SetRunner; c: Clock; lastRepT: number } {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 5)], 'knee'));
    const reps5 = out.filter((x) => x.ev.type === 'rep');
    expect(reps5).toHaveLength(5);
    return { r, c, lastRepT: reps5.at(-1)!.t };
  }

  it('마지막 반복 0.5초 뒤 stop → 그 반복은 뺀다(5 → 4)', () => {
    const { r, lastRepT } = squatWith5();
    const evs = r.stop(lastRepT + 500);
    expect(evs.map((e) => e.type)).toEqual(['finished']);
    const fin = evs[0]!;
    expect(fin.type === 'finished' && fin.reason).toBe('manual');
    expect(r.result!.count).toBe(4);
    expect(r.result!.endT).toBe(lastRepT + 500);
    expect(r.phase).toBe('finished');
  });

  it('마지막 반복 3초 뒤 stop → 빼지 않는다', () => {
    const { r, c, lastRepT } = squatWith5();
    feed(r, c.frames(hold(175, 2900), 'knee'));
    r.stop(lastRepT + 3000);
    expect(r.result!.count).toBe(5);
    expect(r.result!.endReason).toBe('manual');
  });

  it('negative: stop으로 뺀 반복은 negativeDescentMs에서도 뺀다', () => {
    const r = new SetRunner({ exercise: 'negative', target: { kind: 'reps', reps: 10 } });
    const c = new Clock();
    // 3번째 반복이 확정된 프레임까지만 넣는다(그 뒤 프레임이 있으면 stop이 lastT 기준이 된다).
    const out = feed(r, c.frames([...hold(40, 500), ...reps(40, 170, 3, 90)], 'elbow'), [], (e) => e.type === 'rep' && e.count === 3);
    const lastRep = out.filter((x) => x.ev.type === 'rep').at(-1)!;
    // negative는 반환점에서 확정되므로 마지막 반복의 확정 시각 + 0.5초에 멈춘다.
    r.stop(lastRep.t + 500);
    expect(r.result!.count).toBe(2);
    expect(r.result!.negativeDescentMs).toHaveLength(2);
  });

  it('waitingReady에서 stop → 빈 배열, phase finished, result null', () => {
    const r = squat();
    const c = new Clock();
    feed(r, c.frames(hold(175, 300), 'knee'));
    expect(r.phase).toBe('waitingReady');
    expect(r.stop(c.t)).toEqual([]);
    expect(r.phase).toBe('finished');
    expect(r.result).toBeNull();
  });

  it('finished 뒤에는 push·tick·stop이 빈 배열', () => {
    const { r, c, lastRepT } = squatWith5();
    r.stop(lastRepT + 3000);
    expect(r.push(buildPose({ t: c.t + 4000 }))).toEqual([]);
    expect(r.tick(c.t + 9000)).toEqual([]);
    expect(r.stop(c.t + 9100)).toEqual([]);
  });
});

describe('SetRunner: 프레임 끊김(tick)', () => {
  it('active에서 2회 뒤 push 없이 tick만 → 마지막 반복 + 5000ms에 finished(idle)', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 2)], 'knee'));
    const lastRepT = out.filter((x) => x.ev.type === 'rep').at(-1)!.t;
    tickTo(r, c.t, c.t + 8000, 50, out);
    const fin = finishedOf(out)!;
    expect(fin.reason).toBe('idle');
    expect(fin.result.count).toBe(2);
    expect(fin.t - lastRepT).toBeGreaterThanOrEqual(5000);
    expect(fin.t - lastRepT).toBeLessThan(5000 + 50);
  });

  it('countdown 중 tick만으로도 2, 1, start가 나온다', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames(hold(175, 1000), 'knee'));
    const t0 = first(out, 'countdown')!.t;
    tickTo(r, c.t, t0 + 3500, 10, out);
    expect(types(out)).toEqual(['countdown', 'countdown', 'countdown', 'start']);
    expect(Math.abs(first(out, 'start')!.t - t0 - 3000)).toBeLessThanOrEqual(10);
    expect(r.phase).toBe('active');
  });

  it('tick이 한 번에 크게 건너뛰면 밀린 이벤트를 순서대로 한 배열에 담는다', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames(hold(175, 1000), 'knee'));
    const t0 = first(out, 'countdown')!.t;
    const evs = r.tick(t0 + 3000);
    expect(evs).toEqual([{ type: 'countdown', n: 2 }, { type: 'countdown', n: 1 }, { type: 'start' }]);
    expect(r.tick(t0 + 3000)).toEqual([]);
    expect(r.tick(t0 + 2000)).toEqual([]);
  });
});

describe('SetRunner: 일시정지', () => {
  it('2회 직후 10초 일시정지 → resume 뒤 4초에는 안 끝나고 5초에 idle(복귀 여유). 일시정지 중 반복은 세지 않음', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 2)], 'knee'));
    const rep2T = out.filter((x) => x.ev.type === 'rep').at(-1)!.t;
    const pauseT = c.t; // 마지막 반복 직후(약 160ms 뒤)
    r.pause(pauseT);
    const during = feed(r, c.frames(reps(175, 90, 2), 'knee'));
    expect(during).toEqual([]);
    expect(r.tick(c.t + 3000)).toEqual([]);
    const resumeT = pauseT + 10000;
    r.resume(resumeT);
    // 복귀 여유: idleFrom = max(idleFrom + d, resumeT) = resumeT(일시정지 전 흐른 약 160ms는 버린다)
    expect(pauseT - rep2T).toBeGreaterThan(0);
    const remain = 5000;
    c.t = resumeT;
    const after = feed(r, c.frames(hold(175, remain - 1000), 'knee'));
    expect(finishedOf(after)).toBeUndefined();
    expect(r.phase).toBe('active');
    feed(r, c.frames(hold(175, 1500), 'knee'), after);
    const fin = finishedOf(after)!;
    expect(fin.reason).toBe('idle');
    expect(fin.result.count).toBe(2);
    expect(fin.t - resumeT).toBeGreaterThanOrEqual(remain);
    expect(fin.t - resumeT).toBeLessThan(remain + 40);
  });

  it('카운트다운 중 일시정지하면 그만큼 start가 늦어진다', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames(hold(175, 1000), 'knee'));
    const t0 = first(out, 'countdown')!.t;
    r.pause(t0 + 500);
    r.resume(t0 + 5500);
    expect(types(tickTo(r, t0 + 5500, t0 + 7900, 10))).not.toContain('start');
    expect(r.tick(t0 + 8000).map((e) => e.type)).toEqual(['start']);
  });
});

describe('SetRunner: hint', () => {
  it('관절이 안 보이는 30초 동안 notVisible hint가 1.5, 11.5, 21.5초에 한 번씩(지속 1500ms 뒤 첫 hint)', () => {
    const r = squat();
    const c = new Clock();
    const hidden = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
    const out = feed(r, c.frames(hold(175, 30000), 'knee', { hidden }));
    const hints = out.filter((x) => x.ev.type === 'hint');
    expect(hints.map((x) => (x.ev.type === 'hint' ? x.ev.diagnosis : ''))).toEqual(['notVisible', 'notVisible', 'notVisible']);
    expect(hints[0]!.t).toBeGreaterThanOrEqual(1500);
    expect(hints[0]!.t).toBeLessThan(1500 + 40);
    // 간격은 hintRepeatMs 이상, 한 프레임(33ms) 안쪽. 프레임 격자 때문에 회마다 조금씩 늦어진다.
    for (const [a, b] of [[0, 1], [1, 2]] as const) {
      expect(hints[b]!.t - hints[a]!.t).toBeGreaterThanOrEqual(10000);
      expect(hints[b]!.t - hints[a]!.t).toBeLessThan(10000 + 40);
    }
    expect(r.phase).toBe('waitingReady');
  });

  it('calibratedByDefault hint는 세트당 한 번: 기본값 보정 뒤 active 30초 동안 정확히 1번', () => {
    // 무릎이 140·180을 오가(EMA 뒤 폭 약 13°) 안정 구간을 못 잡음 → 보정 타임아웃(3초) 뒤 관측 최고점으로 보정(진단 calibratedByDefault).
    const r = squat({ kind: 'reps', reps: 10 }, { noStartMs: 60000 });
    const c = new Clock();
    const wobble = Array.from({ length: 110 }, (_, i) => (i % 2 ? 140 : 180));
    const out = feed(r, c.frames([...wobble, ...hold(175, 4000)], 'knee'), [], (e) => e.type === 'start');
    const startT = first(out, 'start')!.t;
    expect(r.tracker.diagnosis).toBe('calibratedByDefault');
    feed(r, c.frames(hold(175, 30000), 'knee'), out);
    expect(r.phase).toBe('active');
    expect(c.t - startT).toBeGreaterThanOrEqual(30000);
    const cbd = out.filter((x) => x.ev.type === 'hint' && x.ev.diagnosis === 'calibratedByDefault');
    expect(cbd).toHaveLength(1);
  });
});

// 실제 녹화(개인 신체 데이터, git에 없음). manifest가 없으면 건너뛴다.
type ManifestEntry = { file: string; exercise: ExerciseId; expectedCount?: number; expectedHeldMs?: number };
const privateDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private');
const manifestPath = join(privateDir, 'manifest.json');

describe('SetRunner: 실녹화 (countdownMs 0)', () => {
  if (!existsSync(manifestPath)) {
    test.skip('manifest.json이 없어 건너뜀', () => {});
    return;
  }
  const manifest: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const entry of manifest) {
    test(`${entry.file} (${entry.exercise})`, () => {
      const rec = JSON.parse(readFileSync(join(privateDir, entry.file), 'utf8')) as RecordingFile;
      const target = EXERCISES[entry.exercise].kind === 'hold' ? ({ kind: 'seconds', seconds: 9999 } as const) : ({ kind: 'reps', reps: 999 } as const);
      const r = new SetRunner({ exercise: entry.exercise, target, countdownMs: 0 });
      for (const f of rec.frames) r.push(f);
      // 녹화 끝의 반복 없음은 tick으로 마무리한다. 그래도 안 끝났으면(매달린 채 끝난 녹화 등) 그만하기.
      const lastT = rec.frames.at(-1)!.t;
      for (let t = lastT + 100; t <= lastT + 10000 && r.phase !== 'finished'; t += 100) r.tick(t);
      if (r.phase !== 'finished') r.stop(lastT + 10000);
      const res = r.result;
      expect(res, `${entry.file}: 세트 결과가 없음`).not.toBeNull();
      if (entry.expectedCount !== undefined) {
        expect(Math.abs(res!.count - entry.expectedCount), `${entry.file}: 기대 ${entry.expectedCount}, 실제 ${res!.count}`).toBeLessThanOrEqual(1);
      }
      if (entry.expectedHeldMs !== undefined) {
        expect(Math.abs(res!.heldMs - entry.expectedHeldMs), `${entry.file}: 기대 ${entry.expectedHeldMs}ms, 실제 ${res!.heldMs}ms`).toBeLessThanOrEqual(1000);
      }
    });
  }
});

describe('SetRunner: 수정 1회차', () => {
  const HANG = { wristAboveNose: true } as const;
  const deadHang = () => new SetRunner({ exercise: 'deadHang', target: { kind: 'seconds', seconds: 60 } });
  const holdsOf = (xs: Timed[]) => xs.flatMap((x) => (x.ev.type === 'hold' ? [x.ev.seconds] : []));
  const heldNow = (r: SetRunner) => (r.tracker.kind === 'hold' ? r.tracker.heldMs : -1);

  describe('매달리기 heldMs와 일시정지', () => {
    it('매달린 채 pause 10초 → resume → 계속 매달림: 일시정지 시간이 빠진다', () => {
      const r = deadHang();
      const c = new Clock();
      const out = feed(r, c.frames(hold(170, 3000), 'elbow', HANG));
      const pauseT = c.t;
      r.pause(pauseT);
      r.resume(pauseT + 10000);
      c.t = pauseT + 10000;
      feed(r, c.frames(hold(170, 3000), 'elbow', HANG), out);
      feed(r, c.frames(hold(170, 1500), 'elbow'), out);
      const fin = finishedOf(out)!;
      expect(fin.reason).toBe('released');
      expect(Math.abs(fin.result.heldMs - 6000)).toBeLessThanOrEqual(100);
      // 일시정지 10초가 끼어들어도 초는 건너뛰지 않는다(놓은 프레임까지 약 6006ms → 6).
      expect(holdsOf(out)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('8초 매달림 → pause 10초 → resume → 프레임 없이 tick으로 released: heldMs는 일시정지 전 값', () => {
      const r = deadHang();
      const c = new Clock();
      feed(r, c.frames(hold(170, 8000), 'elbow', HANG));
      const before = heldNow(r);
      const pauseT = c.t;
      r.pause(pauseT);
      r.resume(pauseT + 10000);
      const out = tickTo(r, pauseT + 10100, pauseT + 13000, 100);
      const fin = finishedOf(out)!;
      expect(fin.reason).toBe('released');
      expect(fin.result.heldMs).toBe(before);
      expect(Math.abs(fin.result.heldMs - 8000)).toBeLessThanOrEqual(100);
    });

    it('pause → resume 직후 stop: heldMs는 일시정지 전 값', () => {
      const r = deadHang();
      const c = new Clock();
      feed(r, c.frames(hold(170, 4000), 'elbow', HANG));
      const before = heldNow(r);
      r.pause(c.t);
      r.resume(c.t + 10000);
      r.stop(c.t + 10000);
      expect(r.result!.heldMs).toBe(before);
    });

    it('grace 중 일시정지: 손을 놓은 시점까지만 센다', () => {
      const r = deadHang();
      const c = new Clock();
      feed(r, c.frames(hold(170, 4000), 'elbow', HANG));
      const out = feed(r, c.frames(hold(170, 200), 'elbow'));
      r.pause(c.t);
      r.resume(c.t + 10000);
      c.t += 10000;
      feed(r, c.frames(hold(170, 1000), 'elbow'), out);
      const fin = finishedOf(out)!;
      expect(fin.reason).toBe('released');
      expect(Math.abs(fin.result.heldMs - 4000)).toBeLessThanOrEqual(100);
    });
  });

  it('start 뒤 pause 5초 → resume: backToReady는 resume 시각 + 20초(복귀 여유)', () => {
    const r = squat();
    const c = new Clock();
    const out: Timed[] = [];
    const startT = squatToActive(r, c, out);
    r.pause(startT + 1000);
    r.resume(startT + 6000);
    tickTo(r, startT + 6000, startT + 26000, 10, out);
    const back = first(out, 'backToReady')!;
    expect(back).toBeDefined();
    expect(back.t - startT).toBeGreaterThanOrEqual(26000);
    expect(back.t - startT).toBeLessThan(26000 + 10);
  });

  describe('카운트다운 길이', () => {
    it('countdownMs 0이면 start만 나온다', () => {
      const r = squat(undefined, { countdownMs: 0 });
      const out = feed(r, new Clock().frames(hold(175, 1000), 'knee'), [], (e) => e.type === 'start');
      expect(types(out)).toEqual(['start']);
      expect(r.phase).toBe('active');
    });
    it('countdownMs 1500이면 1(+500ms) → start(+1500ms). 2는 1500을 넘으므로 내지 않는다', () => {
      const r = squat(undefined, { countdownMs: 1500 });
      const out: Timed[] = [];
      let entered = NaN;
      for (const f of new Clock().frames(hold(175, 3500), 'knee')) {
        for (const ev of r.push(f)) out.push({ t: f.t, ev });
        if (Number.isNaN(entered) && r.phase !== 'waitingReady') entered = f.t;
      }
      expect(types(out)).toEqual(['countdown', 'start']);
      expect(out[0]!.ev).toEqual({ type: 'countdown', n: 1 });
      expect(Math.abs(out[0]!.t - entered - 500)).toBeLessThanOrEqual(40);
      expect(Math.abs(out[1]!.t - entered - 1500)).toBeLessThanOrEqual(40);
    });
    it('countdownMs 2500이면 2 → 1(+1000) → start(+2000), 진입 순간에는 내지 않는다', () => {
      const r = squat(undefined, { countdownMs: 2500 });
      const out = feed(r, new Clock().frames(hold(175, 4000), 'knee'));
      expect(types(out)).toEqual(['countdown', 'countdown', 'start']);
      const [two, one, start] = out;
      expect(two!.ev).toEqual({ type: 'countdown', n: 2 });
      expect(one!.ev).toEqual({ type: 'countdown', n: 1 });
      expect(Math.abs(one!.t - two!.t - 1000)).toBeLessThanOrEqual(40);
      expect(Math.abs(start!.t - two!.t - 2000)).toBeLessThanOrEqual(40);
    });
  });

  describe('stop 경계', () => {
    function squatReps(k: number): { r: SetRunner; c: Clock; repTs: number[] } {
      const r = squat();
      const c = new Clock();
      const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, k)], 'knee'));
      return { r, c, repTs: out.filter((x) => x.ev.type === 'rep').map((x) => x.t) };
    }
    it('idle 시각이 이미 지난 stop은 idle로 끝난다(되돌림 없음)', () => {
      const { r, repTs } = squatReps(2);
      const evs = r.stop(repTs[1]! + 6000);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.type === 'finished' && evs[0]!.reason).toBe('idle');
      expect(r.result!.count).toBe(2);
      expect(r.result!.endReason).toBe('idle');
    });
    it('카운트다운이 끝난 시각의 stop은 밀린 countdown·start 뒤 manual로 끝난다', () => {
      const r = squat();
      const c = new Clock();
      const out = feed(r, c.frames(hold(175, 1000), 'knee'));
      const t0 = first(out, 'countdown')!.t;
      const evs = r.stop(t0 + 3500);
      expect(evs.map((e) => e.type)).toEqual(['countdown', 'countdown', 'start', 'finished']);
      expect(r.result!.endReason).toBe('manual');
      expect(r.result!.count).toBe(0);
    });
    it('lastT보다 이른 stop은 lastT 기준으로 처리한다', () => {
      const { r, c, repTs } = squatReps(5);
      feed(r, c.frames(hold(175, 3000), 'knee'));
      r.stop(repTs[4]! + 200);
      expect(r.result!.count).toBe(5);
      expect(r.result!.endT).toBe(c.t - DT);
    });
    it('일시정지 중 stop은 되돌림 기준이 pausedAt', () => {
      const { r, repTs } = squatReps(5);
      r.pause(repTs[4]! + 500);
      const evs = r.stop(repTs[4]! + 4000);
      expect(evs[0]!.type === 'finished' && evs[0]!.reason).toBe('manual');
      expect(r.result!.count).toBe(4);
    });
    it('countdown 중 stop → 빈 배열, result null', () => {
      const r = squat();
      const c = new Clock();
      feed(r, c.frames(hold(175, 1000), 'knee'));
      expect(r.phase).toBe('countdown');
      expect(r.stop(c.t)).toEqual([]);
      expect(r.phase).toBe('finished');
      expect(r.result).toBeNull();
    });
    it('stop으로 빠진 것은 마지막 반복: negativeDescentMs가 앞 두 반복의 outMs와 같다', () => {
      const frames = new Clock().frames([...hold(40, 500), ...reps(40, 170, 3, 90)], 'elbow');
      const all = replay('negative', frames).reps;
      expect(all).toHaveLength(3);
      const r = new SetRunner({ exercise: 'negative', target: { kind: 'reps', reps: 10 } });
      feed(r, frames.filter((f) => f.t <= all[2]!.endT));
      r.stop(all[2]!.endT + 500);
      expect(r.result!.negativeDescentMs).toEqual(all.slice(0, 2).map((e) => e.outMs));
    });
  });

  it('negativeDescentMs는 트래커 RepEvent의 outMs와 값이 같다', () => {
    const frames = new Clock().frames([...hold(40, 500), ...reps(40, 170, 2, 90), ...hold(40, 9000)], 'elbow');
    const r = new SetRunner({ exercise: 'negative', target: { kind: 'reps', reps: 10 } });
    const out = feed(r, frames);
    expect(finishedOf(out)!.result.negativeDescentMs).toEqual(replay('negative', frames).reps.map((e) => e.outMs));
  });

  it('waitingReady에서 resume하면 트래커를 새로 만든다(일시정지 시간으로 보정 타임아웃되지 않음)', () => {
    const r = squat();
    const c = new Clock();
    feed(r, c.frames(hold(175, 300), 'knee'));
    r.pause(c.t);
    r.resume(c.t + 10000);
    c.t += 10000;
    feed(r, c.frames(hold(175, 300), 'knee'));
    expect(r.tracker.kind === 'reps' && r.tracker.phase).toBe('calibrating');
    feed(r, c.frames(hold(175, 1000), 'knee'));
    expect(r.tracker.diagnosis).toBe('ok');
  });

  it('negative(visible)는 보이는 채로 25초 쉬어도 backToReady가 없다', () => {
    const r = new SetRunner({ exercise: 'negative', target: { kind: 'reps', reps: 5 } });
    const c = new Clock();
    const out = feed(r, c.frames(hold(40, 25000), 'elbow'));
    expect(types(out)).toEqual(['start']);
    expect(r.phase).toBe('active');
    expect(r.tick(c.t + 10000)).toEqual([]);
  });

  it('paused getter', () => {
    const r = squat();
    expect(r.paused).toBe(false);
    r.pause(0);
    expect(r.paused).toBe(true);
    r.resume(100);
    expect(r.paused).toBe(false);
  });

  it('finished 이벤트의 result와 runner.result는 서로 다른 복사본', () => {
    const r = squat({ kind: 'reps', reps: 2 });
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 2)], 'knee'));
    const fin = finishedOf(out)!;
    expect(r.result).toEqual(fin.result);
    expect(r.result).not.toBe(fin.result);
    fin.result.count = 99;
    fin.result.negativeDescentMs.push(1);
    expect(r.result!.count).toBe(2);
    expect(r.result!.negativeDescentMs).toEqual([]);
  });

  it('countdown 중에는 hint가 나오지 않는다', () => {
    const r = squat();
    const c = new Clock();
    const out = feed(r, c.frames(hold(175, 1000), 'knee'));
    expect(r.phase).toBe('countdown');
    const hidden = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
    const during = feed(r, c.frames(hold(175, 1500), 'knee', { hidden }));
    expect(r.phase).toBe('countdown');
    expect(types(during)).not.toContain('hint');
    expect(types(out)).not.toContain('hint');
  });

  it('backToReady 뒤 다시 start하면 rep이 1부터 센다', () => {
    const r = squat();
    const c = new Clock();
    const out: Timed[] = [];
    squatToActive(r, c, out);
    feed(r, c.frames(hold(175, 21000), 'knee'), out, (e) => e.type === 'backToReady');
    expect(first(out, 'backToReady')).toBeDefined();
    // 10.1(c): 준비 자세가 한 번 흐트러져야(여기서는 다리가 안 보이는 400ms 이상) 다시 시작한다.
    const hidden = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
    feed(r, c.frames(hold(175, 500), 'knee', { hidden }));
    const after = feed(r, c.frames([...hold(175, 4200), ...oneRep(175, 90)], 'knee'));
    expect(types(after).filter((t) => t === 'start')).toHaveLength(1);
    expect(repCounts(after)).toEqual([1]);
  });
});

describe('SetRunner: 2b 보강 (spec 10 (a)(b)(c))', () => {
  const HIDDEN_LEGS = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
  const HANG = { wristAboveNose: true } as const;
  const hints = (xs: Timed[]) => xs.filter((x) => x.ev.type === 'hint');
  const diagOf = (x: Timed) => (x.ev.type === 'hint' ? x.ev.diagnosis : '');

  describe('(a) hint 지속 시간', () => {
    it('같은 진단(notVisible)이 1400ms 이어지면 hint 없음, 1500ms 이어지면 hint 1번', () => {
      const r = squat();
      const c = new Clock();
      const out = feed(r, c.frames(hold(175, 1400), 'knee', { hidden: HIDDEN_LEGS }));
      expect(c.t - DT).toBeLessThan(1500);
      expect(hints(out)).toEqual([]);
      feed(r, c.frames(hold(175, 300), 'knee', { hidden: HIDDEN_LEGS }), out);
      const hs = hints(out);
      expect(hs).toHaveLength(1);
      expect(diagOf(hs[0]!)).toBe('notVisible');
      expect(hs[0]!.t).toBeGreaterThanOrEqual(1500);
      expect(hs[0]!.t).toBeLessThan(1500 + 40);
    });

    it('중간에 1프레임 ok가 끼면 처음부터 다시 잰다', () => {
      const r = squat();
      const c = new Clock();
      const out = feed(r, c.frames(hold(175, 1000), 'knee', { hidden: HIDDEN_LEGS }));
      feed(r, c.frames([175], 'knee'), out); // ok 1프레임
      const okT = c.t; // 다음 notVisible 프레임부터 다시 잰다
      feed(r, c.frames(hold(175, 1400), 'knee', { hidden: HIDDEN_LEGS }), out);
      expect(hints(out)).toEqual([]);
      feed(r, c.frames(hold(175, 300), 'knee', { hidden: HIDDEN_LEGS }), out);
      const hs = hints(out);
      expect(hs).toHaveLength(1);
      expect(hs[0]!.t - okT).toBeGreaterThanOrEqual(1500);
      expect(hs[0]!.t - okT).toBeLessThan(1500 + 40);
    });

    it('waitingReady에 들어간 뒤 2900ms 동안은 notReady가 이어져도 hint가 없고, 3000+1500ms 이후에는 나온다', () => {
      const r = squat();
      const c = new Clock();
      // 몸통이 수평이면 서 있는 준비 자세가 아니다(신호는 보이므로 notReady).
      const out = feed(r, c.frames(hold(175, 2900), 'knee', { torso: 'flat' }));
      expect(r.tracker.diagnosis).toBe('notReady');
      expect(hints(out)).toEqual([]);
      feed(r, c.frames(hold(175, 4500 - 2900 - 100), 'knee', { torso: 'flat' }), out);
      expect(c.t - DT).toBeLessThan(4500);
      expect(hints(out)).toEqual([]);
      feed(r, c.frames(hold(175, 300), 'knee', { torso: 'flat' }), out);
      const hs = hints(out);
      expect(hs).toHaveLength(1);
      expect(diagOf(hs[0]!)).toBe('notReady');
      expect(hs[0]!.t).toBeGreaterThanOrEqual(4500);
      expect(hs[0]!.t).toBeLessThan(4500 + 40);
    });

    it('notVisible에는 유예가 없다: waitingReady 처음부터 1500ms 규칙만', () => {
      const r = squat();
      const c = new Clock();
      const out = feed(r, c.frames(hold(175, 2000), 'knee', { hidden: HIDDEN_LEGS }));
      const hs = hints(out);
      expect(hs.map(diagOf)).toEqual(['notVisible']);
      expect(hs[0]!.t).toBeLessThan(1500 + 40);
    });

    it('backToReady 뒤에도 notReady 유예는 waitingReady에 들어간 시각부터 잰다', () => {
      const r = squat();
      const c = new Clock();
      const out: Timed[] = [];
      squatToActive(r, c, out);
      feed(r, c.frames(hold(175, 21000), 'knee'), out, (e) => e.type === 'backToReady');
      const backT = first(out, 'backToReady')!.t;
      c.t = backT + DT; // frames()가 21초치를 미리 만들어 시계가 앞서 있으므로 backToReady 바로 뒤로 되돌린다
      const after = feed(r, c.frames(hold(175, 4400), 'knee', { torso: 'flat' }));
      expect(hints(after)).toEqual([]);
      feed(r, c.frames(hold(175, 300), 'knee', { torso: 'flat' }), after);
      const hs = hints(after);
      expect(hs.map(diagOf)).toEqual(['notReady']);
      expect(hs[0]!.t - backT).toBeGreaterThanOrEqual(4500);
      expect(hs[0]!.t - backT).toBeLessThan(4500 + 40);
    });
  });

  describe('(b) resume 복귀 여유', () => {
    it('반복 2회 → 4초 → pause 10초 → resume: resume 뒤 4999ms까지 idle 없음, 5000ms에 idle', () => {
      const r = squat();
      const c = new Clock();
      const out = feed(r, c.frames([...hold(175, 4200), ...reps(175, 90, 2)], 'knee'));
      const rep2T = out.filter((x) => x.ev.type === 'rep').at(-1)!.t;
      const pauseT = rep2T + 4000;
      expect(r.tick(pauseT)).toEqual([]);
      r.pause(pauseT);
      const resumeT = pauseT + 10000;
      r.resume(resumeT);
      expect(r.tick(resumeT + 1000)).toEqual([]);
      expect(r.tick(resumeT + 4999)).toEqual([]);
      const evs = r.tick(resumeT + 5000);
      expect(evs.map((e) => e.type)).toEqual(['finished']);
      expect(evs[0]!.type === 'finished' && evs[0]!.reason).toBe('idle');
      expect(r.result!.count).toBe(2);
    });

    it('noStart도 같다: start → 4초 → pause 10초 → resume: resume 뒤 19999ms까지 backToReady 없음, 20000ms에 backToReady', () => {
      const r = squat();
      const c = new Clock();
      const out: Timed[] = [];
      const startT = squatToActive(r, c, out);
      const pauseT = startT + 4000;
      expect(r.tick(pauseT)).toEqual([]);
      r.pause(pauseT);
      const resumeT = pauseT + 10000;
      r.resume(resumeT);
      expect(r.tick(resumeT + 19999)).toEqual([]);
      expect(r.tick(resumeT + 20000).map((e) => e.type)).toEqual(['backToReady']);
    });
  });

  describe('(c) backToReady 뒤 다시 시작 규칙', () => {
    it('squat: backToReady 뒤 서 있기만 1분 → countdown·start·backToReady 없음. 흐트러졌다가 다시 준비 자세 → 보정 → countdown → start', () => {
      const r = squat();
      const c = new Clock();
      const out: Timed[] = [];
      squatToActive(r, c, out);
      feed(r, c.frames(hold(175, 21000), 'knee'), out, (e) => e.type === 'backToReady');
      expect(types(out).filter((t) => t === 'backToReady')).toHaveLength(1);
      const stand = feed(r, c.frames(hold(175, 60000), 'knee'));
      tickTo(r, c.t, c.t + 1000, 100, stand);
      expect(types(stand)).not.toContain('countdown');
      expect(types(stand)).not.toContain('start');
      expect(types(stand)).not.toContain('backToReady');
      expect(r.phase).toBe('waitingReady');
      // 신호 null 400ms 이상(흐트러짐) → 다시 준비 자세
      c.t += 2000;
      const again = feed(r, c.frames(hold(175, 500), 'knee', { hidden: HIDDEN_LEGS }));
      feed(r, c.frames(hold(175, 4500), 'knee'), again);
      expect(types(again).filter((t) => t !== 'hint')).toEqual(['countdown', 'countdown', 'countdown', 'start']);
      expect(r.phase).toBe('active');
    });

    it('squat: ready false(몸통 수평)로 흐트러져도 다시 시작한다', () => {
      const r = squat();
      const c = new Clock();
      const out: Timed[] = [];
      squatToActive(r, c, out);
      feed(r, c.frames(hold(175, 21000), 'knee'), out, (e) => e.type === 'backToReady');
      const stand = feed(r, c.frames(hold(175, 10000), 'knee'));
      expect(types(stand)).not.toContain('start');
      const again = feed(r, c.frames(hold(175, 500), 'knee', { torso: 'flat' }));
      feed(r, c.frames(hold(175, 4500), 'knee'), again);
      expect(types(again).filter((t) => t !== 'hint')).toEqual(['countdown', 'countdown', 'countdown', 'start']);
    });

    it('pullup: 매달린 채 20초 → backToReady → 계속 매달림 → start 없음 → 400ms 이상 내려왔다가 다시 매달림 300ms → start', () => {
      const r = new SetRunner({ exercise: 'pullup', target: { kind: 'reps', reps: 5 } });
      const c = new Clock();
      const out = feed(r, c.frames(hold(170, 500), 'elbow', HANG), [], (e) => e.type === 'start');
      const startT = first(out, 'start')!.t;
      feed(r, c.frames(hold(170, 21000), 'elbow', HANG), out, (e) => e.type === 'backToReady');
      const back = first(out, 'backToReady')!;
      expect(back.t - startT).toBeGreaterThanOrEqual(20000);
      const still = feed(r, c.frames(hold(170, 30000), 'elbow', HANG));
      expect(types(still)).not.toContain('start');
      expect(types(still)).not.toContain('backToReady');
      expect(r.phase).toBe('waitingReady');
      feed(r, c.frames(hold(170, 500), 'elbow'), still); // 내려옴(startPose false, 400ms 이상)
      const hangT = c.t;
      feed(r, c.frames(hold(170, 600), 'elbow', HANG), still);
      const s = first(still, 'start')!;
      expect(s).toBeDefined();
      expect(s.t - hangT).toBeGreaterThanOrEqual(300);
      expect(s.t - hangT).toBeLessThan(300 + 40);
    });
  });
});

describe('SetRunner: 작업 1 수정 1회차 (흐트러짐 400ms·스쿼트 굽힘·ready null·waitingForBreak)', () => {
  const HIDDEN_LEGS = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
  const HIDDEN_SHOULDERS = [LM.L_SHOULDER, LM.R_SHOULDER];

  /** squat: start → 20초 반복 없음 → backToReady. 시계는 backToReady 바로 뒤로 맞춘다 */
  function squatBack(): { r: SetRunner; c: Clock } {
    const r = squat();
    const c = new Clock();
    const out: Timed[] = [];
    squatToActive(r, c, out);
    feed(r, c.frames(hold(175, 21000), 'knee'), out, (e) => e.type === 'backToReady');
    c.t = first(out, 'backToReady')!.t + DT;
    return { r, c };
  }
  /** 첫 프레임 t0부터 마지막 프레임 t0+spanMs까지(DT 간격, 마지막은 정확히 t0+spanMs) 흐트러진 프레임 */
  function brokenSpan(c: Clock, spanMs: number, opts: Extra = { hidden: HIDDEN_LEGS }, knee = 175): PoseFrame[] {
    const t0 = c.t;
    const ts: number[] = [];
    for (let t = t0; t < t0 + spanMs; t += DT) ts.push(t);
    ts.push(t0 + spanMs);
    c.t = t0 + spanMs + DT;
    return ts.map((t) => buildPose({ ...opts, t, knee }));
  }
  const standThenStarts = (r: SetRunner, c: Clock) => types(feed(r, c.frames(hold(175, 4500), 'knee'))).includes('start');

  it('waitingForBreak: 처음 false, backToReady 뒤 서 있으면 true이고 시작 없음', () => {
    expect(squat().waitingForBreak).toBe(false);
    const { r, c } = squatBack();
    expect(r.waitingForBreak).toBe(true);
    expect(standThenStarts(r, c)).toBe(false);
    expect(r.waitingForBreak).toBe(true);
  });

  it('1프레임 흐트러짐(visibility 깜빡임)으로는 다시 시작하지 않는다', () => {
    const { r, c } = squatBack();
    feed(r, c.frames([175], 'knee', { hidden: HIDDEN_LEGS }));
    expect(standThenStarts(r, c)).toBe(false);
    expect(r.waitingForBreak).toBe(true);
  });

  it('399ms 흐트러짐으로는 다시 시작하지 않는다', () => {
    const { r, c } = squatBack();
    feed(r, brokenSpan(c, 399));
    expect(r.waitingForBreak).toBe(true);
    expect(standThenStarts(r, c)).toBe(false);
  });

  it('400ms 흐트러짐 → 다시 준비 자세 → 보정 → countdown → start', () => {
    const { r, c } = squatBack();
    feed(r, brokenSpan(c, 400));
    expect(r.waitingForBreak).toBe(false);
    const again = feed(r, c.frames(hold(175, 4500), 'knee'));
    expect(types(again).filter((t) => t !== 'hint')).toEqual(['countdown', 'countdown', 'countdown', 'start']);
  });

  it('흐트러짐 중간에 흐트러지지 않은 프레임이 하나 끼면 처음부터 다시 잰다', () => {
    const { r, c } = squatBack();
    feed(r, brokenSpan(c, 300));
    feed(r, c.frames([175], 'knee'));
    feed(r, brokenSpan(c, 300));
    expect(r.waitingForBreak).toBe(true);
  });

  it('squat: 무릎 120°(minBaseline 150 미만)로 400ms 이상 → 흐트러짐 인정 → 다시 서서 보정 → start', () => {
    const { r, c } = squatBack();
    feed(r, c.frames(hold(120, 500), 'knee'));
    expect(r.waitingForBreak).toBe(false);
    const again = feed(r, c.frames(hold(175, 4500), 'knee'));
    expect(types(again).filter((t) => t !== 'hint')).toEqual(['countdown', 'countdown', 'countdown', 'start']);
  });

  it('squat: 무릎 155°(minBaseline 이상)는 흐트러짐이 아니다', () => {
    const { r, c } = squatBack();
    feed(r, c.frames(hold(155, 1000), 'knee'));
    expect(r.waitingForBreak).toBe(true);
  });

  it('ready null(어깨가 화면 밖, 다리는 보임)로 400ms 이상 → 흐트러짐 인정', () => {
    const { r, c } = squatBack();
    feed(r, c.frames(hold(175, 500), 'knee', { hidden: HIDDEN_SHOULDERS }));
    expect(r.waitingForBreak).toBe(false);
  });

  it('흐트러짐을 기다리는 동안에는 hint가 나오지 않는다', () => {
    const { r, c } = squatBack();
    const out = feed(r, c.frames(hold(175, 15000), 'knee'));
    expect(types(out)).not.toContain('hint');
  });

  it('흐트러짐을 기다리는 중 pause → resume(직접 누른 다시 시작)이면 기다림을 푼다', () => {
    const { r, c } = squatBack();
    expect(r.waitingForBreak).toBe(true);
    r.pause(c.t);
    r.resume(c.t + 3000);
    c.t += 3000;
    expect(r.waitingForBreak).toBe(false);
    expect(standThenStarts(r, c)).toBe(true);
  });
});

describe('SetRunner: count·heldMs 조회 (2b 작업 2)', () => {
  it('reps: start 전 0, start 뒤 센 반복 수, 끝난 뒤에도 결과와 같다. heldMs는 0', () => {
    const r = new SetRunner({ exercise: 'squat', target: { kind: 'reps', reps: 3 }, countdownMs: 0 });
    expect(r.count).toBe(0);
    expect(r.heldMs).toBe(0);
    const c = new Clock();
    const out = feed(r, c.frames([...hold(175, 1000), ...reps(175, 90, 2)], 'knee'));
    expect(types(out).filter((t) => t === 'rep')).toHaveLength(2);
    expect(r.count).toBe(2);
    expect(r.heldMs).toBe(0);
    feed(r, c.frames([...reps(175, 90, 1), ...hold(175, 3000)], 'knee'), out, (e) => e.type === 'finished');
    expect(r.phase).toBe('finished');
    expect(r.count).toBe(r.result!.count);
    expect(r.count).toBe(3);
  });

  it('deadHang: heldMs는 매달린 시간(일시정지 제외), count는 0', () => {
    const r = new SetRunner({ exercise: 'deadHang', target: { kind: 'seconds', seconds: 30 } });
    expect(r.heldMs).toBe(0);
    const c = new Clock();
    feed(r, c.frames(hold(170, 500), 'elbow'));
    feed(r, c.frames(hold(170, 3000), 'elbow', { wristAboveNose: true } as const));
    expect(r.count).toBe(0);
    expect(Math.abs(r.heldMs - 3000)).toBeLessThanOrEqual(400);
    const h = r.heldMs;
    r.pause(c.t);
    expect(r.heldMs).toBe(h);
  });
});
