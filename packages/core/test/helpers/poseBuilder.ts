import type { Landmark, PoseFrame } from '../../src/types';

export type PoseOpts = {
  t: number;
  /** 양쪽 팔꿈치 각도(도). 기본 170. wristAboveNose는 90 이상에서만 보장. */
  elbow?: number;
  /** 양쪽 무릎 각도(도). 기본 175. */
  knee?: number;
  /** true면 팔을 머리 위로 든 기하(두 손목 y < 코 y). 아니면 손목은 코보다 아래. */
  wristAboveNose?: boolean;
  /** 모든 랜드마크의 visibility. 기본 1. */
  visibility?: number;
  /** visibility를 0으로 만들 랜드마크 인덱스. */
  hidden?: number[];
};

type P = [number, number];
const rad = (d: number) => (d * Math.PI) / 180;
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];

const NOSE: P = [0.5, 0.2];
const UPPER = 0.15, FORE = 0.15, THIGH = 0.2, SHIN = 0.2;
const SHOULDER_Y = 0.3, HIP_Y = 0.6;
// 이미지 y는 아래로 커진다. side: 왼쪽 -1, 오른쪽 +1(바깥쪽 방향).
const SIDES = [-1, 1] as const;

function armPoints(side: number, elbow: number, above: boolean): [P, P, P] {
  const shoulder: P = [0.5 + 0.1 * side, SHOULDER_Y];
  const th = rad(elbow);
  if (above) {
    // 팔뚝을 곧게 위로. 위팔은 팔뚝과 elbow도를 이루도록 어깨 쪽으로 내린다.
    const e = add(shoulder, [-UPPER * Math.sin(th) * side, UPPER * Math.cos(th)]);
    return [shoulder, e, add(e, [0, -FORE])];
  }
  // 위팔은 곧게 아래, 팔뚝은 위팔 반대(위) 방향에서 elbow도만큼 벌어진다.
  const e = add(shoulder, [0, UPPER]);
  return [shoulder, e, add(e, [FORE * Math.sin(th) * side, -FORE * Math.cos(th)])];
}

function legPoints(side: number, knee: number): [P, P, P] {
  const hip: P = [0.5 + 0.06 * side, HIP_Y];
  const k = add(hip, [0, THIGH]);
  const th = rad(knee);
  return [hip, k, add(k, [SHIN * Math.sin(th) * side, -SHIN * Math.cos(th)])];
}

export function buildPose(opts: PoseOpts): PoseFrame {
  const { t, elbow = 170, knee = 175, wristAboveNose = false, visibility = 1, hidden = [] } = opts;
  const pts: P[] = Array.from({ length: 33 }, () => [...NOSE] as P);
  pts[0] = NOSE;
  // 얼굴: 눈(1~6), 귀(7,8), 입(9,10)
  const eyes: [number, number][] = [[1, -0.02], [2, -0.03], [3, -0.04], [4, 0.02], [5, 0.03], [6, 0.04]];
  for (const [i, dx] of eyes) pts[i] = [0.5 + dx, NOSE[1] - 0.02];
  pts[7] = [0.45, NOSE[1]]; pts[8] = [0.55, NOSE[1]];
  pts[9] = [0.48, NOSE[1] + 0.04]; pts[10] = [0.52, NOSE[1] + 0.04];

  SIDES.forEach((side, i) => {
    const [s, e, w] = armPoints(side, elbow, wristAboveNose);
    pts[11 + i] = s; pts[13 + i] = e; pts[15 + i] = w;
    // 손(17~22)은 손목 근처
    pts[17 + i] = add(w, [0, -0.01]); pts[19 + i] = add(w, [0.005 * side, -0.015]);
    pts[21 + i] = add(w, [-0.005 * side, -0.01]);
    const [h, k, a] = legPoints(side, knee);
    pts[23 + i] = h; pts[25 + i] = k; pts[27 + i] = a;
    // 발(29~32): 발뒤꿈치, 발끝
    pts[29 + i] = add(a, [0, 0.01]); pts[31 + i] = add(a, [0.03 * side, 0.02]);
  });

  const make = (): Landmark[] =>
    pts.map(([x, y], i) => ({ x, y, z: 0, visibility: hidden.includes(i) ? 0 : visibility }));
  return { t, image: make(), world: make() };
}

/** 각도 값 배열을 프레임 열로. key 각도만 values로 바꾸고 나머지는 extra를 따른다. */
export function series(
  values: number[],
  key: 'elbow' | 'knee',
  dtMs = 33,
  extra: Partial<Omit<PoseOpts, 't' | 'elbow' | 'knee'>> = {},
): PoseFrame[] {
  return values.map((v, i) => buildPose({ ...extra, t: i * dtMs, [key]: v }));
}
