import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { KpFrame } from '../src/form/halpe';
import {
  SQUAT_ENABLED,
  computeSquatRepMetrics,
  judgeSquat,
  type FindingKind,
  type SquatRepMetrics,
} from '../src/form/squatRules';
import type { RepTiming } from '../src/session/model';
import { buildHalpe, squatRep, type BottomSpec } from './helpers/halpeBuilder';

const GOOD: BottomSpec = { kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.05 };

/** 반복 스펙 목록 → 프레임과 RepTiming (4초 간격, 하강 800ms·상승 800ms) */
function makeSet(specs: BottomSpec[]) {
  const frames: KpFrame[] = [];
  const reps: RepTiming[] = [];
  specs.forEach((bottom, i) => {
    const bottomT = 2000 + i * 4000;
    const startT = bottomT - 1600;
    const endT = bottomT + 800;
    frames.push(...squatRep({ startT, bottomT, endT, bottom }));
    reps.push({ index: i + 1, startT, bottomT, endT });
  });
  return { frames, reps };
}

function run(specs: BottomSpec[]) {
  const { frames, reps } = makeSet(specs);
  const metrics = computeSquatRepMetrics(frames, reps);
  return { metrics, judge: judgeSquat(metrics, []) };
}

function metric(p: Partial<SquatRepMetrics> & { index: number }): SquatRepMetrics {
  return { bottomT: p.index * 1000, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.05, descentMs: 1500, skipped: null, ...p };
}

describe('computeSquatRepMetrics', () => {
  it('합성 반복의 지표를 되돌려준다', () => {
    const { metrics } = run([{ kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.3 }]);
    expect(metrics).toHaveLength(1);
    const m = metrics[0]!;
    expect(m.index).toBe(1);
    expect(m.bottomT).toBe(2000);
    expect(m.skipped).toBeNull();
    expect(m.kneeDeg).toBeCloseTo(80, 0);
    expect(m.kneeAnkleRatio).toBeCloseTo(1.5, 1);
    expect(m.heelRise).toBeCloseTo(0.3, 1);
    expect(m.descentMs).toBeGreaterThan(1000);
    expect(m.descentMs).toBeLessThanOrEqual(1600);
  });

  it('바닥 ±150ms 구간 kps가 모두 null이면 noPerson, 다른 반복은 그대로', () => {
    const { frames, reps } = makeSet([GOOD, GOOD, GOOD]);
    const f2 = frames.map((f) => (Math.abs(f.t - reps[1]!.bottomT) <= 150 ? { t: f.t, kps: null } : f));
    const m = computeSquatRepMetrics(f2, reps);
    expect(m[1]!.skipped).toBe('noPerson');
    expect(m[1]!.kneeDeg).toBeNull();
    expect(m[0]!.skipped).toBeNull();
    expect(m[2]!.skipped).toBeNull();
    expect(judgeSquat(m, []).findings).toEqual([]);
  });

  it('왼 170도/오른 80도(한쪽만 굽음)는 oneLeg, 왼 120도/오른 40도는 oneLeg 아님', () => {
    const { metrics } = run([GOOD, { ...GOOD, kneeDeg: 170, kneeDegR: 80 }, { ...GOOD, kneeDeg: 120, kneeDegR: 40 }]);
    expect(metrics[0]!.skipped).toBeNull();
    expect(metrics[1]!.skipped).toBe('oneLeg');
    expect(metrics[2]!.skipped).toBeNull();
    expect(metrics[2]!.kneeDeg).toBeCloseTo(80, 0);
    expect(judgeSquat([metrics[1]!], []).findings).toEqual([]);
  });

  it('reps가 0개·1개여도 예외 없이 동작한다', () => {
    expect(computeSquatRepMetrics([], [])).toEqual([]);
    expect(judgeSquat([], [])).toEqual({ findings: [], notes: [], uncertain: [] });
    const { metrics, judge } = run([GOOD]);
    expect(metrics).toHaveLength(1);
    expect(judge.findings).toEqual([]);
    const m = computeSquatRepMetrics([], [{ index: 1, startT: 0, bottomT: 1000, endT: 2000 }]);
    expect(m[0]!.skipped).toBe('noPerson');
  });

  it('점수 0.1인 프레임과 한 프레임만 정강이가 2배로 튄 프레임은 버린다', () => {
    const { frames, reps } = makeSet([GOOD]);
    const bt = reps[0]!.bottomT;
    const win = frames.filter((f) => Math.abs(f.t - bt) <= 150);
    expect(win.length).toBeGreaterThanOrEqual(5);
    const lowT = win[0]!.t;
    const longT = win[1]!.t;
    const base = { kneeDeg: 160, kneeAnkleRatio: 0.3, heelRise: 0.9 };
    const mixed = frames.map((f) => {
      if (f.t === lowT) return buildHalpe({ ...base, t: f.t, score: 0.1 });
      if (f.t === longT) return buildHalpe({ ...base, t: f.t, shankScale: 2 });
      return f;
    });
    const m = computeSquatRepMetrics(mixed, reps)[0]!;
    expect(m.skipped).toBeNull();
    // 오염 프레임이 중앙값에 들어가도 값이 크게 변하지 않지만, 한 프레임 튐은 반드시 버려져야 하므로 길이만 튄 프레임 단독으로도 확인한다
    const onlyLong = frames.map((f) => (f.t === longT ? buildHalpe({ ...base, t: f.t, shankScale: 2 }) : f));
    const winF = onlyLong.filter((f) => Math.abs(f.t - bt) <= 150);
    expect(winF.length).toBe(win.length);
    // 바닥 구간을 전부 한 프레임 튐으로 채우면 살아남는 프레임이 없어야 한다(튄 프레임 사이가 이웃 중앙값과 다르므로)
    const spikes = frames.map((f) => (Math.abs(f.t - bt) <= 150 && ((f.t - win[0]!.t) / 50) % 2 === 0 ? buildHalpe({ ...base, t: f.t, shankScale: 2 }) : f));
    const m2 = computeSquatRepMetrics(spikes, reps)[0]!;
    expect(m2.kneeDeg).toBeCloseTo(80, 0);
    expect(m.kneeDeg).toBeCloseTo(80, 0);
    expect(m.kneeAnkleRatio).toBeCloseTo(1.5, 1);
    expect(m.heelRise).toBeCloseTo(0.05, 1);
  });

  it('천천히 짧아지는 허벅지(45도 단축)는 버리지 않는다', () => {
    // 허벅지가 1.0 -> 0.4로 서서히 줄어드는 세트. 세트 전체 중앙값 기준이면 바닥 프레임이 버려진다.
    const frames: KpFrame[] = [];
    for (let t = 0; t <= 2000; t += 50) {
      const u = Math.min(1, t / 1500);
      frames.push(buildHalpe({ t, kneeDeg: 175 - 95 * u, kneeAnkleRatio: 1 + 0.5 * u, heelRise: 0, thighScale: 1 - 0.6 * u }));
    }
    for (let t = 2050; t <= 3000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0, thighScale: 0.4 }));
    for (let t = 3050; t <= 6000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 175, kneeAnkleRatio: 1, heelRise: 0 }));
    for (let t = -300; t < 0; t += 50) frames.unshift(buildHalpe({ t, kneeDeg: 175, kneeAnkleRatio: 1, heelRise: 0 }));
    frames.sort((a, b) => a.t - b.t);
    const m = computeSquatRepMetrics(frames, [{ index: 1, startT: 500, bottomT: 2500, endT: 3000 }])[0]!;
    expect(m.skipped).toBeNull();
    expect(m.kneeDeg).toBeCloseTo(80, 0);
  });

  it('먼 발 점수 0.2, 가까운 발 0.8이어도 두 발 모두 써서 뒤꿈치 값을 낸다', () => {
    const frames: KpFrame[] = [];
    for (let t = 0; t <= 1000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 175, kneeAnkleRatio: 1, heelRise: 0.0, heelRiseR: 0.1, score: 0.8, footScoreL: 0.2 }));
    for (let t = 1050; t <= 2000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.4, heelRiseR: 0.6, score: 0.8, footScoreL: 0.2 }));
    const m = computeSquatRepMetrics(frames, [{ index: 1, startT: 800, bottomT: 1500, endT: 2000 }])[0]!;
    // 왼발 0.4-0.0, 오른발 0.6-0.1 -> 평균 0.45 (왼발을 버리면 0.5)
    expect(m.heelRise).toBeCloseTo(0.45, 2);
  });

  it('한쪽 발 점수가 0.1이면 그 발은 빼고 나머지 발로 계산한다', () => {
    const frames: KpFrame[] = [];
    for (let t = 0; t <= 1000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 175, kneeAnkleRatio: 1, heelRise: 0.0, heelRiseR: 0.0, footScoreR: 0.1 }));
    for (let t = 1050; t <= 2000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.3, heelRiseR: 0.9, footScoreR: 0.1 }));
    const m = computeSquatRepMetrics(frames, [{ index: 1, startT: 800, bottomT: 1500, endT: 2000 }])[0]!;
    expect(m.heelRise).toBeCloseTo(0.3, 2);
    const none = computeSquatRepMetrics(
      frames.map((f) => ({ t: f.t, kps: f.kps!.map((p, i) => (i === 20 || i === 21 || i === 24 || i === 25 ? { ...p, score: 0.1 } : p)) })),
      [{ index: 1, startT: 800, bottomT: 1500, endT: 2000 }],
    )[0]!;
    expect(none.heelRise).toBeNull();
  });

  it('서 있는 프레임이 없으면 비율·뒤꿈치·하강시간은 null', () => {
    const frames: KpFrame[] = [];
    for (let t = 0; t <= 2000; t += 50) frames.push(buildHalpe({ t, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.05 }));
    const m = computeSquatRepMetrics(frames, [{ index: 1, startT: 200, bottomT: 1000, endT: 1800 }])[0]!;
    expect(m.kneeDeg).toBeCloseTo(80, 0);
    expect(m.kneeAnkleRatio).toBeNull();
    expect(m.heelRise).toBeNull();
    expect(m.descentMs).toBeNull();
  });
});

describe('judgeSquat', () => {
  it('바른 반복은 지적이 없다', () => {
    expect(run([GOOD]).judge).toEqual({ findings: [], notes: [], uncertain: [] });
  });

  it('바닥 무릎 각도 110도면 depth, 그 반복은 kneeIn 판정 안 함', () => {
    const { judge } = run([{ kneeDeg: 110, kneeAnkleRatio: 0.7, heelRise: 0.05 }]);
    expect(judge.findings.map((f) => f.kind)).toEqual(['depth']);
    expect(judge.findings[0]!.index).toBe(1);
    expect(judge.findings[0]!.value).toBeCloseTo(110, 0);
    expect(judge.uncertain).toEqual([]);
  });

  it('비율 0.7이면 kneeIn, 1.0이면 uncertain, 1.2면 지적 없음', () => {
    const a = run([{ ...GOOD, kneeAnkleRatio: 0.7 }]).judge;
    expect(a.findings.map((f) => f.kind)).toEqual(['kneeIn']);
    expect(a.uncertain).toEqual([]);
    const b = run([{ ...GOOD, kneeAnkleRatio: 1.0 }]).judge;
    expect(b.findings).toEqual([]);
    expect(b.uncertain).toEqual([1]);
    const c = run([{ ...GOOD, kneeAnkleRatio: 1.2 }]).judge;
    expect(c.findings).toEqual([]);
    expect(c.uncertain).toEqual([]);
  });

  it('상대 기준: 비교 5개 중앙값 1.6, 이번 1.3이면 kneeInRelative', () => {
    const history = [1, 2, 3, 4, 5].map((i) => metric({ index: i, kneeAnkleRatio: 1.6 }));
    const cur = [metric({ index: 6, kneeAnkleRatio: 1.3 })];
    expect(judgeSquat(cur, history).findings).toEqual([{ index: 6, kind: 'kneeInRelative', value: 1.3 }]);
    expect(judgeSquat(cur, history.slice(0, 4)).findings).toEqual([]);
    const far = history.map((h, i) => (i < 2 ? { ...h, kneeDeg: 60 } : h));
    expect(judgeSquat(cur, far).findings).toEqual([]);
    const near = history.map((h) => ({ ...h, kneeDeg: 90 }));
    expect(judgeSquat(cur, near).findings.map((f) => f.kind)).toEqual(['kneeInRelative']);
  });

  it('상대 기준에는 이번 세트의 다른 반복도 비교로 들어간다', () => {
    const set = [1, 2, 3, 4, 5].map((i) => metric({ index: i, kneeAnkleRatio: 1.6 }));
    set.push(metric({ index: 6, kneeAnkleRatio: 1.3 }));
    expect(judgeSquat(set, []).findings).toEqual([{ index: 6, kind: 'kneeInRelative', value: 1.3 }]);
  });

  it('뒤꿈치 0.3이면 heel, 0.2면 없음', () => {
    expect(run([{ ...GOOD, heelRise: 0.3 }]).judge.findings.map((f) => f.kind)).toEqual(['heel']);
    expect(run([{ ...GOOD, heelRise: 0.2 }]).judge.findings).toEqual([]);
  });

  it('세트 평균 descentMs 600이면 fastDescent note, 1500이면 없음', () => {
    const fast = [1, 2, 3].map((i) => metric({ index: i, descentMs: 600 }));
    expect(judgeSquat(fast, []).notes).toEqual([{ kind: 'fastDescent', avgDescentMs: 600 }]);
    const slow = [1, 2, 3].map((i) => metric({ index: i, descentMs: 1500 }));
    expect(judgeSquat(slow, []).notes).toEqual([]);
  });

  it('SQUAT_ENABLED.heel을 false로 주입하면 heel 지적이 없다', () => {
    const m = [metric({ index: 1, heelRise: 0.3 })];
    expect(judgeSquat(m, []).findings.map((f) => f.kind)).toEqual(['heel']);
    const off: Record<FindingKind, boolean> = { ...SQUAT_ENABLED, heel: false };
    expect(judgeSquat(m, [], off).findings).toEqual([]);
  });
});

// 개인 녹화 회귀(git에 없음). 파일이 없으면 건너뛴다.
const privateFile = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private', 'angle-test', 'rtm-litebox-1.0.json');
const BOTTOMS_S = [6.9, 9.5, 12, 14.4, 21.8, 24.3, 26.7, 29.2, 36.9, 40, 43.1, 46.1, 49.4, 51.6, 53.7, 55.6, 58.6, 60.8, 63, 65.2];

describe.skipIf(!existsSync(privateFile))('스쿼트 판정: 개인 녹화 회귀', () => {
  it('깊이는 17~20번, kneeIn은 5~8번, heel은 9~12번만 지적한다', () => {
    const rec = JSON.parse(readFileSync(privateFile, 'utf8')) as {
      frames: { t: number; k: number[][] | null; s: number[] | null }[];
    };
    const frames: KpFrame[] = rec.frames.map((f) => ({
      t: f.t,
      kps: f.k ? f.k.map((p, i) => ({ x: p[0]!, y: p[1]!, score: f.s![i]! })) : null,
    }));
    const reps: RepTiming[] = BOTTOMS_S.map((s, i) => {
      const bottomT = Math.round(s * 1000);
      return { index: i + 1, startT: bottomT - 800, bottomT, endT: bottomT + 800 };
    });
    const metrics = computeSquatRepMetrics(frames, reps);
    const j = judgeSquat(metrics, []);
    const by = (k: FindingKind) => j.findings.filter((f) => f.kind === k).map((f) => f.index);
    const summary = metrics
      .map((m) => `${m.index}:${m.skipped ?? `${m.kneeDeg?.toFixed(0)}/${m.kneeAnkleRatio?.toFixed(2)}/${m.heelRise?.toFixed(2)}`}`)
      .join(' ');
    expect(by('depth'), summary).toEqual([17, 18, 19, 20]);
    expect(by('kneeIn'), summary).toEqual([5, 6, 7, 8]);
    expect(by('heel'), summary).toEqual([9, 10, 11, 12]);
    expect(by('kneeInRelative'), summary).toEqual([]);
  });
});
