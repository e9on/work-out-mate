import type { FindingKind, KpFrame, RepTiming, SquatRepMetrics } from '@wom/core';
import type { MediaStore } from '../ports/mediaStore';
import type { Storage } from '../ports/storage';
import { setKey, type RepLabel } from './types';

export type ExportRow = {
  source: 'own-app';
  consentAgreed: true;
  consentVersion: string;
  exercise: 'squat';
  sessionId: string;
  recordedAt: number;
  exerciseIndex: number;
  setIndex: number;
  index: number;
  rep: RepTiming;
  cameraAngle: '45deg';
  model: 'rtmpose-m-halpe26';
  appVersion: string;
  /** 반복 [startT-500, endT+500] 구간의 관절점 */
  frames: KpFrame[];
  metrics: SquatRepMetrics;
  findings: FindingKind[];
  uncertain: boolean;
  label: Omit<RepLabel, 'key' | 'sessionId' | 'setKey'> | null;
};

export interface ExportFile {
  /** 저장하고, 저장 위치를 한국어로 설명해 돌려준다 */
  save(name: string, text: string): Promise<string>;
}

const PAD_MS = 500;
const NOTHING = '내보낼 기록이 없어요';
const FAILED = '내보내지 못했어요. 다시 시도해 주세요.';

export async function buildExportRows(deps: { storage: Storage; store: MediaStore; appVersion: string }): Promise<ExportRow[]> {
  const { storage, store, appVersion } = deps;
  const rows: ExportRow[] = [];
  for (const session of await storage.listSessions()) {
    const meta = await store.getCaptureMeta(session.id);
    if (!meta || meta.consentAgreed !== true) continue;
    const analyses = new Map((await store.listAnalyses(session.id)).map((a) => [a.key, a]));
    const labels = new Map((await store.listLabels(session.id)).map((l) => [l.key, l]));
    for (const set of session.sets) {
      if (set.exercise !== 'squat' || !set.reps) continue;
      const key = setKey(session.id, set.exerciseIndex, set.setIndex);
      const analysis = analyses.get(key);
      if (!analysis || analysis.status !== 'done') continue;
      for (const rep of set.reps) {
        const metrics = analysis.metrics.find((m) => m.index === rep.index);
        if (!metrics) continue;
        const l = labels.get(`${key}#${rep.index}`);
        let label: ExportRow['label'] = null;
        if (l) {
          const { key: _k, sessionId: _s, setKey: _sk, ...rest } = l;
          label = rest;
        }
        rows.push({
          source: 'own-app',
          consentAgreed: true,
          consentVersion: meta.consentVersion ?? '',
          exercise: 'squat',
          sessionId: session.id,
          recordedAt: session.startedAt,
          exerciseIndex: set.exerciseIndex,
          setIndex: set.setIndex,
          index: rep.index,
          rep,
          cameraAngle: '45deg',
          model: analysis.model,
          appVersion,
          frames: analysis.frames.filter((f) => f.t >= rep.startT - PAD_MS && f.t <= rep.endT + PAD_MS),
          metrics,
          findings: analysis.findings.filter((f) => f.index === rep.index).map((f) => f.kind),
          uncertain: analysis.uncertain.includes(rep.index),
          label,
        });
      }
    }
  }
  return rows;
}

/** 한 줄에 한 행(JSON Lines). 행이 있으면 끝에 줄바꿈이 붙는다. */
export function toJsonl(rows: ExportRow[]): string {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join('');
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function exportFileName(d: Date): string {
  return `wom-train-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.jsonl`;
}

/** 내보내기 한 번. 화면에 보여 줄 한국어 결과 문구를 돌려준다(예외를 던지지 않는다). */
export async function runExport(deps: {
  storage: Storage;
  store: MediaStore;
  appVersion: string;
  file: ExportFile;
  now?: () => Date;
}): Promise<string> {
  try {
    const rows = await buildExportRows(deps);
    if (rows.length === 0) return NOTHING;
    const where = await deps.file.save(exportFileName((deps.now ?? (() => new Date()))()), toJsonl(rows));
    return `${rows.length}개 반복을 내보냈어요. ${where}`;
  } catch {
    return FAILED;
  }
}
