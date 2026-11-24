/** RTMPose-m(Halpe26) 관절점 번호. 운동 뒤 자세 분석에서만 쓴다. */
export const HALPE = {
  L_HIP: 11,
  R_HIP: 12,
  L_KNEE: 13,
  R_KNEE: 14,
  L_ANKLE: 15,
  R_ANKLE: 16,
  L_BIG_TOE: 20,
  R_BIG_TOE: 21,
  L_HEEL: 24,
  R_HEEL: 25,
} as const;

/** 화면 픽셀 좌표(y는 아래가 +). */
export type Kp2 = { x: number; y: number; score: number };

/** t는 RepTiming과 같은 시계(ms). kps는 26개 또는 null(사람 없음). */
export type KpFrame = { t: number; kps: Kp2[] | null };
