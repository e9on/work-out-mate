import type { PoseFrame } from '@wom/core';

export interface PoseSource {
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  onFrame(cb: (f: PoseFrame) => void): () => void;
  readonly delegate: 'GPU' | 'CPU' | null;
}

export class CameraError extends Error {
  readonly kind: 'denied' | 'notFound' | 'other';
  constructor(kind: 'denied' | 'notFound' | 'other', message?: string) {
    super(message ?? kind);
    this.name = 'CameraError';
    this.kind = kind;
  }
}
