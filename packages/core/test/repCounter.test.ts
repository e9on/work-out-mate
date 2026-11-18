import { describe, expect, it } from 'vitest';
import { RepCounter, type RepConfig, type RepEvent } from '../src/counter/repCounter';

const CFG: RepConfig = { restSide: 'high', enter: 150, turn: 95, exit: 160, minRepMs: 500, pauseAfterMs: 1500 };
const DT = 33;

type Frame = [number, number | null];

/** t부터 a→b로 ms 동안 선형 변화하는 프레임(33ms 간격). 시작점 포함, 끝점 제외. */
function ramp(t0: number, a: number, b: number, ms: number): Frame[] {
  const n = Math.max(1, Math.round(ms / DT));
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) out.push([t0 + i * DT, a + ((b - a) * i) / n]);
  return out;
}

/** 구간들을 이어 붙인다. [값, 지속ms] 목록의 인접 값 사이를 보간. */
function path(points: Array<[number, number]>, t0 = 0): Frame[] {
  // points: [value, msToReachFromPrevious]; 첫 점은 시작값(ms 무시)
  const frames: Frame[] = [];
  let t = t0;
  for (let i = 1; i < points.length; i++) {
    const seg = ramp(t, points[i - 1]![0], points[i]![0], points[i]![1]);
    frames.push(...seg);
    t = seg[seg.length - 1]![0] + DT;
  }
  frames.push([t, points[points.length - 1]![0]]);
  return frames;
}

function run(c: RepCounter, frames: Frame[]): RepEvent[] {
  const ev: RepEvent[] = [];
  for (const [t, v] of frames) {
    const e = c.update(t, v);
    if (e) ev.push(e);
  }
  return ev;
}

describe('RepCounter', () => {
  it('완전한 1회', () => {
    const c = new RepCounter(CFG);
    const ev = run(c, path([[170, 0], [90, 600], [170, 600]]));
    expect(c.count).toBe(1);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.index).toBe(1);
    expect(ev[0]!.outMs).toBe(ev[0]!.turnT - ev[0]!.startT);
    expect(ev[0]!.outMs).toBeGreaterThan(350);
    expect(ev[0]!.outMs).toBeLessThan(700);
    expect(ev[0]!.backMs).toBe(ev[0]!.endT - ev[0]!.turnT);
    expect(c.phase).toBe('rest');
  });

  it('3회 연속', () => {
    const c = new RepCounter(CFG);
    const one = (t0: number) => path([[170, 0], [90, 600], [170, 600]], t0);
    let frames: Frame[] = [];
    let t = 0;
    for (let i = 0; i < 3; i++) {
      const f = one(t);
      frames = frames.concat(f);
      t = f[f.length - 1]![0] + DT;
    }
    const ev = run(c, frames);
    expect(c.count).toBe(3);
    expect(ev.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it('가만히 서 있음', () => {
    const c = new RepCounter(CFG);
    const frames: Frame[] = [];
    for (let i = 0; i < 300; i++) frames.push([i * DT, 170 + 3 * Math.sin(i * 1.7)]);
    run(c, frames);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('임계값 근처 떨림', () => {
    const c = new RepCounter(CFG);
    const frames: Frame[] = [];
    let t = 0;
    for (let i = 0; i < 50; i++) {
      frames.push([t, 148]); t += DT;
      frames.push([t, 162]); t += DT;
    }
    run(c, frames);
    expect(c.count).toBe(0);
  });

  it('반만 내려감', () => {
    const c = new RepCounter(CFG);
    run(c, path([[170, 0], [120, 600], [170, 600]]));
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('너무 빠름 (전체 200ms)', () => {
    const c = new RepCounter(CFG);
    run(c, path([[170, 0], [90, 100], [170, 100]]));
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('빠른 하강 회귀: 150→100° 구간 약 200ms여도 전체가 충분하면 1회', () => {
    const c = new RepCounter(CFG);
    const ev = run(c, path([[170, 0], [150, 300], [100, 200], [90, 100], [170, 1000]]));
    expect(c.count).toBe(1);
    expect(ev[0]!.outMs).toBeLessThan(250);
    expect(ev[0]!.endT - ev[0]!.startT).toBeGreaterThanOrEqual(500);
  });

  it('전체가 너무 짧은 반복(400ms)은 세지 않음', () => {
    const c = new RepCounter(CFG);
    const ev = run(c, [[0, 170], [100, 140], [250, 90], [500, 165], [533, 170]]);
    expect(ev).toHaveLength(0);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('경계: 전체 정확히 500ms면 1회, 499ms면 0회', () => {
    const mk = (endT: number): Frame[] => [[0, 170], [100, 140], [300, 90], [endT, 165], [endT + 33, 170]];
    const a = new RepCounter(CFG);
    const evA = run(a, mk(600));
    expect(evA).toHaveLength(1);
    expect(evA[0]!.endT - evA[0]!.startT).toBe(500);
    const b = new RepCounter(CFG);
    run(b, mk(599));
    expect(b.count).toBe(0);
  });

  it('처음부터 바닥(90)에서 추적을 시작해 올라오면 세지 않고, 그 뒤 정상 1회는 센다', () => {
    const c = new RepCounter(CFG);
    const up = path([[90, 0], [170, 600]]);
    expect(run(c, up)).toHaveLength(0);
    expect(c.count).toBe(0);
    const t0 = up[up.length - 1]![0] + DT;
    const ev = run(c, path([[170, 0], [90, 600], [170, 600]], t0));
    expect(ev).toHaveLength(1);
    expect(c.count).toBe(1);
  });

  it('restSide low: 올린 자세(155)에서 시작해 내려오면 세지 않음', () => {
    const c = new RepCounter({ restSide: 'low', enter: 70, turn: 150, exit: 60, minRepMs: 500, pauseAfterMs: 1500 });
    const down = path([[160, 0], [160, 100], [50, 600]]);
    expect(run(c, down)).toHaveLength(0);
    expect(c.count).toBe(0);
    const t0 = down[down.length - 1]![0] + DT;
    run(c, path([[50, 0], [155, 600], [50, 600]], t0));
    expect(c.count).toBe(1);
  });

  it('불규칙 간격', () => {
    const c = new RepCounter(CFG);
    const frames: Frame[] = [
      [0, 170], [33, 170], [66, 168],
      [100, 140], // startT
      [300, 120],
      [333, 100],
      [533, 90], // turnT
      [566, 92],
      [766, 130],
      [800, 150],
      [1000, 165], // endT
      [1033, 170],
    ];
    const ev = run(c, frames);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(100);
    expect(ev[0]!.turnT).toBe(533);
    expect(ev[0]!.endT).toBe(1000);
    expect(ev[0]!.outMs).toBe(433);
    expect(ev[0]!.backMs).toBe(467);
  });

  it('잠깐 가림', () => {
    const c = new RepCounter(CFG);
    const down = path([[170, 0], [90, 600]]);
    let t = down[down.length - 1]![0] + DT;
    const frames: Frame[] = [...down];
    for (let i = 0; i < 10; i++) { frames.push([t, null]); t += DT; }
    frames.push(...path([[90, 0], [170, 600]], t));
    let paused = false;
    for (const [tt, v] of frames) {
      c.update(tt, v);
      if (v === null) paused = c.phase === 'paused' || paused;
    }
    expect(paused).toBe(true);
    expect(c.count).toBe(1);
  });

  it('오래 가림', () => {
    const c = new RepCounter(CFG);
    const down = path([[170, 0], [90, 600]]);
    run(c, down);
    let t = down[down.length - 1]![0] + DT;
    const nullStart = t;
    for (; t < nullStart + 2000; t += DT) {
      c.update(t, null);
      expect(c.phase).toBe('paused');
    }
    const ev = run(c, path([[90, 0], [170, 600]], t));
    expect(ev).toHaveLength(0);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('restSide low (네거티브)', () => {
    const c = new RepCounter({ restSide: 'low', enter: 70, turn: 150, exit: 60, minRepMs: 500, pauseAfterMs: 1500 });
    run(c, path([[50, 0], [155, 600], [50, 600]]));
    expect(c.count).toBe(1);
  });

  it('reset은 count와 상태를 처음으로', () => {
    const c = new RepCounter(CFG);
    run(c, path([[170, 0], [90, 600], [170, 600]]));
    c.reset();
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });
});
