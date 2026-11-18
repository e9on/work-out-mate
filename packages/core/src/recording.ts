import type { ExerciseId } from './exercises/runner';
import type { PoseFrame } from './types';

/** 폰에서 녹화한 랜드마크 파일 형식. scripts/replay.ts가 읽는다. */
export type RecordingFile = {
  version: 1;
  device: string;
  exercise: ExerciseId;
  model: 'lite' | 'full';
  frames: PoseFrame[];
};
