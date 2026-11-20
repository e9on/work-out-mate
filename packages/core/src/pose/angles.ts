import type { Landmark } from '../types';

/** b를 꼭짓점으로 하는 a-b-c 사이 각도(3D, 도 단위 0~180). 벡터 길이가 0이면 NaN. */
export function jointAngle(a: Landmark, b: Landmark, c: Landmark): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const nu = Math.hypot(ux, uy, uz);
  const nv = Math.hypot(vx, vy, vz);
  if (nu === 0 || nv === 0) return NaN;
  const cos = (ux * vx + uy * vy + uz * vz) / (nu * nv);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}
