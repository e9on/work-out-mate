import type { EndReason, SetLog } from '@wom/core';
import { EXERCISE_NAMES } from '../domain/validate';
import { targetText } from '../domain/format';

const END_REASON: Record<EndReason, string> = {
  target: '목표 달성',
  idle: '멈춤',
  manual: '그만하기',
  button: '세트 끝',
  released: '손 놓음',
};

const actualText = (l: SetLog) => (l.target.kind === 'reps' ? `${l.count}회` : `${Math.round(l.heldMs / 1000)}초`);
const restText = (ms: number | null) => (ms === null ? '-' : `${Math.round(ms / 1000)}초`);

/** 세트 기록 표(기록 상세·완료 화면 공용): 운동, 세트, 목표, 실제, 쉰 시간, 종료 사유 */
export function SetTable({ sets }: { sets: SetLog[] }) {
  return (
    <div className="table-wrap">
      <table className="set-table">
        <thead>
          <tr>
            <th scope="col">운동</th>
            <th scope="col">세트</th>
            <th scope="col">목표</th>
            <th scope="col">실제</th>
            <th scope="col">쉰 시간</th>
            <th scope="col">종료 사유</th>
          </tr>
        </thead>
        <tbody>
          {sets.map((l, i) => (
            <tr key={i}>
              <td>{EXERCISE_NAMES[l.exercise]}</td>
              <td>{l.setIndex + 1}</td>
              <td>{targetText(l.target)}</td>
              <td>{actualText(l)}</td>
              <td>{restText(l.restTakenMs)}</td>
              <td>{END_REASON[l.endReason]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
