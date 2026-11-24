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
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
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

  /**
   * 이웃 루틴과 자리를 바꾼 화면 순서대로 order를 0..n-1로 모두 다시 매기고, order가 바뀐 루틴만 저장한 뒤 목록을 다시 읽는다.
   * 전체를 다시 매기므로 order가 겹친 데이터도 바로잡힌다. 처리 중에는 순서 버튼을 막는다.
   */
  const swap = async (i: number, d: -1 | 1) => {
    if (!data || movingRef.current) return;
    const list = [...data.routines];
    const a = list[i];
    const b = list[i + d];
    if (!a || !b) return;
    list[i] = b;
    list[i + d] = a;
    movingRef.current = true;
    setMoving(true);
    try {
      for (const [order, r] of list.entries()) {
        if (r.order !== order) await storage.saveRoutine({ ...r, order });
      }
      setError('');
    } catch {
      setError('순서를 바꾸지 못했어요. 다시 시도해 주세요.');
    }
    await load();
    movingRef.current = false;
    if (alive.current) setMoving(false);
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
                  <button type="button" aria-label={`${r.name} 위로`} disabled={moving || i === 0} onClick={() => swap(i, -1)}>
                    위로
                  </button>
                  <button type="button" aria-label={`${r.name} 아래로`} disabled={moving || i === data.routines.length - 1} onClick={() => swap(i, 1)}>
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
