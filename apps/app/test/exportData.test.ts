import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KpFrame, SetLog, WorkoutSession } from '@wom/core';
import { buildExportRows, exportFileName, runExport, toJsonl, type ExportFile } from '../src/form/exportData';
import { setKey, type RepLabel, type SetAnalysis } from '../src/form/types';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { createMemoryStorage } from '../src/storage/memoryStorage';

const frame = (t: number): KpFrame => ({ t, kps: [] }) as unknown as KpFrame;

function mkSession(id: string, startedAt: number): WorkoutSession {
  const set = {
    exercise: 'squat', exerciseIndex: 0, setIndex: 0, startT: startedAt, endT: startedAt + 30_000, count: 2, heldMs: 0,
    negativeDescentMs: [], endReason: 'button', restTakenMs: null, target: { kind: 'reps', value: 2 },
    reps: [
      { index: 0, startT: 1000, bottomT: 1500, endT: 2000 },
      { index: 1, startT: 5000, bottomT: 5500, endT: 6000 },
    ],
  } as unknown as SetLog;
  return { id, routineId: 'r', routineName: '루틴', startedAt, endedAt: startedAt + 40_000, completed: true, sets: [set] };
}

const analysis = (sid: string, uncertain: number[] = []): SetAnalysis => ({
  key: setKey(sid, 0, 0), sessionId: sid, status: 'done', reason: null,
  metrics: [0, 1].map((index) => ({ index, bottomT: 0, kneeDeg: 90, kneeAnkleRatio: 1, heelRise: 0, descentMs: 500, skipped: null })),
  findings: [{ index: 1, kind: 'depth', value: 1 }], notes: [], uncertain,
  frames: [0, 400, 499, 500, 2000, 2500, 2501, 4400, 4500, 6500, 6501].map(frame),
  model: 'rtmpose-m-halpe26', analyzedAt: 1,
});

async function seed(opts: { agreed?: boolean | null; sid?: string; startedAt?: number; uncertain?: number[] } = {}) {
  const { agreed = true, sid = 's1', startedAt = 1_000_000, uncertain = [] } = opts;
  const storage = createMemoryStorage();
  const store = createMemoryMediaStore();
  await storage.saveSession(mkSession(sid, startedAt));
  await store.putAnalysis(analysis(sid, uncertain));
  if (agreed !== null) await store.putCaptureMeta({ sessionId: sid, videoEnabled: true, consentAgreed: agreed, consentVersion: agreed ? 'v1' : null });
  return { storage, store };
}

afterEach(() => vi.restoreAllMocks());

describe('buildExportRows', () => {
  it('동의한 세션의 반복만 행으로 만든다', async () => {
    const { storage, store } = await seed();
    const rows = await buildExportRows({ storage, store, appVersion: '1.2.3' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'own-app', consentAgreed: true, consentVersion: 'v1', exercise: 'squat', sessionId: 's1', recordedAt: 1_000_000,
      exerciseIndex: 0, setIndex: 0, index: 0, cameraAngle: '45deg', model: 'rtmpose-m-halpe26', appVersion: '1.2.3',
      rep: { index: 0, startT: 1000, bottomT: 1500, endT: 2000 }, findings: [], uncertain: false, label: null,
    });
    expect(rows[0]!.metrics.index).toBe(0);
    expect(rows[1]!.findings).toEqual(['depth']);
  });

  it('동의를 끈 세션이나 메타 없는 세션은 빠진다', async () => {
    const a = await seed({ agreed: false });
    expect(await buildExportRows({ ...a, appVersion: 'x' })).toEqual([]);
    const b = await seed({ agreed: null });
    expect(await buildExportRows({ ...b, appVersion: 'x' })).toEqual([]);
    // 같은 저장소에 동의 세션과 비동의 세션이 섞여 있으면 동의한 것만
    const { storage, store } = await seed({ sid: 'on' });
    await storage.saveSession(mkSession('off', 2_000_000));
    await store.putAnalysis(analysis('off'));
    await store.putCaptureMeta({ sessionId: 'off', videoEnabled: true, consentAgreed: false, consentVersion: 'v1' });
    const rows = await buildExportRows({ storage, store, appVersion: 'x' });
    expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set(['on']));
  });

  it('frames는 반복 앞뒤 500ms만 담는다', async () => {
    const { storage, store } = await seed();
    const rows = await buildExportRows({ storage, store, appVersion: 'x' });
    expect(rows[0]!.frames.map((f) => f.t)).toEqual([500, 2000, 2500]);
    expect(rows[1]!.frames.map((f) => f.t)).toEqual([4500, 6500]);
  });

  it('uncertain과 label을 반영한다(label 없으면 null)', async () => {
    const { storage, store } = await seed({ uncertain: [1] });
    const l: RepLabel = {
      key: `${setKey('s1', 0, 0)}#1`, sessionId: 's1', setKey: setKey('s1', 0, 0), index: 1,
      verdicts: [{ kind: 'depth', agree: true }], manual: ['heel'], normal: false, note: '메모', updatedAt: 9,
    };
    await store.putLabel(l);
    const rows = await buildExportRows({ storage, store, appVersion: 'x' });
    expect(rows[0]).toMatchObject({ uncertain: false, label: null });
    expect(rows[1]!.uncertain).toBe(true);
    expect(rows[1]!.label).toEqual({ index: 1, verdicts: [{ kind: 'depth', agree: true }], manual: ['heel'], normal: false, note: '메모', updatedAt: 9 });
    expect(rows[1]!.label).not.toHaveProperty('key');
    expect(rows[1]!.label).not.toHaveProperty('sessionId');
    expect(rows[1]!.label).not.toHaveProperty('setKey');
  });

  it('스쿼트가 아닌 세트는 건너뛴다', async () => {
    const { storage, store } = await seed();
    const s = mkSession('s2', 3_000_000);
    (s.sets[0] as { exercise: string }).exercise = 'pushup';
    await storage.saveSession(s);
    await store.putAnalysis(analysis('s2'));
    await store.putCaptureMeta({ sessionId: 's2', videoEnabled: true, consentAgreed: true, consentVersion: 'v1' });
    const rows = await buildExportRows({ storage, store, appVersion: 'x' });
    expect(rows.every((r) => r.sessionId === 's1')).toBe(true);
  });
});

describe('toJsonl', () => {
  it('한 줄에 한 행, 끝에 줄바꿈', async () => {
    const { storage, store } = await seed();
    const rows = await buildExportRows({ storage, store, appVersion: 'x' });
    const text = toJsonl(rows);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(JSON.stringify(rows[0])));
    expect(toJsonl([])).toBe('');
  });
});

describe('exportFileName', () => {
  it('wom-train-YYYYMMDD-HHMMSS.jsonl', () => {
    expect(exportFileName(new Date(2026, 10, 24, 9, 5, 7))).toBe('wom-train-20261124-090507.jsonl');
  });
});

describe('runExport', () => {
  it('내보내는 동안 fetch를 부르지 않고, 파일에 저장한 뒤 저장 위치를 돌려준다', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { storage, store } = await seed();
      const save = vi.fn(async (_name: string, _text: string) => '문서 폴더 Documents/x');
      const file: ExportFile = { save };
      const msg = await runExport({ storage, store, appVersion: 'x', file, now: () => new Date(2026, 10, 24, 9, 5, 7) });
      expect(msg).toContain('문서 폴더 Documents/x');
      expect(save).toHaveBeenCalledTimes(1);
      const [name, text] = save.mock.calls[0]!;
      expect(name).toBe('wom-train-20261124-090507.jsonl');
      expect(text.trim().split('\n')).toHaveLength(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('내보낼 기록이 없으면 저장하지 않고 안내한다', async () => {
    const save = vi.fn();
    const msg = await runExport({ storage: createMemoryStorage(), store: createMemoryMediaStore(), appVersion: 'x', file: { save } });
    expect(msg).toBe('내보낼 기록이 없어요');
    expect(save).not.toHaveBeenCalled();
  });

  it('저장이 실패하면 실패 문구', async () => {
    const { storage, store } = await seed();
    const msg = await runExport({
      storage,
      store,
      appVersion: 'x',
      file: {
        save: async () => {
          throw new Error('x');
        },
      },
    });
    expect(msg).toBe('내보내지 못했어요. 다시 시도해 주세요.');
  });
});
