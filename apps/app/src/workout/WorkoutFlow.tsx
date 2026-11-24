import { useCallback, useEffect, useRef, useState } from 'react';
import type { Routine } from '@wom/core';
import type { Storage } from '../ports/storage';
import type { MediaStore } from '../ports/mediaStore';
import { createSetCapture, type SetCapture } from '../form/setCapture';
import type { AnalysisQueue } from '../form/analysisQueue';
import { createMediaRecorder } from '../platform/mediaRecorderCapture';
import type { EngineDeps } from './engine';
import { useWorkout } from './useWorkout';
import { createMediapipePose } from '../platform/mediapipePose';
import { createSpeech } from '../platform/createSpeech';
import { createKeepAwake } from '../platform/keepAwake';
import { applyRetention, type ClipCutter } from '../form/retention';
import { createClipCutter } from '../platform/clipCutter';
import { Workout } from '../screens/Workout';
import { Rest } from '../screens/Rest';
import { Summary } from '../screens/Summary';
import { RepPlayer } from '../screens/RepPlayer';
import type { SetKey } from '../form/types';
import { Placement } from '../screens/Placement';
import { CameraErrorView } from '../screens/CameraErrorView';

/** 테스트 주입용. 빠진 것은 실제 플랫폼 구현과 브라우저 시계로 채운다 */
export type WorkoutFlowDeps = Partial<Omit<EngineDeps, 'routine' | 'storage'>>;
export type WorkoutFlowProps = {
  routine: Routine;
  storage: Storage;
  /** 없으면 세트 영상을 녹화하지 않는다 */
  mediaStore?: MediaStore;
  /** 세트 영상이 저장되면 분석 대기열에 넣고, 세트 진행 중에는 분석을 멈추게 한다 */
  analysisQueue?: AnalysisQueue;
  onHome: () => void;
  deps?: WorkoutFlowDeps;
  /** 테스트 주입용. 없으면 실제 클립 자르개 */
  clipCutter?: ClipCutter;
};

/** 첫 렌더에서 한 번만 만든다(useWorkout도 mount 때 deps만 쓴다). 테스트용으로 내보낸다 */
export function buildDeps(
  routine: Routine,
  storage: Storage,
  d: WorkoutFlowDeps = {},
  mediaStore?: MediaStore,
  analysisQueue?: AnalysisQueue,
  getStream: () => MediaStream | null = () => null,
): EngineDeps {
  const epochOffset = d.epochOffset ?? Date.now() - performance.now();
  const now = d.now ?? (() => performance.now());
  let capture: SetCapture | undefined = d.capture;
  if (!capture && mediaStore) {
    capture = createSetCapture({
      store: mediaStore,
      // 반복 시각·상자 시각(now + epochOffset)과 같은 시계로 녹화 시작 시각을 잰다.
      // Date.now()를 따로 쓰면 절전·시각 보정 때 둘이 벌어져 영상 위치가 어긋난다
      recorder: createMediaRecorder(getStream, () => now() + epochOffset),
      onSaved: (key) => analysisQueue?.enqueue(key),
    });
  }
  return {
    routine,
    storage,
    pose: d.pose ?? createMediapipePose(),
    speech: d.speech ?? createSpeech(),
    keepAwake: d.keepAwake ?? createKeepAwake(),
    now,
    epochOffset,
    newId: d.newId ?? (() => crypto.randomUUID()),
    setInterval: d.setInterval ?? ((cb, ms) => window.setInterval(cb, ms)),
    clearInterval: d.clearInterval ?? ((h) => window.clearInterval(h as number)),
    capture,
  };
}

/**
 * 운동 흐름 컨테이너. 엔진 view를 보고 화면을 고른다:
 * ended → Summary, cameraError → 오류 화면, rest → Rest, 그 밖에는 Workout(+ Placement 겹침).
 * 카메라 <video>는 화면이 바뀌어도 같은 요소를 쓰도록 늘 마운트해 둔다(다른 화면은 그 위를 덮는다).
 */
export function WorkoutFlow({ routine, storage, mediaStore, analysisQueue, onHome, deps, clipCutter }: WorkoutFlowProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [d] = useState(() =>
    buildDeps(routine, storage, deps, mediaStore, analysisQueue, () => {
      const src = videoRef.current?.srcObject;
      return typeof MediaStream !== 'undefined' && src instanceof MediaStream ? src : null;
    }),
  );
  const { view, engine } = useWorkout(d);
  // 세트 화면(준비·카운트다운·진행)이면 분석을 멈추고, 쉬는 시간·루틴 끝·화면을 떠난 뒤에는 돌린다
  const setBusy = !!view && !view.ended && view.phase === 'set';
  useEffect(() => {
    analysisQueue?.setBusy(setBusy);
  }, [analysisQueue, setBusy]);
  useEffect(() => () => analysisQueue?.setBusy(false), [analysisQueue]);

  // 세션이 최종 저장된 뒤 한 번, 오래된 영상을 정리한다(실패해도 화면은 그대로)
  const retained = useRef(false);
  const ended = !!view?.ended;
  useEffect(() => {
    if (!ended || !mediaStore || retained.current) return;
    retained.current = true;
    applyRetention({ storage, store: mediaStore, cutter: clipCutter ?? createClipCutter() }).catch((e) => console.warn('영상 정리 실패', e));
  }, [ended, mediaStore, storage, clipCutter]);

  // 결과 화면에서 다시 보기를 누르면 그 위에 재생 화면을 겹쳐 띄운다
  const [player, setPlayer] = useState<{ setKey: SetKey; index: number } | null>(null);

  const getVideo = useCallback(() => videoRef.current, []);

  const start = useCallback(() => {
    const video = videoRef.current;
    if (engine && video) void engine.start(video);
  }, [engine]);

  useEffect(() => {
    start();
  }, [start]);

  let content = null;
  if (view && engine) {
    if (view.ended) content = <Summary session={view.ended} onHome={onHome} mediaStore={mediaStore} analysisQueue={analysisQueue} onPlay={(setKey, index) => setPlayer({ setKey, index })} />;
    else if (view.cameraError) content = <CameraErrorView kind={view.cameraError} onRetry={start} onHome={onHome} />;
    else if (view.phase === 'rest')
      content = <Rest view={view} onSkipRest={() => engine.skipRest()} onPause={() => engine.pause()} onResume={() => engine.resume()} />;
    else
      content = (
        <Workout
          view={view}
          routine={routine}
          pose={d.pose}
          getVideo={getVideo}
          onPause={() => engine.pause()}
          onResume={() => engine.resume()}
          onSkip={() => engine.skipExercise()}
          onEndSet={() => engine.endSet()}
          onStop={() => void engine.stop()}
        />
      );
  }
  const showPlacement = view !== null && !view.ended && !view.cameraError;

  return (
    <main className="workout-flow">
      <video ref={videoRef} className="camera-video mirror" playsInline muted autoPlay aria-hidden="true" />
      {content}
      {player && view?.ended && mediaStore && (
        <div className="player-host">
          <RepPlayer
            key={`${player.setKey}#${player.index}`}
            store={mediaStore}
            storage={storage}
            sessionId={view.ended.id}
            setKey={player.setKey}
            index={player.index}
            onBack={() => setPlayer(null)}
          />
        </div>
      )}
      {showPlacement && <Placement view={view} routine={routine} mediaStore={mediaStore} />}
    </main>
  );
}
