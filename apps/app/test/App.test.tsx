import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { makeFakeWorkout } from './fakeWorkout';

describe('App', () => {
  it('홈 제목 "Work Out Mate"가 보인다', async () => {
    render(<App storage={createMemoryStorage()} />);
    expect(screen.getByRole('heading', { name: 'Work Out Mate' })).toBeInTheDocument();
    await screen.findByText('루틴을 먼저 만들어 주세요');
  });

  it('홈 → 루틴 만들기 → 저장 → 홈 목록에 보인다', async () => {
    render(<App storage={createMemoryStorage()} />);
    fireEvent.click(await screen.findByRole('button', { name: '루틴 만들기' }));
    fireEvent.change(screen.getByLabelText('루틴 이름'), { target: { value: '아침 루틴' } });
    fireEvent.change(screen.getByLabelText('추가할 운동'), { target: { value: 'squat' } });
    fireEvent.click(screen.getByRole('button', { name: '운동 추가' }));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('아침 루틴 1번째')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '아침 루틴 시작' })).toBeInTheDocument());
  });

  it('시작하면 운동 화면(WorkoutFlow)이 뜨고, 그만하기 → 완료 화면 → 홈으로 돌아온다', async () => {
    const storage = createMemoryStorage();
    const fw = makeFakeWorkout();
    render(<App storage={storage} mediaStore={createMemoryMediaStore()} workoutDeps={fw.deps} />);
    fireEvent.click(await screen.findByRole('button', { name: '루틴 만들기' }));
    fireEvent.change(screen.getByLabelText('루틴 이름'), { target: { value: '아침 루틴' } });
    fireEvent.change(screen.getByLabelText('추가할 운동'), { target: { value: 'squat' } });
    fireEvent.click(screen.getByRole('button', { name: '운동 추가' }));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    fireEvent.click(await screen.findByRole('button', { name: '시작' }));
    expect(await screen.findByText(/^스쿼트 1\/\d+세트$/)).toBeInTheDocument();
    await waitFor(() => expect(fw.pose.videos).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '그만하기' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '그만하기' }));
    fireEvent.click(await screen.findByRole('button', { name: '홈으로' }));
    expect(await screen.findByText('아침 루틴 1번째')).toBeInTheDocument();
  });
});
