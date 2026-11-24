import { useEffect, useState } from 'react';
import type { WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';
import { formatDateTime } from './History';
import type { AnalysisQueue } from '../form/analysisQueue';
import type { SetKey } from '../form/types';
import type { MediaStore } from '../ports/mediaStore';
import { FormFindings } from './FormFindings';
import { SetTable } from './SetTable';

export type SessionDetailProps = {
  storage: Storage;
  sessionId: string;
  onBack: () => void;
  mediaStore?: MediaStore;
  analysisQueue?: AnalysisQueue;
  onPlay?: (setKey: SetKey, index: number) => void;
};

export function SessionDetail({ storage, sessionId, onBack, mediaStore, analysisQueue, onPlay }: SessionDetailProps) {
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
          <SetTable sets={session.sets} />
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
