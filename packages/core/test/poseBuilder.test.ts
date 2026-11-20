import { test, expect } from 'vitest';
import { buildPose, series } from './helpers/poseBuilder';
import { jointAngle } from '../src/pose/angles';
import { LM } from '../src/types';

const arm = (f: ReturnType<typeof buildPose>, s: [number, number, number]) =>
  jointAngle(f.image[s[0]]!, f.image[s[1]]!, f.image[s[2]]!);

test('팔꿈치 90도: 양팔 모두', () => {
  const f = buildPose({ t: 0, elbow: 90 });
  expect(arm(f, [11, 13, 15])).toBeCloseTo(90, 0);
  expect(arm(f, [12, 14, 16])).toBeCloseTo(90, 0);
});

test('무릎 100도: 양쪽 모두', () => {
  const f = buildPose({ t: 0, knee: 100 });
  expect(arm(f, [23, 25, 27])).toBeCloseTo(100, 0);
  expect(arm(f, [24, 26, 28])).toBeCloseTo(100, 0);
});

test('기본값: 팔꿈치 170, 무릎 175, 33개 랜드마크, visibility 1', () => {
  const f = buildPose({ t: 5 });
  expect(f.t).toBe(5);
  expect(f.image).toHaveLength(33);
  expect(f.world).toHaveLength(33);
  expect(arm(f, [11, 13, 15])).toBeCloseTo(170, 0);
  expect(arm(f, [23, 25, 27])).toBeCloseTo(175, 0);
  expect(f.image.every((l) => l.visibility === 1)).toBe(true);
});

test('visibility 옵션과 hidden', () => {
  const f = buildPose({ t: 0, visibility: 0.8, hidden: [13] });
  expect(f.image[13]!.visibility).toBe(0);
  expect(f.world[13]!.visibility).toBe(0);
  expect(f.image[14]!.visibility).toBe(0.8);
});

test('wristAboveNose 없음/false: 손목이 코보다 아래', () => {
  for (const w of [undefined, false]) {
    const f = buildPose({ t: 0, elbow: 170, wristAboveNose: w });
    expect(f.image[LM.L_WRIST]!.y).toBeGreaterThan(f.image[LM.NOSE]!.y);
    expect(f.image[LM.R_WRIST]!.y).toBeGreaterThan(f.image[LM.NOSE]!.y);
  }
});

test('wristAboveNose true: 손목이 코보다 위, 팔꿈치 각도 유지', () => {
  for (const elbow of [170, 90]) {
    const f = buildPose({ t: 0, elbow, wristAboveNose: true });
    expect(f.image[LM.L_WRIST]!.y).toBeLessThan(f.image[LM.NOSE]!.y);
    expect(f.image[LM.R_WRIST]!.y).toBeLessThan(f.image[LM.NOSE]!.y);
    expect(arm(f, [11, 13, 15])).toBeCloseTo(elbow, 0);
    expect(arm(f, [12, 14, 16])).toBeCloseTo(elbow, 0);
  }
});

test('series: 각도 배열을 프레임 열로', () => {
  const fs = series([170, 120, 90], 'elbow', 40, { wristAboveNose: true });
  expect(fs.map((f) => f.t)).toEqual([0, 40, 80]);
  expect(arm(fs[1]!, [11, 13, 15])).toBeCloseTo(120, 0);
  expect(fs[2]!.image[LM.L_WRIST]!.y).toBeLessThan(fs[2]!.image[LM.NOSE]!.y);
});

test('series 기본 간격 33ms, knee 키', () => {
  const fs = series([175, 100], 'knee');
  expect(fs[1]!.t).toBe(33);
  expect(arm(fs[1]!, [23, 25, 27])).toBeCloseTo(100, 0);
});
