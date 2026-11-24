import * as ort from 'onnxruntime-web/webgpu';
import type { Kp2 } from '@wom/core';
import { RTM_H, RTM_W, cropFor, decodeSimcc, toInputTensor } from '../form/rtmposeCodec';
import type { FormPoseModel } from '../ports/formPose';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCtx(): Ctx2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(RTM_W, RTM_H);
    return c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  }
  const c = document.createElement('canvas');
  c.width = RTM_W;
  c.height = RTM_H;
  return c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
}

export async function createRtmposeModel(
  opts: { modelUrl?: string; prefer?: 'webgpu' | 'wasm' } = {},
): Promise<FormPoseModel> {
  const modelUrl = opts.modelUrl ?? '/form/rtmpose-m.onnx';
  ort.env.wasm.wasmPaths = '/form/ort/';
  ort.env.wasm.numThreads = 1; // WebView는 crossOriginIsolated가 아니다
  const order: ('webgpu' | 'wasm')[] = opts.prefer === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'];
  let sess: ort.InferenceSession | null = null;
  let backend: 'webgpu' | 'wasm' = 'wasm';
  let lastErr: unknown = null;
  for (const ep of order) {
    try {
      sess = await ort.InferenceSession.create(modelUrl, { executionProviders: [ep] });
      backend = ep;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!sess) throw lastErr instanceof Error ? lastErr : new Error('RTMPose 모델을 불러오지 못했어요');
  const session = sess;
  const ctx = makeCtx();
  const inName = session.inputNames[0]!;

  return {
    backend,
    async estimate(image, width, height, box): Promise<Kp2[]> {
      const crop = cropFor(box, width, height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, RTM_W, RTM_H);
      ctx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, RTM_W, RTM_H);
      const data = ctx.getImageData(0, 0, RTM_W, RTM_H).data;
      const input = new ort.Tensor('float32', toInputTensor(data), [1, 3, RTM_H, RTM_W]);
      const out = await session.run({ [inName]: input });
      const [nx, ny] = session.outputNames;
      const ox = out[nx!];
      const oy = out[ny!];
      if (!ox || !oy) throw new Error('RTMPose 출력이 올바르지 않아요');
      const joints = ox.dims[1]!;
      return decodeSimcc(ox.data as Float32Array, oy.data as Float32Array, joints, crop);
    },
    dispose() {
      void session.release();
    },
  };
}
