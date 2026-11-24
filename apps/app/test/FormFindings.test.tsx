import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetLog, WorkoutSession } from '@wom/core';
import type { AnalysisQueue } from '../src/form/analysisQueue';
import { setKey, type SetAnalysis, type SetVideo } from '../src/form/types';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { FormFindings } from '../src/screens/FormFindings';

afterEach(cleanup);

const SID = 's1';
const STARTED = 100_000;

const log = (setIndex: number, reps: SetLog['reps']): SetLog => ({
  exercise: 'squat',
  target: { kind: 'reps', reps: 5 },
  count: 5,
  heldMs: 0,
  negativeDescentMs: [],
  startT: STARTED,
  endT: STARTED + 60_000,
  endReason: 'button',
  exerciseIndex: 0,
  setIndex,
  restTakenMs: null,
  reps,
});

const session = (sets: SetLog[]): WorkoutSession => ({
  id: SID,
  routineId: 'r',
  routineName: '루틴',
  startedAt: STARTED,
  endedAt: STARTED + 90_000,
  completed: true,
  sets,
});

const video = (setIndex: number): SetVideo => ({
  key: setKey(SID, 0, setIndex),
  sessionId: SID,
  routineId: 'r',
  exerciseIndex: 0,
  setIndex,
  startedAt: STARTED,
  mimeType: 'video/webm',
  blob: new Blob([new Uint8Array(1)]),
  boxes: [],
});

const analysis = (setIndex: number, over: Partial<SetAnalysis> = {}): SetAnalysis => ({
  key: setKey(SID, 0, setIndex),
  sessionId: SID,
  status: 'done',
  reason: null,
  metrics: [],
  findings: [],
  notes: [],
  uncertain: [],
  frames: [],
  model: 'rtmpose-m-halpe26',
  analyzedAt: 1,
  ...over,
});

const reps = [{ index: 4, startT: STARTED + 18_000, bottomT: STARTED + 19_000, endT: STARTED + 20_000 }];

async function setup(opts: { meta?: boolean; videos?: number[]; analyses?: SetAnalysis[] } = {}) {
  const store = createMemoryMediaStore();
  if (opts.meta !== false) await store.putCaptureMeta({ sessionId: SID, videoEnabled: true, consentAgreed: true, consentVersion: '1' });
  for (const i of opts.videos ?? [0]) await store.putVideo(video(i));
  for (const a of opts.analyses ?? []) await store.putAnalysis(a);
  return store;
}

describe('FormFindings', () => {
  it('지적 줄과 맞아요/틀려요 버튼을 보여 준다', async () => {
    const store = await setup({
      analyses: [analysis(0, { findings: [{ index: 4, kind: 'kneeIn', value: 1 }, { index: 5, kind: 'heel', value: 1 }] })],
    });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} />);
    const raw = { normalizer: (t: string) => t };
    expect(await screen.findByText('4번째 (0:18)  무릎이 발보다 안쪽으로 모였어요', raw)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '맞아요' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '틀려요' })).toHaveLength(2);
    expect(screen.getByText('5번째  뒤꿈치가 바닥에서 떨어졌어요', raw)).toBeInTheDocument();
  });

  it('맞아요를 누르면 저장하고 틀려요로 바꾸면 덮어쓴다', async () => {
    const store = await setup({ analyses: [analysis(0, { findings: [{ index: 4, kind: 'kneeIn', value: 1 }] })] });
    const put = vi.spyOn(store, 'putLabel');
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} />);
    fireEvent.click(await screen.findByRole('button', { name: '맞아요' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toMatchObject({ key: `${setKey(SID, 0, 0)}#4`, index: 4, verdicts: [{ kind: 'kneeIn', agree: true }] });
    await waitFor(() => expect(screen.getByRole('button', { name: '맞아요' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '틀려요' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]![0].verdicts).toEqual([{ kind: 'kneeIn', agree: false }]);
    await waitFor(() => expect(screen.getByRole('button', { name: '틀려요' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: '맞아요' })).toHaveAttribute('aria-pressed', 'false');
    expect((await store.listLabels(SID))[0]!.verdicts).toEqual([{ kind: 'kneeIn', agree: false }]);
  });

  it('분석 2/3 끝났으면 진행 문구, onProgress 뒤 다시 읽어 갱신', async () => {
    const store = await setup({ videos: [0, 1, 2], analyses: [analysis(0), analysis(1)] });
    let cb: (sid: string) => void = () => undefined;
    const queue = {
      onProgress: (c: (sid: string) => void) => {
        cb = c;
        return () => undefined;
      },
    } as unknown as AnalysisQueue;
    render(<FormFindings store={store} queue={queue} sessionId={SID} session={session([log(0, reps)])} />);
    expect(await screen.findByText('분석 중… (2/3)')).toBeInTheDocument();
    await store.putAnalysis(analysis(2));
    await act(async () => cb(SID));
    await waitFor(() => expect(screen.queryByText(/분석 중…/)).toBeNull());
  });

  it('captureMeta가 없거나 videoEnabled=false면 아무것도 그리지 않는다', async () => {
    const none = await setup({ meta: false, analyses: [analysis(0)] });
    const first = render(<FormFindings store={none} sessionId={SID} session={session([log(0, reps)])} />);
    await act(async () => undefined);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const off = await setup({ meta: false, analyses: [analysis(0)] });
    await off.putCaptureMeta({ sessionId: SID, videoEnabled: false, consentAgreed: false, consentVersion: null });
    const second = render(<FormFindings store={off} sessionId={SID} session={session([log(0, reps)])} />);
    await act(async () => undefined);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('영상 없이 분석만 있는 noVideo 세트는 사유 문구, 지적 없음은 문구', async () => {
    const store = await setup({ videos: [], analyses: [analysis(0, { status: 'failed', reason: 'noVideo' }), analysis(1)] });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps), log(1, reps)])} />);
    expect(await screen.findByText('영상이 없어 분석하지 못했어요')).toBeInTheDocument();
    expect(screen.getByText('자세 지적 없음')).toBeInTheDocument();
    expect(screen.queryByText(/분석 중…/)).toBeNull();
  });

  it('세트는 숫자 순서(2번이 10번 앞)로, 다시 보기 버튼은 onPlay를 부른다', async () => {
    const sets = [10, 2];
    const store = await setup({ videos: sets, analyses: sets.map((i) => analysis(i, { findings: [{ index: 1, kind: 'depth', value: 1 }] })) });
    const onPlay = vi.fn();
    render(<FormFindings store={store} sessionId={SID} session={session([])} onPlay={onPlay} />);
    const titles = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(titles).toEqual(['3세트', '11세트']);
    fireEvent.click(screen.getAllByRole('button', { name: '1번째 다시 보기' })[0]!);
    expect(onPlay).toHaveBeenCalledWith(setKey(SID, 0, 2), 1);
  });
  it('저장이 실패하면 눌림을 되돌리고 안내를 보인다', async () => {
    const store = await setup({ analyses: [analysis(0, { findings: [{ index: 4, kind: 'kneeIn', value: 1 }] })] });
    vi.spyOn(store, 'putLabel').mockRejectedValue(new Error('idb'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} />);
    fireEvent.click(await screen.findByRole('button', { name: '맞아요' }));
    expect(await screen.findByText('저장하지 못했어요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '맞아요' })).toHaveAttribute('aria-pressed', 'false');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('저장이 끝나기 전에 같은 반복의 두 지적을 연달아 눌러도 둘 다 남는다', async () => {
    const store = await setup({
      analyses: [analysis(0, { findings: [{ index: 4, kind: 'depth', value: 1 }, { index: 4, kind: 'heel', value: 1 }] })],
    });
    const real = store.putLabel.bind(store);
    const put = vi.spyOn(store, 'putLabel').mockImplementation(async (l) => {
      await new Promise((r) => setTimeout(r, 30));
      return real(l);
    });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} />);
    const agree = await screen.findAllByRole('button', { name: '맞아요' });
    fireEvent.click(agree[0]!);
    fireEvent.click(agree[1]!);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    const last = put.mock.calls[1]![0];
    expect(last.verdicts).toHaveLength(2);
    await waitFor(async () => expect((await store.listLabels(SID))[0]!.verdicts).toHaveLength(2));
  });

  it('세트 제목에 운동 이름·횟수·목표 달성, 줄 앞에 아이콘', async () => {
    const store = await setup({
      videos: [0, 1],
      analyses: [
        analysis(0, { findings: [{ index: 4, kind: 'kneeIn', value: 1 }], notes: [{ kind: 'fastDescent', avgDescentMs: 600 }] }),
        analysis(1, { findings: [{ index: 4, kind: 'heel', value: 1 }] }),
      ],
    });
    const hit = { ...log(0, reps), endReason: 'target' as const };
    render(<FormFindings store={store} sessionId={SID} session={session([hit, log(1, reps)])} />);
    const titles = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(titles).toEqual(['스쿼트 1세트  5회  ✓ 목표 달성', '스쿼트 2세트  5회']);
    expect(screen.getAllByText('⚠')).toHaveLength(2);
    expect(screen.getAllByText('ⓘ')).toHaveLength(1);
  });

  it('영상도 분석도 없는 스쿼트 세트(녹화 실패)는 "영상 없음" 사유, 영상만 있으면 분석 중', async () => {
    const store = await setup({ videos: [1] });
    const zero = { ...log(2, []), count: 0 };
    const hang: SetLog = { ...log(3, reps), exercise: 'deadHang', exerciseIndex: 1, setIndex: 0 };
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps), log(1, reps), zero, hang])} />);
    const titles = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(titles).toEqual(['스쿼트 1세트  5회', '스쿼트 2세트  5회']);
    expect(screen.getByText('영상이 없어 분석하지 못했어요')).toBeInTheDocument();
    expect(screen.getByText('분석 중…')).toBeInTheDocument();
    expect(screen.getByText('분석 중… (0/1)')).toBeInTheDocument();
  });

  it('영상이 정리된 뒤에도 videoStartedAt으로 m:ss와 ▶을 보인다', async () => {
    const onPlay = vi.fn();
    const store = await setup({ videos: [], analyses: [analysis(0, { videoStartedAt: STARTED, findings: [{ index: 4, kind: 'depth', value: 1 }] })] });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} onPlay={onPlay} />);
    expect(await screen.findByText('4번째 (0:18)  허벅지가 바닥과 평행해질 때까지 앉지 않았어요', { normalizer: (t: string) => t })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '4번째 다시 보기' }));
    expect(onPlay).toHaveBeenCalledWith(setKey(SID, 0, 0), 4);
  });

  it('videoStartedAt이 없는 옛 분석은 영상이 정리됐어도 ▶을 보이고 시각만 뺀다', async () => {
    const store = await setup({ videos: [], analyses: [analysis(0, { findings: [{ index: 4, kind: 'depth', value: 1 }] })] });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} onPlay={vi.fn()} />);
    expect(await screen.findByText('4번째  허벅지가 바닥과 평행해질 때까지 앉지 않았어요', { normalizer: (t: string) => t })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4번째 다시 보기' })).toBeInTheDocument();
  });

  it('지적이 없는 세트에도 "영상 보기"가 있고 첫 반복부터 연다', async () => {
    const two = [
      { index: 1, startT: STARTED + 1000, bottomT: STARTED + 2000, endT: STARTED + 3000 },
      { index: 2, startT: STARTED + 4000, bottomT: STARTED + 5000, endT: STARTED + 6000 },
    ];
    const onPlay = vi.fn();
    const store = await setup({ analyses: [analysis(0)] });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, two)])} onPlay={onPlay} />);
    expect(await screen.findByText('자세 지적 없음')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '영상 보기' }));
    expect(onPlay).toHaveBeenCalledWith(setKey(SID, 0, 0), 1);
  });

  const m = (index: number, skipped: 'noPerson' | 'oneLeg' | null) => ({
    index, bottomT: 0, kneeDeg: skipped ? null : 80, kneeAnkleRatio: skipped ? null : 1.3, heelRise: skipped ? null : 0, descentMs: skipped ? null : 900, skipped,
  });

  it('판정한 반복이 하나도 없으면 "자세 지적 없음" 대신 사람이 안 보였다는 사유', async () => {
    const store = await setup({ analyses: [analysis(0, { metrics: [m(1, 'noPerson'), m(2, 'oneLeg')] })] });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} />);
    expect(await screen.findByText('사람이 화면에 보이지 않아 분석하지 못했어요')).toBeInTheDocument();
    expect(screen.queryByText('자세 지적 없음')).toBeNull();
  });

  it('일부 반복만 판정했으면 "n회는 판정하지 못했어요" 한 줄을 더한다', async () => {
    const store = await setup({ analyses: [analysis(0, { metrics: [m(1, null), m(2, 'noPerson'), m(3, 'oneLeg')] })] });
    render(<FormFindings store={store} sessionId={SID} session={session([log(0, reps)])} />);
    expect(await screen.findByText('자세 지적 없음')).toBeInTheDocument();
    expect(screen.getByText('2회는 판정하지 못했어요')).toBeInTheDocument();
  });
});
