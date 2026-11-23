import { useEffect, useRef, useState } from 'react';
import { WorkoutEngine, type EngineDeps, type EngineView } from './engine';

/**
 * 운동 엔진을 React에 붙인다.
 * - 엔진은 effect 안에서 만들고 cleanup에서 dispose한다. StrictMode의 mount → cleanup → mount에서도
 *   두 번째 mount가 새 엔진을 만들므로 죽은 엔진을 쓰지 않는다(첫 엔진은 start 전이라 버려도 부작용이 없다).
 * - 그래서 effect가 돌기 전 첫 렌더에서는 view·engine이 null이다.
 * - deps는 mount 때 값만 쓴다(운동 중 루틴이 바뀌지 않는다). 루틴을 바꾸려면 key로 다시 mount한다.
 * - document의 visibilitychange를 구독해 engine.onVisibilityChange(document.hidden)를 부른다.
 */
export function useWorkout(d: EngineDeps): { view: EngineView | null; engine: WorkoutEngine | null } {
  const depsRef = useRef(d);
  const [state, setState] = useState<{ view: EngineView | null; engine: WorkoutEngine | null }>({
    view: null,
    engine: null,
  });

  useEffect(() => {
    const engine = new WorkoutEngine(depsRef.current);
    setState({ view: engine.view(), engine });
    const unsub = engine.subscribe((view) => setState({ view, engine }));
    const onVisibility = () => engine.onVisibilityChange(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
      engine.dispose();
    };
  }, []);

  return state;
}
