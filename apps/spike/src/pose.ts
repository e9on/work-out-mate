import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '@wom/core';

export type Delegate = 'GPU' | 'CPU';
export type ModelName = 'lite' | 'full';

export type Landmarker = {
  landmarker: PoseLandmarker;
  /** 실제로 쓰이는 delegate (GPU 실패 시 CPU로 바뀜) */
  delegate: Delegate;
  fellBack: boolean;
};

const WASM_DIR = '/mediapipe/wasm';

async function make(model: ModelName, delegate: Delegate): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `/mediapipe/pose_landmarker_${model}.task`, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

/** GPU 생성이 실패하면 CPU로 자동 전환한다. */
export async function createLandmarker(model: ModelName, delegate: Delegate): Promise<Landmarker> {
  try {
    return { landmarker: await make(model, delegate), delegate, fellBack: false };
  } catch (e) {
    if (delegate === 'GPU') {
      console.warn('GPU 생성 실패, CPU로 전환', e);
      return { landmarker: await make(model, 'CPU'), delegate: 'CPU', fellBack: true };
    }
    throw e;
  }
}

/** 사람이 없으면 visibility 0인 33점 프레임을 만든다(트래커가 일시정지하게). */
export function emptyFrame(t: number): PoseFrame {
  const zero = (): Landmark[] => Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  return { t, image: zero(), world: zero() };
}

export function detect(l: PoseLandmarker, video: HTMLVideoElement, t: number): PoseFrame {
  const r = l.detectForVideo(video, t);
  const img = r.landmarks[0];
  const wld = r.worldLandmarks[0];
  if (!img || !wld || img.length !== 33 || wld.length !== 33) return emptyFrame(t);
  const conv = (p: { x: number; y: number; z: number; visibility?: number }): Landmark => ({
    x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0,
  });
  return { t, image: img.map(conv), world: wld.map(conv) };
}

// 오버레이용 뼈대 연결 (MediaPipe 포즈 33점)
const CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [28, 30], [30, 32],
];

export function drawPose(ctx: CanvasRenderingContext2D, f: PoseFrame, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#4ade80';
  for (const [a, b] of CONNECTIONS) {
    const p = f.image[a]!, q = f.image[b]!;
    if (p.visibility < 0.5 || q.visibility < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(p.x * w, p.y * h);
    ctx.lineTo(q.x * w, q.y * h);
    ctx.stroke();
  }
  ctx.fillStyle = '#facc15';
  for (const p of f.image) {
    if (p.visibility < 0.5) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
