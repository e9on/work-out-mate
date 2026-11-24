import { useEffect, useState } from 'react';
import type { Routine } from '@wom/core';
import type { Storage } from './ports/storage';
import type { MediaStore } from './ports/mediaStore';
import { createAnalysisQueue, type AnalysisQueue } from './form/analysisQueue';
import type { FormPoseModel } from './ports/formPose';
import { createVideoFrameReader } from './platform/videoFrameReader';
import { createIdbMediaStore } from './storage/idbMediaStore';
import { createIdbStorage } from './storage/idbStorage';
import { Home } from './screens/Home';
import { RoutineEdit } from './screens/RoutineEdit';
import { History } from './screens/History';
import { SessionDetail } from './screens/SessionDetail';
import { Settings } from './screens/Settings';
import { RepPlayer } from './screens/RepPlayer';
import type { SetKey } from './form/types';
import { WorkoutFlow, type WorkoutFlowDeps } from './workout/WorkoutFlow';

// 라우터 라이브러리 없이 상태 하나로 화면을 고른다.
type Screen =
  | { kind: 'home' }
  | { kind: 'edit'; routine?: Routine }
  | { kind: 'history' }
  | { kind: 'settings' }
  | { kind: 'detail'; sessionId: string }
  | { kind: 'player'; sessionId: string; setKey: SetKey; index: number }
  | { kind: 'workout'; routine: Routine };

export type AppProps = { storage?: Storage; mediaStore?: MediaStore; analysisQueue?: AnalysisQueue; workoutDeps?: WorkoutFlowDeps };

/** onnxruntime-web은 크니 첫 화면 번들에 넣지 않고, 분석이 처음 필요할 때 불러온다 */
const loadFormModel = async (): Promise<FormPoseModel> => (await import('./platform/rtmposeOrt')).createRtmposeModel();

export function App({ storage: injected, mediaStore: injectedMedia, analysisQueue: injectedQueue, workoutDeps }: AppProps = {}) {
  const [storage] = useState<Storage>(() => injected ?? createIdbStorage());
  const [mediaStore] = useState<MediaStore>(() => injectedMedia ?? createIdbMediaStore());
  const [analysisQueue] = useState<AnalysisQueue>(
    () => injectedQueue ?? createAnalysisQueue({ store: mediaStore, storage, model: loadFormModel, reader: createVideoFrameReader(), now: () => Date.now() }),
  );
  // 앱을 켤 때 분석이 안 끝난 세트 영상을 이어서 분석한다
  useEffect(() => {
    analysisQueue.resumePending().catch((e) => console.warn('분석 이어서 하기 실패', e));
  }, [analysisQueue]);
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
    case 'settings':
      return <Settings mediaStore={mediaStore} storage={storage} onBack={home} />;
    case 'history':
      return <History storage={storage} onOpen={(sessionId) => setScreen({ kind: 'detail', sessionId })} onBack={home} />;
    case 'detail':
      return (
        <SessionDetail
          storage={storage}
          sessionId={screen.sessionId}
          mediaStore={mediaStore}
          analysisQueue={analysisQueue}
          onPlay={(setKey, index) => setScreen({ kind: 'player', sessionId: screen.sessionId, setKey, index })}
          onBack={() => setScreen({ kind: 'history' })}
        />
      );
    case 'player':
      return (
        <RepPlayer
          key={`${screen.setKey}#${screen.index}`}
          store={mediaStore}
          storage={storage}
          sessionId={screen.sessionId}
          setKey={screen.setKey}
          index={screen.index}
          onBack={() => setScreen({ kind: 'detail', sessionId: screen.sessionId })}
        />
      );
    case 'workout':
      return <WorkoutFlow key={screen.routine.id} routine={screen.routine} storage={storage} mediaStore={mediaStore} analysisQueue={analysisQueue} onHome={home} deps={workoutDeps} />;
    default:
      return (
        <Home
          storage={storage}
          onStart={(routine) => setScreen({ kind: 'workout', routine })}
          onEdit={(routine) => setScreen({ kind: 'edit', routine })}
          onHistory={() => setScreen({ kind: 'history' })}
          onSettings={() => setScreen({ kind: 'settings' })}
        />
      );
  }
}
