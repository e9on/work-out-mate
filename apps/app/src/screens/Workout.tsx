import { useEffect, useRef, useState } from 'react';
import { LM, type PoseFrame, type Routine } from '@wom/core';
import type { EngineView } from '../workout/engine';
import type { PoseSource } from '../ports/pose';
import { EXERCISE_NAMES } from '../domain/validate';
import { phraseFor } from '../domain/phrases';

export type WorkoutProps = {
  view: EngineView;
  routine: Routine;
  pose: PoseSource;
  /** 관절 오버레이 canvas 크기를 카메라 영상 크기에 맞추는 데 쓴다 */
  getVideo?: () => HTMLVideoElement | null;
  onPause: () => void;
  onResume: () => void;
  onSkip: () => void;
  onStop: () => void;
  /** 세트 끝 버튼(세트 중 active일 때만 보인다) */
  onEndSet: () => void;
};

/**
 * 세트 중 화면: 관절 오버레이, "{운동} {세트+1}/{세트 수}세트", 큰 숫자(횟수 또는 버틴 초), 상태 문구, 버튼.
 * 카메라 <video>는 WorkoutFlow가 늘 마운트해 두고, 이 화면은 그 위에 겹친다.
 */
export function Workout({ view, routine, pose, getVideo, onPause, onResume, onSkip, onStop, onEndSet }: WorkoutProps) {
  const [confirming, setConfirming] = useState(false);
  const hint = useLastHint(view, routine);
  const ex = routine.exercises[view.exerciseIndex];
  const set = view.set;
  const seconds = ex?.target.kind === 'seconds';

  let status = '';
  if (view.paused) status = '일시정지';
  else if (set?.setPhase === 'countdown' && set.countdownRemainingMs !== null) status = String(Math.ceil(set.countdownRemainingMs / 1000));
  else if (set?.setPhase === 'waitingReady' && set.waitingForBreak) status = '자세를 풀었다가 다시 잡아 주세요';
  else if (hint) status = hint;
  else if (set?.setPhase === 'waitingReady') status = '준비 자세를 잡아 주세요';

  return (
    <section className="workout" aria-label="운동">
      <PoseOverlay pose={pose} getVideo={getVideo} />
      <div className="workout-hud">
        <p className="workout-title">{ex ? `${EXERCISE_NAMES[ex.exercise]} ${view.setIndex + 1}/${ex.sets}세트` : ''}</p>
        <p className="big-number">
          {seconds ? Math.floor((set?.heldMs ?? 0) / 1000) : (set?.count ?? 0)}
          <span className="unit">{seconds ? '초' : '회'}</span>
        </p>
        <p className="workout-status" aria-live="polite">
          {status}
        </p>
      </div>
      <div className="workout-actions">
        {set?.setPhase === 'active' && (
          <button type="button" className="primary end-set" onClick={onEndSet}>
            세트 끝
          </button>
        )}
        {view.paused ? (
          <button type="button" onClick={onResume}>
            다시 시작
          </button>
        ) : (
          <button type="button" onClick={onPause}>
            일시정지
          </button>
        )}
        <button type="button" onClick={onSkip}>
          건너뛰기
        </button>
        <button type="button" className="danger" onClick={() => setConfirming(true)}>
          그만하기
        </button>
      </div>

      {confirming && (
        <div className="dialog-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="stop-title" className="dialog">
            <p id="stop-title">운동을 그만할까요? 지금까지 한 세트는 저장돼요.</p>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirming(false);
                onStop();
              }}
            >
              그만하기
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              계속하기
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * lastEvents의 마지막 hint 진단 문구를 기억한다. 세트가 active로 바뀌면 지운다.
 * 렌더 중에 props 변화를 반영한다(effect를 기다리면 한 번 늦게 바뀐다).
 */
function useLastHint(view: EngineView, routine: Routine): string | null {
  const phase = view.set?.setPhase;
  const [st, setSt] = useState(() => ({ events: view.lastEvents, phase, hint: hintIn(view.lastEvents, routine, null) }));
  if (st.events === view.lastEvents && st.phase === phase) return st.hint;
  let hint = phase === 'active' && st.phase !== 'active' ? null : st.hint;
  if (st.events !== view.lastEvents) hint = hintIn(view.lastEvents, routine, hint);
  setSt({ events: view.lastEvents, phase, hint });
  return hint;
}

function hintIn(events: EngineView['lastEvents'], routine: Routine, prev: string | null): string | null {
  let h = prev;
  for (const e of events) if (e.type === 'set' && e.event.type === 'hint') h = phraseFor(e, { routine });
  return h;
}

// 관절을 잇는 선(한쪽씩)
const BONES: Array<[number, number]> = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_HIP, LM.R_HIP],
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP],
  [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.L_KNEE],
  [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE],
  [LM.R_KNEE, LM.R_ANKLE],
];
const POINTS = [...new Set(BONES.flat())];
const MIN_VISIBILITY = 0.5;

/** pose.onFrame을 직접 구독해 관절 점과 선을 canvas에 그린다. 좌표는 그리기만 하고 저장하지 않는다 */
function PoseOverlay({ pose, getVideo }: { pose: PoseSource; getVideo?: () => HTMLVideoElement | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let ctx: CanvasRenderingContext2D | null | undefined;
    return pose.onFrame((f) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // jsdom처럼 2D context가 없으면 그리지 않는다(첫 프레임에 한 번만 묻는다).
      if (ctx === undefined) ctx = canvas.getContext('2d');
      if (!ctx) return;
      const video = getVideo?.();
      if (video && video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      drawPose(ctx, canvas.width, canvas.height, f);
    });
  }, [pose, getVideo]);

  return <canvas ref={canvasRef} className="pose-overlay mirror" width={480} height={640} aria-hidden="true" />;
}

function drawPose(ctx: CanvasRenderingContext2D, w: number, h: number, f: PoseFrame): void {
  ctx.clearRect(0, 0, w, h);
  const lm = f.image;
  const ok = (i: number) => {
    const p = lm[i];
    return p !== undefined && p.visibility >= MIN_VISIBILITY;
  };
  ctx.lineWidth = Math.max(3, w / 120);
  ctx.strokeStyle = 'rgba(120, 220, 255, 0.9)';
  ctx.beginPath();
  for (const [a, b] of BONES) {
    if (!ok(a) || !ok(b)) continue;
    ctx.moveTo(lm[a]!.x * w, lm[a]!.y * h);
    ctx.lineTo(lm[b]!.x * w, lm[b]!.y * h);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  const r = Math.max(4, w / 80);
  for (const i of POINTS) {
    if (!ok(i)) continue;
    ctx.beginPath();
    ctx.arc(lm[i]!.x * w, lm[i]!.y * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
