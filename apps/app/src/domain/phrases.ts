import type { Routine, RoutineEvent, SetEvent } from '@wom/core';
import { koCount } from './koNumbers';
import { EXERCISE_NAMES } from './validate';

type Ctx = { routine: Routine };

function targetText(t: { kind: 'reps'; reps: number } | { kind: 'seconds'; seconds: number }): string {
  return t.kind === 'reps' ? `${t.reps}회` : `${t.seconds}초`;
}

function setPhrase(e: SetEvent, exerciseIndex: number, ctx: Ctx): string | null {
  switch (e.type) {
    case 'countdown':
      return koCount(e.n);
    case 'start':
      return '시작';
    case 'rep':
      return koCount(e.count);
    case 'hold':
      return e.seconds > 0 && e.seconds % 10 === 0 ? `${e.seconds}초` : null;
    case 'goalReached': {
      const ex = ctx.routine.exercises[exerciseIndex];
      if (!ex) return null;
      return ex.target.kind === 'reps' ? '목표 달성, 세트 끝' : '목표 달성';
    }
    case 'finished': {
      if (e.reason === 'idle') {
        return e.result.count > 0 ? `세트를 마칠게요, ${e.result.count}회` : null;
      }
      if (e.reason === 'released') {
        const sec = Math.round(e.result.heldMs / 1000);
        return sec > 0 ? `${sec}초 버텼어요` : null;
      }
      return null;
    }
    case 'hint':
      switch (e.diagnosis) {
        case 'notReady':
          return '옆에서 찍어 주세요';
        case 'notVisible':
          return '몸이 화면에 다 보이게 해 주세요';
        case 'calibratedByDefault':
          return '준비 자세를 잡지 못해 기본값으로 셀게요';
        default: {
          const _never: never = e.diagnosis;
          return _never;
        }
      }
    case 'backToReady':
      return '준비가 되면 다시 자세를 잡아 주세요';
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

/** 루틴 진행 이벤트를 음성 문구로 바꾼다. 말할 것이 없으면 null */
export function phraseFor(e: RoutineEvent, ctx: Ctx): string | null {
  switch (e.type) {
    case 'set':
      return setPhrase(e.event, e.exerciseIndex, ctx);
    case 'exerciseStart': {
      const ex = ctx.routine.exercises[e.exerciseIndex];
      if (!ex) return null;
      return `${EXERCISE_NAMES[e.exercise]}, ${ex.sets}세트`;
    }
    case 'restStart':
      return `쉬는 시간 ${e.seconds}초`;
    case 'restTick':
      if (e.remaining === 30) return '30초 남았어요';
      if (e.remaining >= 1 && e.remaining <= 5) return koCount(e.remaining);
      return null;
    case 'nextUp':
      return `다음은 ${EXERCISE_NAMES[e.exercise]} ${e.setIndex + 1}세트, ${targetText(e.target)}`;
    case 'restEnd':
      return null;
    case 'routineEnd':
      return e.session.completed ? '루틴 완료, 수고했어요' : '운동을 마쳤어요';
    default: {
      const _never: never = e;
      return _never;
    }
  }
}
