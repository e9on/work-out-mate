import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutSession } from '@wom/core';
import { setKey, type VideoClip } from '../src/form/types';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { RepPlayer } from '../src/screens/RepPlayer';

const SID = 's1';
const KEY = setKey(SID, 0, 0);
const VIDEO_AT = 100_000;

const session: WorkoutSession = {
  id: SID,
  routineId: 'r',
  routineName: '루틴',
  startedAt: VIDEO_AT,
  endedAt: VIDEO_AT + 90_000,
  completed: true,
  sets: [
    {
      exercise: 'squat',
      target: { kind: 'reps', reps: 3 },
      count: 3,
      heldMs: 0,
      negativeDescentMs: [],
      startT: VIDEO_AT,
      endT: VIDEO_AT + 60_000,
      endReason: 'button',
      exerciseIndex: 0,
      setIndex: 0,
      restTakenMs: null,
      reps: [
        { index: 1, startT: VIDEO_AT + 5_000, bottomT: VIDEO_AT + 6_000, endT: VIDEO_AT + 7_000 },
        { index: 2, startT: VIDEO_AT + 12_000, bottomT: VIDEO_AT + 13_000, endT: VIDEO_AT + 14_000 },
        { index: 3, startT: VIDEO_AT + 18_000, bottomT: VIDEO_AT + 19_000, endT: VIDEO_AT + 20_000 },
      ],
    },
  ],
};

let n = 0;
beforeEach(() => {
  n = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

async function setup(opts: { video?: boolean; clip?: boolean } = {}) {
  const store = createMemoryMediaStore();
  const storage = createMemoryStorage();
  await storage.saveSession(session);
  if (opts.video !== false) {
    await store.putVideo({
      key: KEY,
      sessionId: SID,
      routineId: 'r',
      exerciseIndex: 0,
      setIndex: 0,
      startedAt: VIDEO_AT,
      mimeType: 'video/webm',
      blob: new Blob([new Uint8Array(1)]),
      boxes: [],
    });
  }
  if (opts.clip) {
    const clip: VideoClip = { key: `${KEY}#1`, setKey: KEY, index: 1, startedAt: VIDEO_AT + 3_000, mimeType: 'video/webm', blob: new Blob([new Uint8Array(1)]) };
    await store.putClip(clip);
  }
  return { store, storage };
}

const getVideo = () => document.querySelector('video') as HTMLVideoElement;
const noop = () => undefined;

describe('RepPlayer', () => {
  it('반복 startT가 영상 시작 + 5s면 currentTime 4', async () => {
    const { store, storage } = await setup();
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={1} onBack={noop} />);
    await waitFor(() => expect(getVideo()).not.toBeNull());
    expect(getVideo().getAttribute('src')).toBe('blob:fake-1');
    await waitFor(() => expect(getVideo().currentTime).toBe(4));
  });

  it('전체 영상이 없고 클립만 있으면 클립 objectURL을 쓴다', async () => {
    const { store, storage } = await setup({ video: false, clip: true });
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={1} onBack={noop} />);
    await waitFor(() => expect(getVideo()).not.toBeNull());
    expect(getVideo().getAttribute('src')).toBe('blob:fake-1');
    // 클립 시작 +3s, 반복 startT +5s, 1초 앞 → 1s 지점
    await waitFor(() => expect(getVideo().currentTime).toBe(1));
  });

  it('둘 다 없으면 삭제 안내', async () => {
    const { store, storage } = await setup({ video: false });
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={1} onBack={noop} />);
    expect(await screen.findByText('영상이 삭제됐어요(오래된 기록은 지적 구간만 보관)')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('느리게 보기 → playbackRate 0.5', async () => {
    const { store, storage } = await setup();
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={1} onBack={noop} />);
    await waitFor(() => expect(getVideo()).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '0.5배 느리게 보기' }));
    expect(getVideo().playbackRate).toBe(0.5);
    fireEvent.click(screen.getByRole('button', { name: '0.5배 느리게 보기' }));
    expect(getVideo().playbackRate).toBe(1);
  });

  it('문제 있어요 → 무릎 모임 선택 → putLabel manual [kneeIn]', async () => {
    const { store, storage } = await setup();
    const put = vi.spyOn(store, 'putLabel');
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={2} onBack={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: '이 반복에 문제가 있어요' }));
    fireEvent.click(screen.getByRole('button', { name: '무릎 모임' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toMatchObject({ key: `${KEY}#2`, index: 2, manual: ['kneeIn'], normal: false });
    await waitFor(() => expect(screen.getByRole('button', { name: '무릎 모임' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('정상 → normal true, manual []', async () => {
    const { store, storage } = await setup();
    await store.putLabel({ key: `${KEY}#2`, sessionId: SID, setKey: KEY, index: 2, verdicts: [{ kind: 'heel', agree: true }], manual: ['bounce'], normal: false, note: '', updatedAt: 1 });
    const put = vi.spyOn(store, 'putLabel');
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={2} onBack={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: '이 반복은 정상' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toMatchObject({ normal: true, manual: [], verdicts: [{ kind: 'heel', agree: true }] });
  });

  it('저장 실패하면 되돌리고 안내한다', async () => {
    const { store, storage } = await setup();
    vi.spyOn(store, 'putLabel').mockRejectedValue(new Error('x'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={2} onBack={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: '이 반복은 정상' }));
    expect(await screen.findByText('저장하지 못했어요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이 반복은 정상' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('다음 반복 → index+1, 영상 위치도 바뀐다', async () => {
    const { store, storage } = await setup();
    render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={1} onBack={noop} />);
    expect(await screen.findByText('1번째 반복')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다음 반복' }));
    expect(await screen.findByText('2번째 반복')).toBeInTheDocument();
    await waitFor(() => expect(getVideo().currentTime).toBe(11));
    fireEvent.click(screen.getByRole('button', { name: '이전 반복' }));
    expect(await screen.findByText('1번째 반복')).toBeInTheDocument();
  });

  it('언마운트하면 objectURL을 revoke한다', async () => {
    const { store, storage } = await setup();
    const { unmount } = render(<RepPlayer store={store} storage={storage} sessionId={SID} setKey={KEY} index={1} onBack={noop} />);
    await waitFor(() => expect(getVideo()).not.toBeNull());
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-1');
  });
});
