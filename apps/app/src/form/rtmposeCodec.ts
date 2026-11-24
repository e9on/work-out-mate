import type { Kp2 } from '@wom/core';
import type { Box } from './types';

export const RTM_W = 192;
export const RTM_H = 256;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

export type Crop = { sx: number; sy: number; sw: number; sh: number };

// 사람 상자(정규화)를 중심 유지·1.25배 여유·192:256 비율의 픽셀 크롭으로 바꾼다.
export function cropFor(box: Box, width: number, height: number): Crop {
  const cx = ((box[0] + box[2]) / 2) * width;
  const cy = ((box[1] + box[3]) / 2) * height;
  let w = (box[2] - box[0]) * width * 1.25;
  let h = (box[3] - box[1]) * height * 1.25;
  if (w > (h * RTM_W) / RTM_H) h = (w * RTM_H) / RTM_W;
  else w = (h * RTM_W) / RTM_H;
  return { sx: cx - w / 2, sy: cy - h / 2, sw: w, sh: h };
}

// RGBA(192x256) → CHW float. rtmlib은 BGR 순서에 MEAN/STD를 그대로 적용한다.
export function toInputTensor(rgba: Uint8ClampedArray): Float32Array {
  const n = RTM_W * RTM_H;
  const x = new Float32Array(3 * n);
  for (let k = 0; k < n; k++) {
    x[k] = (rgba[k * 4 + 2]! - MEAN[0]!) / STD[0]!;
    x[n + k] = (rgba[k * 4 + 1]! - MEAN[1]!) / STD[1]!;
    x[2 * n + k] = (rgba[k * 4]! - MEAN[2]!) / STD[2]!;
  }
  return x;
}

// SimCC(2배 해상도) argmax → 크롭 좌표(÷2) → 원본 픽셀. score는 두 최댓값 중 작은 값.
export function decodeSimcc(simccX: Float32Array, simccY: Float32Array, joints: number, crop: Crop): Kp2[] {
  const lx = simccX.length / joints;
  const ly = simccY.length / joints;
  const out: Kp2[] = [];
  for (let j = 0; j < joints; j++) {
    let bx = 0;
    let by = 0;
    for (let q = 1; q < lx; q++) if (simccX[j * lx + q]! > simccX[j * lx + bx]!) bx = q;
    for (let q = 1; q < ly; q++) if (simccY[j * ly + q]! > simccY[j * ly + by]!) by = q;
    out.push({
      x: crop.sx + (bx / 2 / RTM_W) * crop.sw,
      y: crop.sy + (by / 2 / RTM_H) * crop.sh,
      score: Math.min(simccX[j * lx + bx]!, simccY[j * ly + by]!),
    });
  }
  return out;
}
