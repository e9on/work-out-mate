import type { WorkoutSession } from '@wom/core';
import { SetTable } from './SetTable';

export type SummaryProps = { session: WorkoutSession; onHome: () => void };

function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

/** 완료 화면: 세트 표(목표 대비 실제, 쉰 시간), 총 시간, 홈으로 */
export function Summary({ session, onHome }: SummaryProps) {
  return (
    <section className="summary screen-cover" aria-label="운동 완료">
      <h1 className="app-title">{session.completed ? '루틴 완료' : '운동을 마쳤어요'}</h1>
      <p>{session.routineName}</p>
      <p className="summary-total">{`총 시간 ${durationText(session.endedAt - session.startedAt)}`}</p>
      {session.sets.length > 0 ? <SetTable sets={session.sets} /> : <p>기록된 세트가 없어요</p>}
      <div className="home-footer">
        <button type="button" onClick={onHome}>
          홈으로
        </button>
      </div>
    </section>
  );
}
