import { HALPE, type Kp2, type KpFrame } from '../../src/form/halpe';

const CX = 500;
const ANKLE_Y = 800;
const ANKLE_GAP = 200; // 두 발목 사이 거리(고정). 무릎 간격 비율 = 무릎 간격 / 이 값
const THIGH = 100; // 허벅지 길이(고정)
const SHANK0 = 100; // 무릎 바로 위에 발목이 있을 때 정강이 길이

export type HalpeOpts = {
  /** 두 무릎 각도(엉덩이–무릎–발목). kneeDegR를 주면 오른쪽만 다르게 */
  kneeDeg: number;
  kneeDegR?: number;
  /** 무릎 간격 ÷ 발목 간격 */
  kneeAnkleRatio: number;
  /** (엄지발가락 y − 뒤꿈치 y) ÷ 정강이 길이 */
  heelRise: number;
  t: number;
  score?: number;
  /** 정강이 길이 배수(이상치 시험용) */
  shankScale?: number;
  /** 허벅지 길이 배수(45도 시점 단축 시험용) */
  thighScale?: number;
  /** 발(엄지발가락·뒤꿈치) 점수를 발마다 따로 */
  footScoreL?: number;
  footScoreR?: number;
  /** 오른발 뒤꿈치 값만 따로 */
  heelRiseR?: number;
};

/** 단순 정면 투영 관절점(26개 중 쓰는 10점만 의미 있음). */
export function buildHalpe(o: HalpeOpts): KpFrame {
  const score = o.score ?? 0.9;
  const kps: Kp2[] = Array.from({ length: 26 }, () => ({ x: 0, y: 0, score: 0 }));
  const scale = o.shankScale ?? 1;
  for (const side of [-1, 1] as const) {
    const deg = side === -1 ? o.kneeDeg : (o.kneeDegR ?? o.kneeDeg);
    const ax = CX + side * (ANKLE_GAP / 2);
    const kx = CX + side * ((o.kneeAnkleRatio * ANKLE_GAP) / 2);
    const ky = ANKLE_Y - SHANK0;
    // 무릎→발목 방향
    let dx = ax - kx;
    let dy = ANKLE_Y - ky;
    const shank = Math.hypot(dx, dy);
    dx /= shank;
    dy /= shank;
    // 무릎→엉덩이 방향 = 무릎→발목 방향을 deg만큼 회전
    const r = (deg * Math.PI) / 180;
    const hx = dx * Math.cos(r) - dy * Math.sin(r) * side;
    const hy = dy * Math.cos(r) + dx * Math.sin(r) * side;
    const sh = shank * scale;
    const ankle = { x: kx + dx * sh, y: ky + dy * sh };
    const toeY = ankle.y + 10;
    const heelY = toeY - (side === 1 ? (o.heelRiseR ?? o.heelRise) : o.heelRise) * sh;
    const footScore = (side === -1 ? o.footScoreL : o.footScoreR) ?? score;
    const [hip, knee, ank, toe, heel] =
      side === -1
        ? [HALPE.L_HIP, HALPE.L_KNEE, HALPE.L_ANKLE, HALPE.L_BIG_TOE, HALPE.L_HEEL]
        : [HALPE.R_HIP, HALPE.R_KNEE, HALPE.R_ANKLE, HALPE.R_BIG_TOE, HALPE.R_HEEL];
    kps[hip] = { x: kx + hx * THIGH * (o.thighScale ?? 1), y: ky + hy * THIGH * (o.thighScale ?? 1), score };
    kps[knee] = { x: kx, y: ky, score };
    kps[ank] = { x: ankle.x, y: ankle.y, score };
    kps[toe] = { x: ankle.x, y: toeY, score: footScore };
    kps[heel] = { x: ankle.x, y: heelY, score: footScore };
  }
  return { t: o.t, kps };
}

export type BottomSpec = { kneeDeg: number; kneeDegR?: number; kneeAnkleRatio: number; heelRise: number };

export const STANDING: BottomSpec = { kneeDeg: 175, kneeAnkleRatio: 1, heelRise: 0 };

/**
 * 서 있음 → 내려가기(startT~bottomT-200) → 바닥 유지(bottomT±200) → 올라오기(bottomT+200~endT) → 서 있음.
 * 앞뒤로 300ms씩 서 있는 프레임을 붙인다. 프레임 간격 stepMs(기본 50).
 */
export function squatRep(o: { startT: number; bottomT: number; endT: number; bottom: BottomSpec; stepMs?: number; standing?: BottomSpec }): KpFrame[] {
  const step = o.stepMs ?? 50;
  const st = o.standing ?? STANDING;
  const out: KpFrame[] = [];
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  for (let t = o.startT - 300; t <= o.endT + 300; t += step) {
    let u: number;
    if (t <= o.startT) u = 0;
    else if (t < o.bottomT - 200) u = (t - o.startT) / (o.bottomT - 200 - o.startT);
    else if (t <= o.bottomT + 200) u = 1;
    else if (t < o.endT) u = 1 - (t - (o.bottomT + 200)) / (o.endT - (o.bottomT + 200));
    else u = 0;
    out.push(
      buildHalpe({
        t,
        kneeDeg: lerp(st.kneeDeg, o.bottom.kneeDeg, u),
        kneeDegR: o.bottom.kneeDegR === undefined ? undefined : lerp(st.kneeDeg, o.bottom.kneeDegR, u),
        kneeAnkleRatio: lerp(st.kneeAnkleRatio, o.bottom.kneeAnkleRatio, u),
        heelRise: lerp(st.heelRise, o.bottom.heelRise, u),
      }),
    );
  }
  return out;
}
