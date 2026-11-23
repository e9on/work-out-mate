import { useCallback, useEffect, useRef, useState } from 'react';
import { completedCount, recommendNext } from '@wom/core';
import type { Routine, WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';

export type HomeProps = {
  storage: Storage;
  onStart: (routine: Routine) => void;
  /** 인자 없이 부르면 새 루틴 */
  onEdit: (routine?: Routine) => void;
  onHistory: () => void;
};

export function Home({ storage, onStart, onEdit, onHistory }: HomeProps) {
  const [data, setData] = useState<{ routines: Routine[]; sessions: WorkoutSession[] } | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [routines, sessions] = await Promise.all([storage.listRoutines(), storage.listSessions()]);
      if (alive.current) setData({ routines: [...routines].sort((a, b) => a.order - b.order), sessions });
    } catch {
      if (alive.current) setError('불러오지 못했어요. 다시 시도해 주세요.');
    }
  }, [storage]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  /** 이웃 루틴과 order 값을 바꿔 저장한 뒤 목록을 다시 읽는다. */
  const swap = async (i: number, d: -1 | 1) => {
    if (!data) return;
    const a = data.routines[i];
    const b = data.routines[i + d];
    if (!a || !b) return;
    try {
      await storage.saveRoutine({ ...a, order: b.order });
      await storage.saveRoutine({ ...b, order: a.order });
      setError('');
    } catch {
      setError('순서를 바꾸지 못했어요. 다시 시도해 주세요.');
    }
    await load();
  };

  const recommended = data ? recommendNext(data.routines, data.sessions) : null;

  return (
    <main className="app home">
      <h1 className="app-title">Work Out Mate</h1>

      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      {data && data.routines.length === 0 && (
        <section className="empty">
          <p>루틴을 먼저 만들어 주세요</p>
          <button type="button" className="primary" onClick={() => onEdit()}>
            루틴 만들기
          </button>
        </section>
      )}

      {data && recommended && (
        <section className="recommend">
          <p className="label">오늘의 추천</p>
          <h2>
            {recommended.name} {completedCount(recommended.id, data.sessions) + 1}번째
          </h2>
          <button type="button" className="primary" onClick={() => onStart(recommended)}>
            시작
          </button>
        </section>
      )}

      {data && data.routines.length > 0 && (
        <>
          <ul className="routine-list" aria-label="루틴 목록">
            {data.routines.map((r, i) => (
              <li key={r.id} className="routine-item">
                <span className="routine-name">{r.name}</span>
                <div className="row-actions">
                  <button type="button" aria-label={`${r.name} 시작`} onClick={() => onStart(r)}>
                    시작
                  </button>
                  <button type="button" aria-label={`${r.name} 편집`} onClick={() => onEdit(r)}>
                    편집
                  </button>
                  <button type="button" aria-label={`${r.name} 위로`} disabled={i === 0} onClick={() => swap(i, -1)}>
                    위로
                  </button>
                  <button type="button" aria-label={`${r.name} 아래로`} disabled={i === data.routines.length - 1} onClick={() => swap(i, 1)}>
                    아래로
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="home-footer">
            <button type="button" onClick={() => onEdit()}>
              루틴 만들기
            </button>
          </div>
        </>
      )}

      <div className="home-footer">
        <button type="button" onClick={onHistory}>
          기록
        </button>
      </div>
    </main>
  );
}
