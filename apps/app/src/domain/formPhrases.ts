import type { FindingKind, SetNote } from '@wom/core';
import type { SetAnalysis } from '../form/types';

export const FINDING_PHRASES: Record<FindingKind, string> = {
  depth: '허벅지가 바닥과 평행해질 때까지 앉지 않았어요',
  kneeIn: '무릎이 발보다 안쪽으로 모였어요',
  kneeInRelative: '평소보다 무릎이 모였어요',
  heel: '뒤꿈치가 바닥에서 떨어졌어요',
};

export const NO_FINDINGS = '자세 지적 없음';

export const analyzingText = (done: number, total: number) => `분석 중… (${done}/${total})`;

/** 영상은 있는데 아직 분석이 없는 세트 */
export const ANALYZING_SET = '분석 중…';

/** 일부 반복을 판정하지 못했을 때(사람이 안 보이거나 한쪽 다리만 굽힘) */
export const unjudgedText = (n: number) => `${n}회는 판정하지 못했어요`;

export const REASON_PHRASES: Record<NonNullable<SetAnalysis['reason']>, string> = {
  noVideo: '영상이 없어 분석하지 못했어요',
  noPerson: '사람이 화면에 보이지 않아 분석하지 못했어요',
  error: '분석 중 문제가 생겼어요',
};

export function notePhrase(n: SetNote): string {
  return `이번 세트는 평균 ${(n.avgDescentMs / 1000).toFixed(1)}초 만에 내려갔어요. 2초 이상 천천히 내려가 보세요`;
}

/** 초를 m:ss로(0 아래는 0) */
export function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** "{index}번째 ({m:ss})  {문구}" — offsetSec이 null이면 시각 부분 없음 */
export function findingLine(index: number, offsetSec: number | null, phrase: string): string {
  return offsetSec === null ? `${index}번째  ${phrase}` : `${index}번째 (${mmss(offsetSec)})  ${phrase}`;
}
