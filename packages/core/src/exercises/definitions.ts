import type { PoseFrame } from '../types';
import { LM } from '../types';
import { jointAngle } from '../pose/angles';
import { visibleEnough } from '../pose/signal';
import type { RepConfig } from '../counter/repCounter';
import type { AdaptiveConfig } from '../counter/adaptiveRepCounter';
import type { HoldConfig } from '../counter/holdTimer';

export type ExerciseId = 'squat' | 'pushup' | 'dumbbellBench' | 'pullup' | 'negative' | 'deadHang';

/** 시작 방식: 'calibrate' 준비 자세 보정 / 'pose' 시작 자세를 잡으면 시작 / 'visible' 몸이 보이면 바로 시작 */
export type StartMode = 'calibrate' | 'pose' | 'visible';

type ExerciseCommon = {
  start: StartMode;
  /** 시작한 뒤 이 시간(ms) 동안 아무 진행이 없으면 세션을 끝낸다 */
  idleEndMs: number;
  /** start === 'pose'일 때 시작 자세인지. 판단할 관절이 안 보이면 null */
  startPose?(f: PoseFrame): boolean | null;
};

type RepExerciseBase = ExerciseCommon & {
  id: Exclude<ExerciseId, 'deadHang'>;
  kind: 'reps';
  signal(f: PoseFrame): number | null;
};
/** 고정 임계값 카운터(RepCounter)를 쓰는 운동 */
export type FixedRepExerciseDef = RepExerciseBase & { mode: 'fixed'; rep: RepConfig };
/** 준비 자세 기준 카운터(AdaptiveRepCounter)를 쓰는 운동 */
export type AdaptiveRepExerciseDef = RepExerciseBase & {
  mode: 'adaptive';
  adaptive: AdaptiveConfig;
  /** 이 프레임이 준비 자세인지(보정 중에만 쓴다). 판단할 관절이 안 보이면 null */
  ready(f: PoseFrame): boolean | null;
};
/** `mode`가 'adaptive'면 준비 자세 기준, 'fixed'면 `rep` 고정 임계값. */
export type RepExerciseDef = FixedRepExerciseDef | AdaptiveRepExerciseDef;
export type HoldExerciseDef = ExerciseCommon & {
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

const vis = (f: PoseFrame, i: number) => f.image[i]?.visibility ?? 0;

type P3 = { x: number; y: number; z: number };
const mid3 = (a: P3, b: P3): P3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/**
 * 몸통의 world 좌표 양 끝점(어깨 중점·엉덩이 중점). 가시성 판단은 image visibility, 좌표는 world를 쓴다
 * (world에는 visibility 신뢰도가 없고, 화면 비율 왜곡은 image 좌표에만 있다).
 * 양쪽 어깨·엉덩이가 모두 보이면 중점. 아니면 같은 쪽 어깨·엉덩이가 둘 다 보이는 쪽(두 점 visibility의
 * 작은 값이 더 큰 쪽)을 쓴다. world에서 반대편끼리 짝지으면 z 차이가 섞여 기울기가 왜곡되기 때문이다.
 * 같은 쪽 짝이 없으면 null.
 */
function torsoEndsWorld(f: PoseFrame): { sh: P3; hip: P3 } | null {
  const ok = (i: number) => vis(f, i) >= MIN_VISIBILITY && f.world[i] !== undefined;
  if ([LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP].every(ok)) {
    return {
      sh: mid3(f.world[LM.L_SHOULDER]!, f.world[LM.R_SHOULDER]!),
      hip: mid3(f.world[LM.L_HIP]!, f.world[LM.R_HIP]!),
    };
  }
  const sides = [[LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP]] as const;
  const usable = sides.filter(([s, h]) => ok(s) && ok(h));
  if (usable.length === 0) return null;
  const [s, h] = usable.reduce((best, c) =>
    Math.min(vis(f, c[0]), vis(f, c[1])) > Math.min(vis(f, best[0]), vis(f, best[1])) ? c : best,
  );
  return { sh: f.world[s]!, hip: f.world[h]! };
}

/**
 * 몸통(어깨→엉덩이, world 좌표)이 수평면에서 기운 각도(0 = 수평, 90 = 수직).
 * world는 미터 단위라 화면 비율에 영향받지 않는다. 기울기 = atan2(|dy|, hypot(dx, dz)).
 * 어깨나 엉덩이가 안 보이거나 값이 유한하지 않으면 null.
 */
function torsoTiltFromHorizontal(f: PoseFrame): number | null {
  const e = torsoEndsWorld(f);
  if (!e) return null;
  const dy = Math.abs(e.hip.y - e.sh.y), dh = Math.hypot(e.hip.x - e.sh.x, e.hip.z - e.sh.z);
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

const IDLE_END_MS = 5000;

export const EXERCISES = {
  squat: {
    id: 'squat', kind: 'reps', mode: 'adaptive', start: 'calibrate', idleEndMs: IDLE_END_MS,
    signal: (f) => betterSideAngle(f, L_LEG, R_LEG), ready: uprightReady, adaptive: ADAPTIVE_CFG.squat,
  },
  pushup: {
    id: 'pushup', kind: 'reps', mode: 'adaptive', start: 'calibrate', idleEndMs: IDLE_END_MS,
    signal: armAngle, ready: lyingReady, adaptive: ADAPTIVE_CFG.pushup,
  },
  dumbbellBench: {
    id: 'dumbbellBench', kind: 'reps', mode: 'adaptive', start: 'calibrate', idleEndMs: IDLE_END_MS,
    signal: meanVisibleArms, ready: lyingReady, adaptive: ADAPTIVE_CFG.dumbbellBench,
  },
  // 사용자 결정: 턱걸이는 팔꿈치 각도로만 판별한다(코·손목·철봉 위치는 보지 않음).
  pullup: {
    id: 'pullup', kind: 'reps', mode: 'fixed', start: 'pose', idleEndMs: IDLE_END_MS,
    signal: meanVisibleArms, startPose: deadHangHolding, rep: REP_CFG.pullup,
  },
  negative: {
    id: 'negative', kind: 'reps', mode: 'fixed', start: 'visible', idleEndMs: 8000,
    signal: meanVisibleArms, rep: REP_CFG.negative,
  },
  deadHang: {
    id: 'deadHang', kind: 'hold', start: 'pose', idleEndMs: IDLE_END_MS,
    holding: deadHangHolding, hold: HOLD_CFG,
  },
} satisfies Record<ExerciseId, ExerciseDef>;
