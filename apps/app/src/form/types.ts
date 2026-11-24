import type { FindingKind, FormFinding, KpFrame, SetNote, SquatRepMetrics } from '@wom/core';

export type SetKey = string; // `${sessionId}/${exerciseIndex}/${setIndex}`
export const setKey = (sessionId: string, exerciseIndex: number, setIndex: number): SetKey =>
  `${sessionId}/${exerciseIndex}/${setIndex}`;

export type Box = [number, number, number, number]; // 정규화 0~1 (x1,y1,x2,y2)

export type SetVideo = {
  key: SetKey;
  sessionId: string;
  routineId: string;
  exerciseIndex: number;
  setIndex: number;
  startedAt: number; // 첫 프레임 epoch ms
  mimeType: string;
  blob: Blob;
  boxes: { t: number; box: Box }[];
};

export type VideoClip = {
  key: string; // `${SetKey}#${index}`
  setKey: SetKey;
  index: number;
  startedAt: number;
  mimeType: string;
  blob: Blob;
};

export type SetAnalysis = {
  key: SetKey;
  sessionId: string;
  status: 'done' | 'failed';
  reason: null | 'noVideo' | 'noPerson' | 'error';
  metrics: SquatRepMetrics[];
  findings: FormFinding[];
  notes: SetNote[];
  uncertain: number[];
  frames: KpFrame[];
  model: 'rtmpose-m-halpe26';
  analyzedAt: number;
  /** 분석한 영상의 첫 프레임 epoch ms. 영상이 정리된 뒤에도 m:ss를 보이려고 남긴다(옛 분석에는 없음) */
  videoStartedAt?: number;
  /** reason이 'error'일 때 지금까지 시도한 횟수(옛 분석에는 없음 = 1회) */
  attempts?: number;
};

export type ManualErrorKind = 'depth' | 'kneeIn' | 'heel' | 'trunkLean' | 'lumbarFlexion' | 'bounce' | 'other';

export type RepLabel = {
  key: string; // `${SetKey}#${index}`
  sessionId: string;
  setKey: SetKey;
  index: number;
  verdicts: { kind: FindingKind; agree: boolean }[];
  manual: ManualErrorKind[];
  normal: boolean;
  note: string;
  updatedAt: number;
};

export type CaptureMeta = { sessionId: string; videoEnabled: boolean; consentAgreed: boolean; consentVersion: string | null };

export type AppSettings = {
  videoEnabled: boolean;
  consent: { agreed: boolean; version: string; at: number } | null;
  guideSeen: number;
};
export const DEFAULT_SETTINGS: AppSettings = { videoEnabled: false, consent: null, guideSeen: 0 };
