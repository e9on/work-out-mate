import { useEffect, useState } from 'react';
import type { WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';

export type HistoryProps = {
  storage: Storage;
  onOpen: (sessionId: string) => void;
  onBack: () => void;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** 로컬 시각 기준 "YYYY. M. D. HH:mm". toLocale 계열은 환경마다 달라서 쓰지 않는다. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function History({ storage, onOpen, onBack }: HistoryProps) {
  const [sessions, setSessions] = useState<WorkoutSession[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    storage.listSessions().then(
      (list) => {
        if (alive) setSessions([...list].sort((a, b) => b.endedAt - a.endedAt));
      },
      () => {
        if (alive) setError('불러오지 못했어요. 다시 시도해 주세요.');
      },
    );
    return () => {
      alive = false;
    };
  }, [storage]);

  return (
    <main className="app history">
      <h1 className="app-title">기록</h1>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {sessions && sessions.length === 0 && <p>아직 기록이 없어요</p>}
      {sessions && sessions.length > 0 && (
        <ul className="history-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <button type="button" className="history-item" onClick={() => onOpen(s.id)}>
                <span className="history-date">{formatDateTime(s.endedAt)}</span>
                <span className="history-name">{s.routineName}</span>
                <span className={s.completed ? 'badge done' : 'badge undone'}>{s.completed ? '완료' : '미완료'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="home-footer">
        <button type="button" onClick={onBack}>
          홈으로
        </button>
      </div>
    </main>
  );
}
