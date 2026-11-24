import { useCallback, useEffect, useRef, useState } from 'react';
import { HALPE, type KpFrame, type WorkoutSession } from '@wom/core';
import type { ManualErrorKind, RepLabel, SetKey } from '../form/types';
import type { MediaStore } from '../ports/mediaStore';
import type { Storage } from '../ports/storage';

export type RepPlayerProps = {
  store: MediaStore;
  storage: Storage;
  sessionId: string;
  setKey: SetKey;
  index: number;
  onBack: () => void;
};

type Source = { blob: Blob; startedAt: number };

const MANUAL_KINDS: { kind: ManualErrorKind; label: string }[] = [
  { kind: 'depth', label: '깊이 부족' },
  { kind: 'kneeIn', label: '무릎 모임' },
  { kind: 'heel', label: '뒤꿈치 들림' },
  { kind: 'trunkLean', label: '상체 과다 숙임' },
  { kind: 'lumbarFlexion', label: '허리 말림' },
  { kind: 'bounce', label: '반동' },
  { kind: 'other', label: '기타' },
];

const LEAD_MS = 1000;
const FRAME_TOLERANCE_MS = 100;
const MIN_SCORE = 0.3;
const S = { L_SHOULDER: 5, R_SHOULDER: 6 };
/** 엉덩이·무릎·발목·엄지발가락·뒤꿈치·어깨 */
const BONES: [number, number][] = [
  [S.L_SHOULDER, S.R_SHOULDER],
  [S.L_SHOULDER, HALPE.L_HIP],
  [S.R_SHOULDER, HALPE.R_HIP],
  [HALPE.L_HIP, HALPE.R_HIP],
  [HALPE.L_HIP, HALPE.L_KNEE],
  [HALPE.L_KNEE, HALPE.L_ANKLE],
  [HALPE.R_HIP, HALPE.R_KNEE],
  [HALPE.R_KNEE, HALPE.R_ANKLE],
  [HALPE.L_ANKLE, HALPE.L_BIG_TOE],
  [HALPE.L_ANKLE, HALPE.L_HEEL],
  [HALPE.L_HEEL, HALPE.L_BIG_TOE],
  [HALPE.R_ANKLE, HALPE.R_BIG_TOE],
  [HALPE.R_ANKLE, HALPE.R_HEEL],
  [HALPE.R_HEEL, HALPE.R_BIG_TOE],
];

/** `${sessionId}/${exerciseIndex}/${setIndex}`에서 뒤의 두 숫자 */
function parseKey(key: SetKey): [number, number] {
  const p = key.split('/');
  return [Number(p[p.length - 2]), Number(p[p.length - 1])];
}

function nearestFrame(frames: KpFrame[], t: number): KpFrame | null {
  let best: KpFrame | null = null;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.t - t);
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best && bestD <= FRAME_TOLERANCE_MS ? best : null;
}

function drawSkeleton(ctx: CanvasRenderingContext2D, w: number, h: number, frame: KpFrame | null): void {
  ctx.clearRect(0, 0, w, h);
  const k = frame?.kps;
  if (!k) return;
  const ok = (i: number) => {
    const p = k[i];
    return p !== undefined && p.score >= MIN_SCORE;
  };
  ctx.lineWidth = Math.max(3, w / 120);
  ctx.strokeStyle = 'rgba(120, 220, 255, 0.9)';
  ctx.beginPath();
  for (const [a, b] of BONES) {
    if (!ok(a) || !ok(b)) continue;
    ctx.moveTo(k[a]!.x, k[a]!.y);
    ctx.lineTo(k[b]!.x, k[b]!.y);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  const r = Math.max(4, w / 160);
  for (const [a, b] of BONES) {
    for (const i of [a, b]) {
      if (!ok(i)) continue;
      ctx.beginPath();
      ctx.arc(k[i]!.x, k[i]!.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 한 반복의 영상 재생(시작 1초 전부터), 관절 선 겹치기, 직접 라벨. */
export function RepPlayer({ store, storage, sessionId, setKey: key, index, onBack }: RepPlayerProps) {
  const [cur, setCur] = useState(index);
  const [session, setSession] = useState<WorkoutSession | null | undefined>(undefined);
  const [video, setVideo] = useState<Source | null | undefined>(undefined);
  const [clips, setClips] = useState<Map<number, Source>>(new Map());
  const [frames, setFrames] = useState<KpFrame[]>([]);
  const [labels, setLabels] = useState<Map<string, RepLabel>>(new Map());
  const [overlay, setOverlay] = useState(false);
  const [slow, setSlow] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 저장이 끝나기 전 연속 클릭에도 최신 라벨을 합치려고 렌더 밖에서 들고 있는다 */
  const labelsRef = useRef<Map<string, RepLabel>>(new Map());

  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, v, cs, a, ls] = await Promise.all([
        storage.getSession(sessionId),
        store.getVideo(key),
        store.listClips(key),
        store.getAnalysis(key),
        store.listLabels(sessionId),
      ]);
      if (!alive) return;
      const map = new Map(ls.map((l) => [l.key, l]));
      labelsRef.current = map;
      setLabels(map);
      setSession(s);
      setVideo(v ? { blob: v.blob, startedAt: v.startedAt } : null);
      setClips(new Map(cs.map((c) => [c.index, { blob: c.blob, startedAt: c.startedAt }])));
      setFrames(a?.frames ?? []);
    })().catch((e) => {
      console.warn('재생 자료 읽기 실패', e);
      if (alive) {
        setSession(null);
        setVideo(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [store, storage, sessionId, key]);

  const [exerciseIndex, setIndex] = parseKey(key);
  const reps = [...(session?.sets.find((s) => s.exerciseIndex === exerciseIndex && s.setIndex === setIndex)?.reps ?? [])].sort((a, b) => a.index - b.index);
  const pos = reps.findIndex((r) => r.index === cur);
  const rep = pos >= 0 ? reps[pos] : undefined;
  const source = video ?? clips.get(cur) ?? null;
  const loading = session === undefined || video === undefined;
  const startSec = rep && source ? Math.max(0, (rep.startT - LEAD_MS - source.startedAt) / 1000) : 0;
  const blob = source?.blob ?? null;

  // blob마다 objectURL을 만들고 바뀌거나 언마운트되면 revoke
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  // 반복이 바뀌거나 영상이 준비되면 그 반복 시작 1초 전으로 이동
  const seek = useCallback(() => {
    const v = videoRef.current;
    if (v) v.currentTime = startSec;
  }, [startSec]);
  useEffect(() => {
    seek();
  }, [seek, url]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = slow ? 0.5 : 1;
  }, [slow, url]);

  // 관절 선: 재생 시각에 가장 가까운 프레임을 그린다(2D context가 없으면 조용히 건너뜀)
  const base = source?.startedAt ?? 0;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (v.videoWidth > 0 && (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight)) {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
        }
        drawSkeleton(ctx, canvas.width, canvas.height, nearestFrame(frames, base + v.currentTime * 1000));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [overlay, frames, base, url]);

  const labelKey = `${key}#${cur}`;
  const label = labels.get(labelKey);

  const save = (change: Partial<Pick<RepLabel, 'manual' | 'normal' | 'note'>>) => {
    const old = labelsRef.current.get(labelKey);
    const next: RepLabel = {
      key: labelKey,
      sessionId,
      setKey: key,
      index: cur,
      verdicts: old?.verdicts ?? [],
      manual: old?.manual ?? [],
      normal: old?.normal ?? false,
      note: old?.note ?? '',
      updatedAt: Date.now(),
      ...change,
    };
    const apply = (l: RepLabel | undefined) => {
      const m = new Map(labelsRef.current);
      if (l) m.set(labelKey, l);
      else m.delete(labelKey);
      labelsRef.current = m;
      setLabels(m);
    };
    setSaveError(false);
    apply(next);
    store.putLabel(next).catch((e) => {
      console.warn('라벨 저장 실패', e);
      apply(old);
      setSaveError(true);
    });
  };

  const toggleKind = (kind: ManualErrorKind) => {
    const has = label?.manual.includes(kind) ?? false;
    const manual = has ? (label?.manual ?? []).filter((k) => k !== kind) : [...(label?.manual ?? []), kind];
    save({ manual, normal: false });
  };
  const markNormal = () => {
    if (label?.normal) save({ normal: false });
    else save({ normal: true, manual: [] });
  };

  const go = (d: number) => {
    const t = reps[pos + d];
    if (t) {
      setCur(t.index);
      setShowManual(false);
      setSaveError(false);
    }
  };

  const problemOpen = showManual || (label?.manual.length ?? 0) > 0;

  let stage;
  if (loading) stage = <p className="player-status">불러오는 중…</p>;
  else if (!source) stage = <p className="player-status">영상이 삭제됐어요(오래된 기록은 지적 구간만 보관)</p>;
  else
    stage = (
      <div className="player-stage">
        {url && <video ref={videoRef} className="player-video" src={url} controls playsInline muted onLoadedMetadata={seek} />}
        {overlay && <canvas ref={canvasRef} className="player-overlay" width={480} height={640} aria-hidden="true" />}
      </div>
    );

  return (
    <main className="app rep-player">
      <h1 className="app-title">{rep ? `${cur}번째 반복` : '반복 다시 보기'}</h1>
      {stage}
      <div className="player-controls">
        <button type="button" onClick={() => go(-1)} disabled={pos <= 0}>
          이전 반복
        </button>
        <button type="button" onClick={() => go(1)} disabled={pos < 0 || pos >= reps.length - 1}>
          다음 반복
        </button>
        <button type="button" aria-pressed={slow} onClick={() => setSlow((s) => !s)}>
          0.5배 느리게 보기
        </button>
        {frames.length > 0 && (
          <button type="button" aria-pressed={overlay} onClick={() => setOverlay((o) => !o)}>
            관절 선 보기
          </button>
        )}
      </div>
      <section className="player-label" aria-label="직접 라벨">
        <div className="player-controls">
          <button type="button" aria-pressed={problemOpen} onClick={() => setShowManual((s) => !s)}>
            이 반복에 문제가 있어요
          </button>
          <button type="button" aria-pressed={label?.normal === true} onClick={markNormal}>
            이 반복은 정상
          </button>
        </div>
        {problemOpen && (
          <div className="player-kinds">
            {MANUAL_KINDS.map((m) => (
              <button key={m.kind} type="button" aria-pressed={label?.manual.includes(m.kind) === true} onClick={() => toggleKind(m.kind)}>
                {m.label}
              </button>
            ))}
            {label?.manual.includes('other') && (
              <textarea
                key={labelKey}
                className="player-note"
                aria-label="메모"
                defaultValue={label.note}
                onBlur={(e) => {
                  if (e.target.value !== (labelsRef.current.get(labelKey)?.note ?? '')) save({ note: e.target.value });
                }}
              />
            )}
          </div>
        )}
        {saveError && (
          <p className="form-error" role="alert">
            저장하지 못했어요
          </p>
        )}
      </section>
      <div className="home-footer">
        <button type="button" onClick={onBack}>
          돌아가기
        </button>
      </div>
    </main>
  );
}
