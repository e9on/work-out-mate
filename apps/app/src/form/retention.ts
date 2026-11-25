import type { WorkoutSession } from '@wom/core';
import type { MediaStore } from '../ports/mediaStore';
import type { Storage } from '../ports/storage';
import { setKey, type RepLabel, type SetAnalysis, type SetKey, type SetVideo } from './types';

/** 루틴마다 전체 영상을 남기는 최근 세션 수 */
export const KEEP_FULL_SESSIONS = 3;
/** 클립은 반복 앞뒤로 이만큼(ms) 더 남긴다 */
export const CLIP_PAD_MS = 1000;

export interface ClipCutter {
  /** video 안의 [fromMs, toMs] 구간을 잘라 돌려준다. 이 기기에서 못 자르면 null */
  cut(video: SetVideo, fromMs: number, toMs: number): Promise<{ blob: Blob; mimeType: string } | null>;
}

export type ClipPlan = { setKey: SetKey; index: number; fromMs: number; toMs: number };
export type RetentionPlan = { keepFull: SetKey[]; toClip: ClipPlan[]; deleteFull: SetKey[] };

const isSettled = (a: SetAnalysis): boolean => a.status === 'done' || a.reason === 'noPerson' || a.reason === 'noVideo';

const hasLabel = (l: RepLabel): boolean => l.verdicts.length > 0 || l.manual.length > 0 || l.normal;

/**
 * 어떤 전체 영상을 남기고, 어떤 반복을 클립으로 자르고, 어떤 전체 영상을 지울지 정한다(순수 함수).
 * - routineId별로 endedAt 최신 KEEP_FULL_SESSIONS개 세션의 영상은 keepFull.
 * - 그보다 오래된 세션의 영상은 deleteFull, 그중 지적(findings)이나 라벨이 붙은 반복은 toClip.
 * - fromMs/toMs는 그 세트 영상 안의 ms(= 반복 시각 ∓ 1초 − 영상 startedAt, 0 아래는 0).
 *   videoStartedAt에 없는 세트는 0으로 본다.
 * - 세션에 속하지 않는 영상 키는 건드리지 않는다.
 */
export function planRetention(
  sessions: WorkoutSession[],
  analyses: SetAnalysis[],
  labels: RepLabel[],
  videoKeys: SetKey[],
  videoStartedAt: ReadonlyMap<SetKey, number> = new Map(),
): RetentionPlan {
  const recent = new Set<string>();
  const byRoutine = new Map<string, WorkoutSession[]>();
  for (const s of sessions) byRoutine.set(s.routineId, [...(byRoutine.get(s.routineId) ?? []), s]);
  for (const list of byRoutine.values()) {
    list.sort((a, b) => b.endedAt - a.endedAt);
    for (const s of list.slice(0, KEEP_FULL_SESSIONS)) recent.add(s.id);
  }

  const have = new Set(videoKeys);
  const findingIdx = new Map<SetKey, Set<number>>();
  for (const a of analyses) findingIdx.set(a.key, new Set(a.findings.map((f) => f.index)));
  const labeledIdx = new Map<SetKey, Set<number>>();
  for (const l of labels) {
    if (!hasLabel(l)) continue;
    labeledIdx.set(l.setKey, (labeledIdx.get(l.setKey) ?? new Set()).add(l.index));
  }

  const plan: RetentionPlan = { keepFull: [], toClip: [], deleteFull: [] };
  for (const s of sessions) {
    for (const set of s.sets) {
      const key = setKey(s.id, set.exerciseIndex, set.setIndex);
      if (!have.has(key)) continue;
      if (recent.has(s.id)) {
        plan.keepFull.push(key);
        continue;
      }
      plan.deleteFull.push(key);
      const origin = videoStartedAt.get(key) ?? 0;
      for (const rep of [...(set.reps ?? [])].sort((a, b) => a.index - b.index)) {
        if (!findingIdx.get(key)?.has(rep.index) && !labeledIdx.get(key)?.has(rep.index)) continue;
        plan.toClip.push({
          setKey: key,
          index: rep.index,
          fromMs: Math.max(0, rep.startT - CLIP_PAD_MS - origin),
          toMs: Math.max(0, rep.endT + CLIP_PAD_MS - origin),
        });
      }
    }
  }
  return plan;
}

/**
 * 보관 규칙을 실제로 적용한다. 세션 최종 저장 뒤 한 번 부른다.
 * - 아직 분석이 없거나 일시 오류(reason 'error')로 실패한 오래된 세트는 건너뛴다(다시 분석할 영상을 지우면 안 된다).
 * - 클립이 이미 있으면 다시 자르지 않는다. 하나라도 못 만들면 그 세트의 전체 영상은 지우지 않고 다음에 다시 시도한다.
 * - 세트 하나가 실패해도 나머지는 계속한다.
 */
export async function applyRetention(deps: { storage: Storage; store: MediaStore; cutter: ClipCutter }): Promise<void> {
  const { storage, store, cutter } = deps;
  const [sessions, videoKeys] = await Promise.all([storage.listSessions(), store.listVideoKeys()]);
  const first = planRetention(sessions, [], [], videoKeys);
  if (first.deleteFull.length === 0) return;

  const oldKeys = new Set(first.deleteFull);
  const oldSessions = sessions.filter((s) => s.sets.some((set) => oldKeys.has(setKey(s.id, set.exerciseIndex, set.setIndex))));
  const analyses = (await Promise.all(oldSessions.map((s) => store.listAnalyses(s.id)))).flat();
  const labels = (await Promise.all(oldSessions.map((s) => store.listLabels(s.id)))).flat();
  // 끝난 분석(done)이나 다시 해도 결과가 같은 실패(noPerson·noVideo)만 '분석됨'으로 본다
  const analyzed = new Set(analyses.filter(isSettled).map((a) => a.key));

  // 영상 안 시각으로 바꾸려면 각 영상의 startedAt이 필요하다(blob은 쥐고 있지 않는다)
  const startedAt = new Map<SetKey, number>();
  for (const key of first.deleteFull) {
    if (!analyzed.has(key)) continue;
    const v = await store.getVideo(key);
    if (v) startedAt.set(key, v.startedAt);
  }
  const plan = planRetention(sessions, analyses, labels, videoKeys, startedAt);

  for (const key of plan.deleteFull) {
    if (!analyzed.has(key)) continue;
    try {
      const video = await store.getVideo(key);
      if (!video) continue;
      const have = new Set((await store.listClips(key)).map((c) => c.index));
      let complete = true;
      for (const c of plan.toClip.filter((p) => p.setKey === key)) {
        if (have.has(c.index)) continue;
        const out = await cutter.cut(video, c.fromMs, c.toMs);
        if (!out) {
          complete = false;
          continue;
        }
        await store.putClip({
          key: `${key}#${c.index}`,
          setKey: key,
          index: c.index,
          startedAt: video.startedAt + c.fromMs,
          mimeType: out.mimeType,
          blob: out.blob,
        });
      }
      if (complete) await store.deleteVideo(key);
    } catch (e) {
      console.warn('영상 정리 실패', key, e);
    }
  }
}
