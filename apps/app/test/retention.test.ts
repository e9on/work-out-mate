import { describe, expect, it, vi } from 'vitest';
import type { SetLog, WorkoutSession } from '@wom/core';
import { applyRetention, planRetention, type ClipCutter } from '../src/form/retention';
import { setKey, type RepLabel, type SetAnalysis, type SetVideo } from '../src/form/types';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { createMemoryStorage } from '../src/storage/memoryStorage';

const set0 = (sid: string) => setKey(sid, 0, 0);

function mkSet(startT: number, reps: { index: number; startT: number; endT: number }[]): SetLog {
  return {
    exercise: 'squat',
    target: { kind: 'reps', reps: 5 },
    count: reps.length,
    heldMs: 0,
    negativeDescentMs: [],
    startT,
    endT: startT + 30_000,
    endReason: 'target',
    reps: reps.map((r) => ({ ...r, bottomT: (r.startT + r.endT) / 2 })),
    exerciseIndex: 0,
    setIndex: 0,
    restTakenMs: null,
  } as SetLog;
}

function mkSession(id: string, endedAt: number, routineId = 'r1', reps: { index: number; startT: number; endT: number }[] = []): WorkoutSession {
  return { id, routineId, routineName: '루틴', startedAt: endedAt - 60_000, endedAt, completed: true, sets: [mkSet(endedAt - 50_000, reps)] };
}

const analysis = (sid: string, indices: number[]): SetAnalysis =>
  ({
    key: set0(sid),
    sessionId: sid,
    status: 'done',
    reason: null,
    metrics: [],
    findings: indices.map((index) => ({ index, kind: 'depth', value: 1 })),
    notes: [],
    uncertain: [],
    frames: [],
    model: 'rtmpose-m-halpe26',
    analyzedAt: 1,
  }) as SetAnalysis;

const label = (sid: string, index: number, p: Partial<RepLabel> = {}): RepLabel => ({
  key: `${set0(sid)}#${index}`,
  sessionId: sid,
  setKey: set0(sid),
  index,
  verdicts: [],
  manual: [],
  normal: false,
  note: '',
  updatedAt: 1,
  ...p,
});

const video = (sid: string, startedAt = 0): SetVideo => ({
  key: set0(sid),
  sessionId: sid,
  routineId: 'r1',
  exerciseIndex: 0,
  setIndex: 0,
  startedAt,
  mimeType: 'video/webm',
  blob: new Blob(['x']),
  boxes: [],
});

const REPS = [
  { index: 1, startT: 5_000, endT: 7_000 },
  { index: 4, startT: 18_000, endT: 20_000 },
];

const four = (reps = REPS) => [mkSession('a', 1000, 'r1', reps), mkSession('b', 2000), mkSession('c', 3000), mkSession('d', 4000)];

describe('planRetention', () => {
  it('같은 루틴 4번째 세션이 생기면 1번째 세션만 정리 대상이다', () => {
    const plan = planRetention(four(), [], [], ['a', 'b', 'c', 'd'].map(set0));
    expect(plan.deleteFull).toEqual([set0('a')]);
    expect([...plan.keepFull].sort()).toEqual([set0('b'), set0('c'), set0('d')]);
  });

  it('세션 순서는 endedAt 기준이며 key 사전순과 무관하다', () => {
    const ss = [mkSession('z', 1000), mkSession('a', 2000), mkSession('b', 3000), mkSession('c', 4000)];
    expect(planRetention(ss, [], [], ['z', 'a', 'b', 'c'].map(set0)).deleteFull).toEqual([set0('z')]);
  });

  it('루틴이 다르면 따로 센다', () => {
    const ss = [mkSession('a', 1000, 'r1'), mkSession('b', 2000, 'r2'), mkSession('c', 3000, 'r1'), mkSession('d', 4000, 'r2'), mkSession('e', 5000, 'r1')];
    const plan = planRetention(ss, [], [], ['a', 'b', 'c', 'd', 'e'].map(set0));
    expect(plan.deleteFull).toEqual([]);
    expect(plan.keepFull).toHaveLength(5);
  });

  it('지적 반복 4번(startT 18s, endT 20s)은 [17s, 21s] 클립이다', () => {
    const plan = planRetention(four(), [analysis('a', [4])], [], [set0('a')]);
    expect(plan.toClip).toEqual([{ setKey: set0('a'), index: 4, fromMs: 17_000, toMs: 21_000 }]);
  });

  it('fromMs/toMs는 영상 startedAt을 빼고 0 아래는 0으로 자른다', () => {
    const plan = planRetention(four(), [analysis('a', [1, 4])], [], [set0('a')], new Map([[set0('a'), 4_500]]));
    expect(plan.toClip).toEqual([
      { setKey: set0('a'), index: 1, fromMs: 0, toMs: 3_500 },
      { setKey: set0('a'), index: 4, fromMs: 12_500, toMs: 16_500 },
    ]);
  });

  it('라벨이 있는 반복도 클립이고, normal만 true여도 라벨로 센다. 빈 라벨은 아니다', () => {
    const ss = four();
    expect(planRetention(ss, [], [label('a', 1, { normal: true })], [set0('a')]).toClip.map((c) => c.index)).toEqual([1]);
    expect(planRetention(ss, [], [label('a', 4, { manual: ['heel'] })], [set0('a')]).toClip.map((c) => c.index)).toEqual([4]);
    expect(planRetention(ss, [], [label('a', 4, { verdicts: [{ kind: 'depth', agree: false }] })], [set0('a')]).toClip.map((c) => c.index)).toEqual([4]);
    expect(planRetention(ss, [], [label('a', 1)], [set0('a')]).toClip).toEqual([]);
  });

  it('지적·라벨 없는 세트는 클립 없이 삭제 대상이다', () => {
    const plan = planRetention(four(), [analysis('a', [])], [], [set0('a')]);
    expect(plan.toClip).toEqual([]);
    expect(plan.deleteFull).toEqual([set0('a')]);
  });

  it('세션에 없는 영상 키는 건드리지 않는다', () => {
    const plan = planRetention([mkSession('a', 1000)], [], [], ['ghost/0/0']);
    expect(plan).toEqual({ keepFull: [], toClip: [], deleteFull: [] });
  });
});

async function world(opts: { analyzeOld?: boolean } = {}) {
  const storage = createMemoryStorage();
  const store = createMemoryMediaStore();
  const base = 1_000_000;
  const ss = four(REPS.map((r) => ({ ...r, startT: r.startT + base, endT: r.endT + base })));
  for (const s of ss) {
    await storage.saveSession(s);
    await store.putVideo(video(s.id, base));
  }
  if (opts.analyzeOld ?? true) await store.putAnalysis(analysis('a', [4]));
  return { storage, store, base };
}

const okCutter = () => ({ cut: vi.fn(async () => ({ blob: new Blob(['clip']), mimeType: 'video/webm' })) });

describe('applyRetention', () => {
  it('지적 구간을 클립으로 저장하고 전체 영상을 지운다. 클립 startedAt은 클립 첫 프레임의 원래 시각이다', async () => {
    const { storage, store, base } = await world();
    const cutter = okCutter();
    await applyRetention({ storage, store, cutter });
    expect(cutter.cut).toHaveBeenCalledTimes(1);
    expect(cutter.cut.mock.calls[0]!.slice(1)).toEqual([17_000, 21_000]);
    const clips = await store.listClips(set0('a'));
    expect(clips).toHaveLength(1);
    // RepPlayer가 (rep.startT - 1000 - clip.startedAt)/1000 = 0초에서 시작해야 한다
    expect(clips[0]!.startedAt).toBe(base + 18_000 - 1000);
    expect(await store.getVideo(set0('a'))).toBeNull();
    expect(await store.getVideo(set0('b'))).not.toBeNull();
  });

  it('cut이 null이면 deleteVideo를 부르지 않고 다음 정리 때 다시 시도한다', async () => {
    const { storage, store } = await world();
    const del = vi.spyOn(store, 'deleteVideo');
    const failing: ClipCutter = { cut: vi.fn(async () => null) };
    await applyRetention({ storage, store, cutter: failing });
    expect(del).not.toHaveBeenCalled();
    expect(await store.getVideo(set0('a'))).not.toBeNull();
    await applyRetention({ storage, store, cutter: okCutter() });
    expect(await store.getVideo(set0('a'))).toBeNull();
  });

  it('이미 클립이 있으면 다시 자르지 않는다', async () => {
    const { storage, store, base } = await world();
    await store.putClip({ key: `${set0('a')}#4`, setKey: set0('a'), index: 4, startedAt: base + 17_000, mimeType: 'video/webm', blob: new Blob(['old']) });
    const cutter = okCutter();
    await applyRetention({ storage, store, cutter });
    expect(cutter.cut).not.toHaveBeenCalled();
    expect(await store.getVideo(set0('a'))).toBeNull();
  });

  it('분석이 아직 없는 오래된 세트는 건너뛴다(영상 유지)', async () => {
    const { storage, store } = await world({ analyzeOld: false });
    const cutter = okCutter();
    await applyRetention({ storage, store, cutter });
    expect(cutter.cut).not.toHaveBeenCalled();
    expect(await store.getVideo(set0('a'))).not.toBeNull();
  });

  it('한 세트에서 오류가 나도 예외를 던지지 않고 영상을 지우지 않는다', async () => {
    const { storage, store } = await world();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom: ClipCutter = { cut: vi.fn(async () => Promise.reject(new Error('x'))) };
    await expect(applyRetention({ storage, store, cutter: boom })).resolves.toBeUndefined();
    expect(await store.getVideo(set0('a'))).not.toBeNull();
  });

  it('분석이 failed·error인 오래된 세트는 다시 분석할 수 있게 영상을 지우지 않는다', async () => {
    const { storage, store } = await world({ analyzeOld: false });
    await store.putAnalysis({ ...analysis('a', []), status: 'failed', reason: 'error' });
    const cutter = okCutter();
    await applyRetention({ storage, store, cutter });
    expect(await store.getVideo(set0('a'))).not.toBeNull();
  });

  it('분석이 failed·noPerson인 오래된 세트는 정리한다', async () => {
    const { storage, store } = await world({ analyzeOld: false });
    await store.putAnalysis({ ...analysis('a', []), status: 'failed', reason: 'noPerson' });
    await applyRetention({ storage, store, cutter: okCutter() });
    expect(await store.getVideo(set0('a'))).toBeNull();
  });
});
