import type { RepTiming } from '../session/model';
import { HALPE, type Kp2, type KpFrame } from './halpe';

export type FindingKind = 'depth' | 'kneeIn' | 'kneeInRelative' | 'heel';

/** 정확도 기준(설계 8.1)을 못 넘는 항목은 false로 꺼서 내보내지 않는다. */
export const SQUAT_ENABLED: Record<FindingKind, boolean> = { depth: true, kneeIn: true, kneeInRelative: true, heel: true };

export const SQUAT_RULES = {
  depthMaxKneeDeg: 100,
  kneeInAbs: 0.9,
  kneeInUncertainMax: 1.1,
  relativeDrop: 0.15,
  relativeMinPeers: 5,
  relativeDepthWindowDeg: 10,
  heelRise: 0.25,
  fastDescentMs: 1000,
  medianWindowMs: 150,
  standingKneeDeg: 160,
  descentStartDropDeg: 15,
  segmentOutlierRatio: 0.3,
  segmentNeighborMs: 200,
  oneLegStraightDeg: 150,
  oneLegBentDeg: 120,
  minScore: 0.3,
  footMinScore: 0.15,
} as const;

export type SquatRepMetrics = {
  index: number;
  bottomT: number;
  kneeDeg: number | null;
  kneeAnkleRatio: number | null;
  heelRise: number | null;
  descentMs: number | null;
  skipped: null | 'noPerson' | 'oneLeg';
};
export type FormFinding = { index: number; kind: FindingKind; value: number };
export type SetNote = { kind: 'fastDescent'; avgDescentMs: number };
export type SquatJudgement = { findings: FormFinding[]; notes: SetNote[]; uncertain: number[] };

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const dist = (a: Kp2, b: Kp2) => Math.hypot(a.x - b.x, a.y - b.y);

/** 엉덩이–무릎–발목 각도(도). 퇴화(길이 0)면 null */
function angleDeg(hip: Kp2, knee: Kp2, ankle: Kp2): number | null {
  const ax = hip.x - knee.x;
  const ay = hip.y - knee.y;
  const bx = ankle.x - knee.x;
  const by = ankle.y - knee.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return null;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

type Leg = { hip: number; knee: number; ankle: number; toe: number; heel: number };
const LEGS: Leg[] = [
  { hip: HALPE.L_HIP, knee: HALPE.L_KNEE, ankle: HALPE.L_ANKLE, toe: HALPE.L_BIG_TOE, heel: HALPE.L_HEEL },
  { hip: HALPE.R_HIP, knee: HALPE.R_KNEE, ankle: HALPE.R_ANKLE, toe: HALPE.R_BIG_TOE, heel: HALPE.R_HEEL },
];

type LegRaw = { thigh: number; shank: number; deg: number } | null;

/** 프레임 하나에서 다리별 원시 값(점수가 낮거나 퇴화면 null) */
function legRaw(kps: Kp2[], leg: Leg): LegRaw {
  const hip = kps[leg.hip];
  const knee = kps[leg.knee];
  const ankle = kps[leg.ankle];
  if (!hip || !knee || !ankle) return null;
  const min = SQUAT_RULES.minScore;
  if (hip.score < min || knee.score < min || ankle.score < min) return null;
  const deg = angleDeg(hip, knee, ankle);
  if (deg === null) return null;
  return { thigh: dist(hip, knee), shank: dist(knee, ankle), deg };
}

type FrameInfo = {
  t: number;
  /** 양쪽 다리가 모두 유효할 때만 */
  legDeg: [number, number];
  kneeDeg: number;
  kneeGap: number;
  ankleGap: number;
  /** 발마다(왼, 오른) 뒤꿈치 값. 그 발의 엄지발가락·뒤꿈치 점수가 footMinScore 미만이면 null */
  heel: [number | null, number | null];
};

function analyzeFrames(frames: KpFrame[]): FrameInfo[] {
  const raws = frames.map((f) => (f.kps ? [legRaw(f.kps, LEGS[0]!), legRaw(f.kps, LEGS[1]!)] : null));
  // 길이 이상치: 시간상 이웃 프레임(t ±segmentNeighborMs, 자기 제외)의 중앙값과 비교. 이웃이 없으면 버리지 않는다.
  const ratio = SQUAT_RULES.segmentOutlierRatio;
  const nb = SQUAT_RULES.segmentNeighborMs;
  const off = (v: number, m: number | null) => m !== null && m > 0 && Math.abs(v - m) / m > ratio;
  const out: FrameInfo[] = [];
  frames.forEach((f, i) => {
    const r = raws[i];
    if (!f.kps || !r || !r[0] || !r[1]) return;
    for (let li = 0; li < 2; li++) {
      const th: number[] = [];
      const sh: number[] = [];
      for (let j = i - 1; j >= 0 && f.t - frames[j]!.t <= nb; j--) {
        const q = raws[j]?.[li];
        if (q) { th.push(q.thigh); sh.push(q.shank); }
      }
      for (let j = i + 1; j < frames.length && frames[j]!.t - f.t <= nb; j++) {
        const q = raws[j]?.[li];
        if (q) { th.push(q.thigh); sh.push(q.shank); }
      }
      if (off(r[li]!.thigh, median(th)) || off(r[li]!.shank, median(sh))) return;
    }
    const k = f.kps;
    // 뒤꿈치: 발마다 따로. 엄지발가락·뒤꿈치 점수가 footMinScore 이상일 때만(무릎·발목은 위에서 이미 검사)
    const heels = LEGS.map((leg, li) => {
      const toe = k[leg.toe];
      const heel = k[leg.heel];
      const fm = SQUAT_RULES.footMinScore;
      return toe && heel && toe.score >= fm && heel.score >= fm && r[li]!.shank > 0 ? (toe.y - heel.y) / r[li]!.shank : null;
    }) as [number | null, number | null];
    out.push({
      t: f.t,
      legDeg: [r[0].deg, r[1].deg],
      kneeDeg: (r[0].deg + r[1].deg) / 2,
      kneeGap: dist(k[HALPE.L_KNEE]!, k[HALPE.R_KNEE]!),
      ankleGap: dist(k[HALPE.L_ANKLE]!, k[HALPE.R_ANKLE]!),
      heel: heels,
    });
  });
  return out;
}

export function computeSquatRepMetrics(frames: KpFrame[], reps: RepTiming[]): SquatRepMetrics[] {
  const infos = analyzeFrames(frames);
  // 서 있을 때 기준: 무릎 각도 > 160도 프레임의 중앙값
  const standing = infos.filter((f) => f.kneeDeg > SQUAT_RULES.standingKneeDeg);
  const standKnee = median(standing.map((f) => f.kneeDeg));
  const standAnkleGap = median(standing.map((f) => f.ankleGap));
  const footVals = (fs: FrameInfo[], li: 0 | 1) => fs.flatMap((f) => (f.heel[li] === null ? [] : [f.heel[li]!]));
  const standHeel = [median(footVals(standing, 0)), median(footVals(standing, 1))];

  return reps.map((rep): SquatRepMetrics => {
    const base = { index: rep.index, bottomT: rep.bottomT };
    const w = SQUAT_RULES.medianWindowMs;
    const win = infos.filter((f) => Math.abs(f.t - rep.bottomT) <= w);
    if (win.length === 0) return { ...base, kneeDeg: null, kneeAnkleRatio: null, heelRise: null, descentMs: null, skipped: 'noPerson' };

    const degL = median(win.map((f) => f.legDeg[0]))!;
    const degR = median(win.map((f) => f.legDeg[1]))!;
    const { oneLegStraightDeg: st, oneLegBentDeg: bent } = SQUAT_RULES;
    if ((degL > st && degR < bent) || (degR > st && degL < bent)) {
      return { ...base, kneeDeg: null, kneeAnkleRatio: null, heelRise: null, descentMs: null, skipped: 'oneLeg' };
    }
    const kneeDeg = median(win.map((f) => f.kneeDeg))!;

    const gap = median(win.map((f) => f.kneeGap))!;
    const kneeAnkleRatio = standAnkleGap !== null && standAnkleGap > 0 ? gap / standAnkleGap : null;

    // 발마다 (바닥 값 - 서 있을 때 값)을 구하고, 둘 다 있는 발만 평균
    const rises: number[] = [];
    for (const li of [0, 1] as const) {
      const bh = median(footVals(win, li));
      const sh = standHeel[li];
      if (bh !== null && sh !== null && sh !== undefined) rises.push(bh - sh);
    }
    const heelRise = rises.length ? rises.reduce((a, b) => a + b, 0) / rises.length : null;

    // 하강 시작: 바닥 전 구간(startT~bottomT)에서 무릎 각도가 서 있음 기준-15도 아래로 처음 내려간 프레임
    let descentMs: number | null = null;
    if (standKnee !== null) {
      const thr = standKnee - SQUAT_RULES.descentStartDropDeg;
      const first = infos.find((f) => f.t >= rep.startT && f.t < rep.bottomT && f.kneeDeg < thr);
      if (first) descentMs = rep.bottomT - first.t;
    }
    return { ...base, kneeDeg, kneeAnkleRatio, heelRise, descentMs, skipped: null };
  });
}

export function judgeSquat(
  metrics: SquatRepMetrics[],
  history: SquatRepMetrics[],
  enabled: Record<FindingKind, boolean> = SQUAT_ENABLED,
): SquatJudgement {
  const R = SQUAT_RULES;
  const findings: FormFinding[] = [];
  const uncertain: number[] = [];
  const pool = [...history, ...metrics];

  for (const m of metrics) {
    if (m.skipped) continue;
    // 깊이가 부족한 반복은 무릎 모임 판정을 하지 않는다(지적 노출 여부와 무관하게 판정 조건으로 본다)
    const shallow = m.kneeDeg !== null && m.kneeDeg > R.depthMaxKneeDeg;
    if (shallow && enabled.depth) findings.push({ index: m.index, kind: 'depth', value: m.kneeDeg! });

    if (!shallow && m.kneeAnkleRatio !== null) {
      const r = m.kneeAnkleRatio;
      if (r < R.kneeInAbs) {
        if (enabled.kneeIn) findings.push({ index: m.index, kind: 'kneeIn', value: r });
      } else if (r < R.kneeInUncertainMax) {
        if (enabled.kneeIn) uncertain.push(m.index);
      } else if (enabled.kneeInRelative && m.kneeDeg !== null) {
        const peers = pool
          .filter(
            (p) =>
              p !== m &&
              !p.skipped &&
              p.kneeDeg !== null &&
              p.kneeAnkleRatio !== null &&
              Math.abs(p.kneeDeg - m.kneeDeg!) <= R.relativeDepthWindowDeg,
          )
          .map((p) => p.kneeAnkleRatio!);
        if (peers.length >= R.relativeMinPeers) {
          const med = median(peers)!;
          if (r < med * (1 - R.relativeDrop)) findings.push({ index: m.index, kind: 'kneeInRelative', value: r });
        }
      }
    }

    if (enabled.heel && m.heelRise !== null && m.heelRise >= R.heelRise) {
      findings.push({ index: m.index, kind: 'heel', value: m.heelRise });
    }
  }

  const notes: SetNote[] = [];
  const ds = metrics.flatMap((m) => (!m.skipped && m.descentMs !== null ? [m.descentMs] : []));
  if (ds.length > 0) {
    const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
    if (avg < R.fastDescentMs) notes.push({ kind: 'fastDescent', avgDescentMs: avg });
  }
  return { findings, notes, uncertain };
}
