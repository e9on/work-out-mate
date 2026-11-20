import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, test } from 'vitest';
import { SetRunner, type SetConfig, type SetEvent } from '../src/session/setRunner';
import { EXERCISES, type ExerciseId } from '../src/exercises/runner';
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
    const out = feed(r, c.frames([...hold(40, 500), ...reps(40, 170, 3, 90)], 'elbow'));
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
  it('2회 뒤 10초 일시정지 → resume 뒤 4초에는 안 끝나고 5초에 idle. 일시정지 중 반복은 세지 않음', () => {
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
    const remain = 5000 - (pauseT - rep2T);
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
  it('관절이 안 보이는 30초 동안 notVisible hint가 0, 10, 20초에 한 번씩', () => {
    const r = squat();
    const c = new Clock();
    const hidden = [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE];
    const out = feed(r, c.frames(hold(175, 30000), 'knee', { hidden }));
    const hints = out.filter((x) => x.ev.type === 'hint');
    expect(hints.map((x) => (x.ev.type === 'hint' ? x.ev.diagnosis : ''))).toEqual(['notVisible', 'notVisible', 'notVisible']);
    expect(hints[0]!.t).toBe(0);
    // 간격은 hintRepeatMs 이상, 한 프레임(33ms) 안쪽. 프레임 격자 때문에 회마다 조금씩 늦어진다.
    for (const [a, b] of [[0, 1], [1, 2]] as const) {
      expect(hints[b]!.t - hints[a]!.t).toBeGreaterThanOrEqual(10000);
      expect(hints[b]!.t - hints[a]!.t).toBeLessThan(10000 + 40);
    }
    expect(r.phase).toBe('waitingReady');
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
