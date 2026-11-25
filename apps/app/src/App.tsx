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
import { CONSENT_VERSION, ConsentPrompt } from './screens/ConsentPrompt';
import { runExport } from './form/exportData';
import { createExportFile } from './platform/exportFile';
import { APP_VERSION } from './appVersion';
import { RepPlayer } from './screens/RepPlayer';
import type { AppSettings, SetKey } from './form/types';
import { WorkoutFlow, type WorkoutFlowDeps } from './workout/WorkoutFlow';
import { useBackHandler } from './platform/backButton';

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
  // 처음 켤 때 영상 저장 안내: 동의 여부를 정한 적도, 안내를 본 적도 없으면 홈에서 한 번 보여 준다.
  // 홈으로 올 때마다 최신 설정으로 다시 판단한다(설정 화면에서 먼저 켰다면 묻지 않음).
  // 설정을 읽지 못하면(저장소 오류) 묻지 않는다. 설정 화면에서 언제든 켤 수 있다.
  const [firstRun, setFirstRun] = useState(false);
  const atHome = screen.kind === 'home';
  useEffect(() => {
    if (!atHome) {
      setFirstRun(false);
      return;
    }
    let alive = true;
    mediaStore.getSettings().then(
      (s) => {
        if (alive) setFirstRun(s.consent === null && !s.firstRunPrompted);
      },
      (e) => console.warn('설정을 읽지 못해 첫 실행 안내를 건너뜀', e),
    );
    return () => {
      alive = false;
    };
  }, [atHome, mediaStore]);
  // 닫을 때 최신 설정을 다시 읽어 병합한다. 그 사이 동의 여부가 정해졌으면 그 값을 덮어쓰지 않는다.
  const finishFirstRun = (pick: (s: AppSettings) => AppSettings) => {
    setFirstRun(false);
    mediaStore
      .getSettings()
      .then((latest) => mediaStore.putSettings(latest.consent === null ? pick(latest) : { ...latest, firstRunPrompted: true }))
      .catch((e) => console.warn('첫 실행 안내 결과 저장 실패', e));
  };
  const firstRunDialog = firstRun && (
    <ConsentPrompt
      cancelLabel="영상 없이 쓰기"
      onConfirm={(agreed) =>
        finishFirstRun((s) => ({ ...s, videoEnabled: true, consent: { agreed, version: CONSENT_VERSION, at: Date.now() }, firstRunPrompted: true }))
      }
      onCancel={() => finishFirstRun((s) => ({ ...s, firstRunPrompted: true }))}
    />
  );
  // 폰 뒤로 가기: 화면마다 바로 위 화면으로. 홈은 처리하지 않아 앱 기본 동작(뒤로 보냄)으로 넘긴다.
  // 운동 중에는 WorkoutFlow·Workout이 위에서 먼저 받고, 넘어오면 아무것도 하지 않는다(운동이 끊기지 않게).
  useBackHandler(() => {
    switch (screen.kind) {
      case 'home':
        return false;
      case 'detail':
        setScreen({ kind: 'history' });
        return true;
      case 'player':
        setScreen({ kind: 'detail', sessionId: screen.sessionId });
        return true;
      case 'workout':
        return true;
      default:
        setScreen({ kind: 'home' });
        return true;
    }
  });
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
      return (
        <Settings
          mediaStore={mediaStore}
          storage={storage}
          onBack={home}
          onExport={() => runExport({ storage, store: mediaStore, appVersion: APP_VERSION, file: createExportFile() })}
        />
      );
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
        <>
          <Home
            storage={storage}
            onStart={(routine) => setScreen({ kind: 'workout', routine })}
            onEdit={(routine) => setScreen({ kind: 'edit', routine })}
            onHistory={() => setScreen({ kind: 'history' })}
            onSettings={() => setScreen({ kind: 'settings' })}
          />
          {firstRunDialog}
        </>
      );
  }
}
