import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '@wom/core';
import { CameraError, type PoseSource } from '../ports/pose';

// 시험용 앱(apps/spike/src/pose.ts, main.ts)에서 옮겼다. 자산은 public/mediapipe/(scripts/copy-wasm.mjs).
const WASM_DIR = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/pose_landmarker_lite.task';
const TELEMETRY_HOST = 'odml.pa.googleapis.com';

type Delegate = 'GPU' | 'CPU';

/** getUserMedia 오류를 CameraError로 바꾼다. NotAllowedError → denied, NotFoundError → notFound, 나머지 other */
export function toCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  const message = e instanceof Error ? e.message : undefined;
  // PermissionDeniedError·DevicesNotFoundError는 예전 Chrome 이름
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return new CameraError('denied', message);
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return new CameraError('notFound', message);
  return new CameraError('other', message);
}

let telemetryBlocked = false;

/**
 * MediaPipe 1.2.x 내부 로거가 https://odml.pa.googleapis.com/v1/log 로 fetch를 보낸다.
 * 옵션으로 끌 방법이 없어 이 주소로 가는 fetch만 막는다(시험용 앱 main.ts와 같은 방식). 한 번만 설치한다.
 */
export function blockTelemetry(): void {
  if (telemetryBlocked || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  telemetryBlocked = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(TELEMETRY_HOST)) return Promise.reject(new TypeError('blocked: mediapipe telemetry'));
    return realFetch(input, init);
  };
}

/** 사람이 없으면 visibility 0인 33점 프레임(트래커가 일시정지하게) */
function emptyFrame(t: number): PoseFrame {
  const zero = (): Landmark[] => Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  return { t, image: zero(), world: zero() };
}

function detect(l: PoseLandmarker, video: HTMLVideoElement, t: number): PoseFrame {
  const r = l.detectForVideo(video, t);
  const img = r.landmarks[0];
  const wld = r.worldLandmarks[0];
  if (!img || !wld || img.length !== 33 || wld.length !== 33) return emptyFrame(t);
  const conv = (p: { x: number; y: number; z: number; visibility?: number }): Landmark => ({
    x: p.x,
    y: p.y,
    z: p.z,
    visibility: p.visibility ?? 0,
  });
  return { t, image: img.map(conv), world: wld.map(conv) };
}

async function createLandmarker(): Promise<{ landmarker: PoseLandmarker; delegate: Delegate }> {
  // 무거운 라이브러리는 운동을 시작할 때만 불러온다(홈 화면 번들에 넣지 않는다).
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  const make = (delegate: Delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  try {
    return { landmarker: await make('GPU'), delegate: 'GPU' };
  } catch (e) {
    console.warn('GPU 생성 실패, CPU로 전환', e);
    return { landmarker: await make('CPU'), delegate: 'CPU' };
  }
}

/** MediaPipe Pose(lite) 기반 PoseSource. 프레임 시각 t는 performance.now() 시계다 */
export function createMediapipePose(): PoseSource {
  const listeners = new Set<(f: PoseFrame) => void>();
  let landmarker: PoseLandmarker | null = null;
  let delegate: Delegate | null = null;
  let stream: MediaStream | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let running = false;
  let busy = false;
  let lastT = 0;
  /** start·stop 세대. stop 뒤 늦게 끝난 start가 자원을 남기지 않게 한다 */
  let gen = 0;

  function release(): void {
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
    if (videoEl) videoEl.srcObject = null;
    videoEl = null;
    landmarker?.close();
    landmarker = null;
    delegate = null;
  }

  function schedule(video: HTMLVideoElement, my: number): void {
    if (!running || my !== gen) return;
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => onFrame(video, my));
    else requestAnimationFrame(() => onFrame(video, my));
  }

  function onFrame(video: HTMLVideoElement, my: number): void {
    if (!running || my !== gen) return;
    schedule(video, my);
    if (!landmarker || video.readyState < 2) return;
    if (busy) return; // 이전 추론이 끝나지 않았으면 이 프레임은 건너뛴다
    busy = true;
    try {
      // 타임스탬프는 단조 증가여야 한다.
      const t = Math.max(performance.now(), lastT + 0.001);
      lastT = t;
      const f = detect(landmarker, video, t);
      for (const cb of [...listeners]) cb(f);
    } catch (e) {
      console.warn('자세 추론 오류', e);
    } finally {
      busy = false;
    }
  }

  return {
    get delegate() {
      return delegate;
    },
    async start(video) {
      const my = ++gen;
      running = false;
      release();
      blockTelemetry();
      if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('notFound', 'getUserMedia 없음');
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });
      } catch (e) {
        throw toCameraError(e);
      }
      if (my !== gen) {
        s.getTracks().forEach((tr) => tr.stop());
        return;
      }
      stream = s;
      videoEl = video;
      try {
        video.muted = true;
        video.playsInline = true;
        video.srcObject = s;
        await video.play();
        const lm = await createLandmarker();
        if (my !== gen) {
          lm.landmarker.close();
          return;
        }
        landmarker = lm.landmarker;
        delegate = lm.delegate;
      } catch (e) {
        if (my === gen) release();
        // denied·notFound는 getUserMedia 단계만. play()의 NotAllowedError(자동 재생 거부)는 권한 거부가 아니다.
        if (e instanceof CameraError) throw e;
        throw new CameraError('other', e instanceof Error ? e.message : undefined);
      }
      running = true;
      schedule(video, my);
    },
    stop() {
      gen++;
      running = false;
      release();
    },
    onFrame(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
