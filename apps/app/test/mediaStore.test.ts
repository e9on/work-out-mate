import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, setKey, type RepLabel, type SetAnalysis, type SetVideo, type VideoClip } from '../src/form/types';
import type { MediaStore } from '../src/ports/mediaStore';
import { createIdbMediaStore } from '../src/storage/idbMediaStore';
import { createIdbStorage } from '../src/storage/idbStorage';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';

// jsdom의 Blob은 Node structuredClone(fake-indexeddb가 씀)이 복사하지 못해 빈 객체가 된다.
// 실제 브라우저는 Blob을 복사하므로, 테스트에서는 Node 기본 Blob을 쓴다.
const makeBlob = (bytes: number, type = ''): Blob => new NodeBlob([new Uint8Array(bytes)], { type }) as unknown as Blob;

const video = (sessionId: string, ex: number, set: number, bytes: number): SetVideo => ({
  key: setKey(sessionId, ex, set),
  sessionId,
  routineId: 'r1',
  exerciseIndex: ex,
  setIndex: set,
  startedAt: 1000,
  mimeType: 'video/webm',
  blob: makeBlob(bytes, 'video/webm'),
  boxes: [{ t: 0, box: [0.1, 0.1, 0.9, 0.9] }],
});
const clip = (sk: string, index: number, bytes: number): VideoClip => ({
  key: `${sk}#${index}`,
  setKey: sk,
  index,
  startedAt: 5,
  mimeType: 'video/webm',
  blob: makeBlob(bytes),
});
const analysis = (sessionId: string, ex: number, set: number): SetAnalysis => ({
  key: setKey(sessionId, ex, set),
  sessionId,
  status: 'done',
  reason: null,
  metrics: [],
  findings: [],
  notes: [],
  uncertain: [1],
  frames: [],
  model: 'rtmpose-m-halpe26',
  analyzedAt: 9,
});
const label = (sessionId: string, sk: string, index: number): RepLabel => ({
  key: `${sk}#${index}`,
  sessionId,
  setKey: sk,
  index,
  verdicts: [{ kind: 'depth', agree: true }],
  manual: ['heel'],
  normal: false,
  note: '메모',
  updatedAt: 3,
});

let dbSeq = 0;
const makers: [string, () => MediaStore][] = [
  ['idb', () => createIdbMediaStore(`media-db-${dbSeq++}`)],
  ['memory', () => createMemoryMediaStore()],
];

describe.each(makers)('MediaStore (%s)', (_n, make) => {
  let m: MediaStore;
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    m = make();
  });

  it('영상 저장·읽기·목록·삭제', async () => {
    await m.putVideo(video('s1', 0, 0, 10));
    await m.putVideo(video('s1', 0, 1, 20));
    const got = await m.getVideo('s1/0/0');
    expect(got?.blob.size).toBe(10);
    expect(got?.boxes).toEqual([{ t: 0, box: [0.1, 0.1, 0.9, 0.9] }]);
    expect(await m.listVideoKeys()).toEqual(['s1/0/0', 's1/0/1']);
    await m.deleteVideo('s1/0/0');
    expect(await m.getVideo('s1/0/0')).toBeNull();
    expect(await m.listVideoKeys()).toEqual(['s1/0/1']);
  });

  it('클립은 세트별로 index 순 목록이고 세트 단위로 지운다', async () => {
    await m.putClip(clip('s1/0/0', 1, 5));
    await m.putClip(clip('s1/0/0', 0, 5));
    await m.putClip(clip('s1/0/1', 0, 5));
    expect((await m.listClips('s1/0/0')).map((c) => c.index)).toEqual([0, 1]);
    expect((await m.getClip('s1/0/1#0'))?.blob.size).toBe(5);
    await m.deleteClipsOfSet('s1/0/0');
    expect(await m.listClips('s1/0/0')).toEqual([]);
    expect(await m.listClips('s1/0/1')).toHaveLength(1);
    expect(await m.getClip('none')).toBeNull();
  });

  it('분석 저장·읽기·세션별 목록', async () => {
    await m.putAnalysis(analysis('s1', 0, 0));
    await m.putAnalysis(analysis('s1', 0, 1));
    await m.putAnalysis(analysis('s2', 0, 0));
    expect((await m.getAnalysis('s1/0/1'))?.uncertain).toEqual([1]);
    expect(await m.getAnalysis('none')).toBeNull();
    expect((await m.listAnalyses('s1')).map((a) => a.key)).toEqual(['s1/0/0', 's1/0/1']);
  });

  it('라벨은 같은 key를 덮어쓰고 세션별로 나온다', async () => {
    await m.putLabel(label('s1', 's1/0/0', 0));
    await m.putLabel({ ...label('s1', 's1/0/0', 0), note: '바뀜' });
    await m.putLabel(label('s2', 's2/0/0', 0));
    const l = await m.listLabels('s1');
    expect(l).toHaveLength(1);
    expect(l[0]!.note).toBe('바뀜');
  });

  it('녹화 메타 왕복', async () => {
    expect(await m.getCaptureMeta('s1')).toBeNull();
    const meta = { sessionId: 's1', videoEnabled: true, consentAgreed: true, consentVersion: 'v1' };
    await m.putCaptureMeta(meta);
    expect(await m.getCaptureMeta('s1')).toEqual(meta);
  });

  it('설정 기본값과 왕복', async () => {
    expect(await m.getSettings()).toEqual(DEFAULT_SETTINGS);
    const s = { videoEnabled: true, consent: { agreed: true, version: 'v1', at: 7 }, guideSeen: 2 };
    await m.putSettings(s);
    expect(await m.getSettings()).toEqual(s);
  });

  it('usageBytes는 영상·클립 blob 크기 합이다', async () => {
    expect(await m.usageBytes()).toBe(0);
    await m.putVideo(video('s1', 0, 0, 100));
    await m.putVideo(video('s1', 0, 1, 50));
    await m.putClip(clip('s1/0/0', 0, 7));
    expect(await m.usageBytes()).toBe(157);
    await m.deleteVideo('s1/0/0');
    expect(await m.usageBytes()).toBe(57);
  });
});

describe('DB 버전 2 업그레이드', () => {
  it('버전 1 DB의 루틴·세션이 업그레이드 뒤에도 남는다', async () => {
    globalThis.indexedDB = new IDBFactory();
    const old = await openDB('upg-db', 1, {
      upgrade(d) {
        d.createObjectStore('routines', { keyPath: 'id' });
        d.createObjectStore('sessions', { keyPath: 'id' }).createIndex('endedAt', 'endedAt');
      },
    });
    await old.put('sessions', { id: 's', routineId: 'r1', routineName: 'n', startedAt: 1, endedAt: 5, completed: true, sets: [] });
    await old.put('routines', { id: 'a', name: 'n', order: 1, exercises: [], createdAt: 1, updatedAt: 1 });
    old.close();

    const media = createIdbMediaStore('upg-db');
    expect(await media.getSettings()).toEqual(DEFAULT_SETTINGS);
    const storage = createIdbStorage('upg-db');
    expect((await storage.getSession('s'))?.endedAt).toBe(5);
    expect((await storage.listRoutines()).map((r) => r.id)).toEqual(['a']);
    await media.putVideo(video('s', 0, 0, 3));
    expect((await media.getVideo('s/0/0'))?.blob.size).toBe(3);
  });

  it('두 저장소를 같은 DB에 동시에 열어도 충돌하지 않는다', async () => {
    globalThis.indexedDB = new IDBFactory();
    const storage = createIdbStorage('shared-db');
    const media = createIdbMediaStore('shared-db');
    await Promise.all([media.putSettings({ ...DEFAULT_SETTINGS, guideSeen: 1 }), storage.listRoutines()]);
    expect((await media.getSettings()).guideSeen).toBe(1);
  });
});
