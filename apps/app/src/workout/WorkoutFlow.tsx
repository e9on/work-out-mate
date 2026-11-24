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
import { Workout } from '../screens/Workout';
import { Rest } from '../screens/Rest';
import { Summary } from '../screens/Summary';
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
};

/** 첫 렌더에서 한 번만 만든다(useWorkout도 mount 때 deps만 쓴다) */
function buildDeps(
  routine: Routine,
  storage: Storage,
  d: WorkoutFlowDeps = {},
  mediaStore?: MediaStore,
  analysisQueue?: AnalysisQueue,
  getStream: () => MediaStream | null = () => null,
): EngineDeps {
  const epochOffset = d.epochOffset ?? Date.now() - performance.now();
  let capture: SetCapture | undefined = d.capture;
  if (!capture && mediaStore) {
    capture = createSetCapture({
      store: mediaStore,
      recorder: createMediaRecorder(getStream, () => Date.now()),
      onSaved: (key) => analysisQueue?.enqueue(key),
    });
  }
  return {
    routine,
    storage,
    pose: d.pose ?? createMediapipePose(),
    speech: d.speech ?? createSpeech(),
    keepAwake: d.keepAwake ?? createKeepAwake(),
    now: d.now ?? (() => performance.now()),
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
export function WorkoutFlow({ routine, storage, mediaStore, analysisQueue, onHome, deps }: WorkoutFlowProps) {
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
    if (view.ended) content = <Summary session={view.ended} onHome={onHome} mediaStore={mediaStore} analysisQueue={analysisQueue} />;
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
      {showPlacement && <Placement view={view} routine={routine} />}
    </main>
  );
}
