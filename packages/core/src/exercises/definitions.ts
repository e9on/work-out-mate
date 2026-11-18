import type { PoseFrame } from '../types';
import { LM } from '../types';
import { jointAngle } from '../pose/angles';
import { visibleEnough } from '../pose/signal';
import type { RepConfig } from '../counter/repCounter';
import type { HoldConfig } from '../counter/holdTimer';

export type ExerciseId = 'squat' | 'pushup' | 'dumbbellBench' | 'pullup' | 'negative' | 'deadHang';

export type RepExerciseDef = {
  id: Exclude<ExerciseId, 'deadHang'>;
  kind: 'reps';
  signal(f: PoseFrame): number | null;
  rep: RepConfig;
};
export type HoldExerciseDef = {
  id: 'deadHang';
  kind: 'hold';
  holding(f: PoseFrame): boolean | null;
  hold: HoldConfig;
};
export type ExerciseDef = RepExerciseDef | HoldExerciseDef;

/** 신호에 거는 EMA 계수. */
export const EMA_ALPHA = 0.5;

// 임계값은 출발점이다. Task 10에서 녹화 데이터로 조정한다. 모아 두는 곳은 이 파일.
const COMMON = { minRepMs: 500, pauseAfterMs: 1500 } as const;
const REP_CFG = {
  squat: { restSide: 'high', enter: 150, turn: 100, exit: 160, ...COMMON },
  pushup: { restSide: 'high', enter: 150, turn: 100, exit: 160, ...COMMON },
  dumbbellBench: { restSide: 'high', enter: 150, turn: 100, exit: 160, ...COMMON },
  pullup: { restSide: 'high', enter: 140, turn: 80, exit: 155, ...COMMON },
  negative: { restSide: 'low', enter: 100, turn: 140, exit: 95, countAt: 'turn', ...COMMON },
} satisfies Record<string, RepConfig>;
const HOLD_CFG: HoldConfig = { startAfterMs: 300, graceMs: 500 };
const MIN_VISIBILITY = 0.5;
const DEAD_HANG_MIN_ELBOW = 150;

type Triple = readonly [number, number, number];
const L_ARM: Triple = [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST];
const R_ARM: Triple = [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST];
const L_LEG: Triple = [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE];
const R_LEG: Triple = [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE];

/** world 좌표 각도. NaN/Infinity는 null로 바꿔 Ema 오염을 막는다. */
function angleOf(f: PoseFrame, [a, b, c]: Triple): number | null {
  const pa = f.world[a], pb = f.world[b], pc = f.world[c];
  if (!pa || !pb || !pc) return null;
  const v = jointAngle(pa, pb, pc);
  return Number.isFinite(v) ? v : null;
}

function meanVisibility(f: PoseFrame, t: Triple): number {
  return t.reduce((s, i) => s + (f.image[i]?.visibility ?? 0), 0) / t.length;
}

/** 좌우 중 평균 visibility가 높은 쪽의 각도. 그쪽이 안 보이면 null. */
function betterSideAngle(f: PoseFrame, left: Triple, right: Triple): number | null {
  const side = meanVisibility(f, right) > meanVisibility(f, left) ? right : left;
  if (!visibleEnough(f, side, MIN_VISIBILITY)) return null;
  return angleOf(f, side);
}

const armAngle = (f: PoseFrame) => betterSideAngle(f, L_ARM, R_ARM);

function bothArmsMean(f: PoseFrame): number | null {
  if (!visibleEnough(f, [...L_ARM, ...R_ARM], MIN_VISIBILITY)) return null;
  const l = angleOf(f, L_ARM), r = angleOf(f, R_ARM);
  return l === null || r === null ? null : (l + r) / 2;
}

/** 양팔 평균. 한쪽만 보이면 그쪽, 둘 다 안 보이면 null. */
function meanVisibleArms(f: PoseFrame): number | null {
  const l = visibleEnough(f, L_ARM, MIN_VISIBILITY) ? angleOf(f, L_ARM) : null;
  const r = visibleEnough(f, R_ARM, MIN_VISIBILITY) ? angleOf(f, R_ARM) : null;
  if (l !== null && r !== null) return (l + r) / 2;
  return l ?? r;
}

function deadHangHolding(f: PoseFrame): boolean | null {
  const needed = [LM.NOSE, ...L_ARM, ...R_ARM];
  if (!visibleEnough(f, needed, MIN_VISIBILITY)) return null;
  const l = angleOf(f, L_ARM), r = angleOf(f, R_ARM);
  if (l === null || r === null) return null;
  const noseY = f.image[LM.NOSE]!.y;
  const wristsUp = f.image[LM.L_WRIST]!.y < noseY && f.image[LM.R_WRIST]!.y < noseY;
  return wristsUp && l >= DEAD_HANG_MIN_ELBOW && r >= DEAD_HANG_MIN_ELBOW;
}

export const EXERCISES: Record<ExerciseId, ExerciseDef> = {
  squat: { id: 'squat', kind: 'reps', signal: (f) => betterSideAngle(f, L_LEG, R_LEG), rep: REP_CFG.squat },
  pushup: { id: 'pushup', kind: 'reps', signal: armAngle, rep: REP_CFG.pushup },
  dumbbellBench: { id: 'dumbbellBench', kind: 'reps', signal: bothArmsMean, rep: REP_CFG.dumbbellBench },
  // 사용자 결정: 턱걸이는 팔꿈치 각도로만 판별한다(코·손목·철봉 위치는 보지 않음).
  pullup: { id: 'pullup', kind: 'reps', signal: meanVisibleArms, rep: REP_CFG.pullup },
  negative: { id: 'negative', kind: 'reps', signal: meanVisibleArms, rep: REP_CFG.negative },
  deadHang: { id: 'deadHang', kind: 'hold', holding: deadHangHolding, hold: HOLD_CFG },
};
