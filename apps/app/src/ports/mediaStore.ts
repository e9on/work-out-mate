import type { AppSettings, CaptureMeta, RepLabel, SetAnalysis, SetKey, SetVideo, VideoClip } from '../form/types';

/** 세트 영상·클립·분석·라벨·녹화 메타·앱 설정 저장소. */
export interface MediaStore {
  putVideo(v: SetVideo): Promise<void>;
  getVideo(key: SetKey): Promise<SetVideo | null>;
  deleteVideo(key: SetKey): Promise<void>;
  listVideoKeys(): Promise<SetKey[]>;
  putClip(c: VideoClip): Promise<void>;
  getClip(key: string): Promise<VideoClip | null>;
  listClips(setKey: SetKey): Promise<VideoClip[]>;
  deleteClipsOfSet(setKey: SetKey): Promise<void>;
  putAnalysis(a: SetAnalysis): Promise<void>;
  getAnalysis(key: SetKey): Promise<SetAnalysis | null>;
  listAnalyses(sessionId: string): Promise<SetAnalysis[]>;
  putLabel(l: RepLabel): Promise<void>;
  listLabels(sessionId: string): Promise<RepLabel[]>;
  putCaptureMeta(m: CaptureMeta): Promise<void>;
  getCaptureMeta(sessionId: string): Promise<CaptureMeta | null>;
  getSettings(): Promise<AppSettings>;
  putSettings(s: AppSettings): Promise<void>;
  /** 영상·클립 blob 크기 합(바이트). */
  usageBytes(): Promise<number>;
}
