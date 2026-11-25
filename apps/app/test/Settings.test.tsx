import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Routine, SetLog, WorkoutSession } from '@wom/core';
import { Settings } from '../src/screens/Settings';
import { SessionDetail } from '../src/screens/SessionDetail';
import { Home } from '../src/screens/Home';
import { Placement } from '../src/screens/Placement';
import type { EngineView } from '../src/workout/engine';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { DEFAULT_SETTINGS, type SetVideo, type VideoClip } from '../src/form/types';

const CONSENT_TEXT = '자세 분석 AI를 개선하는 데 내 운동 데이터(관절 좌표, 영상 구간, 맞아요/틀려요 정답)를 학습 데이터로 쓰는 데 동의합니다.';

const video = (sessionId: string, exerciseIndex = 0, setIndex = 0): SetVideo => ({
  key: `${sessionId}/${exerciseIndex}/${setIndex}`, sessionId, routineId: 'r', exerciseIndex, setIndex,
  startedAt: 1, mimeType: 'video/webm', blob: new Blob(['x']), boxes: [],
});
const clip = (setKey: string, index: number): VideoClip => ({ key: `${setKey}#${index}`, setKey, index, startedAt: 1, mimeType: 'video/webm', blob: new Blob(['y']) });

describe('Settings', () => {
  it('영상 저장을 처음 켜면 동의 화면이 뜨고, 체크 없이 확인해도 videoEnabled true·consent agreed false', async () => {
    const store = createMemoryMediaStore();
    render(<Settings mediaStore={store} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '영상 저장' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(CONSENT_TEXT)).toBeInTheDocument();
    expect(within(dlg).getByText('데이터는 내가 직접 내보내기 전에는 폰 밖으로 나가지 않아요.')).toBeInTheDocument();
    expect(within(dlg).getByText('설정에서 언제든 끌 수 있어요. 끄면 그 뒤 기록은 내보내기에 포함되지 않아요.')).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: '확인' }));
    await waitFor(async () => {
      const s = await store.getSettings();
      expect(s.videoEnabled).toBe(true);
      expect(s.consent).toMatchObject({ agreed: false, version: 'v1' });
    });
  });

  it('동의를 체크하고 확인하면 consent {agreed:true, version:v1}', async () => {
    const store = createMemoryMediaStore();
    render(<Settings mediaStore={store} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '영상 저장' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('checkbox'));
    fireEvent.click(within(dlg).getByRole('button', { name: '확인' }));
    await waitFor(async () => expect((await store.getSettings()).consent).toMatchObject({ agreed: true, version: 'v1' }));
    expect((await store.getSettings()).videoEnabled).toBe(true);
  });

  it('동의를 끄면 "이미 내보낸 파일은 지울 수 없어요" 안내가 보이고 저장된다. 영상 저장을 끄면 videoEnabled false', async () => {
    const store = createMemoryMediaStore();
    await store.putSettings({ videoEnabled: true, consent: { agreed: true, version: 'v1', at: 1 }, guideSeen: 0 });
    render(<Settings mediaStore={store} onBack={vi.fn()} />);
    expect(screen.queryByText('이미 내보낸 파일은 지울 수 없어요.')).toBeNull();
    fireEvent.click(await screen.findByRole('checkbox', { name: CONSENT_TEXT }));
    expect(await screen.findByText('이미 내보낸 파일은 지울 수 없어요.')).toBeInTheDocument();
    await waitFor(async () => expect((await store.getSettings()).consent?.agreed).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: '영상 저장' }));
    await waitFor(async () => expect((await store.getSettings()).videoEnabled).toBe(false));
  });

  it('영상 전체 삭제는 확인 뒤에만 deleteVideo를 부른다(클립 포함)', async () => {
    const store = createMemoryMediaStore();
    await store.putVideo(video('s1'));
    await store.putVideo(video('s2'));
    await store.putClip(clip('s1/0/0', 0));
    const del = vi.spyOn(store, 'deleteVideo');
    render(<Settings mediaStore={store} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '영상 전체 삭제' }));
    const dlg = await screen.findByRole('alertdialog');
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '영상 전체 삭제' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
    expect(await store.listVideoKeys()).toEqual([]);
    expect(await store.listClips('s1/0/0')).toEqual([]);
  });

  it('영상 용량을 MB 소수 한 자리로 보인다', async () => {
    const store = createMemoryMediaStore();
    vi.spyOn(store, 'usageBytes').mockResolvedValue(Math.round(12.3 * 1024 * 1024));
    render(<Settings mediaStore={store} onBack={vi.fn()} />);
    expect(await screen.findByText('영상 용량 12.3MB')).toBeInTheDocument();
  });

  it('내보내기 버튼은 onExport가 있을 때만 보인다', async () => {
    const store = createMemoryMediaStore();
    const r = render(<Settings mediaStore={store} onBack={vi.fn()} />);
    await screen.findByRole('checkbox', { name: '영상 저장' });
    expect(screen.queryByRole('button', { name: '학습 데이터 내보내기' })).toBeNull();
    const onExport = vi.fn();
    r.rerender(<Settings mediaStore={store} onBack={vi.fn()} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: '학습 데이터 내보내기' }));
    expect(onExport).toHaveBeenCalled();
  });

  it('내보내기 결과 문구를 화면에 보인다', async () => {
    const store = createMemoryMediaStore();
    const onExport = vi.fn().mockResolvedValue('내보낼 기록이 없어요');
    render(<Settings mediaStore={store} onBack={vi.fn()} onExport={onExport} />);
    fireEvent.click(await screen.findByRole('button', { name: '학습 데이터 내보내기' }));
    expect(await screen.findByRole('status')).toHaveTextContent('내보낼 기록이 없어요');
  });
});

describe('Home 설정 진입', () => {
  it('onSettings가 있으면 설정 버튼으로 부른다', async () => {
    const onSettings = vi.fn();
    render(<Home storage={createMemoryStorage()} onStart={vi.fn()} onEdit={vi.fn()} onHistory={vi.fn()} onSettings={onSettings} />);
    fireEvent.click(await screen.findByRole('button', { name: '설정' }));
    expect(onSettings).toHaveBeenCalled();
  });
});

describe('SessionDetail: 이 기록의 영상 삭제', () => {
  it('확인 뒤 그 세션의 영상·클립만 지우고 분석은 남긴다', async () => {
    const storage = createMemoryStorage();
    const log: SetLog = {
      exercise: 'squat', target: { kind: 'reps', reps: 10 }, count: 8, heldMs: 0, negativeDescentMs: [],
      startT: 0, endT: 1, endReason: 'target', exerciseIndex: 0, setIndex: 0, restTakenMs: null,
    };
    const ws: WorkoutSession = { id: 's1', routineId: 'r', routineName: '하체', startedAt: 1, endedAt: 2, completed: true, sets: [log] };
    await storage.saveSession(ws);
    const store = createMemoryMediaStore();
    await store.putVideo(video('s1'));
    await store.putVideo(video('s2'));
    await store.putClip(clip('s1/0/0', 0));
    await store.putClip(clip('s2/0/0', 0));
    await store.putAnalysis({
      key: 's1/0/0', sessionId: 's1', status: 'done', reason: null, metrics: [], findings: [], notes: [], uncertain: [], frames: [],
      model: 'rtmpose-m-halpe26', analyzedAt: 1,
    });
    render(<SessionDetail storage={storage} sessionId="s1" mediaStore={store} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '이 기록의 영상 삭제' }));
    expect(await store.listVideoKeys()).toEqual(['s1/0/0', 's2/0/0']);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '삭제' }));
    await waitFor(async () => expect(await store.listVideoKeys()).toEqual(['s2/0/0']));
    expect(await store.listClips('s1/0/0')).toEqual([]);
    expect(await store.listClips('s2/0/0')).toHaveLength(1);
    expect(await store.getAnalysis('s1/0/0')).not.toBeNull();
  });
});

const ROUTINE: Routine = {
  id: 'r1', name: '루틴', order: 0, createdAt: 0, updatedAt: 0,
  exercises: [
    { exercise: 'squat', sets: 3, target: { kind: 'reps', reps: 10 }, restSec: 60 },
    { exercise: 'deadHang', sets: 2, target: { kind: 'seconds', seconds: 30 }, restSec: 90 },
  ],
};
const view = (p: Partial<EngineView> = {}): EngineView => ({
  phase: 'set', paused: false, exerciseIndex: 0, setIndex: 0,
  set: { setPhase: 'waitingReady', tracker: {} as never, count: 0, heldMs: 0, waitingForBreak: false, countdownRemainingMs: null },
  rest: null, lastEvents: [], cameraError: null, ended: null, ...p,
});
const GUIDE = '폰을 몸 앞쪽 대각선(45도), 허리 높이에 두세요';

describe('Placement 스쿼트 촬영 안내', () => {
  it('영상 저장이 켜진 스쿼트에서 안내를 보이고 본 횟수를 1 올린다', async () => {
    const store = createMemoryMediaStore();
    await store.putSettings({ ...DEFAULT_SETTINGS, videoEnabled: true });
    render(<Placement view={view()} routine={ROUTINE} mediaStore={store} />);
    expect(await screen.findByText(GUIDE)).toBeInTheDocument();
    expect(screen.getByText('머리부터 발끝까지 여유 있게')).toBeInTheDocument();
    expect(screen.getByText('무릎이 보이는 옷(반바지나 붙는 바지), 신발은 평소대로')).toBeInTheDocument();
    expect(screen.getByText('팔은 앞으로 뻗거나 가슴 앞에 모으세요')).toBeInTheDocument();
    await waitFor(async () => expect((await store.getSettings()).guideSeen).toBe(1));
  });

  it('영상 저장이 꺼져 있거나 3번 봤거나 스쿼트가 아니면 보이지 않는다', async () => {
    const off = createMemoryMediaStore();
    const r1 = render(<Placement view={view()} routine={ROUTINE} mediaStore={off} />);
    await screen.findByText('옆에서, 온몸이 보이게');
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(GUIDE)).toBeNull();
    expect((await off.getSettings()).guideSeen).toBe(0);
    r1.unmount();

    const seen = createMemoryMediaStore();
    await seen.putSettings({ ...DEFAULT_SETTINGS, videoEnabled: true, guideSeen: 3 });
    const r2 = render(<Placement view={view()} routine={ROUTINE} mediaStore={seen} />);
    await screen.findByText('옆에서, 온몸이 보이게');
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(GUIDE)).toBeNull();
    r2.unmount();

    const bar = createMemoryMediaStore();
    await bar.putSettings({ ...DEFAULT_SETTINGS, videoEnabled: true });
    render(<Placement view={view({ exerciseIndex: 1 })} routine={ROUTINE} mediaStore={bar} />);
    await screen.findByText('철봉과 손이 보이게');
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(GUIDE)).toBeNull();
    expect((await bar.getSettings()).guideSeen).toBe(0);
  });

  it('"다시 보지 않기"는 guideSeen을 3으로 하고 안내를 닫는다', async () => {
    const store = createMemoryMediaStore();
    await store.putSettings({ ...DEFAULT_SETTINGS, videoEnabled: true });
    render(<Placement view={view()} routine={ROUTINE} mediaStore={store} />);
    await screen.findByText(GUIDE);
    await waitFor(async () => expect((await store.getSettings()).guideSeen).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: '다시 보지 않기' }));
    expect(screen.queryByText(GUIDE)).toBeNull();
    await waitFor(async () => expect((await store.getSettings()).guideSeen).toBe(3));
  });
});
