import { describe, expect, it } from 'vitest';
import { EXERCISES, createTracker, replay } from '../src/exercises/runner';
import type { ExerciseId } from '../src/exercises/definitions';
import { LM } from '../src/types';
import { buildPose, series } from './helpers/poseBuilder';

/** a에서 b로 n프레임 선형 변화(끝점 제외) */
function lin(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / n);
}
/** rest → bottom → rest 한 번. */
function oneRep(rest: number, bottom: number, n = 15): number[] {
  return [...Array(5).fill(rest), ...lin(rest, bottom, n), ...Array(3).fill(bottom), ...lin(bottom, rest, n), ...Array(5).fill(rest)];
}

describe('운동 6종: 완전한 1회', () => {
  it('squat: 무릎 175→90→175', () => {
    expect(replay('squat', series(oneRep(175, 90), 'knee')).count).toBe(1);
  });
  it('pushup: 팔꿈치 170→85→170', () => {
    expect(replay('pushup', series(oneRep(170, 85), 'elbow')).count).toBe(1);
  });
  it('dumbbellBench: 양팔 170→85→170', () => {
    expect(replay('dumbbellBench', series(oneRep(170, 85), 'elbow')).count).toBe(1);
  });
  it('pullup: 팔꿈치 170→70→170', () => {
    expect(replay('pullup', series(oneRep(170, 70), 'elbow')).count).toBe(1);
  });
  it('negative: 팔꿈치 40→170→40', () => {
    expect(replay('negative', series(oneRep(40, 170, 90), 'elbow')).count).toBe(1);
  });
  it('푸시업: 맨 위가 155°까지만 펴지고 바닥이 115°까지만 내려가는 반복 3회 → 3', () => {
    // 실측(옆 바닥 촬영): 위 155~157, 바닥 90~114. 한 회 43프레임 x 33ms = 약 1.4초.
    const v = [...oneRep(155, 115), ...oneRep(155, 115), ...oneRep(155, 115)];
    expect(replay('pushup', series(v, 'elbow')).count).toBe(3);
  });
  it('2회 연속이면 2', () => {
    const v = [...oneRep(170, 85), ...oneRep(170, 85)];
    expect(replay('pushup', series(v, 'elbow')).count).toBe(2);
  });
});

describe('pullup은 팔꿈치 각도로만 판별', () => {
  it('손목이 코 아래여도 80° 이하로 굽혔다 펴면 1', () => {
    const frames = series(oneRep(170, 75), 'elbow', 33, { wristAboveNose: false });
    expect(replay('pullup', frames).count).toBe(1);
  });
  it('손목이 코 위여도 마찬가지로 1', () => {
    const frames = series(oneRep(170, 75), 'elbow', 33, { wristAboveNose: true });
    expect(replay('pullup', frames).count).toBe(1);
  });
});

describe('dumbbellBench', () => {
  it('한쪽 팔이 안 보이면 신호 null: count 0, paused', () => {
    const frames = series(oneRep(170, 85), 'elbow', 33, { hidden: [LM.L_ELBOW, LM.L_WRIST] });
    const r = replay('dumbbellBench', frames);
    expect(r.count).toBe(0);
    expect(r.paused).toBe(true);
  });
  it('한쪽 팔(13,15)만 hidden이어도 마찬가지', () => {
    const frames = series(oneRep(170, 85), 'elbow', 33, { hidden: [13, 15] });
    const r = replay('dumbbellBench', frames);
    expect(r.count).toBe(0);
    expect(r.paused).toBe(true);
  });
});

describe('negative', () => {
  it('outMs는 내려온(40→170) 구간 시간', () => {
    // 100 초과 시점 ~ 140 이상 시점. 선형 40→170을 60프레임(약 2000ms)에 걸쳐 진행.
    const n = 90;
    const frames = series(oneRep(40, 170, n), 'elbow');
    const r = replay('negative', frames);
    expect(r.reps).toHaveLength(1);
    // 100→140 구간은 전체의 40/130. EMA 지연이 같은 폭으로 양쪽에 걸리므로 시간차는 유지된다.
    const expected = (40 / 130) * n * 33;
    expect(Math.abs(r.reps[0]!.outMs - expected)).toBeLessThanOrEqual(50);
  });
});

describe('deadHang', () => {
  it('손목이 코보다 위, 팔꿈치 170으로 5초 → heldMs 약 5000', () => {
    const frames = Array.from({ length: 152 }, (_, i) =>
      buildPose({ t: i * 33, elbow: 170, wristAboveNose: true }),
    );
    const r = replay('deadHang', frames);
    expect(Math.abs(r.heldMs - 5000)).toBeLessThanOrEqual(100);
    expect(r.count).toBe(0);
  });
  it('손목이 코 아래면 시간이 올라가지 않는다', () => {
    const frames = Array.from({ length: 60 }, (_, i) => buildPose({ t: i * 33, elbow: 170 }));
    expect(replay('deadHang', frames).heldMs).toBe(0);
  });
  it('팔꿈치가 구부러지면(< 150) holding이 아니다', () => {
    const frames = Array.from({ length: 60 }, (_, i) =>
      buildPose({ t: i * 33, elbow: 110, wristAboveNose: true }),
    );
    expect(replay('deadHang', frames).heldMs).toBe(0);
  });
  it('관련 랜드마크가 안 보이면 paused', () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      buildPose({ t: i * 33, elbow: 170, wristAboveNose: true, hidden: [LM.NOSE] }),
    );
    expect(replay('deadHang', frames).paused).toBe(true);
  });
});

describe('createTracker와 replay', () => {
  const cases: Array<[ExerciseId, ReturnType<typeof series>]> = [
    ['squat', series(oneRep(175, 90), 'knee')],
    ['pushup', series(oneRep(170, 85), 'elbow')],
    ['negative', series(oneRep(40, 170, 90), 'elbow')],
  ];
  it.each(cases)('%s: 프레임 단위 push 결과 = replay 결과', (id, frames) => {
    const tr = createTracker(id);
    let last = tr.state();
    for (const f of frames) last = tr.push(f);
    const { reps, ...rest } = replay(id, frames);
    expect(last).toEqual(rest);
    expect(tr.state()).toEqual(last);
    expect(reps.length).toBe(last.count);
    expect(last.lastRep).toEqual(reps[reps.length - 1] ?? null);
  });

  it('push는 각 프레임에서 즉시 현재 상태를 돌려준다', () => {
    const tr = createTracker('squat');
    const frames = series(oneRep(175, 90), 'knee');
    const counts = frames.map((f) => tr.push(f).count);
    // 완료 프레임 이전에는 0, 마지막에는 1. 중간에 줄어들지 않는다.
    expect(counts[0]).toBe(0);
    expect(counts[counts.length - 1]).toBe(1);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
  });

  it('EXERCISES는 6종을 모두 가진다', () => {
    expect(Object.keys(EXERCISES).sort()).toEqual(
      ['deadHang', 'dumbbellBench', 'negative', 'pullup', 'pushup', 'squat'],
    );
  });
});

describe('NaN 방어', () => {
  /** 한 프레임(index 3)의 양쪽 어깨·팔꿈치 좌표를 같게 만들어 각도를 NaN으로 만든다. */
  function poison(frames: ReturnType<typeof series>) {
    return frames.map((f, i) => {
      if (i !== 3) return f;
      const bad = buildPose({ t: f.t, elbow: 170 });
      for (const side of [0, 1]) {
        const s = bad.world[LM.L_SHOULDER + side]!;
        const e = bad.world[LM.L_ELBOW + side]!;
        e.x = s.x; e.y = s.y; e.z = s.z;
      }
      return bad;
    });
  }

  it.each([
    ['pushup', 85],
    ['pullup', 70],
    ['dumbbellBench', 85],
    ['negative', -1],
  ] as const)('%s: NaN 각도 프레임이 끼어도 이후 반복이 정상적으로 세진다', (id, bottom) => {
    const v = id === 'negative' ? oneRep(40, 170, 90) : oneRep(170, bottom);
    expect(replay(id, poison(series(v, 'elbow'))).count).toBe(1);
  });

  it('squat도 마찬가지(무릎)', () => {
    const frames = series(oneRep(175, 90), 'knee').map((f, i) => {
      if (i !== 3) return f;
      const bad = buildPose({ t: f.t });
      for (const side of [0, 1]) {
        const h = bad.world[LM.L_HIP + side]!;
        const k = bad.world[LM.L_KNEE + side]!;
        k.x = h.x; k.y = h.y; k.z = h.z;
      }
      return bad;
    });
    expect(replay('squat', frames).count).toBe(1);
  });
});

describe('pullup·negative 신호는 양팔 팔꿈치 각도 평균', () => {
  /** 왼팔은 left도, 오른팔은 right도인 포즈(오른팔 좌표를 다른 포즈에서 가져옴). */
  function asym(left: number, right: number, opts: { hidden?: number[] } = {}) {
    const a = buildPose({ t: 0, elbow: left, ...opts });
    const b = buildPose({ t: 0, elbow: right });
    for (const i of [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]) {
      a.world[i] = { ...b.world[i]! };
      a.image[i] = { ...b.image[i]!, visibility: a.image[i]!.visibility };
    }
    return a;
  }
  const uniform = (id: 'pullup' | 'negative', deg: number) =>
    EXERCISES[id].kind === 'reps' ? (EXERCISES[id] as { signal(f: unknown): number | null }).signal(buildPose({ t: 0, elbow: deg })) : null;
  const sig = (id: 'pullup' | 'negative', f: ReturnType<typeof buildPose>) =>
    (EXERCISES[id] as { signal(f: unknown): number | null }).signal(f);

  it.each(['pullup', 'negative'] as const)('%s: 왼팔 120, 오른팔 160이면 평균', (id) => {
    const expected = (uniform(id, 120)! + uniform(id, 160)!) / 2;
    expect(sig(id, asym(120, 160))).toBeCloseTo(expected, 5);
    // 가시성이 한쪽이 높아도(왼팔) 평균이어야 한다
    const f = asym(120, 160);
    for (const i of [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST]) f.image[i]!.visibility = 0.6;
    expect(sig(id, f)).toBeCloseTo(expected, 5);
  });

  it.each(['pullup', 'negative'] as const)('%s: 한쪽 팔만 보이면 그쪽 값', (id) => {
    const f = asym(120, 160, { hidden: [LM.L_ELBOW, LM.L_WRIST] });
    expect(sig(id, f)).toBeCloseTo(uniform(id, 160)!, 5);
    const g = asym(120, 160);
    for (const i of [LM.R_ELBOW, LM.R_WRIST]) g.image[i]!.visibility = 0;
    expect(sig(id, g)).toBeCloseTo(uniform(id, 120)!, 5);
  });

  it.each(['pullup', 'negative'] as const)('%s: 둘 다 안 보이면 null', (id) => {
    const f = buildPose({ t: 0, elbow: 120, hidden: [LM.L_ELBOW, LM.L_WRIST, LM.R_ELBOW, LM.R_WRIST] });
    expect(sig(id, f)).toBeNull();
  });
});

describe('negative: 바닥에 닿는 즉시 센다', () => {
  it('enter→turn이 약 300ms인 빠른 내려오기도 1회(교정은 outMs로 따로)', () => {
    const v = [...Array(5).fill(40), ...lin(40, 170, 30), ...Array(10).fill(170)];
    const r = replay('negative', series(v, 'elbow'));
    expect(r.count).toBe(1);
    expect(r.reps[0]!.outMs).toBeLessThan(400);
  });
  it('위(40)에서 바닥(170)까지 내려가고 끝나도 1', () => {
    const v = [...Array(5).fill(40), ...lin(40, 170, 90), ...Array(10).fill(170)];
    expect(replay('negative', series(v, 'elbow')).count).toBe(1);
  });
});
