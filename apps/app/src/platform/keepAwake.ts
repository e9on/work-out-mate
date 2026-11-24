import { Capacitor } from '@capacitor/core';
import { KeepAwake as CapKeepAwake } from '@capacitor-community/keep-awake';
import type { KeepAwake } from '../ports/keepAwake';

type Sentinel = { release(): Promise<void>; addEventListener(type: 'release', cb: () => void): void };

export type KeepAwakeEnv = {
  isNative: boolean;
  plugin: { keepAwake(): Promise<void>; allowSleep(): Promise<void> };
  wakeLock: { request(type: 'screen'): Promise<Sentinel> } | undefined;
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | undefined;
};

function defaultEnv(): KeepAwakeEnv {
  return {
    isNative: Capacitor.isNativePlatform(),
    plugin: CapKeepAwake,
    wakeLock: typeof navigator !== 'undefined' ? navigator.wakeLock : undefined,
    doc: typeof document !== 'undefined' ? document : undefined,
  };
}

/**
 * 운동 중 화면 켜짐. 네이티브 앱이면 Capacitor KeepAwake, 아니면(또는 네이티브가 실패하면) Wake Lock API.
 * 둘 다 실패하거나 없으면 조용히 넘어간다(오류를 던지지 않는다).
 * 웹 Wake Lock은 화면이 가려지면 브라우저가 풀기 때문에, on 상태에서 다시 보이면 다시 잡는다.
 */
export function createKeepAwake(env: KeepAwakeEnv = defaultEnv()): KeepAwake {
  let wanted = false;
  let nativeOn = false;
  let sentinel: Sentinel | null = null;

  async function acquire(): Promise<void> {
    if (!env.wakeLock || sentinel) return;
    try {
      const s = await env.wakeLock.request('screen');
      if (!wanted) {
        await s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null;
      });
    } catch {
      // 지원하지 않거나 거절됨: 조용히 넘어간다.
    }
  }

  const onVisible = () => {
    if (wanted && !nativeOn && env.doc?.visibilityState === 'visible') void acquire();
  };

  return {
    async on() {
      if (wanted) return;
      wanted = true;
      if (env.isNative) {
        try {
          await env.plugin.keepAwake();
          nativeOn = true;
          return;
        } catch {
          // 네이티브 실패면 Wake Lock을 시도한다.
        }
      }
      env.doc?.addEventListener('visibilitychange', onVisible);
      await acquire();
    },
    async off() {
      if (!wanted) return;
      wanted = false;
      env.doc?.removeEventListener('visibilitychange', onVisible);
      if (nativeOn) {
        nativeOn = false;
        try {
          await env.plugin.allowSleep();
        } catch {
          // 무시
        }
      }
      const s = sentinel;
      sentinel = null;
      if (s) {
        try {
          await s.release();
        } catch {
          // 무시
        }
      }
    },
  };
}
