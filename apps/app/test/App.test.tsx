import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { makeFakeWorkout } from './fakeWorkout';
import { DEFAULT_SETTINGS } from '../src/form/types';
import { act } from '@testing-library/react';
import { dispatchBack } from '../src/platform/backButton';

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

    it('체크하지 않고 확인하면 영상 저장은 켜고 학습 데이터 동의는 하지 않은 것으로 남긴다', async () => {
      const media = createMemoryMediaStore();
      render(<App storage={createMemoryStorage()} mediaStore={media} />);
      const dlg = await screen.findByRole('dialog', { name: '영상 저장 안내' });
      fireEvent.click(within(dlg).getByRole('button', { name: '확인' }));
      await waitFor(async () => expect((await media.getSettings()).firstRunPrompted).toBe(true));
      const s = await media.getSettings();
      expect(s.videoEnabled).toBe(true);
      expect(s.consent).toMatchObject({ agreed: false, version: 'v1' });
    });

    it('안내가 떠 있는 동안 다른 곳에서 동의 여부가 정해졌으면 그 설정을 덮어쓰지 않는다', async () => {
      const media = createMemoryMediaStore();
      render(<App storage={createMemoryStorage()} mediaStore={media} />);
      const dlg = await screen.findByRole('dialog', { name: '영상 저장 안내' });
      const decided = { ...DEFAULT_SETTINGS, videoEnabled: true, consent: { agreed: true, version: 'v1', at: 5 } };
      await media.putSettings(decided);
      fireEvent.click(within(dlg).getByRole('button', { name: '영상 없이 쓰기' }));
      await waitFor(async () => expect((await media.getSettings()).firstRunPrompted).toBe(true));
      expect(await media.getSettings()).toEqual({ ...decided, firstRunPrompted: true });
    });
  });

  describe('폰 뒤로 가기', () => {
    const settled = async () => {
      const media = createMemoryMediaStore();
      await media.putSettings({ ...DEFAULT_SETTINGS, firstRunPrompted: true });
      return media;
    };

    it('설정·기록·루틴 편집에서 뒤로 가면 홈으로 간다', async () => {
      render(<App storage={createMemoryStorage()} mediaStore={await settled()} />);
      for (const [button, title] of [['설정', '설정'], ['기록', '기록'], ['루틴 만들기', '새 루틴']] as const) {
        fireEvent.click(await screen.findByRole('button', { name: button }));
        await screen.findByRole('heading', { name: title });
        act(() => {
          expect(dispatchBack()).toBe(true);
        });
        await screen.findByRole('heading', { name: 'Work Out Mate' });
      }
    });

    it('홈에서는 처리하지 않는다(앱이 기본 동작으로 닫히거나 뒤로 간다)', async () => {
      render(<App storage={createMemoryStorage()} mediaStore={await settled()} />);
      await screen.findByRole('heading', { name: 'Work Out Mate' });
      expect(dispatchBack()).toBe(false);
    });

    it('대화 상자가 떠 있으면 뒤로 가기는 대화 상자만 닫는다', async () => {
      render(<App storage={createMemoryStorage()} mediaStore={createMemoryMediaStore()} />);
      await screen.findByRole('dialog', { name: '영상 저장 안내' });
      act(() => {
        expect(dispatchBack()).toBe(true);
      });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '영상 저장 안내' })).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: 'Work Out Mate' })).toBeInTheDocument();
    });

    it('운동 중 뒤로 가기는 그만할지 묻고, 한 번 더 누르면 묻는 창만 닫고 운동을 이어 간다', async () => {
      const fw = makeFakeWorkout();
      render(<App storage={createMemoryStorage()} mediaStore={await settled()} workoutDeps={fw.deps} />);
      fireEvent.click(await screen.findByRole('button', { name: '루틴 만들기' }));
      fireEvent.change(screen.getByLabelText('루틴 이름'), { target: { value: '아침 루틴' } });
      fireEvent.change(screen.getByLabelText('추가할 운동'), { target: { value: 'squat' } });
      fireEvent.click(screen.getByRole('button', { name: '운동 추가' }));
      fireEvent.click(screen.getByRole('button', { name: '저장' }));
      fireEvent.click(await screen.findByRole('button', { name: '시작' }));
      expect(await screen.findByText(/^스쿼트 1\/\d+세트$/)).toBeInTheDocument();
      act(() => {
        expect(dispatchBack()).toBe(true);
      });
      expect(await screen.findByText('운동을 그만할까요? 지금까지 한 세트는 저장돼요.')).toBeInTheDocument();
      act(() => {
        expect(dispatchBack()).toBe(true);
      });
      await waitFor(() => expect(screen.queryByText('운동을 그만할까요? 지금까지 한 세트는 저장돼요.')).not.toBeInTheDocument());
      expect(screen.getByText(/^스쿼트 1\/\d+세트$/)).toBeInTheDocument();
    });
  });
});
