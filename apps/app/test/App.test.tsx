import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { makeFakeWorkout } from './fakeWorkout';
import { DEFAULT_SETTINGS } from '../src/form/types';

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
    const media = createMemoryMediaStore();
    await media.putSettings({ ...DEFAULT_SETTINGS, firstRunPrompted: true }); // 첫 실행 안내는 따로 시험
    render(<App storage={storage} mediaStore={media} workoutDeps={fw.deps} />);
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

  describe('처음 켤 때 영상 저장 안내', () => {
    it('설정을 한 번도 정하지 않았으면 안내가 뜨고, 확인하면 영상 저장이 켜진다', async () => {
      const media = createMemoryMediaStore();
      render(<App storage={createMemoryStorage()} mediaStore={media} />);
      const dlg = await screen.findByRole('dialog', { name: '영상 저장 안내' });
      fireEvent.click(within(dlg).getByRole('checkbox'));
      fireEvent.click(within(dlg).getByRole('button', { name: '확인' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '영상 저장 안내' })).not.toBeInTheDocument());
      const s = await media.getSettings();
      expect(s.videoEnabled).toBe(true);
      expect(s.consent?.agreed).toBe(true);
      expect(s.firstRunPrompted).toBe(true);
    });

    it('영상 없이 쓰기를 고르면 영상 저장은 꺼진 채로 두고, 다시 켜도 안내가 뜨지 않는다', async () => {
      const media = createMemoryMediaStore();
      const first = render(<App storage={createMemoryStorage()} mediaStore={media} />);
      const dlg = await screen.findByRole('dialog', { name: '영상 저장 안내' });
      fireEvent.click(within(dlg).getByRole('button', { name: '영상 없이 쓰기' }));
      await waitFor(async () => expect((await media.getSettings()).firstRunPrompted).toBe(true));
      const s = await media.getSettings();
      expect(s.videoEnabled).toBe(false);
      expect(s.consent).toBeNull();
      first.unmount();
      render(<App storage={createMemoryStorage()} mediaStore={media} />);
      await screen.findByRole('heading', { name: 'Work Out Mate' });
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('dialog', { name: '영상 저장 안내' })).not.toBeInTheDocument();
    });

    it('이미 동의 여부를 정한 사용자에게는 안내가 뜨지 않는다', async () => {
      const media = createMemoryMediaStore();
      await media.putSettings({ ...DEFAULT_SETTINGS, videoEnabled: true, consent: { agreed: false, version: 'v1', at: 1 } });
      render(<App storage={createMemoryStorage()} mediaStore={media} />);
      await screen.findByRole('heading', { name: 'Work Out Mate' });
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('dialog', { name: '영상 저장 안내' })).not.toBeInTheDocument();
    });
  });
});
