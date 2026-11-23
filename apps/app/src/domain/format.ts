import type { Target } from '@wom/core';

/** 세트 목표 표기: "10회" / "30초" */
export function targetText(t: Target): string {
  return t.kind === 'reps' ? `${t.reps}회` : `${t.seconds}초`;
}
