import { describe, expect, it } from 'vitest';
import { EXERCISES, createTracker, replay } from '../src/exercises/runner';
import { LM } from '../src/types';
import type { TrackerState } from '../src/exercises/runner';
import { buildPose, series } from './helpers/poseBuilder';

/** 준비 자세 보정 중인지(reps 상태의 phase) */
const isCal = (s: TrackerState) => s.kind === 'reps' && s.phase === 'calibrating';

/** a에서 b로 n프레임 선형 변화(끝점 제외) */
function lin(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / n);
}
/** rest → bottom → rest 한 번. */
function oneRep(rest: number, bottom: number, n = 15): number[] {
  return [...Array(5).fill(rest), ...lin(rest, bottom, n), ...Array(3).fill(bottom), ...lin(bottom, rest, n), ...Array(5).fill(rest)];
}
/**
 * 준비 자세 v에서 약 1초(30프레임) 정지. squat·pushup·dumbbellBench는 준비 자세를 기준으로
 * 보정(700ms 정지)한 뒤에 세므로 합성 반복 앞에 붙인다.
 */
/** 푸시업·벤치의 준비 자세(엎드림·누움): image 몸통이 수평 */
const FLAT = { torso: 'flat' } as const;
function ready(v: number): number[] {
  return Array(30).fill(v);
}

describe('운동 6종: 완전한 1회', () => {
  it('squat: 무릎 175→90→175', () => {
    expect(replay('squat', series([...ready(175), ...oneRep(175, 90)], 'knee')).count).toBe(1);
  });
  it('pushup: 팔꿈치 170→85→170', () => {
    expect(replay('pushup', series([...ready(170), ...oneRep(170, 85)], 'elbow', 33, FLAT)).count).toBe(1);
  });
  it('dumbbellBench: 양팔 170→85→170', () => {
    expect(replay('dumbbellBench', series([...ready(170), ...oneRep(170, 85)], 'elbow', 33, FLAT)).count).toBe(1);
  });
  it('pullup: 팔꿈치 170→70→170', () => {
    expect(replay('pullup', series(oneRep(170, 70), 'elbow')).count).toBe(1);
  });
  it('negative: 팔꿈치 40→170→40', () => {
    expect(replay('negative', series(oneRep(40, 170, 90), 'elbow')).count).toBe(1);
  });
  it('푸시업: 맨 위가 155°까지만 펴지고 바닥이 115°까지만 내려가는 반복 3회 → 3', () => {
    // 실측(옆 바닥 촬영): 준비 자세 166~169, 위 155~157, 바닥 90~114. 한 회 43프레임 x 33ms = 약 1.4초.
    const v = [...ready(168), ...oneRep(155, 115), ...oneRep(155, 115), ...oneRep(155, 115)];
    expect(replay('pushup', series(v, 'elbow', 33, FLAT)).count).toBe(3);
  });
  it('푸시업: 카메라 각도로 전체가 −15° 밀려도(준비 153, 위 140, 바닥 100) 3회 → 3', () => {
    // 고정 임계값(복귀>150)으로는 맨 위 140이 복귀선을 못 넘어 0이 된다.
    const v = [...ready(153), ...oneRep(140, 100), ...oneRep(140, 100), ...oneRep(140, 100)];
    expect(replay('pushup', series(v, 'elbow', 33, FLAT)).count).toBe(3);
  });
  it('2회 연속이면 2', () => {
    const v = [...ready(170), ...oneRep(170, 85), ...oneRep(170, 85)];
    expect(replay('pushup', series(v, 'elbow', 33, FLAT)).count).toBe(2);
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
  it('한쪽 팔(왼쪽)이 안 보여도 보이는 팔로 1회를 세고 paused는 false', () => {
    const frames = series([...ready(170), ...oneRep(170, 85)], 'elbow', 33, { ...FLAT, hidden: [LM.L_ELBOW, LM.L_WRIST] });
    const r = replay('dumbbellBench', frames);
    expect(r.count).toBe(1);
    expect(r.diagnosis).toBe('ok');
  });
  it('한쪽 팔(13,15)만 hidden이어도 마찬가지', () => {
    const frames = series([...ready(170), ...oneRep(170, 85)], 'elbow', 33, { ...FLAT, hidden: [13, 15] });
    const r = replay('dumbbellBench', frames);
    expect(r.count).toBe(1);
    expect(r.diagnosis).toBe('ok');
  });
  it('양팔이 모두 hidden이면 count 0, paused', () => {
    const frames = series(oneRep(170, 85), 'elbow', 33, { hidden: [13, 15, 14, 16] });
    const r = replay('dumbbellBench', frames);
    expect(r.count).toBe(0);
    expect(r.diagnosis).toBe('notVisible');
  });
});

describe('negative', () => {
  it('outMs는 내려온(40→170) 구간 시간', () => {
    // 100 초과 시점 ~ 140 이상 시점. 선형 40→170을 90프레임(약 3000ms)에 걸쳐 진행.
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
    expect(r.reps).toHaveLength(0);
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
    expect(replay('deadHang', frames).diagnosis).toBe('notVisible');
  });
});

describe('createTracker와 replay', () => {
  const cases: Array<['squat' | 'pushup' | 'negative', ReturnType<typeof series>]> = [
    ['squat', series([...ready(175), ...oneRep(175, 90)], 'knee')],
    ['pushup', series([...ready(170), ...oneRep(170, 85)], 'elbow', 33, FLAT)],
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
    const frames = series([...ready(175), ...oneRep(175, 90)], 'knee');
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
    const v = id === 'negative' ? oneRep(40, 170, 90) : [...ready(170), ...oneRep(170, bottom)];
    const flat = id === 'pushup' || id === 'dumbbellBench' ? FLAT : {};
    expect(replay(id, poison(series(v, 'elbow', 33, flat))).count).toBe(1);
  });

  it('squat도 마찬가지(무릎)', () => {
    const frames = series([...ready(175), ...oneRep(175, 90)], 'knee').map((f, i) => {
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
    EXERCISES[id].signal(buildPose({ t: 0, elbow: deg }));
  const sig = (id: 'pullup' | 'negative', f: ReturnType<typeof buildPose>) =>
    EXERCISES[id].signal(f);

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

describe('준비 자세 보정 상태(phase === calibrating)', () => {
  it.each(['squat', 'pushup', 'dumbbellBench'] as const)('%s: 처음엔 calibrating, 1초 정지 뒤 false', (id) => {
    const key = id === 'squat' ? 'knee' : 'elbow';
    const tr = createTracker(id);
    const frames = series(ready(170), key, 33, id === 'squat' ? {} : FLAT);
    expect(isCal(tr.push(frames[0]!))).toBe(true);
    let last = tr.state();
    for (const f of frames.slice(1)) last = tr.push(f);
    expect(isCal(last)).toBe(false);
  });
  it.each(['pullup', 'negative', 'deadHang'] as const)('%s: 보정 없음(항상 false)', (id) => {
    const tr = createTracker(id);
    expect(isCal(tr.push(buildPose({ t: 0, elbow: 170 })))).toBe(false);
  });
});

describe('수정 1회차: 준비 자세 확인(몸통 방향)', () => {
  const at = (frames: ReturnType<typeof series>, t0: number) => frames.map((f) => ({ ...f, t: f.t + t0 }));

  it('pushup: 서 있는 자세(몸통 수직, 팔 170°)로 1초 가만히 있어도 보정되지 않는다', () => {
    const tr = createTracker('pushup');
    let s = tr.state();
    for (const f of series(ready(170), 'elbow')) s = tr.push(f);
    expect(isCal(s)).toBe(true);
    expect(s.baseline).toBeNull();
  });

  it('pushup: 서 있다가 엎드려(수평) 1초 → 보정 → 반복 3회 → 3', () => {
    const standing = series([...ready(170), ...ready(170)], 'elbow');
    const t0 = standing[standing.length - 1]!.t + 33;
    const v = [...ready(168), ...oneRep(155, 115), ...oneRep(155, 115), ...oneRep(155, 115)];
    const r = replay('pushup', [...standing, ...at(series(v, 'elbow', 33, FLAT), t0)]);
    expect(isCal(r)).toBe(false);
    expect(r.baseline).toBeCloseTo(168, 0);
    expect(r.count).toBe(3);
  });

  it('pushup: 서서 팔을 굽혔다 편 뒤 엎드려도 가짜 1회가 생기지 않는다', () => {
    const standing = series([...ready(170), ...oneRep(170, 90)], 'elbow');
    const t0 = standing[standing.length - 1]!.t + 33;
    const r = replay('pushup', [...standing, ...at(series(ready(168), 'elbow', 33, FLAT), t0)]);
    expect(r.count).toBe(0);
  });

  it('squat: 수평 자세는 보정되지 않는다', () => {
    const tr = createTracker('squat');
    let s = tr.state();
    for (const f of series(ready(175), 'knee', 33, FLAT)) s = tr.push(f);
    expect(isCal(s)).toBe(true);
    expect(s.baseline).toBeNull();
  });

  it('dumbbellBench: 몸통 수직이면 보정되지 않고, 수평이면 보정된다', () => {
    const a = createTracker('dumbbellBench');
    let s = a.state();
    for (const f of series(ready(170), 'elbow')) s = a.push(f);
    expect(isCal(s)).toBe(true);
    const b = createTracker('dumbbellBench');
    for (const f of series(ready(170), 'elbow', 33, FLAT)) s = b.push(f);
    expect(isCal(s)).toBe(false);
  });

  it('ready 함수: 어깨나 엉덩이가 안 보이면 null', () => {
    for (const id of ['squat', 'pushup', 'dumbbellBench'] as const) {
      const def = EXERCISES[id];
      expect(def.ready(buildPose({ t: 0, hidden: [LM.L_SHOULDER, LM.R_SHOULDER] }))).toBeNull();
      expect(def.ready(buildPose({ t: 0, hidden: [LM.L_HIP, LM.R_HIP] }))).toBeNull();
    }
  });

  it('보정 중 신호가 끊겨도(null) calibrating은 true로 남는다', () => {
    const tr = createTracker('pushup');
    tr.push(buildPose({ t: 0, elbow: 170, torso: 'flat' }));
    const s = tr.push(buildPose({ t: 33, elbow: 170, torso: 'flat', hidden: [LM.L_ELBOW, LM.R_ELBOW] }));
    expect(isCal(s)).toBe(true);
  });
});

describe('몸통 기울기는 world 좌표 기준(#3)', () => {
  type Pt = { x: number; y: number; z: number };
  type Frame = ReturnType<typeof buildPose>;
  /** 어깨(11,12)를 s, 엉덩이(23,24)를 h에 둔 사본. which로 world/image 중 어느 쪽을 바꿀지 고른다. */
  function withTorso(f: Frame, which: 'world' | 'image', s: Pt, h: Pt): Frame {
    const edit = (lm: Frame['world']) =>
      lm.map((p, i) => {
        if (i === LM.L_SHOULDER || i === LM.R_SHOULDER) return { ...p, ...s };
        if (i === LM.L_HIP || i === LM.R_HIP) return { ...p, ...h };
        return p;
      });
    return { ...f, [which]: edit(f[which]) };
  }
  const deg = (d: number) => (d * Math.PI) / 180;
  const ready = (id: 'pushup' | 'squat' | 'dumbbellBench', f: Frame) =>
    EXERCISES[id].ready(f);
  const HORIZ_S = { x: -0.25, y: 0, z: 0 }, HORIZ_H = { x: 0.25, y: 0, z: 0 };

  it('world는 수평인데 image는 세로로 서 있어도 lyingReady는 true', () => {
    const f = withTorso(buildPose({ t: 0 }), 'world', HORIZ_S, HORIZ_H);
    expect(ready('pushup', f)).toBe(true);
    expect(ready('dumbbellBench', f)).toBe(true);
    expect(ready('squat', f)).toBe(false);
  });

  it('world 수평 + 세로 화면처럼 image를 세로로 늘려 45°로 보여도 lyingReady는 true', () => {
    const f = withTorso(
      withTorso(buildPose({ t: 0 }), 'world', HORIZ_S, HORIZ_H),
      'image', { x: 0.3, y: 0.3, z: 0 }, { x: 0.5, y: 0.5, z: 0 },
    );
    expect(ready('pushup', f)).toBe(true);
  });

  it('world 50° 기울기를 image만 가로로 1.78배 늘려 약 29°로 보이게 해도 false', () => {
    const t = deg(50);
    const w = withTorso(buildPose({ t: 0 }), 'world', { x: 0, y: 0, z: 0 }, { x: 0.5 * Math.cos(t), y: 0.5 * Math.sin(t), z: 0 });
    const f = withTorso(w, 'image', { x: 0.3, y: 0.3, z: 0 }, { x: 0.3 + 0.2 * 1.78, y: 0.5, z: 0 });
    expect(ready('pushup', f)).toBe(false);
  });

  it('world 기준 수평에서 50° 기울면 image가 수평이어도 false', () => {
    const t = deg(50);
    const tilted = withTorso(buildPose({ t: 0 }), 'world', { x: 0, y: 0, z: 0 }, { x: 0.5 * Math.cos(t), y: 0.5 * Math.sin(t), z: 0 });
    const f = withTorso(tilted, 'image', { x: 0.3, y: 0.5, z: 0 }, { x: 0.6, y: 0.5, z: 0 });
    expect(ready('pushup', f)).toBe(false);
  });

  it('world 기준 수직이면 image가 수평이어도 squat ready는 true', () => {
    const f = withTorso(buildPose({ t: 0 }), 'image', { x: 0.3, y: 0.5, z: 0 }, { x: 0.6, y: 0.5, z: 0 });
    expect(ready('squat', f)).toBe(true);
    expect(ready('pushup', f)).toBe(false);
  });

  it('깊이(z) 방향으로 누운 몸통도 수평으로 본다', () => {
    const f = withTorso(buildPose({ t: 0 }), 'world', { x: 0, y: 0, z: -0.25 }, { x: 0, y: 0, z: 0.25 });
    expect(ready('pushup', f)).toBe(true);
  });

  describe('한쪽만 보일 때는 같은 쪽 어깨·엉덩이끼리 짝짓는다', () => {
    const hideOf = (idx: number[]) => buildPose({ t: 0, hidden: idx });
    // 기본 포즈: 어깨(11,12) y=0.3, 엉덩이(23,24) y=0.6 world 수직. 왼쪽/오른쪽을 서로 다른 z로 둬 반대편 짝이면 기울어 보이게 한다.
    const skewed = (hidden: number[]) => {
      const f = hideOf(hidden);
      const world = f.world.map((p, i) => (i === LM.R_SHOULDER || i === LM.R_HIP ? { ...p, z: 0.3 } : p));
      return { ...f, world };
    };
    it('왼쪽만 보임 -> 정상 판정(서 있음)', () => {
      const f = skewed([LM.R_SHOULDER, LM.R_HIP]);
      expect(ready('squat', f)).toBe(true);
      expect(ready('pushup', f)).toBe(false);
    });
    it('왼쪽 어깨 + 오른쪽 엉덩이만 보임 -> null', () => {
      const f = skewed([LM.R_SHOULDER, LM.L_HIP]);
      expect(ready('squat', f)).toBeNull();
      expect(ready('pushup', f)).toBeNull();
    });
    it('전부 숨김 -> null', () => {
      const f = skewed([LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP]);
      expect(ready('squat', f)).toBeNull();
    });
    it('양쪽 다 보이면 중점', () => {
      expect(ready('squat', skewed([]))).toBe(true);
    });
  });
});

describe('TrackerState 판별 유니온과 진단(#4, #2)', () => {
  const allHidden = Array.from({ length: 33 }, (_, i) => i);

  it('squat 트래커 상태는 kind가 reps', () => {
    const s = createTracker('squat').push(buildPose({ t: 0, knee: 175 }));
    expect(s.kind).toBe('reps');
  });

  it('deadHang 트래커 상태는 kind가 hold', () => {
    const s = createTracker('deadHang').push(buildPose({ t: 0, elbow: 170, wristAboveNose: true }));
    expect(s.kind).toBe('hold');
  });

  it('관절을 다 가리면 reps·hold 모두 notVisible', () => {
    const hidden = buildPose({ t: 0, hidden: allHidden });
    expect(createTracker('squat').push(hidden).diagnosis).toBe('notVisible');
    expect(createTracker('pullup').push(hidden).diagnosis).toBe('notVisible');
    expect(createTracker('deadHang').push(hidden).diagnosis).toBe('notVisible');
  });

  it('서 있는 자세의 pushup 보정 중에는 notReady', () => {
    const tr = createTracker('pushup');
    let s = tr.state();
    for (const f of series(ready(170), 'elbow')) s = tr.push(f);
    expect(s.diagnosis).toBe('notReady');
  });

  it('준비 자세로 보정되면 ok', () => {
    const tr = createTracker('pushup');
    let s = tr.state();
    for (const f of series(ready(170), 'elbow', 33, FLAT)) s = tr.push(f);
    expect(s.diagnosis).toBe('ok');
  });

  it('3초 타임아웃으로 보정되면 calibratedByDefault', () => {
    const wobble = Array.from({ length: 140 }, (_, i) => (Math.floor(i / 6) % 2 === 0 ? 170 : 120));
    const tr = createTracker('pushup');
    let s = tr.state();
    for (const f of series(wobble, 'elbow', 33, FLAT)) s = tr.push(f);
    expect(s.kind === 'reps' && s.phase !== 'calibrating').toBe(true);
    expect(s.diagnosis).toBe('calibratedByDefault');
  });

  it('보정 없는 운동은 보이면 ok', () => {
    expect(createTracker('pullup').push(buildPose({ t: 0, elbow: 170 })).diagnosis).toBe('ok');
  });

  it('운동별 시작 방식과 idleEndMs', () => {
    expect(EXERCISES.squat.start).toBe('calibrate');
    expect(EXERCISES.pushup.start).toBe('calibrate');
    expect(EXERCISES.dumbbellBench.start).toBe('calibrate');
    expect(EXERCISES.pullup.start).toBe('pose');
    expect(EXERCISES.pullup.startPose).toBeTypeOf('function');
    expect(EXERCISES.deadHang.start).toBe('pose');
    expect(EXERCISES.negative.start).toBe('visible');
    expect(EXERCISES.negative.idleEndMs).toBe(8000);
    for (const id of ['squat', 'pushup', 'dumbbellBench', 'pullup', 'deadHang'] as const) {
      expect(EXERCISES[id].idleEndMs).toBe(5000);
    }
  });

  it('mode 판별자: squat·pushup·dumbbellBench는 adaptive, pullup·negative는 fixed', () => {
    for (const id of ['squat', 'pushup', 'dumbbellBench'] as const) expect(EXERCISES[id].mode).toBe('adaptive');
    for (const id of ['pullup', 'negative'] as const) expect(EXERCISES[id].mode).toBe('fixed');
  });
});
