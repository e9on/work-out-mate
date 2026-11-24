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
  /** 영상은 있는데 분석이 없거나 일시 오류로 실패한(시도 3회 미만) key를 대기열에 넣는다(분석이 끝나길 기다리지 않는다) */
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
/** 일시적 오류(reason 'error')로 실패한 세트를 다시 분석하는 최대 시도 횟수 */
export const MAX_ERROR_ATTEMPTS = 3;

/** 다시 분석해야 하는 분석인가: 없거나, 오류로 실패했고 시도 횟수가 남았다 */
export const needsAnalysis = (a: SetAnalysis | null): boolean =>
  !a || (a.status === 'failed' && a.reason === 'error' && (a.attempts ?? 1) < MAX_ERROR_ATTEMPTS);

/** 브라우저 화면이 숨겨졌나(백그라운드). document가 없으면 false */
const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

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
  /** 세트 진행 중이거나 앱이 백그라운드면 기다린다(숨겨진 동안 영상 읽기가 멈춰 오류가 나는 것을 막는다) */
  const waitNotBusy = async (): Promise<void> => {
    while ((busy || pageHidden()) && !disposed) await new Promise<void>((r) => waiters.push(r));
  };
  const onVisibility = () => {
    if (!pageHidden()) wake();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

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

  const failed = (
    key: SetKey,
    sessionId: string,
    reason: 'noVideo' | 'noPerson' | 'error',
    extra: Pick<SetAnalysis, 'videoStartedAt' | 'attempts'> = {},
  ): SetAnalysis => ({
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
    ...extra,
  });

  /** 같은 세션의 앞선 분석 + 최근 세션의 스쿼트 분석 metrics */
  const gatherHistory = async (key: SetKey, session: WorkoutSession, cur: { exerciseIndex: number; setIndex: number }): Promise<SquatRepMetrics[]> => {
    const out: SquatRepMetrics[] = [];
    // 같은 세션은 이번 세트보다 앞선 세트만, 다른 세션은 먼저 시작한 세션만 본다
    const before = (l: { exerciseIndex: number; setIndex: number }) => l.exerciseIndex < cur.exerciseIndex || (l.exerciseIndex === cur.exerciseIndex && l.setIndex < cur.setIndex);
    const take = async (s: WorkoutSession, same: boolean) => {
      const squatKeys = new Set(
        s.sets.filter((l) => l.exercise === 'squat' && (!same || before(l))).map((l) => `${s.id}/${l.exerciseIndex}/${l.setIndex}`),
      );
      for (const a of await store.listAnalyses(s.id)) {
        if (a.key !== key && a.status === 'done' && squatKeys.has(a.key)) out.push(...a.metrics);
      }
    };
    try {
      await take(session, true);
      const others = (await storage.listSessions())
        .filter((s) => s.id !== session.id && s.startedAt < session.startedAt)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, RECENT_SESSIONS);
      for (const s of others) await take(s, false);
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
      if (!(Number.isFinite(clip.durationMs) && clip.durationMs > 0)) throw new Error('영상 길이를 알 수 없어요');
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
      await waitNotBusy(); // 모델을 불러오는 동안 다음 세트가 시작됐을 수 있다
      if (disposed) return 'done';
      const frames = await readFrames(video, model);
      if (disposed) return 'done';
      if (frames.every((f) => f.kps === null)) {
        a = failed(key, video.sessionId, 'noPerson', { videoStartedAt: video.startedAt });
      } else {
        const metrics = computeSquatRepMetrics(frames, log.reps);
        const judged = judgeSquat(metrics, await gatherHistory(key, session, log));
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
          videoStartedAt: video.startedAt,
        };
      }
    } catch (e) {
      warn('세트 분석 실패', e);
      // 일시적 오류일 수 있어 시도 횟수를 세어 두고, 다음 resumePending에서 다시 넣는다
      let prev: SetAnalysis | null = null;
      try {
        prev = await store.getAnalysis(key);
      } catch (e2) {
        warn('이전 분석 읽기 실패', e2);
      }
      const attempts = prev?.status === 'failed' && prev.reason === 'error' ? (prev.attempts ?? 1) + 1 : 1;
      a = failed(key, video.sessionId, 'error', { videoStartedAt: video.startedAt, attempts });
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
        if (needsAnalysis(await store.getAnalysis(key))) enqueue(key);
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
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
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
