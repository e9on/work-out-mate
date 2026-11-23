import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Routine, WorkoutSession } from '@wom/core';
import { Home } from '../src/screens/Home';
import { createMemoryStorage } from '../src/storage/memoryStorage';

const routine = (id: string, name: string, order: number): Routine => ({
  id, name, order, createdAt: 1, updatedAt: 1,
  exercises: [{ exercise: 'squat', sets: 3, target: { kind: 'reps', reps: 10 }, restSec: 60 }],
});
const session = (id: string, r: Routine, endedAt: number, completed = true): WorkoutSession => ({
  id, routineId: r.id, routineName: r.name, startedAt: endedAt - 10, endedAt, completed, sets: [],
});
const handlers = () => ({ onStart: vi.fn(), onEdit: vi.fn(), onHistory: vi.fn() });

describe('Home', () => {
  it('제목과 루틴이 없을 때의 안내·만들기 버튼', async () => {
    const h = handlers();
    render(<Home storage={createMemoryStorage()} {...h} />);
    expect(screen.getByRole('heading', { name: 'Work Out Mate' })).toBeInTheDocument();
    expect(await screen.findByText('루틴을 먼저 만들어 주세요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '루틴 만들기' }));
    expect(h.onEdit).toHaveBeenCalledWith();
  });

  it('마지막 완료 루틴의 다음 순서를 "N번째"와 함께 추천하고 시작하면 루틴을 넘긴다', async () => {
    const storage = createMemoryStorage();
    const a = routine('a', '상체데이', 0);
    const b = routine('b', '하체데이', 1);
    await storage.saveRoutine(a);
    await storage.saveRoutine(b);
    await storage.saveSession(session('s1', a, 100));
    await storage.saveSession(session('s2', b, 200));
    await storage.saveSession(session('s3', a, 300));
    await storage.saveSession(session('s4', b, 400, false));
    const h = handlers();
    render(<Home storage={storage} {...h} />);
    expect(await screen.findByText('하체데이 2번째')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '시작' }));
    expect(h.onStart).toHaveBeenCalledWith(b);
  });

  it('지워진 루틴의 세션이 마지막이면 남은 루틴 중 첫 번째를 추천한다', async () => {
    const storage = createMemoryStorage();
    await storage.saveRoutine(routine('a', '상체데이', 0));
    await storage.saveSession(session('s1', routine('gone', '지운루틴', 5), 100));
    render(<Home storage={storage} {...handlers()} />);
    expect(await screen.findByText('상체데이 1번째')).toBeInTheDocument();
  });

  it('목록의 루틴을 눌러 시작하거나 편집하고, 기록 버튼은 onHistory를 부른다', async () => {
    const storage = createMemoryStorage();
    const a = routine('a', '상체데이', 0);
    await storage.saveRoutine(a);
    const h = handlers();
    render(<Home storage={storage} {...h} />);
    await screen.findByText('상체데이 1번째');
    fireEvent.click(screen.getByRole('button', { name: '상체데이 시작' }));
    expect(h.onStart).toHaveBeenCalledWith(a);
    fireEvent.click(screen.getByRole('button', { name: '상체데이 편집' }));
    expect(h.onEdit).toHaveBeenCalledWith(a);
    fireEvent.click(screen.getByRole('button', { name: '기록' }));
    expect(h.onHistory).toHaveBeenCalled();
  });

  it('위로/아래로로 이웃과 order를 바꿔 저장하고 목록을 다시 읽는다', async () => {
    const storage = createMemoryStorage();
    await storage.saveRoutine(routine('a', '상체데이', 0));
    await storage.saveRoutine(routine('b', '하체데이', 1));
    render(<Home storage={storage} {...handlers()} />);
    await screen.findByText('상체데이 1번째');
    expect(screen.getByRole('button', { name: '상체데이 위로' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '하체데이 아래로' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '하체데이 위로' }));
    await waitFor(async () => expect((await storage.listRoutines()).map((r) => r.id)).toEqual(['b', 'a']));
    const list = screen.getByRole('list', { name: '루틴 목록' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('하체데이'));
    expect(screen.getByRole('button', { name: '하체데이 위로' })).toBeDisabled();
  });
});
