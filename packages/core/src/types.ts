/** 관절 한 점. image는 정규화 좌표, world는 미터 좌표. */
export type Landmark = { x: number; y: number; z: number; visibility: number };

/** t는 ms, image/world는 각각 33개 랜드마크. */
export type PoseFrame = { t: number; image: Landmark[]; world: Landmark[] };

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
} as const;
