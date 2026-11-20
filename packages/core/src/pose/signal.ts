import type { PoseFrame } from '../types';

/** 지수이동평균. null 입력은 null을 내고 내부 값은 유지한다. */
export class Ema {
  private value: number | null = null;

  constructor(private readonly alpha: number) {}

  next(v: number | null): number | null {
    if (v === null) return null;
    this.value = this.value === null ? v : this.alpha * v + (1 - this.alpha) * this.value;
    return this.value;
  }

  reset(): void {
    this.value = null;
  }
}

/** idx의 모든 랜드마크 visibility가 min 이상이면 true. */
export function visibleEnough(frame: PoseFrame, idx: readonly number[], min = 0.5): boolean {
  return idx.every((i) => (frame.image[i]?.visibility ?? 0) >= min);
}
