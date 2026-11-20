import type { PoseFrame } from '../types';
import { LM } from '../types';
import { jointAngle } from '../pose/angles';
import { visibleEnough } from '../pose/signal';
import type { RepConfig } from '../counter/repCounter';
import type { AdaptiveConfig } from '../counter/adaptiveRepCounter';
import type { HoldConfig } from '../counter/holdTimer';

export type ExerciseId = 'squat' | 'pushup' | 'dumbbellBench' | 'pullup' | 'negative' | 'deadHang';

type RepExerciseBase = {
  id: Exclude<ExerciseId, 'deadHang'>;
  kind: 'reps';
  signal(f: PoseFrame): number | null;
};
/** 고정 임계값 카운터(RepCounter)를 쓰는 운동 */
export type FixedRepExerciseDef = RepExerciseBase & { rep: RepConfig; adaptive?: never; ready?: never };
/** 준비 자세 기준 카운터(AdaptiveRepCounter)를 쓰는 운동 */
export type AdaptiveRepExerciseDef = RepExerciseBase & {
  adaptive: AdaptiveConfig;
  /** 이 프레임이 준비 자세인지(보정 중에만 쓴다). 판단할 관절이 안 보이면 null */
  ready(f: PoseFrame): boolean | null;
  rep?: never;
};
/** `def.adaptive`가 있으면 준비 자세 기준, 없으면 `def.rep` 고정 임계값. */
export type RepExerciseDef = FixedRepExerciseDef | AdaptiveRepExerciseDef;
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
  pullup: { restSide: 'high', enter: 140, turn: 80, exit: 155, ...COMMON },
  negative: { restSide: 'low', enter: 100, turn: 140, exit: 95, countAt: 'turn', ...COMMON, minRepMs: 250 },
} satisfies Record<string, RepConfig>;
// 준비 자세 기준(Task 6b). 실측(S23): 푸시업 준비 166~169, 반복 사이 맨 위 155~157, 바닥 90~114.
// 바닥 = 준비 자세 - depth, 시작 = 직전 최고점 - startDrop, 복귀 = 이번 최저점 + rebound.
const CALIBRATE = { calibrateMs: 700, calibrateTol: 8, calibrateTimeoutMs: 3000 } as const;
const ADAPTIVE_CFG = {
  squat: { restSide: 'high', depth: 60, rebound: 35, startDrop: 10, defaultBaseline: 170, minBaseline: 150, ...CALIBRATE, ...COMMON },
  pushup: { restSide: 'high', depth: 40, rebound: 30, startDrop: 10, defaultBaseline: 165, minBaseline: 140, ...CALIBRATE, ...COMMON },
  dumbbellBench: { restSide: 'high', depth: 40, rebound: 30, startDrop: 10, defaultBaseline: 165, minBaseline: 140, ...CALIBRATE, ...COMMON },
} satisfies Record<string, AdaptiveConfig>;
const HOLD_CFG: HoldConfig = { startAfterMs: 300, graceMs: 500 };
const MIN_VISIBILITY = 0.5;
const DEAD_HANG_MIN_ELBOW = 150;
/** 준비 자세 확인: 몸통이 수평(푸시업·벤치) 또는 수직(스쿼트)에서 이 각도 이내 */
const READY_TORSO_TOL_DEG = 35;

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

/** 양팔 평균. 한쪽만 보이면 그쪽, 둘 다 안 보이면 null. */
function meanVisibleArms(f: PoseFrame): number | null {
  const l = visibleEnough(f, L_ARM, MIN_VISIBILITY) ? angleOf(f, L_ARM) : null;
  const r = visibleEnough(f, R_ARM, MIN_VISIBILITY) ? angleOf(f, R_ARM) : null;
  if (l !== null && r !== null) return (l + r) / 2;
  return l ?? r;
}

/** 보이는(image visibility ≥ 0.5) 점들의 world 좌표 평균. 하나도 안 보이면 null */
function visibleMidWorld(f: PoseFrame, idx: readonly number[]): { x: number; y: number; z: number } | null {
  const pts = idx
    .filter((i) => (f.image[i]?.visibility ?? 0) >= MIN_VISIBILITY)
    .map((i) => f.world[i])
    .filter((p) => p !== undefined);
  if (pts.length === 0) return null;
  const n = pts.length;
  return { x: pts.reduce((s, p) => s + p!.x, 0) / n, y: pts.reduce((s, p) => s + p!.y, 0) / n, z: pts.reduce((s, p) => s + p!.z, 0) / n };
}

/**
 * 몸통(어깨 중점 → 엉덩이 중점, world 좌표)이 수평면에서 기운 각도(0 = 수평, 90 = 수직).
 * world는 미터 단위라 화면 비율에 영향받지 않는다. 기울기 = atan2(|dy|, hypot(dx, dz)).
 * 한쪽 어깨·엉덩이만 보여도(image visibility 기준) 그 점을 쓴다(옆에서 찍으면 먼 쪽이 가려지므로).
 * 어깨나 엉덩이가 전혀 안 보이거나 값이 유한하지 않으면 null.
 */
function torsoTiltFromHorizontal(f: PoseFrame): number | null {
  const sh = visibleMidWorld(f, [LM.L_SHOULDER, LM.R_SHOULDER]);
  const hip = visibleMidWorld(f, [LM.L_HIP, LM.R_HIP]);
  if (!sh || !hip) return null;
  const dy = Math.abs(hip.y - sh.y), dh = Math.hypot(hip.x - sh.x, hip.z - sh.z);
  if (dy === 0 && dh === 0) return null;
  const a = (Math.atan2(dy, dh) * 180) / Math.PI;
  return Number.isFinite(a) ? a : null;
}

/** 엎드림·누움(푸시업·벤치): 몸통이 수평에서 35° 이내 */
function lyingReady(f: PoseFrame): boolean | null {
  const a = torsoTiltFromHorizontal(f);
  return a === null ? null : a <= READY_TORSO_TOL_DEG;
}

/** 서 있음(스쿼트): 몸통이 수직에서 35° 이내 */
function uprightReady(f: PoseFrame): boolean | null {
  const a = torsoTiltFromHorizontal(f);
  return a === null ? null : a >= 90 - READY_TORSO_TOL_DEG;
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
  squat: { id: 'squat', kind: 'reps', signal: (f) => betterSideAngle(f, L_LEG, R_LEG), ready: uprightReady, adaptive: ADAPTIVE_CFG.squat },
  pushup: { id: 'pushup', kind: 'reps', signal: armAngle, ready: lyingReady, adaptive: ADAPTIVE_CFG.pushup },
  dumbbellBench: { id: 'dumbbellBench', kind: 'reps', signal: meanVisibleArms, ready: lyingReady, adaptive: ADAPTIVE_CFG.dumbbellBench },
  // 사용자 결정: 턱걸이는 팔꿈치 각도로만 판별한다(코·손목·철봉 위치는 보지 않음).
  pullup: { id: 'pullup', kind: 'reps', signal: meanVisibleArms, rep: REP_CFG.pullup },
  negative: { id: 'negative', kind: 'reps', signal: meanVisibleArms, rep: REP_CFG.negative },
  deadHang: { id: 'deadHang', kind: 'hold', holding: deadHangHolding, hold: HOLD_CFG },
};
