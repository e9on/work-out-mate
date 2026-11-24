import { useCallback, useEffect, useRef, useState } from 'react';
import type { FindingKind, WorkoutSession } from '@wom/core';
import type { AnalysisQueue } from '../form/analysisQueue';
import type { RepLabel, SetAnalysis, SetKey } from '../form/types';
import type { MediaStore } from '../ports/mediaStore';
import { EXERCISE_NAMES } from '../domain/validate';
import { FINDING_PHRASES, NO_FINDINGS, REASON_PHRASES, analyzingText, findingLine, notePhrase } from '../domain/formPhrases';

export type FormFindingsProps = {
  store: MediaStore;
  queue?: AnalysisQueue;
  sessionId: string;
  session: WorkoutSession;
  onPlay?: (setKey: SetKey, index: number) => void;
};

type Data = {
  analyses: SetAnalysis[];
  labels: Map<string, RepLabel>;
  videoTotal: number;
  videoStart: Map<SetKey, number>;
};

/** `${sessionId}/${exerciseIndex}/${setIndex}`에서 뒤의 두 숫자 */
function parseKey(key: SetKey): [number, number] {
  const p = key.split('/');
  return [Number(p[p.length - 2]), Number(p[p.length - 1])];
}

/** 자세 분석 지적 목록. 녹화를 켜지 않은 세션은 아무것도 그리지 않는다. */
export function FormFindings({ store, queue, sessionId, session, onPlay }: FormFindingsProps) {
  const [data, setData] = useState<Data | null>(null);
  const [saveError, setSaveError] = useState(false);
  /** 저장이 끝나기 전 연속 클릭에도 최신 라벨을 합치려고 렌더 밖에서 들고 있는다 */
  const labelsRef = useRef<Map<string, RepLabel>>(new Map());

  const load = useCallback(async (): Promise<Data | null> => {
    const meta = await store.getCaptureMeta(sessionId);
    if (!meta || !meta.videoEnabled) return null;
    const [analyses, labels, keys] = await Promise.all([store.listAnalyses(sessionId), store.listLabels(sessionId), store.listVideoKeys()]);
    const mine = keys.filter((k) => k.startsWith(`${sessionId}/`));
    const videoStart = new Map<SetKey, number>();
    for (const k of mine) {
      const v = await store.getVideo(k);
      if (v) videoStart.set(k, v.startedAt);
    }
    const sorted = [...analyses].sort((a, b) => {
      const [ae, as] = parseKey(a.key);
      const [be, bs] = parseKey(b.key);
      return ae - be || as - bs;
    });
    return { analyses: sorted, labels: new Map(labels.map((l) => [l.key, l])), videoTotal: mine.length, videoStart };
  }, [store, sessionId]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      load().then(
        (d) => {
          if (!alive) return;
          if (d) labelsRef.current = d.labels;
          setData(d);
        },
        () => undefined,
      );
    };
    refresh();
    const off = queue?.onProgress((sid) => {
      if (sid === sessionId) refresh();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [load, queue, sessionId]);

  if (!data) return null;

  const videoKeys = new Set(data.videoStart.keys());
  const done = data.analyses.filter((a) => videoKeys.has(a.key)).length;

  const vote = (a: SetAnalysis, index: number, kind: FindingKind, agree: boolean) => {
    const key = `${a.key}#${index}`;
    const old = labelsRef.current.get(key);
    const label: RepLabel = {
      key,
      sessionId,
      setKey: a.key,
      index,
      verdicts: [...(old?.verdicts ?? []).filter((v) => v.kind !== kind), { kind, agree }],
      manual: old?.manual ?? [],
      normal: old?.normal ?? false,
      note: old?.note ?? '',
      updatedAt: Date.now(),
    };
    const apply = (l: RepLabel | undefined) => {
      const next = new Map(labelsRef.current);
      if (l) next.set(key, l);
      else next.delete(key);
      labelsRef.current = next;
      setData((d) => (d ? { ...d, labels: next } : d));
    };
    setSaveError(false);
    apply(label);
    store.putLabel(label).catch((e) => {
      console.warn('라벨 저장 실패', e);
      // 그 사이 같은 반복의 다른 지적에 판정이 더해졌을 수 있어 이 지적의 판정만 되돌린다
      const cur = labelsRef.current.get(key);
      const rest = (cur?.verdicts ?? []).filter((v) => v.kind !== kind);
      const before = old?.verdicts.find((v) => v.kind === kind);
      const verdicts = before ? [...rest, before] : rest;
      apply(cur && (verdicts.length > 0 || old) ? { ...cur, verdicts } : undefined);
      setSaveError(true);
    });
  };

  const sections = data.analyses.map((a) => {
    const [exerciseIndex, setIndex] = parseKey(a.key);
    const log = session.sets.find((s) => s.exerciseIndex === exerciseIndex && s.setIndex === setIndex);
    const setTitle = log
      ? `${EXERCISE_NAMES[log.exercise]} ${setIndex + 1}세트  ${log.count}회${log.endReason === 'target' ? '  ✓ 목표 달성' : ''}`
      : `${setIndex + 1}세트`;
    const videoStart = data.videoStart.get(a.key);
    const findings = [...a.findings].sort((x, y) => x.index - y.index);
    let body;
    if (a.status === 'failed') {
      body = <p className="form-reason">{a.reason ? REASON_PHRASES[a.reason] : REASON_PHRASES.error}</p>;
    } else if (findings.length === 0 && a.notes.length === 0) {
      body = <p className="form-none">{NO_FINDINGS}</p>;
    } else {
      body = (
        <>
          {findings.map((f) => {
            const startT = log?.reps?.find((r) => r.index === f.index)?.startT;
            const offset = startT !== undefined && videoStart !== undefined ? (startT - videoStart) / 1000 : null;
            const verdict = data.labels.get(`${a.key}#${f.index}`)?.verdicts.find((v) => v.kind === f.kind);
            return (
              <div className="form-finding" key={`${f.index}-${f.kind}`}>
                <span className="form-icon" aria-hidden="true">⚠</span>
                <span className="form-finding-text">{findingLine(f.index, offset, FINDING_PHRASES[f.kind])}</span>
                {onPlay && videoStart !== undefined && (
                  <button type="button" className="form-play" aria-label={`${f.index}번째 다시 보기`} onClick={() => onPlay(a.key, f.index)}>
                    ▶
                  </button>
                )}
                <button type="button" className="form-vote" aria-pressed={verdict?.agree === true} onClick={() => vote(a, f.index, f.kind, true)}>
                  맞아요
                </button>
                <button type="button" className="form-vote" aria-pressed={verdict?.agree === false} onClick={() => vote(a, f.index, f.kind, false)}>
                  틀려요
                </button>
              </div>
            );
          })}
          {a.notes.map((n) => (
            <p className="form-note" key={n.kind}>
              <span className="form-icon" aria-hidden="true">ⓘ</span> {notePhrase(n)}
            </p>
          ))}
        </>
      );
    }
    return (
      <div className="form-set" key={a.key}>
        <h3 className="form-set-title">{setTitle}</h3>
        {body}
      </div>
    );
  });

  return (
    <section className="form-findings" aria-label="자세 분석">
      <h2 className="form-title">자세 분석</h2>
      {done < data.videoTotal && <p className="form-progress">{analyzingText(done, data.videoTotal)}</p>}
      {saveError && <p className="form-error" role="alert">저장하지 못했어요</p>}
      {sections}
    </section>
  );
}
