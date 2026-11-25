import type { ClipCutter } from '../form/retention';

const WAIT_TIMEOUT_MS = 5000;

const once = (el: HTMLVideoElement, ok: string, ms: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
      fn();
    };
    const onOk = () => done(resolve);
    const onErr = () => done(() => reject(new Error('영상을 읽지 못했어요')));
    const timer = setTimeout(() => done(() => reject(new Error('영상 읽기 시간 초과'))), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream };

/**
 * 숨은 <video>를 fromMs로 옮긴 뒤 captureStream()을 MediaRecorder로 녹화해 toMs에서 멈춘다.
 * 실시간으로 재생하며 녹화하므로 클립 길이만큼 걸린다. captureStream·MediaRecorder가 없거나 실패하면 null.
 * (jsdom에서 검증할 수 없다: 실기기 확인 대상)
 */
export function createClipCutter(): ClipCutter {
  return {
    async cut(video, fromMs, toMs) {
      if (typeof MediaRecorder === 'undefined' || toMs <= fromMs) return null;
      const el: CapturableVideo = document.createElement('video');
      if (typeof el.captureStream !== 'function') return null;
      const url = URL.createObjectURL(video.blob);
      try {
        el.muted = true;
        el.playsInline = true;
        el.preload = 'auto';
        const meta = once(el, 'loadedmetadata', WAIT_TIMEOUT_MS);
        el.src = url;
        await meta;
        const seeked = once(el, 'seeked', WAIT_TIMEOUT_MS);
        el.currentTime = fromMs / 1000;
        await seeked;
        const recorder = new MediaRecorder(el.captureStream(), { mimeType: video.mimeType });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        const stopped = new Promise<void>((resolve, reject) => {
          recorder.onstop = () => resolve();
          recorder.onerror = () => reject(new Error('클립 녹화 실패'));
        });
        const limit = toMs - fromMs;
        const ended = new Promise<void>((resolve) => {
          const stop = () => {
            window.clearTimeout(timer);
            el.removeEventListener('ended', stop);
            resolve();
          };
          const timer = window.setTimeout(stop, limit);
          el.addEventListener('ended', stop);
        });
        recorder.start();
        await el.play();
        await ended;
        el.pause();
        recorder.stop();
        await stopped;
        if (chunks.length === 0) return null;
        return { blob: new Blob(chunks, { type: video.mimeType }), mimeType: video.mimeType };
      } catch (e) {
        console.warn('클립 자르기 실패', e);
        return null;
      } finally {
        el.removeAttribute('src');
        el.load();
        URL.revokeObjectURL(url);
      }
    },
  };
}
