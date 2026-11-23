import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraError } from '../src/ports/pose';
import { createMediapipePose, toCameraError } from '../src/platform/mediapipePose';
import { createWebSpeech } from '../src/platform/webSpeech';
import { createKeepAwake, type KeepAwakeEnv } from '../src/platform/keepAwake';

describe('toCameraError (getUserMedia 오류 → CameraError)', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['NotFoundError', 'notFound'],
    ['DevicesNotFoundError', 'notFound'],
    ['NotReadableError', 'other'],
    ['OverconstrainedError', 'other'],
  ])('%s → %s', (name, kind) => {
    const e = toCameraError(new DOMException('x', name));
    expect(e).toBeInstanceOf(CameraError);
    expect(e.kind).toBe(kind);
  });

  it('이름이 없는 값·CameraError는 각각 other·그대로', () => {
    expect(toCameraError('뭔가').kind).toBe('other');
    expect(toCameraError(null).kind).toBe('other');
    const ce = new CameraError('notFound');
    expect(toCameraError(ce)).toBe(ce);
  });
});

describe('createMediapipePose.start 오류 단계', () => {
  const realMd = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  afterEach(() => {
    if (realMd) Object.defineProperty(navigator, 'mediaDevices', realMd);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  });
  function setGetUserMedia(fn: () => Promise<unknown>) {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: fn } });
  }

  it('getUserMedia의 NotAllowedError는 denied', async () => {
    setGetUserMedia(() => Promise.reject(new DOMException('x', 'NotAllowedError')));
    const err = await createMediapipePose().start(document.createElement('video')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).kind).toBe('denied');
  });

  it('video.play()의 NotAllowedError(자동 재생 거부)는 denied가 아니라 other이고 트랙을 멈춘다', async () => {
    const track = { stop: vi.fn() };
    setGetUserMedia(async () => ({ getTracks: () => [track] }));
    const video = document.createElement('video');
    video.play = () => Promise.reject(new DOMException('autoplay', 'NotAllowedError'));
    const err = await createMediapipePose().start(video).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).kind).toBe('other');
    expect(track.stop).toHaveBeenCalled();
  });
});

class FakeUtterance {
  voice: unknown = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

type FakeVoice = { lang: string; name: string; localService: boolean };
/** 문자열은 기기 안 음성(localService true)으로 본다 */
function fakeSynth(langs: Array<string | FakeVoice>) {
  const spoken: string[] = [];
  const used: unknown[] = [];
  const synth = {
    getVoices: () => langs.map((v) => (typeof v === 'string' ? { lang: v, name: v, localService: true } : v)),
    cancel: vi.fn(),
    speak: (u: FakeUtterance) => {
      spoken.push(u.text);
      used.push(u.voice);
      u.onend?.();
    },
  };
  return { synth: synth as unknown as SpeechSynthesis, spoken, used };
}

describe('createWebSpeech', () => {
  it("ko 음성이 없으면 'unsupported'이고 말하지 않는다", async () => {
    const { synth, spoken } = fakeSynth(['en-US', 'ja-JP']);
    const s = createWebSpeech({ synth, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    await expect(s.speak('하나')).resolves.toBe('unsupported');
    expect(spoken).toEqual([]);
  });

  it("speechSynthesis가 없으면 'unsupported'", async () => {
    const s = createWebSpeech({ synth: undefined, Utterance: undefined });
    await expect(s.speak('하나')).resolves.toBe('unsupported');
  });

  it("ko 음성이 있으면 말하고 'ok'", async () => {
    const { synth, spoken } = fakeSynth(['en-US', 'ko-KR']);
    const s = createWebSpeech({ synth, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    await expect(s.speak('하나')).resolves.toBe('ok');
    expect(spoken).toEqual(['하나']);
  });

  it("ko 음성이 네트워크 음성(localService false)뿐이면 'unsupported'이고 말하지 않는다", async () => {
    const { synth, spoken } = fakeSynth([{ lang: 'ko-KR', name: 'Google 한국의', localService: false }]);
    const s = createWebSpeech({ synth, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    await expect(s.speak('하나')).resolves.toBe('unsupported');
    expect(spoken).toEqual([]);
  });

  it('네트워크 ko 음성이 먼저 있어도 기기 안 ko 음성을 고른다', async () => {
    const net = { lang: 'ko-KR', name: 'Online (Natural)', localService: false };
    const local = { lang: 'ko-KR', name: 'Heami', localService: true };
    const { synth, used } = fakeSynth([net, local]);
    const s = createWebSpeech({ synth, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance });
    await expect(s.speak('하나')).resolves.toBe('ok');
    expect(used).toEqual([local]);
  });
});

function keepAwakeEnv(over: Partial<KeepAwakeEnv> = {}) {
  const sentinel = { release: vi.fn(async () => undefined), addEventListener: vi.fn() };
  const env: KeepAwakeEnv = {
    isNative: false,
    plugin: { keepAwake: vi.fn(async () => undefined), allowSleep: vi.fn(async () => undefined) },
    wakeLock: { request: vi.fn(async () => sentinel) },
    doc: undefined,
    ...over,
  };
  return { env, sentinel };
}

describe('createKeepAwake', () => {
  it('네이티브면 Capacitor 플러그인을 쓰고 Wake Lock은 쓰지 않는다', async () => {
    const { env } = keepAwakeEnv({ isNative: true });
    const k = createKeepAwake(env);
    await k.on();
    await k.off();
    expect(env.plugin.keepAwake).toHaveBeenCalledTimes(1);
    expect(env.plugin.allowSleep).toHaveBeenCalledTimes(1);
    expect(env.wakeLock!.request).not.toHaveBeenCalled();
  });

  it('네이티브가 아니면 Wake Lock을 잡고 off에서 놓는다', async () => {
    const { env, sentinel } = keepAwakeEnv();
    const k = createKeepAwake(env);
    await k.on();
    expect(env.wakeLock!.request).toHaveBeenCalledWith('screen');
    await k.off();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(env.plugin.keepAwake).not.toHaveBeenCalled();
  });

  it('둘 다 실패하거나 없어도 조용히 넘어간다', async () => {
    const failing = keepAwakeEnv({
      isNative: true,
      plugin: { keepAwake: () => Promise.reject(new Error('x')), allowSleep: () => Promise.reject(new Error('y')) },
      wakeLock: { request: () => Promise.reject(new DOMException('no', 'NotAllowedError')) },
    }).env;
    const k1 = createKeepAwake(failing);
    await expect(k1.on()).resolves.toBeUndefined();
    await expect(k1.off()).resolves.toBeUndefined();

    const none = keepAwakeEnv({ wakeLock: undefined }).env;
    const k2 = createKeepAwake(none);
    await expect(k2.on()).resolves.toBeUndefined();
    await expect(k2.off()).resolves.toBeUndefined();
  });
});
