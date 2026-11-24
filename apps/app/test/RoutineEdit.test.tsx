import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Routine } from '@wom/core';
import { RoutineEdit } from '../src/screens/RoutineEdit';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import type { Storage } from '../src/ports/storage';

function setup(opts: { routine?: Routine; storage?: Storage } = {}) {
  const storage = opts.storage ?? createMemoryStorage();
  const onDone = vi.fn();
  render(
    <RoutineEdit storage={storage} routine={opts.routine} nextOrder={3} onDone={onDone} now={() => 5000} makeId={() => 'new-id'} />,
  );
  return { storage, onDone };
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const addExercise = (id: string) => {
  fireEvent.change(screen.getByLabelText('추가할 운동'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: '운동 추가' }));
};

const existing: Routine = {
  id: 'r1', name: '기존', order: 1, createdAt: 100, updatedAt: 200,
  exercises: [
    { exercise: 'squat', sets: 3, target: { kind: 'reps', reps: 10 }, restSec: 60 },
    { exercise: 'pushup', sets: 2, target: { kind: 'reps', reps: 8 }, restSec: 30 },
  ],
};

describe('RoutineEdit', () => {
  it('이름·운동·세트·목표·쉬는 시간을 입력해 저장하면 storage에 들어간다', async () => {
    const { storage, onDone } = setup();
    type('루틴 이름', ' 아침 루틴 ');
    addExercise('squat');
    type('1번 세트', '4');
    type('1번 횟수', '12');
    type('1번 쉬는 시간(초)', '45');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.listRoutines()).toEqual([
      {
        id: 'new-id', name: '아침 루틴', order: 3, createdAt: 5000, updatedAt: 5000,
        exercises: [{ exercise: 'squat', sets: 4, target: { kind: 'reps', reps: 12 }, restSec: 45 }],
      },
    ]);
  });

  it('새 운동의 기본값은 세트 3, 쉬는 시간 60, 반복 10 / 매달리기 30초', () => {
    setup();
    addExercise('squat');
    addExercise('deadHang');
    expect(screen.getByLabelText('1번 세트')).toHaveValue(3);
    expect(screen.getByLabelText('1번 횟수')).toHaveValue(10);
    expect(screen.getByLabelText('1번 쉬는 시간(초)')).toHaveValue(60);
    expect(screen.getByLabelText('2번 초')).toHaveValue(30);
    expect(screen.queryByLabelText('2번 횟수')).toBeNull();
  });

  it('잘못된 값이면 저장되지 않고 오류 문구가 보인다', async () => {
    const { storage, onDone } = setup();
    type('루틴 이름', '아침');
    addExercise('squat');
    type('1번 세트', '0');
    type('1번 횟수', '');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('세트');
    expect(alert.textContent).toContain('횟수');
    expect(await storage.listRoutines()).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('소수 횟수와 이름 없음도 오류', async () => {
    const { storage } = setup();
    addExercise('squat');
    type('1번 횟수', '2.5');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('이름');
    expect(alert.textContent).toContain('횟수');
    expect(await storage.listRoutines()).toEqual([]);
  });

  it('운동 순서를 위아래로 옮긴다', async () => {
    const { storage } = setup({ routine: existing });
    fireEvent.click(screen.getByRole('button', { name: '1번 아래로' }));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(async () => expect((await storage.listRoutines()).length).toBe(1));
    expect((await storage.listRoutines())[0]!.exercises.map((e) => e.exercise)).toEqual(['pushup', 'squat']);
  });

  it('위로 이동, 맨 위의 위로·맨 아래의 아래로는 비활성', () => {
    setup({ routine: existing });
    expect(screen.getByRole('button', { name: '1번 위로' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '2번 아래로' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '2번 위로' }));
    expect(screen.getByLabelText('1번 세트')).toHaveValue(2);
  });

  it('운동을 제거할 수 있다', () => {
    setup({ routine: existing });
    fireEvent.click(screen.getByRole('button', { name: '1번 제거' }));
    expect(screen.queryByLabelText('2번 세트')).toBeNull();
    expect(screen.getByLabelText('1번 세트')).toHaveValue(2);
  });

  it('기존 루틴 저장은 createdAt·id·order를 유지하고 updatedAt만 바꾼다', async () => {
    const { storage } = setup({ routine: existing });
    type('루틴 이름', '바뀜');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(async () => expect((await storage.listRoutines()).length).toBe(1));
    const [r] = await storage.listRoutines();
    expect(r).toMatchObject({ id: 'r1', order: 1, createdAt: 100, updatedAt: 5000, name: '바뀜' });
  });

  it('삭제는 확인 대화상자에서 "삭제"를 눌러야만 지워진다', async () => {
    const storage = createMemoryStorage();
    await storage.saveRoutine(existing);
    const { onDone } = setup({ routine: existing, storage });
    fireEvent.click(screen.getByRole('button', { name: '루틴 삭제' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await storage.listRoutines()).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '루틴 삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.listRoutines()).toEqual([]);
  });

  it('새 루틴에는 삭제 버튼이 없다', () => {
    setup();
    expect(screen.queryByRole('button', { name: '루틴 삭제' })).toBeNull();
  });

  it('취소하면 저장 없이 onDone', async () => {
    const { storage, onDone } = setup();
    fireEvent.click(screen.getByRole('button', { name: '편집 취소' }));
    expect(onDone).toHaveBeenCalled();
    expect(await storage.listRoutines()).toEqual([]);
  });

  it('매달리기를 고르면 목표 입력이 "초"로 바뀐다 (운동 종류 변경 포함)', () => {
    setup({ routine: existing });
    expect(screen.getByLabelText('1번 횟수')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('1번 운동'), { target: { value: 'deadHang' } });
    expect(screen.getByLabelText('1번 초')).toHaveValue(30);
    expect(screen.queryByLabelText('1번 횟수')).toBeNull();
    fireEvent.change(screen.getByLabelText('1번 운동'), { target: { value: 'pullup' } });
    expect(screen.getByLabelText('1번 횟수')).toHaveValue(10);
  });
  it('저장 버튼을 두 번 눌러도 루틴은 1개만 생긴다', async () => {
    const storage = createMemoryStorage();
    let n = 0;
    render(<RoutineEdit storage={storage} nextOrder={0} onDone={() => {}} now={() => 1} makeId={() => `id-${++n}`} />);
    type('루틴 이름', '아침');
    addExercise('squat');
    const save = screen.getByRole('button', { name: '저장' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(async () => expect((await storage.listRoutines()).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(await storage.listRoutines()).toHaveLength(1);
  });

  it('저장이 reject되면 오류 문구가 보이고 onDone은 호출되지 않으며 버튼은 다시 눌린다', async () => {
    const storage = createMemoryStorage();
    storage.saveRoutine = async () => {
      throw new Error('fail');
    };
    const { onDone } = setup({ storage });
    type('루틴 이름', '아침');
    addExercise('squat');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('저장하지 못했어요. 다시 시도해 주세요.');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled();
  });

  it('삭제가 reject되면 오류 문구가 보이고 onDone은 호출되지 않는다', async () => {
    const storage = createMemoryStorage();
    storage.deleteRoutine = async () => {
      throw new Error('fail');
    };
    const { onDone } = setup({ routine: existing, storage });
    fireEvent.click(screen.getByRole('button', { name: '루틴 삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('삭제하지 못했어요. 다시 시도해 주세요.');
    expect(alert.textContent).not.toContain('저장하지 못했어요');
    expect(onDone).not.toHaveBeenCalled();
  });
});
