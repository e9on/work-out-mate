import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kp2, SetLog, WorkoutSession } from '@wom/core';
import { buildHalpe } from '../../../packages/core/test/helpers/halpeBuilder';
import { createAnalysisQueue, type AnalysisQueue, type VideoFrameReader } from '../src/form/analysisQueue';
import { setKey, type Box, type SetVideo } from '../src/form/types';
import type { FormPoseModel } from '../src/ports/formPose';
import type { MediaStore } from '../src/ports/mediaStore';
import type { Storage } from '../src/ports/storage';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { createMemoryStorage } from '../src/storage/memoryStorage';

const STARTED = 100_000;
const DURATION = 2400;
const BOX: Box = [0.1, 0.1, 0.9, 0.9];

/** 영상 시각(ms)별 가짜 자세: 0.6~1.4초는 무릎 130도(얕음), 나머지는 서 있음 */
const poseAt = (ms: number): Kp2[] => {
  const kneeDeg = ms >= 600 && ms <= 1400 ? 130 : 175;
  return buildHalpe({ t: ms, kneeDeg, kneeAnkleRatio: 1.5, heelRise: 0.05 }).kps!;
};

type Img = { ms: number };

function fakeReader(opts: { durationMs?: number } = {}) {
  const r = {
    opened: 0,
    closed: 0,
    asked: [] as number[],
    async open() {
      r.opened++;
      return {
        durationMs: opts.durationMs ?? DURATION,
        width: 640,
        height: 480,
        async frameAt(ms: number) {
          r.asked.push(ms);
          return { ms } as unknown as CanvasImageSource;
        },
        close() {
          r.closed++;
        },
      };
    },
  } satisfies VideoFrameReader & { opened: number; closed: number; asked: number[] };
  return r;
}

function fakeModel(opts: { kps?: (ms: number) => Kp2[]; slowMs?: number } = {}) {
  const m = {
    calls: [] as { ms: number; box: Box; w: number; h: number }[],
    active: 0,
    maxActive: 0,
    disposed: 0,
    backend: 'wasm' as const,
    async estimate(image: CanvasImageSource, w: number, h: number, box: Box): Promise<Kp2[]> {
      const ms = (image as unknown as Img).ms;
      m.calls.push({ ms, box, w, h });
      m.active++;
      m.maxActive = Math.max(m.maxActive, m.active);
      await (opts.slowMs ? new Promise((r) => setTimeout(r, opts.slowMs)) : Promise.resolve());
      m.active--;
      return (opts.kps ?? poseAt)(ms);
    },
    dispose() {
      m.disposed++;
    },
  } satisfies FormPoseModel & { calls: unknown[]; active: number; maxActive: number; disposed: number };
  return m;
}

const blob = (): Blob => new NodeBlob([new Uint8Array(4)], { type: 'video/webm' }) as unknown as Blob;

function video(sessionId: string, exerciseIndex: number, setIndex: number, boxes?: SetVideo['boxes']): SetVideo {
  const covering: SetVideo['boxes'] = [];
  for (let ms = 0; ms <= DURATION; ms += 33) covering.push({ t: STARTED + ms, box: BOX });
  return {
    key: setKey(sessionId, exerciseIndex, setIndex),
    sessionId,
    routineId: 'r1',
    exerciseIndex,
    setIndex,
    startedAt: STARTED,
    mimeType: 'video/webm',
    blob: blob(),
    boxes: boxes ?? covering,
  };
}

function log(exerciseIndex: number, setIndex: number, withReps = true): SetLog {
  return {
    exercise: 'squat',
    target: { kind: 'reps', reps: 1 },
    count: 1,
    heldMs: 0,
    negativeDescentMs: [],
    startT: STARTED,
    endT: STARTED + DURATION,
    endReason: 'button',
    ...(withReps ? { reps: [{ index: 1, startT: STARTED + 200, bottomT: STARTED + 1000, endT: STARTED + 1800 }] } : {}),
    exerciseIndex,
    setIndex,
    restTakenMs: null,
  };
}

function session(id: string, sets: SetLog[]): WorkoutSession {
  return { id, routineId: 'r1', routineName: '루틴', startedAt: STARTED, endedAt: STARTED + 5000, completed: true, sets };
}

async function setup(opts: { reader?: ReturnType<typeof fakeReader>; model?: ReturnType<typeof fakeModel>; storage?: Storage; store?: MediaStore } = {}) {
  const store = opts.store ?? createMemoryMediaStore();
  const storage = opts.storage ?? createMemoryStorage();
  const reader = opts.reader ?? fakeReader();
  const model = opts.model ?? fakeModel();
  const modelFactory = vi.fn(async () => model as FormPoseModel);
  const queue = createAnalysisQueue({ store, storage, model: modelFactory, reader, now: () => 777, retryDelayMs: 0 });
  queues.push(queue);
  return { store, storage, reader, model, modelFactory, queue };
}
const queues: AnalysisQueue[] = [];
afterEach(() => {
  for (const q of queues.splice(0)) q.dispose();
  vi.restoreAllMocks();
});

const analysisOf = (store: MediaStore, key: string) => vi.waitFor(async () => (await store.getAnalysis(key)) ?? Promise.reject(new Error('아직 없음')));

describe('분석 대기열', () => {
  it('enqueue하면 15fps 시각마다 estimate를 부르고 SetAnalysis(done)와 findings를 저장한다', async () => {
    const { store, storage, reader, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    const progress = vi.fn();
    queue.onProgress(progress);
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    const a = await analysisOf(store, key);
    expect(a.status).toBe('done');
    expect(a.reason).toBeNull();
    expect(a.sessionId).toBe('s1');
    expect(a.analyzedAt).toBe(777);
    expect(a.model).toBe('rtmpose-m-halpe26');
    // 0, 66.67, ... 2400ms: 37프레임
    expect(model.calls).toHaveLength(37);
    expect(reader.asked[1]).toBeCloseTo(1000 / 15, 5);
    expect(reader.asked.at(-1)!).toBeLessThanOrEqual(DURATION);
    expect(model.calls[0]).toMatchObject({ w: 640, h: 480, box: BOX });
    // KpFrame.t는 영상 시작 epoch + 프레임 ms
    expect(a.frames[0]!.t).toBe(STARTED);
    expect(a.frames[3]!.t).toBeCloseTo(STARTED + 200, 5);
    expect(a.metrics).toHaveLength(1);
    expect(a.metrics[0]!.skipped).toBeNull();
    // 깊이는 이제 반복별 지적이 아니라 세트 조언(notes)으로만 낸다
    expect(a.findings.some((f) => f.kind === 'depth')).toBe(false);
    // 대기열에 넣을 때 한 번(분석 중 표시), 저장 뒤 한 번
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(2));
    expect(progress).toHaveBeenCalledWith('s1');
    expect(reader.closed).toBe(1);
  });

  it('enqueue하면 분석이 끝나기 전에 onProgress로 알린다(결과 화면이 "분석 중"으로 바뀌게)', async () => {
    const { queue } = await setup();
    const progress = vi.fn();
    queue.onProgress(progress);
    queue.setBusy(true);
    queue.enqueue(setKey('s9', 0, 0));
    expect(progress).toHaveBeenCalledWith('s9');
  });

  it('estimate는 한 번에 하나씩만 부른다', async () => {
    const { store, storage, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    queue.enqueue(setKey('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 1));
    await analysisOf(store, setKey('s1', 0, 1));
    expect(model.maxActive).toBe(1);
  });

  it('busy=true인 동안 estimate를 부르지 않고, false가 되면 이어서 끝낸다', async () => {
    const { store, storage, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    queue.setBusy(true);
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    await new Promise((r) => setTimeout(r, 30));
    expect(model.calls).toHaveLength(0);
    queue.setBusy(false);
    expect((await analysisOf(store, key)).status).toBe('done');
    expect(model.calls).toHaveLength(37);
  });

  it('분석 도중 busy가 되면 프레임 사이에서 멈췄다가 풀리면 이어서 한다', async () => {
    const { store, storage, model, queue } = await setup({ model: fakeModel({ slowMs: 2 }) });
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    await vi.waitFor(() => expect(model.calls.length).toBeGreaterThan(0));
    queue.setBusy(true);
    await new Promise((r) => setTimeout(r, 20));
    const n = model.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(model.calls.length).toBe(n);
    expect(await store.getAnalysis(key)).toBeNull();
    queue.setBusy(false);
    await analysisOf(store, key);
    expect(model.calls).toHaveLength(37);
  });

  it('resumePending은 분석 없는 key만 넣고, 같은 key를 두 번 enqueue해도 한 번만 분석한다', async () => {
    const { store, storage, reader, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    const done = setKey('s1', 0, 0);
    await store.putAnalysis({ key: done, sessionId: 's1', status: 'done', reason: null, metrics: [], findings: [], notes: [], uncertain: [], frames: [], model: 'rtmpose-m-halpe26', analyzedAt: 1 });
    const todo = setKey('s1', 0, 1);
    queue.enqueue(todo);
    queue.enqueue(todo);
    await queue.resumePending();
    await analysisOf(store, todo);
    await new Promise((r) => setTimeout(r, 20));
    expect(reader.opened).toBe(1); // done은 건너뜀, todo는 한 번만
    expect((await store.getAnalysis(done))!.analyzedAt).toBe(1);
  });

  it('boxes가 빈 구간 프레임은 kps null로 넘어가고 estimate도 부르지 않는다', async () => {
    const { store, storage, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    const boxes: SetVideo['boxes'] = [];
    for (let ms = 0; ms <= 1000; ms += 33) boxes.push({ t: STARTED + ms, box: BOX });
    await store.putVideo(video('s1', 0, 0, boxes));
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    const a = await analysisOf(store, key);
    expect(a.frames).toHaveLength(37);
    const late = a.frames.filter((f) => f.t - STARTED > 1300);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((f) => f.kps === null)).toBe(true);
    expect(a.frames[0]!.kps).not.toBeNull();
    expect(model.calls.every((c) => c.ms <= 1200 + 1)).toBe(true);
  });

  it('상자 너비·높이가 0이거나 NaN이면 estimate하지 않는다', async () => {
    const { store, storage, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    const bad: SetVideo['boxes'] = [];
    for (let ms = 0; ms <= DURATION; ms += 33) {
      const box: Box = ms < 1200 ? [0.5, 0.1, 0.5, 0.9] : ms < 1800 ? [0.1, 0.1, Number.NaN, 0.9] : BOX;
      bad.push({ t: STARTED + ms, box });
    }
    await store.putVideo(video('s1', 0, 0, bad));
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    const a = await analysisOf(store, key);
    expect(model.calls.every((c) => c.ms >= 1750)).toBe(true);
    expect(a.frames.filter((f) => f.kps === null).length).toBeGreaterThan(0);
  });

  it('모든 프레임이 null이면 failed·noPerson', async () => {
    const { store, storage, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0, []));
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    const a = await analysisOf(store, key);
    expect(a).toMatchObject({ status: 'failed', reason: 'noPerson' });
    expect(model.calls).toHaveLength(0);
  });

  it('model 생성이 reject되면 failed·error로 저장하고 다음 key는 계속 시도한다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createMemoryMediaStore();
    const storage = createMemoryStorage();
    const model = fakeModel();
    let n = 0;
    const factory = vi.fn(async () => {
      if (n++ === 0) throw new Error('모델 없음');
      return model as FormPoseModel;
    });
    const queue = createAnalysisQueue({ store, storage, model: factory, reader: fakeReader(), now: () => 1, retryDelayMs: 0 });
    queues.push(queue);
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    queue.enqueue(setKey('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 1));
    expect(await analysisOf(store, setKey('s1', 0, 0))).toMatchObject({ status: 'failed', reason: 'error', sessionId: 's1' });
    expect((await analysisOf(store, setKey('s1', 0, 1))).status).toBe('done');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('estimate가 던지면 failed·error이고 영상을 닫는다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = fakeModel({
      kps: () => {
        throw new Error('추론 실패');
      },
    });
    const reader = fakeReader();
    const { store, storage, queue } = await setup({ model, reader });
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 0));
    expect(await analysisOf(store, setKey('s1', 0, 0))).toMatchObject({ status: 'failed', reason: 'error' });
    expect(reader.closed).toBe(1);
  });

  it('모델은 처음 필요할 때 한 번만 만든다', async () => {
    const { store, storage, modelFactory, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    expect(modelFactory).not.toHaveBeenCalled();
    queue.enqueue(setKey('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 1));
    await analysisOf(store, setKey('s1', 0, 1));
    expect(modelFactory).toHaveBeenCalledTimes(1);
  });

  it('영상이 없으면 failed·noVideo', async () => {
    const { store, queue } = await setup();
    queue.enqueue(setKey('s9', 0, 0));
    expect(await analysisOf(store, setKey('s9', 0, 0))).toMatchObject({ status: 'failed', reason: 'noVideo', sessionId: 's9' });
  });

  it('세션 기록에 reps가 없으면(옛 기록) 분석하지 않고 저장도 하지 않는다', async () => {
    const { store, storage, model, modelFactory, reader, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0, false), log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    queue.enqueue(setKey('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 1));
    await analysisOf(store, setKey('s1', 0, 1));
    expect(await store.getAnalysis(setKey('s1', 0, 0))).toBeNull();
    expect(reader.opened).toBe(1);
    expect(model.calls.length).toBe(37);
    expect(modelFactory).toHaveBeenCalledTimes(1);
  });

  it('세트 기록이 늦게 저장돼도 뒤로 미뤘다가 다시 시도해 분석한다', async () => {
    const base = createMemoryStorage();
    let calls = 0;
    // 세 번째 조회 때 (0,0)의 기록이 저장된다(엔진의 중간 저장이 늦은 상황)
    const storage: Storage = {
      ...base,
      async getSession(id) {
        if (++calls === 3) await base.saveSession(session('s1', [log(0, 0), log(0, 1)]));
        return base.getSession(id);
      },
    };
    const { store, queue } = await setup({ storage });
    await base.saveSession(session('s1', [log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    const first = setKey('s1', 0, 0);
    const second = setKey('s1', 0, 1);
    queue.enqueue(first);
    queue.enqueue(second);
    const b = await analysisOf(store, second);
    const a = await analysisOf(store, first);
    expect(a.status).toBe('done');
    expect(b.analyzedAt <= a.analyzedAt).toBe(true);
    expect(calls).toBe(3);
  });

  it('세트 기록을 끝내 못 찾으면 5번 시도 뒤 포기하고 저장하지 않으며, 다음 resumePending에서 다시 시도된다', async () => {
    const base = createMemoryStorage();
    const getSession = vi.fn((id: string) => base.getSession(id));
    const storage: Storage = { ...base, getSession };
    const { store, queue } = await setup({ storage });
    await store.putVideo(video('s1', 0, 0));
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(5));
    await new Promise((r) => setTimeout(r, 20));
    expect(getSession).toHaveBeenCalledTimes(5);
    expect(await store.getAnalysis(key)).toBeNull();
    await base.saveSession(session('s1', [log(0, 0)]));
    await queue.resumePending();
    expect((await analysisOf(store, key)).status).toBe('done');
  });

  it('같은 세션의 앞선 분석 metrics를 history로 쓴다', async () => {
    // 앞선 세트 5개의 무릎 모임 비율이 1.5이고 이번 세트는 1.2라 상대 비교에서 지적된다
    const { store, storage, queue } = await setup({
      model: fakeModel({ kps: (ms) => buildHalpe({ t: ms, kneeDeg: ms >= 600 && ms <= 1400 ? 80 : 175, kneeAnkleRatio: ms >= 600 && ms <= 1400 ? 1.2 : 1, heelRise: 0.05 }).kps! }),
    });
    const peers = [1, 2, 3, 4, 5].map((i) => ({ index: i, bottomT: i, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.05, descentMs: 1500, skipped: null }));
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putAnalysis({ key: setKey('s1', 0, 0), sessionId: 's1', status: 'done', reason: null, metrics: peers, findings: [], notes: [], uncertain: [], frames: [], model: 'rtmpose-m-halpe26', analyzedAt: 1 });
    await store.putVideo(video('s1', 0, 1));
    queue.enqueue(setKey('s1', 0, 1));
    const a = await analysisOf(store, setKey('s1', 0, 1));
    expect(a.findings.some((f) => f.kind === 'kneeInRelative')).toBe(true);
  });

  it('영상 길이가 0이면 done이 아니라 failed·error로 저장한다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, storage, model, queue } = await setup({ reader: fakeReader({ durationMs: 0 }) });
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 0));
    expect(await analysisOf(store, setKey('s1', 0, 0))).toMatchObject({ status: 'failed', reason: 'error' });
    expect(model.calls).toHaveLength(0);
  });

  it('모델을 불러오는 중에 busy가 되면 풀릴 때까지 estimate를 부르지 않는다', async () => {
    const store = createMemoryMediaStore();
    const storage = createMemoryStorage();
    const model = fakeModel();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory = vi.fn(async () => {
      await gate;
      return model as FormPoseModel;
    });
    const queue = createAnalysisQueue({ store, storage, model: factory, reader: fakeReader(), now: () => 1, retryDelayMs: 0 });
    queues.push(queue);
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 0));
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    queue.setBusy(true);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(model.calls).toHaveLength(0);
    queue.setBusy(false);
    expect((await analysisOf(store, setKey('s1', 0, 0))).status).toBe('done');
  });

  const doneWith = (key: string, sessionId: string, metrics: unknown[]) => ({
    key,
    sessionId,
    status: 'done' as const,
    reason: null,
    metrics: metrics as never,
    findings: [],
    notes: [],
    uncertain: [],
    frames: [],
    model: 'rtmpose-m-halpe26' as const,
    analyzedAt: 1,
  });
  const peers = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i + 1, bottomT: i, kneeDeg: 80, kneeAnkleRatio: 1.5, heelRise: 0.05, descentMs: 1500, skipped: null }));
  const lowRatioModel = () =>
    fakeModel({ kps: (ms) => buildHalpe({ t: ms, kneeDeg: ms >= 600 && ms <= 1400 ? 80 : 175, kneeAnkleRatio: ms >= 600 && ms <= 1400 ? 1.2 : 1, heelRise: 0.05 }).kps! });

  it('history에 같은 세션의 뒤 세트 분석은 넣지 않는다', async () => {
    const { store, storage, queue } = await setup({ model: lowRatioModel() });
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putAnalysis(doneWith(setKey('s1', 0, 1), 's1', peers(5))); // 뒤 세트
    await store.putVideo(video('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 0));
    const a = await analysisOf(store, setKey('s1', 0, 0));
    expect(a.findings.some((f) => f.kind === 'kneeInRelative')).toBe(false);
  });

  it('history에 이번 세션보다 늦게 시작한 세션의 분석은 넣지 않고, 먼저 시작한 세션은 넣는다', async () => {
    const { store, storage, queue } = await setup({ model: lowRatioModel() });
    await storage.saveSession(session('s1', [log(0, 0)]));
    await storage.saveSession({ ...session('late', [log(0, 0)]), startedAt: STARTED + 1000 });
    await storage.saveSession({ ...session('early', [log(0, 0)]), startedAt: STARTED - 1000 });
    await store.putAnalysis(doneWith(setKey('late', 0, 0), 'late', peers(5)));
    await store.putVideo(video('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 0));
    expect((await analysisOf(store, setKey('s1', 0, 0))).findings.some((f) => f.kind === 'kneeInRelative')).toBe(false);
    await store.putAnalysis(doneWith(setKey('early', 0, 0), 'early', peers(5)));
    await store.deleteVideo(setKey('s1', 0, 0));
    await store.putVideo(video('s1', 0, 0));
    queues.push(queue);
    const q2 = createAnalysisQueue({ store, storage, model: async () => lowRatioModel(), reader: fakeReader(), now: () => 2, retryDelayMs: 0 });
    queues.push(q2);
    q2.enqueue(setKey('s1', 0, 0));
    await vi.waitFor(async () => expect((await store.getAnalysis(setKey('s1', 0, 0)))!.analyzedAt).toBe(2));
    expect((await store.getAnalysis(setKey('s1', 0, 0)))!.findings.some((f) => f.kind === 'kneeInRelative')).toBe(true);
  });

  it('dispose하면 모델을 정리하고 더 분석하지 않는다', async () => {
    const { store, storage, model, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0), log(0, 1)]));
    await store.putVideo(video('s1', 0, 0));
    await store.putVideo(video('s1', 0, 1));
    queue.enqueue(setKey('s1', 0, 0));
    await analysisOf(store, setKey('s1', 0, 0));
    queue.dispose();
    queue.enqueue(setKey('s1', 0, 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.getAnalysis(setKey('s1', 0, 1))).toBeNull();
    expect(model.disposed).toBe(1);
  });

  it('failed·error는 resumePending에서 다시 분석하고, 3번 실패하면 더 넣지 않는다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = fakeModel({
      kps: () => {
        throw new Error('일시 오류');
      },
    });
    const reader = fakeReader();
    const { store, storage, queue } = await setup({ model, reader });
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    const key = setKey('s1', 0, 0);
    queue.enqueue(key);
    expect(await analysisOf(store, key)).toMatchObject({ status: 'failed', reason: 'error', attempts: 1 });
    for (const n of [2, 3]) {
      await queue.resumePending();
      await vi.waitFor(async () => expect((await store.getAnalysis(key))!.attempts).toBe(n));
    }
    await queue.resumePending();
    await new Promise((r) => setTimeout(r, 20));
    expect(reader.opened).toBe(3);
  });

  it('attempts가 없는 옛 failed·error도 다시 분석하고, 성공하면 done으로 바뀐다', async () => {
    const { store, storage, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    const key = setKey('s1', 0, 0);
    await store.putAnalysis({ key, sessionId: 's1', status: 'failed', reason: 'error', metrics: [], findings: [], notes: [], uncertain: [], frames: [], model: 'rtmpose-m-halpe26', analyzedAt: 1 });
    await queue.resumePending();
    await vi.waitFor(async () => expect((await store.getAnalysis(key))!.status).toBe('done'));
  });

  it('화면이 숨겨진(hidden) 동안은 분석을 멈추고, 다시 보이면 이어서 한다', async () => {
    let state: DocumentVisibilityState = 'hidden';
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    try {
      const { store, storage, model, queue } = await setup();
      await storage.saveSession(session('s1', [log(0, 0)]));
      await store.putVideo(video('s1', 0, 0));
      const key = setKey('s1', 0, 0);
      queue.enqueue(key);
      await new Promise((r) => setTimeout(r, 30));
      expect(model.calls).toHaveLength(0);
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect((await analysisOf(store, key)).status).toBe('done');
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (desc) Object.defineProperty(Document.prototype, 'visibilityState', desc);
    }
  });

  it('분석에 영상 시작 시각(videoStartedAt)을 함께 저장한다', async () => {
    const { store, storage, queue } = await setup();
    await storage.saveSession(session('s1', [log(0, 0)]));
    await store.putVideo(video('s1', 0, 0));
    queue.enqueue(setKey('s1', 0, 0));
    expect((await analysisOf(store, setKey('s1', 0, 0))).videoStartedAt).toBe(STARTED);
  });
});
