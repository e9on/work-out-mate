import { computeSquatRepMetrics, judgeSquat, type Kp2, type KpFrame, type SquatRepMetrics, type WorkoutSession } from '@wom/core';
import type { FormPoseModel } from '../ports/formPose';
import type { MediaStore } from '../ports/mediaStore';
import type { Storage } from '../ports/storage';
import type { Box, SetAnalysis, SetKey, SetVideo } from './types';

/** 숨은 영상에서 원하는 시각의 프레임 이미지를 뽑는다. */
export interface VideoFrameReader {
  open(blob: Blob): Promise<{
    durationMs: number;
    width: number;
    height: number;
    frameAt(ms: number): Promise<CanvasImageSource>;
    close(): void;
  }>;
}

export type AnalysisQueue = {
  enqueue(key: SetKey): void;
  /** 영상은 있는데 분석이 없는 key를 대기열에 넣는다(분석이 끝나길 기다리지 않는다) */
  resumePending(): Promise<void>;
  /** 세트 진행 중이면 true. true인 동안은 프레임 사이에서 멈춘다 */
  setBusy(busy: boolean): void;
  onProgress(cb: (sessionId: string) => void): () => void;
  dispose(): void;
};

export type AnalysisQueueDeps = {
  store: MediaStore;
  storage: Storage;
  model: () => Promise<FormPoseModel>;
  reader: VideoFrameReader;
  now: () => number;
  /** 세션에서 세트 기록을 못 찾았을 때 다시 시도하기 전 기다리는 ms(기본 1000) */
  retryDelayMs?: number;
};

/** 분석 프레임 간격(15fps) */
const FPS = 15;
/** 프레임 시각과 상자 시각이 이 안이면 그 상자를 쓴다 */
const BOX_TOLERANCE_MS = 200;
/** 세트 기록(SetLog)을 찾는 최대 시도 횟수(엔진의 중간 저장이 늦을 수 있다) */
const MAX_LOOKUP_TRIES = 5;
/** 기준 기록으로 참고할 이전 세션 수 */
const RECENT_SESSIONS = 5;

const warn = (what: string, e: unknown) => console.warn(what, e);

type TimedBox = SetVideo['boxes'][number];

/** 가장 가까운 상자. 허용 범위 안에 없으면 null. boxes는 시간순 */
function nearestBox(boxes: TimedBox[], t: number): Box | null {
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  let best: TimedBox | null = null;
  for (const i of [lo - 1, lo]) {
    const b = boxes[i];
    if (b && (best === null || Math.abs(b.t - t) < Math.abs(best.t - t))) best = b;
  }
  return best && Math.abs(best.t - t) <= BOX_TOLERANCE_MS ? best.box : null;
}

/** 너비·높이가 0보다 큰 유한한 상자만 쓴다 */
const usableBox = (b: Box): boolean => {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
};

const sessionIdOf = (key: SetKey): string => key.split('/')[0] ?? key;

export function createAnalysisQueue(deps: AnalysisQueueDeps): AnalysisQueue {
  const { store, storage, reader, now } = deps;
  const retryDelayMs = deps.retryDelayMs ?? 1000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const pending: SetKey[] = [];
  /** 대기열에 있거나 분석 중인 key */
  const known = new Set<SetKey>();
  const lookups = new Map<SetKey, number>();
  const listeners = new Set<(sessionId: string) => void>();
  let running = false;
  let busy = false;
  let disposed = false;
  let waiters: (() => void)[] = [];
  let modelPromise: Promise<FormPoseModel> | null = null;
  let loadedModel: FormPoseModel | null = null;

  /** 처음 필요할 때 한 번만 만든다. 실패하면 다음 key에서 다시 시도한다 */
  const getModel = (): Promise<FormPoseModel> => {
    if (!modelPromise) {
      modelPromise = deps.model().then(
        (m) => {
          loadedModel = m;
          return m;
        },
        (e) => {
          modelPromise = null;
          throw e;
        },
      );
    }
    return modelPromise;
  };

  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  const waitNotBusy = async (): Promise<void> => {
    while (busy && !disposed) await new Promise<void>((r) => waiters.push(r));
  };

  const finish = async (a: SetAnalysis): Promise<void> => {
    await store.putAnalysis(a);
    for (const cb of [...listeners]) {
      try {
        cb(a.sessionId);
      } catch (e) {
        warn('분석 진행 알림 실패', e);
      }
    }
  };

  const failed = (key: SetKey, sessionId: string, reason: 'noVideo' | 'noPerson' | 'error'): SetAnalysis => ({
    key,
    sessionId,
    status: 'failed',
    reason,
    metrics: [],
    findings: [],
    notes: [],
    uncertain: [],
    frames: [],
    model: 'rtmpose-m-halpe26',
    analyzedAt: now(),
  });

  /** 같은 세션의 앞선 분석 + 최근 세션의 스쿼트 분석 metrics */
  const gatherHistory = async (key: SetKey, session: WorkoutSession): Promise<SquatRepMetrics[]> => {
    const out: SquatRepMetrics[] = [];
    const take = async (s: WorkoutSession) => {
      const squatKeys = new Set(s.sets.filter((l) => l.exercise === 'squat').map((l) => `${s.id}/${l.exerciseIndex}/${l.setIndex}`));
      for (const a of await store.listAnalyses(s.id)) {
        if (a.key !== key && a.status === 'done' && squatKeys.has(a.key)) out.push(...a.metrics);
      }
    };
    try {
      await take(session);
      const others = (await storage.listSessions())
        .filter((s) => s.id !== session.id)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, RECENT_SESSIONS);
      for (const s of others) await take(s);
    } catch (e) {
      warn('이전 분석 기록 읽기 실패', e);
    }
    return out;
  };

  /** 프레임을 한 번에 하나씩(직렬) 읽어 관절점을 구한다. 프레임 시각 t는 영상 시작 epoch + 영상 ms */
  const readFrames = async (video: SetVideo, model: FormPoseModel): Promise<KpFrame[]> => {
    const clip = await reader.open(video.blob);
    const frames: KpFrame[] = [];
    try {
      const step = 1000 / FPS;
      for (let i = 0; i * step <= clip.durationMs; i++) {
        await waitNotBusy();
        if (disposed) break;
        const ms = i * step;
        const t = video.startedAt + ms;
        const box = nearestBox(video.boxes, t);
        if (!box || !usableBox(box)) {
          frames.push({ t, kps: null });
          continue;
        }
        const image = await clip.frameAt(ms);
        const kps: Kp2[] = await model.estimate(image, clip.width, clip.height, box);
        frames.push({ t, kps });
      }
    } finally {
      clip.close();
    }
    return frames;
  };

  /** 'retry'면 세트 기록이 아직 없어 나중에 다시 해야 한다 */
  const processOne = async (key: SetKey): Promise<'done' | 'retry'> => {
    await waitNotBusy();
    if (disposed) return 'done';
    const video = await store.getVideo(key);
    if (!video) {
      await finish(failed(key, sessionIdOf(key), 'noVideo'));
      return 'done';
    }
    const session = await storage.getSession(video.sessionId);
    const log = session?.sets.find((l) => l.exerciseIndex === video.exerciseIndex && l.setIndex === video.setIndex);
    if (!session || !log) return 'retry';
    // 옛 기록(반복 시각 없음)이나 스쿼트가 아닌 세트는 분석하지 않고 건너뛴다
    if (log.exercise !== 'squat' || !log.reps || log.reps.length === 0) return 'done';

    let a: SetAnalysis;
    try {
      const model = await getModel();
      const frames = await readFrames(video, model);
      if (disposed) return 'done';
      if (frames.every((f) => f.kps === null)) {
        a = failed(key, video.sessionId, 'noPerson');
      } else {
        const metrics = computeSquatRepMetrics(frames, log.reps);
        const judged = judgeSquat(metrics, await gatherHistory(key, session));
        a = {
          key,
          sessionId: video.sessionId,
          status: 'done',
          reason: null,
          metrics,
          findings: judged.findings,
          notes: judged.notes,
          uncertain: judged.uncertain,
          frames,
          model: 'rtmpose-m-halpe26',
          analyzedAt: now(),
        };
      }
    } catch (e) {
      warn('세트 분석 실패', e);
      a = failed(key, video.sessionId, 'error');
    }
    if (disposed) return 'done';
    await finish(a);
    return 'done';
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (!disposed && pending.length > 0) {
        const key = pending.shift()!;
        let result: 'done' | 'retry' = 'done';
        try {
          result = await processOne(key);
        } catch (e) {
          warn('분석 대기열 처리 실패', e);
        }
        if (result === 'retry') {
          const tries = (lookups.get(key) ?? 0) + 1;
          if (tries < MAX_LOOKUP_TRIES) {
            lookups.set(key, tries);
            pending.push(key); // 대기열 뒤로 보내 나중에 다시 시도
            await sleep(retryDelayMs);
            continue;
          }
        }
        lookups.delete(key);
        known.delete(key);
      }
    } finally {
      running = false;
    }
  };

  const enqueue = (key: SetKey): void => {
    if (disposed || known.has(key)) return;
    known.add(key);
    pending.push(key);
    void pump();
  };

  return {
    enqueue,
    async resumePending() {
      for (const key of await store.listVideoKeys()) {
        if (known.has(key)) continue;
        if (!(await store.getAnalysis(key))) enqueue(key);
      }
    },
    setBusy(b) {
      busy = b;
      if (!b) wake();
    },
    onProgress(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      known.clear();
      listeners.clear();
      wake();
      loadedModel?.dispose();
      loadedModel = null;
      modelPromise = null;
    },
  };
}
