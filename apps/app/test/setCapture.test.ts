import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPose } from '../../../packages/core/test/helpers/poseBuilder';
import { createSetCapture, type Recorder } from '../src/form/setCapture';
import { setKey, type AppSettings } from '../src/form/types';
import type { MediaStore } from '../src/ports/mediaStore';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';

const blob = (): Blob => new NodeBlob([new Uint8Array(4)], { type: 'video/webm' }) as unknown as Blob;
const on: AppSettings = { videoEnabled: true, consent: { agreed: true, version: 'v1', at: 1 }, guideSeen: 0 };

function fakeRecorder(opts: { startOk?: boolean; result?: 'ok' | 'null' | 'throw' } = {}) {
  const r = {
    starts: 0,
    stops: 0,
    start(): boolean {
      r.starts++;
      return opts.startOk ?? true;
    },
    async stop() {
      r.stops++;
      if (opts.result === 'throw') throw new Error('boom');
      return opts.result === 'null' ? null : { blob: blob(), mimeType: 'video/webm', startedAt: 1234 };
    },
  } satisfies Recorder & { starts: number; stops: number };
  return r;
}

async function setup(settings: AppSettings | null, recorder: Recorder | null = fakeRecorder()) {
  const store = createMemoryMediaStore();
  if (settings) await store.putSettings(settings);
  const onSaved = vi.fn();
  const cap = createSetCapture({ store, recorder, onSaved });
  return { store, cap, onSaved, recorder };
}
const frame = (t: number, hidden: number[] = []) => buildPose({ t, hidden });
const allHidden = Array.from({ length: 33 }, (_, i) => i);

/** getSettings가 gate가 열릴 때까지 기다리는 저장소 */
async function gatedStore() {
  const base = createMemoryMediaStore();
  await base.putSettings(on);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store: MediaStore = {
    ...base,
    getSettings: async () => {
      await gate;
      return base.getSettings();
    },
  };
  return { base, store, release };
}

afterEach(() => vi.restoreAllMocks());

describe('SetCapture', () => {
  it('beginSet→addFrame 3번→endSet이면 SetVideo가 저장되고 boxes 3개, key는 setKey', async () => {
    const { store, cap, onSaved } = await setup(on);
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 1);
    for (let i = 0; i < 3; i++) cap.addFrame(frame(i), 5000 + i * 33);
    const key = await cap.endSet();
    expect(key).toBe(setKey('s1', 0, 1));
    expect(onSaved).toHaveBeenCalledWith(key);
    const v = await store.getVideo(key!);
    expect(v).toMatchObject({ sessionId: 's1', routineId: 'r1', exerciseIndex: 0, setIndex: 1, startedAt: 1234, mimeType: 'video/webm' });
    expect(v!.boxes).toHaveLength(3);
    expect(v!.boxes.map((b) => b.t)).toEqual([5000, 5033, 5066]);
    for (const { box } of v!.boxes) {
      expect(box[0]).toBeGreaterThanOrEqual(0);
      expect(box[2]).toBeLessThanOrEqual(1);
      expect(box[0]).toBeLessThan(box[2]);
      expect(box[1]).toBeLessThan(box[3]);
    }
  });

  it('beginSession은 설정을 읽어 CaptureMeta를 저장한다', async () => {
    const { store, cap } = await setup(on);
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    expect(await store.getCaptureMeta('s1')).toEqual({ sessionId: 's1', videoEnabled: true, consentAgreed: true, consentVersion: 'v1' });
    const off = await setup(null);
    await off.cap.beginSession({ sessionId: 's2', routineId: 'r1' });
    expect(await off.store.getCaptureMeta('s2')).toEqual({ sessionId: 's2', videoEnabled: false, consentAgreed: false, consentVersion: null });
  });

  it('lite 관절점이 없는 프레임(visibility 0)은 boxes에 넣지 않는다', async () => {
    const { store, cap } = await setup(on);
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    cap.addFrame(frame(0), 1);
    cap.addFrame(frame(1, allHidden), 2);
    cap.addFrame(frame(2), 3);
    const key = await cap.endSet();
    expect((await store.getVideo(key!))!.boxes.map((b) => b.t)).toEqual([1, 3]);
  });

  it('videoEnabled=false면 녹화·저장을 하지 않고 endSet은 null', async () => {
    const { store, cap, recorder } = await setup({ ...on, videoEnabled: false });
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    cap.addFrame(frame(0), 1);
    expect(await cap.endSet()).toBeNull();
    expect((recorder as ReturnType<typeof fakeRecorder>).starts).toBe(0);
    expect(await store.listVideoKeys()).toEqual([]);
  });

  it('recorder.start()가 false면 저장하지 않고 endSet은 null, 예외 없음', async () => {
    const { store, cap } = await setup(on, fakeRecorder({ startOk: false }));
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    cap.addFrame(frame(0), 1);
    expect(await cap.endSet()).toBeNull();
    expect(await store.listVideoKeys()).toEqual([]);
  });

  it('stop()이 null이거나 던져도 저장하지 않고 endSet은 null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const result of ['null', 'throw'] as const) {
      const { store, cap } = await setup(on, fakeRecorder({ result }));
      await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
      cap.beginSet(0, 0);
      expect(await cap.endSet()).toBeNull();
      expect(await store.listVideoKeys()).toEqual([]);
    }
  });

  it('recorder가 null(MediaRecorder 미지원)이어도 예외 없이 null', async () => {
    const { cap } = await setup(on, null);
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    cap.addFrame(frame(0), 1);
    await expect(cap.endSet()).resolves.toBeNull();
  });

  it('keep=false면 녹화를 멈추고 저장하지 않는다', async () => {
    const { store, cap, recorder } = await setup(on);
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    cap.addFrame(frame(0), 1);
    expect(await cap.endSet(false)).toBeNull();
    expect((recorder as ReturnType<typeof fakeRecorder>).stops).toBe(1);
    expect(await store.listVideoKeys()).toEqual([]);
  });

  it('세트가 열려 있지 않으면 addFrame·endSet은 아무것도 하지 않는다', async () => {
    const { cap } = await setup(on);
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.addFrame(frame(0), 1);
    expect(await cap.endSet()).toBeNull();
  });

  it('설정을 읽기 전에 beginSet·addFrame이 와도 읽은 뒤 녹화하고, 그동안의 프레임도 보존한다', async () => {
    const { base, store, release } = await gatedStore();
    const recorder = fakeRecorder();
    const cap = createSetCapture({ store, recorder, onSaved: () => undefined });
    const began = cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    cap.addFrame(frame(0), 1);
    expect(recorder.starts).toBe(0);
    release();
    await began;
    expect(recorder.starts).toBe(1);
    cap.addFrame(frame(1), 2);
    const key = await cap.endSet();
    expect((await base.getVideo(key!))!.boxes.map((b) => b.t)).toEqual([1, 2]);
  });

  it('설정을 읽는 중에 세트가 끝나면 영상 없이 null이고 녹화를 시작하지 않는다', async () => {
    const { store, release } = await gatedStore();
    const recorder = fakeRecorder();
    const cap = createSetCapture({ store, recorder, onSaved: () => undefined });
    const began = cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    const ended = cap.endSet();
    release();
    await began;
    expect(await ended).toBeNull();
    expect(recorder.starts).toBe(0);
  });

  it('설정 읽기가 실패해도 녹화 없이 조용히 넘어간다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = createMemoryMediaStore();
    const store: MediaStore = { ...base, getSettings: async () => Promise.reject(new Error('idb')) };
    const cap = createSetCapture({ store, recorder: fakeRecorder(), onSaved: () => undefined });
    await expect(cap.beginSession({ sessionId: 's1', routineId: 'r1' })).resolves.toBeUndefined();
    cap.beginSet(0, 0);
    expect(await cap.endSet()).toBeNull();
  });

  it('putVideo가 실패해도 endSet은 null을 돌려주고 던지지 않는다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = createMemoryMediaStore();
    await base.putSettings(on);
    const store: MediaStore = { ...base, putVideo: async () => Promise.reject(new Error('quota')) };
    const onSaved = vi.fn();
    const cap = createSetCapture({ store, recorder: fakeRecorder(), onSaved });
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    expect(await cap.endSet()).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('onSaved가 던져도 저장은 됐으므로 endSet은 key를 돌려준다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = createMemoryMediaStore();
    await base.putSettings(on);
    const cap = createSetCapture({
      store: base,
      recorder: fakeRecorder(),
      onSaved: () => {
        throw new Error('대기열 오류');
      },
    });
    await cap.beginSession({ sessionId: 's1', routineId: 'r1' });
    cap.beginSet(0, 0);
    expect(await cap.endSet()).toBe(setKey('s1', 0, 0));
    expect(await base.getVideo(setKey('s1', 0, 0))).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
