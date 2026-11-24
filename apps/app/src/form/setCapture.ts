import type { PoseFrame } from '@wom/core';
import type { MediaStore } from '../ports/mediaStore';
import { setKey, type Box, type CaptureMeta, type SetKey } from './types';

export interface Recorder {
  /** 시작 못 하면 false */
  start(): boolean;
  /** 녹화를 멈추고 영상을 돌려준다. 영상이 없으면 null */
  stop(): Promise<{ blob: Blob; mimeType: string; startedAt: number } | null>;
}

export interface SetCapture {
  /** 설정을 읽어 녹화 메타를 저장한다. 끝나기 전에 beginSet이 와도 안전하다 */
  beginSession(s: { sessionId: string; routineId: string }): Promise<void>;
  beginSet(exerciseIndex: number, setIndex: number): void;
  /** lite 관절점 → 정규화 사람 상자. 사람이 없으면 건너뛴다. epochT는 epoch ms */
  addFrame(f: PoseFrame, epochT: number): void;
  /** 세트를 끝내고 저장한다. keep=false면 저장하지 않고 버린다. 저장된 key(없으면 null) */
  endSet(keep?: boolean): Promise<SetKey | null>;
}

/** 상자에 쓸 관절점의 최소 visibility와 최소 개수 */
const MIN_VISIBILITY = 0.5;
const MIN_POINTS = 4;
/** 상자 둘레 여유(상자 크기의 비율) */
const PAD = 0.1;

/** 정규화 관절점에서 사람 상자를 만든다. 보이는 점이 모자라면 null */
export function boxFromFrame(f: PoseFrame): Box | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let n = 0;
  for (const p of f.image) {
    if (!(p.visibility >= MIN_VISIBILITY)) continue;
    n++;
    if (p.x < x1) x1 = p.x;
    if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.y > y2) y2 = p.y;
  }
  if (n < MIN_POINTS) return null;
  const px = (x2 - x1) * PAD;
  const py = (y2 - y1) * PAD;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(x1 - px), c(y1 - py), c(x2 + px), c(y2 + py)];
}

type Active = { exerciseIndex: number; setIndex: number; started: boolean; boxes: { t: number; box: Box }[] };

export function createSetCapture(deps: { store: MediaStore; recorder: Recorder | null; onSaved: (key: SetKey) => void }): SetCapture {
  const { store, recorder, onSaved } = deps;
  let session: { sessionId: string; routineId: string } | null = null;
  /** null이면 설정을 아직 읽는 중(또는 세션 시작 전) */
  let enabled: boolean | null = null;
  let ready: Promise<void> = Promise.resolve();
  let cur: Active | null = null;

  const warn = (what: string, e: unknown) => console.warn(what, e);

  /** 녹화를 시작한다. 못 시작해도 상자는 계속 모은다(저장은 영상이 있을 때만) */
  const startRecording = (a: Active): void => {
    try {
      a.started = recorder?.start() ?? false;
    } catch (e) {
      a.started = false;
      warn('세트 녹화 시작 실패', e);
    }
  };

  const stopRecording = async (a: Active) => {
    if (!a.started || !recorder) return null;
    try {
      return await recorder.stop();
    } catch (e) {
      warn('세트 녹화 종료 실패', e);
      return null;
    }
  };

  return {
    beginSession(s) {
      session = s;
      enabled = null;
      ready = (async () => {
        let on = false;
        try {
          const settings = await store.getSettings();
          on = settings.videoEnabled;
          const meta: CaptureMeta = {
            sessionId: s.sessionId,
            videoEnabled: settings.videoEnabled,
            consentAgreed: settings.consent?.agreed ?? false,
            consentVersion: settings.consent?.version ?? null,
          };
          await store.putCaptureMeta(meta);
        } catch (e) {
          warn('녹화 설정 읽기·저장 실패', e);
        }
        enabled = on;
        // 설정을 읽는 동안 세트가 이미 시작됐다면 이제 녹화를 시작한다
        if (on && cur && !cur.started) startRecording(cur);
      })();
      return ready;
    },

    beginSet(exerciseIndex, setIndex) {
      if (enabled === false) return;
      cur = { exerciseIndex, setIndex, started: false, boxes: [] };
      if (enabled === true) startRecording(cur);
    },

    addFrame(f, epochT) {
      if (!cur || enabled === false) return;
      try {
        const box = boxFromFrame(f);
        if (box) cur.boxes.push({ t: epochT, box });
      } catch (e) {
        warn('상자 계산 실패', e);
      }
    },

    async endSet(keep = true) {
      const a = cur;
      const s = session;
      cur = null;
      if (!a || !s) return null;
      try {
        await ready;
        if (enabled !== true) return null;
        const rec = await stopRecording(a);
        if (!keep || !rec) return null;
        const key = setKey(s.sessionId, a.exerciseIndex, a.setIndex);
        await store.putVideo({
          key,
          sessionId: s.sessionId,
          routineId: s.routineId,
          exerciseIndex: a.exerciseIndex,
          setIndex: a.setIndex,
          startedAt: rec.startedAt,
          mimeType: rec.mimeType,
          blob: rec.blob,
          boxes: a.boxes,
        });
        // 저장은 끝났으므로 후속 처리(분석 대기열 등)가 던져도 key를 돌려준다
        try {
          onSaved(key);
        } catch (e) {
          warn('세트 영상 저장 뒤 처리 실패', e);
        }
        return key;
      } catch (e) {
        warn('세트 영상 저장 실패', e);
        return null;
      }
    },
  };
}
