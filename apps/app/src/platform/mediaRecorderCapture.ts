import type { Recorder } from '../form/setCapture';

const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
const VIDEO_BITS_PER_SECOND = 2_500_000;

/**
 * MediaRecorder로 카메라 스트림을 녹화한다. 지원하지 않거나 스트림이 없으면 null을 돌려준다(세트 진행에는 영향 없음).
 * now는 epoch ms. startedAt은 녹화 시작 시각이다.
 */
export function createMediaRecorder(getStream: () => MediaStream | null, now: () => number): Recorder | null {
  if (typeof MediaRecorder === 'undefined') return null;
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let mimeType = '';

  return {
    start() {
      try {
        const stream = getStream();
        if (!stream || rec) return false;
        const picked = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
        const r = new MediaRecorder(stream, {
          ...(picked ? { mimeType: picked } : {}),
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        });
        chunks = [];
        mimeType = r.mimeType || picked || 'video/webm';
        r.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        startedAt = now();
        r.start();
        rec = r;
        return true;
      } catch {
        rec = null;
        return false;
      }
    },
    stop() {
      const r = rec;
      rec = null;
      if (!r) return Promise.resolve(null);
      return new Promise((resolve) => {
        r.onstop = () => {
          const parts = chunks;
          chunks = [];
          resolve(parts.length > 0 ? { blob: new Blob(parts, { type: mimeType }), mimeType, startedAt } : null);
        };
        r.onerror = () => resolve(null);
        try {
          if (r.state === 'inactive') r.onstop?.(new Event('stop'));
          else r.stop();
        } catch {
          resolve(null);
        }
      });
    },
  };
}
