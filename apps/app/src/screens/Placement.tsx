import { useEffect, useRef, useState } from 'react';
import type { ExerciseId, Routine } from '@wom/core';
import type { EngineView } from '../workout/engine';
import type { MediaStore } from '../ports/mediaStore';
import { EXERCISE_NAMES } from '../domain/validate';

export type PlacementProps = { view: EngineView; routine: Routine; /** 있으면 스쿼트 45도 안내를 설정(영상 저장·본 횟수)에 맞춰 보인다 */ mediaStore?: MediaStore };

export const GUIDE_MAX_SEEN = 3;

const BAR_EXERCISES: ReadonlySet<ExerciseId> = new Set<ExerciseId>(['pullup', 'negative', 'deadHang']);

export const isBarExercise = (id: ExerciseId) => BAR_EXERCISES.has(id);

/**
 * 운동별 카메라 배치 안내. Workout 화면 위에 겹쳐 보인다.
 * - 처음과 운동이 바뀔 때(exerciseIndex 변화 또는 lastEvents의 exerciseStart) 열린다.
 * - 세트가 countdown이나 active가 되면 닫힌다. 일시정지 중에는 그리지 않는다. "확인"으로 직접 닫을 수도 있다.
 * - 쉬는 시간에도 마운트를 유지해야 같은 운동의 다음 세트에서 다시 열리지 않는다(쉬는 시간에는 그리지 않는다).
 */
export function Placement({ view, routine, mediaStore }: PlacementProps) {
  const [open, setOpen] = useState(true);
  const [seen, setSeen] = useState<{ exerciseIndex: number; events: EngineView['lastEvents'] }>({
    exerciseIndex: view.exerciseIndex,
    events: view.lastEvents,
  });

  // 렌더 중에 props 변화를 반영한다(effect를 기다리면 한 프레임 늦게 열리고 닫힌다).
  if (seen.exerciseIndex !== view.exerciseIndex || seen.events !== view.lastEvents) {
    const changed =
      seen.exerciseIndex !== view.exerciseIndex ||
      (seen.events !== view.lastEvents && view.lastEvents.some((e) => e.type === 'exerciseStart'));
    setSeen({ exerciseIndex: view.exerciseIndex, events: view.lastEvents });
    if (changed && !open) setOpen(true);
  }
  const started = view.set?.setPhase === 'countdown' || view.set?.setPhase === 'active';
  if (open && started) setOpen(false);

  const ex = routine.exercises[view.exerciseIndex];
  const visible = open && !started && !view.paused && view.phase === 'set' && !!ex;
  const isSquat = ex?.exercise === 'squat';

  // 스쿼트 촬영 안내: 영상 저장이 켜져 있고 3번 미만 본 경우에만, 운동마다 한 번 보여 주며 본 횟수를 올린다
  const [guideFor, setGuideFor] = useState<number | null>(null);
  const counted = useRef(new Set<number>());
  const idx = view.exerciseIndex;
  useEffect(() => {
    if (!visible || !isSquat || !mediaStore || counted.current.has(idx)) return;
    counted.current.add(idx);
    mediaStore.getSettings().then(
      (s) => {
        if (!s.videoEnabled || s.guideSeen >= GUIDE_MAX_SEEN) return;
        setGuideFor(idx);
        return mediaStore.putSettings({ ...s, guideSeen: s.guideSeen + 1 });
      },
      () => undefined,
    ).catch(() => undefined);
  }, [visible, isSquat, mediaStore, idx]);

  const dismissGuide = () => {
    setGuideFor(null);
    if (!mediaStore) return;
    mediaStore.getSettings().then((s) => mediaStore.putSettings({ ...s, guideSeen: GUIDE_MAX_SEEN })).catch(() => undefined);
  };

  // 일시정지 중에는 그리지 않는다("다시 시작" 버튼을 가리지 않게). open은 그대로 두어 다시 시작한 뒤 waitingReady면 다시 보인다.
  if (!visible || !ex) return null;
  const bar = isBarExercise(ex.exercise);

  return (
    <div className="placement" role="region" aria-label="카메라 배치 안내">
      <div className="placement-card">
        <h2 className="placement-title">{EXERCISE_NAMES[ex.exercise]}</h2>
        {bar ? <BarSilhouette /> : <FloorSilhouette />}
        <p className="placement-text">{bar ? '철봉과 손이 보이게' : '옆에서, 온몸이 보이게'}</p>
        {isSquat && guideFor === idx && (
          <div className="placement-guide">
            <ul>
              <li>폰을 몸 앞쪽 대각선(45도), 허리 높이에 두세요</li>
              <li>머리부터 발끝까지 여유 있게</li>
              <li>무릎이 보이는 옷(반바지나 붙는 바지), 신발은 평소대로</li>
              <li>팔은 앞으로 뻗거나 가슴 앞에 모으세요</li>
            </ul>
            <button type="button" onClick={dismissGuide}>
              다시 보지 않기
            </button>
          </div>
        )}
        <button type="button" onClick={() => setOpen(false)}>
          확인
        </button>
      </div>
    </div>
  );
}

/** 옆에서 본 사람(바닥 운동)과 옆에 놓인 휴대폰 */
function FloorSilhouette() {
  return (
    <svg className="silhouette" viewBox="0 0 200 140" aria-hidden="true">
      <line className="sil-ground" x1="10" y1="130" x2="190" y2="130" />
      <circle className="sil-body sil-head" cx="70" cy="28" r="10" />
      <line className="sil-body" x1="70" y1="38" x2="70" y2="82" />
      <line className="sil-body" x1="70" y1="48" x2="92" y2="66" />
      <line className="sil-body" x1="70" y1="82" x2="82" y2="106" />
      <line className="sil-body" x1="82" y1="106" x2="72" y2="130" />
      <rect className="sil-phone" x="160" y="90" width="16" height="28" rx="3" />
      <line className="sil-sight" x1="160" y1="100" x2="100" y2="70" />
    </svg>
  );
}

/** 철봉에 매달린 사람과 앞에 놓인 휴대폰 */
function BarSilhouette() {
  return (
    <svg className="silhouette" viewBox="0 0 200 140" aria-hidden="true">
      <line className="sil-bar" x1="30" y1="14" x2="130" y2="14" />
      <line className="sil-body" x1="68" y1="14" x2="74" y2="40" />
      <line className="sil-body" x1="92" y1="14" x2="86" y2="40" />
      <circle className="sil-body sil-head" cx="80" cy="44" r="9" />
      <line className="sil-body" x1="80" y1="53" x2="80" y2="96" />
      <line className="sil-body" x1="80" y1="96" x2="74" y2="130" />
      <line className="sil-body" x1="80" y1="96" x2="86" y2="130" />
      <rect className="sil-phone" x="160" y="90" width="16" height="28" rx="3" />
      <line className="sil-sight" x1="160" y1="100" x2="96" y2="20" />
    </svg>
  );
}
