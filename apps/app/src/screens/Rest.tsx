import type { EngineView } from '../workout/engine';
import { EXERCISE_NAMES } from '../domain/validate';
import { targetText } from '../domain/format';

export type RestProps = { view: EngineView; onSkipRest: () => void; onPause: () => void; onResume: () => void };

/**
 * 쉬는 시간 화면: 남은 초(올림, restTick마다 엔진이 알려 매초 갱신), 다음 세트, 건너뛰기, 일시정지.
 */
export function Rest({ view, onSkipRest, onPause, onResume }: RestProps) {
  const rest = view.rest;
  const sec = rest ? Math.max(0, Math.ceil(rest.remainingMs / 1000)) : 0;
  const next = rest?.next;
  return (
    <section className="rest screen-cover" aria-label="쉬는 시간">
      <p className="label">쉬는 시간</p>
      <p className="big-number">{sec}</p>
      {view.paused && <p className="workout-status">일시정지</p>}
      {next && <p className="rest-next">{`다음: ${EXERCISE_NAMES[next.exercise]} ${next.setIndex + 1}세트 ${targetText(next.target)}`}</p>}
      <div className="workout-actions">
        {view.paused ? (
          <button type="button" onClick={onResume}>
            다시 시작
          </button>
        ) : (
          <button type="button" onClick={onPause}>
            일시정지
          </button>
        )}
        <button type="button" onClick={onSkipRest}>
          건너뛰기
        </button>
      </div>
    </section>
  );
}
