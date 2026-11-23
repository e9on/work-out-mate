import { useEffect, useState } from 'react';
import type { EndReason, SetLog, WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';
import { EXERCISE_NAMES } from '../domain/validate';
import { formatDateTime } from './History';

export type SessionDetailProps = {
  storage: Storage;
  sessionId: string;
  onBack: () => void;
};

const END_REASON: Record<EndReason, string> = {
  target: '목표 달성',
  idle: '멈춤',
  manual: '그만하기',
  released: '손 놓음',
};

const targetText = (l: SetLog) => (l.target.kind === 'reps' ? `${l.target.reps}회` : `${l.target.seconds}초`);
const actualText = (l: SetLog) => (l.target.kind === 'reps' ? `${l.count}회` : `${Math.round(l.heldMs / 1000)}초`);
const restText = (ms: number | null) => (ms === null ? '-' : `${Math.round(ms / 1000)}초`);

export function SessionDetail({ storage, sessionId, onBack }: SessionDetailProps) {
  // undefined: 읽는 중, null: 없음
  const [session, setSession] = useState<WorkoutSession | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    storage.getSession(sessionId).then(
      (s) => {
        if (alive) setSession(s);
      },
      () => {
        if (alive) setSession(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [storage, sessionId]);

  return (
    <main className="app session-detail">
      <h1 className="app-title">{session ? session.routineName : '기록 상세'}</h1>
      {session === null && <p>기록을 찾을 수 없어요</p>}
      {session && (
        <>
          <p>
            {formatDateTime(session.endedAt)} · {session.completed ? '완료' : '미완료'}
          </p>
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
                {session.sets.map((l, i) => (
                  <tr key={i}>
                    <td>{EXERCISE_NAMES[l.exercise]}</td>
                    <td>{l.setIndex + 1}</td>
                    <td>{targetText(l)}</td>
                    <td>{actualText(l)}</td>
                    <td>{restText(l.restTakenMs)}</td>
                    <td>{END_REASON[l.endReason]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="home-footer">
        <button type="button" onClick={onBack}>
          기록으로
        </button>
      </div>
    </main>
  );
}
