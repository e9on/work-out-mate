import type { VideoFrameReader } from '../form/analysisQueue';

/** 이벤트 하나를 기다리는 최대 ms */
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

/**
 * 숨은 <video>에 blob을 물리고 currentTime을 옮겨 가며 프레임을 얻는다(DOM에 붙이지 않는다).
 * frameAt이 돌려주는 이미지는 video 요소 자신이라, 부르는 쪽이 바로 그려야 한다(직렬 사용 전제).
 */
export function createVideoFrameReader(): VideoFrameReader {
  return {
    async open(blob) {
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      const close = () => {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      };
      try {
        const meta = once(video, 'loadedmetadata', WAIT_TIMEOUT_MS);
        video.src = url;
        await meta;
        // MediaRecorder가 만든 webm은 길이가 Infinity일 수 있다. 끝으로 크게 시킹해 실제 길이를 알아낸 뒤 처음으로 돌아온다
        if (!Number.isFinite(video.duration)) {
          const known = once(video, 'durationchange', WAIT_TIMEOUT_MS);
          video.currentTime = 1e101;
          await known;
          const back = once(video, 'seeked', WAIT_TIMEOUT_MS);
          video.currentTime = 0;
          await back;
        }
      } catch (e) {
        close();
        throw e;
      }
      // 길이를 모르는 영상으로 분석하면 지적 없음처럼 보이는 결과가 저장되므로 오류로 처리한다
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        close();
        throw new Error('영상 길이를 알 수 없어요');
      }
      return {
        durationMs: video.duration * 1000,
        width: video.videoWidth,
        height: video.videoHeight,
        async frameAt(ms) {
          // 같은 위치로의 시킹은 seeked가 오지 않으므로 그대로 쓴다
          if (Math.abs(video.currentTime - ms / 1000) < 1e-4 && video.readyState >= 2) return video;
          const seeked = once(video, 'seeked', WAIT_TIMEOUT_MS);
          video.currentTime = ms / 1000;
          await seeked;
          return video;
        },
        close,
      };
    },
  };
}
