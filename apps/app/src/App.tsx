import { useEffect, useState } from 'react';
import type { Routine } from '@wom/core';
import type { Storage } from './ports/storage';
import { createIdbStorage } from './storage/idbStorage';
import { Home } from './screens/Home';
import { RoutineEdit } from './screens/RoutineEdit';
import { History } from './screens/History';
import { SessionDetail } from './screens/SessionDetail';

// 라우터 라이브러리 없이 상태 하나로 화면을 고른다.
type Screen =
  | { kind: 'home' }
  | { kind: 'edit'; routine?: Routine }
  | { kind: 'history' }
  | { kind: 'detail'; sessionId: string }
  | { kind: 'workout'; routine: Routine };

export type AppProps = { storage?: Storage };

export function App({ storage: injected }: AppProps = {}) {
  const [storage] = useState<Storage>(() => injected ?? createIdbStorage());
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [nextOrder, setNextOrder] = useState(0);
  const home = () => setScreen({ kind: 'home' });

  // 편집 화면에 넘길 order: 기존 루틴 order의 최댓값 + 1(없으면 0)
  const editing = screen.kind === 'edit';
  useEffect(() => {
    if (!editing) return;
    let alive = true;
    storage.listRoutines().then((rs) => {
      if (alive) setNextOrder(rs.length === 0 ? 0 : Math.max(...rs.map((r) => r.order)) + 1);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [editing, storage]);

  switch (screen.kind) {
    case 'edit':
      return <RoutineEdit key={screen.routine?.id ?? 'new'} storage={storage} routine={screen.routine} nextOrder={nextOrder} onDone={home} />;
    case 'history':
      return <History storage={storage} onOpen={(sessionId) => setScreen({ kind: 'detail', sessionId })} onBack={home} />;
    case 'detail':
      return <SessionDetail storage={storage} sessionId={screen.sessionId} onBack={() => setScreen({ kind: 'history' })} />;
    case 'workout':
      return (
        <main className="app">
          <h1 className="app-title">Work Out Mate</h1>
          <p>운동 화면 준비 중</p>
          <button type="button" onClick={home}>
            홈으로
          </button>
        </main>
      );
    default:
      return (
        <Home
          storage={storage}
          onStart={(routine) => setScreen({ kind: 'workout', routine })}
          onEdit={(routine) => setScreen({ kind: 'edit', routine })}
          onHistory={() => setScreen({ kind: 'history' })}
        />
      );
  }
}
