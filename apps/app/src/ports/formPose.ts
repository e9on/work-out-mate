import type { Kp2 } from '@wom/core';
import type { Box } from '../form/types';

export interface FormPoseModel {
  estimate(image: CanvasImageSource, width: number, height: number, box: Box): Promise<Kp2[]>;
  dispose(): void;
  readonly backend: 'webgpu' | 'wasm';
}
