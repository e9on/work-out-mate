import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Routine, RoutineEvent, WorkoutSession } from '@wom/core';
import type { EngineView } from '../src/workout/engine';
import { Workout } from '../src/screens/Workout';
import { Rest } from '../src/screens/Rest';
import { Summary } from '../src/screens/Summary';
import { Placement } from '../src/screens/Placement';
import { CameraErrorView } from '../src/screens/CameraErrorView';
import { WorkoutFlow } from '../src/workout/WorkoutFlow';
import { CameraError } from '../src/ports/pose';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { FakePose, makeFakeWorkout } from './fakeWorkout';

const ROUTINE: Routine = {
  id: 'r1',
  name: '아침 루틴',
  order: 0,
  exercises: [
    { exercise: 'squat', sets: 3, target: { kind: 'reps', reps: 10 }, restSec: 60 },
    { exercise: 'deadHang', sets: 2, target: { kind: 'seconds', seconds: 30 }, restSec: 90 },
  ],
  createdAt: 0,
  updatedAt: 0,
};

type SetPart = NonNullable<EngineView['set']>;
function setPart(p: Partial<SetPart> = {}): SetPart {
  return {
    setPhase: 'active',
    tracker: {} as SetPart['tracker'],
    count: 0,
    heldMs: 0,
    waitingForBreak: false,
    countdownRemainingMs: null,
    ...p,
  };
}
function view(p: Partial<EngineView> = {}): EngineView {
  return {
    phase: 'set',
    paused: false,
    exerciseIndex: 0,
    setIndex: 0,
    set: setPart(),
    rest: null,
    lastEvents: [],
    cameraError: null,
    ended: null,
    ...p,
  };
}

function renderWorkout(v: EngineView) {
  const cb = { onPause: vi.fn(), onResume: vi.fn(), onSkip: vi.fn(), onStop: vi.fn() };
  const pose = new FakePose();
  const r = render(<Workout view={v} routine={ROUTINE} pose={pose} {...cb} />);
  const rerender = (nv: EngineView) => r.rerender(<Workout view={nv} routine={ROUTINE} pose={pose} {...cb} />);
  return { ...r, cb, pose, rerender };
}
const bigNumber = (c: HTMLElement) => c.querySelector('.big-number')?.textContent;
const status = (c: HTMLElement) => c.querySelector('.workout-status')?.textContent ?? '';

describe('Workout 화면', () => {
  it('세트 번호는 1부터 센다: "스쿼트 2/3세트"', () => {
    renderWorkout(view({ setIndex: 1, set: setPart({ count: 4 }) }));
    expect(screen.getByText('스쿼트 2/3세트')).toBeInTheDocument();
  });

  it('반복 운동은 횟수를, 매달리기는 버틴 초를 크게 보여 준다', () => {
    const { container, rerender } = renderWorkout(view({ set: setPart({ count: 7 }) }));
    expect(bigNumber(container)).toBe('7회');
    rerender(view({ exerciseIndex: 1, set: setPart({ heldMs: 12400 }) }));
    expect(bigNumber(container)).toBe('12초');
    expect(screen.getByText('매달리기 1/2세트')).toBeInTheDocument();
  });

  it('준비 대기 중이면 "준비 자세를 잡아 주세요", 카운트다운이면 올림한 숫자를 보여 준다', () => {
    const { container, rerender } = renderWorkout(view({ set: setPart({ setPhase: 'waitingReady' }) }));
    expect(status(container)).toBe('준비 자세를 잡아 주세요');
    rerender(view({ set: setPart({ setPhase: 'countdown', countdownRemainingMs: 2100 }) }));
    expect(status(container)).toBe('3');
  });

  it('hint 진단 문구를 기억해 보여 주고, active가 되면 지운다', () => {
    const hint: RoutineEvent = { type: 'set', exerciseIndex: 0, setIndex: 0, event: { type: 'hint', diagnosis: 'notVisible' } };
    const { container, rerender } = renderWorkout(view({ set: setPart({ setPhase: 'countdown', countdownRemainingMs: 900 }), lastEvents: [hint] }));
    // 카운트다운 숫자가 우선
    expect(status(container)).toBe('1');
    rerender(view({ set: setPart({ setPhase: 'finished' }), lastEvents: [] }));
    expect(status(container)).toBe('몸이 화면에 다 보이게 해 주세요');
    rerender(view({ set: setPart({ setPhase: 'active' }), lastEvents: [] }));
    rerender(view({ set: setPart({ setPhase: 'finished' }), lastEvents: [] }));
    expect(status(container)).toBe('');
  });

  it('일시정지 버튼 문구가 바뀌고 각각 pause·resume을 부른다', () => {
    const { cb, container, rerender } = renderWorkout(view());
    fireEvent.click(screen.getByRole('button', { name: '일시정지' }));
    expect(cb.onPause).toHaveBeenCalledTimes(1);
    rerender(view({ paused: true }));
    expect(status(container)).toBe('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '다시 시작' }));
    expect(cb.onResume).toHaveBeenCalledTimes(1);
  });

  it('건너뛰기는 skipExercise를 부른다', () => {
    const { cb } = renderWorkout(view());
    fireEvent.click(screen.getByRole('button', { name: '건너뛰기' }));
    expect(cb.onSkip).toHaveBeenCalledTimes(1);
  });

  it('그만하기는 확인 대화상자를 거쳐야 stop을 부른다', () => {
    const { cb } = renderWorkout(view());
    fireEvent.click(screen.getByRole('button', { name: '그만하기' }));
    expect(cb.onStop).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '계속하기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cb.onStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '그만하기' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '그만하기' }));
    expect(cb.onStop).toHaveBeenCalledTimes(1);
  });

  it('pose 프레임을 구독하고, canvas context가 없어도(jsdom) 오류 없이 넘어간다', () => {
    const { pose, unmount, container } = renderWorkout(view());
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(pose.listeners).toBe(1);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => pose.emit({ t: 1, image: [], world: [] })).not.toThrow();
    unmount();
    expect(pose.listeners).toBe(0);
  });
});

describe('Rest 화면', () => {
  const restView = (p: Partial<EngineView> = {}) =>
    view({
      phase: 'rest',
      set: null,
      setIndex: 0,
      rest: { remainingMs: 35400, totalMs: 60000, next: { exerciseIndex: 0, setIndex: 1, exercise: 'squat', target: { kind: 'reps', reps: 10 } } },
      ...p,
    });

  it('남은 초를 올림해 크게 보여 주고 다음 세트를 알려 준다', () => {
    const { container } = render(<Rest view={restView()} onSkipRest={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} />);
    expect(bigNumber(container)).toBe('36');
    expect(screen.getByText('다음: 스쿼트 2세트 10회')).toBeInTheDocument();
  });

  it('매달리기 목표는 초로 쓴다', () => {
    const v = restView({
      rest: { remainingMs: 1000, totalMs: 90000, next: { exerciseIndex: 1, setIndex: 0, exercise: 'deadHang', target: { kind: 'seconds', seconds: 30 } } },
    });
    render(<Rest view={v} onSkipRest={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} />);
    expect(screen.getByText('다음: 매달리기 1세트 30초')).toBeInTheDocument();
  });

  it('건너뛰기는 skipRest, 일시정지·다시 시작은 pause·resume을 부른다', () => {
    const onSkipRest = vi.fn();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const r = render(<Rest view={restView()} onSkipRest={onSkipRest} onPause={onPause} onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: '건너뛰기' }));
    expect(onSkipRest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '일시정지' }));
    expect(onPause).toHaveBeenCalledTimes(1);
    r.rerender(<Rest view={restView({ paused: true })} onSkipRest={onSkipRest} onPause={onPause} onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: '다시 시작' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});

describe('Summary 화면', () => {
  const session: WorkoutSession = {
    id: 's1',
    routineId: 'r1',
    routineName: '아침 루틴',
    startedAt: 1_000_000,
    endedAt: 1_000_000 + 5 * 60_000 + 3_000,
    completed: false,
    sets: [
      { exercise: 'squat', target: { kind: 'reps', reps: 10 }, count: 10, heldMs: 0, negativeDescentMs: [], startT: 0, endT: 1, endReason: 'target', exerciseIndex: 0, setIndex: 0, restTakenMs: null },
      { exercise: 'squat', target: { kind: 'reps', reps: 10 }, count: 8, heldMs: 0, negativeDescentMs: [], startT: 2, endT: 3, endReason: 'idle', exerciseIndex: 0, setIndex: 1, restTakenMs: 61_400 },
      { exercise: 'deadHang', target: { kind: 'seconds', seconds: 30 }, count: 0, heldMs: 21_600, negativeDescentMs: [], startT: 4, endT: 5, endReason: 'manual', exerciseIndex: 1, setIndex: 0, restTakenMs: 90_000 },
    ],
  };

  it('세트 표(목표 대비 실제, 쉰 시간), 총 시간, 홈으로', () => {
    const onHome = vi.fn();
    render(<Summary session={session} onHome={onHome} />);
    const rows = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      ['스쿼트', '1', '10회', '10회', '-', '목표 달성'],
      ['스쿼트', '2', '10회', '8회', '61초', '멈춤'],
      ['매달리기', '1', '30초', '22초', '90초', '그만하기'],
    ]);
    expect(screen.getByText('총 시간 5분 3초')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '홈으로' }));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

describe('카메라 오류', () => {
  it.each([
    ['denied', '카메라 권한이 필요해요. 설정에서 허용한 뒤 다시 시도해 주세요'],
    ['notFound', '카메라를 찾을 수 없어요'],
    ['other', '카메라를 켜지 못했어요'],
  ] as const)('%s: 문구와 다시 시도', (kind, text) => {
    const onRetry = vi.fn();
    render(<CameraErrorView kind={kind} onRetry={onRetry} onHome={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('Placement', () => {
  it('운동이 시작되면 배치 안내를 보여 주고, countdown·active가 되면 닫힌다. 다음 운동에서 다시 열린다', () => {
    const r = render(<Placement view={view({ set: setPart({ setPhase: 'waitingReady' }) })} routine={ROUTINE} />);
    expect(screen.getByText('옆에서, 온몸이 보이게')).toBeInTheDocument();
    r.rerender(<Placement view={view({ set: setPart({ setPhase: 'active' }) })} routine={ROUTINE} />);
    expect(screen.queryByText('옆에서, 온몸이 보이게')).toBeNull();
    // 같은 운동의 다음 세트에서는 다시 열지 않는다
    r.rerender(<Placement view={view({ setIndex: 1, set: setPart({ setPhase: 'waitingReady' }) })} routine={ROUTINE} />);
    expect(screen.queryByText('옆에서, 온몸이 보이게')).toBeNull();
    // 철봉 운동으로 바뀌면 다시 연다
    const start: RoutineEvent = { type: 'exerciseStart', exerciseIndex: 1, exercise: 'deadHang' };
    r.rerender(<Placement view={view({ exerciseIndex: 1, set: setPart({ setPhase: 'waitingReady' }), lastEvents: [start] })} routine={ROUTINE} />);
    expect(screen.getByText('철봉과 손이 보이게')).toBeInTheDocument();
    r.rerender(<Placement view={view({ exerciseIndex: 1, set: setPart({ setPhase: 'countdown', countdownRemainingMs: 2000 }) })} routine={ROUTINE} />);
    expect(screen.queryByText('철봉과 손이 보이게')).toBeNull();
  });
});

describe('WorkoutFlow: 화면 선택', () => {
  const squat2: Routine = {
    ...ROUTINE,
    exercises: [{ exercise: 'squat', sets: 2, target: { kind: 'reps', reps: 1 }, restSec: 60 }],
  };
  const flush = () => act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  it('시작하면 video로 engine.start를 부르고 Workout 화면(배치 안내 겹침)을 보여 준다', async () => {
    const fw = makeFakeWorkout();
    render(<WorkoutFlow routine={squat2} storage={createMemoryStorage()} onHome={vi.fn()} deps={fw.deps} />);
    await flush();
    expect(fw.pose.videos).toHaveLength(1);
    expect(fw.pose.videos[0]).toBeInstanceOf(HTMLVideoElement);
    expect(screen.getByText('스쿼트 1/2세트')).toBeInTheDocument();
    expect(screen.getByText('옆에서, 온몸이 보이게')).toBeInTheDocument();
  });

  it('카메라 오류면 오류 화면, 다시 시도하면 start를 다시 부른다', async () => {
    const fw = makeFakeWorkout();
    fw.pose.startError = new CameraError('denied');
    render(<WorkoutFlow routine={squat2} storage={createMemoryStorage()} onHome={vi.fn()} deps={fw.deps} />);
    await flush();
    expect(screen.getByText('카메라 권한이 필요해요. 설정에서 허용한 뒤 다시 시도해 주세요')).toBeInTheDocument();
    fw.pose.startError = null;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await flush();
    expect(fw.pose.videos).toHaveLength(2);
    expect(screen.getByText('스쿼트 1/2세트')).toBeInTheDocument();
  });

  it('세트가 끝나면 Rest 화면, 건너뛰면 다시 Workout 화면', async () => {
    const fw = makeFakeWorkout();
    const { container } = render(<WorkoutFlow routine={squat2} storage={createMemoryStorage()} onHome={vi.fn()} deps={fw.deps} />);
    await flush();
    act(() => fw.doSquatSet(1));
    expect(screen.getByText('다음: 스쿼트 2세트 1회')).toBeInTheDocument();
    expect(container.querySelector('.rest .big-number')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '건너뛰기' }));
    expect(screen.getByText('스쿼트 2/2세트')).toBeInTheDocument();
  });

  it('그만하기를 확인하면 Summary로 가고, 홈으로를 눌러야 onHome을 부른다', async () => {
    const fw = makeFakeWorkout();
    const onHome = vi.fn();
    render(<WorkoutFlow routine={squat2} storage={createMemoryStorage()} onHome={onHome} deps={fw.deps} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '그만하기' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '그만하기' }));
    await flush();
    expect(screen.getByText(/총 시간/)).toBeInTheDocument();
    expect(onHome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '홈으로' }));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});
